/**
 * 重试链账本的单元测试。
 *
 * 被测对象是 `src/host/retry-chain-ledger.ts`：`构造重试链键()` 与 `重试链账本` 的两个归一方法，
 * 覆盖平台对重试链的四条不变量——序号从 1 起逐条 +1、整链共用一个 retryId、
 * `llm/retry-started` 按 (retryId, retry) 配对、`normal` 模式的 maxRetries 够用
 * （`always` 模式不碰它）。
 *
 * 事件形状取自真机样本（子代理会话 dfd3eb08-79dd-42ea-ae47-99fba10cc4e0：turn 1 / step 7 /
 * provider command-code，同链两条 retry=1 且 maxRetries=1），但事件数据全部内联构造，
 * 不读任何真实会话文件。
 *
 * @module dsh-harden/tests/retry-chain-ledger
 */

import { describe, expect, it } from 'vitest'
import { 重试链账本, 构造重试链键 } from '../src/host/retry-chain-ledger.js'

/** 真机样本里的链坐标（四元组里的前三个 + policyKey 全量）。 */
const 真机链 = {
    turn: 1,
    step: 7,
    provider: 'command-code',
    policyKey: '["normal",5,["EMPTY_RESPONSE","RATE_LIMIT","SERVER","TIMEOUT","TRANSPORT"],500,10000,0.1]',
}

/** 造一条 llm/retry 的 data；覆盖项用来单改某条事件的字段。 */
function 重试数据(retryId: string, retry: number, 覆盖: Record<string, unknown> = {}): Record<string, unknown> {
    return { ...真机链, mode: 'normal', retryId, retry, ...覆盖 }
}

/** 造一条 llm/retry-started 的 data——真机形状：只有 retryId / turn / step / retry。 */
function 启动数据(retryId: string, retry: number): Record<string, unknown> {
    return { turn: 真机链.turn, step: 真机链.step, retryId, retry }
}

describe('构造重试链键', () => {
    it('同一坐标给出同一份键、不同坐标给出不同键', () => {
        const 键甲 = 构造重试链键(重试数据('id-1', 1))
        const 键乙 = 构造重试链键(重试数据('id-2', 1))
        const 键丙 = 构造重试链键(重试数据('id-1', 1, { step: 8 }))

        expect(键甲).toBe(键乙)
        expect(键甲).not.toBe(键丙)
    })

    it('provider / policyKey 内容里带分隔符也不会撞键', () => {
        const 键甲 = 构造重试链键({ turn: 1, step: 1, provider: 'a|b', policyKey: 'c' })
        const 键乙 = 构造重试链键({ turn: 1, step: 1, provider: 'a', policyKey: 'b|c' })

        expect(键甲).not.toBe(键乙)
    })

    it('四元组缺一或类型不符时返回 null', () => {
        expect(构造重试链键({ step: 7, provider: 'p', policyKey: 'k' })).toBeNull()
        expect(构造重试链键({ turn: 1, step: 7, provider: 7, policyKey: 'k' })).toBeNull()
        expect(构造重试链键({ turn: 1, step: 7, provider: 'p' })).toBeNull()
    })
})

describe('归一重试事件', () => {
    it('链首次出现时序号归一成 1（原序号 3 也算改动）', () => {
        const 账本 = new 重试链账本()

        expect(账本.归一重试事件(重试数据('id-1', 3))).toEqual({ retryId: 'id-1', retry: 1, 有改动: true })
    })

    it('坐标本来就对时如实报无改动', () => {
        const 账本 = new 重试链账本()

        expect(账本.归一重试事件(重试数据('id-1', 1))).toEqual({ retryId: 'id-1', retry: 1, 有改动: false })
    })

    it('同链第二条接着上一条 +1，并共用首条的 retryId', () => {
        const 账本 = new 重试链账本()
        账本.归一重试事件(重试数据('id-1', 1))

        expect(账本.归一重试事件(重试数据('id-2', 1))).toEqual({ retryId: 'id-1', retry: 2, 有改动: true })
        expect(账本.归一重试事件(重试数据('id-2', 1))).toEqual({ retryId: 'id-1', retry: 3, 有改动: true })
    })

    it('换一条链重新从 1 起，不复用上一条链的 retryId', () => {
        const 账本 = new 重试链账本()
        账本.归一重试事件(重试数据('id-a', 2))

        expect(账本.归一重试事件(重试数据('id-b', 1, { step: 8 }))).toEqual({ retryId: 'id-b', retry: 1, 有改动: false })
    })

    it('normal 模式下 maxRetries 不够用时抬到本条序号', () => {
        const 账本 = new 重试链账本()
        账本.归一重试事件(重试数据('id-1', 1, { maxRetries: 1 }))

        expect(账本.归一重试事件(重试数据('id-2', 1, { maxRetries: 1 }))).toEqual({
            retryId: 'id-1',
            retry: 2,
            maxRetries: 2,
            有改动: true,
        })
    })

    it('normal 模式下 maxRetries 够用时原样保留、不报改动', () => {
        const 账本 = new 重试链账本()
        账本.归一重试事件(重试数据('id-1', 1, { maxRetries: 5 }))

        expect(账本.归一重试事件(重试数据('id-1', 2, { maxRetries: 5 }))).toEqual({
            retryId: 'id-1',
            retry: 2,
            maxRetries: 5,
            有改动: false,
        })
    })

    it('always 模式不碰 maxRetries（平台要求它必须不带）', () => {
        const 账本 = new 重试链账本()
        const 结论 = 账本.归一重试事件(重试数据('id-1', 1, { mode: 'always', maxRetries: 3 }))

        expect(结论).toEqual({ retryId: 'id-1', retry: 1, 有改动: false })
    })

    it('缺链键或字段类型不符时返回 null', () => {
        const 账本 = new 重试链账本()

        expect(账本.归一重试事件({ turn: 1, provider: 'p', policyKey: 'k', retryId: 'id-1', retry: 1 })).toBeNull()
        expect(账本.归一重试事件(重试数据('id-1', 1, { retry: '1' }))).toBeNull()
    })
})

