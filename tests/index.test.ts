/**
 * host 入口 `src/host/index.ts` 的监听器接线测试。
 *
 * 判定核心的纯函数用例在 `guard.test.ts`；这里测**接线**：一回合一读会话、两条看护规则
 * 共用同一份快照、规则 H3 的「先等官方决定」顺序与名额记账。宿主用假 ctx
 * （`on` 收监听器、`inject` 只记录不回调、`get` 恒 undefined、`logger` 收口），
 * 配置按平台的 volatile 引用形状（`{ get() }`）造——顺带验证一次真解包。
 *
 * @module dsh-harden/tests/index
 */

import { describe, expect, it } from 'vitest'
import { apply } from '../src/host/index.js'
import type {
    AgentLike,
    Ctx,
    LlmFailureLike,
    MessageBlock,
    RequestErrorAction,
    RequestErrorPayload,
    SessionEventLike,
    SessionLike,
} from '../src/host/types.js'

/** 固定的回合号与步号——看护载荷与消息事件都落在同一坐标上。 */
const TURN = 3
const STEP = 1

/** 一条典型的平台工具失败警告（放在 text 块里）。 */
const WARNING_LINE = '⚠ Could not execute tool(s): "run_code": required field "code" is missing'

/** 平台事件监听器的最小形状。 */
type 监听器 = (...args: unknown[]) => unknown

/** steer 收到的一条纠正消息（只声明断言用到的字段）。 */
interface 引导消息 {
    readonly content: readonly { readonly type?: string; readonly text?: string }[]
    readonly source: { readonly summary: string }
}

/** 假宿主：监听器收进 Map，服务注入只记录不回调。 */
interface 假宿主 {
    readonly 监听组: Map<string, 监听器>
    readonly 注入记录组: (readonly string[])[]
    readonly 上下文: Ctx
}

/** 造一个各服务都缺省的假 ctx——本模块只依赖 `on`、`logger` 与 `inject` 的外形。 */
function 造宿主(): 假宿主 {
    const 监听组 = new Map<string, 监听器>()
    const 注入记录组: (readonly string[])[] = []
    const 上下文: Ctx = {
        logger: { info() {}, warn() {}, error() {} },
        on(event: string, listener: 监听器): void {
            监听组.set(event, listener)
        },
        inject(依赖组: readonly string[]): void {
            注入记录组.push(依赖组)
        },
        get(): undefined {
            return undefined
        },
    }

    return { 监听组, 注入记录组, 上下文 }
}

/** 照平台的 volatile 引用形状造配置：每个字段都是 `{ get() }`。 */
function 造配置(字段组: Record<string, unknown>): unknown {
    const 配置: Record<string, { get: () => unknown }> = {}
    for (const [字段名, 值] of Object.entries(字段组)) {
        配置[字段名] = { get: () => 值 }
    }

    return 配置
}

/** 挂载后取到的两个监听器。 */
interface 已挂载 {
    readonly 收尾监听器: 监听器
    readonly 报错监听器: 监听器
}

/** 用给定配置挂一遍插件，再从宿主里取两个监听器直接调用。 */
function 挂载(配置字段组: Record<string, unknown>): 已挂载 {
    const 宿主 = 造宿主()
    apply(宿主.上下文, 造配置(配置字段组))

    return {
        收尾监听器: 宿主.监听组.get('agent/turn-stopping') as 监听器,
        报错监听器: 宿主.监听组.get('agent/request-error') as 监听器,
    }
}

/** 假代理：会话读写与 steer 都记账，`扫描次数` 数 `snapshotEvents` 被调了几次。 */
interface 假代理 {
    readonly agent: AgentLike
    readonly 引导组: unknown[]
    readonly 追加记录组: { readonly type: string; readonly data: unknown }[]
    readonly 扫描次数: () => number
}

