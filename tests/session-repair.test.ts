/**
 * 会话修复模块的持久化测试。
 *
 * 被测对象是 `src/host/session-repair.ts`：
 * - 纯函数 `mergeRetryIds()`（A 类：retryId 归并）与 `expandSourceEventSeqs()`（B 类：
 *   范围展开）——直接验证改动结果；
 * - 完整流程 `repairSessionFile()`——注入模拟平台校验器，用真实 zstd 文件验证
 *   「无需修复 / 已修复 / 修不了 / 读取失败」四态与落盘行为。
 *
 * @module dsh-harden/tests/session-repair
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { constants, zstdCompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { expandSourceEventSeqs, mergeRetryIds, repairSessionFile, scanSessionFiles } from '../src/host/session-repair.js'
import type { SessionValidator } from '../src/host/session-repair.js'

/** 与模块内一致的带 checksum 压缩选项（测试造文件用）。 */
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

/** 构造一条 llm/retry 事件。 */
function 重试事件(turn: number, step: number, provider: string, policyKey: string, retryId: string, retry: number): unknown {
    return { type: 'llm/retry', data: { turn, step, provider, policyKey, retryId, retry } }
}

/** 构造一条 llm/retry-started 事件。 */
function 重试启动事件(turn: number, step: number, provider: string, policyKey: string, retryId: string, retry: number): unknown {
    return { type: 'llm/retry-started', data: { turn, step, provider, policyKey, retryId, retry } }
}

/** 构造一条带 sourceEventSeqs 的事件。 */
function 序号事件(序号组: unknown[]): unknown {
    return { type: 'assistant/message', data: { turn: 1, step: 1, sourceEventSeqs: 序号组 } }
}

/** 把事件组编码成多帧 zstd 会话文件字节。 */
function 编码会话文件(行组: unknown[]): Buffer {
    return zstdCompressSync(Buffer.from(`${行组.map((行) => JSON.stringify(行)).join('\n')}\n`, 'utf8'), CHECKSUM_OPTIONS)
}

/**
 * 模拟平台校验器：A 类（同链 retryId 不一致）与 B 类（sourceEventSeqs 含子数组）都拒。
 */
function 模拟平台校验(header: unknown, events: unknown[]): void {
    const 规范编号组 = new Map<string, string>()
    for (const 事件 of events) {
        const 记录 = 事件 as { type?: string; data?: Record<string, unknown> }
        if (记录.type !== 'llm/retry') continue
        const data = 记录.data ?? {}
        const 链键 = `${data.turn}|${data.step}|${data.provider}|${data.policyKey}`
        if (规范编号组.has(链键) === false) 规范编号组.set(链键, String(data.retryId))
        else if (规范编号组.get(链键) !== data.retryId) throw new Error('retryId 不一致')
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

describe('mergeRetryIds（A 类修复）', () => {
    it('同链不同 retryId 归并成第一条', () => {
        const 事件组 = [
            重试事件(1, 1, 'p', 'k', 'id-1', 1),
            重试启动事件(1, 1, 'p', 'k', 'id-1', 1),
            重试事件(1, 1, 'p', 'k', 'id-2', 2),
            重试启动事件(1, 1, 'p', 'k', 'id-2', 2),
        ]

        expect(mergeRetryIds(事件组)).toBe(true)
        const 编号组 = 事件组.map((事件) => (事件 as { data: { retryId: string } }).data.retryId)
        expect(编号组).toEqual(['id-1', 'id-1', 'id-1', 'id-1'])
    })

    it('配对的 llm/retry-started 同步归并', () => {
        const 事件组 = [重试事件(2, 3, 'xkiro', 'policy-a', 'first', 1), 重试启动事件(2, 3, 'xkiro', 'policy-a', 'second', 1)]

        mergeRetryIds(事件组)
        expect((事件组[1] as { data: { retryId: string } }).data.retryId).toBe('first')
    })

    it('已一致时不改动', () => {
        const 事件组 = [重试事件(1, 1, 'p', 'k', 'id-1', 1), 重试启动事件(1, 1, 'p', 'k', 'id-1', 1)]

        expect(mergeRetryIds(事件组)).toBe(false)
    })

    it('不同链互不影响', () => {
        const 事件组 = [
            重试事件(1, 1, 'p', 'k', 'id-a', 1),
            重试事件(1, 2, 'p', 'k', 'id-b', 1),
            重试事件(1, 1, 'p', 'k', 'id-x', 2),
        ]

        mergeRetryIds(事件组)
        expect((事件组[1] as { data: { retryId: string } }).data.retryId).toBe('id-b')
        expect((事件组[2] as { data: { retryId: string } }).data.retryId).toBe('id-a')
    })

    it('缺字段的事件被跳过、不报错', () => {
        const 事件组 = [{ type: 'llm/retry', data: { turn: 1 } }, { type: 'tool/call', data: {} }]

        expect(mergeRetryIds(事件组)).toBe(false)
    })
})

describe('expandSourceEventSeqs（B 类修复）', () => {
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

    it('A 类损坏被修好、落盘、报「已修复」', async () => {
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
            expect(结果.changedCategories).toContain('retryId-merged')
        } finally {
            await rm(目录, { recursive: true, force: true })
        }
    })

    it('B 类损坏被修好、落盘、报「已修复」', async () => {
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

    it('修不了：校验失败但不属于已知两类损坏', async () => {
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
