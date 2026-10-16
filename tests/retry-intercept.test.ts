/**
 * 重试链写入拦截器的单元测试。
 *
 * 被测对象是 `src/host/retry-intercept.ts`：包住 `session.append` 的写入拦截器、两个安装点
 * （`agent/created` / `agent/pre-step`）、拦截记录的内存账本与落进会话日志的 `plugin:` 记录，以及只读
 * 端点用的合并读取（内存 ∪ 日志）。会话桩**记下每一次落到原始 append 的调用**，断言直接验真正落到的
 * 数据，不 mock 一圈再断言 mock。
 *
 * **只替掉「平台包在哪」那一层**（`session-repair.js` 的 `加载平台包组`）：记录通道那一步读的是磁盘上的
 * 真平台包（只有装了 DSH 的机器才有），换成假模块后，写侧断言假通道真收到的参数、读侧读假通道真追加进
 * 会话桩事件组的记录——两侧都落在本模块的真实行为上。
 *
 * 事件形状取自真机样本（子代理会话 dfd3eb08-79dd-42ea-ae47-99fba10cc4e0：turn 1 / step 7 /
 * provider command-code，同链两条 retry=1 且 maxRetries=1），但事件数据全部内联构造，
 * 不读任何真实会话文件、不写死任何绝对路径。
 *
 * 冷读路径（会话查询面）由用例直接给桩——平台读一份「没打开过」的会话日志走的是那个服务，不是会话对象。
 *
 * 最后一组用**真平台校验器**回放同一序列（负对照：不装拦截器必被拒；正对照：装了之后过校验）。
 * 平台包只有真机才有（CI 上没有），拿不到就整组跳过——与会话修复用例同一条定位策略。
 *
 * @module dsh-harden/tests/retry-intercept
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ctx, Logger, SessionEventLike, 会话查询面 } from '../src/host/types.js'
import { mountRetryIntercept, 获取拦截记录, 获取全部拦截记录 } from '../src/host/retry-intercept.js'
import { loadPlatformValidator, type SessionValidator } from '../src/host/session-repair.js'

/**
 * 假平台记录通道：`appendPluginRecord` 收下写进日志的记录，`pluginRecordOf` 只作探测面
 * （`plugin-record.ts` 要求这两个都是函数才启用这条通道）。写出去的记录会**追加进对应会话桩的事件组**
 * ——平台真把记录写进会话日志之后，会话桩的 `snapshotEvents` 就读得到它，合并读取的断言因此落在真实
 * 行为上，而不是断言 mock。
 */
const 平台桩 = vi.hoisted(() => {
    /** 落进假通道的调用，形如 `[会话, 记录名, 数据]`。 */
    const 落盘调用组: unknown[][] = []
    /** 用例可切：模拟平台的 append 重入保护（另一次 append 正在发布时调 appendPluginRecord 会抛）。 */
    const 状态 = { 是否抛错: false }
    /** 会话桩的事件组：假通道按会话对象往里追加记录。 */
    const 会话事件组 = new WeakMap<object, unknown[]>()

    const 模块 = {
        appendPluginRecord(会话: unknown, 记录名: string, 数据: unknown): number {
            if (状态.是否抛错) throw new Error('session append cannot reenter while another append is being published')

            落盘调用组.push([会话, 记录名, 数据])

            const 事件组 = 会话事件组.get(会话 as object)
            if (事件组 !== undefined) {
                // seq 接着已有事件往下排（会话桩按 seq 筛事件，与会话日志的读法一致）。
                事件组.push({ type: 记录名, seq: 事件组.length, ignorable: true, data: 数据 })
            }

            return 落盘调用组.length
        },
        pluginRecordOf: (): undefined => undefined,
    }

    return { 模块, 落盘调用组, 状态, 会话事件组 }
})

vi.mock('../src/host/session-repair.js', async (importOriginal) => {
    // 只换掉「平台包在哪」这一步（真平台包只有装了 DSH 的机器才有），其余照原样——下面的回放用例仍用
    // 原始的 loadPlatformValidator 取真校验器。
    const 原模块 = await importOriginal<typeof import('../src/host/session-repair.js')>()

    return {
        ...原模块,
        加载平台包组: (): Record<string, unknown> => ({ 'dsh-session': 平台桩.模块 }),
    }
})

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

/** 一次落到原始 append 上的调用。 */
interface 落盘调用 {
    类型: string
    数据: unknown
    选项组: unknown[]
}

/** 会话桩：带拦截器要的写入面与会话头，另带读取面（只读端点按它读会话日志里的记录）。 */
interface 会话桩 {
    header: { id?: string }
    append(类型: string, 数据: unknown, ...选项组: unknown[]): unknown
    snapshotEvents(起点?: number): readonly SessionEventLike[]
}

