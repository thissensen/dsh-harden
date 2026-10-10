/**
 * host 半边的 HTTP 路由：设置页读配置、写配置的唯一通路。
 *
 * **为什么需要它。** 设置页跑在浏览器里，够不到 Node 进程里的平台 `settings` 服务；
 * 而「当前配置是什么」「把改动写回去」都只有 host 进程才干得了。DSH 的 `webServer`
 * 服务允许插件注册自己的前缀路由，这就是两者之间的桥。
 *
 * **围栏不假外求。** 路由挂在用户本机的 DSH 服务上，守的是「谁能让这台机器改配置」
 * 这条线。读端点过读围栏，写端点再过写围栏，两个端点从这一处取同一套判据，
 * 不各写一遍。
 *
 * @module dsh-harden/api
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { repairSessionFile, scanSessionFiles } from './session-repair.js'
import { 获取拦截记录 } from './retry-intercept.js'
import type { Ctx, HardenConfig, Logger, WebServerService } from './types.js'

/** 本插件的路由前缀。 */
const API_PREFIX = '/api/dsh-harden'

/**
 * 写操作必须携带的自定义请求头。
 *
 * 它把请求变成「非简单请求」，浏览器会先发预检；跨站页面做不出带自定义头的预检，
 * 所以伪造不出来。
 */
const CLIENT_MARKER_HEADER = 'x-dsh-harden'

/** 请求体上限，防止畸形请求把内存吃光。 */
const MAX_BODY_BYTES = 1 << 20

/** 会话仓库目录名（DSH_HOME 下面那一层）。 */
const SESSIONS_DIR_NAME = 'sessions'

/** 围栏的拒绝结果（通过时返回 null）。 */
export interface GuardReject {
    statusCode: number
    error: string
}

/**
 * 配置作用域：读当前配置、把改动写回平台 settings。
 *
 * 由 `index.ts` 在 `settings` 服务就绪后建出来；服务没就绪时不存在，
 * 写端点据此回 503 而不是假装写成功。
 */
export interface ConfigScope {
    get(): Required<HardenConfig>
    update(patch: object): void | Promise<void>
}

/** `mountApi` 的取值依赖。 */
export interface ApiDeps {
    /** 现问现取：设置服务的就绪时机与路由注册的先后顺序不作保证。 */
    getScope: () => ConfigScope | undefined
    /** 用户显式信任的 authority 清单（来自 `webRuntime`）；为空时只允许回环地址。 */
    trustedHosts?: string[]
}

/** 把 authority 字符串解析成 URL，失败返回 undefined。 */
function parseAuthority(authority: string): URL | undefined {
    try {
        return new URL(`http://${authority}`)

    } catch {
        return undefined
    }
}

/** 主机名是否是回环地址：`localhost`、`[::1]` 或 `127.x.x.x`。 */
function isLoopbackHostname(hostname: string): boolean {
    if (hostname === 'localhost' || hostname === '[::1]') return true

    const parts = hostname.split('.')
    const isIpv4Shape = parts.length === 4 && parts[0] === '127'
    const isNumericOnly = parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)

    return isIpv4Shape && isNumericOnly
}

/** host 是否命中用户显式信任的 authority 清单（带端口的按「主机:端口」比，不带端口的只比主机名）。 */
function isTrustedAuthority(hostUrl: URL, trustedHosts: string[]): boolean {
    return trustedHosts.some((entry) => {
        const entryUrl = parseAuthority(entry)
        if (entryUrl === undefined) return false
        if (entryUrl.port !== '') return entryUrl.host === hostUrl.host

        return entryUrl.hostname === hostUrl.hostname
    })
}

/** 围栏的统一拒绝结果。 */
function forbiddenHost(): GuardReject {
    return { statusCode: 403, error: 'api.forbiddenHost' }
}

