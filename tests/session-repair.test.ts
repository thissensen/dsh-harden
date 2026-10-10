/**
 * 会话修复模块的持久化测试。
 *
 * 被测对象是 `src/host/session-repair.ts`：
 * - 纯函数 `normalizeRetryChain()`（重试链规范化：同链 retry 序号重排成 1..n + 同链共用
 *   一个 retryId + `normal` 模式的 maxRetries 抬到不小于本条序号）与
 *   `expandSourceEventSeqs()`（序号范围编码展开）——直接验证改动结果；
 * - 完整流程 `repairSessionFile()`——注入模拟平台校验器，用真实 zstd 文件验证
 *   「无需修复 / 已修复 / 修不了 / 读取失败」四态与落盘行为。
 *
 * 判定逻辑已下沉到 `src/host/retry-chain-ledger.ts` 的重试链账本，本文件只管修复器这一层。
 *
 * @module dsh-harden/tests/session-repair
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { expandSourceEventSeqs, loadPlatformValidator, normalizeRetryChain, repairSessionFile, scanSessionFiles } from '../src/host/session-repair.js'
import type { SessionValidator } from '../src/host/session-repair.js'

/** 与模块内一致的带 checksum 压缩选项（测试造文件用）。 */
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

/** 构造一条 llm/retry 事件。 */
function 重试事件(turn: number, step: number, provider: string, policyKey: string, retryId: string, retry: number): unknown {
    return { type: 'llm/retry', data: { turn, step, provider, policyKey, retryId, retry } }
}

/** 构造一条 llm/retry-started 事件——真机形状：不带 provider/policyKey，平台只按 (retryId, retry) 配对。 */
function 重试启动事件(turn: number, step: number, retryId: string, retry: number): unknown {
    return { type: 'llm/retry-started', data: { retryId, turn, step, retry } }
}

/**
 * 构造一条真机形状的 llm/retry 事件：带 mode / maxRetries，用来覆盖第 4 条不变量
 * （坐标取真机样本 dfd3eb08… 的 turn 1 / step 7 / provider command-code）。
 */
function 带限额重试事件(retryId: string, retry: number, maxRetries: number): unknown {
    return {
        type: 'llm/retry',
        data: {
            turn: 1,
            step: 7,
            provider: 'command-code',
            policyKey: '["normal",1,[],500,10000,0.1]',
            mode: 'normal',
            retryId,
            retry,
            maxRetries,
        },
    }
}

/** 构造一条带 sourceEventSeqs 的事件。 */
function 序号事件(序号组: unknown[]): unknown {
    return { type: 'assistant/message', data: { turn: 1, step: 1, sourceEventSeqs: 序号组 } }
}

/** 把事件组编码成多帧 zstd 会话文件字节。 */
function 编码会话文件(行组: unknown[]): Buffer {
    return zstdCompressSync(Buffer.from(`${行组.map((行) => JSON.stringify(行)).join('\n')}\n`, 'utf8'), CHECKSUM_OPTIONS)
}

/** 把会话文件字节解回行数组（本文件的用例都只写单帧，故可整体解压）。 */
function 解码会话文件(内容: Buffer): unknown[] {
    return zstdDecompressSync(内容)
        .toString('utf8')
        .split('\n')
        .filter((行) => 行 !== '')
        .map((行) => JSON.parse(行))
}

/**
 * 模拟平台校验器：同链 retryId 不一致、同链 retry 序号不连续、llm/retry-started 配不上既存的
 * llm/retry（或坐标不符、重复配对）、`normal` 模式的 maxRetries 缺失或不够用（`always` 模式
 * 反而带了它）、sourceEventSeqs 含子数组——五条规则都拒。
 *
 * 规则形状逐条对照平台源码（`dsh-session-persistence-jsonl` 的 `assertReleasedPayloadSemantics()`
 * 的 llm/retry 分支与 `Relationships.retry()`）：假校验器不认真机写出的形态时，会出现「测试全绿
 * 但真机修不好」，所以平台新增不变量必须同步补进来。
 */
