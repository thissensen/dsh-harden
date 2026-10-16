/**
 * `plugin:` 记录通道适配层 —— 把模块七「重试链修正」的拦截记录写进会话日志，并从日志读回。
 *
 * **为什么落日志**：内存账本（`retry-intercept.ts` 的记录存储）随进程生灭，重启后界面就不记得哪几处被
 * 改写。平台的 `plugin:` 记录通道（0.2.1-alpha.5 新增）给了插件一个自有的持久位置：记录带
 * `ignorable` 标记，读者不认识的类型一律**保留并跳过**，V3→V4 迁移还会把未知的 `ignorable` 事件收进
 * `plugin:` 命名空间，rc.2 读含记录的会话也安全（已实测）。
 *
 * **通道在无承诺面上**（`.harness/05-坑册.md` 坑 35）：官方注释限定「仅 `packages/experimental` 的生产
 * 代码可调用」，桌面端 0.2.0-rc.2 根本没有 `appendPluginRecord` / `pluginRecordOf`。所以本模块的所有失败
 * 一律静默降级：写失败只 warn 一行、读失败回空数组，绝不影响看护层的主职责。
 *
 * **一份记录，两个落点**：日志是持久源、内存账本是降级源，两个源在只读端点（第二批）合并。本模块只管
 * 「写进日志 / 从日志读回」，不改记录语义——形状与归属由 `retry-intercept.ts` 定义。读回有两条路径：
 * 按会话对象增量读（`readRetryInterceptRecords`，会话在本进程活着时）与按会话 id 冷读
 * （`读会话记录`，「查看会话」这类没打开过的会话）。
 *
 * **平台包动态定位**：不静态 import（不往 peerDependencies 加包、不动链接脚本），定位与加载交给
 * `session-repair.ts` 的两候选加载（坑 22 / 坑 27），目标包换成 `dsh-session`。
 *
 * @module dsh-harden/plugin-record
 */

import { 加载平台包组, 锚点包名, type 平台包候选 } from './session-repair.js'
import type { 拦截记录 } from './retry-intercept.js'
import type { Logger, SessionEventLike, SessionLike, 会话查询面 } from './types.js'

/** 记录名后缀：本插件名 + 这份记录的用途；读侧按它做宽松匹配。 */
const 记录名后缀 = 'dsh-harden/retry-intercept'

/** 记录名：平台按「`plugin:` + 小写分段」的语法校验，本插件只写这一个名字。 */
const 拦截记录名 = `plugin:${记录名后缀}`

/** 落进日志的数据版本；读回时必须等于它——将来换形状就换这个号，旧号码的记录自然被跳过。 */
const 记录数据版本 = 1

/**
 * 记录通道所在包：`dsh-session` 提供 `appendPluginRecord` / `pluginRecordOf`。
 * `包目录名` 是它在 `@deepseek-ai` 下的一级目录名（定位器按它取包、也按它作返回映射的键），
 * `包名` 是完整包名（候选解析用），两者不能混。
 */
const 记录通道包目录名 = 'dsh-session'
const 记录通道包名 = `@deepseek-ai/${记录通道包目录名}`

/**
 * 定位候选组：先直接解析目标包（插件装进 profile 内、与平台包同树时成立），失败再以锚点 `dsh-agent`
 * 反推 `@deepseek-ai` 目录（`link:` 装法下只有它被链进插件，见坑 22）。
 */
const 记录通道候选组: 平台包候选[] = [
    { 包名: 记录通道包名, 说明: `直接解析 ${记录通道包名}` },
    { 包名: 锚点包名, 说明: `锚点包 ${锚点包名}` },
]

/** 平台 `plugin:` 记录通道的最小面（动态加载，形状自备，不 import 平台类型）。 */
interface 平台记录通道 {
    /** 追加一条记录并返回它的 seq；另一次 append 正在发布时会抛。 */
    appendPluginRecord(会话: unknown, 记录名: string, 数据: unknown): unknown
    /** 把一条已提交的事件读成记录；不是记录时返回 undefined。 */
    pluginRecordOf(事件: unknown): unknown
}

/** 一个会话的读取缓存：已解析出的记录 + 已扫过的最大 seq。 */
interface 会话读取缓存 {
    /** 已解析出的记录（按日志顺序）。 */
    记录组: 拦截记录[]
    /** 已扫过的最大事件 seq；下次从它的下一条起增量续读。 */
    已见最大seq: number
}

/**
 * 探测结果：`undefined` = 还没探过，`null` = 这条通道在本进程不可用。
 * **只缓存成功**——失败（rc.2、加载不出来）下次调用仍会重探，见 `探测记录通道`。
 */
