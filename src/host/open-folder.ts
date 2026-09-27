/**
 * dsh-harden —— 「打开文件夹到资源管理器」路由。
 *
 * 接管平台 open-in-app 的这一个能力。原链路最终调用
 * @deepseek-ai/dsh-native-command 的 runNativeCommand，那里把
 * windowsHide 写死成 true，explorer 窗口被创建却不可见
 * （2026-09-28 实测 A/B：false 可见、true 不可见）。
 *
 * **为什么自己 spawn。** 平台的两个路径打开函数都走 runNativeCommand，
 * 躲不开那个写死的开关；本模块用 node:child_process 的 spawn 自己起
 * explorer，显式传 windowsHide: false。
 *
 * **为什么只做 explorer。** 用户裁决：只保留「打开文件夹到资源管理器」，
 * 原插件的编辑器 / 终端 / Git 客户端目录一概不要。
 *
 * **为什么有 visible 参数。** 用户可以在设置页关掉「打开文件夹窗口可见」——
 * 关掉后 explorer 用 windowsHide: true 起，等同平台原版行为（窗口不弹出来）。
 * 路由一直挂着，每次请求现取开关（isVisible()），所以改设置不用重启插件。
 *
 * @module dsh-harden/host-open-folder
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { errText, json, readJsonBody, validateRequestOrigin } from './api.js'
import type { Ctx, Logger, WebServerService } from './types.js'

/** 前端请求的三个路由（与 @deepseek-ai/dsh-client-ui-open-in-app 的常量一致）。 */
const APPS_PATH = '/open-in-app/apps'
const ICON_PREFIX_PATH = '/open-in-app/icon'
const OPEN_PATH = '/open-in-app/open'

/** 本模块唯一支持的启动器 id（前端按它选标签与图标）。 */
const EXPLORER_ID = 'explorer'

/** open 路由的请求体上限；前端只发两个短字符串。 */
const OPEN_BODY_MAX_BYTES = 64 * 1024

/** explorer 把请求交给已在运行的桌面进程后退出 1 —— 那是成功，不是失败。 */
const EXPLORER_DELEGATED_EXIT = 1

/** 启动后观察窗：只用来接住立即失败，窗口还开着就算成功。 */
const LAUNCH_WATCH_MS = 1000

/** 抽 explorer 关联图标的脚本；位置参数依次是源 exe、输出 PNG。 */
const ICON_EXTRACT_SCRIPT = [
    'Add-Type -AssemblyName System.Drawing',
    '$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($args[0])',
    'if ($null -eq $icon) { exit 1 }',
    '$bitmap = $icon.ToBitmap()',
    '$bitmap.Save($args[1], [System.Drawing.Imaging.ImageFormat]::Png)',
    '',
].join('\n')

/** 图标抽取超时；PowerShell 冷启动偶尔慢，5 秒足够。 */
const ICON_EXTRACT_TIMEOUT_MS = 5000

/**
 * 用资源管理器打开一个目录。
 *
 * 用 spawn 而非平台的命令工具：那条路写死了 windowsHide: true，窗口不可见。
 * detached + stdio ignore 让 explorer 独立于本进程存活；1 秒观察窗只用来接住
 * 立即失败（spawn 报错、非 0/1 退出码），窗口还开着就当成功，不再等待。
 *
 * 目标编码说明：explorer 自己解析命令行，在逗号和等号处切分字段——原样传路径
 * 会在第一个分隔符处截断，且它不报错、只是打开别的东西，所以这两个字符要转义。
 * 非 ASCII 的百分号转义要还原：explorer 拒绝 URI 里的转义非 ASCII，却认得原字符
 * （逻辑与来源同 dsh-native-command 的 explorerTarget，2026-09-28 核实）。
 *
 * @param directory - 要打开的目录（绝对路径）。
 * @param visible - 窗口是否可见；false 时按平台原版行为传 windowsHide: true。
 * @throws 启动失败或 explorer 立即以异常码退出时抛出。
 */
