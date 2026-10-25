/**
 * HTTP 端点（`src/host/api.ts`）的单元测试。
 *
 * **被测对象是本插件唯一的对外暴露面，也是唯一的安全边界**：读 / 写两道围栏、十二个字段的端点校验
 * 与错误码、请求体读取的 400 / 413、暗号参数的竖线转义、逐文件容错的四类计数，以及页头「检查更新」
 * 用的只读版本端点。这些口径此前只有真机手工 curl 过三态（B-6），这里补回归网。
 *
 * **不起真 http server、不引新依赖。** 请求桩只带围栏与路由要读的头；带 body 的用例用 `node:stream` 的
 * `PassThrough`（`readJsonBody` 要的就是事件流）；响应桩是记录型小对象，`writeHead` / `end` 收到的值留在
 * 属性上。handler 直接从假 `webServer.register` 里摘出来调，断言读的是真实写出的响应体与真实收到的
 * patch，不 mock 一圈断言 mock。
 *
 * **只替掉会话修复那一层**（`session-repair.js` 的 `scanSessionFiles` / `repairSessionFile`）：容错用例要
 * 造「某个文件抛错」，其余导出照原样。版本端点默认不碰网络——用例注入 `取最新版本`；只有接线用例用
 * `vi.stubGlobal('fetch', …)` 验真打的 URL、请求头与超时信号。
 *
 * @module dsh-harden/tests/api
 */

import { PassThrough } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { json, mountApi, readJsonBody } from '../src/host/api.js'
import type { ApiDeps, ConfigScope } from '../src/host/api.js'
import {
    COMPACTION_INSTRUCTION_MAX_LENGTH,
    RETRY_COUNT_MAX,
    RETRY_COUNT_MIN,
    RETRY_TOKENS_MAX_LENGTH,
    TOOL_FAILURE_PREFIXES_MAX_LENGTH,
    parseTokenCount,
} from '../src/host/shared-format.js'
import type { Ctx, HardenConfig } from '../src/host/types.js'

/** 会话修复桩的活状态（`vi.hoisted` 让它先于 `vi.mock` 工厂建好）。 */
const 会话修复桩 = vi.hoisted(() => {
    /** `scanSessionFiles` 要回的路径组（用例自己填）。 */
    const 扫描路径组: string[] = []
    /** 路径 → 修复结果（`RepairOutcome`）或「该文件抛错」的 Error。 */
    const 结果表 = new Map<string, unknown>()
    /** 真被问过的路径组（断言端点确实逐个走了，不是提前收摊）。 */
    const 修复调用组: string[] = []

    return { 扫描路径组, 结果表, 修复调用组 }
})

vi.mock('../src/host/session-repair.js', async (importOriginal) => {
    // 只换「扫描」与「修一个文件」两步：其余导出（平台包定位、修复判定）照原样，别的模块 import 它不受影响。
    const 原模块 = await importOriginal<typeof import('../src/host/session-repair.js')>()

    return {
        ...原模块,
        scanSessionFiles: async (): Promise<string[]> => 会话修复桩.扫描路径组,
        repairSessionFile: async (文件路径: string): Promise<unknown> => {
            会话修复桩.修复调用组.push(文件路径)

            const 结果 = 会话修复桩.结果表.get(文件路径)
            if (结果 instanceof Error) throw 结果

            return 结果
        },
    }
})

/** 十二个可写字段各取一个合法值：合法请求体与「patch 字段齐全」断言共用这一份。 */
const 合法配置: Required<HardenConfig> = {
    toolFailureGuard: true,
    toolFailurePrefixes: '工具调用失败',
    emptyOutputGuard: false,
    networkRetryCount: 3,
    networkRetryTokens: 'SERVER,TIMEOUT',
    backgroundJobTool: true,
    subagentAggregation: true,
    ptcBreakLimit: false,
    contextCompaction: true,
    compactionScope: 'all',
    compactionThreshold: '200K',
    compactionInstruction: '压一压',
}

/** 字段校验表结构：字段名 + 非法取值 + 期望错误码。 */
interface 字段校验行 {
    字段名: string
    非法值: unknown
    期望错误码: string
}