/**
 * 读端点围栏：host 头必须是回环或显式信任的地址，跨站发起的请求一律拒绝。
 *
 * @param req - Node 的请求对象。
 * @param trustedHosts - 用户显式信任的 authority 清单。
 * @returns 通过时 null，否则给 `{ statusCode, error }`。
 */
export function validateRequestOrigin(req: IncomingMessage, trustedHosts: string[]): GuardReject | null {
    const host = typeof req.headers.host === 'string' ? req.headers.host : ''
    const hostUrl = parseAuthority(host)
    if (hostUrl === undefined) return forbiddenHost()

    const reachable = isLoopbackHostname(hostUrl.hostname) || isTrustedAuthority(hostUrl, trustedHosts)
    if (!reachable) return forbiddenHost()

    // 跨站发起的请求一律拒绝，哪怕 host 头本身看着正常。
    if (req.headers['sec-fetch-site'] === 'cross-site') return forbiddenHost()

    const origin = req.headers.origin
    if (typeof origin !== 'string') return null

    // origin 解析失败按不可信处理——拿不准就拒绝。
    try {
        if (new URL(origin).host !== hostUrl.host) return forbiddenHost()

    } catch {
        return forbiddenHost()
    }

    return null
}

/**
 * 写端点围栏：在读围栏之上，再要求自定义头与 JSON content-type。
 *
 * @param req - Node 的请求对象。
 * @param trustedHosts - 用户显式信任的 authority 清单。
 * @returns 通过时 null，否则给 `{ statusCode, error }`。
 */
function validateMutationRequest(req: IncomingMessage, trustedHosts: string[]): GuardReject | null {
    const originError = validateRequestOrigin(req, trustedHosts)
    if (originError !== null) return originError

    if (req.headers[CLIENT_MARKER_HEADER] !== '1') {
        return { statusCode: 403, error: 'api.forbiddenMutation' }
    }

    const contentType = String(req.headers['content-type'] ?? '')
        .split(';', 1)[0]
        .trim()
        .toLowerCase()

    if (contentType !== 'application/json') {
        return { statusCode: 415, error: 'api.contentTypeInvalid' }
    }

    return null
}

/** 浏览器可能在响应写回前就断开，没有监听者时 res 的 'error' 会变成未捕获异常。 */
function ignoreClientAbort(): void {}

/**
 * 回一个 JSON 响应。
 *
 * @param res - Node 的响应对象。
 * @param statusCode - HTTP 状态码。
 * @param payload - 可 JSON 序列化的响应体。
 */
export function json(res: ServerResponse, statusCode: number, payload: unknown): void {
    if (res.writableEnded || res.destroyed) return

    res.once('error', ignoreClientAbort)

    const body = JSON.stringify(payload)
    try {
        res.writeHead(statusCode, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(body),
        })
        res.end(body)

    } catch {
        // 连接已断，写不回去是常态，不该把它升级成未捕获异常。
    }
}

/**
 * 读请求体并解析成 JSON 对象。
 *
 * Node 的请求是事件流，这里是唯一一处回调适配；上层拿到的是 Promise。
 * 畸形 JSON（400）与超大 body（413）以「异常带 statusCode」的形式抛出，
 * 由调用方就地接住——HTTP handler 是这条链的最外层边界。
 *
 * @param req - Node 的请求对象。
 */
export function readJsonBody(req: IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
        let size = 0
        let settled = false
        const chunks: Buffer[] = []

        const fail = (error: unknown) => {
            if (settled) return
            settled = true
            reject(error)
        }

        req.on('data', (chunk: Buffer) => {
            if (settled) return

            size += chunk.length
            if (size > maxBytes) {
                fail(Object.assign(Error('body too large'), { statusCode: 413 }))
                req.resume()
                return
            }

            chunks.push(chunk)
        })

        req.on('end', () => {
            if (settled) return

            try {
                const raw = Buffer.concat(chunks).toString('utf8')
                settled = true
                resolve(raw === '' ? {} : JSON.parse(raw))

            } catch (error) {
                fail(Object.assign(Error(`invalid JSON body: ${(error as Error).message}`), { statusCode: 400 }))
            }
        })

        req.on('error', fail)
    })
}

