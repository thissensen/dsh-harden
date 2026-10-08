/**
 * 规则「子代理通知聚合」的持久化测试。
 *
 * 被测对象是 `src/host/subagent-aggregate.ts` 的 `mountSubagentAggregation()`：桩只提供
 * 边界输入（桩 ctx / 桩注册表 / 桩 agent / 桩结算通知），断言里看到的 `inbox.remove`、
 * `inbox.replace`、`followup` 调用记录都出自模块里真实的监听器。
 *
 * **为什么顶掉 `@deepseek-ai/dsh-llm`。** CI 上没有宿主包，模块连加载都会失败；假的
 * `createUserMessage` 只记下产品喂进来的 `content` 与 `source`，并回一个稳定 id
 * （`agg-N`）——断言验的是「本模块交给平台工厂的参数」，不是这个桩自己。
 *
 * `agent/disposed` 的兜底投递排在 `setImmediate` 上，相关用例用 `等宏任务()` 等它跑完。
 *
 * @module dsh-harden/tests/subagent-aggregate
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
    AgentDisposedPayload,
    AggregationAgentLike,
    Ctx,
    InboxInsertedPayload,
    InboxMessageLike,
    Logger,
    MessageSourceLike,
} from '../src/host/types.js'
import { DEFAULT_SUBAGENT_AGGREGATION, defaultConfig, readConfig } from '../src/host/config.js'
import { mountSubagentAggregation } from '../src/host/subagent-aggregate.js'

// ── 平台消息构造器的替身 ──────────────────────────────────────────────────

/** 假 `createUserMessage` 记下的每一次入参（产品喂给平台工厂的真实参数）。 */
interface 聚合消息入参 {
    readonly content: readonly { readonly type: string; readonly text?: string }[]
    readonly source: {
        readonly kind: string
        readonly form: string
        readonly summary: string
        readonly senderSessionId: string
    }
}

/** 工厂调用记录：跨用例共享，每个用例开头清空。 */
const 聚合消息入参组: 聚合消息入参[] = []

vi.mock('@deepseek-ai/dsh-llm', () => ({
    createUserMessage: (入参: 聚合消息入参) => {
        聚合消息入参组.push(入参)

        return { id: `agg-${聚合消息入参组.length}` }
    },
}))

beforeEach(() => {
    聚合消息入参组.length = 0
})

// ── 桩：agent、结算通知、桩 ctx ──────────────────────────────────────────

/** 用例里的坐标常量。 */
const 父会话 = 'sess-parent'
const 子会话甲 = 'sess-child-a'
const 子会话乙 = 'sess-child-b'
const 子会话丙 = 'sess-child-c'

/** 桩 agent 被碰过的边界调用。 */
interface 代理调用记录 {
    /** `inbox.remove` 收到过的消息 id。 */
    readonly 摘除组: string[]
    /** `inbox.replace` 收到过的消息 id 与新消息。 */
    readonly 替换组: { readonly 消息标识: string; readonly 新消息: unknown }[]
    /** `followup` 收到过的消息。 */
    readonly 跟进组: unknown[]
}

/** 带调用记录的桩 agent。 */
interface 代理桩 extends AggregationAgentLike {
    readonly 调用: 代理调用记录
}

/**
 * 造一个 agent 桩。
 *
 * @param 会话标识 - agent 的会话 id。
 * @param 所属父会话 - 会话头里的 `parentSession`；根代理传 undefined。
 * @param 落空通知组 - 这些消息在收件箱里已取不到：两个 inbox 方法对它们一律回 false。
 */
function 造代理(
    会话标识: string,
    所属父会话: string | undefined,
    落空通知组: readonly string[] = [],
): 代理桩 {
    const 调用: 代理调用记录 = { 摘除组: [], 替换组: [], 跟进组: [] }

    return {
        id: 会话标识,
        session: { header: { parentSession: 所属父会话 }, snapshotEvents: () => [] },
        inbox: {
            remove: (消息标识: string) => {
                调用.摘除组.push(消息标识)

                return 落空通知组.includes(消息标识) === false
            },
            replace: (消息标识: string, 新消息: unknown) => {
                调用.替换组.push({ 消息标识, 新消息 })

                return 落空通知组.includes(消息标识) === false
            },
        },
        followup: (消息: unknown) => {
            调用.跟进组.push(消息)
        },
        调用,
    }
}

/**
 * 造一条平台形状的结算通知。
 *
 * 内容三块与真机同形：结束原因行（index 0）、收尾说明「Its closing message:」（index 1）、
 * 收尾正文（index ≥ 2）。
 */
