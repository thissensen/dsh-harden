/**
 * 规则 H3（网络请求中断续跑）判定逻辑的持久化测试。
 *
 * 被测对象是 `src/host/retry.ts` 导出的纯函数：`matchesRetryTokens()` 判定失败是否该兜底重试；
 * `peekRetrySlot()` / `commitRetrySlot()` 管兜底名额（查与记分开，记账点必须在重试事件写成功之后）；
 * `buildRetryEvents()` 写出的 `policyKey` 是「换模型 = 换链」的关键。
 *
 * 判定与记账是两条独立的口径，这里分开覆盖：判定只看失败特征，记账只看链坐标与上限。
 *
 * @module dsh-harden/tests/retry
 */

import { describe, expect, it } from 'vitest'
import type { LlmFailureLike } from '../src/host/types.js'
import {
    buildRetryEvents,
    commitRetrySlot,
    matchesRetryTokens,
    peekRetrySlot,
    type RetryBudget,
    type RetryCoordinate,
    type RetrySlotLedger,
} from '../src/host/retry.js'

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

describe('peekRetrySlot / commitRetrySlot', () => {
    /** 每个用例一块独立记账，互不干扰。 */
    function makeBudgets(): RetrySlotLedger {
        return new WeakMap()
    }

    /** 造一条链坐标：默认落在同一条链上（xkiro / m1）。 */
    function 造坐标(turn: number, step: number, provider = 'xkiro', model = 'm1'): RetryCoordinate {
        return { turn, step, provider, model }
    }

    /** 占一次名额 = 查 + 记；生产代码把两步分开，是为了让记账点落在重试事件写成功之后。 */
    function 占一次(账本: RetrySlotLedger, agent: object, 坐标: RetryCoordinate, limit: number): RetryBudget | null {
        const 名额 = peekRetrySlot(账本, agent, 坐标, limit)
        if (名额 === null) return null

        commitRetrySlot(账本, agent, 坐标, 名额)
        return 名额
    }

    it('第一次占用返回 1，之后每次加一', () => {
        const budgets = makeBudgets()
        const agent = {}

        expect(占一次(budgets, agent, 造坐标(1, 3), 3)).toEqual({ count: 1, retryId: expect.any(String) })
        expect(占一次(budgets, agent, 造坐标(1, 3), 3)).toEqual({ count: 2, retryId: expect.any(String) })
        expect(占一次(budgets, agent, 造坐标(1, 3), 3)).toEqual({ count: 3, retryId: expect.any(String) })
    })

    it('用满上限后返回 null', () => {
        const budgets = makeBudgets()
        const agent = {}

        expect(占一次(budgets, agent, 造坐标(1, 3), 2)).toEqual({ count: 1, retryId: expect.any(String) })
        expect(占一次(budgets, agent, 造坐标(1, 3), 2)).toEqual({ count: 2, retryId: expect.any(String) })
        expect(占一次(budgets, agent, 造坐标(1, 3), 2)).toBeNull()
    })

    it('上限为 0 时一次都不给', () => {
        const budgets = makeBudgets()

        expect(占一次(budgets, {}, 造坐标(1, 3), 0)).toBeNull()
    })

    it('步号变化 = 名额重置', () => {
        const budgets = makeBudgets()
        const agent = {}

        expect(占一次(budgets, agent, 造坐标(1, 3), 2)).toEqual({ count: 1, retryId: expect.any(String) })
        expect(占一次(budgets, agent, 造坐标(1, 3), 2)).toEqual({ count: 2, retryId: expect.any(String) })
        expect(占一次(budgets, agent, 造坐标(1, 3), 2)).toBeNull()
        expect(占一次(budgets, agent, 造坐标(1, 4), 2)).toEqual({ count: 1, retryId: expect.any(String) })
    })

    it('回合号变化 = 名额重置', () => {
        const budgets = makeBudgets()
        const agent = {}

        expect(占一次(budgets, agent, 造坐标(1, 3), 1)).toEqual({ count: 1, retryId: expect.any(String) })
        expect(占一次(budgets, agent, 造坐标(1, 3), 1)).toBeNull()
        expect(占一次(budgets, agent, 造坐标(2, 3), 1)).toEqual({ count: 1, retryId: expect.any(String) })
    })

    it('不同 agent 的名额互不影响', () => {
        const budgets = makeBudgets()
        const agentA = {}
        const agentB = {}

        expect(占一次(budgets, agentA, 造坐标(1, 3), 1)).toEqual({ count: 1, retryId: expect.any(String) })
        expect(占一次(budgets, agentA, 造坐标(1, 3), 1)).toBeNull()
        expect(占一次(budgets, agentB, 造坐标(1, 3), 1)).toEqual({ count: 1, retryId: expect.any(String) })
    })

    it('同一链坐标内多次占用共用同一个 retryId', () => {
        const budgets = makeBudgets()
        const agent = {}

        const firstSlot = 占一次(budgets, agent, 造坐标(1, 3), 3)
        const secondSlot = 占一次(budgets, agent, 造坐标(1, 3), 3)
        const thirdSlot = 占一次(budgets, agent, 造坐标(1, 3), 3)

        expect(firstSlot?.retryId).toEqual(expect.any(String))
        expect(secondSlot?.retryId).toBe(firstSlot?.retryId)
        expect(thirdSlot?.retryId).toBe(firstSlot?.retryId)
    })

    it('turn 或 step 变化 = 换链，retryId 变新', () => {
        const budgets = makeBudgets()
        const agent = {}

        const slotOnStepThree = 占一次(budgets, agent, 造坐标(1, 3), 5)
        const slotOnStepFour = 占一次(budgets, agent, 造坐标(1, 4), 5)
        const slotOnTurnTwo = 占一次(budgets, agent, 造坐标(2, 3), 5)

        expect(slotOnStepThree?.retryId).toEqual(expect.any(String))
        expect(slotOnStepFour?.retryId).not.toBe(slotOnStepThree?.retryId)
        expect(slotOnTurnTwo?.retryId).not.toBe(slotOnStepThree?.retryId)
        expect(slotOnTurnTwo?.retryId).not.toBe(slotOnStepFour?.retryId)
    })

    it('provider 变化 = 换链，retryId 变新', () => {
        const budgets = makeBudgets()
        const agent = {}

        const 首链 = 占一次(budgets, agent, 造坐标(1, 3, 'xkiro'), 5)
        const 换链 = 占一次(budgets, agent, 造坐标(1, 3, 'command-code'), 5)

        expect(换链?.count).toBe(1)
        expect(换链?.retryId).not.toBe(首链?.retryId)
    })

    it('model 变化 = 换链，retryId 变新', () => {
        const budgets = makeBudgets()
        const agent = {}

        const 首链 = 占一次(budgets, agent, 造坐标(1, 3, 'xkiro', 'm1'), 5)
        const 换链 = 占一次(budgets, agent, 造坐标(1, 3, 'xkiro', 'm2'), 5)

        expect(换链?.count).toBe(1)
        expect(换链?.retryId).not.toBe(首链?.retryId)
    })

    it('坐标 A→B→A：回到原坐标时沿用第一次的 retryId，序号接着数', () => {
        const budgets = makeBudgets()
        const agent = {}

        const 首次A = 占一次(budgets, agent, 造坐标(1, 3, 'xkiro', 'm1'), 5)
        const 首次B = 占一次(budgets, agent, 造坐标(1, 3, 'command-code', 'm1'), 5)
        const 再回A = 占一次(budgets, agent, 造坐标(1, 3, 'xkiro', 'm1'), 5)

        expect(首次A).toEqual({ count: 1, retryId: expect.any(String) })
        expect(首次B?.count).toBe(1)
        expect(再回A?.count).toBe(2)
        expect(再回A?.retryId).toBe(首次A?.retryId)
        expect(再回A?.retryId).not.toBe(首次B?.retryId)
    })

    it('写事件失败不消耗名额：没落账时同链仍从 1 起，落账后才数到 2', () => {
        const budgets = makeBudgets()
        const agent = {}
        const 坐标 = 造坐标(1, 3)

        const 首次 = peekRetrySlot(budgets, agent, 坐标, 5)
        const 重查 = peekRetrySlot(budgets, agent, 坐标, 5)

        expect(首次?.count).toBe(1)
        // 没调 commitRetrySlot = 事件没落盘 ⇒ 名额不能消耗。
        expect(重查?.count).toBe(1)

        commitRetrySlot(budgets, agent, 坐标, 重查!)

        expect(peekRetrySlot(budgets, agent, 坐标, 5)?.count).toBe(2)
    })
})

