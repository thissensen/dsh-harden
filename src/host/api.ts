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

import { repairSessionFile, scanSessionFiles, type RepairOutcome } from './session-repair.js'
import { 获取全部拦截记录 } from './retry-intercept.js'
import {
    COMPACTION_INSTRUCTION_MAX_LENGTH,
    RETRY_COUNT_MAX,
    RETRY_COUNT_MIN,
    RETRY_TOKENS_MAX_LENGTH,
    TOOL_FAILURE_PREFIXES_MAX_LENGTH,
    errText,
    解析压缩阈值,
    是否回环主机名,
} from './shared-format.js'
import { 判定待删认证Cookie, 造删除响应头组 } from './auth-cookie-sweep.js'
import { readConfig } from './config.js'
import type { Ctx, HardenConfig, Logger, WebServerService, 会话查询面 } from './types.js'

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

/** npm 上本包的最新版本（dist-tag latest）。 */
const VERSION_ENDPOINT_URL = 'https://registry.npmjs.org/dsh-harden/latest'
/** registry 卡住时不能让设置页一直转。 */
const VERSION_TIMEOUT_MS = 5000
/** 同一份结果 5 分钟内复用：用户连点按钮不该反复打 registry。 */
const VERSION_CACHE_MS = 5 * 60 * 1000

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
    /** 用户显式信任的 authority 清单（`readTrustedHosts` 从 `webStartup` 取）；为空时只允许回环地址。 */
    trustedHosts?: string[]
    /** 查 npm 上本包的最新版本；缺省真查 registry，测试注入假实现而不发网络请求。 */
    取最新版本?: () => Promise<string>
    /**
     * 现问现取：平台的会话查询服务，读一份「没打开过」的会话日志里的记录用。
     *
     * **为什么不进 inject 列表**：这个服务由平台内的另一个插件行提供、精简 profile 可能没挂它，把服务名
     * 写进 `inject` 会让整条配置通路静默挂不上（`05-坑册.md` 坑 37）；`ctx.get` 缺服务时如实回
     * `undefined`，端点退回只有内存账本与会话对象两条源。
     */
    取会话查询: () => 会话查询面 | undefined
}

/**
 * 取用户显式信任的 authority 清单。
 *
 * **唯一来源是 `webStartup`。** 平台把 `--trusted-host` 传进来的显式信任清单挂在这个服务上；
 * 服务缺席或字段形状不可用就回空清单——围栏随之退化成只允许回环地址，是安全默认。
 *
 * **为什么必须用 `ctx.get`。** 把服务名写进 `inject` 列表会让「服务不存在」变成「回调永不
 * 执行」；属性访问未声明的服务会抛。`ctx.get` 不需要声明，缺服务时如实返回 undefined。
 *
 * @param ctx - 插件所在的 context（可以是 inject 回调里那个子 context）。
 * @returns 信任清单；拿不到就是空数组。
 */
export function readTrustedHosts(ctx: Ctx): string[] {
    const webStartup = ctx.get('webStartup') as { trustedHosts?: unknown } | undefined
    const trustedHosts = webStartup?.trustedHosts
    // 服务值是外部输入，围栏不能因为它抛错。
    if (Array.isArray(trustedHosts) === false) return []

    return trustedHosts as string[]
}

/**
 * 取平台的会话查询服务（`ctx.sessionQuery`）。
 *
 * **为什么必须用 `ctx.get`。** 这个服务由平台内的另一个插件行提供（精简 profile 可能没挂），把服务名
 * 写进 `inject` 会让整条配置通路静默挂不上（`05-坑册.md` 坑 37）。`ctx.get` 不需要声明，缺服务时
 * 如实返回 `undefined`——只读端点随之退回只有内存账本与会话对象两条源。
 *
 * @param ctx - 插件所在的 context（可以是 inject 回调里那个子 context）。
 * @returns 会话查询服务；本进程没有就是 undefined。
 */
export function readSessionQuery(ctx: Ctx): 会话查询面 | undefined {
    return ctx.get<会话查询面>('sessionQuery')
}

