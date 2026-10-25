/**
 * host 入口 `src/host/index.ts` 的监听器接线测试。
 *
 * 判定核心的纯函数用例在 `guard.test.ts`；这里测**接线**：一回合一读会话、两条看护规则
 * 共用同一份快照、规则 H3 的「先等官方决定」顺序与名额记账，以及规则「突破 PTC 120 秒限制」的
 * 注入回调与还原 disposer。宿主用假 ctx
 * （`on` 收监听器、`inject` 记下依赖组与回调（不自动回调）、`effect` 记下 disposer、`get` 恒 undefined、`logger` 收口），
 * 配置按平台的 volatile 引用形状（`{ get() }`）造——顺带验证一次真解包。
 *
 * @module dsh-harden/tests/index
 */

import { describe, expect, it } from 'vitest'
import { apply } from '../src/host/index.js'
import { PTC_BUDGET_MAX_MS } from '../src/host/ptc-budget.js'
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

/** 一次 `ctx.inject` 的记录：依赖组 + 回调（回调不自动执行，用例自己决定跑哪一条）。 */
interface 注入记录 {
    readonly 依赖组: readonly string[]
    readonly 回调: (ctx: Ctx) => void
}

/** 宿主与注入子上下文共用的一份记账。 */
interface 宿主记账 {
    readonly 监听组: Map<string, 监听器>
    readonly 注入记录组: 注入记录[]
    /** `ctx.effect` 的执行函数当场跑掉的返回值（disposer），按注册顺序攒着。 */
    readonly 副作用组: (() => void)[]
}

/** 假宿主：监听器收进 Map，服务注入记下依赖组与回调（不自动回调）。 */
interface 假宿主 extends 宿主记账 {
    readonly 上下文: Ctx
}

/** 造一个共用这份记账的 ctx——本模块只依赖 `on`、`logger`、`inject` 与 `effect` 的外形。 */
function 造上下文(记账: 宿主记账): Ctx {
    return {
        logger: { info() {}, warn() {}, error() {} },
        on(event: string, listener: 监听器): void {
            记账.监听组.set(event, listener)
        },
        inject(依赖组: readonly string[], 回调: (ctx: Ctx) => void): void {
            记账.注入记录组.push({ 依赖组, 回调 })
        },
        effect(执行函数: () => () => void): void {
            记账.副作用组.push(执行函数())
        },
        get(): undefined {
            return undefined
        },
    }
}

/** 造一个各服务都缺省的假宿主。 */
function 造宿主(): 假宿主 {
    const 监听组 = new Map<string, 监听器>()
    const 注入记录组: 注入记录[] = []
    const 副作用组: (() => void)[] = []
    const 上下文 = 造上下文({ 监听组, 注入记录组, 副作用组 })

    return { 监听组, 注入记录组, 副作用组, 上下文 }
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

/** PTC 运行时桩：只提供本插件读写的两个预算字段（断言读的就是它上面被写进去的值）。 */
interface 运行时桩 {
    readonly config: { timeoutMs: number; maxTimeoutMs: number }
}

/** 预算接线现场：假 PTC 运行时，以及注入回调里注册出来的两个钩子。 */
interface 预算现场 {
    readonly 运行时: 运行时桩
    /** `settings/document-updated` 的监听器（配置改了手动触发一次）。 */
    readonly 配置更新通知: () => void
    /** 注入回调用 `ctx.effect` 记下的还原 disposer（插件卸载时调）。 */
    readonly 还原预算: () => void
}

/** 造一个「注入进来的子上下文」：与宿主共用同一份记账，另带注入进来的 ptcRuntime。 */
function 造注入子上下文(宿主: 假宿主, 运行时: 运行时桩): Ctx {
    return { ...造上下文(宿主), ptcRuntime: 运行时 }
}

/**
 * 用给定开关挂一遍插件，再手动跑 `ptcRuntime` 那条注入回调。
 *
 * **为什么不自动回调全部注入。** `apply` 里还有配置通路、后台 job 工具等几条注入，每条都要
 * 各自的整套平台服务；接线用例只关心预算这一条，就只喂它。回调不自动执行的那份记录因此
 * 同时是「坑 37 的回归网」——依赖组被谁改宽了，这里立刻看得出来。
 *
 * @param 读开关 - 现取现解的开关（volatile 引用被改后要重读）。
 */
function 挂上Ptc预算(读开关: () => boolean): 预算现场 {
    const 宿主 = 造宿主()
    apply(宿主.上下文, { ptcBreakLimit: { get: 读开关 } })

    const 记录 = 宿主.注入记录组.find((项) => 项.依赖组.length === 1 && 项.依赖组[0] === 'ptcRuntime')
    if (记录 === undefined) throw Error('apply 没有为 ptcRuntime 注册注入回调')

    const 运行时: 运行时桩 = { config: { timeoutMs: 120_000, maxTimeoutMs: 600_000 } }
    记录.回调(造注入子上下文(宿主, 运行时))

    return {
        运行时,
        配置更新通知: 宿主.监听组.get('settings/document-updated') as 监听器,
        // 注入回调里最后注册的副作用就是还原动作，取它比按序号猜稳。
        还原预算: 宿主.副作用组.at(-1) as () => void,
    }
}

describe('ptcBreakLimit 的接线', () => {
    it('ptcBreakLimit 打开时把 ptcRuntime 的程序预算抬到上限', () => {
        const 现场 = 挂上Ptc预算(() => true)

        expect(现场.运行时.config.timeoutMs).toBe(PTC_BUDGET_MAX_MS)
        expect(现场.运行时.config.maxTimeoutMs).toBe(PTC_BUDGET_MAX_MS)
    })

    it('收到 settings/document-updated 后按新配置重算（关掉即恢复）', () => {
        let 开关打开 = true
        const 现场 = 挂上Ptc预算(() => 开关打开)
        expect(现场.运行时.config.timeoutMs).toBe(PTC_BUDGET_MAX_MS)

        开关打开 = false
        现场.配置更新通知()

        expect(现场.运行时.config.timeoutMs).toBe(120_000)
        expect(现场.运行时.config.maxTimeoutMs).toBe(600_000)
    })

    it('插件卸载（effect 释放）时把预算恢复原值', () => {
        const 现场 = 挂上Ptc预算(() => true)
        expect(现场.运行时.config.timeoutMs).toBe(PTC_BUDGET_MAX_MS)

        现场.还原预算()

        expect(现场.运行时.config.timeoutMs).toBe(120_000)
        expect(现场.运行时.config.maxTimeoutMs).toBe(600_000)
    })

    it('ptcRuntime 是独占的一条 inject，不并进配置通路那条', () => {
        const 宿主 = 造宿主()
        apply(宿主.上下文, 造配置({ ptcBreakLimit: true }))

        const 依赖组清单 = 宿主.注入记录组.map((记录) => 记录.依赖组)
        const 带预算依赖的记录组 = 宿主.注入记录组.filter((记录) => 记录.依赖组.includes('ptcRuntime'))

        // 坑 37：可选服务并进共享依赖列表会让整条 fiber 停在 INACTIVE ⇒ 面板读写全断。
        expect(依赖组清单).toContainEqual(['ptcRuntime'])
        expect(依赖组清单).toContainEqual(['webServer', 'settings'])
        expect(带预算依赖的记录组).toHaveLength(1)
    })
})