describe('buildRetryEvents', () => {
    /** 一份最小载荷：只带 buildRetryEvents 用到的字段。 */
    const payload = {
        turn: 2,
        step: 5,
        provider: 'xkiro',
        model: 'deepseek-v4',
        failure: { code: 'SERVER', status: 502, message: 'Bad Gateway' },
    }

    it('两条事件的类型与官方一致', () => {
        const events = buildRetryEvents(payload, 'retry-id-1', 1, 3)

        expect(events.scheduledType).toBe('llm/retry')
        expect(events.startedType).toBe('llm/retry-started')
    })

    it('两条事件共享同一个非空 retryId', () => {
        const events = buildRetryEvents(payload, 'retry-id-1', 2, 5)

        expect(events.scheduledData.retryId).toBe(events.startedData.retryId)
        expect(events.scheduledData.retryId).not.toBe('')
    })

    it('重试序号与上限如实带进事件（界面显示成 n/max）', () => {
        const events = buildRetryEvents(payload, 'retry-id-1', 2, 5)

        expect(events.scheduledData.retry).toBe(2)
        expect(events.scheduledData.maxRetries).toBe(5)
        expect(events.startedData.retry).toBe(2)
    })

    it('delayMs 为 0：我们立即重试，没有等待', () => {
        const events = buildRetryEvents(payload, 'retry-id-1', 1, 3)

        expect(events.scheduledData.delayMs).toBe(0)
    })

    it('坐标与失败事实原样带进事件', () => {
        const events = buildRetryEvents(payload, 'retry-id-1', 1, 3)

        expect(events.scheduledData.turn).toBe(2)
        expect(events.scheduledData.step).toBe(5)
        expect(events.scheduledData.provider).toBe('xkiro')
        expect(events.scheduledData.failure).toEqual(payload.failure)
        expect(events.startedData.turn).toBe(2)
        expect(events.startedData.step).toBe(5)
    })

    it('policyKey 把模型编进去：平台链键里没有 model，换模型才真的换链', () => {
        const events = buildRetryEvents(payload, 'retry-id-1', 1, 3)

        expect(events.scheduledData.policyKey).toBe('["harden-fallback","deepseek-v4"]')
    })

    it('传入的 retryId 原样写进两条事件', () => {
        const retryId = 'retry-id-7f3a'
        const events = buildRetryEvents(payload, retryId, 2, 5)

        expect(events.scheduledData.retryId).toBe(retryId)
        expect(events.startedData.retryId).toBe(retryId)
    })
})
