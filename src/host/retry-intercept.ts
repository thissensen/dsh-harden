/**
 * 重试链写入拦截器 —— 在重试事件落盘之前做增量归一，坏值根本进不了日志。
 *
 * **背景**（`.harness/05-坑册.md` 坑 28）。平台自带重试器偶发把自己的重试状态读成空，于是同一条
 * policy chain 写出两条 `retry = 1`、还各带一个新 `retryId`（真机样本
 * `dfd3eb08-79dd-42ea-ae47-99fba10cc4e0`）。平台的会话读校验对重试链有四条硬不变量（序号从 1 起
 * 逐条 +1、整链共用一个 `retryId`、`llm/retry-started` 按 (retryId, retry) 配对、`normal` 模式
 * `retry <= maxRetries`），但**只在读会话时校验，写的时候不查**——这份会话之后整份打不开，只能靠
 * 会话修复器事后补。本模块把判定挪到写入路径上：坏值当场归一，再落盘。
 *
 * **判定只有一份**：四条不变量收敛在 `retry-chain-ledger.ts` 的重试链账本里（会话修复器对整份日志
 * 批量跑的是同一份账本）。本模块只负责「包住 `session.append` → 先喂账本 → 按结论改写或原样放行」。
 *
 * **为什么包 `session.append`**：平台重试器与本项目自己的 H3 兜底（`index.ts` 的
 * `reportRetryToSession`）都只走这一个口写重试事件。`Session.append` 是类原型方法，实例赋值可以
 * 覆盖；包装前先 `bind` 出原始实现，包装里调用**已绑定**的它——项目自己就是
 * `append.call(session, ...)` 形式，脱离对象调用会丢 `this`。
 *
 * **一次改写，两处落点**：内存账本（本模块的 `记录存储组`，按会话 id 走，进程重启即空）与会话日志里的
 * `plugin:` 记录（`plugin-record.ts`，持久）。日志记录**只能写在原 `append` 返回之后**（同一同步栈）：
 * 平台在另一次 append 正在发布时调 `appendPluginRecord` 会抛重入错误。只读端点按会话 id 取两处的并集，
 * 故安装拦截器时还要把会话对象登记进 `会话对象组`（端点拿它读该会话日志里的记录）；**没登记过的会话**
 * （「查看会话」不创建 agent、进程重启后该会话还没恢复）则由端点改用平台的 `ctx.sessionQuery` 冷读日志
 * （见 `取冷读记录`）——少了这条路径，日志里明明有记录、提示行也不显示。
 *
 * **异常边界（两处，都不能少）**：归一逻辑整段 try-catch，出错就打日志、用**原始 data** 放行；
 * 两个挂点的监听器自身也绝不抛——`agent/created` 是 serial，监听器抛错会让平台**创建 agent 失败**。
 *
 * **安装时机与幂等**：主安装点 `agent/created`（serial，agent 进入注册表、放行排队输入之前），
 * 兜底安装点 `agent/pre-step`（waterfall，热重载等时序下补装）。会话对象记在模块级 `WeakSet` 里，
 * 重复安装什么都不做——装两次会让同一条事件喂两遍账本，第二条重试事件会被写成 `retry = 3`。
 *
 * **账本在包装闭包里**（而不是另开一张 `WeakMap<session, 账本>`）：闭包随会话对象一起回收，
 * 生命周期已经一致，再开一张没人读的 WeakMap 只是多一处写入。
 *
 * @module dsh-harden/retry-intercept
 */

import { 重试链账本, type 归一结论 } from './retry-chain-ledger.js'
import { readRetryInterceptRecords, writeRetryInterceptRecord, 读会话记录 } from './plugin-record.js'
import type { Ctx, Logger, SessionLike, 会话查询面 } from './types.js'

/** 每条会话最多保留的拦截记录条数（超出丢最旧）。 */
const 每会话记录上限 = 50

/** 记录存储最多保留的会话个数（超出丢最早进入的那个）。 */
const 记录会话上限 = 50

/**
 * 一条拦截记录：某个会话的哪一步被改写成了什么序号。
 *
 * 字段名是给 client 半边用的**接口契约**（`GET /api/dsh-harden/retry-intercepts` 的响应元素），
 * 不按内部叫法改写。
 */
