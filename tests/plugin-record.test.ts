/**
 * `plugin:` 记录通道适配层的单元测试。
 *
 * 被测对象是 `src/host/plugin-record.ts`：写入口（落进日志的数据逐字段）、读入口（逐条自验 + 按 seq
 * 增量续接）与通道探测（rc.2 没有那两个函数 ⇒ 静默降级）。
 *
 * **只替掉「平台包在哪」那一层**（`session-repair.js` 的 `加载平台包组`）：它读磁盘上的真平台包，
 * 只有装了 DSH 的机器才有、CI 上没有；真包回放归第二批。断言全部落在本适配层的真实行为上——
 * `appendPluginRecord` 收到的参数、读出来的记录数组、增量读取真正喂进去的事件，不 mock 一圈断言 mock。
 *
 * @module dsh-harden/tests/plugin-record
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { 拦截记录 } from '../src/host/retry-intercept.js'
import type { Logger, SessionEventLike, SessionLike } from '../src/host/types.js'

/** 假平台包组：用例按需换成本次要给的那套（包名 → 模块对象）。 */
const 平台包组桩 = vi.hoisted(() => ({
    当前: {} as Record<string, unknown>,
    加载次数: 0,
    是否抛错: false,
    最近调用: null as { 必需包名组: readonly string[]; 候选包名组: readonly string[] } | null,
}))

vi.mock('../src/host/session-repair.js', async (importOriginal) => {
    // 只换掉「平台包在哪」这一步，其余照原样（候选包的常量仍是真的）。
    const 原模块 = await importOriginal<typeof import('../src/host/session-repair.js')>()

    return {
        ...原模块,

        加载平台包组: (必需包名组: readonly string[], 候选组: readonly { 包名: string }[]): Record<string, unknown> => {
            平台包组桩.加载次数 += 1
            平台包组桩.最近调用 = { 必需包名组, 候选包名组: 候选组.map((候选) => 候选.包名) }
            if (平台包组桩.是否抛错) throw new Error('定位平台包目录失败 —— 两个候选都失败')
            return 平台包组桩.当前
        },
    }
})

/** rc.2（桌面端 0.2.0-rc.2）的 `dsh-session` 导出面：没有 `appendPluginRecord` / `pluginRecordOf`。 */
const 假旧版平台模块 = { Session: class {}, KNOWN_SESSION_EVENT_TYPES: new Set() }

/** 一条拦截记录（与内存账本同形）。 */
const 样例记录: 拦截记录 = { 回合: 1, 步: 7, 序号: 2, 时间戳: 1750000000000 }

beforeEach(() => {
    平台包组桩.当前 = {}
    平台包组桩.加载次数 = 0
    平台包组桩.是否抛错 = false
    平台包组桩.最近调用 = null
})

/**
 * 重新加载被测模块。
 *
 * 模块内有「探测成功」缓存与按会话的读取缓存，用例之间必须互不串——每条用例都从新模块开始。
 */
async function 加载被测模块(): Promise<typeof import('../src/host/plugin-record.js')> {
    vi.resetModules()
    return await import('../src/host/plugin-record.js')
}

/** 造一条本插件的记录事件；覆盖项用来单改某一处形状（逐条跳过的过滤都靠它）。 */
function 造记录事件(覆盖: Record<string, unknown> = {}): SessionEventLike {
    return {
        type: 'plugin:dsh-harden/retry-intercept',
        seq: 0,
        ignorable: true,
        data: { 数据版本: 1, 回合: 1, 步: 7, 序号: 2, 时间戳: 1750000000000 },
        ...覆盖,
    } as unknown as SessionEventLike
}

/** 造一条普通平台事件（没有 ignorable 标记）。 */
function 造普通事件(类型: string, seq: number): SessionEventLike {
    return { type: 类型, seq, data: { turn: 1, step: 1 } }
}