/** 十二个字段各自的非法取值（顺序与端点里的校验顺序一致）。 */
const 字段校验表: 字段校验行[] = [
    { 字段名: 'toolFailureGuard', 非法值: 'yes', 期望错误码: 'api.toolFailureGuardNotBoolean' },
    { 字段名: 'emptyOutputGuard', 非法值: 'true', 期望错误码: 'api.emptyOutputGuardNotBoolean' },
    { 字段名: 'networkRetryCount', 非法值: 1.5, 期望错误码: 'api.networkRetryCountInvalid' },
    { 字段名: 'networkRetryTokens', 非法值: 7, 期望错误码: 'api.networkRetryTokensInvalid' },
    { 字段名: 'toolFailurePrefixes', 非法值: 42, 期望错误码: 'api.toolFailurePrefixesInvalid' },
    { 字段名: 'backgroundJobTool', 非法值: 1, 期望错误码: 'api.backgroundJobToolNotBoolean' },
    { 字段名: 'subagentAggregation', 非法值: null, 期望错误码: 'api.subagentAggregationNotBoolean' },
    { 字段名: 'ptcBreakLimit', 非法值: 'yes', 期望错误码: 'api.ptcBreakLimitNotBoolean' },
    { 字段名: 'contextCompaction', 非法值: 'off', 期望错误码: 'api.contextCompactionNotBoolean' },
    { 字段名: 'compactionScope', 非法值: 'both', 期望错误码: 'api.compactionScopeInvalid' },
    { 字段名: 'compactionThreshold', 非法值: 'abc', 期望错误码: 'api.compactionThresholdInvalid' },
    { 字段名: 'compactionInstruction', 非法值: 10000, 期望错误码: 'api.compactionInstructionInvalid' },
]

/** 字段名 → 错误码（长度边界用例复用同一张表，不再写第二份字面量）。 */
const 错误码表 = new Map(字段校验表.map((行) => [行.字段名, 行.期望错误码]))

/** 端点 handler 的形状（`mountApi` 注册进 webServer 的那个）。 */
type 端点处理器 = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/** 记录型响应对象：`writeHead` / `end` 收到的值留在属性上，断言读真实写出值。 */
interface 响应桩 {
    statusCode: number
    headers: Record<string, unknown>
    body: string
    writableEnded: boolean
    destroyed: boolean
    writeHead调用次数: number
    end调用次数: number
    once(事件名: string, 处理函数: () => void): void
    writeHead(statusCode: number, headers: Record<string, unknown>): void
    end(body?: string): void
}

/** 造一个记录型响应桩；`初值` 用来模拟已经 end / 已经断开。 */
function 造响应桩(初值: { writableEnded?: boolean; destroyed?: boolean } = {}): 响应桩 {
    const 响应记录: 响应桩 = {
        statusCode: 0,
        headers: {},
        body: '',
        writableEnded: 初值.writableEnded ?? false,
        destroyed: 初值.destroyed ?? false,
        writeHead调用次数: 0,
        end调用次数: 0,

        once(): void {},

        writeHead(statusCode: number, headers: Record<string, unknown>): void {
            响应记录.statusCode = statusCode
            响应记录.headers = headers
            响应记录.writeHead调用次数 += 1
        },

        end(body?: string): void {
            响应记录.body = body ?? ''
            响应记录.writableEnded = true
            响应记录.end调用次数 += 1
        },
    }

    return 响应记录
}

/** 造一个只带围栏与路由要读的头的请求桩；host 缺省是回环。 */
function 造请求桩(方法: string, url: string, 头组: Record<string, string> = {}): IncomingMessage {
    return { method: 方法, url, headers: { host: 'localhost:1234', ...头组 } } as unknown as IncomingMessage
}

/** 造一个带原始文本 body 的请求桩（`readJsonBody` 要的是可读的事件流）。 */
function 造带体请求桩(
    方法: string,
    url: string,
    原始文本: string,
    头组: Record<string, string>,
): IncomingMessage {
    const 请求流 = new PassThrough()
    请求流.end(Buffer.from(原始文本, 'utf8'))

    return Object.assign(请求流, { method: 方法, url, headers: { host: 'localhost:1234', ...头组 } }) as unknown as IncomingMessage
}

/** 造一个读 body 时就报错的请求桩（连接中断这类真实故障）。 */
function 造断流请求桩(
    方法: string,
    url: string,
    错误: Error,
    头组: Record<string, string>,
): IncomingMessage {
    const 请求流 = new PassThrough()
    // destroy 带错误：'data' / 'end' 都不会来，readJsonBody 的 'error' 分支接住它。
    请求流.destroy(错误)

    return Object.assign(请求流, { method: 方法, url, headers: { host: 'localhost:1234', ...头组 } }) as unknown as IncomingMessage
}

