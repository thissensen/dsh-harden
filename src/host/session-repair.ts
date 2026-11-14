/**
 * 会话修复模块 —— 扫描会话文件、读完先归一、判定好坏、在内存里修已知的损坏形态（重试链规范化）、
 * 过平台校验才落盘。
 *
 * **背景。** 会话持久化文件是「多帧 zstd 串联」的 JSONL：首行是 `type: "session"` 的
 * header，其余每行一条会话事件。平台读取时会用 `restoreReleasedV4Artifact` 做一次严格
 * 校验，遇到损坏形态会整份拒读。两份输入要区别对待：
 *
 * - **`sourceEventSeqs` 的序号范围编码是合法存储形态，不是损坏。** 平台把连续段（≥3 条）编码成
 *   `[start, end]` 写进 JSONL，读路径先 `decodeSeqRanges(value, event.seq)` 展开再交给校验器；
 *   校验器本身只认扁平整数。我们拿 JSONL 原始行直接校验，所以首检不过时要先补上这一步再判一次
 *   （`expandSourceEventSeqs`）——照原始行直接判会把平台自己写出的合法文件判成损坏，每次扫描都
 *   白重写一遍。
 * - **重试链异常是损坏**：同一 policy chain（turn + step + provider + policyKey 四元组）内 retry
 *   编号重复或跳号、整条链的 retryId 不一致，或者序号重排后 `normal` 模式的 `maxRetries`
 *   不够用。这种形态的来源是平台自带重试器写出重复的序号（校验报
 *   llm/retry skips its policy attempt sequence）与本插件早期版本的兜底重试每次换新 id
 *   （校验报 llm/retry must keep one retryId per policy chain）。
 *
 * 本模块在**内存里**修好重试链（交给 `retry-chain-ledger.ts` 的重试链账本：同链 retry 编号按出现
 * 顺序重排 1..n、整链 retryId 归并成第一条、配对的 `llm/retry-started` 按 (retryId, retry) 同步
 * 改写，并把 `normal` 模式的 `maxRetries` 抬到不小于本条序号——真机样本 `dfd3eb08…` 同链两条
 * `retry = 1` 且 `maxRetries = 1`，序号重排成 2 后不改它仍会被平台拒）。只有**修完再校验通过**
 * 才写回磁盘；写回只重新序列化被改写过的行（其余行原样拼回），用「临时文件 + fsync + rename」
 * 原子替换，任何一步失败都不落盘。展开有单条范围上界（`SEQ_RANGE_MAX_SPAN`）与整份日志的累计
 * 上界（`SEQ_RANGE_MAX_TOTAL`）：损伤值跨 5E7 时不展开、报「修不了」，免得同步卡住宿主进程。
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
定位与加载收敛在 `加载平台包组`（`plugin-record.ts` 的 `plugin:` 记录通道复用它，只换目标包名）。
 *
 * @module dsh-harden/session-repair
 */

import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { existsSync } from 'node:fs'
import { open, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'

import { errText } from './shared-format.js'
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
export const 锚点包名 = '@deepseek-ai/dsh-agent'

/** 派生出的平台包目录里必须同时存在的两个包，见 `.harness/05-坑册.md` 坑 22。 */
const 必需包名组 = ['dsh-session-format-v3-to-v4', 'dsh-session']

/** 插件模块自己的 require；平台包按 peerDependencies 的链接关系解析。 */
const 插件require = createRequire(import.meta.url)

/** 修复结果的状态。 */
export type RepairStatus = 'intact' | 'repaired' | 'unrepairable' | 'read-failed'

/**
 * 实际改动的类别。
 *
 * 重试链规范化是唯一的修复类别：序号范围编码是平台自己的合法存储形态，展开只是读路径归一，
 * 不算「改动」。
 */
export type RepairCategory = 'retry-chain-normalized'

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
    /** 每行的原始文本（写回时未改动的行原样拼回，避免 JSON 往返改写数字字面量）。 */
    行文本组: string[]
    /** 每一帧的明文行数，编码时按它重新切帧。 */
    frameLineCounts: number[]
}

/** 判断「读到的还是不是磁盘上那份」用的签名：大小 + mtime。 */
interface 文件签名 {
    大小: number
    修改时间: number
}