/** 会话桩：只带读取面；`snapshotEvents` 按起点筛（平台语义：起点是**含**的），并记下每次的起点。 */
function 造会话桩(事件组: SessionEventLike[]): { 会话: SessionLike; 读取起点组: number[] } {
    const 读取起点组: number[] = []
    const 会话: SessionLike = {
        snapshotEvents(起点 = 0): readonly SessionEventLike[] {
            读取起点组.push(起点)
            return 事件组.filter((事件) => (事件.seq ?? 0) >= 起点)
        },
    }

    return { 会话, 读取起点组 }
}

/** 假平台模块：真函数的替身，记下落进 `appendPluginRecord` 的参数（`pluginRecordOf` 只作探测面）。 */
function 造平台模块(): { 模块: Record<string, unknown>; 落盘调用组: unknown[][] } {
    const 落盘调用组: unknown[][] = []
    const 模块: Record<string, unknown> = {
        appendPluginRecord(会话: unknown, 记录名: string, 数据: unknown): number {
            落盘调用组.push([会话, 记录名, 数据])
            return 落盘调用组.length
        },
        pluginRecordOf: (): undefined => undefined,
    }

    return { 模块, 落盘调用组 }
}

/** 日志桩：只收 warn（写失败的降级要看它）。 */
function 造日志桩(): { logger: Logger; 警告组: string[] } {
    const 警告组: string[] = []
    const logger: Logger = {
        warn: (消息: string): void => {
            警告组.push(消息)
        },
    }

    return { logger, 警告组 }
}

describe('writeRetryInterceptRecord（写入口）', () => {
    it('探测成功：按记录名写一条带版本号的日志数据', async () => {
        const { 模块, 落盘调用组 } = 造平台模块()
        平台包组桩.当前 = { 'dsh-session': 模块 }
        const { writeRetryInterceptRecord } = await 加载被测模块()
        const { 会话 } = 造会话桩([])

        writeRetryInterceptRecord(会话, 样例记录)

        expect(落盘调用组).toEqual([
            [会话, 'plugin:dsh-harden/retry-intercept', { 数据版本: 1, 回合: 1, 步: 7, 序号: 2, 时间戳: 1750000000000 }],
        ])
    })

    it('定位时给定位器的是 @deepseek-ai 下的一级目录名，候选是完整包名', async () => {
        平台包组桩.当前 = { 'dsh-session': 造平台模块().模块 }
        const { writeRetryInterceptRecord } = await 加载被测模块()

        writeRetryInterceptRecord(造会话桩([]).会话, 样例记录)

        expect(平台包组桩.最近调用?.必需包名组).toEqual(['dsh-session'])
        expect(平台包组桩.最近调用?.候选包名组).toEqual(['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-agent'])
    })

    it('探测成功后不再重复定位平台包', async () => {
        平台包组桩.当前 = { 'dsh-session': 造平台模块().模块 }
        const { writeRetryInterceptRecord } = await 加载被测模块()
        const { 会话 } = 造会话桩([])

        writeRetryInterceptRecord(会话, 样例记录)
        writeRetryInterceptRecord(会话, { ...样例记录, 序号: 3 })

        expect(平台包组桩.加载次数).toBe(1)
    })

    it('平台模块只有写函数（缺 pluginRecordOf）时不启用', async () => {
        const 落盘调用组: unknown[][] = []
        平台包组桩.当前 = {
            'dsh-session': {
                appendPluginRecord: (...参数组: unknown[]): number => {
                    落盘调用组.push(参数组)
                    return 1
                },
            },
        }
        const { writeRetryInterceptRecord } = await 加载被测模块()

        writeRetryInterceptRecord(造会话桩([]).会话, 样例记录)

        expect(落盘调用组).toEqual([])
    })

    it('本机没有平台包（定位抛错）时不写、不抛，只 warn 一行', async () => {
        平台包组桩.是否抛错 = true
        const { writeRetryInterceptRecord } = await 加载被测模块()
        const { logger, 警告组 } = 造日志桩()

        expect(() => writeRetryInterceptRecord(造会话桩([]).会话, 样例记录, logger)).not.toThrow()

        expect(警告组).toHaveLength(1)
        expect(警告组[0]).toContain('记录通道')
    })

    it('rc.2 没有这两个函数时不写、不抛，只 warn 一行', async () => {
        平台包组桩.当前 = { 'dsh-session': 假旧版平台模块 }
        const { writeRetryInterceptRecord } = await 加载被测模块()
        const { logger, 警告组 } = 造日志桩()

        expect(() => writeRetryInterceptRecord(造会话桩([]).会话, 样例记录, logger)).not.toThrow()

        expect(警告组).toHaveLength(1)
        expect(警告组[0]).toContain('记录通道')
    })

    it('探测失败不缓存：rc.2 下每次写都重新探一次', async () => {
        平台包组桩.当前 = { 'dsh-session': 假旧版平台模块 }
        const { writeRetryInterceptRecord } = await 加载被测模块()
        const { 会话 } = 造会话桩([])

        writeRetryInterceptRecord(会话, 样例记录)
        writeRetryInterceptRecord(会话, 样例记录)

        expect(平台包组桩.加载次数).toBe(2)
    })

    it('写入抛错（平台重入保护）时静默降级，只 warn 一行', async () => {
        平台包组桩.当前 = {
            'dsh-session': {
                appendPluginRecord: (): never => {
                    throw new Error('session append cannot reenter while another append is being published')
                },
                pluginRecordOf: (): undefined => undefined,
            },
        }
        const { writeRetryInterceptRecord } = await 加载被测模块()
        const { logger, 警告组 } = 造日志桩()

        expect(() => writeRetryInterceptRecord(造会话桩([]).会话, 样例记录, logger)).not.toThrow()

        expect(警告组).toHaveLength(1)
        expect(警告组[0]).toContain('拦截记录写入会话日志失败')
    })
})