function 造结算通知(会话标识: string, 通知标识: string, 收尾正文: string): InboxMessageLike {
    const 来源: MessageSourceLike & { readonly form: string; readonly summary: string } = {
        kind: 'subagent-settled',
        form: 'notice',
        summary: `Subagent ${会话标识} settled`,
        senderSessionId: 会话标识,
    }

    return {
        id: 通知标识,
        content: [
            { type: 'text', text: `Subagent ${会话标识} finished its work.` },
            { type: 'text', text: 'Its closing message:' },
            { type: 'text', text: 收尾正文 },
        ],
        source: 来源,
    }
}

/** 日志桩：info / warn 不记，error 单独收起来（模块的内部异常都被自己的 catch 吞掉了）。 */
interface 日志桩 extends Logger {
    readonly 错误组: string[]
}

/** 造一个日志桩。 */
function 造日志桩(): 日志桩 {
    const 错误组: string[] = []

    return {
        错误组,
        error: (消息: string) => {
            错误组.push(消息)
        },
    }
}

/** 一套挂载好的聚合规则环境。 */
interface 聚合环境 {
    /** 喂一条 `agent/inbox/inserted` 事件（同步跑真实监听器）。 */
    喂插入(代理: AggregationAgentLike, 消息: InboxMessageLike): void
    /** 喂一条 `agent/disposed` 事件（被移除的是子代理自己）。 */
    喂移除(代理: AggregationAgentLike): void
    /** 换掉注册表的活跃代理组（模拟平台增删子代理）。 */
    设置活跃代理组(代理组: AggregationAgentLike[]): void
    /** 改「子代理通知聚合」开关（监听器每次都现读）。 */
    设置开关(聚合开关: boolean): void
    /** 本环境的日志桩。 */
    readonly 日志: 日志桩
}

/**
 * 挂上一条真实的「子代理通知聚合」规则。
 *
 * 桩 ctx 的 `inject` 同步回调自身（真机上服务是异步补齐的，这里不需要那层时序）：
 * 模块判「服务在不在」读的就是 `agents` 与 `on` 两样。
 *
 * @param 初始开关 - 挂载时 `subagentAggregation` 的取值。
 * @returns 喂事件、改环境与看日志的几个口子。
 */
function 挂载聚合规则(初始开关: boolean): 聚合环境 {
    let 活跃代理组: AggregationAgentLike[] = []
    let 启用 = 初始开关
    const 监听器组 = new Map<string, (...args: unknown[]) => unknown>()
    const 日志 = 造日志桩()

    /** 取监听器：没挂上就直接抛，免得桩静默吞掉「模块根本没挂上」这种失败。 */
    function 取监听器(事件名: string): (...args: unknown[]) => unknown {
        const 监听器 = 监听器组.get(事件名)
        if (监听器 === undefined) throw Error(`未挂上 ${事件名} 监听器`)

        return 监听器
    }

    const 桩上下文: Ctx = {
        agents: {
            list: () => 活跃代理组,
            get: (会话标识: string) => 活跃代理组.find((候选) => 候选.id === 会话标识),
        },
        on: (事件名: string, 监听器: (...args: unknown[]) => unknown) => {
            监听器组.set(事件名, 监听器)
        },
        inject: (_依赖组: readonly string[], 回调: (ctx: Ctx) => void) => {
            回调(桩上下文)
        },
    }

    mountSubagentAggregation(桩上下文, 日志, () => ({ ...defaultConfig(), subagentAggregation: 启用 }))

    return {
        日志,
        喂插入: (代理, 消息) => {
            const 载荷: InboxInsertedPayload = { agent: 代理, message: 消息 }
            取监听器('agent/inbox/inserted')(载荷)
        },
        喂移除: (代理) => {
            const 载荷: AgentDisposedPayload = { agent: 代理 }
            取监听器('agent/disposed')(载荷)
        },
        设置活跃代理组: (代理组) => {
            活跃代理组 = 代理组
        },
        设置开关: (聚合开关) => {
            启用 = 聚合开关
        },
    }
}

// ── 用例共用的走法与读取口 ──────────────────────────────────────────────

/** 等一轮宏任务：`agent/disposed` 的兜底投递排在 `setImmediate` 上。 */
async function 等宏任务(): Promise<void> {
    await new Promise<void>((resolve) => {
        setImmediate(() => {
            resolve()
        })
    })
}

