/**
 * 会话修复模块 —— 扫描会话文件、判定好坏、内存修复两类已知损坏、过校验才落盘。
 *
 * **背景。** 会话持久化文件是「多帧 zstd 串联」的 JSONL：首行是 `type: "session"` 的
 * header，其余每行一条会话事件。平台读取时会用 `restoreReleasedV4Artifact` 做一次严格
 * 校验，遇到两类已知损坏会整份拒读：
 *
 * - **A 类（retryId 不一致）**：同一 policy chain（turn + step + provider + policyKey
 *   四元组）内的 `llm/retry` 与 `llm/retry-started` 必须共享同一个 retryId；插件兜底
 *   重试时若换了 id，校验就拒。
 * - **B 类（sourceEventSeqs 范围编码）**：`sourceEventSeqs` 里允许写 `[start, end]`
 *   形式的子数组；校验器只认扁平数字，遇到范围就不解码。
 *
 * 本模块在**内存里**修好这两类损坏，只有**修完再校验通过**才写回磁盘；写回用「临时文件 +
 * rename」原子替换，任何一步失败都不落盘。
 *
 * **平台包用锚点解析。** 三个平台包（持久化 jsonl / v3-to-v4 格式 / session 事件表）不写死
 * 绝对路径：先由插件入口 resolve 出 `dsh-session-persistence-jsonl`，再从它的入口路径派生
 * 出 `@deepseek-ai` 目录，按同级包名取绝对路径。平台包只在真正要校验时才加载——开发与 CI
 * 环境没有它们，顶层静态 import 会让整个模块挂掉。
 *
 * @module dsh-harden/session-repair
 */

import { createRequire } from 'node:module'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'

/** 会话文件名。 */
const SESSION_FILE_NAME = 'session.v4.jsonl.zstd'

/** zstd 帧魔数（小端读出等于它才是帧起点）。 */
const ZSTD_FRAME_MAGIC = 4247762216

/** 每帧带 xxhash64 校验和的压缩选项。 */
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

/** 修复结果的状态。 */
export type RepairStatus = 'intact' | 'repaired' | 'unrepairable' | 'read-failed'

