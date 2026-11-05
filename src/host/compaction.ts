/**
 * 规则「上下文自动压缩」——host 侧核心。
 *
 * 挂 `agent/pre-step`（waterfall）：先 `await next()` 照常放行，再自己量一次会话
 * token；超过用户配置的阈值就调当前会话模型生成中文摘要，按平台四事件契约把摘要
 * 写回会话、替换掉老的一段。与官方 `dsh-compaction-basic` 并存，各判各的
 * （用户裁决 2026-09-28：当官方压缩不存在，只照 waterfall 规矩先放行再自量）。
 *
 * **四事件契约**（照官方 `commitCompactionBody`，`dsh-compaction-basic/lib/index.js:628`）：
 * ① `compaction/start`（log-only，持有锁）
 * ② `compaction/summary`（log-only，无 surfaceOp）
 * ③ 紧随其后的 `user/message` 替换（surfaceOp 为 replace）——**② ③ 必须相邻**
 * ④ `compaction/end`（log-only，释放锁）
 *
 * **失败静默**：任何一步抛错都只记 `logger.warn`，什么都不改（用户定稿）。
 *
 * **为什么还留着 `session.eventAt?.`。** 本模块仍有三处按 seq 读事件：判首节点是不是
 * `system/message`（两处）、把可压区间的每个 seq 派生成消息（一处）。平台没有非 deprecated
 * 的等价面——`session.surface` 只给 seq 数组、回不到事件体——所以这是有意保留，不是漏改。
 *
 * @module dsh-harden/compaction
 */

import { randomUUID } from 'node:crypto'