/** 写端点的默认头组（自定义头 + JSON content-type）。 */
const 写端点头组 = { 'x-dsh-harden': '1', 'content-type': 'application/json' }

/** 造一个写端点请求桩；`头组` 用来逐项改坏写围栏要看的头。 */
function 造写请求桩(体: unknown, 头组: Record<string, string> = {}, 路径: string = '/api/dsh-harden/config'): IncomingMessage {
    return 造带体请求桩('POST', 路径, JSON.stringify(体), { ...写端点头组, ...头组 })
}

/** 造一个记录写入的作用域桩：`get` 回给定配置，`update` 把 patch 记下来。 */
function 造作用域桩(配置: Required<HardenConfig>): { scope: ConfigScope; 写入补丁组: object[] } {
    const 写入补丁组: object[] = []
    const scope: ConfigScope = {
        get: () => 配置,
        update: (patch: object): void => {
            写入补丁组.push(patch)
        },
    }

    return { scope, 写入补丁组 }
}

/** 造一份「设置服务未就绪」的依赖；用例按需覆盖（注入取版本实现、信任清单等）。 */
function 造依赖(覆盖: Partial<ApiDeps> = {}): ApiDeps {
    return {
        getScope: () => undefined,
        取会话查询: () => undefined,
        ...覆盖,
    }
}

/** 造一份「设置服务已就绪」的依赖（写端点要先过 scope 这一关才走到字段校验）。 */
function 造就绪依赖(覆盖: Partial<ApiDeps> = {}): ApiDeps {
    return 造依赖({ getScope: () => 造作用域桩(合法配置).scope, ...覆盖 })
}

/** 用假 ctx 挂一次路由，把 `mountApi` 注册的 handler 摘出来。 */
function 挂载端点(deps: ApiDeps): 端点处理器 {
    const 捕获: { handler: 端点处理器 | null } = { handler: null }
    const ctx = {
        webServer: {
            register(选项: { handler: 端点处理器 }): void {
                捕获.handler = 选项.handler
            },
        },
    } as unknown as Ctx

    mountApi(ctx, { info: () => {}, warn: () => {} }, deps)
    if (捕获.handler === null) throw Error('mountApi 没有注册路由 handler')

    return 捕获.handler
}

/** 调一次端点，返回记录型响应桩。 */
async function 调端点(handler: 端点处理器, req: IncomingMessage): Promise<响应桩> {
    const 响应 = 造响应桩()
    await handler(req, 响应 as unknown as ServerResponse)

    return 响应
}

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

describe('读围栏', () => {
    /** 该被拒的请求头组（每条一个真实触发场景）。 */
    const 拒绝头组: { 说明: string; 头组: Record<string, string> }[] = [
        { 说明: 'host 是外部域名', 头组: { host: 'harden.example:3080' } },
        { 说明: 'sec-fetch-site 是 cross-site', 头组: { 'sec-fetch-site': 'cross-site' } },
        { 说明: 'origin 与 host 不符', 头组: { origin: 'http://evil.example' } },
        { 说明: 'origin 解析失败', 头组: { origin: ':::' } },
    ]

    for (const 用例 of 拒绝头组) {
        it(`${用例.说明} ⇒ 403 api.forbiddenHost`, async () => {
            const handler = 挂载端点(造依赖())
            const 响应 = await 调端点(handler, 造请求桩('GET', '/api/dsh-harden/config', 用例.头组))

            expect(响应.statusCode).toBe(403)
            expect(JSON.parse(响应.body)).toEqual({ ok: false, error: 'api.forbiddenHost' })
        })
    }

    /** 该放行的请求头组。 */
    const 放行头组: { 说明: string; 头组: Record<string, string> }[] = [
        { 说明: '回环 host 且没有 origin', 头组: {} },
        { 说明: '回环 host 且 origin 与 host 全等', 头组: { origin: 'http://localhost:1234' } },
        { 说明: 'sec-fetch-site 是 same-origin', 头组: { 'sec-fetch-site': 'same-origin' } },
    ]

    for (const 用例 of 放行头组) {
        it(`${用例.说明} ⇒ 放行`, async () => {
            const handler = 挂载端点(造依赖())
            const 响应 = await 调端点(handler, 造请求桩('GET', '/api/dsh-harden/config', 用例.头组))

            expect(响应.statusCode).toBe(200)
        })
    }

    it('信任清单里的外部 authority 放行（回环之外的唯一出口）', async () => {
        const handler = 挂载端点(造依赖({ trustedHosts: ['harden.example:3080'] }))
        const 响应 = await 调端点(handler, 造请求桩('GET', '/api/dsh-harden/config', { host: 'harden.example:3080' }))

        expect(响应.statusCode).toBe(200)
    })
})

