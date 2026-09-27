/**
 * 规则 H3 —— 网络请求中断续跑（官方重试耗尽后的兜底）。
 *
 * **挂点与时机。** 平台 `dsh-llm-retry` 挂在同一个 `agent/request-error` 上，
 * 在它自己的重试次数**未耗尽**时直接返回 retry、**根本不调用下游**；只有它放弃
 * 时才 `next()` 到本插件。所以本插件天然只出现在「官方已经认输」这一刻。
 *
 * **为什么值得再做一次。** 平台每个 provider 的 `retryPolicy.maxRetries` 是注册时
 * 固定的（真机实测：`xkiro` 只给 1 次），一次瞬态失败就可能直接判死。本插件在官方
 * 放弃后再补几轮，让 502、超时、流中断这类瞬时故障多几次机会。
 *
 * @module dsh-harden/retry
 */

import { randomUUID } from 'node:crypto'

import type { LlmFailureLike } from './types.js'

/** 一个 agent 在一个 `turn/step` 上已经兜底重试了几次。 */
export interface RetryBudget {
    turn: number
    step: number
    count: number
}

/**
 * 写进 `llm/retry` 事件的数据（形状照官方 `dsh-llm-retry` 的 normal 分支）。
 *
 * 界面靠这条事件画「等待重试模型请求（n/max）· Ns」那一行，
 * 平台文案是写死的模板，插件改不了它的字，只能填这些数。
 */
export interface RetryEventData {
    retryId: string
    turn: number
    step: number
    provider: string
    mode: 'normal'
    policyKey: string
    retry: number
    maxRetries: number
    delayMs: number
    failure: LlmFailureLike
}

/** 写进 `llm/retry-started` 事件的数据（界面据此把状态改成「已重试」）。 */
export interface RetryStartedEventData {
    retryId: string
    turn: number
    step: number
    retry: number
}

/** 本插件兜底重试在事件 `policyKey` 上的标记：与官方 provider 策略区分开。 */
const FALLBACK_POLICY_KEY = '["harden-fallback"]'

/**
 * 构造一对重试事件的数据：先 `llm/retry`（等待），再 `llm/retry-started`（已重试）。
 *
 * **为什么连着写两条。** 官方重试要等退避延迟，所以两条之间隔着一段时间；
 * 本插件是**立即重试**，两条连着写，界面直接停在「已重试模型请求」。
 *
 * `delayMs` 填 0：官方模板把它显示成 `max(1, ceil(ms/1000))` 秒，即恒为 1s——
 * 我们确实没有等待，填 0 最如实。
 *
 * @param payload - `agent/request-error` 载荷里本插件要用的字段。
 * @param retry - 这是第几次兜底重试（从 1 起）。
 * @param maxRetries - 兜底次数上限（界面显示成 `{retry}/{maxRetries}`）。
 * @returns 两条事件的类型与数据。
 */
export function buildRetryEvents(
    payload: { turn: number; step: number; provider: string; failure: LlmFailureLike },
    retry: number,
    maxRetries: number,
): { scheduledType: string; scheduledData: RetryEventData; startedType: string; startedData: RetryStartedEventData } {
    const retryId = randomUUID()

    return {
        scheduledType: 'llm/retry',
        scheduledData: {
            retryId,
            turn: payload.turn,
            step: payload.step,
            provider: payload.provider,
            mode: 'normal',
            policyKey: FALLBACK_POLICY_KEY,
            retry,
            maxRetries,
            delayMs: 0,
            failure: payload.failure,
        },
        startedType: 'llm/retry-started',
        startedData: { retryId, turn: payload.turn, step: payload.step, retry },
    }
}

/**
 * 这次失败是否命中配置的重试特征。
 *
 * `tokens` 是逗号分隔的清单，允许混装两类：`code` 名（英文大写）与 HTTP 状态码（数字）。
 * 匹配任一即算命中；清单为空视为「不重试任何失败」。
 *
 * @param failure - 平台归一化后的失败事实。
 * @param tokens - 用户配置的失败特征清单。
 * @returns 命中返回 true。
 */
export function matchesRetryTokens(failure: LlmFailureLike, tokens: string): boolean {
    const items = parseTokens(tokens)
    if (items.length === 0) return false

    for (const item of items) {
        if (failure.code !== undefined && failure.code === item) return true
        if (failure.status !== undefined && String(failure.status) === item) return true
    }

    return false
}

/**
 * 占一次兜底重试名额。
 *
 * 名额按 `turn + step` 记账：同一 `turn/step` 上每占一次加一，超出上限就拒绝；
 * 坐标一变（新一步/新回合）计数自动清零。**只增不删**——WeakMap 的 key 是 agent
 * 对象本身，agent 回收时记录随之消失，不需要手工清理。
 *
 * @param budgets - 每个 agent 的兜底重试记账。
 * @param agent - agent 对象（WeakMap 的 key）。
 * @param turn - 当前回合。
 * @param step - 当前步号。
 * @param limit - 用户配置的兜底次数上限。
 * @returns 还有名额时返回这是第几次（从 1 起）；已用尽返回 null。
 */
export function takeRetrySlot(
    budgets: WeakMap<object, RetryBudget>,
    agent: object,
    turn: number,
    step: number,
    limit: number,
): number | null {
    const previous = budgets.get(agent)
    const isSameStep = previous !== undefined && previous.turn === turn && previous.step === step
    const count = isSameStep ? previous.count + 1 : 1

    if (count > limit) return null

    budgets.set(agent, { turn, step, count })
    return count
}

/** 把逗号分隔的清单切成去空白的条目组。 */
function parseTokens(tokens: string): string[] {
    const parts: string[] = []
    for (const raw of tokens.split(',')) {
        const item = raw.trim()
        if (item !== '') parts.push(item)
    }

    return parts
}