/** 造 agent 桩；会话只提供读事件与写事件两个面。 */
function 造代理(事件组: readonly SessionEventLike[] = []): 假代理 {
    const 引导组: unknown[] = []
    const 追加记录组: { type: string; data: unknown }[] = []
    let 扫描次数 = 0

    const 会话: SessionLike = {
        snapshotEvents: () => {
            扫描次数 += 1
            return 事件组
        },
        append: (type: string, data: unknown): { seq: number } => {
            追加记录组.push({ type, data })
            return { seq: 追加记录组.length }
        },
    }

    const agent: AgentLike = {
        session: 会话,
        steer: (message: unknown): void => {
            引导组.push(message)
        },
    }

    return { agent, 引导组, 追加记录组, 扫描次数: () => 扫描次数 }
}

/** 构造一条本回合本步的 assistant 消息事件。 */
function 造消息事件(内容组: readonly MessageBlock[]): SessionEventLike {
    return { type: 'assistant/message', data: { turn: TURN, step: STEP, message: { content: 内容组 } } }
}

/** 构造一个 reasoning 内容块。 */
function 造思考块(text: string): MessageBlock {
    return { type: 'reasoning', text }
}

/** 构造一个 text 内容块。 */
function 造正文块(text: string): MessageBlock {
    return { type: 'text', text }
}

/** 构造一条 agent/request-error 载荷（H3 用例共用，只有失败事实不同）。 */
function 造失败载荷(agent: AgentLike, failure: LlmFailureLike): RequestErrorPayload {
    return { agent, turn: TURN, step: STEP, provider: 'xkiro', failure }
}

/** 官方重试监听器放弃时的决定：undefined = 不接管，失败终止。 */
async function 官方放弃(): Promise<RequestErrorAction> {
    return undefined
}

describe('agent/turn-stopping：一回合一读会话', () => {
    it('两条规则都关时连会话都不读', async () => {
        const { 收尾监听器 } = 挂载({ toolFailureGuard: false, emptyOutputGuard: false })
        const { agent, 引导组, 扫描次数 } = 造代理([
            造消息事件([造思考块('只有想法')]),
        ])

        await 收尾监听器({ agent, turn: TURN })

        expect(扫描次数()).toBe(0)
        expect(引导组).toHaveLength(0)
    })

    it('H1 开关开着但前缀为空、H2 关时也不读会话（默认配置不白扫）', async () => {
        const { 收尾监听器 } = 挂载({ toolFailureGuard: true, toolFailurePrefixes: '', emptyOutputGuard: false })
        const { agent, 引导组, 扫描次数 } = 造代理([
            造消息事件([造正文块(WARNING_LINE)]),
        ])

        await 收尾监听器({ agent, turn: TURN })

        expect(扫描次数()).toBe(0)
        expect(引导组).toHaveLength(0)
    })

    it('H1 前缀为空、H2 开：只扫一次会话，同回合再判一次时计数累加', async () => {
        const { 收尾监听器 } = 挂载({
            toolFailureGuard: true,
            toolFailurePrefixes: '',
            emptyOutputGuard: true,
        })
        const { agent, 引导组, 扫描次数 } = 造代理([
            造消息事件([造思考块('只有想法')]),
        ])

        await 收尾监听器({ agent, turn: TURN })

        expect(扫描次数()).toBe(1)
        expect(引导组).toHaveLength(1)
        const 首条纠正消息 = 引导组[0] as 引导消息
        expect(首条纠正消息.source.summary).toBe('nudge.emptyTurn|1')
        expect(首条纠正消息.content[0]?.text).toContain('你上一次没有给用户任何回复就结束了回合')

        await 收尾监听器({ agent, turn: TURN })

        expect(扫描次数()).toBe(2)
        expect(引导组).toHaveLength(2)
        const 第二条纠正消息 = 引导组[1] as 引导消息
        expect(第二条纠正消息.source.summary).toBe('nudge.emptyTurn|2')
    })

    it('H1 前缀非空、H2 开：两条规则共用同一份快照', async () => {
        const { 收尾监听器 } = 挂载({
            toolFailureGuard: true,
            toolFailurePrefixes: '⚠ Could not execute tool',
            emptyOutputGuard: true,
        })
        const { agent, 引导组, 扫描次数 } = 造代理([
            造消息事件([造正文块('任务完成，报告如下。')]),
        ])

        await 收尾监听器({ agent, turn: TURN })

        expect(扫描次数()).toBe(1)
        expect(引导组).toHaveLength(0)
    })

    it('H1 命中：steer 收到纠正消息，摘要带本回合第 1 次', async () => {
        const { 收尾监听器 } = 挂载({
            toolFailureGuard: true,
            toolFailurePrefixes: '⚠ Could not execute tool',
            emptyOutputGuard: true,
        })
        const { agent, 引导组 } = 造代理([
            造消息事件([造正文块(WARNING_LINE)]),
        ])

        await 收尾监听器({ agent, turn: TURN })

        expect(引导组).toHaveLength(1)
        const 纠正消息 = 引导组[0] as 引导消息
        expect(纠正消息.source.summary).toBe('nudge.toolFailure|1')
        expect(纠正消息.content[0]?.text).toContain('你上一次的工具调用没有成功执行')
    })
})