function 模拟平台校验(header: unknown, events: unknown[]): void {
    const 规范编号组 = new Map<string, string>()
    const 重试序号组 = new Map<string, number>()
    const 已调度组: { retryId: unknown; retry: unknown; turn: unknown; step: unknown }[] = []
    const 已配对组 = new Set<string>()

    for (const 事件 of events) {
        const 记录 = 事件 as { type?: string; data?: Record<string, unknown> }
        if (记录.type !== 'llm/retry' && 记录.type !== 'llm/retry-started') continue
        const data = 记录.data ?? {}

        if (记录.type === 'llm/retry-started') {
            const 配对条目 = 已调度组.find((条目) => 条目.retryId === data.retryId && 条目.retry === data.retry)
            if (配对条目 === undefined) throw new Error('llm/retry-started pairs no prior scheduled attempt')
            if (配对条目.turn !== data.turn || 配对条目.step !== data.step) throw new Error('llm/retry-started changes scheduled coordinates')
            const 配对键 = `${data.retryId}|${data.retry}`
            if (已配对组.has(配对键)) throw new Error('llm/retry-started repeats one scheduled attempt')
            已配对组.add(配对键)
            continue
        }

        const 链键 = `${data.turn}|${data.step}|${data.provider}|${data.policyKey}`
        if (规范编号组.has(链键) === false) 规范编号组.set(链键, String(data.retryId))
        else if (规范编号组.get(链键) !== data.retryId) throw new Error('retryId 不一致')

        const 期望序号 = (重试序号组.get(链键) ?? 0) + 1
        if (data.retry !== 期望序号) throw new Error('retry 序号不连续')
        重试序号组.set(链键, 期望序号)
        已调度组.push({ retryId: data.retryId, retry: data.retry, turn: data.turn, step: data.step })

        // 第 4 条不变量：normal 模式必带够用的 maxRetries，always 模式必须不带。
        if (data.mode === 'normal') {
            const 最大值 = data.maxRetries
            if (typeof 最大值 !== 'number' || Number.isInteger(最大值) === false || 最大值 < 1) {
                throw new Error('llm/retry maxRetries 必须是正整数')
            }
            if (data.retry > 最大值) throw new Error('llm/retry retry exceeds maxRetries')

        } else if (data.mode === 'always' && data.maxRetries !== void 0) {
            throw new Error('llm/retry always mode must omit maxRetries')
        }
    }

    for (const 事件 of events) {
        const data = (事件 as { data?: Record<string, unknown> }).data ?? {}
        const 序号组 = data.sourceEventSeqs
        if (Array.isArray(序号组) === false) continue
        for (const 项 of 序号组) {
            if (Array.isArray(项)) throw new Error('sourceEventSeqs 含范围编码')
        }
    }
}

/** 注入用的校验器包装。 */
function 用假校验器(): SessionValidator {
    return { validate: 模拟平台校验 }
}

