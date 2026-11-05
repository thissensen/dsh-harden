/**
 * host 与 client 共用的口径模块 —— 纯文本口径，不碰任何平台 / Node 能力。
 *
 * **为什么共享。** 兜底重试次数的区间与默认值、各字段长度上限、阈值文本解析、异常取文本、
 * 版本比较这些口径同时被三处读：host 端点校验、设置页的面板内联校验、测试。各写一份的下场
 * 是任一处改口径就分叉——面板放行、端点 400。所以口径只留这一份，两半边都 import 它：
 * host 侧按 NodeNext 写 `'./shared-format.js'`；client 侧用相对路径引用本文件——`src/client/*.ts` 是
 * `'../host/shared-format'`，`src/client/parts/*.ts` 是 `'../../host/shared-format'`（均不带扩展名，vite 打包）。
 *
 * **不许 import 任何 `node:` 模块、不许碰 `process` / `Buffer`。** vite 会把这个文件一起打进
 * 浏览器侧的 `client/index.js`，混进 node 内置模块会让设置页直接炸。
 *
 * @module dsh-harden/shared-format
 */

/** 兜底重试次数的合法区间（端点校验、面板内联校验、测试三处共用）。 */
export const RETRY_COUNT_MIN = 0
export const RETRY_COUNT_MAX = 99
/** 各配置字段的长度上限（端点校验用；面板与文档引用同一份）。 */
export const RETRY_TOKENS_MAX_LENGTH = 200
export const TOOL_FAILURE_PREFIXES_MAX_LENGTH = 2000
export const COMPACTION_INSTRUCTION_MAX_LENGTH = 10000
/** 兜底重试次数的权威默认值（host 的 schema 默认与面板回落值共用，别再各写一份）。 */
export const DEFAULT_NETWORK_RETRY_COUNT = 5
/**
 * 浏览器认证 cookie 的清理门槛：`Cookie` 头里 `dsh-auth-*` 的条数**严格大于**该值才动手。
 *
 * **为什么取 20。** 桌面端每次启动换端口，平台就多签发一条名字不同的认证 cookie；HTTP 下这些
 * cookie 不按端口隔离、全堆在同一个 `Cookie` 头里，约 68 条时撑爆 Node 默认 16 KB 的请求头上限、
 * 页面直接 431。20 条大约 4.5 KB，离上限还有三倍余量，动手够早；而清理请求本身也得靠页面先加载
 * 得起来——门槛定到 68 那种程度时，已经是连页面都打不开了。
 */
export const AUTH_COOKIE_SWEEP_THRESHOLD = 20

/** 阈值文本的两种写法：绝对 token 数，或占模型上下文窗口的比例。 */
export type 压缩阈值 = { 绝对token数: number } | { 窗口比例: number }

/**
 * 解析 `1M` / `200K` / `100000` 这类绝对阈值，或 `60%` 这类占模型上下文窗口的比例。
 *
 * **绝对写法**：`K` = 1000、`M` = 1000000，不区分大小写，允许首尾空白，必须是正整数。
 * **比例写法**：整数加 `%`，取值 1..100——`0%` 永远触发不了、`101%` 永远超过窗口，都不认；
 * 小数（`1.5%`）与空白、符号错位（`60 %`、`%60`）同样不认。
 *
 * 比例得乘上窗口才知道是多少 token，故这里只回比例、不换算：「窗口未知就跳过」和
 * 「绝对写法被窗口夹住」的裁决在 `compaction.ts`，那边才拿得到 `contextPressure`。
 *
 * @param text - 用户配置的阈值文本。
 * @returns 解析结果；两种写法都不成立时返回 null。
 */
export function 解析压缩阈值(text: string): 压缩阈值 | null {
    const trimmed = text.trim()

    const ratioMatch = /^(\d+)%$/.exec(trimmed)
    if (ratioMatch !== null) {
        const percent = Number.parseInt(ratioMatch[1], 10)
        if (percent < 1 || percent > 100) return null

        return { 窗口比例: percent / 100 }
    }

    const matched = /^(\d+)([KkMm]?)$/.exec(trimmed)
    if (matched === null) return null

    const base = Number.parseInt(matched[1], 10)
    if (base <= 0) return null

    const unit = matched[2].toUpperCase()
    if (unit === 'K') return { 绝对token数: base * 1000 }
    if (unit === 'M') return { 绝对token数: base * 1000000 }

    return { 绝对token数: base }
}

/**
 * 把异常转成可进响应体 / 日志的一行文本。
 *
 * 合并了原先 api.ts 的 `errText` 与 session-repair.ts 的 `错误文本` 两份实现：有 `message`
 * 用 `message`，否则退回原值（`{ message: null }` 也走 `String(原值)`，与旧的 `=== null` 特判等价）。
 *
 * @param error - 捕获到的异常，或任意原值。
 * @returns 一行文本。
 */