let 记录通道探测结果: 平台记录通道 | null | undefined

/** 按会话对象缓存的读取进度；会话对象被回收时缓存一起回收。 */
const 记录读取缓存组 = new WeakMap<object, 会话读取缓存>()

/**
 * 把一条拦截记录写进会话日志。
 *
 * 供模块七在**原 `append` 返回之后**调用：平台的 append 发布过程中再调 `appendPluginRecord` 会抛重入错误
 * （`session append cannot reenter while another append is being published`）。
 * 通道不可用、定位失败、写入抛错……所有失败都只 warn 一行：记录落不进日志时内存账本照旧持有它，
 * 界面提示不受影响。
 *
 * @param 会话 - 记录落在哪个会话上。
 * @param 记录 - 一条拦截记录（与内存账本同形的字段）。
 * @param logger - 日志出口；本模块不持有平台上下文，日志口由调用方给。
 */
export function writeRetryInterceptRecord(会话: SessionLike, 记录: 拦截记录, logger?: Logger): void {
    const 记录通道 = 探测记录通道()
    if (记录通道 === null) {
        logger?.warn?.('[harden] 本进程没有 plugin: 记录通道（rc.2 或平台包加载失败），本次拦截记录未落日志')
        return
    }

    try {
        // 落进日志的数据带版本号，另有四个与内存记录同义的字段；读回时版本号不进对外形状。
        记录通道.appendPluginRecord(会话, 拦截记录名, {
            数据版本: 记录数据版本,
            回合: 记录.回合,
            步: 记录.步,
            序号: 记录.序号,
            时间戳: 记录.时间戳,
        })

    } catch (err) {
        logger?.warn?.('[harden] 重试链拦截记录写入会话日志失败，已跳过（内存账本仍持有）', err)
    }
}

/**
 * 读会话日志里的拦截记录（只读端点用）。
 *
 * 按会话对象缓存：首次读全量事件，之后按 `snapshotEvents(fromSeq)` 从上次的最大 seq 增量续接——
 * `snapshotEvents` 平台已标 deprecated「新调用禁止」，本项目定稿**不迁移、先记录**（见
 * `.harness/05-坑册.md` 坑 26），读法与 `step-reader.ts` 同源。
 * 逐条自验（记录标记 + 记录名 + data 形状），不合形状就跳过这一条；通道不可用（rc.2 / 加载失败）、
 * 会话对象或事件面缺失、读事件抛错，一律回空数组——只读端点不能因为日志读不动而失败。
 *
 * @param 会话 - 要读的会话；不存在时（端点按会话 id 解析未命中）回空数组。
 * @returns 该会话日志里的拦截记录组；返回的是副本，调用方改不动缓存。
 */
export function readRetryInterceptRecords(会话: SessionLike): 拦截记录[] {
    if (会话 === null || typeof 会话 !== 'object') return []

    // 通道不可用时读写一视同仁地当没有这条通道：rc.2 下记录本就不可能是它写出来的。
    if (探测记录通道() === null) return []

    let 缓存 = 记录读取缓存组.get(会话)
    if (缓存 === undefined) {
        缓存 = { 记录组: [], 已见最大seq: -1 }
        记录读取缓存组.set(会话, 缓存)
    }

    const 新事件组 = 读事件组(会话, 缓存.已见最大seq + 1)
    for (const 事件 of 新事件组) {
        const 事件序号 = 读整数(事件.seq)
        if (事件序号 !== null && 事件序号 > 缓存.已见最大seq) 缓存.已见最大seq = 事件序号

        const 记录 = 解析拦截记录(事件)
        if (记录 !== null) 缓存.记录组.push(记录)
    }

    return 缓存.记录组.map((记录) => ({ ...记录 }))
}

/**
 * 读会话日志里的拦截记录（只读端点用的**冷读**路径）。
 *
 * **为什么需要它。**「查看会话」不创建 agent，只读端点拿不到会话对象（`retry-intercept.ts` 的会话对象
 * 注册表只登记装过拦截器的会话）⇒ 日志里明明有记录也读不出来、提示行不显示。平台的
 * `ctx.sessionQuery.readSession` 读的是完整会话日志、**不把会话变成活的**（注释原文
 * without making it live），正好补这条路径。
 *
 * 逐条自验复用 `解析拦截记录`（与按会话对象增量读那条路径**同一份口径**）；服务抛错（会话不存在 /
 * 日志校验不过）、返回形状不符一律回空数组——只读端点不能因为冷读失败而失败。
 *
 * @param 会话查询 - 平台的会话查询服务（`ctx.get('sessionQuery')` 现取）。
 * @param 会话ID - 要读的会话 id。
 * @returns 该会话日志里的拦截记录组（日志顺序）；读不出来就是空数组。
 */