/** 造一条本插件的日志记录事件（形状照 `plugin-record.ts` 写进会话日志的那份）。 */
function 造记录事件(seq: number, 字段: { 回合: number; 步: number; 序号: number; 时间戳: number }): SessionEventLike {
    return {
        type: 'plugin:dsh-harden/retry-intercept',
        seq,
        ignorable: true,
        data: { 数据版本: 1, 回合: 字段.回合, 步: 字段.步, 序号: 字段.序号, 时间戳: 字段.时间戳 },
    }
}

/**
 * 造一个平台会话查询桩（冷读路径那一层）。
 *
 * `readSession` 记下每次被问的会话 id——用例据此断言「读了几次、问的是哪个 id」；每次都全量回同一组事件，
 * 逐条自验由被测模块自己做。
 *
 * @param 事件组 - 该会话「日志」里的事件。
 */
function 造会话查询(事件组: readonly SessionEventLike[]): { 查询: 会话查询面; 读入ID组: string[] } {
    const 读入ID组: string[] = []
    const 查询: 会话查询面 = {
        async readSession(会话ID: string): Promise<{ events: readonly SessionEventLike[] }> {
            读入ID组.push(会话ID)
            return { events: 事件组 }
        },
    }

    return { 查询, 读入ID组 }
}

/**
 * 造一个记录调用的会话桩。
 *
 * @param 会话ID - 不给时头里就真的没有 id（覆盖「id 读不到」的分支）。
 * @param 事件组 - 会话日志里已有的事件；假记录通道往里追加本插件写进的记录。
 */
function 造会话桩(会话ID?: string, 事件组: SessionEventLike[] = []): {
    会话: 会话桩
    落盘组: 落盘调用[]
    进入时日志记录数: number[]
    事件组: SessionEventLike[]
    抛错控制: { 是否抛错: boolean }
} {
    const 落盘组: 落盘调用[] = []
    // 每次 append 进来时日志里已有多少条记录：「记账写在原 append 返回之后」靠它钉。
    const 进入时日志记录数: number[] = []
    const 抛错控制 = { 是否抛错: false }

    const 会话: 会话桩 = {
        header: 会话ID === undefined ? {} : { id: 会话ID },

        append(类型: string, 数据: unknown, ...选项组: unknown[]): unknown {
            落盘组.push({ 类型, 数据, 选项组 })
            进入时日志记录数.push(平台桩.落盘调用组.length)
            // 用例可切：模拟平台拒收这次写入。桩在抛之前已记下调用，用来断言改写确实交给了原 append。
            if (抛错控制.是否抛错) throw new Error('平台拒绝写入（用例构造）')

            return { seq: 落盘组.length }
        },

        snapshotEvents(起点 = 0): readonly SessionEventLike[] {
            return 事件组.filter((事件) => (事件.seq ?? 0) >= 起点)
        },
    }

    平台桩.会话事件组.set(会话, 事件组)

    return { 会话, 落盘组, 进入时日志记录数, 事件组, 抛错控制 }
}

/** 日志桩收下的全部行（info 与 warn 混在一起）；用例按关键词断言留痕，不按顺序。 */
const 日志行组: string[] = []

/** 日志桩。 */
const 日志桩: Logger = {
    info: (消息: string): void => {
        日志行组.push(消息)
    },
    warn: (消息: string): void => {
        日志行组.push(消息)
    },
}

/** 上下文桩：只记监听器，供用例按事件名派发（两个挂点各一个监听器）。 */
function 造上下文桩(): {
    ctx: Ctx
    派发: (事件: string, 载荷: unknown, next?: () => Promise<unknown>) => Promise<unknown>
} {
    const 监听器组 = new Map<string, (...参数组: unknown[]) => unknown>()

    const ctx = {
        on(事件: string, 监听器: (...参数组: unknown[]) => unknown): void {
            监听器组.set(事件, 监听器)
        },
    } as unknown as Ctx

    return {
        ctx,

        派发: async (事件: string, 载荷: unknown, next?: () => Promise<unknown>): Promise<unknown> => {
            const 监听器 = 监听器组.get(事件)
            if (监听器 === undefined) throw new Error(`上下文桩里没有挂 ${事件} 的监听器`)

            return await 监听器(载荷, next)
        },
    }
}

/**
 * 整个文件共用一个挂载：拦截器的状态（已装会话组 / 记录存储）是模块级的，挂一次就够。
 * 用例之间靠**各自独立的会话 id 与会话桩**隔离。
 */
const 测试环境 = 造上下文桩()

mountRetryIntercept(测试环境.ctx, 日志桩)

/** 用例之间清掉假记录通道的调用账与抛错开关：会话桩是各用例自造的，只有这份模块级状态要重置。 */
beforeEach(() => {
    平台桩.落盘调用组.length = 0
    平台桩.状态.是否抛错 = false
})