export interface 拦截记录 {
    /** 回合号（取自被改写的那条 `llm/retry`）。 */
    回合: number
    /** 步号（取自被改写的那条 `llm/retry`）。 */
    步: number
    /** 归一后该链的序号。 */
    序号: number
    /** 记录时刻（Unix 毫秒）。 */
    时间戳: number
}

/**
 * 拦截记录存储：会话 id → 该会话的拦截记录组。
 *
 * **为什么是 Map 而不是 WeakMap**：只读端点按**会话 id（字符串）**查记录，WeakMap 的 key 只能是
 * 对象、也枚举不出来。生命周期由两个上限管：每条会话 50 条、最多 50 个会话。
 */
const 记录存储组 = new Map<string, 拦截记录[]>()

/** 已装拦截器的会话对象；重复安装什么都不做（见文件头「安装时机与幂等」）。 */
const 已装会话组 = new WeakSet<object>()

/**
 * 冷读结果的缓存时限（毫秒）。
 *
 * 一次冷读要读**整份**会话日志，而 client 的提示行最快每秒就来拉一次——不缓存等于把「读日志」变成每秒一次的
 * 常态开销。活跃会话走会话对象那条实时路径（冷读根本不参与），冷读只覆盖「没打开过 / 重启后还没恢复」这类
 * 记录不会再变的会话，30 秒的延迟足够短、也足够省。
 */
const 冷读缓存时限 = 30_000

/** 一次冷读的缓存条目。 */
interface 冷读缓存 {
    /** 这次冷读的时刻（Unix 毫秒），用来判缓存有没有过期。 */
    时间戳: number
    /** 这次冷读读到的记录组（日志顺序）。 */
    记录组: 拦截记录[]
}

/**
 * 冷读结果缓存：会话 id → `{ 时间戳, 记录组 }`。
 *
 * 上限口径与记录存储、会话对象注册表一致：最多 `记录会话上限` 个会话，**新增槽位**时超出丢最早进入的那个
 * ——冷读的键是客户端给的会话 id（任意字符串），不设上限会随请求过的 id 数一直涨。
 */
const 冷读缓存组 = new Map<string, 冷读缓存>()

/**
 * 会话对象注册表：会话 id → 会话对象。
 *
 * **为什么留会话对象**：拦截记录的另一半落在会话日志里，只读端点只有拿到会话对象才读得出来（日志按
 * 会话走）。装拦截器是唯一拿得到会话对象的地方，就在那里登记。上限口径与记录存储一致：最多
 * `记录会话上限` 个会话，**新增槽位**时超出丢最早进入的那个（覆盖已有 id 不淘汰任何人）。
 * **后装的覆盖同 id 的先前的**——同一 id 上来了更新的会话对象（热重载 / 会话重开），端点该读新的那个。
 */
const 会话对象组 = new Map<string, SessionLike>()

/**
 * 取某个会话的拦截记录：**内存账本**这一侧的源（端点的合并读取有两处，另一处是会话日志里的 `plugin:` 记录）。
 *
 * @param 会话ID - 会话 id。
 * @returns 该会话的拦截记录组；未知 id 返回空数组。返回的是副本，调用方改不动内部状态。
 */
export function 获取拦截记录(会话ID: string): 拦截记录[] {
    const 记录组 = 记录存储组.get(会话ID)
    if (记录组 === undefined) return []
    return 记录组.map((记录) => ({ ...记录 }))
}

