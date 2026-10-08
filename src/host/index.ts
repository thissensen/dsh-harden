/**
 * dsh-harden —— host 半边。
 *
 * 挂两个公开事件：`agent/turn-stopping`（serial）上跑规则 H1 与 H2，`agent/request-error`
 * （waterfall）上跑规则 H3。其余模块（上下文自动压缩、子代理通知聚合、后台 job 工具）
 * 由各自文件挂载。
 *
 * **为什么 H1 也挂收尾点。** 真机会话实测（2026-09-27）：工具调用失败的那个回合只有 1 步，
 * 旧挂点 `agent/pre-step` 判「上一步」永远判不到。改成读本回合最后一步的正文，挂在回合
 * 收尾边界上，与 H2 同一个监听器里依次判定。
 *
 * **为什么只能 steer。** `agent/turn-stopping` 是 serial，监听器没有 `next`，也不能靠
 * 返回值改变结果；反对收尾的唯一手段是在监听器里调 `agent.steer(...)`——平台收尾前会重读
 * 收件箱，有新的引导就再走一步，没有才真正关闭回合。
 *
 * **配置面归平台**：插件只导出 schema（`Config`），平台把 profile 里这条 row 的 `config`
 * 校验后从 `apply(ctx, config)` 交进来。插件自己不落任何配置文件。
 *
 * 关于 `name`：`cordis.patch.yml` 里那个 row 的 `id` 必须与它一致。
 *
 * @module dsh-harden
 */

import { createRequire } from 'node:module'
import type {
    Ctx,
    Logger,
    RequestErrorAction,
    RequestErrorPayload,
    TurnStoppingPayload,
} from './types.js'
import { readConfig, type HardenConfig } from './config.js'
import {
    detectEmptyTurnEnd,
    detectSilentToolFailure,
    EMPTY_TURN_NUDGE_TEXT,
    NUDGE_TEXT,
} from './guard.js'
import { buildRetryEvents, matchesRetryTokens, takeRetrySlot, type RetryBudget } from './retry.js'
import { mountApi } from './api.js'
import type { ConfigScope } from './api.js'
import { mountJobBackground } from './job-background.js'
import { mountContextCompaction } from './compaction.js'
import { mountSubagentAggregation } from './subagent-aggregate.js'
import { SETTINGS_NAMESPACE } from './config.js'

/** 平台按这个 id 认配置 schema（`Config` 是平台侧的约定名，见 config.ts）。 */
export { Config } from './config.js'

/** `cordis.patch.yml` 里 row 的 id 必须与它一致。 */
export const name = 'harden'

/** 平台自带的消息构造器（走同步 require，ESM 下用 createRequire 拿）。 */
const hostRequire = createRequire(import.meta.url)

/** 一个 agent 在一个回合内已注入几次——只用于日志留痕，不做拦截。 */
interface NudgeBudget {
    turn: number
    count: number
}

/** 本插件挂载期的活状态。 */
interface HardenState {
    /** 每个 agent 的注入计数；key 是 agent 对象本身（WeakMap 让回收自动发生）。 */
    budgets: WeakMap<object, NudgeBudget>
    /** 每个 agent 的兜底重试记账（规则 H3）。 */
    retryBudgets: WeakMap<object, RetryBudget>
}

/**
 * 插件入口。
 *
 * @param ctx - cordis 上下文。
 * @param config - 平台按 `Config` schema 校验后交进来的配置（含 volatile 引用）。
 */
export function apply(ctx: Ctx, config: unknown): void {
    const logger: Logger = ctx.logger ?? console
    logger.info?.('[harden] host 半边已挂载')

    const state: HardenState = { budgets: new WeakMap(), retryBudgets: new WeakMap() }
    const current: () => Required<HardenConfig> = () => readConfig(config)

    mountTurnStoppingGuard(ctx, logger, state, current)
    mountRequestErrorGuard(ctx, logger, state, current)

    const now = current()
    logger.info?.(
        `[harden] 规则 H1（工具调用失败被吞）= ${now.toolFailureGuard ? '开' : '关'}` +
            `（挂 agent/turn-stopping，失败前缀 ${now.toolFailurePrefixes === '' ? '未配置' : '已配置'}）`,
    )
    logger.info?.(`[harden] 规则 H2（回合无正文收尾）= ${now.emptyOutputGuard ? '开' : '关'}`)
    logger.info?.(`[harden] 规则 H3（网络请求中断续跑）= ${now.networkRetryCount > 0 ? `开，兜底 ${now.networkRetryCount} 次` : '关'}`)
    logger.info?.(
        `[harden] 规则「上下文自动压缩」= ${now.contextCompaction ? `开，阈值 ${now.compactionThreshold}，范围 ${now.compactionScope}` : '关'}`,
    )
    logger.info?.(`[harden] 规则「子代理通知聚合」= ${now.subagentAggregation ? '开' : '关'}`)

    mountConfigApi(ctx, logger, config)
    mountContextCompaction(ctx, logger, () => current())
    mountJobBackground(ctx, logger, () => current().backgroundJobTool)
    mountSubagentAggregation(ctx, logger, () => current())
}