export async function 读会话记录(会话查询: 会话查询面, 会话ID: string): Promise<拦截记录[]> {
    let 事件组: readonly SessionEventLike[]
    try {
        const 快照 = await 会话查询.readSession(会话ID)
        const 候选事件组 = 快照?.events
        if (Array.isArray(候选事件组) === false) return []
        事件组 = 候选事件组

    } catch {
        return []
    }

    const 记录组: 拦截记录[] = []
    for (const 事件 of 事件组) {
        const 记录 = 解析拦截记录(事件)
        if (记录 !== null) 记录组.push(记录)
    }

    return 记录组
}

/**
 * 探测本进程可用的平台记录通道。
 *
 * 判定：模块上 `appendPluginRecord` 与 `pluginRecordOf` **都是 function** 才启用——这两个函数是这条通道的
 * 读写面，缺任一说明本进程的平台版本没有它（桌面端 0.2.0-rc.2 两个都没有，已实测）。
 * **只缓存成功**：不可用（rc.2、加载失败）时不留缓存，下次调用重新探测。
 */
function 探测记录通道(): 平台记录通道 | null {
    if (记录通道探测结果 !== undefined) return 记录通道探测结果

    try {
        const 包组 = 加载平台包组([记录通道包目录名], 记录通道候选组)
        const 候选模块 = 包组[记录通道包目录名] as 平台记录通道 | undefined
        const 有记录通道读写面 =
            候选模块 !== undefined &&
            typeof 候选模块.appendPluginRecord === 'function' &&
            typeof 候选模块.pluginRecordOf === 'function'
        if (有记录通道读写面) 记录通道探测结果 = 候选模块

    } catch {
        // 定位/加载失败（本机没有平台包、目录派生不出来）：静默降级，且**不留缓存**，下次调用重新探。
        return null
    }

    return 记录通道探测结果 ?? null
}

/**
 * 读一段会话事件。
 *
 * `snapshotEvents` 平台已标 deprecated「新调用禁止」，本项目定稿不迁移、先记录（坑 26）；起点按上次读到的
 * 最大 seq 增量续接。读不到（平台真移除这个方法、返回非数组）一律按空数组——读历史失败只该让记录读不出来，
 * 不该把异常抛进只读端点。
 *
 * @param 会话 - 要读的会话。
 * @param 起点 - 起始 seq（平台语义是**含**起点）。
 */
function 读事件组(会话: SessionLike, 起点: number): readonly SessionEventLike[] {
    if (typeof 会话.snapshotEvents !== 'function') return []

    try {
        const 事件组 = 会话.snapshotEvents(起点)
        return Array.isArray(事件组) ? 事件组 : []

    } catch {
        return []
    }
}

/**
 * 把一条会话事件解析成拦截记录；不是本插件写的记录就返回 null。
 *
 * 逐条自验，任一关不过就跳过这一条（**不抛**）——会话里混着别的插件的记录、旧版本的记录、迁移改名后的
 * 记录都是正常的：`ignorable === true`（平台的记录标记）、记录名宽松匹配（`plugin:` 命名空间 +
 * `endsWith`，容忍迁移给记录名加前缀）、data 形状（版本号 + 四个有限整数）。
 * 归属自验是本模块的责任：平台的 `pluginRecordOf` 不校验记录属于谁。
 *
 * @param 事件 - 会话日志里的一条事件。
 */
function 解析拦截记录(事件: SessionEventLike): 拦截记录 | null {
    if (事件.ignorable !== true) return null
    if (typeof 事件.type !== 'string') return null

    const 是拦截记录名 = 事件.type.startsWith('plugin:') && 事件.type.endsWith(记录名后缀)
    if (是拦截记录名 === false) return null

    const 数据 = 事件.data
    if (数据 === null || typeof 数据 !== 'object' || Array.isArray(数据)) return null
    if (数据.数据版本 !== 记录数据版本) return null

    const 回合 = 读整数(数据.回合)
    const 步 = 读整数(数据.步)
    const 序号 = 读整数(数据.序号)
    const 时间戳 = 读整数(数据.时间戳)
    const 四个字段都是整数 = 回合 !== null && 步 !== null && 序号 !== null && 时间戳 !== null
    if (四个字段都是整数 === false) return null

    return { 回合, 步, 序号, 时间戳 }
}

/** 读一个有限整数；不是有限整数（含 NaN / Infinity / 小数 / 字符串）时返回 null。 */
function 读整数(值: unknown): number | null {
    if (typeof 值 !== 'number' || Number.isInteger(值) === false) return null
    return 值
}