/** 取工厂入参里每个内容块的正文，便于整体比对。 */
function 取正文组(入参: 聚合消息入参): (string | undefined)[] {
    return 入参.content.map((内容块) => 内容块.text)
}

/** 一次完整聚合的现场。 */
interface 聚合现场 {
    readonly 环境: 聚合环境
    readonly 父代理: 代理桩
    readonly 子代理组: 代理桩[]
}

/**
 * 走一遍完整聚合：先压住甲乙两条结算通知（此刻丙还活跃），再喂丙的最后一条
 * （此刻注册表里只剩丙，甲乙已像真机那样被移除）。
 *
 * @param 最后一条已取走 - true 表示喂丙那条通知时它已不在 pending（`inbox.replace` 落空）。
 * @returns 环境、父代理桩与三个子代理桩。
 */
function 走完整聚合流程(最后一条已取走: boolean = false): 聚合现场 {
    const 环境 = 挂载聚合规则(true)
    const 父代理 = 造代理(父会话, undefined, 最后一条已取走 ? ['通知丙'] : [])
    const 子代理甲 = 造代理(子会话甲, 父会话)
    const 子代理乙 = 造代理(子会话乙, 父会话)
    const 子代理丙 = 造代理(子会话丙, 父会话)
    环境.设置活跃代理组([父代理, 子代理甲, 子代理乙, 子代理丙])

    环境.喂插入(父代理, 造结算通知(子会话甲, '通知甲', '甲收尾正文'))
    环境.喂插入(父代理, 造结算通知(子会话乙, '通知乙', '乙收尾正文'))
    环境.设置活跃代理组([父代理, 子代理丙])
    环境.喂插入(父代理, 造结算通知(子会话丙, '通知丙', '丙收尾正文'))

    return { 环境, 父代理, 子代理组: [子代理甲, 子代理乙, 子代理丙] }
}

/** 一次兜底场景的现场：甲的结算通知已压进账本。 */
interface 兜底现场 {
    readonly 环境: 聚合环境
    readonly 父代理: 代理桩
    readonly 子代理甲: 代理桩
    readonly 子代理乙: 代理桩
}

/**
 * 造一套兜底场景：甲先结算（此刻乙还活跃 ⇒ 甲的通知被压进账本）；
 * 之后注册表怎么变、开关怎么动，由用例自己安排。
 */
function 压住甲结算通知(): 兜底现场 {
    const 环境 = 挂载聚合规则(true)
    const 父代理 = 造代理(父会话, undefined)
    const 子代理甲 = 造代理(子会话甲, 父会话)
    const 子代理乙 = 造代理(子会话乙, 父会话)
    环境.设置活跃代理组([父代理, 子代理甲, 子代理乙])

    环境.喂插入(父代理, 造结算通知(子会话甲, '通知甲', '甲收尾正文'))

    return { 环境, 父代理, 子代理甲, 子代理乙 }
}

// ── 用例 ────────────────────────────────────────────────────────────────