describe('normalizeRetryChain（重试链规范化）', () => {
    it('同链不同 retryId 归并成第一条', () => {
        const 事件组 = [
            重试事件(1, 1, 'p', 'k', 'id-1', 1),
            重试启动事件(1, 1, 'id-1', 1),
            重试事件(1, 1, 'p', 'k', 'id-2', 2),
            重试启动事件(1, 1, 'id-2', 2),
        ]

        expect(normalizeRetryChain(事件组)).toBe(true)
        const 编号组 = 事件组.map((事件) => (事件 as { data: { retryId: string } }).data.retryId)
        expect(编号组).toEqual(['id-1', 'id-1', 'id-1', 'id-1'])
    })

    it('配对的 llm/retry-started 同步归并', () => {
        const 事件组 = [重试事件(2, 3, 'xkiro', 'policy-a', 'first', 1), 重试启动事件(2, 3, 'second', 1)]

        normalizeRetryChain(事件组)
        expect((事件组[1] as { data: { retryId: string } }).data.retryId).toBe('first')
    })

    it('已一致时不改动', () => {
        const 事件组 = [重试事件(1, 1, 'p', 'k', 'id-1', 1), 重试启动事件(1, 1, 'id-1', 1)]

        expect(normalizeRetryChain(事件组)).toBe(false)
    })

    it('不同链互不影响', () => {
        const 事件组 = [
            重试事件(1, 1, 'p', 'k', 'id-a', 1),
            重试事件(1, 2, 'p', 'k', 'id-b', 1),
            重试事件(1, 1, 'p', 'k', 'id-x', 2),
        ]

        normalizeRetryChain(事件组)
        expect((事件组[1] as { data: { retryId: string } }).data.retryId).toBe('id-b')
        expect((事件组[2] as { data: { retryId: string } }).data.retryId).toBe('id-a')
    })

    it('缺字段的事件被跳过、不报错', () => {
        const 事件组 = [{ type: 'llm/retry', data: { turn: 1 } }, { type: 'tool/call', data: {} }]

        expect(normalizeRetryChain(事件组)).toBe(false)
    })

    it('同链序号重复（1,1）被重排成 1,2 且 id 归并', () => {
        const 事件组 = [
            重试事件(1, 1, 'p', 'k', 'id-1', 1),
            重试启动事件(1, 1, 'id-1', 1),
            重试事件(1, 1, 'p', 'k', 'id-2', 1),
            重试启动事件(1, 1, 'id-2', 1),
        ]

        expect(normalizeRetryChain(事件组)).toBe(true)
        const 编号组 = 事件组.map((事件) => (事件 as { data: { retryId: string } }).data.retryId)
        expect(编号组).toEqual(['id-1', 'id-1', 'id-1', 'id-1'])
        const 序号组 = 事件组.map((事件) => (事件 as { data: { retry: number } }).data.retry)
        expect(序号组).toEqual([1, 1, 2, 2])
    })

    it('链内跳号（1,3）重排成 1,2', () => {
        const 事件组 = [重试事件(2, 1, 'p', 'k', 'id-a', 1), 重试事件(2, 1, 'p', 'k', 'id-a', 3)]

        expect(normalizeRetryChain(事件组)).toBe(true)
        expect((事件组[1] as { data: { retry: number } }).data.retry).toBe(2)
        expect((事件组[1] as { data: { retryId: string } }).data.retryId).toBe('id-a')
    })

    it('retry 字段类型不对时跳过、不改写', () => {
        const 事件组 = [{ type: 'llm/retry', data: { turn: 1, step: 1, provider: 'p', policyKey: 'k', retryId: 'id-x' } }]

        expect(normalizeRetryChain(事件组)).toBe(false)
    })

    it('真机形状的 retry-started 被同步改写', () => {
        const 事件组 = [
            重试事件(1, 1, 'p', 'k', 'id-1', 1),
            重试启动事件(1, 1, 'id-1', 1),
            重试事件(1, 1, 'p', 'k', 'id-2', 1),
            重试启动事件(1, 1, 'id-2', 1),
        ]

        expect(normalizeRetryChain(事件组)).toBe(true)
        const 第二条 = (事件组[1] as { data: { retry: number; retryId: string } }).data
        expect(第二条.retry).toBe(1)
        expect(第二条.retryId).toBe('id-1')
        const 第三条 = (事件组[2] as { data: { retry: number; retryId: string } }).data
        expect(第三条.retry).toBe(2)
        expect(第三条.retryId).toBe('id-1')
        const 第四条 = (事件组[3] as { data: { retry: number; retryId: string } }).data
        expect(第四条.retry).toBe(2)
        expect(第四条.retryId).toBe('id-1')
    })
})

