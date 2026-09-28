/**
 * `parseTokenCount()` 的单元测试。
 *
 * 被测对象是 `src/host/compaction.ts` 的阈值解析：`1M` / `200K` / `100000` 这类
 * 文本必须解析成正整数 token 数，格式不对一律返回 null（失败静默，不改会话）。
 *
 * 断言直接验真实返回值，不 mock——解析是纯函数，没有可 mock 的依赖。
 *
 * @module dsh-harden/tests/compaction
 */

import { describe, expect, it } from 'vitest'
import { parseTokenCount, shouldCompactSession } from '../src/host/compaction.js'
import type { CompactionScope, HardenConfig } from '../src/host/types.js'

/** 造一份判压缩用的配置（只放本判定读的两个字段）。 */
function 造配置(contextCompaction: boolean, compactionScope: CompactionScope): Required<HardenConfig> {
    return {
        toolFailureGuard: true,
        toolFailurePrefixes: '',
        emptyOutputGuard: true,
        networkRetryCount: 5,
        networkRetryTokens: '',
        backgroundJobTool: true,
        contextCompaction,
        compactionScope,
        compactionThreshold: '200K',
        compactionInstruction: '',
    }
}

describe('parseTokenCount', () => {
    it('纯数字按字面量解析', () => {
        expect(parseTokenCount('100000')).toBe(100000)
    })

    it('K 后缀按 1000 放大', () => {
        expect(parseTokenCount('200K')).toBe(200000)
    })

    it('M 后缀按 1000000 放大', () => {
        expect(parseTokenCount('1M')).toBe(1000000)
    })

    it('后缀不区分大小写', () => {
        expect(parseTokenCount('200k')).toBe(200000)
        expect(parseTokenCount('1m')).toBe(1000000)
    })

    it('允许首尾空白', () => {
        expect(parseTokenCount(' 1m ')).toBe(1000000)
    })

    it('空串返回 null', () => {
        expect(parseTokenCount('')).toBeNull()
    })

    it('纯字母返回 null', () => {
        expect(parseTokenCount('abc')).toBeNull()
    })

    it('零返回 null（必须为正整数）', () => {
        expect(parseTokenCount('0')).toBeNull()
    })

    it('负数返回 null', () => {
        expect(parseTokenCount('-5')).toBeNull()
    })

    // 小数不在用户定稿的三种形态里（1M / 200K / 100000），选择不解析：
    // 正则只认 \d+ 整数部分，`1.5K` 因含小数点而整体失配，返回 null。
    it('小数返回 null（不在支持的三种形态内）', () => {
        expect(parseTokenCount('1.5K')).toBeNull()
    })
})

describe('shouldCompactSession（总开关与压缩范围）', () => {
    it('总开关关：任何范围下主代理与子代理都不压', () => {
        for (const 范围 of ['all', 'main', 'subagent'] as const) {
            const 配置 = 造配置(false, 范围)

            expect(shouldCompactSession(配置, { snapshotEvents: () => [] })).toBe(false)
            expect(shouldCompactSession(配置, { snapshotEvents: () => [], header: { origin: 'subagent' } })).toBe(false)
        }
    })

    it('范围 all：主代理与子代理都压', () => {
        const 配置 = 造配置(true, 'all')

        expect(shouldCompactSession(配置, { snapshotEvents: () => [] })).toBe(true)
        expect(shouldCompactSession(配置, { snapshotEvents: () => [], header: { origin: 'subagent' } })).toBe(true)
    })

    it('范围 main：只压主代理，子代理保持原样', () => {
        const 配置 = 造配置(true, 'main')

        expect(shouldCompactSession(配置, { snapshotEvents: () => [] })).toBe(true)
        expect(shouldCompactSession(配置, { snapshotEvents: () => [], header: { origin: 'subagent' } })).toBe(false)
    })

    it('范围 subagent：只压子代理，主代理保持原样', () => {
        const 配置 = 造配置(true, 'subagent')

        expect(shouldCompactSession(配置, { snapshotEvents: () => [] })).toBe(false)
        expect(shouldCompactSession(配置, { snapshotEvents: () => [], header: { origin: 'subagent' } })).toBe(true)
    })

    it('会话头没有 origin（主代理）时按主代理算', () => {
        expect(shouldCompactSession(造配置(true, 'main'), { snapshotEvents: () => [], header: {} })).toBe(true)
        expect(shouldCompactSession(造配置(true, 'subagent'), { snapshotEvents: () => [], header: {} })).toBe(false)
    })
})