/**
 * 造一个会话桩，并按生产路径（主安装点 agent/created）把它装上拦截器。
 *
 * @param 会话ID - 会话 id；不给时头里没有 id。
 * @param 事件组 - 会话日志里已有的事件（模拟进程重启后重开会话：日志里早就有本插件的记录）。
 */
async function 装会话(会话ID?: string, 事件组: SessionEventLike[] = []): Promise<ReturnType<typeof 造会话桩>> {
    const 桩 = 造会话桩(会话ID, 事件组)
    await 测试环境.派发('agent/created', { agent: { session: 桩.会话 }, source: 'startup' })

    return 桩
}

describe('写入透传', () => {
    it('非重试类型原样透传：数据对象与 opts 都不变', async () => {
        const { 会话, 落盘组 } = await 装会话('透传-1')
        const 数据 = { turn: 真机链.turn, step: 真机链.step, message: { content: [] } }
        const 选项 = { surfaceOp: 'append', sourceEventSeqs: [1] }

        会话.append('assistant/message', 数据, 选项)

        expect(落盘组).toHaveLength(1)
        expect(落盘组[0].类型).toBe('assistant/message')
        expect(落盘组[0].数据).toBe(数据)
        expect(落盘组[0].选项组).toEqual([选项])
        expect(落盘组[0].选项组[0]).toBe(选项)
        expect(获取拦截记录('透传-1')).toEqual([])
    })

    it('项目自己 H3 形状的合法重试链（policyKey harden-fallback / delayMs 0 / maxRetries 5 / 序号 1..n）不被改写', async () => {
        const { 会话, 落盘组 } = await 装会话('合法链-1')
        const 链路覆盖 = {
            policyKey: '["harden-fallback"]',
            delayMs: 0,
            maxRetries: 5,
            failure: { code: 'SERVER' },
        }
        const 事件组: { 类型: string; 数据: Record<string, unknown> }[] = []
        for (const 序号 of [1, 2, 3]) {
            事件组.push({ 类型: 'llm/retry', 数据: 重试数据('h3-兜底链', 序号, 链路覆盖) })
            事件组.push({ 类型: 'llm/retry-started', 数据: 启动数据('h3-兜底链', 序号) })
        }

        for (const 事件 of 事件组) 会话.append(事件.类型, 事件.数据)

        expect(落盘组).toHaveLength(事件组.length)
        for (const [下标, 事件] of 事件组.entries()) {
            // 不光是「值相等」——落到的就是平台传进来的那个对象，没有无谓拷贝。
            expect(落盘组[下标].数据).toBe(事件.数据)
        }
        expect(获取拦截记录('合法链-1')).toEqual([])
    })
})

describe('平台坏序列归一', () => {
    it('同链两条 retry=1 被归一：第二条落成 retry=2 + 首条 retryId + maxRetries=2，started 同步改写', async () => {
        const { 会话, 落盘组 } = await 装会话('坏序列-1')
        const 首条 = 重试数据('6b1cc297', 1, { maxRetries: 1 })
        const 首条启动 = 启动数据('6b1cc297', 1)
        const 第二条 = 重试数据('b0797b5b', 1, { maxRetries: 1 })
        const 第二条启动 = 启动数据('b0797b5b', 1)

        会话.append('llm/retry', 首条)
        会话.append('llm/retry-started', 首条启动)
        会话.append('llm/retry', 第二条)
        会话.append('llm/retry-started', 第二条启动)

        // 首条本来就合法：原对象直通。
        expect(落盘组[0].数据).toBe(首条)
        expect(落盘组[1].数据).toBe(首条启动)
        // 第二条：序号 +1、retryId 归并到首条、maxRetries 抬到 2；配套的 started 一起改。
        expect(落盘组[2].数据).toEqual(重试数据('6b1cc297', 2, { maxRetries: 2 }))
        expect(落盘组[3].数据).toEqual({ turn: 真机链.turn, step: 真机链.step, retryId: '6b1cc297', retry: 2 })
        // 平台传进来的对象绝不就地改。
        expect(第二条).toEqual(重试数据('b0797b5b', 1, { maxRetries: 1 }))
        expect(第二条启动).toEqual(启动数据('b0797b5b', 1))
    })

    it('改写记一条拦截记录（回合 / 步 / 序号），started 的同步改写不额外记', async () => {
        const { 会话 } = await 装会话('记录-1')

        会话.append('llm/retry', 重试数据('r1', 1, { maxRetries: 1 }))
        会话.append('llm/retry-started', 启动数据('r1', 1))
        会话.append('llm/retry', 重试数据('r2', 1, { maxRetries: 1 }))
        会话.append('llm/retry-started', 启动数据('r2', 1))

        const 记录组 = 获取拦截记录('记录-1')
        expect(记录组).toHaveLength(1)
        expect(记录组[0]).toEqual({ 回合: 真机链.turn, 步: 真机链.step, 序号: 2, 时间戳: expect.any(Number) })

        // 返回的是副本：改它动不了内部状态。
        记录组[0].序号 = 99
        expect(获取拦截记录('记录-1')[0].序号).toBe(2)

        // 留痕：会话 id / 回合 / 步 / provider / 原坐标 → 新坐标 / 抬了 maxRetries。
        const 改写行 = 日志行组.find((行) => 行.includes('重试链改写') && 行.includes('记录-1')) ?? ''
        expect(改写行).toContain('turn=1')
        expect(改写行).toContain('step=7')
        expect(改写行).toContain('provider=command-code')
        expect(改写行).toContain('原 (r2, 1) → 新 (r1, 2)')
        expect(改写行).toContain('maxRetries 1 → 2')
    })
})