describe('expandSourceEventSeqs（序号范围编码展开）', () => {
    it('把 [8,10] 展开成 [8,9,10]', () => {
        const 事件组 = [序号事件([[8, 10]])]

        expect(expandSourceEventSeqs(事件组)).toBe(true)
        expect((事件组[0] as { data: { sourceEventSeqs: unknown[] } }).data.sourceEventSeqs).toEqual([8, 9, 10])
    })

    it('扁平数字与范围混装时只展开范围、保持顺序', () => {
        const 事件组 = [序号事件([1, [3, 5], 7])]

        expandSourceEventSeqs(事件组)
        expect((事件组[0] as { data: { sourceEventSeqs: unknown[] } }).data.sourceEventSeqs).toEqual([1, 3, 4, 5, 7])
    })

    it('无范围编码时不改动', () => {
        const 事件组 = [序号事件([1, 2, 3])]

        expect(expandSourceEventSeqs(事件组)).toBe(false)
    })

    it('遍历多个事件', () => {
        const 事件组 = [序号事件([1, [2, 4]]), 序号事件([10, [12, 13]])]

        expect(expandSourceEventSeqs(事件组)).toBe(true)
        expect((事件组[0] as { data: { sourceEventSeqs: unknown[] } }).data.sourceEventSeqs).toEqual([1, 2, 3, 4])
        expect((事件组[1] as { data: { sourceEventSeqs: unknown[] } }).data.sourceEventSeqs).toEqual([10, 12, 13])
    })
})

