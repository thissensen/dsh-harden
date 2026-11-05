/**
 * 浏览器认证 cookie 的清理口径 —— 纯逻辑，零 IO、零副作用、不 import 任何服务。
 *
 * **为什么要有它。** 平台签发给浏览器的认证 cookie，名字是 `dsh-auth-` + 授权域的 sha256
 * base64url：HTTP 下授权域取 `url.host`（`host:port`），TLS 下取 `url.origin`。桌面端每次启动
 * 都换端口，于是每启动一次就多一条名字不同的 cookie，而 HTTP cookie 不按端口隔离，这些永不
 * 复用的死 cookie 全堆进同一个 `Cookie` 请求头，攒到约 68 条就撑爆 Node 默认 16 KB 的请求头上限
 * （431，页面打不开）。本模块只回答三件事：头里有哪些、当前页面那条叫什么、该删哪些以及删除
 * 响应头长什么样。端点、配置字段、界面都不在这里。
 *
 * @module dsh-harden/auth-cookie-sweep
 */

import { createHash } from 'node:crypto'

import { AUTH_COOKIE_SWEEP_THRESHOLD } from './shared-format.js'

/** 平台签发的认证 cookie 名字前缀（`dsh-client-connection` 的 `cookieName` 前半截）。 */
export const AUTH_COOKIE_PREFIX = 'dsh-auth-'

/**
 * 合法认证 cookie 名的形态：前缀 + 一串 URL 安全字符（base64url 的字母表）。
 *
 * **为什么必须卡字符集。** 名字会原样拼进 `Set-Cookie` 响应头，不卡就等于把请求头里的任意
 * 字符串反射进响应头（header injection 面）；顺带也保证只删平台形态的 cookie，不误伤别的。
 */
const 认证Cookie名模式 = /^dsh-auth-[A-Za-z0-9_-]+$/

/** 按名字去重，保留首次出现的顺序（一个名字只留一条，顺序不动）。 */
function 按名去重(名字组: readonly string[]): string[] {
    const 已见名字集 = new Set<string>()
    const 去重后名字组: string[] = []
    for (const 名字 of 名字组) {
        if (已见名字集.has(名字)) continue

        已见名字集.add(名字)
        去重后名字组.push(名字)
    }

    return 去重后名字组
}

/**
 * 从 `Cookie` 请求头枚举 `dsh-auth-*` 的名字（去重、保持出现顺序；缺失 / 畸形一律当空）。
 *
 * 按 `;` 切段、每段取第一个 `=` 之前的文本当名字。没有 `=` 的段跳过、名字不在
 * `dsh-auth-` 形态里的跳过、纯空白与空串跳过——畸形请求头只该让本函数返回空数组，
 * 绝不能把围栏或端点带崩。
 *
 * @param cookieHeader - 原始 `Cookie` 请求头（Node 里缺头时是 undefined）。
 * @returns 认证 cookie 名组。
 */
export function 获取认证Cookie名组(cookieHeader: string | undefined): string[] {
    if (cookieHeader === undefined) return []

    const 名字组: string[] = []
    for (const cookie段 of cookieHeader.split(';')) {
        const 等号位置 = cookie段.indexOf('=')
        if (等号位置 === -1) continue

        const 名字 = cookie段.slice(0, 等号位置).trim()
        if (认证Cookie名模式.test(名字) === false) continue

        名字组.push(名字)
    }

    return 按名去重(名字组)
}

/**
 * 算出「当前页面这一条」的候选名组：HTTP 形态（`url.host`）与 TLS 形态（`url.origin`）两个都保。
 *
 * **为什么两个都保。** Host 头本身不告诉服务端这个 listener 是不是 TLS：平台在 HTTP 下用
 * `url.host` 拼名字，在 TLS 下用 `url.origin`（`https://host:port`）拼名字。两个候选都留着，
 * 最坏只是多留一条根本不存在的名字（零成本）；漏掉一个就是**误删当前页面的 cookie**，用户当场
 * 被锁在门外。
 *
 * @param hostHeader - 原始 `Host` 请求头（缺头时是 undefined）。
 * @returns 候选名组；Host 头缺失或解析不出地址时为空数组。
 */
export function 获取当前认证Cookie名组(hostHeader: string | undefined): string[] {
    // undefined 插进模板串会拼出 'http://undefined' 这种能解析成功的假地址，得先挡掉。
    if (hostHeader === undefined) return []

    let 授权域组: string[]
    try {
        const 明文页面地址 = new URL(`http://${hostHeader}`)
        const 加密页面地址 = new URL(`https://${hostHeader}`)
        授权域组 = [明文页面地址.host, 加密页面地址.origin]

    } catch {
        return []
    }

    const 名字组: string[] = []
    for (const 授权域 of 授权域组) {
        const 摘要 = createHash('sha256').update(授权域).digest('base64url')
        名字组.push(`${AUTH_COOKIE_PREFIX}${摘要}`)
    }

    return 按名去重(名字组)
}

/**
 * 判定本次要删掉哪些认证 cookie。
 *
 * **两条不动手的纪律**：①条数**严格大于** `AUTH_COOKIE_SWEEP_THRESHOLD` 才扫——没越过门槛时
 * 删它没有收益，只会给每个响应多挂一堆 `Set-Cookie`；②算不出当前页面的名字（Host 头缺失或
 * 解析失败）就一律不删——宁可留着垃圾，也不能赌错当前那条。
 *
 * @param cookieHeader - 原始 `Cookie` 请求头。
 * @param hostHeader - 原始 `Host` 请求头。
 * @returns 待删的名字组（保持 `Cookie` 头里的出现顺序）；不该动手时为空数组。
 */
export function 判定待删认证Cookie(cookieHeader: string | undefined, hostHeader: string | undefined): string[] {
    const 候选名组 = 获取认证Cookie名组(cookieHeader)
    if (候选名组.length <= AUTH_COOKIE_SWEEP_THRESHOLD) return []

    const 保名单组 = 获取当前认证Cookie名组(hostHeader)
    if (保名单组.length === 0) return []

    return 候选名组.filter((名字) => 保名单组.includes(名字) === false)
}

/**
 * 把待删名组序列化成 `Set-Cookie` 的值组（名字进、响应头值出，附带属性逐字钉死）。
 *
 * **每个属性的依据。** `Path=/` 必须有：浏览器按 name + domain + path 三者匹配要删的那条，平台
 * 签发时就是 `Path=/`；不写 `Domain`：平台也没写，host-only 才命中原条（写了反而删不掉）；
 * `Max-Age=0` 是删除本身；`HttpOnly` 与 `SameSite=Strict` 照抄平台的签发形态，零风险且保持
 * 同形；**不写 `Secure`**：本层不知道 listener 是不是 TLS，而 `Secure` 也不参与删除匹配。
 *
 * @param 待删名组 - 要删掉的 cookie 名组。
 * @returns `Set-Cookie` 值组，顺序与入参一致。
 */
export function 造删除响应头组(待删名组: readonly string[]): string[] {
    return 待删名组.map((名字) => `${名字}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`)
}