/** 实际改动的类别。 */
export type RepairCategory = 'retryId-merged' | 'sourceEventSeqs-expanded'

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
 * 流程：读文件 → 解码帧 → 拆 header/事件 → 平台校验 → 好则报「无需修复」，坏则尝试
 * A/B 两类修复 → 改后再校验 → 过了才写回，不过则不落盘。
 *
 * @param 文件路径 - 会话文件路径。
 * @param 校验器 - 可注入的校验器；缺省时用锚点解析出的平台校验器。
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

    if (isValid(实际校验器, header, events)) {
        return { filePath: 文件路径, status: 'intact', reason: '校验通过，无需修复', changedCategories: [] }
    }

    const 改动类别组: RepairCategory[] = []
    if (mergeRetryIds(events)) 改动类别组.push('retryId-merged')
    if (expandSourceEventSeqs(events)) 改动类别组.push('sourceEventSeqs-expanded')

    if (改动类别组.length === 0) {
        return { filePath: 文件路径, status: 'unrepairable', reason: '校验失败，但不属于已知的两类损坏', changedCategories: [] }
    }

    if (isValid(实际校验器, header, events) === false) {
        return {
            filePath: 文件路径,
            status: 'unrepairable',
            reason: `修复后仍未通过校验（已改：${改动类别组.join('、')}）`,
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
 * A 类修复：把同一 policy chain 内的 retryId 归并成该链第一条 `llm/retry` 的。
 *
 * 两遍扫描：先按 chain 记下第一条 `llm/retry` 的 retryId 作为规范值，再改写该 chain 下
 * 所有 `llm/retry` 与 `llm/retry-started` 的 retryId。同一 chain 的 `retry-started`
 * 与 `retry` 共享 chain 键（turn/step/provider/policyKey），按 chain 改写即等于按
 * retryId+retry 配对同步。
 *
 * @param events - 会话事件组（会被原地修改）。
 * @returns 是否真的改动了内容。
 */
export function mergeRetryIds(events: unknown[]): boolean {
    const 规范编号组 = new Map<string, string>()
    for (const event of events) {
        if (读事件类型(event) !== 'llm/retry') continue
        const data = 读事件数据(event)
        if (data === null) continue
        const 链键 = 构造重试链键(data)
        if (链键 === null) continue
        const 编号 = 读文本字段(data, 'retryId')
        if (编号 === null) continue
        if (规范编号组.has(链键) === false) 规范编号组.set(链键, 编号)
    }

    let 有改动 = false
    for (const event of events) {
        const 类型 = 读事件类型(event)
        if (类型 !== 'llm/retry' && 类型 !== 'llm/retry-started') continue
        const data = 读事件数据(event)
        if (data === null) continue
        const 链键 = 构造重试链键(data)
        if (链键 === null) continue
        const 规范编号 = 规范编号组.get(链键)
        if (规范编号 === undefined) continue
        if (读文本字段(data, 'retryId') === 规范编号) continue
        data.retryId = 规范编号
        有改动 = true
    }
    return 有改动
}

/**
 * B 类修复：遍历所有事件，把 `sourceEventSeqs` 里的 `[start, end]` 展开成扁平数字。
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

/** 从 data 里读一个字符串字段；类型不符时返回 null。 */
function 读文本字段(data: Record<string, unknown>, 字段名: string): string | null {
    const value = data[字段名]
    return typeof value === 'string' ? value : null
}

/** 构造 policy chain 的键：turn + step + provider + policyKey，缺一返回 null。 */
function 构造重试链键(data: Record<string, unknown>): string | null {
    const turn = data.turn
    const step = data.step
    const provider = data.provider
    const policyKey = data.policyKey
    if (typeof turn !== 'number' || typeof step !== 'number') return null
    if (typeof provider !== 'string' || typeof policyKey !== 'string') return null
    return `${turn}|${step}|${provider}|${policyKey}`
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
 * 用锚点解析加载平台校验器。
 *
 * 先由插件入口 resolve 出持久化包，再从它的入口路径派生出 `@deepseek-ai` 目录，按同级包名
 * 取绝对路径加载 `dsh-session-format-v3-to-v4` 与 `dsh-session`。两个包都是 CJS，用同步
 * require 加载。
 *
 * pnpm 的符号链接会让「用持久化包路径建 createRequire 再 resolve 同级包」失败（真实路径的
 * node_modules 链里没有同级包的链接），故改为从入口路径直接派生平台包目录。
 */
function loadPlatformValidator(): SessionValidator {
    const 插件require = createRequire(import.meta.url)
    const 持久化包路径 = 插件require.resolve('@deepseek-ai/dsh-session-persistence-jsonl')
    const 路径分段组 = 持久化包路径.split(sep)
    const 目录索引 = 路径分段组.lastIndexOf('@deepseek-ai')
    if (目录索引 <= 0) throw new Error('无法从平台包路径定位 @deepseek-ai 目录')
    const 平台包目录 = 路径分段组.slice(0, 目录索引 + 1).join(sep)
    const 锚点require = createRequire(持久化包路径)

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
}

/**
 * 跑一次校验。
 *
 * @param 校验器 - 平台或注入的校验器。
 * @param header - 剥掉 type 的 header。
 * @param events - 事件组。
 * @returns 通过返回 true，抛异常返回 false。
 */
function isValid(校验器: SessionValidator, header: Record<string, unknown>, events: unknown[]): boolean {
    try {
        校验器.validate(header, events)
        return true

    } catch {
        return false
    }
}

/** 把异常转成一行文本。 */
function 错误文本(err: unknown): string {
    if (err instanceof Error) return err.message
    return String(err)
}