import { CompactionId, compactCheckpointSource, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'

import { DEFAULT_COMPACTION_THRESHOLD } from './config.js'
import { 解析压缩阈值, type 压缩阈值 } from './shared-format.js'
import type {
    AgentLike,
    AgentRegistryService,
    Ctx,
    HardenConfig,
    LlmService,
    Logger,
    SessionLike,
    TokenMeasurementLike,
    TokenMeterService,
} from './types.js'

/** 摘要调用给模型的最大生成 token。 */
const SUMMARY_MAX_TOKENS = 8192

/** 压缩后保留量占阈值的比例（用户定稿：写死 30%，不给输入框）。 */
const RETAIN_RATIO = 0.3

/** 绝对阈值最多按窗口的这个比例算：再高就永远触发不了（请求会先撞上下文上限）。 */
const WINDOW_CEILING_RATIO = 0.9

/**
 * 下面两个「只警告一次」是模块级状态，不能挪进函数。
 *
 * 每一步都会走到这两条裁决：窗口缺席（适配器没报容量）或阈值文本坏掉时，每次 pre-step 都会
 * 撞上同一个事实——逐次 warn 会把日志刷爆，排障时反而看不见真正的那条。
 */
let 是否已警告窗口未知 = false
let 是否已警告阈值无法解析 = false

/** checkpoint 摘要正文的包裹标签。 */
const SUMMARY_OPEN_TAG = '<compacted-summary>'
const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/** checkpoint 前置说明（照官方 `CHECKPOINT_PREAMBLE` 的中文原文）。 */
const CHECKPOINT_PREAMBLE =
    '这是一段自动生成的检查点，浓缩了此前的一段对话以释放上下文。' +
    '把其中的内容当作已确立的背景，直接在其上继续，不要复述。' +
    '请从随后的消息直接接续任务，不要提及这份检查点。'

/** 一条可进摘要的文本块。 */
interface SummaryBlock {
    readonly type: string
    readonly text?: string
}

/** `selectCompactableRange` 选中并量好的可压区间。 */
interface CompactionRange {
    readonly start: number
    readonly end: number
    readonly shadowedSeqs: readonly number[]
    /** 写进 `compaction/summary` 事件的遮蔽代价（官方口径：节点 `heuristicTokens` 之和）。 */
    readonly shadowedHeuristicTokenCount: number
    /** 收缩校验用的遮蔽代价（官方口径：节点精算 `tokens` 之和）。 */
    readonly shadowedRouteTokenCount: number
}

/** 摘要调用的产物。 */
interface SummaryResult {
    readonly summary: readonly SummaryBlock[]
    readonly rawOutput: readonly SummaryBlock[]
    readonly provider: string
    readonly model: string
}

/** `agent/pre-step` 载荷里本项目用到的字段。 */
interface PreStepPayloadLike {
    readonly agent?: AgentLike
    readonly signal?: unknown
}

/**
 * 平台的工具结果裁剪服务（服务名 `toolResultPruner`）。
 *
 * 单模块自用的最小面：平台实现在 `dsh-compaction-tool-result-pruner`，只声明本项目调到的
 * `pruneSession`。**必须 `ctx.get` 现取、不许并进 `inject` 列表**：它是可选服务，精简 profile
 * 里没挂就缺席，并进 inject 会让整条监听器静默不装（坑 37）。
 */
interface ToolResultPrunerService {
    pruneSession(session: SessionLike): unknown
}

/** 压缩判定用到的平台服务面（`ctx.inject` 回调里取好，监听器内直接用）。 */
interface 压缩平台面 {
    readonly ctx: Ctx
    readonly agents: AgentRegistryService
    readonly llm: LlmService
    readonly tokenMeter: TokenMeterService
}

/** `considerCompaction` 的入参。 */
interface 压缩判定入参 {
    readonly payloadRaw: unknown
    readonly current: () => Required<HardenConfig>
    readonly logger: Logger
    readonly 平台面: 压缩平台面
}

/** `runCompactionTransaction` 的入参。 */
interface TransactionDeps {
    readonly session: SessionLike
    readonly agent: AgentLike | undefined
    readonly turn: number
    readonly signal: unknown
    readonly instruction: string
    readonly range: CompactionRange
    readonly tokenMeter: TokenMeterService
    readonly llm: LlmService
    readonly logger: Logger
}

/**
 * 判定一次会话要不要走压缩。
 *
 * 总开关（`contextCompaction`）是总闸：关了就谁也不压。总闸开着时，再按作用范围
 * （`compactionScope`）决定主代理与子代理各压不压：`all` 都压、`main` 只压主代理、
 * `subagent` 只压子代理。主代理与子代理靠会话头的 `origin` 分辨（子代理为 `'subagent'`）。
 *
 * @param config - 当前配置。
 * @param session - 提供会话头的会话。
 * @returns 要压返回 true。
 */
export function shouldCompactSession(config: Required<HardenConfig>, session: SessionLike): boolean {
    if (config.contextCompaction !== true) return false

    const scope = config.compactionScope
    const isSubagent = session.header?.origin === 'subagent'

    if (isSubagent) return scope === 'all' || scope === 'subagent'

    return scope === 'all' || scope === 'main'
}

/**
 * 挂载上下文自动压缩：挂 `agent/pre-step`，与官方各判各的。
 *
 * 用 `ctx.inject(['llm', 'tokenMeter', 'agents'], cb)` 取服务——顶层属性访问在未 inject 时
 * 会抛 `cannot get property ... without inject`（坑 19），必须等服务都到齐再在 cb 里挂监听器。
 *
 * **为什么 `agents` 可以进 inject 列表。** 坑 37 说的「可选服务不许进 inject」指的是
 * settings / webServer / sessionQuery / ptcRuntime 那类可能缺席的来源；`agents` 是平台核心
 * 服务，由 `dsh-agent` 提供、随 agent 回路必装，本模块要用它读回合边界。
 *
 * @param ctx - cordis 上下文。
 * @param logger - 日志出口。
 * @param current - 现取现解包的配置读取器。
 */
export function mountContextCompaction(
    ctx: Ctx,
    logger: Logger,
    current: () => Required<HardenConfig>,
): void {
    ctx.inject(['llm', 'tokenMeter', 'agents'], (svcCtx: Ctx) => {
        const llm = svcCtx.llm
        const tokenMeter = svcCtx.tokenMeter
        const agents = svcCtx.agents
        if (llm === undefined || tokenMeter === undefined || agents === undefined) {
            logger.warn?.('[harden] llm/tokenMeter/agents 不可用，规则「上下文自动压缩」未挂上')
            return
        }

        const 平台面: 压缩平台面 = {
            ctx: svcCtx,
            agents,
            llm,
            tokenMeter,
        }

        svcCtx.on('agent/pre-step', async (payloadRaw: unknown, nextRaw: unknown): Promise<unknown> => {
            const next = nextRaw as () => Promise<unknown>
            const decision = await next()

            try {
                await considerCompaction({
                    payloadRaw,
                    current,
                    logger,
                    平台面,
                })

            } catch (error) {
                // 看护层自己的异常绝不能挡住正常的一步——出错就什么都不改。
                logger.warn?.('[harden] 规则「上下文自动压缩」判定异常，已放行', error)
            }

            return decision
        })
    })
}

/**
 * 把阈值文本换算成 token 数；换算不出时返回 null（调用方本次跳过）。
 *
 * - 比例写法必须知道窗口，否则跳过——比例没有分母就换算不出 token；
 * - 绝对写法不知道窗口时原样用；知道窗口时按窗口的 90% 夹住，因为再高的阈值永远等不到
 *   触发（请求会先撞上下文上限），用户写的 `1M` 在小窗口模型上等于关掉了压缩。
 *
 * @param 阈值 - `解析压缩阈值` 的结果。
 * @param 窗口 - 模型上下文窗口；适配器没报容量时是 undefined。
 * @param logger - 日志出口（窗口未知只警告一次）。
 * @returns 本次判定用的阈值 token 数；换算不出时返回 null。
 */
export function 换算阈值Token数(阈值: 压缩阈值, 窗口: number | undefined, logger: Logger): number | null {
    if ('窗口比例' in 阈值) {
        if (窗口 === undefined) {
            if (是否已警告窗口未知 === false) {
                是否已警告窗口未知 = true
                const 百分比 = Math.round(阈值.窗口比例 * 100)
                logger.warn?.(`[harden] 压缩阈值配成窗口比例（${百分比}%），但当前模型没报上下文窗口，本次跳过`)
            }

            return null
        }

        return Math.floor(窗口 * 阈值.窗口比例)
    }

    if (窗口 === undefined) return 阈值.绝对token数

    return Math.min(阈值.绝对token数, Math.floor(窗口 * WINDOW_CEILING_RATIO))
}

/**
 * 判定 + 执行一次压缩。判定在 `selectCompactableRange`，这里只做收窄载荷、读配置、记账。
 *
 * **顺序照官方 `compactPressure`**（`dsh-compaction-basic/lib/index.js:949`）：先量一次、
 * 没到阈值直接放行；有裁剪器才 prune，prune 后重量一次、仍没到阈值就放行。裁剪器会改写
 * 会话表面，放错位置会把「本来就该保留的最近工具结果」也压掉，而且白写一堆事件。
 *
 * @param 入参 - 载荷、配置读取器、日志出口与平台服务面。
 */
async function considerCompaction(入参: 压缩判定入参): Promise<void> {
    const { payloadRaw, current, logger, 平台面 } = 入参
    const { ctx, agents, llm, tokenMeter } = 平台面

    const payload = payloadRaw as PreStepPayloadLike | null
    if (payload === null || typeof payload !== 'object') return

    const session = payload.agent?.session
    if (session === undefined) return

    const config = current()
    if (shouldCompactSession(config, session) === false) return

    const 配置阈值 = 解析压缩阈值(config.compactionThreshold)
    if (配置阈值 === null && 是否已警告阈值无法解析 === false) {
        是否已警告阈值无法解析 = true
        logger.warn?.(
            `[harden] 压缩阈值无法解析：${config.compactionThreshold}，已改用默认值 ${DEFAULT_COMPACTION_THRESHOLD}`,
        )
    }
    // 兜底常量本身解析不出来，只可能是有人把 config.ts 的默认值改成了不认得的写法。
    const 阈值 = 配置阈值 ?? 解析压缩阈值(DEFAULT_COMPACTION_THRESHOLD)
    if (阈值 === null) return

    // 窗口必须在这里现取：contextPressure 是投影读取，只能在服务就绪后的监听器内调。
    const 窗口 = tokenMeter.contextPressure(session).contextWindow
    const 阈值token数 = 换算阈值Token数(阈值, 窗口, logger)
    if (阈值token数 === null) return

    let measurement = tokenMeter.measure(session)
    if (measurement.totalTokens < 阈值token数) return

    const pruner = ctx.get<ToolResultPrunerService>('toolResultPruner')
    if (pruner !== undefined) {
        pruner.pruneSession(session)
        measurement = tokenMeter.measure(session)
        if (measurement.totalTokens < 阈值token数) return
    }

    const range = selectCompactableRange(session, measurement, Math.floor(阈值token数 * RETAIN_RATIO))
    if (range === null) return

    // `compaction/start` 的 turn 必须与会话里真实打开的回合一致；平台投影比扫日志更权威，
    // 且 openTurnStartSeq 为 null 就是「没有打开的回合」。
    const 回合边界 = agents.turnBoundaryOf(session)
    if (回合边界.openTurnStartSeq === null) {
        logger.warn?.('[harden] 压缩：会话当前没有打开的回合，本次跳过')
        return
    }

    logger.info?.(
        `[harden] 规则「上下文自动压缩」触发：totalTokens=${measurement.totalTokens} ` +
            `阈值=${阈值token数} 窗口=${窗口 ?? '未知'} 回合=${回合边界.lastTurn} ` +
            `压缩区间 ${range.start}..${range.end}（${range.shadowedSeqs.length} 个节点）`,
    )

    await runCompactionTransaction({
        session,
        agent: payload.agent,
        turn: 回合边界.lastTurn,
        signal: payload.signal,
        instruction: config.compactionInstruction,
        range,
        tokenMeter,
        llm,
        logger,
    })
}

/**
 * 照抄官方 `selectCompactableRange`（`dsh-compaction-basic/lib/index.js:410`）：
 * 从尾部往前按**精算 tokens** 累加出一个保留区，再往外收 tool 配对平衡边界。
 *
 * 注意第 4 步累加的是 `tokens`（精算），不是 `heuristicTokens`。
 *
 * @param session - 会话（提供权威 surface 位置）。
 * @param measurement - token-meter 的测量结果。
 * @param retainTokens - 至少原样保留的最近尾部预算。
 * @returns 可压的闭区间与它遮蔽的 seq 组；无安全区间时返回 null。
 */
function selectCompactableRange(
    session: SessionLike,
    measurement: TokenMeasurementLike,
    retainTokens: number,
): CompactionRange | null {
    const pricedNodes = measurement.nodes
    if (pricedNodes.length === 0) return null

    const surfaceNodes = session.surface?.nodes
    if (surfaceNodes === undefined) return null
    if (surfaceNodes.length !== pricedNodes.length) {
        throw new Error('compaction: token-meter surface does not match the current session surface')
    }
    for (let index = 0; index < surfaceNodes.length; index += 1) {
        if (surfaceNodes[index] !== pricedNodes[index].seq) {
            throw new Error('compaction: token-meter surface does not match the current session surface')
        }
    }

    const headEvent = surfaceNodes.length > 0 ? session.eventAt?.(surfaceNodes[0]) : undefined
    const firstIdx = headEvent?.type === 'system/message' ? 1 : 0

    let accumulated = 0
    let keepFromIdx = pricedNodes.length
    for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
        accumulated += pricedNodes[index].tokens
        keepFromIdx = index
        if (accumulated >= retainTokens) break
    }
    if (keepFromIdx <= firstIdx) return null

    while (keepFromIdx > firstIdx) {
        const cutSeq = surfaceNodes[keepFromIdx] as Parameters<typeof toolPairingBalancedBefore>[1]
        if (toolPairingBalancedBefore(session as Parameters<typeof toolPairingBalancedBefore>[0], cutSeq) === true) break
        keepFromIdx -= 1
    }
    if (keepFromIdx <= firstIdx) return null

    const shadowedSeqs = surfaceNodes.slice(firstIdx, keepFromIdx)
    let shadowedHeuristicTokenCount = 0
    let shadowedRouteTokenCount = 0
    for (let index = firstIdx; index < keepFromIdx; index += 1) {
        shadowedHeuristicTokenCount += pricedNodes[index].heuristicTokens
        shadowedRouteTokenCount += pricedNodes[index].tokens
    }

    return {
        start: surfaceNodes[firstIdx],
        end: surfaceNodes[keepFromIdx - 1],
        shadowedSeqs,
        shadowedHeuristicTokenCount,
        shadowedRouteTokenCount,
    }
}