describe('repairSessionFile（完整流程与状态表达）', () => {
    it('校验通过时报「无需修复」', async () => {
        const 目录 = await mkdtemp(join(tmpdir(), 'harden-repair-'))
        try {
            const 文件 = join(目录, 'session.v4.jsonl.zstd')
            await writeFile(文件, 编码会话文件([{ type: 'session', id: 's1' }, 序号事件([1, 2])]))

            const 结果 = await repairSessionFile(文件, 用假校验器())
            expect(结果.status).toBe('intact')
            expect(结果.changedCategories).toEqual([])
        } finally {
            await rm(目录, { recursive: true, force: true })
        }
    })

    it('重试链异常被修好、落盘、报「已修复」', async () => {
        const 目录 = await mkdtemp(join(tmpdir(), 'harden-repair-'))
        try {
            const 文件 = join(目录, 'session.v4.jsonl.zstd')
            await writeFile(文件, 编码会话文件([
                { type: 'session', id: 's1' },
                重试事件(1, 1, 'p', 'k', 'id-1', 1),
                重试事件(1, 1, 'p', 'k', 'id-2', 2),
            ]))

            const 结果 = await repairSessionFile(文件, 用假校验器())
            expect(结果.status).toBe('repaired')
            expect(结果.changedCategories).toContain('retry-chain-normalized')
        } finally {
            await rm(目录, { recursive: true, force: true })
        }
    })

    it('序号范围编码被修好、落盘、报「已修复」', async () => {
        const 目录 = await mkdtemp(join(tmpdir(), 'harden-repair-'))
        try {
            const 文件 = join(目录, 'session.v4.jsonl.zstd')
            await writeFile(文件, 编码会话文件([{ type: 'session', id: 's1' }, 序号事件([[8, 10]])]))

            const 结果 = await repairSessionFile(文件, 用假校验器())
            expect(结果.status).toBe('repaired')
            expect(结果.changedCategories).toContain('sourceEventSeqs-expanded')
        } finally {
            await rm(目录, { recursive: true, force: true })
        }
    })

    it('修不了：校验失败且不属于已知的可修类别', async () => {
        const 目录 = await mkdtemp(join(tmpdir(), 'harden-repair-'))
        try {
            const 文件 = join(目录, 'session.v4.jsonl.zstd')
            await writeFile(文件, 编码会话文件([{ type: 'session', id: 's1' }, 序号事件([1, 2])]))
            const 拒绝校验器: SessionValidator = { validate: () => { throw new Error('永远不过') } }

            const 结果 = await repairSessionFile(文件, 拒绝校验器)
            expect(结果.status).toBe('unrepairable')
            expect(结果.changedCategories).toEqual([])
        } finally {
            await rm(目录, { recursive: true, force: true })
        }
    })

    it('读取失败：文件不存在', async () => {
        const 结果 = await repairSessionFile('不存在的会话文件.v4.jsonl.zstd', 用假校验器())

        expect(结果.status).toBe('read-failed')
        expect(结果.changedCategories).toEqual([])
    })

    it('修好的文件重读后校验通过', async () => {
        const 目录 = await mkdtemp(join(tmpdir(), 'harden-repair-'))
        try {
            const 文件 = join(目录, 'session.v4.jsonl.zstd')
            await writeFile(文件, 编码会话文件([
                { type: 'session', id: 's1' },
                重试事件(1, 1, 'p', 'k', 'id-1', 1),
                重试事件(1, 1, 'p', 'k', 'id-2', 2),
                序号事件([[8, 10]]),
            ]))

            await repairSessionFile(文件, 用假校验器())

            const 二次结果 = await repairSessionFile(文件, 用假校验器())
            expect(二次结果.status).toBe('intact')
        } finally {
            await rm(目录, { recursive: true, force: true })
        }
    })

    it('同链重复序号被修好、落盘、报「已修复」', async () => {
        const 目录 = await mkdtemp(join(tmpdir(), 'harden-repair-'))
        try {
            const 文件 = join(目录, 'session.v4.jsonl.zstd')
            await writeFile(文件, 编码会话文件([
                { type: 'session', id: 's1' },
                重试事件(1, 1, 'p', 'k', 'id-1', 1),
                重试事件(1, 1, 'p', 'k', 'id-2', 1),
            ]))

            const 结果 = await repairSessionFile(文件, 用假校验器())
            expect(结果.status).toBe('repaired')
            expect(结果.changedCategories).toContain('retry-chain-normalized')

            const 行组 = 解码会话文件(await readFile(文件))
            const 第二条重试 = (行组[2] as { data: { retry: number; retryId: string } }).data
            expect(第二条重试.retry).toBe(2)
            expect(第二条重试.retryId).toBe('id-1')
        } finally {
            await rm(目录, { recursive: true, force: true })
        }
    })

    it('不属于可修类别时 reason 带平台原话', async () => {
        const 目录 = await mkdtemp(join(tmpdir(), 'harden-repair-'))
        try {
            const 文件 = join(目录, 'session.v4.jsonl.zstd')
            await writeFile(文件, 编码会话文件([{ type: 'session', id: 's1' }, 序号事件([1, 2])]))
            const 拒绝校验器: SessionValidator = { validate: () => { throw new Error('平台原话甲') } }

            const 结果 = await repairSessionFile(文件, 拒绝校验器)
            expect(结果.status).toBe('unrepairable')
            expect(结果.reason).toContain('平台原话甲')
            expect(结果.reason).toContain('不属于已知的可修类别')
        } finally {
            await rm(目录, { recursive: true, force: true })
        }
    })

    it('真机形状 started 的损坏文件被修好、落盘、复读通过', async () => {
        const 目录 = await mkdtemp(join(tmpdir(), 'harden-repair-'))
        try {
            const 文件 = join(目录, 'session.v4.jsonl.zstd')
            await writeFile(文件, 编码会话文件([
                { type: 'session', id: 's1' },
                重试事件(1, 1, 'p', 'k', 'id-1', 1),
                重试启动事件(1, 1, 'id-1', 1),
                重试事件(1, 1, 'p', 'k', 'id-2', 1),
                重试启动事件(1, 1, 'id-2', 1),
            ]))

            const 结果 = await repairSessionFile(文件, 用假校验器())
            expect(结果.status).toBe('repaired')
            expect(结果.changedCategories).toContain('retry-chain-normalized')

            const 落盘行组 = 解码会话文件(await readFile(文件))
            const 落盘坐标组 = 落盘行组.slice(1).map((事件) => (事件 as { data: { retryId: string; retry: number } }).data)
            expect(落盘坐标组.map((坐标) => [坐标.retryId, 坐标.retry])).toEqual([
                ['id-1', 1],
                ['id-1', 1],
                ['id-1', 2],
                ['id-1', 2],
            ])

            const 复读结果 = await repairSessionFile(文件, 用假校验器())
            expect(复读结果.status).toBe('intact')
        } finally {
            await rm(目录, { recursive: true, force: true })
        }
    })

    it('normal 模式 maxRetries 不够（真机形状：同链两条 retry=1 + maxRetries=1）被修好', async () => {
        const 目录 = await mkdtemp(join(tmpdir(), 'harden-repair-'))
        try {
            const 文件 = join(目录, 'session.v4.jsonl.zstd')
            await writeFile(文件, 编码会话文件([
                { type: 'session', id: 's1' },
                带限额重试事件('id-1', 1, 1),
                重试启动事件(1, 7, 'id-1', 1),
                带限额重试事件('id-2', 1, 1),
                重试启动事件(1, 7, 'id-2', 1),
            ]))

            const 结果 = await repairSessionFile(文件, 用假校验器())
            expect(结果.status).toBe('repaired')
            expect(结果.changedCategories).toContain('retry-chain-normalized')

            const 落盘行组 = 解码会话文件(await readFile(文件))
            const 落盘坐标组 = 落盘行组.slice(1).map((事件) => (事件 as { data: { retryId: string; retry: number; maxRetries?: number } }).data)
            expect(落盘坐标组.map((坐标) => [坐标.retryId, 坐标.retry, 坐标.maxRetries])).toEqual([
                ['id-1', 1, 1],
                ['id-1', 1, undefined],
                ['id-1', 2, 2],
                ['id-1', 2, undefined],
            ])

            const 复读结果 = await repairSessionFile(文件, 用假校验器())
            expect(复读结果.status).toBe('intact')
        } finally {
            await rm(目录, { recursive: true, force: true })
        }
    })

    it('maxRetries 够大时只归并链、不动 maxRetries', async () => {
        const 目录 = await mkdtemp(join(tmpdir(), 'harden-repair-'))
        try {
            const 文件 = join(目录, 'session.v4.jsonl.zstd')
            await writeFile(文件, 编码会话文件([
                { type: 'session', id: 's1' },
                带限额重试事件('id-1', 1, 5),
                带限额重试事件('id-2', 2, 5),
            ]))

            const 结果 = await repairSessionFile(文件, 用假校验器())
            expect(结果.status).toBe('repaired')

            const 落盘行组 = 解码会话文件(await readFile(文件))
            const 落盘坐标组 = 落盘行组.slice(1).map((事件) => (事件 as { data: { retryId: string; retry: number; maxRetries: number } }).data)
            expect(落盘坐标组.map((坐标) => [坐标.retryId, 坐标.retry, 坐标.maxRetries])).toEqual([
                ['id-1', 1, 5],
                ['id-1', 2, 5],
            ])
        } finally {
            await rm(目录, { recursive: true, force: true })
        }
    })

    it('always 模式带 maxRetries 的形态不在可修范围内（平台写入器不产生它）', async () => {
        const 目录 = await mkdtemp(join(tmpdir(), 'harden-repair-'))
        try {
            const 文件 = join(目录, 'session.v4.jsonl.zstd')
            await writeFile(文件, 编码会话文件([
                { type: 'session', id: 's1' },
                {
                    type: 'llm/retry',
                    data: {
                        turn: 1,
                        step: 7,
                        provider: 'command-code',
                        policyKey: 'k',
                        mode: 'always',
                        retryId: 'id-1',
                        retry: 1,
                        maxRetries: 3,
                    },
                },
            ]))

            const 结果 = await repairSessionFile(文件, 用假校验器())
            expect(结果.status).toBe('unrepairable')
            expect(结果.reason).toContain('always mode must omit maxRetries')
            expect(结果.changedCategories).toEqual([])
        } finally {
            await rm(目录, { recursive: true, force: true })
        }
    })

    it('normal 形状的合法重试链报「无需修复」', async () => {
        const 目录 = await mkdtemp(join(tmpdir(), 'harden-repair-'))
        try {
            const 文件 = join(目录, 'session.v4.jsonl.zstd')
            await writeFile(文件, 编码会话文件([
                { type: 'session', id: 's1' },
                带限额重试事件('id-1', 1, 5),
                重试启动事件(1, 7, 'id-1', 1),
            ]))

            const 结果 = await repairSessionFile(文件, 用假校验器())
            expect(结果.status).toBe('intact')
            expect(结果.changedCategories).toEqual([])
        } finally {
            await rm(目录, { recursive: true, force: true })
        }
    })
})