describe('GET /config', () => {
    it('设置服务就绪时 config 是 scope.get() 的结果', async () => {
        const { scope } = 造作用域桩(合法配置)
        const handler = 挂载端点(造依赖({ getScope: () => scope }))
        const 响应 = await 调端点(handler, 造请求桩('GET', '/api/dsh-harden/config'))

        expect(响应.statusCode).toBe(200)
        expect(JSON.parse(响应.body)).toEqual({ ok: true, config: 合法配置 })
    })

    it('设置服务未就绪时 config 为 null（是「没准备好」，不是读失败）', async () => {
        const handler = 挂载端点(造依赖())
        const 响应 = await 调端点(handler, 造请求桩('GET', '/api/dsh-harden/config'))

        expect(响应.statusCode).toBe(200)
        expect(JSON.parse(响应.body)).toEqual({ ok: true, config: null })
    })
})

describe('POST /config 围栏与体读取', () => {
    it('缺 x-dsh-harden 头 ⇒ 403 api.forbiddenMutation', async () => {
        const handler = 挂载端点(造就绪依赖())
        const 请求 = 造带体请求桩(
            'POST',
            '/api/dsh-harden/config',
            JSON.stringify(合法配置),
            { 'content-type': 'application/json' },
        )
        const 响应 = await 调端点(handler, 请求)

        expect(响应.statusCode).toBe(403)
        expect(JSON.parse(响应.body)).toEqual({ ok: false, error: 'api.forbiddenMutation' })
    })

    it('content-type 不是 JSON ⇒ 415 api.contentTypeInvalid', async () => {
        const handler = 挂载端点(造就绪依赖())
        const 响应 = await 调端点(handler, 造写请求桩(合法配置, { 'content-type': 'text/plain' }))

        expect(响应.statusCode).toBe(415)
        expect(JSON.parse(响应.body)).toEqual({ ok: false, error: 'api.contentTypeInvalid' })
    })

    it('设置服务未就绪 ⇒ 503 api.settingsNotReady（不假装写成功）', async () => {
        const handler = 挂载端点(造依赖())
        const 响应 = await 调端点(handler, 造请求桩('POST', '/api/dsh-harden/config', 写端点头组))

        expect(响应.statusCode).toBe(503)
        expect(JSON.parse(响应.body)).toEqual({ ok: false, error: 'api.settingsNotReady' })
    })

    it('body 不是合法 JSON ⇒ 400 api.bodyReadFailed|… 并带上真原因', async () => {
        const handler = 挂载端点(造就绪依赖())
        const 请求 = 造带体请求桩('POST', '/api/dsh-harden/config', '{"toolFailureGuard": ', 写端点头组)
        const 响应 = await 调端点(handler, 请求)
        const 结果 = JSON.parse(响应.body)

        expect(响应.statusCode).toBe(400)
        expect(结果.error.startsWith('api.bodyReadFailed|')).toBe(true)
        expect(结果.error).toContain('invalid JSON body')
    })

    it('body 读到一半连接断开 ⇒ 400 api.bodyReadFailed|…，真原因里的竖线被换掉', async () => {
        const handler = 挂载端点(造就绪依赖())
        const 请求 = 造断流请求桩('POST', '/api/dsh-harden/config', Error('conn|reset'), 写端点头组)
        const 响应 = await 调端点(handler, 请求)
        const 结果 = JSON.parse(响应.body)

        expect(响应.statusCode).toBe(400)
        expect(结果.error).toBe('api.bodyReadFailed|conn/reset')
        expect(结果.error.split('|')).toHaveLength(2)
    })
})