describe('子代理通知聚合', () => {
    describe('结算通知到达（agent/inbox/inserted）', () => {
        it('开关关：整条通知原样放行，不碰收件箱', () => {
            const 环境 = 挂载聚合规则(false)
            const 父代理 = 造代理(父会话, undefined)
            const 子代理甲 = 造代理(子会话甲, 父会话)
            const 子代理乙 = 造代理(子会话乙, 父会话)
            环境.设置活跃代理组([父代理, 子代理甲, 子代理乙])

            环境.喂插入(父代理, 造结算通知(子会话甲, '通知甲', '甲收尾正文'))

            expect(父代理.调用.摘除组).toEqual([])
            expect(父代理.调用.替换组).toEqual([])
            expect(父代理.调用.跟进组).toEqual([])
            expect(聚合消息入参组).toEqual([])
        })

        it('非结算通知：用户发言不碰收件箱', () => {
            const 环境 = 挂载聚合规则(true)
            const 父代理 = 造代理(父会话, undefined)
            const 子代理甲 = 造代理(子会话甲, 父会话)
            const 子代理乙 = 造代理(子会话乙, 父会话)
            环境.设置活跃代理组([父代理, 子代理甲, 子代理乙])

            const 用户消息: InboxMessageLike = {
                id: '用户消息',
                content: [{ type: 'text', text: '用户自己说的话' }],
                source: { kind: 'user' },
            }
            环境.喂插入(父代理, 用户消息)

            expect(父代理.调用.摘除组).toEqual([])
            expect(父代理.调用.替换组).toEqual([])
            expect(聚合消息入参组).toEqual([])
        })

        it('单一子代理结算：原样放行，不摘不换', () => {
            const 环境 = 挂载聚合规则(true)
            const 父代理 = 造代理(父会话, undefined)
            const 子代理甲 = 造代理(子会话甲, 父会话)
            环境.设置活跃代理组([父代理, 子代理甲])

            // 孤立通知（账本为空，且没有别的活跃子代理）不压不聚合，与平台原样一致
            // ——交接文档（用户定稿）§3.1 的口径。
            环境.喂插入(父代理, 造结算通知(子会话甲, '通知甲', '甲收尾正文'))

            expect(父代理.调用.摘除组).toEqual([])
            expect(父代理.调用.替换组).toEqual([])
            expect(聚合消息入参组).toEqual([])
        })

        it('还有兄弟没结算：把通知摘出收件箱压住', () => {
            const 环境 = 挂载聚合规则(true)
            const 父代理 = 造代理(父会话, undefined)
            const 子代理甲 = 造代理(子会话甲, 父会话)
            const 子代理乙 = 造代理(子会话乙, 父会话)
            环境.设置活跃代理组([父代理, 子代理甲, 子代理乙])

            环境.喂插入(父代理, 造结算通知(子会话甲, '通知甲', '甲收尾正文'))

            expect(父代理.调用.摘除组).toEqual(['通知甲'])
            expect(父代理.调用.替换组).toEqual([])
            expect(聚合消息入参组).toEqual([])
        })

        it('连压两条后来最后一条：就地替换成一条聚合消息，正文按记录顺序拼', () => {
            const 现场 = 走完整聚合流程()

            expect(现场.父代理.调用.摘除组).toEqual(['通知甲', '通知乙'])
            expect(现场.父代理.调用.替换组).toEqual([{ 消息标识: '通知丙', 新消息: { id: 'agg-1' } }])
            expect(现场.环境.日志.错误组).toEqual([])

            const 入参 = 聚合消息入参组[0]
            expect(入参.content[0].text).toContain('3')
            expect(取正文组(入参).slice(1)).toEqual([
                `Subagent ${子会话甲} finished its work.`,
                '甲收尾正文',
                `Subagent ${子会话乙} finished its work.`,
                '乙收尾正文',
                `Subagent ${子会话丙} finished its work.`,
                '丙收尾正文',
            ])
        })

        it('聚合消息的来源：沿用结算通知的 kind / form 与最后一条的发送者', () => {
            走完整聚合流程()

            const 来源 = 聚合消息入参组[0].source
            expect(来源.kind).toBe('subagent-settled')
            expect(来源.form).toBe('notice')
            expect(来源.senderSessionId).toBe(子会话丙)
            expect(来源.summary).toContain('3')
        })

        it('重入防御：自己发出的聚合消息 id 再进来，不再摘不再聚合', () => {
            const 现场 = 走完整聚合流程()

            // 平台为 replace / followup 会再同步 emit 一条 inserted：消息 id 正是聚合消息自己。
            现场.环境.喂插入(现场.父代理, 造结算通知(子会话丙, 'agg-1', '丙收尾正文'))

            expect(聚合消息入参组.length).toBe(1)
            expect(现场.父代理.调用.摘除组).toEqual(['通知甲', '通知乙'])
            expect(现场.父代理.调用.替换组.length).toBe(1)
            expect(现场.父代理.调用.跟进组).toEqual([])
        })

        it('replace 落空：改走 followup，聚合内容一条不丢', () => {
            const 现场 = 走完整聚合流程(true)

            expect(现场.父代理.调用.替换组).toEqual([{ 消息标识: '通知丙', 新消息: { id: 'agg-1' } }])
            expect(现场.父代理.调用.跟进组).toEqual([{ id: 'agg-1' }])

            const 正文组 = 取正文组(聚合消息入参组[0])
            expect(正文组).toContain(`Subagent ${子会话甲} finished its work.`)
            expect(正文组).toContain('甲收尾正文')
            expect(正文组).toContain(`Subagent ${子会话丙} finished its work.`)
            expect(正文组).toContain('丙收尾正文')
        })

        it('remove 落空：这条不入账本，后续聚合不含它', () => {
            const 环境 = 挂载聚合规则(true)
            const 父代理 = 造代理(父会话, undefined, ['通知甲'])
            const 子代理甲 = 造代理(子会话甲, 父会话)
            const 子代理乙 = 造代理(子会话乙, 父会话)
            const 子代理丙 = 造代理(子会话丙, 父会话)
            环境.设置活跃代理组([父代理, 子代理甲, 子代理乙, 子代理丙])

            环境.喂插入(父代理, 造结算通知(子会话甲, '通知甲', '甲收尾正文'))
            环境.喂插入(父代理, 造结算通知(子会话乙, '通知乙', '乙收尾正文'))
            环境.设置活跃代理组([父代理, 子代理丙])
            环境.喂插入(父代理, 造结算通知(子会话丙, '通知丙', '丙收尾正文'))

            const 正文组 = 取正文组(聚合消息入参组[0])
            expect(正文组[0]).toContain('2')
            expect(正文组).toContain('乙收尾正文')
            expect(正文组).toContain('丙收尾正文')
            expect(正文组).not.toContain('甲收尾正文')
        })

        it('发送者自己不算兄弟：账本非空时最后一条照常聚合（发送者在册 / 已移除）', () => {
            // 发送者在册：它自己不能被算成自己的兄弟，否则会被继续压住而不是聚合。
            const 在册环境 = 挂载聚合规则(true)
            const 在册父代理 = 造代理(父会话, undefined)
            const 在册子代理甲 = 造代理(子会话甲, 父会话)
            const 在册子代理乙 = 造代理(子会话乙, 父会话)
            在册环境.设置活跃代理组([在册父代理, 在册子代理甲, 在册子代理乙])
            在册环境.喂插入(在册父代理, 造结算通知(子会话甲, '通知甲', '甲收尾正文'))
            在册环境.设置活跃代理组([在册父代理, 在册子代理乙])
            在册环境.喂插入(在册父代理, 造结算通知(子会话乙, '通知乙', '乙收尾正文'))

            // 发送者已从注册表移除：同样只剩它这一条，最后一条照常聚合。
            const 已移除环境 = 挂载聚合规则(true)
            const 已移除父代理 = 造代理(父会话, undefined)
            const 已移除子代理甲 = 造代理(子会话甲, 父会话)
            const 已移除子代理乙 = 造代理(子会话乙, 父会话)
            已移除环境.设置活跃代理组([已移除父代理, 已移除子代理甲, 已移除子代理乙])
            已移除环境.喂插入(已移除父代理, 造结算通知(子会话甲, '通知甲', '甲收尾正文'))
            已移除环境.设置活跃代理组([已移除父代理])
            已移除环境.喂插入(已移除父代理, 造结算通知(子会话乙, '通知乙', '乙收尾正文'))

            expect(在册父代理.调用.摘除组).toEqual(['通知甲'])
            expect(在册父代理.调用.替换组).toEqual([{ 消息标识: '通知乙', 新消息: { id: 'agg-1' } }])
            expect(已移除父代理.调用.替换组).toEqual([{ 消息标识: '通知乙', 新消息: { id: 'agg-2' } }])
            expect(取正文组(聚合消息入参组[0])).toContain('甲收尾正文')
            expect(取正文组(聚合消息入参组[1])).toContain('甲收尾正文')
            expect(取正文组(聚合消息入参组[1])).toContain('乙收尾正文')
        })

        it('一次性（one-shot）子代理也算兄弟：通知照压（已知边界）', () => {
            // 模块判兄弟只看会话头的 parentSession，认不出「不会再发结算通知」的一次性子代理：
            // 那种子代理在线时，通知会被压住，直到下一条结算通知或 disposed 兜底。
            const 环境 = 挂载聚合规则(true)
            const 父代理 = 造代理(父会话, undefined)
            const 子代理甲 = 造代理(子会话甲, 父会话)
            const 一次性子代理 = 造代理('sess-one-shot', 父会话)
            环境.设置活跃代理组([父代理, 子代理甲, 一次性子代理])

            环境.喂插入(父代理, 造结算通知(子会话甲, '通知甲', '甲收尾正文'))

            expect(父代理.调用.摘除组).toEqual(['通知甲'])
            expect(父代理.调用.替换组).toEqual([])
            expect(聚合消息入参组).toEqual([])
        })
    })

    describe('兜底投递（agent/disposed）', () => {
        it('账本非空且已无活跃子：把压住的通知合成一条 followup 投出去', async () => {
            const 现场 = 压住甲结算通知()
            现场.环境.设置活跃代理组([现场.父代理, 现场.子代理乙])

            现场.环境.喂移除(现场.子代理乙)
            await 等宏任务()

            expect(现场.父代理.调用.替换组).toEqual([])
            expect(现场.父代理.调用.跟进组).toEqual([{ id: 'agg-1' }])
            expect(取正文组(聚合消息入参组[0])).toContain('甲收尾正文')
            expect(现场.环境.日志.错误组).toEqual([])
        })

        it('账本非空但还有活跃子：不投递，等下一个结算通知', async () => {
            const 现场 = 压住甲结算通知()
            const 子代理丙 = 造代理(子会话丙, 父会话)
            现场.环境.设置活跃代理组([现场.父代理, 现场.子代理乙, 子代理丙])

            现场.环境.喂移除(现场.子代理乙)
            await 等宏任务()

            expect(现场.父代理.调用.跟进组).toEqual([])
            expect(聚合消息入参组).toEqual([])
        })

        it('父已不在注册表：不投递并清掉账本', async () => {
            const 现场 = 压住甲结算通知()
            现场.环境.设置活跃代理组([现场.子代理乙])

            现场.环境.喂移除(现场.子代理乙)
            await 等宏任务()

            expect(现场.父代理.调用.跟进组).toEqual([])
            expect(聚合消息入参组).toEqual([])

            // 账本已清：把父放回注册表再喂一次 disposed，也不会有任何投递。
            现场.环境.设置活跃代理组([现场.父代理])
            现场.环境.喂移除(现场.子代理乙)
            await 等宏任务()

            expect(现场.父代理.调用.跟进组).toEqual([])
            expect(聚合消息入参组).toEqual([])
        })

        it('开关中途关掉：不投递并清掉账本', async () => {
            const 现场 = 压住甲结算通知()
            现场.环境.设置开关(false)
            现场.环境.设置活跃代理组([现场.父代理, 现场.子代理乙])

            现场.环境.喂移除(现场.子代理乙)
            await 等宏任务()

            expect(现场.父代理.调用.跟进组).toEqual([])
            expect(聚合消息入参组).toEqual([])

            // 账本已清：开关再打开、父也在册，重喂 disposed 也不会把甲的通知投出去。
            现场.环境.设置开关(true)
            现场.环境.设置活跃代理组([现场.父代理])
            现场.环境.喂移除(现场.子代理乙)
            await 等宏任务()

            expect(现场.父代理.调用.跟进组).toEqual([])
            expect(聚合消息入参组).toEqual([])
        })

        it('兜底赛跑：账本被正常聚合清掉，排队的宏任务重查账本后不投递', async () => {
            const 现场 = 压住甲结算通知()
            现场.环境.设置活跃代理组([现场.父代理])

            // disposed 先到：账本非空，先排一个宏任务兜底。
            现场.环境.喂移除(现场.子代理乙)
            // 同一个同步片段里，最后一条结算通知走正常聚合路径把账本清掉。
            现场.环境.喂插入(现场.父代理, 造结算通知(子会话丙, '通知丙', '丙收尾正文'))
            await 等宏任务()

            expect(现场.父代理.调用.替换组).toEqual([{ 消息标识: '通知丙', 新消息: { id: 'agg-1' } }])
            expect(现场.父代理.调用.跟进组).toEqual([])
            expect(聚合消息入参组.length).toBe(1)

            // 同步快速路径同样不投递：账本已空时再喂 disposed，连宏任务都不排。
            现场.环境.喂移除(现场.子代理乙)
            await 等宏任务()

            expect(现场.父代理.调用.跟进组).toEqual([])
            expect(聚合消息入参组.length).toBe(1)
        })

        it('根代理（没有父会话）被移除：不排宏任务、不投递', async () => {
            const 现场 = 压住甲结算通知()

            // 父代理自己就是根代理（会话头没有 parentSession）：它被移除与「某个父名下全结算了」无关。
            现场.环境.喂移除(现场.父代理)
            await 等宏任务()

            expect(现场.父代理.调用.跟进组).toEqual([])
            expect(聚合消息入参组).toEqual([])
        })
    })

    describe('配置层', () => {
        it('readConfig：缺字段回落默认关，true 如实透传', () => {
            expect(DEFAULT_SUBAGENT_AGGREGATION).toBe(false)
            expect(readConfig({}).subagentAggregation).toBe(false)
            expect(readConfig({ subagentAggregation: true }).subagentAggregation).toBe(true)
        })

        it('readConfig：volatile 引用现取现读', () => {
            let 启用 = false
            const 原始配置 = { subagentAggregation: { get: () => 启用 } }

            expect(readConfig(原始配置).subagentAggregation).toBe(false)

            启用 = true
            expect(readConfig(原始配置).subagentAggregation).toBe(true)
        })
    })
})