/**
 * 读文件签名。
 *
 * @param 文件路径 - 会话文件路径。
 */
async function 获取文件签名(文件路径: string): Promise<文件签名> {
    const info = await stat(文件路径)
    return { 大小: info.size, 修改时间: info.mtimeMs }
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
 * 流程：读文件 → 解码帧 → 拆 header/事件 → 平台校验 → 好则报「无需修复」；不过时先展开序号范围
 * 编码（平台读路径的等价物）再判一次，仍不过才做重试链规范化 → 改后再校验 → 过了才写回，不过则
 * 不落盘。校验不通过时把平台的原话带进 reason，便于判断损坏形态。写回前比对文件签名：读完之后被
 * 平台改写过就不落盘（否则等于把读时快照盖回去、丢掉新事件）。
 *
 * 读、解码、拆解任一步失败都只算**这一个文件**失败（报 read-failed，异常不外抛）——异常逃出去
 * 会让整个扫描端点 400 空响应，一个坏文件把其余会话全拖下水。
 *
 * @param 文件路径 - 会话文件路径。
 * @param 校验器 - 可注入的校验器；缺省时用两候选定位加载的平台校验器。
 * @returns 修复结果。
 */
export async function repairSessionFile(文件路径: string, 校验器?: SessionValidator): Promise<RepairOutcome> {
    let 文件内容: Buffer
    let 读取前签名: 文件签名
    try {
        读取前签名 = await 获取文件签名(文件路径)
        文件内容 = await readFile(文件路径)

    } catch (err) {
        return { filePath: 文件路径, status: 'read-failed', reason: `读取失败：${errText(err)}`, changedCategories: [] }
    }

    let 解码结果: DecodedSession
    try {
        解码结果 = decodeSessionFile(文件内容)

    } catch (err) {
        return { filePath: 文件路径, status: 'read-failed', reason: `解码失败：${errText(err)}`, changedCategories: [] }
    }

    let 拆解结果: { header: Record<string, unknown>; events: unknown[] }
    try {
        拆解结果 = splitHeaderAndEvents(解码结果.lines)

    } catch (err) {
        return { filePath: 文件路径, status: 'read-failed', reason: `解析失败：${errText(err)}`, changedCategories: [] }
    }

    let 实际校验器: SessionValidator
    try {
        实际校验器 = 校验器 ?? loadPlatformValidator()

    } catch (err) {
        return { filePath: 文件路径, status: 'unrepairable', reason: `平台校验器不可用：${errText(err)}`, changedCategories: [] }
    }

    const 首检 = 跑校验(实际校验器, 拆解结果.header, 拆解结果.events)
    if (首检.通过) {
        return { filePath: 文件路径, status: 'intact', reason: '校验通过，无需修复', changedCategories: [] }
    }

    // 平台把 sourceEventSeqs 的连续段编码成 [start, end] 存进 JSONL，读路径先 decode 再交给校验器；
    // 校验器自己只认扁平整数。照原始行直接判会把平台自己写出的合法文件判成损坏（每次扫描都白重写），
    // 所以首检不过时补上这一步再判一次。
    const 展开结果 = expandSourceEventSeqs(拆解结果.events)
    if (展开结果.放弃原因 !== null) {
        return {
            filePath: 文件路径,
            status: 'unrepairable',
            reason: `修不了：${展开结果.放弃原因}`,
            changedCategories: [],
        }
    }

    const 展开后首检 = 展开结果.有改动 ? 跑校验(实际校验器, 拆解结果.header, 拆解结果.events) : 首检
    if (展开后首检.通过) {
        return { filePath: 文件路径, status: 'intact', reason: '校验通过，无需修复', changedCategories: [] }
    }

    const 改动事件下标组 = normalizeRetryChain(拆解结果.events)
    if (改动事件下标组.length === 0) {
        return {
            filePath: 文件路径,
            status: 'unrepairable',
            reason: `校验失败（${展开后首检.原因}），且不属于已知的可修类别`,
            changedCategories: [],
        }
    }

    const 改动类别组: RepairCategory[] = ['retry-chain-normalized']

    const 复检 = 跑校验(实际校验器, 拆解结果.header, 拆解结果.events)
    if (复检.通过 === false) {
        return {
            filePath: 文件路径,
            status: 'unrepairable',
            reason: `修复后仍未通过校验（已改：${改动类别组.join('、')}）：${复检.原因}`,
            changedCategories: [],
        }
    }

    // 只重新序列化被改写的行：JSON 往返会把 >2^53 的整数、特殊数字写法改写成另一种文本，
    // 未改动的行必须原样拼回，磁盘字节才保真。events 是 lines.slice(1)，事件下标 + 1 即行下标。
    const 行文本组 = [...解码结果.行文本组]
    for (const index of 改动事件下标组) 行文本组[index + 1] = JSON.stringify(拆解结果.events[index])
    const 写回字节 = encodeSessionFile(行文本组, 解码结果.frameLineCounts)

    // 平台写手是逐批 open→write→fsync→close（句柄只存在几毫秒），rename 未必撞 EPERM；
    // 读完之后它可能又追加了事件，此时把读时快照盖回去就是丢事件、seq 断档，会话永久打不开。
    // 比对放在编码之后、写临时文件之前：编码是最耗时的一步，此后只剩几毫秒的窗口。
    const 写回前签名 = await 获取文件签名(文件路径)
    const 是否未变 = 写回前签名.大小 === 读取前签名.大小 && 写回前签名.修改时间 === 读取前签名.修改时间
    if (是否未变 === false) {
        return {
            filePath: 文件路径,
            status: 'read-failed',
            reason: '会话文件在修复期间被改写（会话可能仍活跃），已放弃写回',
            changedCategories: [],
        }
    }

    // 临时名带随机后缀：两次点击或两个标签页并发修同一个文件时不能共用同一个临时路径。
    const 临时路径 = `${文件路径}.${randomBytes(6).toString('hex')}.tmp`
    try {
        // 平台自己写盘是写穿 + 每批 sync；不 fsync 就 rename，掉电可能留下 0 字节的会话文件。
        const 句柄 = await open(临时路径, 'w')
        try {
            await 句柄.writeFile(写回字节)
            await 句柄.sync()

        } finally {
            await 句柄.close()
        }
        await rename(临时路径, 文件路径)

    } catch (err) {
        try {
            // force: true 已吞掉「文件不存在」；走到这里只能是句柄占用一类的清理失败。
            await rm(临时路径, { force: true })

        } catch {
            // 清理是尽力而为：残留一个临时文件，比盖掉真正的失败原因轻。
        }

        return { filePath: 文件路径, status: 'unrepairable', reason: `写回失败：${errText(err)}`, changedCategories: [] }
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
 * @returns 被改写的事件下标组（空数组 = 没改动）；写回时按它决定哪些行需要重新序列化。
 */
export function normalizeRetryChain(events: unknown[]): number[] {
    // 账本有状态：修一份新日志必须换一个新实例。
    const 账本 = new 重试链账本()
    const 改动下标组: number[] = []

    for (const [index, event] of events.entries()) {
        const 类型 = 读事件类型(event)
        if (类型 !== 'llm/retry' && 类型 !== 'llm/retry-started') continue
        const data = 读事件数据(event)
        if (data === null) continue

        const 结论 = 类型 === 'llm/retry' ? 账本.归一重试事件(data) : 账本.归一启动事件(data)
        if (结论 === null || 结论.有改动 === false) continue

        data.retryId = 结论.retryId
        data.retry = 结论.retry
        if (结论.maxRetries !== undefined) data.maxRetries = 结论.maxRetries
        改动下标组.push(index)
    }

    return 改动下标组
}

/** 单条序号范围的展开上界：损伤值可能跨 5E7，展开会同步阻塞整个宿主进程。 */
const SEQ_RANGE_MAX_SPAN = 100_000

/** 整份日志的累计展开上界（与单条同口径）：N 条各跨 10 万时总量无界，同样会卡住宿主进程。 */
const SEQ_RANGE_MAX_TOTAL = 100_000

/** 一次展开用的累计预算（跨事件、跨字段共享）。 */
interface 展开预算 {
    剩余条数: number
}

/** 序号范围展开的结果。 */
export interface SeqsExpandOutcome {
    /** 是否真的改动了内容。 */
    有改动: boolean
    /** 遇到跨度过大的范围时的原因（拿不准就不落盘）；没有就是 null。 */
    放弃原因: string | null
}

/**
 * 序号范围编码展开：遍历所有事件，把 `sourceEventSeqs` 里的 `[start, end]` 展开成扁平数字。
 *
 * 范围跨度超过 `SEQ_RANGE_MAX_SPAN`、或整份日志累计超过 `SEQ_RANGE_MAX_TOTAL` 时立刻带原因
 * 返回，不展开——损伤值展开 5E7 个数会同步卡住宿主事件循环，比「修不了」严重得多。
 *
 * @param events - 会话事件组（会被原地修改）。
 * @returns 展开结果：是否改了内容，以及遇到跨度过大的范围时放弃的原因。
 */
export function expandSourceEventSeqs(events: unknown[]): SeqsExpandOutcome {
    const 预算: 展开预算 = { 剩余条数: SEQ_RANGE_MAX_TOTAL }
    let 有改动 = false
    for (const event of events) {
        const 子结果 = 展开节点内序号范围(event, 'sourceEventSeqs', 预算)
        if (子结果.放弃原因 !== null) return 子结果
        if (子结果.有改动) 有改动 = true
    }
    return { 有改动, 放弃原因: null }
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
 * 每帧独立解压，明文按顺序拼接后按换行切行；同时记下每帧的明文行数与每行的原始文本——前者让
 * 编码时按相同行数还原帧结构（修复只改字段值、不改行数），后者让未改动的行原样拼回。
 *
 * @param content - 会话文件原始字节。
 */
function decodeSessionFile(content: Buffer): DecodedSession {
    const { frames, tornStart } = scanZstdFrames(content)
    if (tornStart !== null) throw new Error(`会话文件末尾残缺（第 ${tornStart} 字节起）`)

    const lines: unknown[] = []
    const 行文本组: string[] = []
    const frameLineCounts: number[] = []
    for (const frame of frames) {
        const plainText = zstdDecompressSync(content.subarray(frame.start, frame.end)).toString('utf8')
        const 分段组 = plainText.split('\n')
        if (分段组[分段组.length - 1] === '') 分段组.pop()
        for (const line of 分段组) {
            lines.push(JSON.parse(line))
            行文本组.push(line)
        }
        frameLineCounts.push(分段组.length)
    }
    return { lines, 行文本组, frameLineCounts }
}

/**
 * 把行文本组编码回多帧 zstd。
 *
 * 按解码时记录的每帧行数切分，每一帧都带 checksum，帧边界与原文件一致。行数对不上时把
 * 余下所有行压成最后一帧（兜底，正常不会走到）。只收文本：改动的行由调用方重新序列化，
 * 未改动的行原样拼回。
 *
 * @param 行文本组 - 全部行的文本（含 header）。
 * @param frameLineCounts - 每帧明文行数。
 */
function encodeSessionFile(行文本组: string[], frameLineCounts: number[]): Buffer {
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
 * 形式的子数组展开成连续数字；无可展开子数组时原样保留。遇到跨度过大的范围立刻带原因返回，
 * 由递归各层原样上抛——继续展开其余字段没有意义，调用方拿不准就不落盘。
 *
 * @param node - 待检查的节点。
 * @param 字段名 - 要展开的字段名。
 * @param 预算 - 本次展开的累计条数预算（跨事件共享，展开时扣减）。
 * @returns 展开结果：是否真的改动了内容，以及放弃原因。
 */
function 展开节点内序号范围(node: unknown, 字段名: string, 预算: 展开预算): SeqsExpandOutcome {
    if (node === null || typeof node !== 'object') return { 有改动: false, 放弃原因: null }
    if (Array.isArray(node)) {
        let 有改动 = false
        for (const 子项 of node) {
            const 子结果 = 展开节点内序号范围(子项, 字段名, 预算)
            if (子结果.放弃原因 !== null) return 子结果
            if (子结果.有改动) 有改动 = true
        }
        return { 有改动, 放弃原因: null }
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
                    const 跨度 = 结束序号 - 起始序号 + 1
                    if (跨度 > SEQ_RANGE_MAX_SPAN) {
                        return {
                            有改动: false,
                            放弃原因: `sourceEventSeqs 的序号范围 [${起始序号}, ${结束序号}] 跨度过大（上限 ${SEQ_RANGE_MAX_SPAN}），展开会卡住进程`,
                        }
                    }
                    if (跨度 > 预算.剩余条数) {
                        return {
                            有改动: false,
                            放弃原因: `sourceEventSeqs 的累计跨度超过上限（${SEQ_RANGE_MAX_TOTAL} 条），展开会卡住进程`,
                        }
                    }
                    预算.剩余条数 -= 跨度
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
        const 子结果 = 展开节点内序号范围(字段值, 字段名, 预算)
        if (子结果.放弃原因 !== null) return 子结果
        if (子结果.有改动) 有改动 = true
    }
    return { 有改动, 放弃原因: null }
}

/** 一个平台包候选：从它出发能定位到平台的 `@deepseek-ai` 目录。 */
export interface 平台包候选 {
    /** 候选包名（完整 scope 名）。 */
    包名: string
    /** 定位失败时写进错误原因的说明，如「首选包 @deepseek-ai/…」。 */
    说明: string
}

/**
 * 两候选定位并加载平台包组。
 *
 * 按候选顺序逐个试：解析出入口路径 → 从入口路径派生 `@deepseek-ai` 目录 → 确认目录里有全部必需包
 * → 用入口路径建 require 加载它们。一个候选的任一步失败就把原因累积成一行文本、继续下一个；全部候选
 * 都失败时把原因拼成一条错误抛出。定位结果**不写死任何安装位置**。
 *
 * 包都是 CJS，用同步 require 加载。pnpm 的符号链接会让「用包入口路径建 createRequire 再 resolve 同级
 * 包」失败（真实路径的 node_modules 链里没有同级包的链接），故改为从入口路径直接派生平台包目录（坑 22）。
 *
 * `loadPlatformValidator`（校验器）与 `plugin-record.ts`（`plugin:` 记录通道）共用这一段。
 *
 * @param 必需包名组 - 派生出的 `@deepseek-ai` 目录下必须存在、且要加载的一级目录名（不是完整包名），
 *   同时是返回映射的键——混成完整包名会去查 `@deepseek-ai/@deepseek-ai/…`，永远找不到。
 * @param 候选组 - 按顺序试的候选包。
 * @param 解析 - 包名到入口路径的解析器；缺省用插件自己的 require。测试注入假的平台包目录。
 * @returns 包名 → 模块对象的映射。
 */
export function 加载平台包组(
    必需包名组: readonly string[],
    候选组: readonly 平台包候选[],
    解析: (包名: string) => string = (包名) => 插件require.resolve(包名),
): Record<string, unknown> {
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

            const 加载 = createRequire(入口路径)
            const 包组: Record<string, unknown> = {}
            for (const 必需包名 of 必需包名组) {
                包组[必需包名] = 加载(join(平台包目录, 必需包名))
            }

            return 包组

        } catch (err) {
            失败原因组.push(`${候选.说明}：${errText(err)}`)
            continue
        }
    }

    throw new Error(`定位平台包目录失败 —— ${失败原因组.join('；')}`)
}

/**
 * 用「两候选定位」加载平台校验器。
 *
 * 候选一是持久化包（插件装进 profile 内时是同级依赖）、候选二是锚点 `dsh-agent`（`link:` 装法下只有它
 * 被链进插件，见坑 27）；定位与加载的细节在 `加载平台包组`。
 *
 * @param 解析 - 包名到入口路径的解析器；缺省用插件自己的 require。测试注入假的平台包目录。
 */
export function loadPlatformValidator(解析: (包名: string) => string = (包名) => 插件require.resolve(包名)): SessionValidator {
    const 候选组: 平台包候选[] = [
        { 包名: 首选包名, 说明: `首选包 ${首选包名}` },
        { 包名: 锚点包名, 说明: `锚点包 ${锚点包名}` },
    ]
    const 包组 = 加载平台包组(必需包名组, 候选组, 解析)

    const v3to4 = 包组['dsh-session-format-v3-to-v4'] as {
        restoreReleasedV4Artifact: (artifact: unknown, knownTypes: unknown) => void
    }
    const session模块 = 包组['dsh-session'] as { KNOWN_SESSION_EVENT_TYPES: unknown }

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
        return { 通过: false, 原因: errText(err) }
    }
}
