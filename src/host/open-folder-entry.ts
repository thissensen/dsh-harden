/**
 * dsh-harden —— 「打开文件夹」子入口（同包第二个 loader entry）。
 *
 * 本入口专责接管 `/open-in-app/*` 三条路由（实现在 open-folder.ts，原样复用）。
 * 与主入口 `dsh-harden`（`index.ts`）同包不同 row，装载/卸载由设置页卡片⑤
 * 经平台的 pluginManager 运行时独立控制——不必重启。
 *
 * **固定可见**：入口装载期间恒 `visible = true`（「窗口可见」从配置项降级成入口的
 * 存在性；关掉这个入口 = 让官方 host 行回来，而不是把窗口藏起来）。
 *
 * 关于 `name`：`cordis.patch.yml` 里那条 row 的 `id` 必须与它一致。
 *
 * @module dsh-harden/open-folder-entry
 */

import type { Ctx, Logger } from './types.js'
import { mountOpenFolderFix } from './open-folder.js'

/** `cordis.patch.yml` 里 row 的 id 必须与它一致。 */
export const name = 'harden-open-folder'

/**
 * 子入口。
 *
 * @param ctx - cordis 上下文。
 * @param config - 平台交进来的配置；本入口不用它（不导出 `Config`）。
 */
export function apply(ctx: Ctx, config: unknown): void {
    const logger: Logger = ctx.logger ?? console
    logger.info?.('[harden] 「打开文件夹」子入口已挂载')

    if (typeof ctx.inject !== 'function') {
        logger.warn?.('[harden] ctx.inject 不可用，打开文件夹路由未挂上')
        return
    }

    ctx.inject(['webServer', 'webRuntime'], (webCtx: Ctx) => {
        const webRuntime = (webCtx as unknown as { webRuntime?: { trustedHosts?: unknown } }).webRuntime
        const trustedHosts = Array.isArray(webRuntime?.trustedHosts) ? (webRuntime?.trustedHosts as string[]) : []

        mountOpenFolderFix(webCtx, logger, trustedHosts, () => true)
    })
}