/**
 * 取某个会话的全部拦截记录：内存账本 ∪ 该会话日志里的记录（只读端点用）。
 *
 * **日志那一侧有两条路径，二选一**：
 *
 * - **注册表命中**（该会话在本进程活着）⇒ 会话对象上的增量读，实时优先；
 * - **注册表未命中 + 会话查询可用** ⇒ **冷读**：按会话 id 直接读整份日志（不打开会话、不创建 agent），
 *   结果按 `冷读缓存时限` 缓存，见 `取冷读记录`。
 *
 * 两个源各自可能为空：记录落进日志之后进程重启，内存账本是空的、日志里那条还在；会话对象不在注册表里
 * 又拿不到会话查询（桌面端 asar 0.2.0-rc.2 没有该服务）时读不到日志，只回内存账本——与只读端点从前的
 * 行为一致。日志只增不改（重启后重读到的老记录也在），按时间戳升序排完只回最近 `每会话记录上限` 条。
 *
 * @param 会话ID - 会话 id。
 * @param 会话查询 - 平台的会话查询服务；拿不到时（服务缺失）只走内存账本与会话对象两条源。
 * @returns 该会话的拦截记录组（时间戳升序、最多 50 条）；未知 id 返回空数组。
 */
export async function 获取全部拦截记录(会话ID: string, 会话查询?: 会话查询面): Promise<拦截记录[]> {
    const 合并组 = 获取拦截记录(会话ID)

    const 会话对象 = 会话对象组.get(会话ID)
    if (会话对象 !== undefined) {
        并入记录(合并组, readRetryInterceptRecords(会话对象))

    } else if (会话查询 !== undefined) {
        并入记录(合并组, await 取冷读记录(会话ID, 会话查询))
    }

    合并组.sort((甲记录, 乙记录) => 甲记录.时间戳 - 乙记录.时间戳)

    return 合并组.slice(-每会话记录上限)
}

/**
 * 把日志里读到的一批记录并进合并组。
 *
 * 去重按**四个字段全等**（同一条修正两处同形，时间戳也相同）：只按「回合 / 步 / 序号」比会把同一回合、
 * 同一步上两条不同重试链的修正并成一条。
 *
 * @param 合并组 - 内存账本的副本；就地追加。
 * @param 记录组 - 日志里读到的记录（两条路径读出的都是同一形状）。
 */
function 并入记录(合并组: 拦截记录[], 记录组: readonly 拦截记录[]): void {
    for (const 记录 of 记录组) {
        const 是否已合并 = 合并组.some((已合并记录) =>
            已合并记录.回合 === 记录.回合 &&
            已合并记录.步 === 记录.步 &&
            已合并记录.序号 === 记录.序号 &&
            已合并记录.时间戳 === 记录.时间戳)
        if (是否已合并) continue

        合并组.push(记录)
    }
}

/**
 * 取某个会话的冷读记录（带缓存）。
 *
 * 缓存命中且没过期就直接用；过期或没有就重新读一次日志，读到的记录组连时间戳一起存下来。
 *
 * @param 会话ID - 会话 id。
 * @param 会话查询 - 平台的会话查询服务。
 * @returns 该会话日志里的拦截记录组；返回的是副本，调用方改不动缓存。
 */
async function 取冷读记录(会话ID: string, 会话查询: 会话查询面): Promise<拦截记录[]> {
    let 缓存 = 冷读缓存组.get(会话ID)
    if (缓存 === undefined || Date.now() - 缓存.时间戳 >= 冷读缓存时限) {
        淘汰最早会话(冷读缓存组, 会话ID)
        缓存 = { 时间戳: Date.now(), 记录组: await 读会话记录(会话查询, 会话ID) }
        冷读缓存组.set(会话ID, 缓存)
    }

    return 缓存.记录组.map((记录) => ({ ...记录 }))
}

/** 拦截器要用的会话面：写入口（`append`）+ 会话头（取会话 id）。 */
interface 拦截会话 {
    /**
     * 追加一条会话事件。
     *
     * 平台的 `Session` 一定有；测试桩与老版本会话可能没有（见 `types.ts` 的同款说明），
     * 缺失时本模块不装拦截器、什么都不做。
     */
    append(type: string, data: unknown, opts?: unknown): unknown
    /** 会话头；`header.id` 是平台公开读面上的会话 id。 */
    readonly header?: { readonly id?: string }
}

/** 两个挂点的载荷里本项目只用到 `agent.session`（`agent/created` 与 `agent/pre-step` 都带它）。 */
interface 会话载荷 {
    readonly agent?: { readonly session?: unknown }
}

/**
 * 挂上重试链写入拦截器。
 *
 * 两个挂点都调同一个「尽力安装」，装不装得上都不改变平台的决定。
 *
 * @param ctx - cordis 上下文。
 * @param logger - 日志出口。
 */