/** 把 authority 字符串解析成 URL，失败返回 undefined。 */
function parseAuthority(authority: string): URL | undefined {
    try {
        return new URL(`http://${authority}`)

    } catch {
        return undefined
    }
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

    const reachable = 是否回环主机名(hostUrl.hostname) || isTrustedAuthority(hostUrl, trustedHosts)
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
 * 回一个 JSON 响应，可顺带挂上额外响应头。
 *
 * **为什么需要附加头组。** 旧认证 cookie 的清理要在**同一个正常 JSON 响应**上同时挂多条
 * `Set-Cookie`：一个 cookie 一条独立响应头，值必须给**字符串数组**（拼成一条会被浏览器当成
 * 一个畸形 cookie）。故这里多一个可选头组，默认空对象 ⇒ 现有调用方一行不用改、行为不变。
 *
 * **为什么走 `writeHead` 而不是 `res.setHeader`。** 头随状态码一次写完，不需要「先设头再写头」
 * 两步；测试的响应桩也只实现了 `once` / `writeHead` / `end`。
 *
 * @param res - Node 的响应对象。
 * @param statusCode - HTTP 状态码。
 * @param payload - 可 JSON 序列化的响应体。
 * @param 附加头组 - 一并写出的额外响应头（如多条 `set-cookie`）；默认不带。
 */
export function json(
    res: ServerResponse,
    statusCode: number,
    payload: unknown,
    附加头组: Record<string, string | string[]> = {},
): void {
    if (res.writableEnded || res.destroyed) return

    res.once('error', ignoreClientAbort)

    const body = JSON.stringify(payload)
    try {
        res.writeHead(statusCode, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(body),
            ...附加头组,
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
                const body = raw === '' ? {} : JSON.parse(raw)
                // 先解析成功再置 settled：畸形 JSON 走到 catch 时 fail 还能把 Promise 拒绝掉。
                settled = true
                resolve(body)

            } catch (error) {
                fail(Object.assign(Error(`invalid JSON body: ${(error as Error).message}`), { statusCode: 400 }))
            }
        })

        req.on('error', fail)
    })
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
 * 查 npm 上本包的最新版本（dist-tag latest）。
 *
 * 设置页直连 registry 会踩跨域与代理，这一步必须由 host 去查。
 *
 * @returns registry 回的 `version` 字段。
 */
async function fetchLatestVersion(): Promise<string> {
    const response = await fetch(VERSION_ENDPOINT_URL, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(VERSION_TIMEOUT_MS),
    })
    if (response.ok === false) throw Error(`HTTP ${response.status}`)

    const body = await response.json() as { version?: unknown }
    if (typeof body.version !== 'string' || body.version === '') throw Error('registry response has no version')

    return body.version
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
 * **两个来源合并。** 内存账本是本进程记下的，日志里那份是持久的（插件重启后内存账本空了、日志里那条
 * 还在）——合并读取收敛在 `retry-intercept.ts` 的 `获取全部拦截记录`。会话没在本进程打开过时（「查看
 * 会话」），那份日志靠 `deps.取会话查询()` 给的会话查询服务冷读，不需要 agent。
 *
 * @param url - 已解析的请求 URL（会话 id 走 query）。
 * @param res - Node 的响应对象。
 * @param deps - 取值依赖（读记录要现取会话查询服务）。
 */
async function handleGetRetryIntercepts(url: URL, res: ServerResponse, deps: ApiDeps): Promise<void> {
    const 会话ID = url.searchParams.get('session') ?? ''

    json(res, 200, { ok: true, 记录组: await 获取全部拦截记录(会话ID, deps.取会话查询()) })
}

