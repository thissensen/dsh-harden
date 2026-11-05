/**
 * 共享口径模块（`src/host/shared-format.ts`）的单元测试。
 *
 * 被测对象是 host 与 client 共用的那份口径：阈值解析（绝对 token 数与窗口比例）、异常取文本、
 * 版本比较、回环主机名判据，以及端点校验 / 面板内联校验 / 测试三处共用的常量。断言直接验真实
 * 返回值，不 mock——全是纯函数。
 *
 * @module dsh-harden/tests/shared-format
 */

import { describe, expect, it } from 'vitest'
import {
    AUTH_COOKIE_SWEEP_THRESHOLD,
    COMPACTION_INSTRUCTION_MAX_LENGTH,
    DEFAULT_NETWORK_RETRY_COUNT,
    RETRY_COUNT_MAX,
    RETRY_COUNT_MIN,
    RETRY_TOKENS_MAX_LENGTH,
    TOOL_FAILURE_PREFIXES_MAX_LENGTH,
    errText,
    解析压缩阈值,
    是否回环主机名,
    是否有更新版本,
} from '../src/host/shared-format.js'

describe('解析压缩阈值', () => {
    it('纯数字按字面量解析', () => {
        expect(解析压缩阈值('100000')).toEqual({ 绝对token数: 100000 })
    })

    it('K 后缀按 1000 放大', () => {
        expect(解析压缩阈值('200K')).toEqual({ 绝对token数: 200000 })
    })

    it('M 后缀按 1000000 放大', () => {
        expect(解析压缩阈值('1M')).toEqual({ 绝对token数: 1000000 })
    })

    it('后缀不区分大小写', () => {
        expect(解析压缩阈值('200k')).toEqual({ 绝对token数: 200000 })
        expect(解析压缩阈值('1m')).toEqual({ 绝对token数: 1000000 })
    })

    it('允许首尾空白', () => {
        expect(解析压缩阈值(' 1m ')).toEqual({ 绝对token数: 1000000 })
    })

    it('空串返回 null', () => {
        expect(解析压缩阈值('')).toBeNull()
    })

    it('纯字母返回 null', () => {
        expect(解析压缩阈值('abc')).toBeNull()
    })

    it('零返回 null（必须为正整数）', () => {
        expect(解析压缩阈值('0')).toBeNull()
    })

    it('负数返回 null', () => {
        expect(解析压缩阈值('-5')).toBeNull()
    })

    // 小数不在用户定稿的三种绝对形态里（1M / 200K / 100000），选择不解析：
    // 正则只认 \d+ 整数部分，`1.5K` 因含小数点而整体失配，返回 null。
    it('小数返回 null（不在支持的三种形态内）', () => {
        expect(解析压缩阈值('1.5K')).toBeNull()
    })

    it('百分比按窗口比例解析', () => {
        expect(解析压缩阈值('60%')).toEqual({ 窗口比例: 0.6 })
        expect(解析压缩阈值('100%')).toEqual({ 窗口比例: 1 })
    })

    // 比例只认 1..100 的整数：0% 永远触发不了，101% 永远超过窗口。
    it('比例越界返回 null', () => {
        expect(解析压缩阈值('0%')).toBeNull()
        expect(解析压缩阈值('101%')).toBeNull()
    })

    it('小数比例返回 null', () => {
        expect(解析压缩阈值('1.5%')).toBeNull()
    })

    it('空白或符号错位返回 null', () => {
        expect(解析压缩阈值('60 %')).toBeNull()
        expect(解析压缩阈值('%60')).toBeNull()
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

    it('认证 cookie 清理门槛是 20', () => {
        expect(AUTH_COOKIE_SWEEP_THRESHOLD).toBe(20)
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

describe('是否回环主机名', () => {
    it('localhost 与 127.x.x.x 认作回环', () => {
        expect(是否回环主机名('localhost')).toBe(true)
        expect(是否回环主机名('127.0.0.1')).toBe(true)
        expect(是否回环主机名('127.10.0.5')).toBe(true)
    })

    it('带方括号的 IPv6 回环认作回环', () => {
        expect(是否回环主机名('[::1]')).toBe(true)
    })

    // 判据是从 api.ts 的 isLoopbackHostname 原样搬来的：它只面对 URL.hostname 的形态，而
    // URL.hostname 对 IPv6 回的就是带方括号的 [::1]，裸 ::1 根本不会出现在这个入参上。
    it('裸 ::1 不算回环（URL.hostname 只回带方括号的形态）', () => {
        expect(是否回环主机名('::1')).toBe(false)
    })

    it('非回环地址一律 false', () => {
        expect(是否回环主机名('harden.example')).toBe(false)
        expect(是否回环主机名('192.168.1.2')).toBe(false)
        expect(是否回环主机名('')).toBe(false)
    })
})
