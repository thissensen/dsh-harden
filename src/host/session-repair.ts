/**
 * 会话修复模块 —— 扫描会话文件、判定好坏、在内存里修两类已知的损坏形态（重试链规范化 +
 * 序号范围编码展开）、过平台校验才落盘。
 *
 * **背景。** 会话持久化文件是「多帧 zstd 串联」的 JSONL：首行是 `type: "session"` 的
 * header，其余每行一条会话事件。平台读取时会用 `restoreReleasedV4Artifact` 做一次严格
 * 校验，遇到这两类损坏形态会整份拒读：
 *
 * - **重试链异常**：同一 policy chain（turn + step + provider + policyKey 四元组）内 retry
 *   编号重复或跳号、整条链的 retryId 不一致，或者序号重排后 `normal` 模式的 `maxRetries`
 *   不够用。这种形态的来源是平台自带重试器写出重复的序号（校验报
 *   llm/retry skips its policy attempt sequence）与本插件早期版本的兜底重试每次换新 id
 *   （校验报 llm/retry must keep one retryId per policy chain）。
 * - **sourceEventSeqs 序号范围编码**：`sourceEventSeqs` 里允许写 `[start, end]`
 *   形式的子数组；校验器只认扁平数字，遇到范围就不解码。
 *
 * 本模块在**内存里**修好这两类损坏形态：先把重试链**规范化**（交给 `retry-chain-ledger.ts` 的
 * 重试链账本：同链 retry 编号按出现顺序重排 1..n、整链 retryId 归并成第一条、配对的
 * `llm/retry-started` 按 (retryId, retry) 同步改写，并把 `normal` 模式的 `maxRetries` 抬到
 * 不小于本条序号——真机样本 `dfd3eb08…` 同链两条 `retry = 1` 且 `maxRetries = 1`，序号重排
 * 成 2 后不改它仍会被平台拒），再**展开**序号范围编码。只有**修完再校验通过**才写回磁盘；写回用
 * 「临时文件 + rename」原子替换，任何一步失败都不落盘。
 *
 * **平台包按两个候选定位。** 三个平台包（持久化 jsonl / v3-to-v4 格式 / session 事件表）不写死
 * 绝对路径：先 resolve 一个能解析到的包，再从它的入口路径派生出 `@deepseek-ai` 目录，按同级
 * 包名取绝对路径。候选按装法分两档：
 *
 * - **首选** `dsh-session-persistence-jsonl`：插件装进 profile 内（非 link）时它是同级依赖，直接
 *   resolve 得到；
 * - **锚点** `dsh-agent`：`link:` 装法下 peerDependencies 里只有这一项被链进插件
 *   `node_modules`，内部包全不在（见 `.harness/05-坑册.md` 坑 22），只能靠它反推目录。
 *
 * 派生出的目录里必须同时存在 `dsh-session-format-v3-to-v4` 与 `dsh-session`，缺一则换下一个
 * 候选。平台包只在真正要校验时才加载——开发与 CI 环境没有它们，顶层静态 import 会让整个模块挂掉。
 *
 * @module dsh-harden/session-repair
 */

