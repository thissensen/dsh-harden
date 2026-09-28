/**
 * 配置层默认值的持久化测试。
 *
 * 被测对象是 `src/host/config.ts` 的 `readConfig()` 与 `defaultConfig()`：
 * 平台还没注入 settings、或传入的原始对象缺字段时，两者都必须回落到默认值。
 *
 * 断言直接验真实返回值，不 mock——配置层是纯函数，没有可 mock 的依赖。
 *
 * @module dsh-harden/tests/config
 */

import { describe, expect, it } from 'vitest'
import {
    DEFAULT_BACKGROUND_JOB_TOOL,
    DEFAULT_COMPACTION_INSTRUCTION,
    DEFAULT_COMPACTION_THRESHOLD,
    DEFAULT_CONTEXT_COMPACTION,
    DEFAULT_EMPTY_OUTPUT_GUARD,
    DEFAULT_NETWORK_RETRY_COUNT,
    DEFAULT_NETWORK_RETRY_TOKENS,
    DEFAULT_COMPACTION_SCOPE,
    DEFAULT_TOOL_FAILURE_GUARD,
    DEFAULT_TOOL_FAILURE_PREFIXES,
    defaultConfig,
    readConfig,
} from '../src/host/config.js'

describe('配置层默认值', () => {
    it('readConfig 忽略已移除的 openFolderVisible 字段', () => {
        expect(Object.hasOwn(readConfig({ openFolderVisible: false }), 'openFolderVisible')).toBe(false)
    })

    it('defaultConfig() 不含已移除的 openFolderVisible', () => {
        expect(Object.hasOwn(defaultConfig(), 'openFolderVisible')).toBe(false)
    })

    it('readConfig 只回落缺失字段，保留已有字段', () => {
        const config = readConfig({ toolFailureGuard: false })

        expect(config.toolFailureGuard).toBe(false)
        expect(config.emptyOutputGuard).toBe(DEFAULT_EMPTY_OUTPUT_GUARD)
    })

    it('readConfig 对非对象输入回落到全默认配置', () => {
        expect(readConfig(null)).toEqual(defaultConfig())
        expect(readConfig('not-an-object')).toEqual(defaultConfig())
    })

    it('readConfig 解包 volatile 引用后取到真实值', () => {
        const raw = { networkRetryCount: { get: () => 7 } }
        expect(readConfig(raw).networkRetryCount).toBe(7)
    })

    it('readConfig 对类型不符的字段回落到默认值', () => {
        const raw = { networkRetryCount: 'yes' }
        expect(readConfig(raw).networkRetryCount).toBe(DEFAULT_NETWORK_RETRY_COUNT)
    })

    it('全默认配置的每个字段都与导出的默认常量一致', () => {
        const config = defaultConfig()

        expect(config.toolFailureGuard).toBe(DEFAULT_TOOL_FAILURE_GUARD)
        expect(config.toolFailurePrefixes).toBe(DEFAULT_TOOL_FAILURE_PREFIXES)
        expect(config.emptyOutputGuard).toBe(DEFAULT_EMPTY_OUTPUT_GUARD)
        expect(config.networkRetryCount).toBe(DEFAULT_NETWORK_RETRY_COUNT)
        expect(config.networkRetryTokens).toBe(DEFAULT_NETWORK_RETRY_TOKENS)
        expect(config.backgroundJobTool).toBe(DEFAULT_BACKGROUND_JOB_TOOL)
        expect(config.contextCompaction).toBe(DEFAULT_CONTEXT_COMPACTION)
        expect(config.compactionScope).toBe(DEFAULT_COMPACTION_SCOPE)
        expect(config.compactionThreshold).toBe(DEFAULT_COMPACTION_THRESHOLD)
        expect(config.compactionInstruction).toBe(DEFAULT_COMPACTION_INSTRUCTION)
    })

    it('压缩范围默认全部压缩，且能解包 volatile 引用', () => {
        expect(readConfig({}).compactionScope).toBe(DEFAULT_COMPACTION_SCOPE)
        expect(readConfig({ compactionScope: { get: () => 'main' } }).compactionScope).toBe('main')
        expect(readConfig({ compactionScope: { get: () => 'subagent' } }).compactionScope).toBe('subagent')
    })

    it('readConfig 对非法压缩范围回落到默认值（含老字段残留）', () => {
        expect(readConfig({ compactionScope: 'yes' }).compactionScope).toBe(DEFAULT_COMPACTION_SCOPE)
        expect(readConfig({ subagentCompaction: false }).compactionScope).toBe(DEFAULT_COMPACTION_SCOPE)
    })

    it('readConfig 解包新压缩字段的 volatile 引用', () => {
        const raw = {
            contextCompaction: { get: () => false },
            compactionThreshold: { get: () => '1M' },
            compactionInstruction: { get: () => '只输出一句话' },
        }
        const config = readConfig(raw)

        expect(config.contextCompaction).toBe(false)
        expect(config.compactionThreshold).toBe('1M')
        expect(config.compactionInstruction).toBe('只输出一句话')
    })

    it('readConfig 对类型不符的新压缩字段回落到默认值', () => {
        const raw = { contextCompaction: 'yes', compactionThreshold: 200, compactionInstruction: null }
        const config = readConfig(raw)

        expect(config.contextCompaction).toBe(DEFAULT_CONTEXT_COMPACTION)
        expect(config.compactionThreshold).toBe(DEFAULT_COMPACTION_THRESHOLD)
        expect(config.compactionInstruction).toBe(DEFAULT_COMPACTION_INSTRUCTION)
    })
})