describe('POST /config 字段校验', () => {
    for (const 字段行 of 字段校验表) {
        it(`${字段行.字段名} 取非法值 ⇒ 400 ${字段行.期望错误码}`, async () => {
            const handler = 挂载端点(造就绪依赖())
            const 响应 = await 调端点(handler, 造写请求桩({ ...合法配置, [字段行.字段名]: 字段行.非法值 }))

            expect(响应.statusCode).toBe(400)
            expect(JSON.parse(响应.body)).toEqual({ ok: false, error: 字段行.期望错误码 })
        })
    }

    it('老客户端压根不发某个字段 ⇒ 同一道 400，不冒到平台 schema', async () => {
        const 缺字段的体 = { ...合法配置 } as Record<string, unknown>
        delete 缺字段的体.networkRetryCount

        const handler = 挂载端点(造就绪依赖())
        const 响应 = await 调端点(handler, 造写请求桩(缺字段的体))

        expect(响应.statusCode).toBe(400)
        expect(JSON.parse(响应.body)).toEqual({ ok: false, error: 'api.networkRetryCountInvalid' })
    })

    it('十二个字段全合法 ⇒ 200，且把十二个字段一起写给 settings', async () => {
        const { scope, 写入补丁组 } = 造作用域桩(合法配置)
        const handler = 挂载端点(造依赖({ getScope: () => scope }))
        const 响应 = await 调端点(handler, 造写请求桩(合法配置))

        expect(响应.statusCode).toBe(200)
        expect(JSON.parse(响应.body)).toEqual({ ok: true })
        expect(写入补丁组).toEqual([合法配置])
        expect(Object.keys(写入补丁组[0]).sort()).toEqual(Object.keys(合法配置).sort())
        expect(Object.keys(合法配置)).toHaveLength(12)
    })

    it('设置服务拒写 ⇒ 400 api.writeFailed|…，且原因里的竖线被换成斜杠', async () => {
        const 拒写作用域: ConfigScope = {
            get: () => 合法配置,
            update: (): void => {
                throw Error('写入失败：a|b')
            },
        }
        const handler = 挂载端点(造依赖({ getScope: () => 拒写作用域 }))
        const 响应 = await 调端点(handler, 造写请求桩(合法配置))
        const 结果 = JSON.parse(响应.body)

        expect(响应.statusCode).toBe(400)
        expect(结果.error).toBe('api.writeFailed|写入失败：a/b')
        // 暗号用竖线分隔字段，参数里再带一根会把字段切错位 ⇒ 整串只剩分隔符那一处。
        expect(结果.error.split('|')).toHaveLength(2)
    })
})

describe('端点校验与共享口径同一份', () => {
    /** 阈值文本 → 端点与面板该不该放行。 */
    const 阈值表: { 阈值文本: string; 期望通过: boolean }[] = [
        { 阈值文本: '200K', 期望通过: true },
        { 阈值文本: '100000', 期望通过: true },
        { 阈值文本: '1.5K', 期望通过: false },
        { 阈值文本: '0', 期望通过: false },
        { 阈值文本: 'abc', 期望通过: false },
    ]

    for (const 阈值行 of 阈值表) {
        it(`compactionThreshold = ${阈值行.阈值文本} ⇒ 与共享解析 parseTokenCount 裁决一致`, async () => {
            const handler = 挂载端点(造就绪依赖())
            const 响应 = await 调端点(handler, 造写请求桩({ ...合法配置, compactionThreshold: 阈值行.阈值文本 }))

            // 期望值就地由共享实现算出：端点（或面板）自己另写一份解析，这里立刻变红。
            expect(parseTokenCount(阈值行.阈值文本) !== null).toBe(阈值行.期望通过)
            expect(响应.statusCode).toBe(阈值行.期望通过 ? 200 : 400)
            if (阈值行.期望通过 === false) expect(JSON.parse(响应.body).error).toBe('api.compactionThresholdInvalid')
        })
    }

    /** 兜底重试次数的边界取值（上下界含）。 */
    const 次数表: { 取值: number; 期望通过: boolean }[] = [
        { 取值: RETRY_COUNT_MIN, 期望通过: true },
        { 取值: RETRY_COUNT_MAX, 期望通过: true },
        { 取值: RETRY_COUNT_MIN - 1, 期望通过: false },
        { 取值: RETRY_COUNT_MAX + 1, 期望通过: false },
    ]

    for (const 次数行 of 次数表) {
        it(`networkRetryCount = ${次数行.取值} ⇒ ${次数行.期望通过 ? '放行' : '400'}`, async () => {
            const handler = 挂载端点(造就绪依赖())
            const 响应 = await 调端点(handler, 造写请求桩({ ...合法配置, networkRetryCount: 次数行.取值 }))

            expect(响应.statusCode).toBe(次数行.期望通过 ? 200 : 400)
            if (次数行.期望通过 === false) expect(JSON.parse(响应.body).error).toBe('api.networkRetryCountInvalid')
        })
    }

    /** 三个长度字段的上限（端点内联上限已换成共享常量）。 */
    const 长度表: { 字段名: string; 上限: number }[] = [
        { 字段名: 'networkRetryTokens', 上限: RETRY_TOKENS_MAX_LENGTH },
        { 字段名: 'toolFailurePrefixes', 上限: TOOL_FAILURE_PREFIXES_MAX_LENGTH },
        { 字段名: 'compactionInstruction', 上限: COMPACTION_INSTRUCTION_MAX_LENGTH },
    ]

    for (const 长度行 of 长度表) {
        it(`${长度行.字段名} 到上限 ${长度行.上限} 放行、超一个字 400`, async () => {
            const handler = 挂载端点(造就绪依赖())
            const 到上限 = await 调端点(handler, 造写请求桩({ ...合法配置, [长度行.字段名]: 'x'.repeat(长度行.上限) }))
            const 超上限 = await 调端点(handler, 造写请求桩({ ...合法配置, [长度行.字段名]: 'x'.repeat(长度行.上限 + 1) }))

            expect(到上限.statusCode).toBe(200)
            expect(超上限.statusCode).toBe(400)
            expect(JSON.parse(超上限.body).error).toBe(错误码表.get(长度行.字段名))
        })
    }
})