/** 把异常转成可进响应体的一行（有 message 用 message，否则退回原值）。 */
export function errText(error: unknown): string {
    const message = (error as { message?: unknown } | null | undefined)?.message
    return message === undefined || message === null ? String(error) : String(message)
}

/**
 * 把要拼进暗号参数里的文本中的竖线换成斜杠。
 *
 * 暗号用 `|` 分隔字段，参数自身再带竖线会把字段切错位，界面侧只能显示前半截。
 */
function escapeArg(text: string): string {
    return text.replace(/\|/g, '/')
}

/**
 * 把阈值文本解析成正整数：`K` 等于 1000、`M` 等于 1000000，不区分大小写，允许首尾空白。
 *
 * 口径与看护侧（compaction.ts 的 parseTokenCount）一致；这里不去 import 那份实现，
 * 两边各自守住同一套规则，client 发来的值先在这里挡下非法输入。
 *
 * @param text - 待解析的阈值文本。
 * @returns 解析出的正整数；格式不对或不是正数时返回 null。
 */
function parseThresholdText(text: string): number | null {
    const trimmed = text.trim()
    const matched = /^(\d+)([KkMm]?)$/.exec(trimmed)
    if (matched === null) return null

    const base = Number.parseInt(matched[1], 10)
    if (base <= 0) return null

    const unit = matched[2].toUpperCase()
    if (unit === 'K') return base * 1000
    if (unit === 'M') return base * 1000000

    return base
}

/**
 * `GET /config`：把当前配置交给设置页。
 *
 * 设置服务未就绪时 `config` 为 null——那是「还没准备好」，不是「读失败」，
 * 面板据此显示可重试的失败卡片。
 *
 * @param res - Node 的响应对象。
 * @param deps - 取值依赖。
 */
function handleGetConfig(res: ServerResponse, deps: ApiDeps): void {
    json(res, 200, { ok: true, config: deps.getScope()?.get() ?? null })
}

/**
 * `GET /retry-intercepts?session=<会话ID>`：把该会话上被归一过的重试链交给设置页。
 *
 * **为什么缺失与未知都回空数组。** 「这个会话没发生过修正」与「这个 id 谁都不认识」对界面是
 * 同一件事（没什么可展示的），不为它单开错误分支，也就不需要新的 locale 词条。
 *
 * @param url - 已解析的请求 URL（会话 id 走 query）。
 * @param res - Node 的响应对象。
 */
function handleGetRetryIntercepts(url: URL, res: ServerResponse): void {
    const 会话ID = url.searchParams.get('session') ?? ''

    json(res, 200, { ok: true, 记录组: 获取拦截记录(会话ID) })
}

/**
 * `POST /config`：把设置页发来的配置写回平台 settings。
 *
 * 字段只有一个，但类型校验照做：手改请求、老客户端都可能发来别的东西，
 * 与其让平台 schema 抛错冒到 handler 外，不如在这里回 400。
 *
 * @param req - Node 的请求对象。
 * @param res - Node 的响应对象。
 * @param deps - 取值依赖。
 */