import { createRequire } from 'node:module'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { existsSync } from 'node:fs'
import { readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'

import { 重试链账本 } from './retry-chain-ledger.js'

/** 会话文件名。 */
const SESSION_FILE_NAME = 'session.v4.jsonl.zstd'

/** zstd 帧魔数（小端读出等于它才是帧起点）。 */
const ZSTD_FRAME_MAGIC = 4247762216

/** 每帧带 xxhash64 校验和的压缩选项。 */
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

/** 首选包名：插件装进 profile 内（非 link）时是同级依赖，能直接解析到。 */
const 首选包名 = '@deepseek-ai/dsh-session-persistence-jsonl'

/** 锚点包名：`link:` 装法下只有它会被链进插件的 node_modules，见 `.harness/05-坑册.md` 坑 22。 */
const 锚点包名 = '@deepseek-ai/dsh-agent'

/** 派生出的平台包目录里必须同时存在的两个包，见 `.harness/05-坑册.md` 坑 22。 */
const 必需包名组 = ['dsh-session-format-v3-to-v4', 'dsh-session']

/** 插件模块自己的 require；平台包按 peerDependencies 的链接关系解析。 */
const 插件require = createRequire(import.meta.url)

/** 修复结果的状态。 */
export type RepairStatus = 'intact' | 'repaired' | 'unrepairable' | 'read-failed'

/** 实际改动的类别。 */
export type RepairCategory = 'retry-chain-normalized' | 'sourceEventSeqs-expanded'

/** 单个会话文件的修复结果。 */
export interface RepairOutcome {
    /** 被处理的会话文件路径。 */
    filePath: string
    /** 结果状态：无需修复 / 已修复 / 修不了 / 读取失败。 */
    status: RepairStatus
    /** 人类可读的原因。 */
    reason: string
    /** 本次实际改动的类别；无需修复与失败时为空数组。 */
    changedCategories: RepairCategory[]
}

/** 平台校验器接口：校验通过正常返回，失败抛异常。 */
export interface SessionValidator {
    validate(header: Record<string, unknown>, events: unknown[]): void
}

/** 一帧 zstd 在缓冲区里的半开区间 `[start, end)`。 */
interface ZstdFrame {
    start: number
    end: number
}

/** 会话文件的解码结果。 */
interface DecodedSession {
    /** 全部行，首行是 header。 */
    lines: unknown[]
    /** 每一帧的明文行数，编码时按它重新切帧。 */
    frameLineCounts: number[]
}

/**
 * 递归找出会话根目录下所有 `session.v4.jsonl.zstd` 文件路径。
 *
 * @param 会话根目录 - 会话仓库根目录。
 * @returns 命中的会话文件路径组。
 */
export async function scanSessionFiles(会话根目录: string): Promise<string[]> {
    const 文件组: string[] = []
    const 待查目录组: string[] = [会话根目录]
    while (待查目录组.length > 0) {
        const 当前目录 = 待查目录组.pop() as string
        const 条目组 = await readdir(当前目录, { withFileTypes: true })
        for (const 条目 of 条目组) {
            const 子路径 = join(当前目录, 条目.name)
            if (条目.isDirectory()) {
                待查目录组.push(子路径)
                continue
            }
            if (条目.name === SESSION_FILE_NAME) 文件组.push(子路径)
        }
    }
    return 文件组
}

/**
 * 修复单个会话文件。
 *
 * 流程：读文件 → 解码帧 → 拆 header/事件 → 平台校验 → 好则报「无需修复」，坏则依次尝试
 * 重试链规范化与序号范围编码展开 → 改后再校验 → 过了才写回，不过则不落盘。
 * 校验不通过时把平台的原话带进 reason，便于判断损坏形态。
 *
 * @param 文件路径 - 会话文件路径。
 * @param 校验器 - 可注入的校验器；缺省时用两候选定位加载的平台校验器。
 * @returns 修复结果。
 */
export async function repairSessionFile(文件路径: string, 校验器?: SessionValidator): Promise<RepairOutcome> {
    let 文件内容: Buffer
    try {
        文件内容 = await readFile(文件路径)

    } catch (err) {
        return { filePath: 文件路径, status: 'read-failed', reason: `读取失败：${错误文本(err)}`, changedCategories: [] }
    }

    let 解码结果: DecodedSession
    try {
        解码结果 = decodeSessionFile(文件内容)

    } catch (err) {
        return { filePath: 文件路径, status: 'read-failed', reason: `解码失败：${错误文本(err)}`, changedCategories: [] }
    }

    const { header, events } = splitHeaderAndEvents(解码结果.lines)

    let 实际校验器: SessionValidator
    try {
        实际校验器 = 校验器 ?? loadPlatformValidator()

    } catch (err) {
        return { filePath: 文件路径, status: 'unrepairable', reason: `平台校验器不可用：${错误文本(err)}`, changedCategories: [] }
    }

    const 首检 = 跑校验(实际校验器, header, events)
    if (首检.通过) {
        return { filePath: 文件路径, status: 'intact', reason: '校验通过，无需修复', changedCategories: [] }
    }

    const 改动类别组: RepairCategory[] = []
    if (normalizeRetryChain(events)) 改动类别组.push('retry-chain-normalized')
    if (expandSourceEventSeqs(events)) 改动类别组.push('sourceEventSeqs-expanded')

    if (改动类别组.length === 0) {
        return {
            filePath: 文件路径,
            status: 'unrepairable',
            reason: `校验失败（${首检.原因}），且不属于已知的可修类别`,
            changedCategories: [],
        }
    }

    const 复检 = 跑校验(实际校验器, header, events)
    if (复检.通过 === false) {
        return {
            filePath: 文件路径,
            status: 'unrepairable',
            reason: `修复后仍未通过校验（已改：${改动类别组.join('、')}）：${复检.原因}`,
            changedCategories: [],
        }
    }

    try {
        const 临时路径 = `${文件路径}.repairing-${process.pid}`
        await writeFile(临时路径, encodeSessionFile(解码结果.lines, 解码结果.frameLineCounts))
        await rename(临时路径, 文件路径)

    } catch (err) {
        return { filePath: 文件路径, status: 'unrepairable', reason: `写回失败：${错误文本(err)}`, changedCategories: [] }
    }

    return { filePath: 文件路径, status: 'repaired', reason: `已修复：${改动类别组.join('、')}`, changedCategories: 改动类别组 }
}

/**
 * 重试链规范化：把每条 policy chain 的 retry 序号重排成 1..n 连续、整条链的 retryId 归并成该链
 * 第一条 `llm/retry` 的，并把 `normal` 模式下不够用的 `maxRetries` 抬到不小于本条序号。
 *
 * 判定本身不在这里——四条不变量（序号连续、整链共用一个 retryId、`llm/retry-started` 配对、
 * `maxRetries` 够用）收敛在 `retry-chain-ledger.ts` 的重试链账本里，本函数只负责「按日志顺序
 * 喂事件 → 按结论原地改写 data」。`llm/retry-started` 的配对映射也由账本持有（真机写出的
 * started 不带 provider/policyKey，平台只按 (retryId, retry) 配对）。
 *
 * @param events - 会话事件组（会被原地修改）。
 * @returns 是否真的改动了内容。
 */
export function normalizeRetryChain(events: unknown[]): boolean {
    // 账本有状态：修一份新日志必须换一个新实例。
    const 账本 = new 重试链账本()
    let 有改动 = false

    for (const event of events) {
        const 类型 = 读事件类型(event)
        if (类型 !== 'llm/retry' && 类型 !== 'llm/retry-started') continue
        const data = 读事件数据(event)
        if (data === null) continue

        const 结论 = 类型 === 'llm/retry' ? 账本.归一重试事件(data) : 账本.归一启动事件(data)
        if (结论 === null || 结论.有改动 === false) continue

        data.retryId = 结论.retryId
        data.retry = 结论.retry
        if (结论.maxRetries !== undefined) data.maxRetries = 结论.maxRetries
        有改动 = true
    }

    return 有改动
}

/**
 * 序号范围编码展开：遍历所有事件，把 `sourceEventSeqs` 里的 `[start, end]` 展开成扁平数字。
 *
 * @param events - 会话事件组（会被原地修改）。
 * @returns 是否真的改动了内容。
 */
export function expandSourceEventSeqs(events: unknown[]): boolean {
    let 有改动 = false
    for (const event of events) {
        if (展开节点内序号范围(event, 'sourceEventSeqs')) 有改动 = true
    }
    return 有改动
}

/**
 * 扫描多帧 zstd 串联缓冲区的帧边界。
 *
 * 复刻平台的帧扫描：逐字节走 header → block 链 → 可选 checksum，返回每一帧的
 * `[start, end)`。末尾残缺（写入中途断电）时把已识别的帧交回，残缺起点单列。
 *
 * @param buffer - 会话文件原始字节。
 */
function scanZstdFrames(buffer: Buffer): { frames: ZstdFrame[]; tornStart: number | null } {
    const frames: ZstdFrame[] = []
    let offset = 0
    while (offset < buffer.length) {
        const start = offset
        if (buffer.length - offset < 4) return { frames, tornStart: start }
        if (buffer.readUInt32LE(offset) !== ZSTD_FRAME_MAGIC) throw new Error('会话文件不是 zstd 帧')
        offset += 4
        if (offset === buffer.length) return { frames, tornStart: start }

        const descriptor = buffer.readUInt8(offset)
        offset += 1
        const contentSizeFlag = descriptor >>> 6
        const singleSegment = (descriptor & 32) !== 0
        const checksum = (descriptor & 4) !== 0
        const dictionaryFlag = descriptor & 3
        const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
        const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
        const remaining = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
        if (buffer.length - offset < remaining) return { frames, tornStart: start }
        offset += remaining

        for (;;) {
            if (buffer.length - offset < 3) return { frames, tornStart: start }
            const blockHeader = buffer.readUIntLE(offset, 3)
            offset += 3
            const lastBlock = (blockHeader & 1) !== 0
            const blockType = (blockHeader >>> 1) & 3
            const blockSize = blockHeader >>> 3
            const payload = blockType === 1 ? 1 : blockSize
            if (buffer.length - offset < payload) return { frames, tornStart: start }
            offset += payload
            if (lastBlock) break
        }

        if (checksum) {
            if (buffer.length - offset < 4) return { frames, tornStart: start }
            offset += 4
        }
        frames.push({ start, end: offset })
    }
    return { frames, tornStart: null }
}

/**
 * 把多帧 zstd 文件解码成行数组。
 *
 * 每帧独立解压，明文按顺序拼接后按换行切行；同时记下每帧的明文行数，编码时按相同行数
 * 还原帧结构（修复只改字段值、不改行数）。
 *
 * @param content - 会话文件原始字节。
 */
function decodeSessionFile(content: Buffer): DecodedSession {
    const { frames, tornStart } = scanZstdFrames(content)
    if (tornStart !== null) throw new Error(`会话文件末尾残缺（第 ${tornStart} 字节起）`)

    const lines: unknown[] = []
    const frameLineCounts: number[] = []
    for (const frame of frames) {
        const plainText = zstdDecompressSync(content.subarray(frame.start, frame.end)).toString('utf8')
        const 分段组 = plainText.split('\n')
        if (分段组.length > 0 && 分段组[分段组.length - 1] === '') 分段组.pop()
        for (const line of 分段组) lines.push(JSON.parse(line))
        frameLineCounts.push(分段组.length)
    }
    return { lines, frameLineCounts }
}

/**
 * 把行数组编码回多帧 zstd。
 *
 * 按解码时记录的每帧行数切分，每一帧都带 checksum，帧边界与原文件一致。行数对不上时把
 * 余下所有行压成最后一帧（兜底，正常不会走到）。
 *
 * @param lines - 全部行（含 header）。
 * @param frameLineCounts - 每帧明文行数。
 */
function encodeSessionFile(lines: unknown[], frameLineCounts: number[]): Buffer {
    const 行文本组 = lines.map((line) => JSON.stringify(line))
    const 帧缓冲组: Buffer[] = []
    let 游标 = 0
    for (const 帧行数 of frameLineCounts) {
        const 本帧行组 = 行文本组.slice(游标, 游标 + 帧行数)
        游标 += 帧行数
        帧缓冲组.push(zstdCompressSync(Buffer.from(`${本帧行组.join('\n')}\n`, 'utf8'), CHECKSUM_OPTIONS))
    }
    if (游标 < 行文本组.length) {
        const 余行组 = 行文本组.slice(游标)
        帧缓冲组.push(zstdCompressSync(Buffer.from(`${余行组.join('\n')}\n`, 'utf8'), CHECKSUM_OPTIONS))
    }
    return Buffer.concat(帧缓冲组)
}

/**
 * 拆出 header 与事件组。
 *
 * 校验器的允许字段里没有 `type`，校验前必须剥掉；事件组的修改是原地的。
 *
 * @param lines - 全部行（首行是 header）。
 */
function splitHeaderAndEvents(lines: unknown[]): { header: Record<string, unknown>; events: unknown[] } {
    const 首行 = lines[0]
    if (首行 === null || typeof 首行 !== 'object' || Array.isArray(首行)) {
        throw new Error('会话文件首行不是 header 对象')
    }

    const header = { ...(首行 as Record<string, unknown>) }
    delete header.type
    return { header, events: lines.slice(1) }
}

/** 读事件的类型名；不是对象或缺 type 时返回 null。 */
function 读事件类型(event: unknown): string | null {
    if (event === null || typeof event !== 'object') return null
    const type = (event as Record<string, unknown>).type
    return typeof type === 'string' ? type : null
}

/** 读事件的 data 记录；不是对象时返回 null。 */
function 读事件数据(event: unknown): Record<string, unknown> | null {
    if (event === null || typeof event !== 'object') return null
    const data = (event as Record<string, unknown>).data
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
    return data as Record<string, unknown>
}

/**
 * 递归展开一个节点下所有指定字段名里的范围编码。
 *
 * 事件形状不保证 `sourceEventSeqs` 一定在 data 顶层，故按对象树递归查找。`[start, end]`
 * 形式的子数组展开成连续数字；无可展开子数组时原样保留。
 *
 * @param node - 待检查的节点。
 * @param 字段名 - 要展开的字段名。
 * @returns 是否真的改动了内容。
 */
function 展开节点内序号范围(node: unknown, 字段名: string): boolean {
    if (node === null || typeof node !== 'object') return false
    if (Array.isArray(node)) {
        let 有改动 = false
        for (const 子项 of node) {
            if (展开节点内序号范围(子项, 字段名)) 有改动 = true
        }
        return 有改动
    }

    const 记录 = node as Record<string, unknown>
    let 有改动 = false
    for (const 当前字段 of Object.keys(记录)) {
        const 字段值 = 记录[当前字段]
        if (当前字段 === 字段名 && Array.isArray(字段值)) {
            const 展开组: unknown[] = []
            let 有展开 = false
            for (const 序号项 of 字段值) {
                const 是范围 = Array.isArray(序号项) && 序号项.length === 2 && 序号项.every((n) => typeof n === 'number')
                if (是范围) {
                    const 起始序号 = 序号项[0] as number
                    const 结束序号 = 序号项[1] as number
                    for (let 序号 = 起始序号; 序号 <= 结束序号; 序号 += 1) 展开组.push(序号)
                    有展开 = true
                    continue
                }
                展开组.push(序号项)
            }
            if (有展开) {
                记录[当前字段] = 展开组
                有改动 = true
            }
            continue
        }
        if (展开节点内序号范围(字段值, 字段名)) 有改动 = true
    }
    return 有改动
}

/**
 * 用「两候选定位」加载平台校验器。
 *
 * 按候选顺序逐个试：解析出入口路径 → 从入口路径派生 `@deepseek-ai` 目录 → 确认目录里有
 * 两个必需包 → 用入口路径建 require 加载 `dsh-session-format-v3-to-v4` 与 `dsh-session`。
 * 一个候选失败就把原因累积成一行文本、继续下一个；两个都失败时把两次原因拼成一条错误抛出。
 *
 * 两个包都是 CJS，用同步 require 加载。pnpm 的符号链接会让「用包入口路径建 createRequire
 * 再 resolve 同级包」失败（真实路径的 node_modules 链里没有同级包的链接），故改为从入口
 * 路径直接派生平台包目录。
 *
 * @param 解析 - 包名到入口路径的解析器；缺省用插件自己的 require。测试注入假的平台包目录。
 */
export function loadPlatformValidator(解析: (包名: string) => string = (包名) => 插件require.resolve(包名)): SessionValidator {
    const 候选组 = [
        { 包名: 首选包名, 说明: `首选包 ${首选包名}` },
        { 包名: 锚点包名, 说明: `锚点包 ${锚点包名}` },
    ]
    const 失败原因组: string[] = []

    for (const 候选 of 候选组) {
        try {
            const 入口路径 = 解析(候选.包名)
            const 路径分段组 = 入口路径.split(sep)
            const 目录索引 = 路径分段组.lastIndexOf('@deepseek-ai')
            if (目录索引 <= 0) throw new Error('无法从平台包路径定位 @deepseek-ai 目录')
            const 平台包目录 = 路径分段组.slice(0, 目录索引 + 1).join(sep)

            for (const 必需包名 of 必需包名组) {
                if (existsSync(join(平台包目录, 必需包名)) === false) throw new Error(`候选目录里没有 ${必需包名}`)
            }

            const 锚点require = createRequire(入口路径)
            const v3to4 = 锚点require(join(平台包目录, 'dsh-session-format-v3-to-v4')) as {
                restoreReleasedV4Artifact: (artifact: unknown, knownTypes: unknown) => void
            }
            const session模块 = 锚点require(join(平台包目录, 'dsh-session')) as { KNOWN_SESSION_EVENT_TYPES: unknown }

            return {
                validate: (header, events) => {
                    v3to4.restoreReleasedV4Artifact(
                        { header, events, inheritedEventCount: 0 },
                        session模块.KNOWN_SESSION_EVENT_TYPES,
                    )
                },
            }
        } catch (err) {
            失败原因组.push(`${候选.说明}：${错误文本(err)}`)
            continue
        }
    }

    throw new Error(`定位平台包目录失败 —— ${失败原因组.join('；')}`)
}

/**
 * 跑一次校验，并把平台校验器的失败原因原样带回。
 *
 * @param 校验器 - 平台或注入的校验器。
 * @param header - 剥掉 type 的 header。
 * @param events - 事件组。
 * @returns 通过时为 `{ 通过: true, 原因: '' }`；失败时原因 = 平台抛出的异常文本。
 */
function 跑校验(校验器: SessionValidator, header: Record<string, unknown>, events: unknown[]): { 通过: boolean; 原因: string } {
    try {
        校验器.validate(header, events)
        return { 通过: true, 原因: '' }

    } catch (err) {
        return { 通过: false, 原因: 错误文本(err) }
    }
}

/** 把异常转成一行文本。 */
function 错误文本(err: unknown): string {
    if (err instanceof Error) return err.message
    return String(err)
}