describe('scanSessionFiles', () => {
    it('递归找出嵌套目录下的会话文件', async () => {
        const 目录 = await mkdtemp(join(tmpdir(), 'harden-scan-'))
        try {
            const 一层 = join(目录, '工作区编码', '会话甲')
            const 二层 = join(目录, '工作区编码', '会话乙')
            await mkdir(join(目录, '工作区编码'), { recursive: true })
            await writeFile(join(目录, '工作区编码', '忽略我.txt'), 'x')
            await mkdir(一层, { recursive: true })
            await mkdir(二层, { recursive: true })
            await writeFile(join(一层, 'session.v4.jsonl.zstd'), Buffer.from('a'))
            await writeFile(join(二层, 'session.v4.jsonl.zstd'), Buffer.from('b'))

            const 文件组 = await scanSessionFiles(目录)
            expect(文件组.length).toBe(2)
        } finally {
            await rm(目录, { recursive: true, force: true })
        }
    })
})


/**
 * 造一套假的平台包目录：`<临时根>/@deepseek-ai/<包名>/`，形状与真机一致。
 *
 * 两个必需包都写成 CJS：`dsh-session-format-v3-to-v4` 的 `restoreReleasedV4Artifact` 抛带
 * 标记的错误（用来证明校验器真的加载了这个目录里的假包），`dsh-session` 只给事件表；
 * 锚点入口按真机形状放在 `dsh-agent/lib/index.js`。首选包只要求入口路径同层有这两个包，
 * 所以不真的造 `dsh-session-persistence-jsonl` 目录。
 *
 * @param 标记 - 假校验器抛错时带的标记文本。
 * @param 选项 - 控制造哪几个必需包，用来验证「派生目录缺包」的分支。
 */