export function mountRetryIntercept(ctx: Ctx, logger: Logger): void {
    if (typeof ctx.on !== 'function') {
        logger.warn?.('[harden] ctx.on 不可用，重试链写入拦截器未挂上')
        return
    }

    // 主安装点（serial）：agent 进入注册表、平台放行排队输入之前。
    ctx.on('agent/created', (payloadRaw: unknown): void => {
        尽力安装拦截器(payloadRaw, logger)
    })

    // 兜底安装点（waterfall）：热重载等时序下 agent/created 已经过去，进下一步之前补装。
    // 先尽力安装，再把决定**原样**往下传——本拦截器不参与这一步的判定。
    ctx.on('agent/pre-step', async (payloadRaw: unknown, nextRaw: unknown): Promise<unknown> => {
        尽力安装拦截器(payloadRaw, logger)

        const next = nextRaw as () => Promise<unknown>
        return await next()
    })

    logger.info?.('[harden] 重试链写入拦截器已挂载（agent/created + agent/pre-step）')
}

/**
 * 尽力给载荷里的会话装上拦截器；装不上就什么都不做，**绝不抛**。
 *
 * @param payloadRaw - `agent/created` 或 `agent/pre-step` 的载荷。
 * @param logger - 日志出口。
 */
function 尽力安装拦截器(payloadRaw: unknown, logger: Logger): void {
    try {
        const 载荷 = payloadRaw as 会话载荷 | null
        const 会话 = 载荷?.agent?.session
        if (会话 === null || typeof 会话 !== 'object') return
        if (typeof (会话 as { append?: unknown }).append !== 'function') return
        if (已装会话组.has(会话)) return

        安装拦截器(会话 as 拦截会话, logger)
        已装会话组.add(会话)

    } catch (error) {
        // `agent/created` 是 serial：监听器抛错 = 平台创建 agent 失败。这里就是边界。
        logger.warn?.('[harden] 重试链写入拦截器安装失败，已跳过', error)
    }
}

/**
 * 包住会话的 `append`：重试事件先喂账本，按结论改写或原样透传，其余类型零开销直通；顺带把会话对象
 * 登记进 `会话对象组`（只读端点按会话 id 读该会话日志里的记录用）。
 *
 * @param 会话 - 待安装拦截器的会话。
 * @param logger - 日志出口。
 */
function 安装拦截器(会话: 拦截会话, logger: Logger): void {
    // 只读端点按会话 id 读该会话日志里的记录，而装拦截器是唯一拿得到会话对象的地方——就在这里登记。
    // id 读不到就没法按 id 查（改写发生时同样会跳过记账），不登记。
    const 会话ID = 读会话ID(会话)
    if (会话ID !== null) {
        // 同 id 上来了新会话对象（会话重开 / 热重载）时是覆盖已有槽位，不占新位置、不淘汰别人。
        淘汰最早会话(会话对象组, 会话ID)
        // 平台会话一定有读取面（`snapshotEvents`）；本模块的会话面只声明了拦截器要用的写入口，
        // 这里按平台的读面类型转一次，交给 plugin-record 读日志记录。
        会话对象组.set(会话ID, 会话 as unknown as SessionLike)
    }

    const 原始append = 会话.append.bind(会话)
    // 账本有状态，必须按会话日志的先后顺序喂事件 ⇒ 一个会话一个实例。
    // 喂入方式取「增量」：拦截器可能装在某条链已经写了第一条之后（热重载夹在链中间），账本对这条链是瞎的
    // ——链首见按原坐标播种、不重排，那条平台合法写下的事件原样放行。
    const 账本 = new 重试链账本('增量')

    会话.append = (类型: string, 数据: unknown, ...选项组: unknown[]): unknown => {
        // 只认两条重试事件；其余类型直接透传（零额外开销、零行为变化）。
        if (类型 !== 'llm/retry' && 类型 !== 'llm/retry-started') return 原始append(类型, 数据, ...选项组)

        let 落盘数据 = 数据
        let 待记记录: 拦截记录 | null = null
        try {
            const 本次归一 = 归一写入(类型, 数据, 账本, 会话, logger)
            落盘数据 = 本次归一.落盘数据
            待记记录 = 本次归一.待记记录

        } catch (error) {
            // 看护层的异常绝不能影响正常写入：出错就用原始 data 放行。真实平台上这种 shape
            // 本来也过不了平台自己那层校验——这里不替平台兜底，只是不额外添乱。
            logger.warn?.('[harden] 重试链归一异常，已按原始数据写入', error)
            落盘数据 = 数据
            待记记录 = null
        }

        const 返回值 = 原始append(类型, 落盘数据, ...选项组)

        // 记账只能发生在原 append **返回之后**：平台在另一次 append 正在发布时调 appendPluginRecord 会抛
        // 重入错误。写在这里也顺带修掉「落盘失败但账本已记」——上面抛错时根本走不到这里。
        if (待记记录 !== null) 记拦截记录(会话, 待记记录, logger)

        return 返回值
    }
}