describe('未知动作与暗号转义', () => {
    it('GET /api/dsh-harden/nope ⇒ 404 api.unknownAction|GET /api/dsh-harden/nope', async () => {
        const handler = 挂载端点(造依赖())
        const 响应 = await 调端点(handler, 造请求桩('GET', '/api/dsh-harden/nope'))

        expect(响应.statusCode).toBe(404)
        expect(JSON.parse(响应.body)).toEqual({ ok: false, error: 'api.unknownAction|GET /api/dsh-harden/nope' })
    })

    it('路径里带竖线 ⇒ 转义成斜杠，暗号字段切不错位', async () => {
        const handler = 挂载端点(造依赖())
        const 响应 = await 调端点(handler, 造请求桩('GET', '/api/dsh-harden/no|pe'))

        expect(响应.statusCode).toBe(404)
        expect(JSON.parse(响应.body)).toEqual({ ok: false, error: 'api.unknownAction|GET /api/dsh-harden/no/pe' })
    })
})

describe('GET /retry-intercepts', () => {
    it('未知会话 id ⇒ 200 空记录组（与「没发生过修正」同一件事）', async () => {
        const handler = 挂载端点(造依赖())
        const 响应 = await 调端点(handler, 造请求桩('GET', '/api/dsh-harden/retry-intercepts?session=unknown'))

        expect(响应.statusCode).toBe(200)
        expect(JSON.parse(响应.body)).toEqual({ ok: true, 记录组: [] })
    })

    it('缺省 session ⇒ 同样回空数组', async () => {
        const handler = 挂载端点(造依赖())
        const 响应 = await 调端点(handler, 造请求桩('GET', '/api/dsh-harden/retry-intercepts'))

        expect(响应.statusCode).toBe(200)
        expect(JSON.parse(响应.body)).toEqual({ ok: true, 记录组: [] })
    })
})

describe('readJsonBody', () => {
    it('body 超过上限 ⇒ 抛 413', async () => {
        const 请求流 = new PassThrough()
        请求流.end(Buffer.from('x'.repeat(32), 'utf8'))

        await expect(readJsonBody(请求流 as unknown as IncomingMessage, 16)).rejects.toMatchObject({ statusCode: 413 })
    })

    it('空 body ⇒ 空对象', async () => {
        const 请求流 = new PassThrough()
        请求流.end()

        await expect(readJsonBody(请求流 as unknown as IncomingMessage)).resolves.toEqual({})
    })
})

describe('json 响应写出', () => {
    /** 已经不能写的两种状态。 */
    const 已关闭状态组: { 状态: string; 初值: { writableEnded?: boolean; destroyed?: boolean } }[] = [
        { 状态: 'writableEnded', 初值: { writableEnded: true } },
        { 状态: 'destroyed', 初值: { destroyed: true } },
    ]

    for (const 用例 of 已关闭状态组) {
        it(`${用例.状态} 为 true 时不再写（二次 writeHead 会抛）`, () => {
            const 响应 = 造响应桩(用例.初值)
            json(响应 as unknown as ServerResponse, 200, { ok: true })

            expect(响应.writeHead调用次数).toBe(0)
            expect(响应.end调用次数).toBe(0)
        })
    }

    it('正常时写状态、JSON content-type 与序列化后的 body', () => {
        const 响应 = 造响应桩()
        json(响应 as unknown as ServerResponse, 400, { ok: false, error: 'api.x' })

        expect(响应.statusCode).toBe(400)
        expect(响应.headers['content-type']).toBe('application/json; charset=utf-8')
        expect(响应.headers['content-length']).toBe(Buffer.byteLength(响应.body))
        expect(JSON.parse(响应.body)).toEqual({ ok: false, error: 'api.x' })
    })
})