async function 造假平台包目录(
    标记: string,
    选项: { 包含v3to4?: boolean; 包含session?: boolean } = {},
): Promise<{ 临时根: string; 首选包入口: string; 锚点包入口: string }> {
    const 临时根 = await mkdtemp(join(tmpdir(), 'harden-platform-'))
    const 平台包目录 = join(临时根, '@deepseek-ai')
    const 是否包含校验包 = 选项.包含v3to4 ?? true
    const 是否包含事件表包 = 选项.包含session ?? true

    if (是否包含校验包) {
        const 校验包目录 = join(平台包目录, 'dsh-session-format-v3-to-v4')
        await mkdir(校验包目录, { recursive: true })
        await writeFile(join(校验包目录, 'package.json'), JSON.stringify({ name: 'dsh-session-format-v3-to-v4', main: 'index.js' }))
        await writeFile(
            join(校验包目录, 'index.js'),
            `module.exports = { restoreReleasedV4Artifact: () => { throw new Error(${JSON.stringify(标记)}) } }\n`,
        )
    }

    if (是否包含事件表包) {
        const 事件表包目录 = join(平台包目录, 'dsh-session')
        await mkdir(事件表包目录, { recursive: true })
        await writeFile(join(事件表包目录, 'package.json'), JSON.stringify({ name: 'dsh-session', main: 'index.js' }))
        await writeFile(join(事件表包目录, 'index.js'), 'module.exports = { KNOWN_SESSION_EVENT_TYPES: new Set() }\n')
    }

    const 锚点目录 = join(平台包目录, 'dsh-agent', 'lib')
    await mkdir(锚点目录, { recursive: true })
    await writeFile(join(锚点目录, 'index.js'), '')

    return {
        临时根,
        首选包入口: join(平台包目录, 'dsh-session-persistence-jsonl', 'index.js'),
        锚点包入口: join(锚点目录, 'index.js'),
    }
}