describe('agent/request-error：H3 的顺序与名额', () => {
    it('官方已决定重试：原样返回官方的决定，不写会话', async () => {
        const { 报错监听器 } = 挂载({ networkRetryCount: 5 })
        const { agent, 追加记录组 } = 造代理()
        const 官方决定: RequestErrorAction = { kind: 'retry' }

        const 结果 = await 报错监听器(
            造失败载荷(agent, { code: 'SERVER' }),
            async () => 官方决定,
        )

        expect(结果).toBe(官方决定)
        expect(追加记录组).toHaveLength(0)
    })

    it('名额用尽后放行，重试事件只在第一次写', async () => {
        const { 报错监听器 } = 挂载({ networkRetryCount: 1 })
        const { agent, 追加记录组 } = 造代理()
        const 载荷 = 造失败载荷(agent, { code: 'SERVER' })

        const 首次 = await 报错监听器(载荷, 官方放弃)

        expect(首次).toEqual({ kind: 'retry' })
        expect(追加记录组.map((记录) => 记录.type)).toEqual(['llm/retry', 'llm/retry-started'])

        const 第二次 = await 报错监听器(载荷, 官方放弃)

        expect(第二次).toBeUndefined()
        expect(追加记录组).toHaveLength(2)
    })

    it('networkRetryCount 为 0 时不兜底', async () => {
        const { 报错监听器 } = 挂载({ networkRetryCount: 0 })
        const { agent, 追加记录组 } = 造代理()

        const 结果 = await 报错监听器(造失败载荷(agent, { code: 'SERVER' }), 官方放弃)

        expect(结果).toBeUndefined()
        expect(追加记录组).toHaveLength(0)
    })

    it('失败特征不在清单里时不兜底', async () => {
        const { 报错监听器 } = 挂载({ networkRetryCount: 5 })
        const { agent, 追加记录组 } = 造代理()

        const 结果 = await 报错监听器(造失败载荷(agent, { code: 'AUTH' }), 官方放弃)

        expect(结果).toBeUndefined()
        expect(追加记录组).toHaveLength(0)
    })

    it('先等官方决定，官方认输后才写自己的重试事件（硬规则 8.6）', async () => {
        const { 报错监听器 } = 挂载({ networkRetryCount: 5 })
        const { agent, 追加记录组 } = 造代理()
        const 官方决定: RequestErrorAction = { kind: 'retry' }
        const 决定延迟 = Promise.withResolvers<RequestErrorAction>()

        const 监听结果 = 报错监听器(
            造失败载荷(agent, { code: 'SERVER' }),
            () => 决定延迟.promise,
        )
        await Promise.resolve()

        expect(追加记录组).toHaveLength(0)

        决定延迟.resolve(官方决定)

        expect(await 监听结果).toBe(官方决定)
        expect(追加记录组).toHaveLength(0)
    })
})