async function handleUpdateConfig(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<void> {
    const requestError = validateMutationRequest(req, deps.trustedHosts ?? [])
    if (requestError !== null) {
        json(res, requestError.statusCode, { ok: false, error: requestError.error })
        return
    }

    const scope = deps.getScope()
    if (scope === undefined) {
        json(res, 503, { ok: false, error: 'api.settingsNotReady' })
        return
    }

    let body: Record<string, unknown> | undefined
    try {
        body = await readJsonBody(req) as typeof body

    } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode ?? 400
        json(res, statusCode, { ok: false, error: `api.bodyReadFailed|${escapeArg(errText(error))}` })
        return
    }

    const toolFailureGuard = body?.toolFailureGuard
    if (typeof toolFailureGuard !== 'boolean') {
        json(res, 400, { ok: false, error: 'api.toolFailureGuardNotBoolean' })
        return
    }

    const emptyOutputGuard = body?.emptyOutputGuard
    if (typeof emptyOutputGuard !== 'boolean') {
        json(res, 400, { ok: false, error: 'api.emptyOutputGuardNotBoolean' })
        return
    }

    const networkRetryCount = body?.networkRetryCount
    if (typeof networkRetryCount !== 'number' || Number.isInteger(networkRetryCount) === false || networkRetryCount < 0 || networkRetryCount > 99) {
        json(res, 400, { ok: false, error: 'api.networkRetryCountInvalid' })
        return
    }

    const networkRetryTokens = body?.networkRetryTokens
    if (typeof networkRetryTokens !== 'string' || networkRetryTokens.length > 200) {
        json(res, 400, { ok: false, error: 'api.networkRetryTokensInvalid' })
        return
    }

    const toolFailurePrefixes = body?.toolFailurePrefixes
    if (typeof toolFailurePrefixes !== 'string' || toolFailurePrefixes.length > 2000) {
        json(res, 400, { ok: false, error: 'api.toolFailurePrefixesInvalid' })
        return
    }

    const backgroundJobTool = body?.backgroundJobTool
    if (typeof backgroundJobTool !== 'boolean') {
        json(res, 400, { ok: false, error: 'api.backgroundJobToolNotBoolean' })
        return
    }

    const subagentAggregation = body?.subagentAggregation
    if (typeof subagentAggregation !== 'boolean') {
        json(res, 400, { ok: false, error: 'api.subagentAggregationNotBoolean' })
        return
    }

    const contextCompaction = body?.contextCompaction
    if (typeof contextCompaction !== 'boolean') {
        json(res, 400, { ok: false, error: 'api.contextCompactionNotBoolean' })
        return
    }

    const compactionScope = body?.compactionScope
    const isValidCompactionScope =
        compactionScope === 'all' || compactionScope === 'main' || compactionScope === 'subagent'
    if (isValidCompactionScope === false) {
        json(res, 400, { ok: false, error: 'api.compactionScopeInvalid' })
        return
    }

    const compactionThreshold = body?.compactionThreshold
    if (typeof compactionThreshold !== 'string' || parseThresholdText(compactionThreshold) === null) {
        json(res, 400, { ok: false, error: 'api.compactionThresholdInvalid' })
        return
    }

    const compactionInstruction = body?.compactionInstruction
    if (typeof compactionInstruction !== 'string' || compactionInstruction.length > 10000) {
        json(res, 400, { ok: false, error: 'api.compactionInstructionInvalid' })
        return
    }

    try {
        await scope.update({
            toolFailureGuard,
            toolFailurePrefixes,
            emptyOutputGuard,
            networkRetryCount,
            networkRetryTokens,
            backgroundJobTool,
            subagentAggregation,
            contextCompaction,
            compactionScope,
            compactionThreshold,
            compactionInstruction,
        })

    } catch (error) {
        json(res, 400, { ok: false, error: `api.writeFailed|${escapeArg(errText(error))}` })
        return
    }

    json(res, 200, { ok: true })
}

/** 会话修复明细组里的一行。 */
interface SessionRepairDetail {
    filePath: string
    status: string
    reason: string
}

/**
 * `POST /repair-sessions`：扫描并修复全部会话文件。
 *
 * **为什么顺序 await。** 每个文件都要读、改、写临时文件再 rename；并发处理会同时占住
 * 大量文件句柄，而会话目录里几百个文件很常见，逐个走更稳。
 *
 * **为什么活跃文件不会被硬改。** 平台正占用中的会话文件 readFile / rename 会失败，
 * repairSessionFile 如实报 read-failed——这里只统计，不重试、不绕路。
 *
 * @param req - Node 的请求对象。
 * @param res - Node 的响应对象。
 * @param deps - 取值依赖。
 */