export function errText(error: unknown): string {
    if (error instanceof Error) return error.message
    const message = (error as { message?: unknown } | null | undefined)?.message
    if (typeof message !== 'string') return String(error)
    return message
}

/** 版本号拆出的主体段组与预发布段。 */
interface 版本拆分 {
    /** 第一个 `-` 之前的主体，按 `.` 切出的数字段组。 */
    readonly 主体段组: readonly number[]
    /** 第一个 `-` 之后的原文；没有预发布时为空串。 */
    readonly 预发布: string
}

/**
 * 把 `0.0.3-rc.1` 拆成主体段组 `[0, 0, 3]` 与预发布 `rc.1`。
 *
 * 主体任一段不是纯数字就返回 null：版本号半认得出不如不认（调用方按「宁可漏报」处理）。
 *
 * @param 版本 - 待拆的版本号文本。
 * @returns 拆分结果；主体含非数字段时返回 null。
 */
function 解析版本(版本: string): 版本拆分 | null {
    const 分隔位置 = 版本.indexOf('-')
    const 主体文本 = 分隔位置 === -1 ? 版本 : 版本.slice(0, 分隔位置)
    const 预发布 = 分隔位置 === -1 ? '' : 版本.slice(分隔位置 + 1)

    const 主体段组: number[] = []
    for (const 主体段文本 of 主体文本.split('.')) {
        if (/^\d+$/.test(主体段文本) === false) return null
        主体段组.push(Number.parseInt(主体段文本, 10))
    }

    return { 主体段组, 预发布 }
}

/**
 * 判断 npm 上的最新版是否比当前跑的这版新（设置页页头「检查更新」用）。
 *
 * **比较规则**：版本先拆成主体与预发布（第一个 `-` 之后的那段）。**单边带预发布时，带预发布的
 * 一方更旧**——`0.0.3-rc.1` 排在 `0.0.3` 之前，也不该提示用户升级到预览版；两边都没有预发布时
 * 逐段按数字比、段数不齐按 0 补齐（`0.0.2` 与 `0.0.2.0` 相等）；两边都有预发布时，主体相等
 * 之后按字符串比（`rc.1` < `rc.2`）。
 *
 * **宁可漏报**：任一段不是纯数字（`abc`、`v1`）一律返回 false。版本号解析错会让用户看到假
 * 结论，漏报只是不提示，代价小得多。
 *
 * @param 当前版本 - 本插件正在跑的版本（构建期注入的 `package.json` version）。
 * @param 最新版本 - npm 注册表查到的 version。
 * @returns 最新版更新时返回 true。
 */
export function 是否有更新版本(当前版本: string, 最新版本: string): boolean {
    const 当前版本拆分 = 解析版本(当前版本)
    const 最新版本拆分 = 解析版本(最新版本)
    if (当前版本拆分 === null || 最新版本拆分 === null) return false

    const 当前是预发布 = 当前版本拆分.预发布 !== ''
    const 最新是预发布 = 最新版本拆分.预发布 !== ''
    if (当前是预发布 !== 最新是预发布) return 当前是预发布

    const 主体段数 = Math.max(当前版本拆分.主体段组.length, 最新版本拆分.主体段组.length)
    for (let 序号 = 0; 序号 < 主体段数; 序号 += 1) {
        const 当前主体段 = 当前版本拆分.主体段组[序号] ?? 0
        const 最新主体段 = 最新版本拆分.主体段组[序号] ?? 0
        if (当前主体段 !== 最新主体段) return 最新主体段 > 当前主体段
    }

    if (当前是预发布 === false) return false

    return 最新版本拆分.预发布 > 当前版本拆分.预发布
}

/**
 * 主机名是否是回环地址：`localhost`、`[::1]` 或 `127.x.x.x`。
 *
 * **给两半共用**：host 侧判当前请求的 Host 头，client 侧判当前页面地址。判据从 `api.ts` 的
 * `isLoopbackHostname` 原样搬来，行为逐字等价——`[::1]` 之所以带方括号，是因为 `URL.hostname`
 * 对 IPv6 回的就是带方括号的形态（`http://[::1]:8899` 的 hostname 是 `[::1]`）；裸 `::1` 从来
 * 没进过这道判据，这里也就不认。
 *
 * @param hostname - `URL` 的 hostname（只有主机名，不带端口）。
 * @returns 是回环地址时返回 true。
 */
export function 是否回环主机名(hostname: string): boolean {
    if (hostname === 'localhost' || hostname === '[::1]') return true

    const 主机名段组 = hostname.split('.')
    const 是四段形态 = 主机名段组.length === 4 && 主机名段组[0] === '127'
    const 各段都是数字 = 主机名段组.every((主机名段) => /^\d{1,3}$/.test(主机名段) && Number(主机名段) <= 255)

    return 是四段形态 && 各段都是数字
}