describe('loadPlatformValidator（平台包定位）', () => {
    it('候选 1 直接命中：加载首选包同层目录里的校验器', async () => {
        const 假包 = await 造假平台包目录('候选一假校验器')
        const 解析记录组: string[] = []
        const 解析器 = (包名: string): string => {
            解析记录组.push(包名)
            if (包名 !== '@deepseek-ai/dsh-session-persistence-jsonl') throw new Error(`候选 1 命中时不该解析 ${包名}`)
            return 假包.首选包入口
        }

        try {
            const 校验器 = loadPlatformValidator(解析器)

            expect(typeof 校验器.validate).toBe('function')
            expect(() => 校验器.validate({}, [])).toThrowError('候选一假校验器')
            expect(解析记录组).toEqual(['@deepseek-ai/dsh-session-persistence-jsonl'])
        } finally {
            await rm(假包.临时根, { recursive: true, force: true })
        }
    })

    it('候选 1 解析不到时回退候选 2', async () => {
        const 假包 = await 造假平台包目录('候选二假校验器')
        const 解析器 = (包名: string): string => {
            if (包名 === '@deepseek-ai/dsh-session-persistence-jsonl') {
                throw Object.assign(new Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' })
            }
            return 假包.锚点包入口
        }

        try {
            const 校验器 = loadPlatformValidator(解析器)

            expect(() => 校验器.validate({}, [])).toThrowError('候选二假校验器')
        } finally {
            await rm(假包.临时根, { recursive: true, force: true })
        }
    })

    it('两个候选都失败时报「定位平台包目录失败」并带上两次原因', () => {
        const 解析器 = (包名: string): string => {
            if (包名 === '@deepseek-ai/dsh-session-persistence-jsonl') throw new Error('首选解析失败甲')
            throw new Error('锚点包解析失败乙')
        }

        let 捕获错误: unknown = null
        try {
            loadPlatformValidator(解析器)
        } catch (err) {
            捕获错误 = err
        }

        expect(捕获错误).toBeInstanceOf(Error)
        const 错误消息 = (捕获错误 as Error).message
        expect(错误消息).toMatch(/定位平台包目录失败/)
        expect(错误消息).toContain('首选解析失败甲')
        expect(错误消息).toContain('锚点包解析失败乙')
        expect(错误消息).toContain('@deepseek-ai/dsh-session-persistence-jsonl')
        expect(错误消息).toContain('@deepseek-ai/dsh-agent')
    })

    it('候选 2 命中但派生目录缺 dsh-session 时报错', async () => {
        const 假包 = await 造假平台包目录('不该加载的假校验器', { 包含session: false })
        const 解析器 = (包名: string): string => {
            if (包名 === '@deepseek-ai/dsh-session-persistence-jsonl') throw new Error('没有首选包')
            return 假包.锚点包入口
        }

        try {
            let 捕获错误: unknown = null
            try {
                loadPlatformValidator(解析器)
            } catch (err) {
                捕获错误 = err
            }

            expect(捕获错误).toBeInstanceOf(Error)
            const 错误消息 = (捕获错误 as Error).message
            expect(错误消息).toContain('定位平台包目录失败')
            expect(错误消息).toContain('没有 dsh-session')
        } finally {
            await rm(假包.临时根, { recursive: true, force: true })
        }
    })

    it('候选 1 命中但目录缺必需包时回退候选 2', async () => {
        const 首选假包 = await 造假平台包目录('候选一假校验器', { 包含v3to4: false })
        const 锚点假包 = await 造假平台包目录('候选二假校验器')
        const 解析器 = (包名: string): string => {
            if (包名 === '@deepseek-ai/dsh-session-persistence-jsonl') return 首选假包.首选包入口
            return 锚点假包.锚点包入口
        }

        try {
            const 校验器 = loadPlatformValidator(解析器)

            expect(() => 校验器.validate({}, [])).toThrowError('候选二假校验器')
        } finally {
            await rm(首选假包.临时根, { recursive: true, force: true })
            await rm(锚点假包.临时根, { recursive: true, force: true })
        }
    })
})