function openInExplorer(directory: string, visible: boolean): Promise<void> {
    const target = pathToFileURL(directory, { windows: true })
        .href.replace(/(?:%[89A-F][0-9A-F])+/gi, (escaped) => decodeURIComponent(escaped))
        .replaceAll(',', '%2C')
        .replaceAll('=', '%3D')

    return new Promise<void>((resolve, reject) => {
        const child = spawn('explorer.exe', [target], {
            detached: true,
            stdio: 'ignore',
            windowsHide: !visible,
        })

        let settled = false
        const settle = (outcome: () => void) => {
            if (settled) return
            settled = true
            clearTimeout(watch)
            child.unref()
            outcome()
        }

        const watch = setTimeout(() => settle(resolve), LAUNCH_WATCH_MS)

        child.on('error', (error) => settle(() => reject(error)))
        child.on('exit', (code) => {
            if (code === 0 || code === EXPLORER_DELEGATED_EXIT) {
                settle(resolve)

            } else {
                settle(() => reject(Error('explorer 退出码 ' + String(code))))
            }
        })
    })
}

/** 进程内 explorer 图标缓存；null = 尚未抽取，非 null = 已定型（含 null 结果）。 */
let explorerIconPromise: Promise<Buffer | null> | null = null

/**
 * 从 %SystemRoot%\explorer.exe 抽关联图标为 PNG。
 *
 * 走 explorer.exe 而不是打包静态图：图标跟系统版本走，与平台原实现同源
 * （平台 catalog 里 explorer 的 iconPath 就是 "${SystemRoot}/explorer.exe"）。
 *
 * @returns PNG 字节；抽取失败返回 null。
 */
async function extractExplorerIcon(): Promise<Buffer | null> {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    const explorerExe = join(systemRoot, 'explorer.exe')

    let workDir: string | null = null
    try {
        workDir = await mkdtemp(join(tmpdir(), 'dsh-harden-icon-'))
        const scriptPath = join(workDir, 'extract.ps1')
        const pngPath = join(workDir, 'icon.png')
        await writeFile(scriptPath, ICON_EXTRACT_SCRIPT, 'utf8')

        const exitCode = await new Promise<number | null>((resolve) => {
            const child = spawn('powershell.exe', [
                '-NoProfile',
                '-ExecutionPolicy',
                'Bypass',
                '-File',
                scriptPath,
                explorerExe,
                pngPath,
            ], { windowsHide: true })

            let settled = false
            const settle = (result: number | null): void => {
                if (settled) return
                settled = true
                clearTimeout(watch)
                resolve(result)
            }

            const watch = setTimeout(() => {
                child.kill()
                settle(null)
            }, ICON_EXTRACT_TIMEOUT_MS)

            child.on('error', () => settle(null))
            child.on('exit', (result) => settle(result))
        })

        if (exitCode !== 0) return null

        return await readFile(pngPath)

    } catch {
        return null

    } finally {
        if (workDir !== null) {
            await rm(workDir, { recursive: true, force: true }).catch(() => {})
        }
    }
}

/** 回 405 并带上该路由支持的方法。 */
function sendMethodNotAllowed(res: ServerResponse, allow: string): void {
    res.statusCode = 405
    res.setHeader('allow', allow)
    res.end()
}

/**
 * GET /open-in-app/apps：只报 explorer。
 *
 * @param req - Node 请求对象。
 * @param res - Node 响应对象。
 */
function handleApps(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
        sendMethodNotAllowed(res, 'GET')
        return
    }

    json(res, 200, { apps: [EXPLORER_ID] })
}

/**
 * GET /open-in-app/icon/*：返回 explorer.exe 的关联图标（标准资源管理器图标）。
 *
 * 从 explorer.exe 抽，而不是打一张静态图：图标跟系统版本走。
 * 抽取失败或未知 id 一律 404，前端会退化成通用图标，不会崩。
 *
 * @param req - Node 请求对象。
 * @param res - Node 响应对象。
 */
async function handleIcon(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') {
        sendMethodNotAllowed(res, 'GET')
        return
    }

    const id = new URL(String(req.url), 'http://localhost')
        .pathname
        .slice(ICON_PREFIX_PATH.length)
        .replace(/^\//, '')

    if (id !== EXPLORER_ID) {
        json(res, 404, { ok: false, error: 'no icon for ' + id })
        return
    }

    // 进程内缓存：首次抽取（含失败结果）都保留，避免每次刷 UI 都起 PowerShell
    if (explorerIconPromise === null) explorerIconPromise = extractExplorerIcon()
    const bytes = await explorerIconPromise
    if (bytes === null) {
        json(res, 404, { ok: false, error: 'explorer icon unavailable' })
        return
    }

    res.statusCode = 200
    res.setHeader('content-type', 'image/png')
    res.setHeader('cache-control', 'public, max-age=3600')
    res.end(bytes)
}

