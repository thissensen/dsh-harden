/**
 * 页面加载时触发一次旧认证 cookie 清理（「旧认证 cookie 自动清理」的 client 半边）。
 *
 * 桌面端每次启动都换端口 ⇒ 平台每启动一次就多签发一条名字不同的认证 cookie；HTTP 下这些 cookie
 * 不按端口隔离，全堆进同一个 `Cookie` 请求头，约 68 条时撑爆请求头上限、页面直接打不开。
 * 清理动作全在 host 侧（门槛、保谁、删谁都在 `src/host/api.ts` 的写端点里），这里只负责按一次门铃。
 *
 * @module dsh-harden/client-auth-cookie-sweep
 */

import { 是否回环主机名 } from '../host/shared-format'
import { postJson } from './harden-api'

/** 清理端点（写围栏与门槛判定都在 host 侧）。 */
const SWEEP_ENDPOINT = '/api/dsh-harden/sweep-auth-cookies'

/**
 * 本模块实例是否已经触发过：同一次物化里被重复调用时只发一次请求。
 *
 * **刻意不做页面级持久标记**（`sessionStorage` 之类）：HMR 会重置模块、标记跟着归零，而端点
 * 本身幂等——重复触发无害；持久标记只会多一层「什么时候过期」的坑，属于过度设计。
 */
let 已触发 = false

/**
 * 页面加载时清一次本机攒下来的旧认证 cookie。
 *
 * 非回环地址直接返回、一个请求都不发：host 侧也会独立复核，这里只是省掉一次必然空转的请求。
 */
export async function 触发旧认证Cookie清理(): Promise<void> {
    if (已触发) return
    已触发 = true

    // 只在函数体内读 location：模块顶层读会让没有 location 的测试环境在 import 时就炸。
    if (是否回环主机名(location.hostname) === false) return

    try {
        await postJson(SWEEP_ENDPOINT, {})

    } catch {
        // 刻意吞：清理对用户静默（只在 host 日志留痕），且本函数由插件激活路径调用——抛出去会污染插件加载。
    }
}
