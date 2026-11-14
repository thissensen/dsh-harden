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

/** 一条兜底重试的链坐标：回合、步、provider 与模型，四者全等才算同一条链。 */
export interface RetryCoordinate {
    turn: number
    step: number
    provider: string
    model: string
}

/** 一条重试链的账：这条链已经写进日志几次，以及整条链共用的 retryId。 */
export interface RetryBudget {
    count: number
    retryId: string
}

/** 每个 agent 一本账：键 = 链坐标串（见 `链坐标键`），值 = 该链的 `RetryBudget`。 */
export type RetrySlotLedger = WeakMap<object, Map<string, RetryBudget>>

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

/**
 * 本插件兜底重试写在事件 `policyKey` 上的标记：与官方 provider 策略区分开。
 *
 * **为什么把模型编进来。** 平台的链键是 `(turn, step, provider, policyKey)`——里面**没有 model**。
 * 换模型若只改内存口径、policyKey 照旧，平台仍把两次重试当同一条链：它会看到两个 retryId、序号
 * 从 1 重启，读这份会话时整份拒读。把 model 编进 policyKey，换模型在平台眼里才真的换链。
 *
 * @param model - 本次重试用的模型名；取不到时调用方传 `'-'`（都落在同一条链上，不制造新链）。
 */
function fallbackPolicyKey(model: string): string {
    return JSON.stringify(['harden-fallback', model])
}

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
 * @param retryId - 本 policy chain 的重试 id（同链复用，由 `peekRetrySlot` 分配）。
 * @param retry - 这是第几次兜底重试（从 1 起）。
 * @param maxRetries - 兜底次数上限（界面显示成 `{retry}/{maxRetries}`）。
 * @returns 两条事件的类型与数据。
 */
export function buildRetryEvents(
    payload: RetryCoordinate & { failure: LlmFailureLike },
    retryId: string,
    retry: number,
    maxRetries: number,
): { scheduledType: string; scheduledData: RetryEventData; startedType: string; startedData: RetryStartedEventData } {
    return {
        scheduledType: 'llm/retry',
        scheduledData: {
            retryId,
            turn: payload.turn,
            step: payload.step,
            provider: payload.provider,
            mode: 'normal',
            policyKey: fallbackPolicyKey(payload.model),
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
 * 链坐标的账本键。
 *
 * 用 JSON 数组串而不是分隔符拼接：provider 与 model 都是自由文本，分隔符可能撞进内容里
 * （与 `retry-chain-ledger.ts` 的 `构造重试链键` 同一手法；那边键里放事件的 policyKey，
 * 这边放内存里的 model——平台的链键不含 model，靠 `fallbackPolicyKey` 表达）。
 *
 * @param 坐标 - 本次重试的链坐标。
 * @returns 该坐标在账本里的键。
 */
function 链坐标键(坐标: RetryCoordinate): string {
    return JSON.stringify([坐标.turn, 坐标.step, 坐标.provider, 坐标.model])
}

/**
 * 查一次兜底重试名额——**只算不记**；`llm/retry` 事件写成功之后才调 `commitRetrySlot` 落账。
 *
 * **键含回合与步号，所以不需要清表。** 平台校验器在整份日志里用 `(turn, step, provider, policyKey)`
 * 找同一条链的最后一条（`findLast`），与本账本同构；回合号与步号只会往前走，旧坐标不可能复现。
 * 平台自己的 `dsh-llm-retry` 要按 `step/start` 清空，是因为它的键里没有回合与步号。
 *
 * **同链共用一个 retryId、换链必换新 id。** 平台校验要求同一链内的 retry 事件复用同一个 retryId，
 * 且新链的 retryId 不得与本会话任何已出现的链重复；「链是否变化」的判据只在这里写一份。
 * 注意平台的链键里没有 model，换模型要靠 `fallbackPolicyKey` 把 model 编进 policyKey 才成为新链。
 *
 * @param 账本组 - 每个 agent 的兜底重试账。
 * @param agent - agent 对象（WeakMap 的 key）。
 * @param 坐标 - 本次重试的链坐标。
 * @param limit - 用户配置的兜底次数上限。
 * @returns 还有名额时返回本链的 retryId 与这是第几次（从 1 起）；已用尽返回 null（此时什么都不记）。
 */
export function peekRetrySlot(
    账本组: RetrySlotLedger,
    agent: object,
    坐标: RetryCoordinate,
    limit: number,
): RetryBudget | null {
    const 上一条 = 账本组.get(agent)?.get(链坐标键(坐标))
    const count = 上一条 === undefined ? 1 : 上一条.count + 1
    if (count > limit) return null

    return { count, retryId: 上一条?.retryId ?? randomUUID() }
}

/**
 * 记一次名额：把 `peekRetrySlot` 查到的名额落账。
 *
 * **必须在 `llm/retry` 写成功之后调。** 账本只记「已经进日志的那一条」：先记会让写失败的那次
 * 白白占掉一格，账本比日志多一格，之后同链写出的序号与日志对不上。
 *
 * @param 账本组 - 每个 agent 的兜底重试账。
 * @param agent - agent 对象（WeakMap 的 key）。
 * @param 坐标 - 本次重试的链坐标。
 * @param 名额 - `peekRetrySlot` 给出的名额。
 */
export function commitRetrySlot(
    账本组: RetrySlotLedger,
    agent: object,
    坐标: RetryCoordinate,
    名额: RetryBudget,
): void {
    let 账本 = 账本组.get(agent)
    if (账本 === undefined) {
        账本 = new Map()
        账本组.set(agent, 账本)
    }

    账本.set(链坐标键(坐标), 名额)
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