describe('POST /repair-sessions 逐文件容错', () => {
    beforeEach(() => {
        会话修复桩.扫描路径组.length = 0
        会话修复桩.结果表.clear()
        会话修复桩.修复调用组.length = 0
    })

    it('一个文件抛意外只算它自己失败，其余文件照常统计（整次扫描不作废）', async () => {
        const 通过路径 = 'sessions/甲/session.v4.jsonl.zstd'
        const 已修路径 = 'sessions/乙/session.v4.jsonl.zstd'
        const 抛错路径 = 'sessions/丙/session.v4.jsonl.zstd'
        会话修复桩.扫描路径组.push(通过路径, 已修路径, 抛错路径)
        会话修复桩.结果表.set(通过路径, { filePath: 通过路径, status: 'intact', reason: '校验通过，无需修复', changedCategories: [] })
        会话修复桩.结果表.set(已修路径, { filePath: 已修路径, status: 'repaired', reason: '已修复：retry-chain-normalized', changedCategories: ['retry-chain-normalized'] })
        会话修复桩.结果表.set(抛错路径, Error('平台包加载炸了'))

        const handler = 挂载端点(造依赖())
        const 响应 = await 调端点(handler, 造写请求桩({}, {}, '/api/dsh-harden/repair-sessions'))
        const 结果 = JSON.parse(响应.body)

        expect(响应.statusCode).toBe(200)
        expect(结果.总数).toBe(3)
        expect(结果.通过数).toBe(1)
        expect(结果.已修复数).toBe(1)
        expect(结果.修不了数).toBe(0)
        expect(结果.读取失败数).toBe(1)
        expect(结果.明细组).toEqual([
            { filePath: 通过路径, status: 'intact', reason: '校验通过，无需修复' },
            { filePath: 已修路径, status: 'repaired', reason: '已修复：retry-chain-normalized' },
            { filePath: 抛错路径, status: 'read-failed', reason: '未预期的失败：平台包加载炸了' },
        ])
        expect(会话修复桩.修复调用组).toEqual([通过路径, 已修路径, 抛错路径])
    })
})

