/**
 * 规则 H3（网络请求中断续跑）判定逻辑的持久化测试。
 *
 * 被测对象是 `src/host/retry.ts` 导出的两个纯函数：
 * `matchesRetryTokens()` 判定失败是否该兜底重试；`takeRetrySlot()` 管兜底名额。
 *
 * 判定与记账是两条独立的口径，这里分开覆盖：判定只看失败特征，记账只看坐标与上限。
 *
 * @module dsh-harden/tests/retry
 */

import { describe, expect, it } from 'vitest'
import type { LlmFailureLike } from '../src/host/types.js'
import { buildRetryEvents, matchesRetryTokens, takeRetrySlot, type RetryBudget } from '../src/host/retry.js'

/** 默认特征清单：与 `config.ts` 的 `DEFAULT_NETWORK_RETRY_TOKENS` 保持一致。 */
const DEFAULT_TOKENS = 'SERVER,RATE_LIMIT,TIMEOUT,TRANSPORT,502,429'

describe('matchesRetryTokens', () => {
    describe('命中：失败特征在清单里', () => {
        it('错误码命中：502 网关错误归一化成 SERVER', () => {
            const failure: LlmFailureLike = { message: '502 Bad Gateway', code: 'SERVER', status: 502 }

            expect(matchesRetryTokens(failure, DEFAULT_TOKENS)).toBe(true)
        })

        it('HTTP 状态码命中：没有 code 但有 429', () => {
            const failure: LlmFailureLike = { message: 'Too Many Requests', status: 429 }

            expect(matchesRetryTokens(failure, DEFAULT_TOKENS)).toBe(true)
        })

        it('错误码命中：请求超时没有 HTTP 状态码', () => {
            const failure: LlmFailureLike = { message: 'Request timed out.', code: 'TIMEOUT' }

            expect(matchesRetryTokens(failure, DEFAULT_TOKENS)).toBe(true)
        })

        it('错误码命中：流中断', () => {
            const failure: LlmFailureLike = { message: 'Upstream stream ended before terminal chunk', code: 'TRANSPORT' }

            expect(matchesRetryTokens(failure, DEFAULT_TOKENS)).toBe(true)
        })

        it('清单允许混装且带空白：能匹配状态码', () => {
            const failure: LlmFailureLike = { message: 'Bad Gateway', status: 502 }

            expect(matchesRetryTokens(failure, ' SERVER , 502 ')).toBe(true)
        })
    })

    describe('放行：失败特征不在清单里', () => {
        it('鉴权失败不该重试', () => {
            const failure: LlmFailureLike = { message: 'Unauthorized', code: 'AUTH', status: 401 }

            expect(matchesRetryTokens(failure, DEFAULT_TOKENS)).toBe(false)
        })

        it('清单为空 = 不重试任何失败', () => {
            const failure: LlmFailureLike = { message: 'Bad Gateway', code: 'SERVER', status: 502 }

            expect(matchesRetryTokens(failure, '')).toBe(false)
        })

        it('清单只有逗号和空白 = 不重试任何失败', () => {
            const failure: LlmFailureLike = { message: 'Bad Gateway', code: 'SERVER', status: 502 }

            expect(matchesRetryTokens(failure, ' , , ')).toBe(false)
        })

        it('失败信息里既没有 code 也没有 status', () => {
            const failure: LlmFailureLike = { message: '未知故障' }

            expect(matchesRetryTokens(failure, DEFAULT_TOKENS)).toBe(false)
        })

        it('错误码大小写不匹配就不算命中', () => {
            const failure: LlmFailureLike = { message: 'Bad Gateway', code: 'server' }

            expect(matchesRetryTokens(failure, DEFAULT_TOKENS)).toBe(false)
        })
    })
})

