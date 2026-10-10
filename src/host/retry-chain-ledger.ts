/**
 * 重试链账本 —— 把平台对「重试链」的硬不变量收敛成一份可复用的状态机。
 *
 * **四条不变量**（读 `dsh-session-persistence-jsonl` 的 `Relationships.retry()` 与
 * `assertReleasedPayloadSemantics()` 的 `llm/retry` 分支核实）：
 *
 * 1. 链键 = (turn, step, provider, policyKey) 四元组；同链的 `llm/retry` 序号从 1 起逐条 +1；
 * 2. 整条链共用同一个 `retryId`，新链的 `retryId` 不得与本会话已有的任何链重复；
 * 3. `llm/retry-started` 按 (retryId, retry) 配对一条已排定的 `llm/retry`，且 turn/step 与它一致；
 * 4. `mode === 'normal'` 时 `maxRetries` 必填、为正整数，且 `retry <= maxRetries`
 *    （否则报 `llm/retry retry exceeds maxRetries`）；`mode === 'always'` 时必须**不带** `maxRetries`。
 *
 * **为什么单独一份。** 同一套不变量有两个消费者：会话修复器（对整份日志批量归一）与将来的写入
 * 拦截层（每条事件落盘前增量归一）。两份平行实现迟早漂移，所以判定只在这里写一份。
 *
 * 账本是**有状态**的：同一个实例必须按会话日志里的先后顺序喂事件，换一份日志就换一个实例。
 * 它不做任何 I/O、不打日志、不认识「会话」概念。
 *
 * @module dsh-harden/retry-chain-ledger
 */

/** 一条重试链归一后的目标坐标。 */
type 重试坐标 = { retryId: string; retry: number }

/**
 * 构造重试链键：turn + step + provider + policyKey 四元组；缺一返回 null。
 *
 * 用 JSON 数组串而不是分隔符拼接：provider 与 policyKey 都是自由文本，分隔符可能撞进内容里，
 * 撞了会把两条不同的链并成一条。
 *
 * @param data - 一条 `llm/retry` 事件的 data。
 */
export function 构造重试链键(data: Record<string, unknown>): string | null {
    const turn = data.turn
    const step = data.step
    const provider = data.provider
    const policyKey = data.policyKey
    if (typeof turn !== 'number' || typeof step !== 'number') return null
    if (typeof provider !== 'string' || typeof policyKey !== 'string') return null
    return JSON.stringify([turn, step, provider, policyKey])
}

/** 一次归一的结论。 */
export interface 归一结论 {
    /** 这条事件应改写成的 retryId。 */
    retryId: string
    /** 这条事件应改写成的序号。 */
    retry: number
    /** `mode === 'normal'` 时给出（= max(原 maxRetries, retry)）；`mode === 'always'` 时永远不给出。 */
    maxRetries?: number
    /** 与传入值相比是否有改动。 */
    有改动: boolean
}

/**
 * 喂入方式：账本按什么顺序收到某条链的事件——只影响「链首次出现时取什么序号」。
 *
 * - `'批量'`（默认）：整份日志从头喂（会话修复器）⇒ 链首见一律从 1 重排。
 * - `'增量'`：可能接在链中间喂（写入拦截器，装载时机不可控）⇒ 链首见按原坐标播种——平台在那条链上
 *   已经合法写下的事件不能被重排，重排出来的重复序号会让整份会话拒读。
 */
export type 喂入方式 = '批量' | '增量'

/**
 * 重试链账本：同一份判定既服务会话修复器（`'批量'` 喂整份日志），也服务写入拦截器（`'增量'` 逐条喂）。
 *
 * 喂事件的顺序必须与会话日志里的先后一致——序号重排与配对映射都按「上一条」推导。
 */
export class 重试链账本 {
    /** 每条链最近一次归一后的坐标：同链的下一条接着 +1。 */
    private readonly 链状态组 = new Map<string, 重试坐标>()

    /** 「原 (retryId|retry) → 目标坐标」：`llm/retry-started` 靠它找回自己该跟的那条。 */
    private readonly 配对映射组 = new Map<string, 重试坐标>()

    /** 最近一次排定的目标坐标：started 配不上队时的归并去处。 */
    private 最近调度坐标: 重试坐标 | undefined

    /** 本次喂入的方式；构造后不再变（语义见 `喂入方式`）。 */
    private readonly 喂入方式: 喂入方式

    constructor(喂入方式: 喂入方式 = '批量') {
        this.喂入方式 = 喂入方式
    }

