/**
 * 「重试链已修正」提示行的判据：纯逻辑，不 import react / @deepseek-ai/* / 任何有副作用的模块。
 *
 * **判据 = 按回合号数记录条数。** host 侧的重试链写入拦截器（`src/host/retry-intercept.ts`）
 * 每次归一一条 `llm/retry` 就记一条「哪个回合的哪一步被改写成了什么序号」，只存在内存里；
 * 设置页经 `GET /api/dsh-harden/retry-intercepts?session=<会话ID>` 原样取到这份记录组
 * （接口元素 `{ 回合, 步, 序号, 时间戳 }`），本函数负责回答「这个回合该显示几处修正」。
 *
 * **为什么用回合号而不用步号。** 提示行落在回合尾部插槽，平台只给到当前位置对象与会话序号；
 * 修正发生在回合进行中、会话还在往前走，按回合聚合才对得上「本回合 N 处」这句文案。
 *
 * **远端数据当不可信输入。** 记录组来自 HTTP 响应体，形状由 host 契约约定、运行时不保证：
 * 缺字段、字段类型不对（老客户端 / 手改请求 / 将来 host 改结构）时**跳过那一条**，
 * 不抛异常、不计入——界面在数据不合预期时退回「不显示」，不打断会话渲染。
 *
 * **已知边界。** 记录只在 host 进程内存里，进程重启后记录组为空（界面自然退回不显示）。
 *
 * @module dsh-harden/client-retry-intercept-match
 */

/** 拦截记录组里的一条（host 侧契约的客户端镜像，只声明本判据用到的字段）。 */
export interface 拦截记录 {
    /** 回合号（修正发生在这个回合）。 */
    回合: number
}

/**
 * 从平台插槽给的回合位置里取回合号。
 *
 * **平台给的不是数字，是对象。** `conversation.chat.turnTail` 的 owner props 声明为
 * `{ turn: TurnLocation, seq, openFile }`——`turn` 是 `TurnLocation`
 * （`{ turn, start, end, status, steps, data }`），**回合号在 `位置.turn`**
 * （`dsh-client-ui-chat` 的 `contract/slots.d.ts` 与 `dsh-client-ui-conversation` 的
 * `contract/conversation.d.ts`，对照 client bundle 调用点静态核实）。把整个对象当数字比对
 * 永远不相等 ⇒ 提示行静默不显示，故取值单独收在这里。
 *
 * **拿不到就当本回合没有可显示的东西。** 形状不符（位置不是回合/步时平台不传这一格、或平台
 * 升版改声明）时不抛错、不猜，返回 `null` 让界面静默不显示——本行是锦上添花，不该打断会话渲染。
 *
 * @param 位置 - 插槽 props 里的 `turn`，形状未知。
 * @returns 回合号；不是有限数时 `null`。
 */
export function 取回合号(位置: unknown): number | null {
    if (位置 === null || typeof 位置 !== 'object') return null

    const 位置回合号 = (位置 as { turn?: unknown }).turn
    if (typeof 位置回合号 !== 'number' || Number.isFinite(位置回合号) === false) return null

    return 位置回合号
}

/**
 * 把 HTTP 响应体收窄成记录组。
 *
 * 不是数组就没有可数的记录（形状不符 ⇒ 空数组 ⇒ 界面不显示）；数组里字段不符的条目
 * 由 `统计回合修正数` 逐条跳过。
 *
 * @param raw - `GET /retry-intercepts` 响应体里的 `记录组` 字段，形状未知。
 * @returns 记录组；形状不符时是空数组。
 */
export function 读记录组(raw: unknown): 拦截记录[] {
    return Array.isArray(raw) ? (raw as 拦截记录[]) : []
}

/**
 * 数这一回合有几处修正。
 *
 * @param 记录组 - 该会话的拦截记录组（可含其它回合的记录）。
 * @param 回合号 - 当前要显示的回合号。
 * @returns 命中回合号且字段类型正确的记录条数。
 */
export function 统计回合修正数(记录组: readonly 拦截记录[], 回合号: number): number {
    let 修正处数 = 0

    for (const 记录 of 记录组) {
        // 记录组来自 HTTP 响应体，形状未知：缺字段、类型不对的条目直接跳过
        // （见文件头「远端数据当不可信输入」）。
        if (记录 === null || typeof 记录 !== 'object') continue

        const 记录回合号 = (记录 as { 回合?: unknown }).回合
        if (typeof 记录回合号 !== 'number' || Number.isFinite(记录回合号) === false) continue
        if (记录回合号 !== 回合号) continue

        修正处数 += 1
    }

    return 修正处数
}
