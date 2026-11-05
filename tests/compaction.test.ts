/**
 * 压缩判定与阈值换算的单元测试。
 *
 * 被测对象是 `src/host/compaction.ts` 的两个导出纯函数：`shouldCompactSession()` 决定总开关
 * 与压缩范围下主代理 / 子代理各压不压；`换算阈值Token数()` 把阈值换算成本次判定用的 token 数
 * （比例要乘窗口，绝对写法要被窗口的 90% 夹住）。阈值文本的解析（`1M` / `200K` / `100000` /
 * `60%`）随实现住在 `tests/shared-format.test.ts`——口径只有一份，测试也只有一份。
 *
 * 断言直接验真实返回值，不 mock——两个都是纯函数；日志桩只用来数「窗口未知」的警告条数。
 *
 * @module dsh-harden/tests/compaction
 */

import { describe, expect, it } from 'vitest'
import { shouldCompactSession, 换算阈值Token数 } from '../src/host/compaction.js'
import type { CompactionScope, HardenConfig, Logger, SessionLike } from '../src/host/types.js'

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

describe('换算阈值Token数', () => {
    /**
     * 收集 warn 的日志桩。
     *
     * 「窗口未知只警告一次」是模块级状态、全进程只响一次，所以本 describe 的用例**必须按声明
     * 顺序跑**，且共用同一个桩——最后两条正验的是「第二次不再响」。
     */
    const 警告组: string[] = []
    const 日志桩: Logger = {
        warn: (message: string): void => {
            警告组.push(message)
        },
    }

    it('绝对写法 + 窗口未知 ⇒ 原样用', () => {
        expect(换算阈值Token数({ 绝对token数: 200000 }, undefined, 日志桩)).toBe(200000)
    })

    it('绝对写法低于窗口 90% ⇒ 原样用', () => {
        expect(换算阈值Token数({ 绝对token数: 200000 }, 1000000, 日志桩)).toBe(200000)
    })

    it('绝对写法超过窗口 90% ⇒ 夹到窗口的 90%', () => {
        expect(换算阈值Token数({ 绝对token数: 1000000 }, 1000000, 日志桩)).toBe(Math.floor(1000000 * 0.9))
    })

    it('比例写法 + 窗口已知 ⇒ 窗口乘比例向下取整', () => {
        expect(换算阈值Token数({ 窗口比例: 0.6 }, 1000001, 日志桩)).toBe(Math.floor(1000001 * 0.6))
    })

    it('比例 100% ⇒ 等于窗口', () => {
        expect(换算阈值Token数({ 窗口比例: 1 }, 128000, 日志桩)).toBe(128000)
    })

    it('比例写法 + 窗口未知 ⇒ null，并警告一次', () => {
        expect(换算阈值Token数({ 窗口比例: 0.6 }, undefined, 日志桩)).toBeNull()
        expect(警告组).toHaveLength(1)
    })

    it('窗口未知再调一次仍 null，但不再警告（全进程只警告一次）', () => {
        expect(换算阈值Token数({ 窗口比例: 0.6 }, undefined, 日志桩)).toBeNull()
        expect(换算阈值Token数({ 窗口比例: 1 }, undefined, 日志桩)).toBeNull()
        expect(警告组).toHaveLength(1)
    })
})