/**
 * 挂设置页的配置通路。
 *
 * **为什么用注入回调而不是顶层声明。** `settings` 与 `webServer` 由别的插件提供，
 * 就绪时机与本插件的 `apply` 先后顺序不作保证；等它们都到齐了再建作用域、再注册路由，
 * 比在 `apply` 时赌一把稳。缺服务时回调根本不会被调用——与「缺省不干预」一致。
 *
 * `webRuntime` 只为取信任主机清单（用户在本机显式信任的非回环 authority）。
 *
 * @param ctx - cordis 上下文。
 * @param logger - 日志出口。
 * @param config - `apply` 收到的原始配置对象（含 volatile 引用；每次读取都要现取现解包）。
 */
function mountConfigApi(ctx: Ctx, logger: Logger, config: unknown): void {
    if (typeof ctx.inject !== 'function') {
        logger.warn?.('[harden] ctx.inject 不可用，设置页的配置通路未挂上')
        return
    }

    ctx.inject(['webServer', 'webRuntime', 'settings'], (webCtx: Ctx) => {
        const settings = webCtx.settings
        if (settings === undefined) return

        const scope: ConfigScope = {
            get: () => readConfig(config),
            update: (patch: object) => settings.update(SETTINGS_NAMESPACE, patch),
        }

        const webRuntime = (webCtx as unknown as { webRuntime?: { trustedHosts?: unknown } }).webRuntime
        const trustedHosts = Array.isArray(webRuntime?.trustedHosts) ? (webRuntime?.trustedHosts as string[]) : []

        mountApi(webCtx, logger, {
            getScope: () => scope,
            trustedHosts,
        })
    })
}

/**
 * 挂规则 H1 与 H2：`agent/turn-stopping` 上依次判定两条规则，命中就 steer 回一步。
 *
 * **为什么只注册一个监听器。** 两条规则挂在同一个点上，各判各的：H1 看「最后一步的正文
 * 有没有命中失败前缀」，H2 看「最后一步有没有正文」——不可能同时命中，所以不需要互斥标记
 * 或短路逻辑。合成一个监听器让收尾边界的异常边界只有一处。
 *
 * **为什么用 steer 而不是返回值。** 这个事件是 serial 模式，监听器没有 `next`；平台文档
 * 写明了反对收尾的唯一手段就是在监听器里调 `agent.steer(...)`——平台收尾前会重读收件箱，
 * 有新的引导就再走一步，没有才真正关闭回合。
 *
 * @param ctx - cordis 上下文。
 * @param logger - 日志出口。
 * @param state - 活状态（注入计数）。
 * @param current - 现取现解包的配置读取器。
 */
function mountTurnStoppingGuard(
    ctx: Ctx,
    logger: Logger,
    state: HardenState,
    current: () => Required<HardenConfig>,
): void {
    if (typeof ctx.on !== 'function') {
        logger.warn?.('[harden] ctx.on 不可用，规则 H1 与 H2 均未挂上')
        return
    }

    ctx.on('agent/turn-stopping', async (payloadRaw: unknown): Promise<void> => {
        try {
            await considerToolFailureSteer(payloadRaw, state, current, logger)
            await considerEmptyTurnSteer(payloadRaw, state, current, logger)

        } catch (error) {
            // 看护层自己的异常绝不能挡住回合收尾——出错就什么都不做。
            logger.error?.('[harden] 回合收尾判定异常，已放行', error)
        }
    })
}

/**
 * 判定 + steer（规则 H1）。命中就往收件箱投一条纠正消息，把回合拽回再走一步。
 *
 * @param payloadRaw - `agent/turn-stopping` 的载荷（形状由平台保证，这里按需收窄）。
 * @param state - 活状态（注入计数）。
 * @param current - 配置读取器。
 * @param logger - 日志出口。
 */
