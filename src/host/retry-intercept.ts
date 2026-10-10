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
import type { Ctx, Logger } from './types.js'

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
 * 取某个会话的拦截记录（只读端点用）。
 *
 * @param 会话ID - 会话 id。
 * @returns 该会话的拦截记录组；未知 id 返回空数组。返回的是副本，调用方改不动内部状态。
 */
export function 获取拦截记录(会话ID: string): 拦截记录[] {
    const 记录组 = 记录存储组.get(会话ID)
    if (记录组 === undefined) return []
    return 记录组.map((记录) => ({ ...记录 }))
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
 * 包住会话的 `append`：重试事件先喂账本，按结论改写或原样透传，其余类型零开销直通。
 *
 * @param 会话 - 待安装拦截器的会话。
 * @param logger - 日志出口。
 */
function 安装拦截器(会话: 拦截会话, logger: Logger): void {
    const 原始append = 会话.append.bind(会话)
    // 账本有状态，必须按会话日志的先后顺序喂事件 ⇒ 一个会话一个实例。
    // 喂入方式取「增量」：拦截器可能装在某条链已经写了第一条之后（热重载夹在链中间），账本对这条链是瞎的
    // ——链首见按原坐标播种、不重排，那条平台合法写下的事件原样放行。
    const 账本 = new 重试链账本('增量')

    会话.append = (类型: string, 数据: unknown, ...选项组: unknown[]): unknown => {
        // 只认两条重试事件；其余类型直接透传（零额外开销、零行为变化）。
        if (类型 !== 'llm/retry' && 类型 !== 'llm/retry-started') return 原始append(类型, 数据, ...选项组)

        let 落盘数据 = 数据
        try {
            落盘数据 = 归一写入(类型, 数据, 账本, 会话, logger)

        } catch (error) {
            // 看护层的异常绝不能影响正常写入：出错就用原始 data 放行。真实平台上这种 shape
            // 本来也过不了平台自己那层校验——这里不替平台兜底，只是不额外添乱。
            logger.warn?.('[harden] 重试链归一异常，已按原始数据写入', error)
            落盘数据 = 数据
        }

        return 原始append(类型, 落盘数据, ...选项组)
    }
}

/**
 * 喂账本、按结论决定要不要改写。
 *
 * @param 类型 - 事件类型（只会有 `llm/retry` 与 `llm/retry-started`）。
 * @param 数据 - 平台传进来的 data。
 * @param 账本 - 本会话的重试链账本。
 * @param 会话 - 事件落在哪个会话上（取会话 id 记拦截记录）。
 * @param logger - 日志出口。
 * @returns 该写进日志的 data：无需改动时是**原对象**（不做无谓拷贝），需要改动时是一份浅拷贝。
 */
function 归一写入(
    类型: string,
    数据: unknown,
    账本: 重试链账本,
    会话: 拦截会话,
    logger: Logger,
): unknown {
    const 记录 = 读数据记录(数据)
    if (记录 === null) return 数据

    const 结论 = 类型 === 'llm/retry' ? 账本.归一重试事件(记录) : 账本.归一启动事件(记录)
    if (结论 === null || 结论.有改动 === false) return 数据

    打改写日志(会话, 记录, 结论, logger)

    // 只在 `llm/retry` 被改写时记一条：`llm/retry-started` 的同步改写是同一处修正的另一半，
    // 界面提示里的「N 处」数的是链上的修正，不是事件条数。
    if (类型 === 'llm/retry') 记拦截记录(会话, 记录, 结论, logger)

    // 浅拷贝再改：平台传进来的对象别处可能还持有，不就地改它。
    const 限额 = 结论.maxRetries === undefined ? {} : { maxRetries: 结论.maxRetries }
    return { ...记录, retryId: 结论.retryId, retry: 结论.retry, ...限额 }
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
 * 记一条拦截记录（只在 `llm/retry` 被改写时调用）。
 *
 * @param 会话 - 事件落在哪个会话上。
 * @param 记录 - 被改写的原始 data。
 * @param 结论 - 账本给的归一结论。
 * @param logger - 日志出口。
 */
function 记拦截记录(
    会话: 拦截会话,
    记录: Record<string, unknown>,
    结论: 归一结论,
    logger: Logger,
): void {
    const 会话ID = 读会话ID(会话)
    if (会话ID === null) {
        // 记录按会话 id 归属，id 读不到就没法查——只留日志，不瞎猜一个 id。
        logger.warn?.('[harden] 重试链改写已发生，但会话 id 读不到，本次未记入拦截记录')
        return
    }

    let 记录组 = 记录存储组.get(会话ID)
    if (记录组 === undefined) {
        // 会话数上限：超出就丢掉最早进入记录存储的那个会话。
        if (记录存储组.size >= 记录会话上限) {
            const 最早会话ID = 记录存储组.keys().next().value
            if (最早会话ID !== undefined) 记录存储组.delete(最早会话ID)
        }

        记录组 = []
        记录存储组.set(会话ID, 记录组)
    }

    // 每会话上限：超出丢最旧。
    if (记录组.length >= 每会话记录上限) 记录组.shift()

    // 回合 / 步 也由账本保证是数字（链键构造不出来就没有结论）。
    记录组.push({
        回合: 记录.turn as number,
        步: 记录.step as number,
        序号: 结论.retry,
        时间戳: Date.now(),
    })
}

/** 从会话头读会话 id（平台公开读面：`session.header.id`）；读不到返回 null。 */
function 读会话ID(会话: 拦截会话): string | null {
    const 会话ID = 会话.header?.id
    return typeof 会话ID === 'string' && 会话ID !== '' ? 会话ID : null
}