describe('会话中途装载（增量账本）', () => {
    it('第一条就是 retry=2 时原样落盘、不记拦截记录', async () => {
        const { 会话, 落盘组 } = await 装会话('中途装载-1')
        const 首条 = 重试数据('mid-A', 2, { maxRetries: 5 })

        会话.append('llm/retry', 首条)

        // 链首见按原坐标播种 ⇒ 原对象直通（不改写，也不做无谓拷贝）。
        expect(落盘组[0].数据).toBe(首条)
        expect(获取拦截记录('中途装载-1')).toEqual([])
    })

    it('同链随后 retry=3 同样原样落盘', async () => {
        const { 会话, 落盘组 } = await 装会话('中途装载-2')
        const 后续 = 重试数据('mid-A', 3, { maxRetries: 5 })

        会话.append('llm/retry', 重试数据('mid-A', 2, { maxRetries: 5 }))
        会话.append('llm/retry', 后续)

        expect(落盘组[1].数据).toBe(后续)
        expect(获取拦截记录('中途装载-2')).toEqual([])
    })

    it('新会话从 retry=1 起的坏序列照旧归一（主修复路径不受影响）', async () => {
        const { 会话, 落盘组 } = await 装会话('中途装载-对照-1')

        会话.append('llm/retry', 重试数据('r1', 1, { maxRetries: 1 }))
        会话.append('llm/retry', 重试数据('r2', 1, { maxRetries: 1 }))

        expect(落盘组[1].数据).toEqual(重试数据('r1', 2, { maxRetries: 2 }))
        expect(获取拦截记录('中途装载-对照-1')).toHaveLength(1)
    })
})

describe('安装与幂等', () => {
    it('对同一会话重复安装（两个挂点都来一遍）与装一次等价', async () => {
        const 桩 = 造会话桩('幂等-1')
        const 载荷 = { agent: { session: 桩.会话 } }

        await 测试环境.派发('agent/created', 载荷)
        await 测试环境.派发('agent/created', 载荷)
        await 测试环境.派发('agent/pre-step', 载荷, async () => undefined)

        桩.会话.append('llm/retry', 重试数据('r1', 1, { maxRetries: 1 }))
        桩.会话.append('llm/retry', 重试数据('r2', 1, { maxRetries: 1 }))

        // 装两次 = 同一条事件喂两遍账本，第二条会被落成 retry=3；这里必须只 +1 一次。
        expect(桩.落盘组[1].数据).toEqual(重试数据('r1', 2, { maxRetries: 2 }))
        expect(获取拦截记录('幂等-1')).toHaveLength(1)
    })

    it('兜底安装点把决定原样往下传', async () => {
        const 桩 = 造会话桩('兜底-1')
        const 决定 = { kind: 'proceed' }

        const 结果 = await 测试环境.派发('agent/pre-step', { agent: { session: 桩.会话 } }, async () => 决定)

        expect(结果).toBe(决定)
    })

    it('会话没有写入面（append）时跳过安装，监听器不抛', async () => {
        const 无写入口会话 = { header: { id: '无写入口-1' } }

        await expect(测试环境.派发('agent/created', { agent: { session: 无写入口会话 } })).resolves.toBeUndefined()
    })
})

describe('异常边界', () => {
    it('归一过程抛错时，原始 data 照常落盘', async () => {
        const { 会话, 落盘组 } = await 装会话('异常-1')

        // 触发场景的来由：包装后的 append 收到的是平台传进来的任意对象，账本要读它的
        // retryId 等字段。这里把 retryId 做成「一读就抛」的存取器——账本读字段当场抛，
        // 正是「归一自己出错」这一类。要钉的是：出错时落到原始 append 的必须是**原样的
        // data**（既不吞掉这次写入，也不写一半）。
        const 坏数据 = { ...真机链, mode: 'normal', retry: 1 } as Record<string, unknown>
        Object.defineProperty(坏数据, 'retryId', {
            enumerable: true,
            get(): string {
                throw new Error('读 retryId 就抛（用例构造）')
            },
        })

        会话.append('llm/retry', 坏数据)

        expect(落盘组).toHaveLength(1)
        expect(落盘组[0].数据).toBe(坏数据)
        expect(日志行组.some((行) => 行.includes('重试链归一异常'))).toBe(true)
    })

    it('会话 id 读不到时改写照常落盘，只留日志不记记录', async () => {
        const { 会话, 落盘组 } = await 装会话()

        会话.append('llm/retry', 重试数据('r1', 1, { maxRetries: 1 }))
        会话.append('llm/retry', 重试数据('r2', 1, { maxRetries: 1 }))

        // 归一不依赖会话 id：改写照常。
        expect(落盘组[1].数据).toEqual(重试数据('r1', 2, { maxRetries: 2 }))
        expect(日志行组.some((行) => 行.includes('未记入拦截记录'))).toBe(true)
    })
})