    /**
     * 喂入一条 `llm/retry` 的 data。
     *
     * 链首次出现 → 目标坐标 = (原 retryId, 首见序号)；`'批量'` 下首见序号恒为 1，`'增量'` 下取原序号
     * （装载时机不可控，链首见的那条事件可能已经落在链中间，重排成 1 会与已落盘的那条撞序号）。
     * 链已存在 → 目标坐标 = (该链首条的 retryId, 该链上一条序号 + 1)。同时把「原 (retryId|retry) →
     * 目标坐标」登记进配对映射，并记住最近一次排定的目标坐标。
     *
     * `maxRetries` 只在 `mode === 'normal'` 且原值存在时给出，值是 max(原值, 目标序号)——序号重排
     * 变大后原值可能已经不够用，平台会报 `retry exceeds maxRetries`。其余情形一律不碰它。
     *
     * @param data - 一条 `llm/retry` 事件的 data。
     * @returns 归一结论；读不到链键或字段类型不符时返回 null（调用方放行不改）。
     */
    归一重试事件(data: Record<string, unknown>): 归一结论 | null {
        const 链键 = 构造重试链键(data)
        const 原编号 = 读文本字段(data, 'retryId')
        const 原序号 = 读数字字段(data, 'retry')
        if (链键 === null || 原编号 === null || 原序号 === null) return null

        const 链状态 = this.链状态组.get(链键)
        const 首见序号 = this.喂入方式 === '增量' ? 原序号 : 1
        const 目标编号 = 链状态 === undefined ? 原编号 : 链状态.retryId
        const 目标序号 = 链状态 === undefined ? 首见序号 : 链状态.retry + 1

        this.链状态组.set(链键, { retryId: 目标编号, retry: 目标序号 })
        this.配对映射组.set(`${原编号}|${原序号}`, { retryId: 目标编号, retry: 目标序号 })
        this.最近调度坐标 = { retryId: 目标编号, retry: 目标序号 }

        const 结论: 归一结论 = { retryId: 目标编号, retry: 目标序号, 有改动: false }
        const 原最大值 = 读数字字段(data, 'maxRetries')
        if (data.mode === 'normal' && 原最大值 !== null) 结论.maxRetries = Math.max(原最大值, 目标序号)
        结论.有改动 = 坐标已一致(data, 结论) === false
        return 结论
    }

    /**
     * 喂入一条 `llm/retry-started` 的 data。
     *
     * 先按自己报的 (原 retryId, 原 retry) 查配对映射；查不到就归并到最近一次排定的目标坐标——后者正是
     * 「配错队」的损坏形态（旧版插件每次重试换新 retryId 就是这么写坏的），归并到前一条 scheduled 是
     * 唯一能过平台校验的修法。真机写出的 started 不带 provider/policyKey，平台也只按 (retryId, retry)
     * 配对，所以这里不构造链键。
     *
     * @param data - 一条 `llm/retry-started` 事件的 data。
     * @returns 它应改写成的坐标；无法归属时返回 null（放行不改）。
     */
    归一启动事件(data: Record<string, unknown>): 归一结论 | null {
        const 原编号 = 读文本字段(data, 'retryId')
        const 原序号 = 读数字字段(data, 'retry')
        if (原编号 === null || 原序号 === null) return null

        let 目标坐标 = this.配对映射组.get(`${原编号}|${原序号}`)
        if (目标坐标 === undefined) 目标坐标 = this.最近调度坐标
        if (目标坐标 === undefined) return null

        const 结论: 归一结论 = { retryId: 目标坐标.retryId, retry: 目标坐标.retry, 有改动: false }
        结论.有改动 = 坐标已一致(data, 结论) === false
        return 结论
    }
}

/** 从 data 里读一个字符串字段；类型不符时返回 null。 */
function 读文本字段(data: Record<string, unknown>, 字段名: string): string | null {
    const value = data[字段名]
    return typeof value === 'string' ? value : null
}

/** 从 data 里读一个数字字段；类型不符时返回 null。 */
function 读数字字段(data: Record<string, unknown>, 字段名: string): number | null {
    const value = data[字段名]
    return typeof value === 'number' ? value : null
}

/** 结论与 data 里现存的字段逐字段相同即算「已一致」——调用方据此跳过无谓改写。 */
function 坐标已一致(data: Record<string, unknown>, 结论: 归一结论): boolean {
    if (data.retryId !== 结论.retryId || data.retry !== 结论.retry) return false
    if (结论.maxRetries !== undefined && data.maxRetries !== 结论.maxRetries) return false
    return true
}
