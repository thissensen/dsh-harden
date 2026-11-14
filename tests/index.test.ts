/**
 * host 入口 `src/host/index.ts` 的监听器接线测试。
 *
 * 判定核心的纯函数用例在 `guard.test.ts`；这里测**接线**：回合消息记忆与两条看护规则的配合
 * （记忆由 `session/event` 监听器喂，`agent/turn-stopping` 上只查记忆，旧挂载留下的记忆按挂载代号作废）、
 * 规则 H3 的「先等官方决定」顺序与名额记账（含换模型换链；写失败不消耗名额），以及规则
 * 「突破 PTC 120 秒限制」的注入回调与还原 disposer。
 *
 * 宿主用假 ctx（`on` 收监听器、`inject` 记下依赖组与回调（不自动回调）、`effect` 记下 disposer、
 * `get` 恒 undefined、`logger` 收口），配置按平台的 volatile 引用形状（`{ get() }`）造——顺带验证
 * 一次真解包。
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
    /** logger 收下的行——H2 命中说明里回显的步号这类断言靠它。 */
    readonly 日志行组: string[]
}

/** 假宿主：监听器收进 Map，服务注入记下依赖组与回调（不自动回调）。 */
interface 假宿主 extends 宿主记账 {
    readonly 上下文: Ctx
}

