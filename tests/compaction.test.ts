/**
 * 压缩判定 + 事务链（事务链用例由另一任务补）的单元测试。
 *
 * 被测对象是 `src/host/compaction.ts` 的 `shouldCompactSession()`：总开关与压缩范围决定
 * 主代理 / 子代理各压不压。阈值解析（`1M` / `200K` / `100000`）的用例随实现搬到了
 * `tests/shared-format.test.ts`——口径只有一份，测试也只有一份。
 *
 * 断言直接验真实返回值，不 mock——判定是纯函数，没有可 mock 的依赖。
 *
 * @module dsh-harden/tests/compaction
 */

import { describe, expect, it } from 'vitest'
import { shouldCompactSession } from '../src/host/compaction.js'
import type { CompactionScope, HardenConfig, SessionLike } from '../src/host/types.js'

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

/** 造一个判定用的会话：判定只读会话头，其余字段按必填形状补齐（本用例不触达）。 */
function 造会话(会话头?: { readonly origin?: string }): SessionLike {
    return {
        snapshotEvents: () => [],
        append: () => undefined,
        ...(会话头 === undefined ? {} : { header: 会话头 }),
    }
}

describe('shouldCompactSession（总开关与压缩范围）', () => {
    it('总开关关：任何范围下主代理与子代理都不压', () => {
        for (const 范围 of ['all', 'main', 'subagent'] as const) {
            const 配置 = 造配置(false, 范围)

            expect(shouldCompactSession(配置, 造会话())).toBe(false)
            expect(shouldCompactSession(配置, 造会话({ origin: 'subagent' }))).toBe(false)
        }
    })

    it('范围 all：主代理与子代理都压', () => {
        const 配置 = 造配置(true, 'all')

        expect(shouldCompactSession(配置, 造会话())).toBe(true)
        expect(shouldCompactSession(配置, 造会话({ origin: 'subagent' }))).toBe(true)
    })

    it('范围 main：只压主代理，子代理保持原样', () => {
        const 配置 = 造配置(true, 'main')

        expect(shouldCompactSession(配置, 造会话())).toBe(true)
        expect(shouldCompactSession(配置, 造会话({ origin: 'subagent' }))).toBe(false)
    })

    it('范围 subagent：只压子代理，主代理保持原样', () => {
        const 配置 = 造配置(true, 'subagent')

        expect(shouldCompactSession(配置, 造会话())).toBe(false)
        expect(shouldCompactSession(配置, 造会话({ origin: 'subagent' }))).toBe(true)
    })

    it('会话头没有 origin（主代理）时按主代理算', () => {
        expect(shouldCompactSession(造配置(true, 'main'), 造会话({}))).toBe(true)
        expect(shouldCompactSession(造配置(true, 'subagent'), 造会话({}))).toBe(false)
    })
})