/** 一次归一的产物：要落盘的 data + 该记的拦截记录。 */
interface 归一结果 {
    /** 交给原始 append 的 data：无需改动时是**原对象**（不做无谓拷贝），需要改动时是一份浅拷贝。 */
    落盘数据: unknown
    /** 本次改写要记的拦截记录；没改写、或改写的不是 `llm/retry` 时为 null。 */
    待记记录: 拦截记录 | null
}

/**
 * 喂账本、按结论决定要不要改写。
 *
 * 只做**判定**：记账（内存账本 + 会话日志里的记录）由调用方在**原 append 返回之后**做——平台的 append
 * 发布过程中不能写记录。
 *
 * @param 类型 - 事件类型（只会有 `llm/retry` 与 `llm/retry-started`）。
 * @param 数据 - 平台传进来的 data。
 * @param 账本 - 本会话的重试链账本。
 * @param 会话 - 事件落在哪个会话上（打改写日志取会话 id）。
 * @param logger - 日志出口。
 * @returns 该写进日志的 data 与本次要记的拦截记录。
 */
function 归一写入(
    类型: string,
    数据: unknown,
    账本: 重试链账本,
    会话: 拦截会话,
    logger: Logger,
): 归一结果 {
    const 记录 = 读数据记录(数据)
    if (记录 === null) return { 落盘数据: 数据, 待记记录: null }

    const 结论 = 类型 === 'llm/retry' ? 账本.归一重试事件(记录) : 账本.归一启动事件(记录)
    if (结论 === null || 结论.有改动 === false) return { 落盘数据: 数据, 待记记录: null }

    打改写日志(会话, 记录, 结论, logger)

    // 只在 `llm/retry` 被改写时记一条：`llm/retry-started` 的同步改写是同一处修正的另一半，
    // 界面提示里的「N 处」数的是链上的修正，不是事件条数。
    let 待记记录: 拦截记录 | null = null
    if (类型 === 'llm/retry') {
        待记记录 = {
            // 回合 / 步 也由账本保证是数字（链键构造不出来就没有结论）。
            回合: 记录.turn as number,
            步: 记录.step as number,
            序号: 结论.retry,
            时间戳: Date.now(),
        }
    }

    // 浅拷贝再改：平台传进来的对象别处可能还持有，不就地改它。
    const 限额 = 结论.maxRetries === undefined ? {} : { maxRetries: 结论.maxRetries }
    return { 落盘数据: { ...记录, retryId: 结论.retryId, retry: 结论.retry, ...限额 }, 待记记录 }
}

/**
 * 把 data 收窄成记录。
 *
 * 包装后 `append` 的数据是 `unknown`（平台那侧的泛型约束在包装这一层已经丢了），所以在这里
 * 收窄一次；不是普通记录的形状就没有可归一的字段，原样放行。
 *
 * @param 数据 - `append` 收到的 data。
 */
function 读数据记录(数据: unknown): Record<string, unknown> | null {
    if (数据 === null || typeof 数据 !== 'object' || Array.isArray(数据)) return null
    return 数据 as Record<string, unknown>
}