describe('拦截记录落日志（原 append 返回之后）', () => {
    it('改写落盘成功后写一条日志记录：参数逐字段正确，且发生在原 append 返回之后', async () => {
        const 桩 = await 装会话('日志记录-1')

        桩.会话.append('llm/retry', 重试数据('r1', 1, { maxRetries: 1 }))
        桩.会话.append('llm/retry-started', 启动数据('r1', 1))
        桩.会话.append('llm/retry', 重试数据('r2', 1, { maxRetries: 1 }))
        桩.会话.append('llm/retry-started', 启动数据('r2', 1))

        const 内存记录组 = 获取拦截记录('日志记录-1')
        expect(内存记录组).toHaveLength(1)

        // 第三条（被改写的那条）跑原 append 时日志里一条记录都还没有 ⇒ 记账确实排在它返回之后。
        expect(桩.进入时日志记录数[2]).toBe(0)

        // 只写一条：`llm/retry-started` 的同步改写是同一处修正的另一半，不单独记。
        const 期望数据 = {
            数据版本: 1,
            回合: 真机链.turn,
            步: 真机链.step,
            序号: 2,
            时间戳: 内存记录组[0].时间戳,
        }
        expect(平台桩.落盘调用组).toEqual([[桩.会话, 'plugin:dsh-harden/retry-intercept', 期望数据]])
    })

    it('没发生改写（合法链）时零调用', async () => {
        const 桩 = await 装会话('日志记录-未归一-1')
        const 合法覆盖 = { policyKey: '["harden-fallback"]', delayMs: 0, maxRetries: 5 }

        桩.会话.append('llm/retry', 重试数据('h3-链', 1, 合法覆盖))
        桩.会话.append('llm/retry', 重试数据('h3-链', 2, 合法覆盖))

        expect(获取拦截记录('日志记录-未归一-1')).toEqual([])
        expect(平台桩.落盘调用组).toEqual([])
    })

    it('原 append 抛错时：不写日志记录、不写内存账本，异常照旧往外抛', async () => {
        const 桩 = await 装会话('日志记录-落盘失败-1')

        桩.会话.append('llm/retry', 重试数据('r1', 1, { maxRetries: 99 }))
        桩.抛错控制.是否抛错 = true

        expect(() => 桩.会话.append('llm/retry', 重试数据('r2', 99, { maxRetries: 99 }))).toThrowError(
            '平台拒绝写入（用例构造）',
        )

        // 改写算出来了、也交给了原 append（桩在抛之前记下这次调用），但没落盘就两处都不该有记录。
        expect(桩.落盘组).toHaveLength(2)
        expect(桩.落盘组[1].数据).toEqual(重试数据('r1', 2, { maxRetries: 99 }))
        expect(获取拦截记录('日志记录-落盘失败-1')).toEqual([])
        expect(平台桩.落盘调用组).toEqual([])
    })

    it('写日志记录抛错（平台重入保护）时：落盘数据照旧、内存账本仍有该记录', async () => {
        const 桩 = await 装会话('日志记录-写失败-1')

        桩.会话.append('llm/retry', 重试数据('r1', 1, { maxRetries: 99 }))
        平台桩.状态.是否抛错 = true
        桩.会话.append('llm/retry', 重试数据('r2', 99, { maxRetries: 99 }))

        expect(桩.落盘组[1].数据).toEqual(重试数据('r1', 2, { maxRetries: 99 }))
        expect(获取拦截记录('日志记录-写失败-1')).toHaveLength(1)
        expect(日志行组.some((行) => 行.includes('拦截记录写入会话日志失败'))).toBe(true)
    })
})