/**
 * 执行一次压缩事务：写 4 个事件，任何一步抛错都补一条带 `error` 的 `compaction/end`
 * 再往外抛（用户定稿：失败静默，最外层只记日志、什么都不改）。
 *
 * @param deps - 事务入参（会话、区间、服务、日志）。
 */
async function runCompactionTransaction(deps: TransactionDeps): Promise<void> {
    const { session, range, tokenMeter, llm, logger } = deps
    const compactionId = CompactionId(randomUUID())
    const turn = deps.turn

    const startEvent = session.append('compaction/start', { compactionId, turn }) as { seq: number } | undefined
    const startSeq = startEvent === undefined ? undefined : startEvent.seq
    if (typeof startSeq !== 'number') {
        // start 已经落库（持有锁）；拿不到 seq 就必须补一条 end 释放锁，否则会话永久锁死。
        session.append('compaction/end', {
            compactionId,
            turn,
            error: 'compaction: start event seq unavailable',
        })
        logger.warn?.('[harden] 压缩：start 事件拿不到 seq，已释放锁')
        return
    }

    try {
        const summarized = await summarizeWithLlm(session, deps.agent, deps.instruction, range, llm, deps.signal)

        const checkpointContent = [
            { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
            ...summarized.summary,
            { type: 'text', text: SUMMARY_CLOSE_TAG },
        ]
        const checkpointMessage = createUserMessage({
            content: checkpointContent,
            source: compactCheckpointSource(compactionId),
        })

        // 安全校验：框架化后的 checkpoint 必须真的比被遮蔽的内容更小，否则放弃。
        const framedSummaryTokenCount = tokenMeter.estimateMessage(checkpointMessage)
        if (framedSummaryTokenCount >= range.shadowedRouteTokenCount) {
            throw new Error('compaction: framed summary is not smaller than the shadowed range')
        }

        const summaryEvent = session.append('compaction/summary', {
            compactionId,
            summary: summarized.summary,
            rawOutput: summarized.rawOutput,
            llmStreamCall: true,
            shadowedRange: { start: range.start, end: range.end },
            shadowedSeqs: [...range.shadowedSeqs],
            shadowedTokenCount: range.shadowedHeuristicTokenCount,
            provider: summarized.provider,
            model: summarized.model,
            maxTokens: SUMMARY_MAX_TOKENS,
        }) as { seq: number } | undefined

        const summarySeq = summaryEvent === undefined ? undefined : summaryEvent.seq
        if (typeof summarySeq !== 'number') {
            throw new Error('compaction: summary event was not appended')
        }

        // ② ③ 必须相邻：summary 与替换 user/message 之间不许插任何东西。
        session.append('user/message', checkpointMessage, {
            surfaceOp: { op: 'replace', startSeq: range.start, endSeq: range.end },
            sourceEventSeqs: [startSeq, summarySeq, ...range.shadowedSeqs],
        })

        session.append('compaction/end', { compactionId, turn })
        logger.info?.(`[harden] 规则「上下文自动压缩」完成：compactionId=${compactionId}`)

    } catch (error) {
        try {
            session.append('compaction/end', { compactionId, turn, error: String(error) })

        } catch (closeError) {
            logger.warn?.('[harden] 压缩失败后写 compaction/end 也失败', closeError)
        }

        throw error
    }
}

/**
 * 照抄官方 `summarizeWithLlm`（`dsh-compaction-basic/lib/index.js:292`）：复用对话
 * 前缀（system + tools + 被遮蔽消息），末尾追加一条指令 user 消息，再调
 * `ctx.llm.stream()`。
 *
 * @param session - 提供 surface、消息投影与路由头的会话。
 * @param agent - 提供 provider/model 兜底的 agent。
 * @param instruction - 用户配置的压缩指令。
 * @param range - 被遮蔽的可压区间。
 * @param llm - 平台 LLM 服务。
 * @param signal - 当前回合的取消信号。
 * @returns 安全的纯文本摘要块、原始输出、实际路由。
 */
async function summarizeWithLlm(
    session: SessionLike,
    agent: AgentLike | undefined,
    instruction: string,
    range: CompactionRange,
    llm: LlmService,
    signal: unknown,
): Promise<SummaryResult> {
    const header = session.requestHeader?.()
    const provider = header?.config?.provider ?? agent?.options?.provider
    const model = header?.config?.model ?? agent?.options?.model
    if (provider === undefined || model === undefined) {
        throw new Error('no provider/model available for summarization')
    }

    const surfaceNodes = session.surface?.nodes ?? []
    const headEvent = surfaceNodes.length > 0 ? session.eventAt?.(surfaceNodes[0]) : undefined
    const systemMessage = headEvent?.type === 'system/message' ? session.deriveEventMessage?.(headEvent) : undefined

    const regionMessages: unknown[] = []
    for (const seq of range.shadowedSeqs) {
        const event = session.eventAt?.(seq)
        if (event === undefined) continue
        const message = session.deriveEventMessage?.(event)
        if (message === undefined || message === null) continue
        regionMessages.push(message)
    }

    const prefix = systemMessage === undefined ? regionMessages : [systemMessage, ...regionMessages]
    const messages = [...prefix, { role: 'user', content: [{ type: 'text', text: instruction }] }]

    const assembler = new BlockAssembler()
    for await (const chunk of llm.stream({
        provider,
        model,
        messages,
        toolHistory: session.toolHistory?.(),
        ...(header?.tools === undefined ? {} : { tools: header.tools }),
        maxTokens: SUMMARY_MAX_TOKENS,
        sessionId: session.id,
        purpose: 'compaction',
        ...(signal === undefined ? {} : { signal }),
    })) {
        assembler.push(chunk)
    }

    const finishKind = assembler.finish.kind
    if (finishKind === 'error' || finishKind === 'aborted') {
        throw new Error(`summarization finished abnormally: ${finishKind}`)
    }

    const rawOutput = assembler.blocks()
    const summary: SummaryBlock[] = []
    for (const block of rawOutput) {
        if (block.type === 'text' && typeof block.text === 'string') summary.push(block)
    }
    if (summary.some((block) => (block.text ?? '').trim().length > 0) === false) {
        throw new Error('summarization produced no text summary content')
    }

    return { summary, rawOutput, provider, model }
}