async function handleRepairSessions(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<void> {
    const requestError = validateMutationRequest(req, deps.trustedHosts ?? [])
    if (requestError !== null) {
        json(res, requestError.statusCode, { ok: false, error: requestError.error })
        return
    }

    try {
        await readJsonBody(req)

    } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode ?? 400
        json(res, statusCode, { ok: false, error: `api.bodyReadFailed|${escapeArg(errText(error))}` })
        return
    }

    const 会话根目录 = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), SESSIONS_DIR_NAME)

    let 文件组: string[]
    try {
        文件组 = await scanSessionFiles(会话根目录)

    } catch (error) {
        json(res, 400, { ok: false, error: `api.repairScanFailed|${escapeArg(errText(error))}` })
        return
    }

    const 明细组: SessionRepairDetail[] = []
    let 通过数 = 0
    let 已修复数 = 0
    let 修不了数 = 0
    let 读取失败数 = 0

    for (const 文件路径 of 文件组) {
        const 结果 = await repairSessionFile(文件路径)
        明细组.push({ filePath: 结果.filePath, status: 结果.status, reason: 结果.reason })

        if (结果.status === 'intact') {
            通过数 += 1

        } else if (结果.status === 'repaired') {
            已修复数 += 1

        } else if (结果.status === 'unrepairable') {
            修不了数 += 1

        } else {
            读取失败数 += 1
        }
    }

    json(res, 200, {
        ok: true,
        总数: 文件组.length,
        通过数,
        已修复数,
        修不了数,
        读取失败数,
        明细组,
    })
}

/**
 * 挂上本插件的 HTTP 路由。
 *
 * 需要 `webServer`（注册路由）。设置服务缺席时读端点回 `config: null`、写端点回 503，
 * 面板据此如实显示，而不是假装能用。
 *
 * @param ctx - 插件所在的 context。
 * @param logger - 日志出口。
 * @param deps - `{ getScope, trustedHosts }`。
 */
export function mountApi(ctx: Ctx, logger: Logger, deps: ApiDeps): void {
    const webServer = ctx.webServer as WebServerService | undefined
    if (webServer === undefined) {
        logger.warn?.('[harden] webServer 不可用，设置页的配置通路未挂上')
        return
    }

    const trustedHosts = deps.trustedHosts ?? []

    webServer.register({
        kind: 'prefix',
        path: API_PREFIX,

        handler: async (req: IncomingMessage, res: ServerResponse) => {
            const url = new URL(req.url ?? '/', 'http://localhost')
            const path = url.pathname.replace(/\/+$/, '')

            const hostError = validateRequestOrigin(req, trustedHosts)
            if (hostError !== null) {
                json(res, hostError.statusCode, { ok: false, error: hostError.error })
                return
            }

            if (req.method === 'GET' && path === `${API_PREFIX}/config`) {
                handleGetConfig(res, deps)
                return
            }

            if (req.method === 'GET' && path === `${API_PREFIX}/retry-intercepts`) {
                // GET 走读围栏（上面那道），不需要写端点的自定义头与 content-type。
                handleGetRetryIntercepts(url, res)
                return
            }

            if (req.method === 'POST' && path === `${API_PREFIX}/config`) {
                await handleUpdateConfig(req, res, deps)
                return
            }

            if (req.method === 'POST' && path === `${API_PREFIX}/repair-sessions`) {
                await handleRepairSessions(req, res, deps)
                return
            }

            json(res, 404, { ok: false, error: `api.unknownAction|${req.method} ${escapeArg(path)}` })
        },
    })

    logger.info?.(`[harden] 设置页 HTTP 路由已挂上 · ${API_PREFIX}`)
}