describe('获取全部拦截记录（内存账本 ∪ 会话日志）', () => {
    it('同一条修正两处同形时只回一条', async () => {
        const 桩 = await 装会话('合并-去重-1')

        桩.会话.append('llm/retry', 重试数据('r1', 1, { maxRetries: 99 }))
        桩.会话.append('llm/retry', 重试数据('r2', 99, { maxRetries: 99 }))

        const 内存记录组 = 获取拦截记录('合并-去重-1')
        expect(内存记录组).toHaveLength(1)
        // 写侧两处都写了：日志里那条与内存那条四字段全等 ⇒ 合并结果只剩一条。
        expect(桩.事件组).toHaveLength(1)
        expect(await 获取全部拦截记录('合并-去重-1')).toEqual(内存记录组)
    })

    it('同回合、同步、同序号但时间戳不同的两条不合并；返回按时间戳升序', async () => {
        // 会话日志里已经有的两条（模拟进程重启后重开会话）：坐标三元组一样、时间戳不同 = 两处修正。
        const 事件组: SessionEventLike[] = [
            造记录事件(0, { 回合: 1, 步: 7, 序号: 2, 时间戳: 9 }),
            造记录事件(1, { 回合: 1, 步: 7, 序号: 2, 时间戳: 8 }),
        ]
        await 装会话('合并-三元组-1', 事件组)

        expect(await 获取全部拦截记录('合并-三元组-1')).toEqual([
            { 回合: 1, 步: 7, 序号: 2, 时间戳: 8 },
            { 回合: 1, 步: 7, 序号: 2, 时间戳: 9 },
        ])
    })

    it('两源合计超过 50 条时只回最近 50 条', async () => {
        const 事件组: SessionEventLike[] = []
        // 倒着放进日志：断言排序按时间戳升序，不是按日志顺序。
        for (let 序号 = 30; 序号 >= 1; 序号 -= 1) {
            事件组.push(造记录事件(事件组.length, { 回合: 1, 步: 序号, 序号: 序号, 时间戳: 1000 + 序号 }))
        }
        const 桩 = await 装会话('合并-截断-1', 事件组)

        // 25 次改写 ⇒ 内存账本 25 条（时间戳晚于日志里那 30 条），日志里也各追加一条。
        桩.会话.append('llm/retry', 重试数据('截断链', 1, { maxRetries: 99 }))
        for (let 次 = 0; 次 < 25; 次 += 1) 桩.会话.append('llm/retry', 重试数据('截断链', 99, { maxRetries: 99 }))

        const 记录组 = await 获取全部拦截记录('合并-截断-1')
        expect(记录组).toHaveLength(50)
        // 30 条日志 + 25 条内存 = 55 条 ⇒ 丢掉最早的 5 条（时间戳 1001..1005）。
        expect(记录组[0].时间戳).toBe(1006)
        expect(记录组[49].时间戳).toBe(获取拦截记录('合并-截断-1')[24].时间戳)
    })

    it('会话对象不在注册表里（注册表装满，最早的会话被淘汰）时只回内存账本', async () => {
        // 注册表与记录存储各有 50 个会话的上限、各自独立淘汰：先把注册表装满把最早的挤出去，再让最早的
        // 那个发生一次改写——此时内存账本有它、注册表里没有它（进程重启后尚未恢复的会话同理）。
        const 最早的 = await 装会话('淘汰-对象-0', [造记录事件(0, { 回合: 9, 步: 9, 序号: 9, 时间戳: 9 })])
        for (let 序 = 1; 序 <= 50; 序 += 1) await 装会话(`淘汰-对象-${序}`)

        最早的.会话.append('llm/retry', 重试数据('淘汰链', 1, { maxRetries: 99 }))
        最早的.会话.append('llm/retry', 重试数据('淘汰链', 99, { maxRetries: 99 }))

        const 内存记录组 = 获取拦截记录('淘汰-对象-0')
        expect(内存记录组).toHaveLength(1)
        // 只回内存账本：它日志里那条（还有本次改写写进去的那条）读不到，也不该凭空出现。
        expect(await 获取全部拦截记录('淘汰-对象-0')).toEqual(内存记录组)
    })

    it('注册表已满时用同 id 的新会话对象重装：不淘汰别人，只有新增槽位才挤掉最早进入的那个', async () => {
        // 最早进入的会话带一条日志记录：它在不在注册表里，靠这条记录读不读得出来分辨。
        await 装会话('重装-最早-1', [造记录事件(0, { 回合: 3, 步: 4, 序号: 5, 时间戳: 7 })])
        // 再装 49 个别的会话把注册表填满——此后注册表里就是这 50 个，最早那个排在最前。
        for (let 序 = 1; 序 <= 49; 序 += 1) await 装会话(`重装-填满-${序}`)

        // 同 id 的**新会话对象**再走一遍生产路径：这是覆盖已有槽位，不占新位置。
        await 装会话('重装-填满-1')

        // 覆盖不淘汰别人 ⇒ 最早那个仍在注册表里，它日志里的记录照旧读得到。
        expect(await 获取全部拦截记录('重装-最早-1')).toEqual([{ 回合: 3, 步: 4, 序号: 5, 时间戳: 7 }])

        // 容量没被覆盖缩水 ⇒ 下一个**新**会话进来时才挤掉最早进入的那个（淘汰时机只在新增槽位）。
        await 装会话('重装-挤位-1')
        expect(await 获取全部拦截记录('重装-最早-1')).toEqual([])
    })
})