describe('readRetryInterceptRecords（读入口）', () => {
    it('取出本插件的记录，逐条跳过非记录与不合形状的条目', async () => {
        平台包组桩.当前 = { 'dsh-session': 造平台模块().模块 }
        const { readRetryInterceptRecords } = await 加载被测模块()

        const 事件组: SessionEventLike[] = [
            造普通事件('assistant/message', 0),
            造记录事件({ seq: 1, ignorable: undefined }),
            造记录事件({ seq: 2, type: 'dsh-harden/retry-intercept' }),
            造记录事件({ seq: 3, type: 'plugin:其他插件/records' }),
            造记录事件({ seq: 4, data: { 数据版本: 2, 回合: 1, 步: 7, 序号: 2, 时间戳: 1 } }),
            造记录事件({ seq: 5, data: { 数据版本: 1, 回合: 1, 步: 7, 序号: '2', 时间戳: 1 } }),
            造记录事件({ seq: 6, data: '不是对象' }),
            造记录事件({ seq: 7 }),
            造记录事件({ seq: 8, data: { 数据版本: 1, 回合: 2, 步: 1, 序号: 1, 时间戳: 9 } }),
        ]
        const { 会话 } = 造会话桩(事件组)

        expect(readRetryInterceptRecords(会话)).toEqual([
            { 回合: 1, 步: 7, 序号: 2, 时间戳: 1750000000000 },
            { 回合: 2, 步: 1, 序号: 1, 时间戳: 9 },
        ])
    })

    it('通道不可用（rc.2）时回空数组', async () => {
        平台包组桩.当前 = { 'dsh-session': 假旧版平台模块 }
        const { readRetryInterceptRecords } = await 加载被测模块()
        const { 会话 } = 造会话桩([造记录事件({ seq: 0 })])

        expect(readRetryInterceptRecords(会话)).toEqual([])
    })

    it('会话对象缺失 / 事件面缺失 / 读事件抛错时回空数组、不抛', async () => {
        平台包组桩.当前 = { 'dsh-session': 造平台模块().模块 }
        const { readRetryInterceptRecords } = await 加载被测模块()

        expect(readRetryInterceptRecords(undefined as unknown as SessionLike)).toEqual([])
        expect(readRetryInterceptRecords({} as SessionLike)).toEqual([])
        expect(
            readRetryInterceptRecords({
                snapshotEvents: (): never => {
                    throw new Error('日志读不动')
                },
            } as unknown as SessionLike),
        ).toEqual([])
        expect(readRetryInterceptRecords({ snapshotEvents: (): string => '不是数组' } as unknown as SessionLike)).toEqual([])
    })

    it('首次读全量，之后按 seq 增量续接（缓存里的旧记录不重解析）', async () => {
        平台包组桩.当前 = { 'dsh-session': 造平台模块().模块 }
        const { readRetryInterceptRecords } = await 加载被测模块()

        const 事件组: SessionEventLike[] = [造记录事件({ seq: 0 }), 造普通事件('assistant/message', 1)]
        const { 会话, 读取起点组 } = 造会话桩(事件组)

        expect(readRetryInterceptRecords(会话)).toEqual([{ 回合: 1, 步: 7, 序号: 2, 时间戳: 1750000000000 }])
        expect(读取起点组).toEqual([0])

        // 已读过的那条被改成别的记录、又新写一条：增量读法不该回头重解析已读过的那条。
        事件组[0] = 造记录事件({ seq: 0, data: { 数据版本: 1, 回合: 9, 步: 9, 序号: 9, 时间戳: 9 } })
        事件组.push(造记录事件({ seq: 2, data: { 数据版本: 1, 回合: 2, 步: 1, 序号: 1, 时间戳: 9 } }))

        expect(readRetryInterceptRecords(会话)).toEqual([
            { 回合: 1, 步: 7, 序号: 2, 时间戳: 1750000000000 },
            { 回合: 2, 步: 1, 序号: 1, 时间戳: 9 },
        ])
        expect(读取起点组).toEqual([0, 2])
    })

    it('返回的是副本：调用方改不动缓存', async () => {
        平台包组桩.当前 = { 'dsh-session': 造平台模块().模块 }
        const { readRetryInterceptRecords } = await 加载被测模块()
        const { 会话 } = 造会话桩([造记录事件({ seq: 0 })])

        const 首次 = readRetryInterceptRecords(会话)
        首次[0].序号 = 99
        首次.push({ 回合: 9, 步: 9, 序号: 9, 时间戳: 9 })

        expect(readRetryInterceptRecords(会话)).toEqual([{ 回合: 1, 步: 7, 序号: 2, 时间戳: 1750000000000 }])
    })

    it('按会话对象分别缓存，不串台', async () => {
        平台包组桩.当前 = { 'dsh-session': 造平台模块().模块 }
        const { readRetryInterceptRecords } = await 加载被测模块()
        const 会话甲 = 造会话桩([造记录事件({ seq: 0 })])
        const 会话乙 = 造会话桩([造记录事件({ seq: 0, data: { 数据版本: 1, 回合: 2, 步: 1, 序号: 1, 时间戳: 9 } })])

        expect(readRetryInterceptRecords(会话甲.会话)).toEqual([{ 回合: 1, 步: 7, 序号: 2, 时间戳: 1750000000000 }])
        expect(readRetryInterceptRecords(会话乙.会话)).toEqual([{ 回合: 2, 步: 1, 序号: 1, 时间戳: 9 }])
        expect(readRetryInterceptRecords(会话甲.会话)).toEqual([{ 回合: 1, 步: 7, 序号: 2, 时间戳: 1750000000000 }])
        expect(会话乙.读取起点组).toEqual([0])
    })
})