/** 造一个共用这份记账的 ctx——本模块只依赖 `on`、`logger`、`inject` 与 `effect` 的外形。 */
function 造上下文(记账: 宿主记账): Ctx {
    return {
        logger: {
            info(消息: string): void {
                记账.日志行组.push(消息)
            },
            warn(消息: string): void {
                记账.日志行组.push(消息)
            },
            error(消息: string): void {
                记账.日志行组.push(消息)
            },
        },
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
    const 日志行组: string[] = []
    const 上下文 = 造上下文({ 监听组, 注入记录组, 副作用组, 日志行组 })

    return { 监听组, 注入记录组, 副作用组, 日志行组, 上下文 }
}

/** 照平台的 volatile 引用形状造配置：每个字段都是 `{ get() }`。 */
function 造配置(字段组: Record<string, unknown>): unknown {
    const 配置: Record<string, { get: () => unknown }> = {}
    for (const [字段名, 值] of Object.entries(字段组)) {
        配置[字段名] = { get: () => 值 }
    }

    return 配置
}

/** 挂载后取到的监听器与日志行。 */
interface 已挂载 {
    readonly 收尾监听器: 监听器
    readonly 报错监听器: 监听器
    /** `session/event` 的监听器：用例靠它主动喂 `assistant/message` 事件。 */
    readonly 会话事件监听器: 监听器
    /** 插件写下的日志行。 */
    readonly 日志行组: string[]
}

/** 用给定配置挂一遍插件，再从宿主里取监听器直接调用。 */
function 挂载(配置字段组: Record<string, unknown>): 已挂载 {
    const 宿主 = 造宿主()
    apply(宿主.上下文, 造配置(配置字段组))

    return {
        收尾监听器: 宿主.监听组.get('agent/turn-stopping') as 监听器,
        报错监听器: 宿主.监听组.get('agent/request-error') as 监听器,
        会话事件监听器: 宿主.监听组.get('session/event') as 监听器,
        日志行组: 宿主.日志行组,
    }
}

/** H3 用例可切的模型选择：`agent.model.current()` 现读它（「换模型 = 换链」靠它）。 */
interface 模型选择桩 {
    模型名: string
}

/** 假代理：会话写入与 steer 都记账；`session` 就是回合消息记忆的键。 */
interface 假代理 {
    readonly agent: AgentLike
    readonly session: SessionLike
    readonly 引导组: unknown[]
    readonly 追加记录组: { readonly type: string; readonly data: unknown }[]
}

/** 造 agent 桩；会话只提供写事件这一个面（记忆由 `session/event` 监听器喂）。 */
function 造代理(模型选择: 模型选择桩 = { 模型名: 'deepseek-v4' }): 假代理 {
    const 引导组: unknown[] = []
    const 追加记录组: { type: string; data: unknown }[] = []

    const session: SessionLike = {
        append: (type: string, data: unknown): { seq: number } => {
            追加记录组.push({ type, data })
            return { seq: 追加记录组.length }
        },
    }

    const agent: AgentLike = {
        session,
        steer: (message: unknown): void => {
            引导组.push(message)
        },
        model: { current: () => ({ provider: 'xkiro', model: 模型选择.模型名 }) },
    }

    return { agent, session, 引导组, 追加记录组 }
}

/** 构造一条 assistant/message 事件（回合默认取本文件固定的 TURN）。 */
function 造消息事件(步号: number, 内容组: readonly MessageBlock[], 回合号 = TURN): SessionEventLike {
    return { type: 'assistant/message', data: { turn: 回合号, step: 步号, message: { content: 内容组 } } }
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

describe('agent/turn-stopping：读记忆判定 H1 与 H2', () => {
    it('两条规则都关时不 steer', async () => {
        const { 收尾监听器, 会话事件监听器 } = 挂载({ toolFailureGuard: false, emptyOutputGuard: false })
        const { agent, session, 引导组 } = 造代理()
        // 现在读的是记忆，不是会话：这里钉的是「不 steer」，不是「不扫」。
        会话事件监听器(session, 造消息事件(STEP, [造思考块('只有想法')]))

        await 收尾监听器({ agent, turn: TURN })

        expect(引导组).toHaveLength(0)
    })

    it('H1 开关开着但前缀为空、H2 关时也不 steer（默认配置不白判）', async () => {
        const { 收尾监听器, 会话事件监听器 } = 挂载({
            toolFailureGuard: true,
            toolFailurePrefixes: '',
            emptyOutputGuard: false,
        })
        const { agent, session, 引导组 } = 造代理()
        // 现在读的是记忆，不是会话：这里钉的是「不 steer」，不是「不扫」。
        会话事件监听器(session, 造消息事件(STEP, [造正文块(WARNING_LINE)]))

        await 收尾监听器({ agent, turn: TURN })

        expect(引导组).toHaveLength(0)
    })

    it('H2：同回合连判两次时计数从 1 累加到 2', async () => {
        const { 收尾监听器, 会话事件监听器 } = 挂载({
            toolFailureGuard: true,
            toolFailurePrefixes: '',
            emptyOutputGuard: true,
        })
        const { agent, session, 引导组 } = 造代理()
        // 记忆只喂一次，两次判定读的是同一份快照：计数累加靠注入记账，不靠重新读会话。
        会话事件监听器(session, 造消息事件(STEP, [造思考块('只有想法')]))

        await 收尾监听器({ agent, turn: TURN })

        expect(引导组).toHaveLength(1)
        const 首条纠正消息 = 引导组[0] as 引导消息
        expect(首条纠正消息.source.summary).toBe('nudge.emptyTurn|1')
        expect(首条纠正消息.content[0]?.text).toContain('你上一次没有给用户任何回复就结束了回合')

        await 收尾监听器({ agent, turn: TURN })

        expect(引导组).toHaveLength(2)
        const 第二条纠正消息 = 引导组[1] as 引导消息
        expect(第二条纠正消息.source.summary).toBe('nudge.emptyTurn|2')
    })

    it('H1 前缀非空、H2 开：两条规则共用同一份快照（正文正常 ⇒ 不 steer）', async () => {
        const { 收尾监听器, 会话事件监听器 } = 挂载({
            toolFailureGuard: true,
            toolFailurePrefixes: '⚠ Could not execute tool',
            emptyOutputGuard: true,
        })
        const { agent, session, 引导组 } = 造代理()
        会话事件监听器(session, 造消息事件(STEP, [造正文块('任务完成，报告如下。')]))

        await 收尾监听器({ agent, turn: TURN })

        expect(引导组).toHaveLength(0)
    })

    it('H1 命中：steer 收到纠正消息，摘要带本回合第 1 次', async () => {
        const { 收尾监听器, 会话事件监听器 } = 挂载({
            toolFailureGuard: true,
            toolFailurePrefixes: '⚠ Could not execute tool',
            emptyOutputGuard: true,
        })
        const { agent, session, 引导组 } = 造代理()
        会话事件监听器(session, 造消息事件(STEP, [造正文块(WARNING_LINE)]))

        await 收尾监听器({ agent, turn: TURN })

        expect(引导组).toHaveLength(1)
        const 纠正消息 = 引导组[0] as 引导消息
        expect(纠正消息.source.summary).toBe('nudge.toolFailure|1')
        expect(纠正消息.content[0]?.text).toContain('你上一次的工具调用没有成功执行')
    })

    it('只认 assistant/message：别的类型不进记忆', async () => {
        const { 收尾监听器, 会话事件监听器 } = 挂载({ emptyOutputGuard: true })
        const { agent, session, 引导组 } = 造代理()
        // assistant/attempt 是「没落成 surface 消息的尝试」，形状像 assistant/message 也不算本回合最后一条。
        会话事件监听器(session, {
            type: 'assistant/attempt',
            data: { turn: TURN, step: STEP, message: { content: [造思考块('只有想法')] } },
        })

        await 收尾监听器({ agent, turn: TURN })

        expect(引导组).toHaveLength(0)
    })

    it('形状不认识的消息不入记忆：步号不是整数时跳过', async () => {
        const { 收尾监听器, 会话事件监听器 } = 挂载({ emptyOutputGuard: true })
        const { agent, session, 引导组 } = 造代理()
        // 监听器的载荷是 unknown 面：形状不认识就跳过，别把坏坐标塞进记忆。
        会话事件监听器(session, {
            type: 'assistant/message',
            data: { turn: TURN, step: 1.5, message: { content: [造思考块('只有想法')] } },
        })

        await 收尾监听器({ agent, turn: TURN })

        expect(引导组).toHaveLength(0)
    })

    it('取该回合里步号最大的那条消息', async () => {
        const { 收尾监听器, 会话事件监听器, 日志行组 } = 挂载({ emptyOutputGuard: true })
        const { agent, session, 引导组 } = 造代理()
        会话事件监听器(session, 造消息事件(4, [造正文块('第 4 步的正文')]))
        会话事件监听器(session, 造消息事件(6, [造思考块('第 6 步的思考')]))
        会话事件监听器(session, 造消息事件(5, [造正文块('第 5 步的正文')]))

        await 收尾监听器({ agent, turn: TURN })

        expect(引导组).toHaveLength(1)
        const 纠正消息 = 引导组[0] as 引导消息
        expect(纠正消息.source.summary).toBe('nudge.emptyTurn|1')
        // 命中说明里回显步号：取到的是第 6 步（更晚喂进来的第 5 步没把它盖掉）。
        const 命中行 = 日志行组.find((行) => 行.includes('规则 H2 命中'))
        expect(命中行).toContain('第 6 步')
    })

    it('同一步出现多条消息时后者胜', async () => {
        const { 收尾监听器, 会话事件监听器 } = 挂载({ emptyOutputGuard: true })
        const { agent, session, 引导组 } = 造代理()
        会话事件监听器(session, 造消息事件(STEP, [造思考块('先想')]))
        会话事件监听器(session, 造消息事件(STEP, [造思考块('再想'), 造正文块('说清楚了')]))

        await 收尾监听器({ agent, turn: TURN })

        expect(引导组).toHaveLength(0)
    })

    it('只有别的回合的消息时不 steer', async () => {
        const { 收尾监听器, 会话事件监听器 } = 挂载({ emptyOutputGuard: true })
        const { agent, session, 引导组 } = 造代理()
        会话事件监听器(session, 造消息事件(STEP, [造思考块('上一回合的思考')], TURN + 1))

        await 收尾监听器({ agent, turn: TURN })

        expect(引导组).toHaveLength(0)
    })

    it('本回合没有消息时不 steer、也不抛', async () => {
        const { 收尾监听器, 会话事件监听器 } = 挂载({ emptyOutputGuard: true })
        const { agent, session, 引导组 } = 造代理()
        会话事件监听器(session, { type: 'turn/start', data: { turn: TURN } })

        await expect(收尾监听器({ agent, turn: TURN })).resolves.toBeUndefined()
        expect(引导组).toHaveLength(0)
    })

    it('重新挂载后旧监听器留下的同回合快照作废：不误伤，下一条消息又能正常判', async () => {
        const 首次 = 挂载({ emptyOutputGuard: true })
        const { agent, session, 引导组 } = 造代理()
        // 旧监听器在回合中途留下的快照：只有思考、没有正文 —— 正是 H2 的命中形态。
        首次.会话事件监听器(session, 造消息事件(STEP, [造思考块('只有想法')]))

        // 模拟热重载：模块实例还在，监听器换了一批。
        const 再次 = 挂载({ emptyOutputGuard: true })

        await 再次.收尾监听器({ agent, turn: TURN })

        expect(引导组).toHaveLength(0)

        // 新监听器写下的记忆照常生效：代号只作废旧挂载留下的那份，不是把记忆功能关掉。
        再次.会话事件监听器(session, 造消息事件(STEP, [造思考块('还是只有想法')]))

        await 再次.收尾监听器({ agent, turn: TURN })

        expect(引导组).toHaveLength(1)
        const 纠正消息 = 引导组[0] as 引导消息
        expect(纠正消息.source.summary).toBe('nudge.emptyTurn|1')
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

    it('换模型 = 换链：新模型重新拿到名额', async () => {
        const { 报错监听器 } = 挂载({ networkRetryCount: 1 })
        const 模型选择: 模型选择桩 = { 模型名: 'a' }
        const { agent } = 造代理(模型选择)
        const 载荷 = 造失败载荷(agent, { code: 'SERVER' })

        expect(await 报错监听器(载荷, 官方放弃)).toEqual({ kind: 'retry' })

        // 路由换了模型：平台那边是新 policy chain，名额必须从头来（否则同链序号与 retryId 全乱）。
        模型选择.模型名 = 'b'

        expect(await 报错监听器(载荷, 官方放弃)).toEqual({ kind: 'retry' })
    })

    it('写出的重试事件 policyKey 里带模型（平台链键没有 model，靠它换链）', async () => {
        const { 报错监听器 } = 挂载({ networkRetryCount: 5 })
        const { agent, 追加记录组 } = 造代理()

        await 报错监听器(造失败载荷(agent, { code: 'SERVER' }), 官方放弃)

        const 重试事件 = 追加记录组[0]
        expect(重试事件.type).toBe('llm/retry')
        const 事件数据 = 重试事件.data as { policyKey: string }
        expect(JSON.parse(事件数据.policyKey)[1]).toBe('deepseek-v4')
    })

    it('取不到模型时记 "-"：不拿 provider 冒充，且都落在同一条链上', async () => {
        const { 报错监听器 } = 挂载({ networkRetryCount: 1 })
        const 追加记录组: { readonly type: string; readonly data: unknown }[] = []
        const 会话: SessionLike = {
            append: (type: string, data: unknown): void => {
                追加记录组.push({ type, data })
            },
        }
        // 平台 Agent.model 必供，插件声明成可选：取不到时日志与 policyKey 一律记 '-'。
        const agent = { session: 会话, steer: (): void => {} } as unknown as AgentLike
        const 载荷 = 造失败载荷(agent, { code: 'SERVER' })

        expect(await 报错监听器(载荷, 官方放弃)).toEqual({ kind: 'retry' })
        expect(await 报错监听器(载荷, 官方放弃)).toBeUndefined()

        const 事件数据 = 追加记录组[0].data as { policyKey: string }
        expect(JSON.parse(事件数据.policyKey)).toEqual(['harden-fallback', '-'])
    })

    it('append 抛错时放行官方决定，名额不消耗：下一次同链仍写 retry=1', async () => {
        const { 报错监听器, 日志行组 } = 挂载({ networkRetryCount: 2 })
        const 追加记录组: { readonly type: string; readonly data: unknown }[] = []
        let 允许写入 = false
        const 会话: SessionLike = {
            append: (type: string, data: unknown): { seq: number } => {
                if (允许写入 === false) throw Error('会话拒绝写入')

                追加记录组.push({ type, data })
                return { seq: 追加记录组.length }
            },
        }
        const agent = { session: 会话, steer: (): void => {} } as unknown as AgentLike
        const 载荷 = 造失败载荷(agent, { code: 'SERVER' })

        await expect(报错监听器(载荷, 官方放弃)).resolves.toBeUndefined()
        expect(追加记录组).toHaveLength(0)
        expect(日志行组.some((行) => 行.includes('规则 H3 判定异常，已放行'))).toBe(true)

        允许写入 = true

        expect(await 报错监听器(载荷, 官方放弃)).toEqual({ kind: 'retry' })
        const 重试事件 = 追加记录组[0].data as { retry: number }
        expect(重试事件.retry).toBe(1)
        expect(追加记录组.map((记录) => 记录.type)).toEqual(['llm/retry', 'llm/retry-started'])
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