/**
 * 冷读路径：注册表里没有该会话（「查看会话」不创建 agent、进程重启后还没恢复）时，靠平台的
 * `ctx.sessionQuery.readSession` 直接读日志里的记录。
 */
describe('获取全部拦截记录（冷读会话日志）', () => {
    it('注册表里没有该会话时冷读日志：逐条跳过非记录，结果按时间戳升序', async () => {
        const { 查询, 读入ID组 } = 造会话查询([
            { type: 'turn/start', seq: 0, data: { turn: 11 } },
            造记录事件(1, { 回合: 11, 步: 28, 序号: 1, 时间戳: 1750000000000 }),
            造记录事件(2, { 回合: 11, 步: 28, 序号: 1, 时间戳: 3 }),
        ])

        expect(await 获取全部拦截记录('冷读-只读-1', 查询)).toEqual([
            { 回合: 11, 步: 28, 序号: 1, 时间戳: 3 },
            { 回合: 11, 步: 28, 序号: 1, 时间戳: 1750000000000 },
        ])
        expect(读入ID组).toEqual(['冷读-只读-1'])
    })

    it('会话查询抛错或返回形状不符时回空数组、不抛', async () => {
        const 抛错查询: 会话查询面 = {
            async readSession(): Promise<{ events: readonly SessionEventLike[] }> {
                throw new Error('会话日志校验不过（用例构造）')
            },
        }
        const 形状不符查询 = {
            async readSession(): Promise<unknown> {
                return { events: '不是数组' }
            },
        } as unknown as 会话查询面

        expect(await 获取全部拦截记录('冷读-抛错-1', 抛错查询)).toEqual([])
        expect(await 获取全部拦截记录('冷读-形状-1', 形状不符查询)).toEqual([])
    })

    it('冷读结果有 30 秒缓存：连续两次调用只读一次日志，返回的又是副本', async () => {
        const { 查询, 读入ID组 } = 造会话查询([造记录事件(0, { 回合: 2, 步: 3, 序号: 1, 时间戳: 5 })])

        const 首次 = await 获取全部拦截记录('冷读-缓存-1', 查询)
        const 二次 = await 获取全部拦截记录('冷读-缓存-1', 查询)

        expect(读入ID组).toHaveLength(1)
        expect(二次).toEqual(首次)

        二次[0].序号 = 99
        expect(await 获取全部拦截记录('冷读-缓存-1', 查询)).toEqual(首次)
    })

    it('缓存 30 秒后过期：过期那一次重新读日志', async () => {
        const { 查询, 读入ID组 } = 造会话查询([造记录事件(0, { 回合: 3, 步: 1, 序号: 1, 时间戳: 5 })])
        const 起点时刻 = 1_700_000_000_000
        const 时钟 = vi.spyOn(Date, 'now').mockReturnValue(起点时刻)

        try {
            await 获取全部拦截记录('冷读-过期-1', 查询)
            时钟.mockReturnValue(起点时刻 + 29_999)
            await 获取全部拦截记录('冷读-过期-1', 查询)
            expect(读入ID组).toHaveLength(1)

            时钟.mockReturnValue(起点时刻 + 30_000)
            await 获取全部拦截记录('冷读-过期-1', 查询)
            expect(读入ID组).toHaveLength(2)

        } finally {
            时钟.mockRestore()
        }
    })

    it('注册表命中该会话时不冷读（对象上的实时读优先）', async () => {
        const { 查询, 读入ID组 } = 造会话查询([造记录事件(0, { 回合: 9, 步: 9, 序号: 9, 时间戳: 9 })])
        const 桩 = await 装会话('冷读-实时优先-1')

        桩.会话.append('llm/retry', 重试数据('冷读链', 1, { maxRetries: 99 }))
        桩.会话.append('llm/retry', 重试数据('冷读链', 99, { maxRetries: 99 }))

        const 内存记录组 = 获取拦截记录('冷读-实时优先-1')
        expect(内存记录组).toHaveLength(1)
        expect(await 获取全部拦截记录('冷读-实时优先-1', 查询)).toEqual(内存记录组)
        expect(读入ID组).toEqual([])
    })
})

/** 取真平台校验器（两候选定位，见 session-repair.ts）；本机没装平台包（CI）时返回 null。 */
function 取真校验器(): SessionValidator | null {
    try {
        return loadPlatformValidator()

    } catch {
        return null
    }
}

/** 真平台校验器；为 null 时整组回放用例跳过。 */
const 真校验器 = 取真校验器()