async function considerToolFailureSteer(
    payloadRaw: unknown,
    state: HardenState,
    current: () => Required<HardenConfig>,
    logger: Logger,
): Promise<void> {
    const payload = payloadRaw as TurnStoppingPayload | null
    if (payload === null || typeof payload !== 'object') return

    const config = current()
    if (config.toolFailureGuard !== true) return

    const agent = payload.agent as unknown as object
    const turn = payload.turn ?? 0
    const hit = detectSilentToolFailure(payload.agent.session, turn, config.toolFailurePrefixes)
    if (hit === null) return

    const steer = payload.agent.steer
    if (typeof steer !== 'function') return

    const count = takeBudget(state, agent, turn)

    logger.info?.(
        `[harden] 规则 H1 命中：turn=${turn} ${hit}，steer 纠正消息（第 ${count} 次）`,
    )
    // 只传暗号：平台把 notice 的 summary 类型写死成 string，塞不了对象；
    // client 侧 nudge-row.ts 拆开后再用现成的 t 翻译。
    const summary = `nudge.toolFailure|${count}`

    steer.call(payload.agent, makeNudgeMessage(NUDGE_TEXT, summary))
}

/**
 * 判定 + steer。命中就往收件箱投一条纠正消息，把回合拽回再走一步。
 *
 * @param payloadRaw - `agent/turn-stopping` 的载荷（形状由平台保证，这里按需收窄）。
 * @param state - 活状态（注入计数）。
 * @param current - 配置读取器。
 * @param logger - 日志出口。
 */
async function considerEmptyTurnSteer(
    payloadRaw: unknown,
    state: HardenState,
    current: () => Required<HardenConfig>,
    logger: Logger,
): Promise<void> {
    const payload = payloadRaw as TurnStoppingPayload | null
    if (payload === null || typeof payload !== 'object') return
    if (current().emptyOutputGuard !== true) return

    const agent = payload.agent as unknown as object
    const turn = payload.turn ?? 0
    const hit = detectEmptyTurnEnd(payload.agent.session, turn)
    if (hit === null) return

    const steer = payload.agent.steer
    if (typeof steer !== 'function') return

    const count = takeBudget(state, agent, turn)

    logger.info?.(
        `[harden] 规则 H2 命中：turn=${turn}，steer 纠正消息（第 ${count} 次）`,
    )
    // 只传暗号，理由同上（见 considerToolFailureSteer）。
    const summary = `nudge.emptyTurn|${count}`

    steer.call(payload.agent, makeNudgeMessage(EMPTY_TURN_NUDGE_TEXT, summary))
}

/**
 * 挂规则 H3：`agent/request-error` 上判定「官方重试放弃后，要不要再补一轮」。
 *
 * **为什么先 await next()。** 平台官方的 `dsh-llm-retry` 挂在同一个点上，它自己
 * 还有重试名额时根本不调用下游；只有它放弃时才把控制权交给下一个监听器。所以这里
 * 先 `await next()` 拿到官方（以及任何更内层监听器）的决定——已经是 retry 就跟着走，
 * 否则才轮到本插件兜底。这个顺序在官方先注册或后注册两种情况下都成立。
 *
 * @param ctx - cordis 上下文。
 * @param logger - 日志出口。
 * @param state - 活状态（兜底重试记账）。
 * @param current - 现取现解包的配置读取器。
 */
function mountRequestErrorGuard(
    ctx: Ctx,
    logger: Logger,
    state: HardenState,
    current: () => Required<HardenConfig>,
): void {
    if (typeof ctx.on !== 'function') {
        logger.warn?.('[harden] ctx.on 不可用，规则 H3 未挂上')
        return
    }

    ctx.on('agent/request-error', async (payloadRaw: unknown, nextRaw: unknown): Promise<unknown> => {
        const next = nextRaw as () => Promise<RequestErrorAction>
        const officialDecision = await next()

        try {
            return considerRetry(payloadRaw, officialDecision, state, current, logger)

        } catch (error) {
            // 看护层自己的异常绝不能把正常失败流程搞乱——出错就原样放行官方决定。
            logger.error?.('[harden] 规则 H3 判定异常，已放行', error)
            return officialDecision
        }
    })
}

/**
 * 判定 + 兜底重试。判定在 `retry.ts`，这里只做收窄载荷、读配置、记账。
 *
 * @param payloadRaw - `agent/request-error` 的载荷（形状由平台保证，这里按需收窄）。
 * @param officialDecision - 更内层监听器（官方 retry）的决定。
 * @param state - 活状态（兜底重试记账）。
 * @param current - 配置读取器。
 * @param logger - 日志出口。
 * @returns 官方已决定重试就跟着走；否则视配置与本步剩余名额决定是否兜底重试。
 */
