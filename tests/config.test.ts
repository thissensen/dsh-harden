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
    DEFAULT_EMPTY_OUTPUT_GUARD,
    DEFAULT_NETWORK_RETRY_COUNT,
    DEFAULT_NETWORK_RETRY_TOKENS,
    DEFAULT_OPEN_FOLDER_VISIBLE,
    DEFAULT_TOOL_FAILURE_GUARD,
    DEFAULT_TOOL_FAILURE_PREFIXES,
    defaultConfig,
    readConfig,
} from '../src/host/config.js'

describe('配置层默认值', () => {
    it('DEFAULT_OPEN_FOLDER_VISIBLE 是 true', () => {
        expect(DEFAULT_OPEN_FOLDER_VISIBLE).toBe(true)
    })

    it('defaultConfig() 的 openFolderVisible 是 true', () => {
        expect(defaultConfig().openFolderVisible).toBe(true)
    })

    it('readConfig({}) 的 openFolderVisible 是 true', () => {
        expect(readConfig({}).openFolderVisible).toBe(true)
    })

    it('readConfig 对非对象输入回落到全默认配置', () => {
        expect(readConfig(null)).toEqual(defaultConfig())
        expect(readConfig('not-an-object')).toEqual(defaultConfig())
    })

    it('readConfig 解包 volatile 引用后取到真实值', () => {
        const raw = { openFolderVisible: { get: () => false } }
        expect(readConfig(raw).openFolderVisible).toBe(false)
    })

    it('readConfig 对类型不符的字段回落到默认值', () => {
        const raw = { openFolderVisible: 'yes' }
        expect(readConfig(raw).openFolderVisible).toBe(DEFAULT_OPEN_FOLDER_VISIBLE)
    })

    it('全默认配置的每个字段都与导出的默认常量一致', () => {
        const config = defaultConfig()

        expect(config.toolFailureGuard).toBe(DEFAULT_TOOL_FAILURE_GUARD)
        expect(config.toolFailurePrefixes).toBe(DEFAULT_TOOL_FAILURE_PREFIXES)
        expect(config.emptyOutputGuard).toBe(DEFAULT_EMPTY_OUTPUT_GUARD)
        expect(config.networkRetryCount).toBe(DEFAULT_NETWORK_RETRY_COUNT)
        expect(config.networkRetryTokens).toBe(DEFAULT_NETWORK_RETRY_TOKENS)
        expect(config.backgroundJobTool).toBe(DEFAULT_BACKGROUND_JOB_TOOL)
        expect(config.openFolderVisible).toBe(DEFAULT_OPEN_FOLDER_VISIBLE)
    })
})
