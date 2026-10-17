/**
 * 共享口径模块（`src/host/shared-format.ts`）的单元测试。
 *
 * 被测对象是 host 与 client 共用的那份口径：阈值解析、异常取文本、版本比较，以及端点校验 /
 * 面板内联校验 / 测试三处共用的常量。断言直接验真实返回值，不 mock——全是纯函数。
 *
 * @module dsh-harden/tests/shared-format
 */

import { describe, expect, it } from 'vitest'
import {
    COMPACTION_INSTRUCTION_MAX_LENGTH,
    DEFAULT_NETWORK_RETRY_COUNT,
    RETRY_COUNT_MAX,
    RETRY_COUNT_MIN,
    RETRY_TOKENS_MAX_LENGTH,
    TOOL_FAILURE_PREFIXES_MAX_LENGTH,
    errText,
    parseTokenCount,
    是否有更新版本,
} from '../src/host/shared-format.js'

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

describe('errText', () => {
    it('Error 实例取 message', () => {
        expect(errText(new Error('x'))).toBe('x')
    })

    it('带 message 的对象取 message', () => {
        expect(errText({ message: 'x' })).toBe('x')
    })

    it('message 为 null 时退回 String(原值)', () => {
        expect(errText({ message: null })).toBe('[object Object]')
    })

    it('原始值退回 String(原值)', () => {
        expect(errText('boom')).toBe('boom')
    })
})

describe('共享常量', () => {
    it('兜底重试次数的区间与权威默认值', () => {
        expect(RETRY_COUNT_MIN).toBe(0)
        expect(RETRY_COUNT_MAX).toBe(99)
        expect(DEFAULT_NETWORK_RETRY_COUNT).toBe(5)
    })

    it('各配置字段的长度上限', () => {
        expect(RETRY_TOKENS_MAX_LENGTH).toBe(200)
        expect(TOOL_FAILURE_PREFIXES_MAX_LENGTH).toBe(2000)
        expect(COMPACTION_INSTRUCTION_MAX_LENGTH).toBe(10000)
    })
})

describe('是否有更新版本', () => {
    it('同版本返回 false', () => {
        expect(是否有更新版本('0.0.2', '0.0.2')).toBe(false)
    })

    it('最新版主体段更大返回 true', () => {
        expect(是否有更新版本('0.0.2', '0.0.3')).toBe(true)
    })

    it('段数不齐按 0 补齐：0.0.2 与 0.0.2.0 相等', () => {
        expect(是否有更新版本('0.0.2', '0.0.2.0')).toBe(false)
    })

    it('进位段更大返回 true', () => {
        expect(是否有更新版本('0.0.2', '0.1.0')).toBe(true)
    })

    it('最新版主体段更小返回 false', () => {
        expect(是否有更新版本('0.1.0', '0.0.9')).toBe(false)
    })

    it('最新版带预发布返回 false（不提示升级到预览版）', () => {
        expect(是否有更新版本('0.0.2', '0.0.3-rc.1')).toBe(false)
    })

    it('主体段不是纯数字一律返回 false（宁可漏报）', () => {
        expect(是否有更新版本('0.0.2', 'abc')).toBe(false)
    })

    it('主体相等时带预发布的一方更旧：当前是预发布则提示更新', () => {
        expect(是否有更新版本('0.0.2-rc.1', '0.0.2')).toBe(true)
    })

    it('两边都是预发布时按预发布字符串比较', () => {
        expect(是否有更新版本('0.0.2-rc.1', '0.0.2-rc.2')).toBe(true)
    })
})