/**
 * POST /open-in-app/open：用资源管理器打开一个目录。
 *
 * 校验顺序：媒体类型 → 请求体 → app id → 绝对路径 → 目录存在性。
 * 全部通过才 spawn；任一失败都给出前端能读的状态码与原因。
 *
 * @param req - Node 请求对象。
 * @param res - Node 响应对象。
 * @param visible - 资源管理器窗口是否可见（每次请求现取开关）。
 */
async function handleOpen(req: IncomingMessage, res: ServerResponse, visible: boolean): Promise<void> {
    if (req.method !== 'POST') {
        sendMethodNotAllowed(res, 'POST')
        return
    }

    const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
    if (contentType !== 'application/json') {
        json(res, 415, { ok: false, error: 'content-type must be application/json' })
        return
    }

    let body: unknown
    try {
        body = await readJsonBody(req, OPEN_BODY_MAX_BYTES)

    } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode ?? 400
        json(res, statusCode, { ok: false, error: errText(error) })
        return
    }

    if (body === null || typeof body !== 'object') {
        json(res, 400, { ok: false, error: 'body must be a JSON object' })
        return
    }

    const fields = body as Record<string, unknown>
    const app = fields.app
    const path = fields.path
    if (typeof app !== 'string' || typeof path !== 'string') {
        json(res, 400, { ok: false, error: 'body must carry string "app" and "path"' })
        return
    }

    if (app !== EXPLORER_ID) {
        json(res, 400, { ok: false, error: 'unknown app: ' + app })
        return
    }

    if (path === '' || !isAbsolute(path)) {
        json(res, 400, { ok: false, error: 'path must be an absolute directory path' })
        return
    }

    let isDirectory = false
    try {
        isDirectory = (await stat(path)).isDirectory()

    } catch {
        isDirectory = false
    }

    if (!isDirectory) {
        json(res, 404, { ok: false, error: 'directory does not exist: ' + path })
        return
    }

    try {
        await openInExplorer(path, visible)

    } catch (error) {
        json(res, 502, { ok: false, error: errText(error) })
        return
    }

    json(res, 200, { ok: true })
}

/**
 * 过读围栏；被拒时响应已写好。
 *
 * @param req - Node 请求对象。
 * @param res - Node 响应对象。
 * @param trustedHosts - 用户显式信任的 authority 清单。
 * @returns 通过时 false，被拒（响应已写）时 true。
 */
function rejectUntrusted(req: IncomingMessage, res: ServerResponse, trustedHosts: string[]): boolean {
    const rejection = validateRequestOrigin(req, trustedHosts)
    if (rejection === null) return false

    json(res, rejection.statusCode, { ok: false, error: rejection.error })
    return true
}

/**
 * 挂上本插件的「打开文件夹」三条路由。
 *
 * 需要 webServer。围栏复用设置页那套「回环或显式信任的 authority + 拒绝跨站」
 * 判据（api.ts 的 validateRequestOrigin），不依赖平台的 connection 服务。
 *
 * @param ctx - 插件所在的 context。
 * @param logger - 日志出口。
 * @param trustedHosts - 用户显式信任的 authority 清单（来自 webRuntime）。
 * @param isVisible - 现取「打开文件夹窗口可见」开关；每次请求调用一次。
 */
export function mountOpenFolderFix(
    ctx: Ctx,
    logger: Logger,
    trustedHosts: string[],
    isVisible: () => boolean,
): void {
    const webServer = ctx.webServer as WebServerService | undefined
    if (webServer === undefined) {
        logger.warn?.('[harden] webServer 不可用，打开文件夹路由未挂上')
        return
    }

    webServer.register({
        kind: 'exact',
        path: APPS_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
            if (rejectUntrusted(req, res, trustedHosts)) return
            handleApps(req, res)
        },
    })

    webServer.register({
        kind: 'prefix',
        path: ICON_PREFIX_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
            if (rejectUntrusted(req, res, trustedHosts)) return
            await handleIcon(req, res)
        },
    })

    webServer.register({
        kind: 'exact',
        path: OPEN_PATH,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
            if (rejectUntrusted(req, res, trustedHosts)) return
            await handleOpen(req, res, isVisible())
        },
    })

    logger.info?.('[harden] 打开文件夹路由已挂上 · /open-in-app/*')
}