/**
 * `POST /config`：把设置页发来的配置写回平台 settings。
 *
 * 每个字段都照做类型校验：手改请求、老客户端都可能发来别的东西，
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
    if (typeof networkRetryCount !== 'number' || Number.isInteger(networkRetryCount) === false || networkRetryCount < RETRY_COUNT_MIN || networkRetryCount > RETRY_COUNT_MAX) {
        json(res, 400, { ok: false, error: 'api.networkRetryCountInvalid' })
        return
    }

    const networkRetryTokens = body?.networkRetryTokens
    if (typeof networkRetryTokens !== 'string' || networkRetryTokens.length > RETRY_TOKENS_MAX_LENGTH) {
        json(res, 400, { ok: false, error: 'api.networkRetryTokensInvalid' })
        return
    }

    const toolFailurePrefixes = body?.toolFailurePrefixes
    if (typeof toolFailurePrefixes !== 'string' || toolFailurePrefixes.length > TOOL_FAILURE_PREFIXES_MAX_LENGTH) {
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

    const ptcBreakLimit = body?.ptcBreakLimit
    if (typeof ptcBreakLimit !== 'boolean') {
        json(res, 400, { ok: false, error: 'api.ptcBreakLimitNotBoolean' })
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
    if (typeof compactionThreshold !== 'string' || 解析压缩阈值(compactionThreshold) === null) {
        json(res, 400, { ok: false, error: 'api.compactionThresholdInvalid' })
        return
    }

    const compactionInstruction = body?.compactionInstruction
    if (typeof compactionInstruction !== 'string' || compactionInstruction.length > COMPACTION_INSTRUCTION_MAX_LENGTH) {
        json(res, 400, { ok: false, error: 'api.compactionInstructionInvalid' })
        return
    }

    const authCookieSweep = body?.authCookieSweep
    if (typeof authCookieSweep !== 'boolean') {
        json(res, 400, { ok: false, error: 'api.authCookieSweepNotBoolean' })
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
            ptcBreakLimit,
            contextCompaction,
            compactionScope,
            compactionThreshold,
            compactionInstruction,
            authCookieSweep,
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
        let 结果: RepairOutcome
        try {
            结果 = await repairSessionFile(文件路径)

        } catch (err) {
            // 单个文件出意外只算它自己失败：一次扫描要覆盖几百个会话文件，不能因为一个坏文件全盘作废。
            结果 = { filePath: 文件路径, status: 'read-failed', reason: `未预期的失败：${errText(err)}`, changedCategories: [] }
        }

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
 * `POST /sweep-auth-cookies`：删掉本机那些不属于当前页面的旧认证 cookie。
 *
 * **为什么清。** 平台签发的认证 cookie 名字是 `dsh-auth-` + 授权域的 sha256（base64url），而桌面端
 * 每次启动都换端口 ⇒ 每启动一次就多一条名字不同、永不复用的死 cookie；HTTP 下的 cookie 又不按端口
 * 隔离，它们全堆进同一个 `Cookie` 请求头，约 68 条时撑爆 Node 默认 16 KB 的请求头上限（431，
 * 页面直接打不开）。清理就是把没越过门槛的那些死 cookie 删掉。
 *
 * **保谁。** 只删「不属于当前页面」的：当前页面那条的名字用本请求的 `Host` 头现算，算不出来就一条
 * 都不删——宁可留着垃圾，也不能赌错当前那条把用户锁在门外。
 *
 * **门槛。** `Cookie` 头里的 `dsh-auth-*` **严格超过** 20 条才动手（口径收敛在
 * `auth-cookie-sweep.ts`，这里不另写一份）。
 *
 * **为什么静默。** 它由 client 半边在页面加载时自动调，不是用户点的按钮：空操作不写日志、不打
 * 任何提示，否则每开一次页面就刷一行噪音。
 *
 * **为什么只在回环上动手。** 非回环地址可能是别人通过 `--host` / `--trusted-host` 暴露出来的——
 * 那台机器上是别人的浏览器，删 cookie 会把别人的会话当场踢掉。故只清本机。
 *
 * **围栏用写围栏。** 这是服务端改写浏览器状态（删 cookie），不是读；且写围栏把请求变成非简单请求、
 * 跨站页面必须过预检 ⇒ 挡得住「跨站 GET 顺手触发一次清理」这类简单请求 CSRF。
 *
 * @param req - Node 的请求对象（读围栏要的 Host 与 Cookie 头都从这里取）。
 * @param res - Node 的响应对象。
 * @param deps - 取值依赖（配置开关从作用域现取）。
 * @param logger - 日志出口（只在真删了东西时写一行）。
 */