describe('takeRetrySlot', () => {
    /** 每个用例一块独立记账，互不干扰。 */
    function makeBudgets(): WeakMap<object, RetryBudget> {
        return new WeakMap()
    }

    it('第一次占用返回 1，之后每次加一', () => {
        const budgets = makeBudgets()
        const agent = {}

        expect(takeRetrySlot(budgets, agent, 1, 3, 3)).toBe(1)
        expect(takeRetrySlot(budgets, agent, 1, 3, 3)).toBe(2)
        expect(takeRetrySlot(budgets, agent, 1, 3, 3)).toBe(3)
    })

    it('用满上限后返回 null', () => {
        const budgets = makeBudgets()
        const agent = {}

        expect(takeRetrySlot(budgets, agent, 1, 3, 2)).toBe(1)
        expect(takeRetrySlot(budgets, agent, 1, 3, 2)).toBe(2)
        expect(takeRetrySlot(budgets, agent, 1, 3, 2)).toBeNull()
    })

    it('上限为 0 时一次都不给', () => {
        const budgets = makeBudgets()

        expect(takeRetrySlot(budgets, {}, 1, 3, 0)).toBeNull()
    })

    it('步号变化 = 名额重置', () => {
        const budgets = makeBudgets()
        const agent = {}

        expect(takeRetrySlot(budgets, agent, 1, 3, 2)).toBe(1)
        expect(takeRetrySlot(budgets, agent, 1, 3, 2)).toBe(2)
        expect(takeRetrySlot(budgets, agent, 1, 3, 2)).toBeNull()
        expect(takeRetrySlot(budgets, agent, 1, 4, 2)).toBe(1)
    })

    it('回合号变化 = 名额重置', () => {
        const budgets = makeBudgets()
        const agent = {}

        expect(takeRetrySlot(budgets, agent, 1, 3, 1)).toBe(1)
        expect(takeRetrySlot(budgets, agent, 1, 3, 1)).toBeNull()
        expect(takeRetrySlot(budgets, agent, 2, 3, 1)).toBe(1)
    })

    it('不同 agent 的名额互不影响', () => {
        const budgets = makeBudgets()
        const agentA = {}
        const agentB = {}

        expect(takeRetrySlot(budgets, agentA, 1, 3, 1)).toBe(1)
        expect(takeRetrySlot(budgets, agentA, 1, 3, 1)).toBeNull()
        expect(takeRetrySlot(budgets, agentB, 1, 3, 1)).toBe(1)
    })
})

describe('buildRetryEvents', () => {
    /** 一份最小载荷：只带 buildRetryEvents 用到的字段。 */
    const payload = {
        turn: 2,
        step: 5,
        provider: 'xkiro',
        failure: { code: 'SERVER', status: 502, message: 'Bad Gateway' },
    }

    it('两条事件的类型与官方一致', () => {
        const events = buildRetryEvents(payload, 1, 3)

        expect(events.scheduledType).toBe('llm/retry')
        expect(events.startedType).toBe('llm/retry-started')
    })

    it('两条事件共享同一个非空 retryId', () => {
        const events = buildRetryEvents(payload, 2, 5)

        expect(events.scheduledData.retryId).toBe(events.startedData.retryId)
        expect(events.scheduledData.retryId).not.toBe('')
    })

    it('重试序号与上限如实带进事件（界面显示成 n/max）', () => {
        const events = buildRetryEvents(payload, 2, 5)

        expect(events.scheduledData.retry).toBe(2)
        expect(events.scheduledData.maxRetries).toBe(5)
        expect(events.startedData.retry).toBe(2)
    })

    it('delayMs 为 0：我们立即重试，没有等待', () => {
        const events = buildRetryEvents(payload, 1, 3)

        expect(events.scheduledData.delayMs).toBe(0)
    })

    it('坐标与失败事实原样带进事件', () => {
        const events = buildRetryEvents(payload, 1, 3)

        expect(events.scheduledData.turn).toBe(2)
        expect(events.scheduledData.step).toBe(5)
        expect(events.scheduledData.provider).toBe('xkiro')
        expect(events.scheduledData.failure).toEqual(payload.failure)
        expect(events.startedData.turn).toBe(2)
        expect(events.startedData.step).toBe(5)
    })
})