/**
 * 用「最小但能过真校验器」的会话骨架回放真机序列。
 *
 * 骨架形状逐条对照 `restoreReleasedV4Artifact` 的硬要求（实读平台源码核实）：header 只能有
 * version / id / createdAt / isSeeded / delegationDepth（多一个字段就报
 * `format v4 header has unexpected field`）；事件 `seq` 必须密集（= 下标）；`llm/retry` 必须落在
 * 打开着的回合与步里，且 provider 与最近的 `request/header` 一致。
 *
 * @param 是否装拦截器 - true 时先按生产路径（主安装点 `agent/created`）装上拦截器再回放。
 */
async function 回放真机序列(是否装拦截器: boolean): Promise<{ header: Record<string, unknown>; events: unknown[] }> {
    const 会话ID = 是否装拦截器 ? '回放-装拦截器' : '回放-不装拦截器'
    const 桩 = 造会话桩(会话ID)
    if (是否装拦截器) await 测试环境.派发('agent/created', { agent: { session: 桩.会话 } })

    桩.会话.append('turn/start', { turn: 真机链.turn })
    // 真机样本的链在第 7 步；校验器要求步号从 1 起逐条 +1，先把前面几步走完。
    for (let 步号 = 1; 步号 < 真机链.step; 步号 += 1) {
        桩.会话.append('step/start', { turn: 真机链.turn, step: 步号 })
        桩.会话.append('step/end', { turn: 真机链.turn, step: 步号 })
    }
    桩.会话.append('step/start', { turn: 真机链.turn, step: 真机链.step })
    桩.会话.append('request/header', { header: { config: { provider: 真机链.provider } } })
    桩.会话.append('llm/retry', 重试数据('6b1cc297', 1, { maxRetries: 1 }))
    桩.会话.append('llm/retry-started', 启动数据('6b1cc297', 1))
    桩.会话.append('llm/retry', 重试数据('b0797b5b', 1, { maxRetries: 1 }))
    桩.会话.append('llm/retry-started', 启动数据('b0797b5b', 1))
    桩.会话.append('step/end', { turn: 真机链.turn, step: 真机链.step })
    桩.会话.append('turn/end', { turn: 真机链.turn })

    const header = { version: 4, id: 会话ID, createdAt: 1, isSeeded: false, delegationDepth: 0 }
    // 落盘顺序就是会话日志顺序：校验器要求 seq 密集（= 下标）。
    const events = 桩.落盘组.map((调用, 下标) => ({ type: 调用.类型, seq: 下标, data: 调用.数据 }))

    return { header, events }
}

describe.skipIf(真校验器 === null)('真机样本回放（真平台校验器）', () => {
    const 校验器 = 真校验器 as SessionValidator

    it('负对照：不装拦截器时同链两条 retry=1 被真校验器拒', async () => {
        const 产物 = await 回放真机序列(false)

        expect(() => 校验器.validate(产物.header, 产物.events)).toThrowError(
            /llm\/retry skips its policy attempt sequence/,
        )
    })

    it('正对照：装拦截器后同一序列过真校验器', async () => {
        const 产物 = await 回放真机序列(true)

        expect(() => 校验器.validate(产物.header, 产物.events)).not.toThrow()
    })
})

/**
 * 记录存储的容量上限。
 *
 * 放在文件最后：记录存储是模块级的，这一组会挤掉前面用例留下的会话记录——上限行为本身就是
 * 「丢掉更早进入的」。断言只碰本组自己的会话 id，因此与前面留下来多少个会话无关。
 */
describe('拦截记录容量上限', () => {
    it('每条会话最多留 50 条，超出丢最旧', async () => {
        const { 会话 } = await 装会话('上限-每条-1')

        // 账本按「增量」喂：链首见按原坐标播种、不算改写，所以先落一条合法的链首；
        // 再反复报同一个错序号，每次都被改写成链上的下一个序号（2..52）⇒ 51 条改写记录，上限裁掉最旧的 2。
        会话.append('llm/retry', 重试数据('上限链', 1, { maxRetries: 99 }))
        for (let 次 = 0; 次 < 51; 次 += 1) 会话.append('llm/retry', 重试数据('上限链', 99, { maxRetries: 99 }))

        const 记录组 = 获取拦截记录('上限-每条-1')
        expect(记录组).toHaveLength(50)
        expect(记录组[0].序号).toBe(3)
        expect(记录组[记录组.length - 1].序号).toBe(52)
    })

    it('最多留 50 个会话的记录，超出丢最早进入的那个', async () => {
        for (let 序 = 0; 序 < 52; 序 += 1) {
            const { 会话 } = await 装会话(`上限-会话-${序}`)
            // 链首见不算改写 ⇒ 每条会话先落一条合法的链首，再报一条错序号，正好 1 条记录。
            会话.append('llm/retry', 重试数据('上限链', 1, { maxRetries: 99 }))
            会话.append('llm/retry', 重试数据('上限链', 99, { maxRetries: 99 }))
        }

        expect(获取拦截记录('上限-会话-0')).toEqual([])
        expect(获取拦截记录('上限-会话-51')).toHaveLength(1)
    })
})