async function handleSweepAuthCookies(
    req: IncomingMessage,
    res: ServerResponse,
    deps: ApiDeps,
    logger: Logger,
): Promise<void> {
    const requestError = validateMutationRequest(req, deps.trustedHosts ?? [])
    if (requestError !== null) {
        json(res, requestError.statusCode, { ok: false, error: requestError.error })
        return
    }

    // 体里没有内容，但必须读掉：keep-alive 连接上残留未读数据会污染下一个请求。
    try {
        await readJsonBody(req)

    } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode ?? 400
        json(res, statusCode, { ok: false, error: `api.bodyReadFailed|${escapeArg(errText(error))}` })
        return
    }

    const scope = deps.getScope()
    if (scope === undefined) {
        json(res, 503, { ok: false, error: 'api.settingsNotReady' })
        return
    }

    const 配置 = readConfig(scope.get())
    if (配置.authCookieSweep === false) {
        json(res, 200, { ok: true, 清理数: 0 })
        return
    }

    let 是回环 = false
    try {
        是回环 = 是否回环主机名(new URL(`http://${req.headers.host ?? ''}`).hostname)

    } catch {
        // Host 头解析不出来就按非回环办：这次不清，也好过在别人的浏览器上删 cookie。
    }

    if (是回环 === false) {
        json(res, 200, { ok: true, 清理数: 0 })
        return
    }

    const 待删名组 = 判定待删认证Cookie(req.headers.cookie, req.headers.host)
    if (待删名组.length === 0) {
        json(res, 200, { ok: true, 清理数: 0 })
        return
    }

    const 头组 = 造删除响应头组(待删名组)
    json(
        res,
        200,
        { ok: true, 清理数: 头组.length },
        { 'set-cookie': 头组 },
    )

    logger.info?.(`[harden] 旧认证 cookie 已清理：删除 ${头组.length} 条（host=${req.headers.host ?? '-'}）`)
}

/**
 * 挂上本插件的 HTTP 路由。
 *
 * 需要 `webServer`（注册路由）。设置服务缺席时读端点回 `config: null`、写端点回 503，
 * 面板据此如实显示，而不是假装能用。
 *
 * @param ctx - 插件所在的 context。
 * @param logger - 日志出口。
 * @param deps - `{ getScope, trustedHosts, 取最新版本, 取会话查询 }`。
 */
export function mountApi(ctx: Ctx, logger: Logger, deps: ApiDeps): void {
    const webServer = ctx.webServer as WebServerService | undefined
    if (webServer === undefined) {
        logger.warn?.('[harden] webServer 不可用，设置页的配置通路未挂上')
        return
    }

    const trustedHosts = deps.trustedHosts ?? []

    /** 最近一次查询成功的版本；失败不写缓存，见 handleGetLatestVersion。 */
    let 版本缓存: { 版本: string; 时间戳: number } | null = null

    /**
     * `GET /latest-version`：把 npm 上的最新版本交给设置页页头。
     *
     * **缓存住在挂载闭包里。** 5 分钟内复用同一份结果，用户连点按钮不会反复打 registry；
     * 缓存随每次挂载重建，不需要给测试留「清空缓存」的出口。
     *
     * @param res - Node 的响应对象。
     */
    async function handleGetLatestVersion(res: ServerResponse): Promise<void> {
        const 取最新版本 = deps.取最新版本 ?? fetchLatestVersion
        if (版本缓存 !== null && Date.now() - 版本缓存.时间戳 < VERSION_CACHE_MS) {
            json(res, 200, { ok: true, 最新版本: 版本缓存.版本 })
            return
        }

        try {
            const 版本 = await 取最新版本()
            版本缓存 = { 版本, 时间戳: Date.now() }
            json(res, 200, { ok: true, 最新版本: 版本 })

        } catch (err) {
            // 失败不缓存：离线、代理不通、registry 读副本刚发布还 404，都要能立刻重试。
            json(res, 502, { ok: false, error: `api.versionCheckFailed|${escapeArg(errText(err))}` })
        }
    }

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
                await handleGetRetryIntercepts(url, res, deps)
                return
            }

            if (req.method === 'GET' && path === `${API_PREFIX}/latest-version`) {
                await handleGetLatestVersion(res)
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

            if (req.method === 'POST' && path === `${API_PREFIX}/sweep-auth-cookies`) {
                await handleSweepAuthCookies(req, res, deps, logger)
                return
            }

            json(res, 404, { ok: false, error: `api.unknownAction|${req.method} ${escapeArg(path)}` })
        },
    })

    logger.info?.(`[harden] 设置页 HTTP 路由已挂上 · ${API_PREFIX}`)
}