describe('归一启动事件', () => {
    it('按 (原 retryId, 原 retry) 命中配对映射', () => {
        const 账本 = new 重试链账本()
        账本.归一重试事件(重试数据('id-1', 1))
        账本.归一重试事件(重试数据('id-2', 1))

        expect(账本.归一启动事件(启动数据('id-1', 1))).toEqual({ retryId: 'id-1', retry: 1, 有改动: false })
        expect(账本.归一启动事件(启动数据('id-2', 1))).toEqual({ retryId: 'id-1', retry: 2, 有改动: true })
    })

    it('配不上队时归并到最近一次排定的坐标', () => {
        const 账本 = new 重试链账本()
        账本.归一重试事件(重试数据('id-1', 1))

        // 旧版插件每次重试换新 retryId：started 报的坐标从没被排定过，只能归并到前一条 scheduled。
        expect(账本.归一启动事件(启动数据('陌生-id', 1))).toEqual({ retryId: 'id-1', retry: 1, 有改动: true })
    })

    it('既无配对也无已排定事件时返回 null', () => {
        const 账本 = new 重试链账本()

        expect(账本.归一启动事件(启动数据('id-1', 1))).toBeNull()
    })

    it('字段类型不符时返回 null', () => {
        const 账本 = new 重试链账本()
        账本.归一重试事件(重试数据('id-1', 1))

        expect(账本.归一启动事件({ turn: 1, step: 7, retryId: 'id-1' })).toBeNull()
    })
})

describe('真机样本整段归一', () => {
    it('同链两条 retry=1 / maxRetries=1 与两条同坐标 started 归到一条链', () => {
        const 账本 = new 重试链账本()
        const 事件组 = [
            { 类型: 'llm/retry', 数据: 重试数据('6b1cc297', 1, { maxRetries: 1 }) },
            { 类型: 'llm/retry-started', 数据: 启动数据('6b1cc297', 1) },
            { 类型: 'llm/retry', 数据: 重试数据('b0797b5b', 1, { maxRetries: 1 }) },
            { 类型: 'llm/retry-started', 数据: 启动数据('b0797b5b', 1) },
        ]

        const 结论组 = 事件组.map((事件) => {
            if (事件.类型 === 'llm/retry') return 账本.归一重试事件(事件.数据)
            return 账本.归一启动事件(事件.数据)
        })

        expect(结论组.map((结论) => [结论?.retryId, 结论?.retry, 结论?.maxRetries])).toEqual([
            ['6b1cc297', 1, 1],
            ['6b1cc297', 1, undefined],
            ['6b1cc297', 2, 2],
            ['6b1cc297', 2, undefined],
        ])
        expect(结论组.map((结论) => 结论?.有改动)).toEqual([false, false, true, true])
    })
})

// 增量喂入（写入拦截器用）：可能接在某条链中间——链首见按原坐标播种，不重排成 1。
describe('增量模式', () => {
    it('链首见且序号不是 1：按原坐标播种，不改动', () => {
        const 账本 = new 重试链账本('增量')

        expect(账本.归一重试事件(重试数据('id-A', 2))).toEqual({ retryId: 'id-A', retry: 2, 有改动: false })
    })

    it('播种后同链第二条接着上一条 +1', () => {
        const 账本 = new 重试链账本('增量')
        账本.归一重试事件(重试数据('id-A', 2))

        expect(账本.归一重试事件(重试数据('id-A', 3))).toEqual({ retryId: 'id-A', retry: 3, 有改动: false })
    })

    it('链首见且序号是 1：与批量一致（不改动）', () => {
        const 账本 = new 重试链账本('增量')

        expect(账本.归一重试事件(重试数据('id-B', 1))).toEqual({ retryId: 'id-B', retry: 1, 有改动: false })
    })

    it('播种后配对的 started 按原坐标原样放行', () => {
        const 账本 = new 重试链账本('增量')
        账本.归一重试事件(重试数据('id-A', 2))

        expect(账本.归一启动事件(启动数据('id-A', 2))).toEqual({ retryId: 'id-A', retry: 2, 有改动: false })
    })
})