function considerRetry(
    payloadRaw: unknown,
    officialDecision: RequestErrorAction,
    state: HardenState,
    current: () => Required<HardenConfig>,
    logger: Logger,
): RequestErrorAction {
    if (officialDecision?.kind === 'retry') return officialDecision

    const payload = payloadRaw as RequestErrorPayload | null
    if (payload === null || typeof payload !== 'object') return officialDecision

    const config = current()
    if (config.networkRetryCount <= 0) return officialDecision

    if (matchesRetryTokens(payload.failure, config.networkRetryTokens) === false) return officialDecision

    const agent = payload.agent as unknown as object
    const slot = takeRetrySlot(
        state.retryBudgets,
        agent,
        payload.turn,
        payload.step,
        config.networkRetryCount,
    )
    if (slot === null) return officialDecision

    logger.info?.(
        `[harden] 规则 H3 命中：turn=${payload.turn} step=${payload.step} provider=${payload.provider} ` +
            `code=${payload.failure?.code ?? '-'}，兜底重试（第 ${slot.count} 次）`,
    )

    reportRetryToSession(payload, slot.retryId, slot.count, config.networkRetryCount)

    return { kind: 'retry' }
}

/**
 * 往会话写一对重试事件，让界面显示「已重试模型请求（n/max）· 1s」。
 *
 * 事件形状与官方 `dsh-llm-retry` 一致（界面认的就是这两条）。写入面是可选的：
 * 测试桩与老版本会话可能没有 `append`，缺失时照常重试，只是界面看不到那行提示。
 *
 * @param payload - `agent/request-error` 载荷。
 * @param retryId - 本 policy chain 的重试 id（由 `takeRetrySlot` 分配，同链复用）。
 * @param retry - 这是第几次兜底重试（从 1 起）。
 * @param maxRetries - 兜底次数上限。
 */
function reportRetryToSession(
    payload: RequestErrorPayload,
    retryId: string,
    retry: number,
    maxRetries: number,
): void {
    const append = payload.agent.session?.append
    if (typeof append !== 'function') return

    const events = buildRetryEvents(payload, retryId, retry, maxRetries)
    append.call(payload.agent.session, events.scheduledType, events.scheduledData)
    append.call(payload.agent.session, events.startedType, events.startedData)
}

/**
 * 记一次注入次数。
 *
 * 回合号变化 = 新回合，计数清零；同一回合内每调一次加一。
 * **不做上限拦截**（用户定稿）：计数只用于日志留痕。
 *
 * @param state - 活状态。
 * @param agent - agent 对象（WeakMap 的 key）。
 * @param turn - 当前回合。
 * @returns 本回合内的第几次注入。
 */
function takeBudget(state: HardenState, agent: object, turn: number): number {
    const previous = state.budgets.get(agent)
    const count = previous !== undefined && previous.turn === turn ? previous.count + 1 : 1
    state.budgets.set(agent, { turn, count })
    return count
}

/**
 * 看护层纠正消息的来源标记。
 *
 * **为什么不借用 'user'。** 借用的话，插件注入的内容与用户本人的发言在日志、
 * 界面、模型侧完全同形——2026-09-27 实测确认：两者的 source 结构一模一样，
 * 事后排查分不出「这句是人说的还是看护层塞的」。
 *
 * 平台的 MessageSource 是**合并可扩展**的联合类型，每个生产者在自己模块里声明
 * kind，没有共享的兜底 kind；subagent-settled、skill-invocation 是同类先例。
 *
 * form: 'notice' 取自平台的 ContextFormed，专给「刚发生的一件小事」用，
 * 配套的 summary 供界面折叠成一行显示。
 */
interface HardenNudgeMessageSource {
    readonly kind: 'harden-nudge'
    readonly form: 'notice'
    readonly summary: string
}

/** 平台 `@deepseek-ai/dsh-llm` 里本项目用到的部分。 */
interface LlmMessageFactory {
    createUserMessage(input: {
        content: readonly { type: 'text'; text: string }[]
        source: HardenNudgeMessageSource
    }): unknown
}

/**
 * 构造纠正消息。
 *
 * 走平台的 `createUserMessage` —— 它负责补 `id` 与 `source`，并深度冻结。
 * 用别的手段拼一条「长得像 UserMessage」的对象会被平台的消息不变量检查拒掉。
 *
 * @param text - 正文。
 * @param summary - 一行摘要，写进 source.summary 供界面折叠显示。
 * @returns 一条可直接交给 `agent.steer(...)` 的 user 消息。
 */
function makeNudgeMessage(text: string, summary: string): unknown {
    const llm = hostRequire('@deepseek-ai/dsh-llm') as LlmMessageFactory
    return llm.createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'harden-nudge', form: 'notice', summary },
    })
}
