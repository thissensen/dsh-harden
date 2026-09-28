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
 * @module dsh-harden/compaction
 */

import { randomUUID } from 'node:crypto'

import { CompactionId, compactCheckpointSource, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'

import type {
    AgentLike,
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
 * 解析 `1M` / `200K` / `100000` 这类阈值文本；解析失败返回 null。
 *
 * `K` = 1000、`M` = 1000000，不区分大小写，允许首尾空白，必须是正整数。
 *
 * @param text - 用户配置的阈值文本。
 * @returns 解析出的 token 数；格式不对或不是正数时返回 null。
 */
export function parseTokenCount(text: string): number | null {
    const trimmed = text.trim()
    const matched = /^(\d+)([KkMm]?)$/.exec(trimmed)
    if (matched === null) return null

    const base = Number.parseInt(matched[1], 10)
    if (base <= 0) return null

    const unit = matched[2].toUpperCase()
    if (unit === 'K') return base * 1000
    if (unit === 'M') return base * 1000000

    return base
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
 * 用 `ctx.inject(['llm', 'tokenMeter'], cb)` 取服务——顶层属性访问在未 inject 时
 * 会抛 `cannot get property ... without inject`（坑 19），必须等两个服务都到齐
 * 再在 cb 里挂监听器。
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
    if (typeof ctx.inject !== 'function') {
        logger.warn?.('[harden] ctx.inject 不可用，规则「上下文自动压缩」未挂上')
        return
    }

    ctx.inject(['llm', 'tokenMeter'], (svcCtx: Ctx) => {
        const llm = svcCtx.llm
        const tokenMeter = svcCtx.tokenMeter
        if (llm === undefined || tokenMeter === undefined) {
            logger.warn?.('[harden] llm/tokenMeter 不可用，规则「上下文自动压缩」未挂上')
            return
        }
        if (typeof svcCtx.on !== 'function') {
            logger.warn?.('[harden] ctx.on 不可用，规则「上下文自动压缩」未挂上')
            return
        }

        svcCtx.on('agent/pre-step', async (payloadRaw: unknown, nextRaw: unknown): Promise<unknown> => {
            const next = nextRaw as () => Promise<unknown>
            const decision = await next()

            try {
                await considerCompaction(payloadRaw, current, logger, llm, tokenMeter)

            } catch (error) {
                // 看护层自己的异常绝不能挡住正常的一步——出错就什么都不改。
                logger.warn?.('[harden] 规则「上下文自动压缩」判定异常，已放行', error)
            }

            return decision
        })
    })
}

/**
 * 判定 + 执行一次压缩。判定在 `selectCompactableRange`，这里只做收窄载荷、读配置、记账。
 *
 * @param payloadRaw - `agent/pre-step` 的载荷。
 * @param current - 配置读取器。
 * @param logger - 日志出口。
 * @param llm - 平台 LLM 服务。
 * @param tokenMeter - 平台 token 计量服务。
 */
async function considerCompaction(
    payloadRaw: unknown,
    current: () => Required<HardenConfig>,
    logger: Logger,
    llm: LlmService,
    tokenMeter: TokenMeterService,
): Promise<void> {
    const payload = payloadRaw as PreStepPayloadLike | null
    if (payload === null || typeof payload !== 'object') return

    const session = payload.agent?.session
    if (session === undefined) return

    const config = current()
    if (shouldCompactSession(config, session) === false) return

    const thresholdTokens = parseTokenCount(config.compactionThreshold)
    if (thresholdTokens === null) {
        logger.warn?.(`[harden] 压缩阈值无法解析：${config.compactionThreshold}，本次跳过`)
        return
    }

    const measurement = tokenMeter.measure(session)
    if (measurement.totalTokens < thresholdTokens) return

    const retainTokens = Math.floor(thresholdTokens * RETAIN_RATIO)
    const range = selectCompactableRange(session, measurement, retainTokens)
    if (range === null) return

    // `compaction/start` 的 turn 必须与日志里真实打开的回合一致；直接信 payload.turn 有偏差风险。
    const openTurn = findOpenTurn(session)
    if (openTurn === null) {
        logger.warn?.('[harden] 压缩：会话当前没有打开的回合，本次跳过')
        return
    }

    logger.info?.(
        `[harden] 规则「上下文自动压缩」触发：totalTokens=${measurement.totalTokens} ` +
            `阈值=${thresholdTokens} 回合=${openTurn} 压缩区间 ${range.start}..${range.end}（${range.shadowedSeqs.length} 个节点）`,
    )

    await runCompactionTransaction({
        session,
        agent: payload.agent,
        turn: openTurn,
        signal: payload.signal,
        instruction: config.compactionInstruction,
        range,
        tokenMeter,
        llm,
        logger,
    })
}

/**
 * 从会话日志推导当前打开的回合号（照官方 `inspectCompactionEntryState` 的简化版）。
 *
 * 官方 `compaction/start` 的 turn 必须与会话里真实打开的回合一致，故从权威日志推导。
 * 从尾部往前扫：先遇 `turn/start` 取它的 `data.turn`；先遇 `turn/end` 表示没有打开的回合。
 *
 * @param session - 提供尾部 seq 与事件读取的会话。
 * @returns 打开着的回合号；没有打开的回合时返回 null。
 */
function findOpenTurn(session: SessionLike): number | null {
    const lastSeq = session.seq
    if (typeof lastSeq !== 'number') return null

    for (let seq = lastSeq - 1; seq >= 0; seq -= 1) {
        const event = session.eventAt?.(seq)
        if (event === undefined) return null
        if (event.type === 'turn/start') return event.data?.turn ?? null
        if (event.type === 'turn/end') return null
    }

    return null
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
    if (typeof session.append !== 'function') return

    const append = session.append
    const compactionId = CompactionId(randomUUID())
    const turn = deps.turn

    const startEvent = append.call(session, 'compaction/start', { compactionId, turn }) as { seq: number } | undefined
    const startSeq = startEvent === undefined ? undefined : startEvent.seq
    if (typeof startSeq !== 'number') {
        // start 已经落库（持有锁）；拿不到 seq 就必须补一条 end 释放锁，否则会话永久锁死。
        append.call(session, 'compaction/end', {
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

        const summaryEvent = append.call(session, 'compaction/summary', {
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
        append.call(session, 'user/message', checkpointMessage, {
            surfaceOp: { op: 'replace', startSeq: range.start, endSeq: range.end },
            sourceEventSeqs: [startSeq, summarySeq, ...range.shadowedSeqs],
        })

        append.call(session, 'compaction/end', { compactionId, turn })
        logger.info?.(`[harden] 规则「上下文自动压缩」完成：compactionId=${compactionId}`)

    } catch (error) {
        try {
            append.call(session, 'compaction/end', { compactionId, turn, error: String(error) })

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