describe('GET /latest-version', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-10-17T00:00:00.000Z'))
    })

    it('把注入实现查到的最新版本原样交给设置页', async () => {
        const 取最新版本 = vi.fn(async () => '0.0.3')
        const handler = 挂载端点(造依赖({ 取最新版本 }))
        const 响应 = await 调端点(handler, 造请求桩('GET', '/api/dsh-harden/latest-version'))

        expect(响应.statusCode).toBe(200)
        expect(JSON.parse(响应.body)).toEqual({ ok: true, 最新版本: '0.0.3' })
    })

    it('5 分钟内连点第二次走缓存，不再问一次（注入函数只被调 1 次）', async () => {
        const 取最新版本 = vi.fn(async () => '0.0.3')
        const handler = 挂载端点(造依赖({ 取最新版本 }))

        const 第一次 = await 调端点(handler, 造请求桩('GET', '/api/dsh-harden/latest-version'))
        const 第二次 = await 调端点(handler, 造请求桩('GET', '/api/dsh-harden/latest-version'))

        expect(取最新版本).toHaveBeenCalledTimes(1)
        expect(JSON.parse(第一次.body)).toEqual({ ok: true, 最新版本: '0.0.3' })
        expect(JSON.parse(第二次.body)).toEqual({ ok: true, 最新版本: '0.0.3' })
    })

    it('过 5 分钟零 1 毫秒缓存失效，重新问一次', async () => {
        const 版本队列 = ['0.0.3', '0.0.4']
        const 取最新版本 = vi.fn(async () => 版本队列.shift() as string)
        const handler = 挂载端点(造依赖({ 取最新版本 }))

        const 第一次 = await 调端点(handler, 造请求桩('GET', '/api/dsh-harden/latest-version'))
        vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1)
        const 第二次 = await 调端点(handler, 造请求桩('GET', '/api/dsh-harden/latest-version'))

        expect(取最新版本).toHaveBeenCalledTimes(2)
        expect(JSON.parse(第一次.body)).toEqual({ ok: true, 最新版本: '0.0.3' })
        expect(JSON.parse(第二次.body)).toEqual({ ok: true, 最新版本: '0.0.4' })
    })

    it('失败不占缓存：第一次 502，紧接着的第二次（时间没动）就能重试成功', async () => {
        const 结果队列: unknown[] = [Error('registry 连不上'), '0.0.3']
        const 取最新版本 = vi.fn(async () => {
            const 结果 = 结果队列.shift()
            if (结果 instanceof Error) throw 结果

            return 结果 as string
        })
        const handler = 挂载端点(造依赖({ 取最新版本 }))

        const 第一次 = await 调端点(handler, 造请求桩('GET', '/api/dsh-harden/latest-version'))
        const 第二次 = await 调端点(handler, 造请求桩('GET', '/api/dsh-harden/latest-version'))

        expect(第一次.statusCode).toBe(502)
        expect(JSON.parse(第一次.body)).toEqual({ ok: false, error: 'api.versionCheckFailed|registry 连不上' })
        expect(取最新版本).toHaveBeenCalledTimes(2)
        expect(第二次.statusCode).toBe(200)
        expect(JSON.parse(第二次.body)).toEqual({ ok: true, 最新版本: '0.0.3' })
    })

    it('读围栏照旧生效：host 是外部域名 ⇒ 403，且根本不去问版本', async () => {
        const 取最新版本 = vi.fn(async () => '0.0.3')
        const handler = 挂载端点(造依赖({ 取最新版本 }))
        const 响应 = await 调端点(handler, 造请求桩('GET', '/api/dsh-harden/latest-version', { host: 'harden.example:3080' }))

        expect(响应.statusCode).toBe(403)
        expect(JSON.parse(响应.body)).toEqual({ ok: false, error: 'api.forbiddenHost' })
        expect(取最新版本).not.toHaveBeenCalled()
    })

    it('只走读围栏：不带 x-dsh-harden 头仍 200', async () => {
        const 取最新版本 = vi.fn(async () => '0.0.3')
        const handler = 挂载端点(造依赖({ 取最新版本 }))
        const 响应 = await 调端点(handler, 造请求桩('GET', '/api/dsh-harden/latest-version'))

        expect(响应.statusCode).toBe(200)
        expect(JSON.parse(响应.body)).toEqual({ ok: true, 最新版本: '0.0.3' })
    })
})

describe('fetchLatestVersion 的接线', () => {
    it('URL、accept 头与超时信号都按约定，version 原样透出', async () => {
        const 调用组: { url: string; init: RequestInit }[] = []
        vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
            调用组.push({ url, init })

            return { ok: true, status: 200, json: async () => ({ version: '0.0.9' }) }
        })
        const handler = 挂载端点(造依赖())
        const 响应 = await 调端点(handler, 造请求桩('GET', '/api/dsh-harden/latest-version'))

        expect(调用组).toHaveLength(1)
        expect(调用组[0].url).toBe('https://registry.npmjs.org/dsh-harden/latest')
        expect((调用组[0].init.headers as Record<string, string>).accept).toBe('application/json')
        expect(调用组[0].init.signal).toBeInstanceOf(AbortSignal)
        expect(响应.statusCode).toBe(200)
        expect(JSON.parse(响应.body)).toEqual({ ok: true, 最新版本: '0.0.9' })
    })

    it('registry 回 200 但体里没有 version（读副本滞后）⇒ 502', async () => {
        vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({}) }))
        const handler = 挂载端点(造依赖())
        const 响应 = await 调端点(handler, 造请求桩('GET', '/api/dsh-harden/latest-version'))
        const 结果 = JSON.parse(响应.body)

        expect(响应.statusCode).toBe(502)
        expect(结果.error.startsWith('api.versionCheckFailed|')).toBe(true)
        expect(结果.error).toContain('registry response has no version')
    })

    it('registry 回非 2xx（版本还没发出去的 404）⇒ 502 带上状态码', async () => {
        vi.stubGlobal('fetch', async () => ({ ok: false, status: 404, json: async () => ({}) }))
        const handler = 挂载端点(造依赖())
        const 响应 = await 调端点(handler, 造请求桩('GET', '/api/dsh-harden/latest-version'))
        const 结果 = JSON.parse(响应.body)

        expect(响应.statusCode).toBe(502)
        expect(结果.error.startsWith('api.versionCheckFailed|')).toBe(true)
        expect(结果.error).toContain('HTTP 404')
    })
})