/**
 * 打一行改写日志：会话 id / 回合 / 步 / provider / 原坐标 → 新坐标 / 是否抬了 maxRetries。
 *
 * @param 会话 - 事件落在哪个会话上。
 * @param 记录 - 被改写的原始 data。
 * @param 结论 - 账本给的归一结论。
 * @param logger - 日志出口。
 */
function 打改写日志(
    会话: 拦截会话,
    记录: Record<string, unknown>,
    结论: 归一结论,
    logger: Logger,
): void {
    // 账本只在 turn / step 都是数字时才给结论，这两个字段一定有值。
    const 回合号 = 记录.turn as number
    const 步号 = 记录.step as number
    const 抬了限额 = 结论.maxRetries !== undefined && 结论.maxRetries !== 记录.maxRetries
    const 限额说明 = 抬了限额 ? `，maxRetries ${String(记录.maxRetries)} → ${结论.maxRetries}` : ''

    logger.info?.(
        `[harden] 重试链改写：会话 ${读会话ID(会话) ?? '-'} turn=${回合号} step=${步号}` +
            ` provider=${String(记录.provider ?? '-')}` +
            ` 原 (${String(记录.retryId)}, ${String(记录.retry)}) → 新 (${结论.retryId}, ${结论.retry})` +
            限额说明,
    )
}

/**
 * 记一条拦截记录：先写内存账本，再写会话日志里的 `plugin:` 记录。
 *
 * 只在 `llm/retry` 被改写、且原 append 已经成功返回时调用（平台在 append 发布过程中写记录会抛重入）。
 *
 * @param 会话 - 事件落在哪个会话上。
 * @param 记录 - 本次改写的拦截记录（两处写的是同一条，四个字段全等）。
 * @param logger - 日志出口。
 */
function 记拦截记录(会话: 拦截会话, 记录: 拦截记录, logger: Logger): void {
    const 会话ID = 读会话ID(会话)
    if (会话ID === null) {
        // 记录按会话 id 归属，id 读不到就没法查——只留日志，不瞎猜一个 id。
        logger.warn?.('[harden] 重试链改写已发生，但会话 id 读不到，本次未记入拦截记录')
        return
    }

    let 记录组 = 记录存储组.get(会话ID)
    if (记录组 === undefined) {
        // 会话数上限：这里是新建槽位，超出就丢掉最早进入记录存储的那个会话。
        淘汰最早会话(记录存储组, 会话ID)

        记录组 = []
        记录存储组.set(会话ID, 记录组)
    }

    // 每会话上限：超出丢最旧。
    if (记录组.length >= 每会话记录上限) 记录组.shift()
    记录组.push(记录)

    // 日志里那份是持久源（内存账本随进程生灭），只读端点把两处并起来读。写失败已在 plugin-record 里静默
    // 降级（内存账本仍持有这条记录），这里不处理。
    writeRetryInterceptRecord(会话 as unknown as SessionLike, 记录, logger)
}

/**
 * 会话数上限：映射要**新增槽位**且装满时，丢掉**最早进入**的那个会话（记录存储与会话对象注册表同一口径，各自独立淘汰）。
 *
 * 已在映射里的 id 只是覆盖，不占新槽位 ⇒ **不淘汰任何人**。少了这道判断，覆盖时淘汰的是别人、`set` 又不会
 * 把 `size` 涨回来，映射会凭空缩一格——被误删的会话在端点上从此读不到它日志里的记录。
 *
 * @param 映射 - 记录存储组或会话对象组。
 * @param 会话ID - 即将写入的会话 id。
 */
function 淘汰最早会话<T>(映射: Map<string, T>, 会话ID: string): void {
    if (映射.has(会话ID)) return
    if (映射.size < 记录会话上限) return

    const 最早会话ID = 映射.keys().next().value
    if (最早会话ID !== undefined) 映射.delete(最早会话ID)
}

/** 从会话头读会话 id（平台公开读面：`session.header.id`）；读不到返回 null。 */
function 读会话ID(会话: 拦截会话): string | null {
    const 会话ID = 会话.header?.id
    return typeof 会话ID === 'string' && 会话ID !== '' ? 会话ID : null
}
