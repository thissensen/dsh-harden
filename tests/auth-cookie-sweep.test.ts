/**
 * 浏览器认证 cookie 清理口径（`src/host/auth-cookie-sweep.ts`）的单元测试。
 *
 * 被测对象全是纯函数：枚举 `Cookie` 头里的 `dsh-auth-*`、算当前页面那条的名字、判定待删集合、
 * 序列化删除响应头。字符串进、字符串出，不 mock、不碰网络与文件。
 *
 * **期望名一律写现算的字面量。** `dsh-auth-` 后面那串是授权域的 sha256 base64url；用例里把
 * 现算好的串硬编码进来（算法在测试里再写一遍等于自己证明自己）。口径一改就红，这正是要的。
 *
 * @module dsh-harden/tests/auth-cookie-sweep
 */

import { describe, expect, it } from 'vitest'

import {
    判定待删认证Cookie,
    造删除响应头组,
    获取当前认证Cookie名组,
    获取认证Cookie名组,
} from '../src/host/auth-cookie-sweep.js'
import { AUTH_COOKIE_SWEEP_THRESHOLD } from '../src/host/shared-format.js'

/**
 * 现算的字面量：`createHash('sha256').update(授权域).digest('base64url')` 的结果。
 *
 * - v4主机：Host 头 `127.0.0.1:51234` ⇒ HTTP 授权域 `127.0.0.1:51234` / TLS 授权域 `https://127.0.0.1:51234`
 * - v6主机：Host 头 `[::1]:8899` ⇒ HTTP 授权域 `[::1]:8899` / TLS 授权域 `https://[::1]:8899`
 */
const v4主机当前名 = 'dsh-auth-IA65NERIqHMAlmsoa_nqfpvQAaP9M4M2nZaH7yYnF7k'
const v4主机TLS当前名 = 'dsh-auth-P4mDBeGuHbpP0fYtXxyIQ5QaNDOw9Yo1ZKUt6wniNMk'
const v6主机当前名 = 'dsh-auth-ieFNmzhaaNWhtRwrmllZWKGm8XBvYUTn2YMkVp3mOMk'
const v6主机TLS当前名 = 'dsh-auth-SkmYvuIvR003YoOcIk6uBR3N5vWhxxCJ-PHprWtXKWY'

/** 造 `条数` 条旧的认证 cookie（`dsh-auth-A0`、`dsh-auth-A1`……），拼成一条 `Cookie` 头。 */
function 造旧Cookie头(条数: number): string {
    const 条组: string[] = []
    for (let 序号 = 0; 序号 < 条数; 序号 += 1) {
        条组.push(`dsh-auth-A${序号}=v`)
    }

    return 条组.join('; ')
}

describe('获取认证Cookie名组', () => {
    it('只收 dsh-auth-* 并保持出现顺序', () => {
        expect(获取认证Cookie名组('a=1; dsh-auth-AAA=2; dsh-auth-BBB=3')).toEqual(['dsh-auth-AAA', 'dsh-auth-BBB'])
    })

    it('前缀必须精确匹配：dsh-authX / xdsh-auth- / dsh-au 都不算', () => {
        expect(获取认证Cookie名组('dsh-authX=1; xdsh-auth-AAA=1; dsh-au=1')).toEqual([])
    })

    // 名字会原样拼进 Set-Cookie 响应头：字符集不卡住，就是把请求头里的任意字符串反射成响应头。
    it('名字含字符集之外的字符一律跳过', () => {
        expect(获取认证Cookie名组('dsh-auth-AA A=1; dsh-auth-..=1; dsh-auth-a%2F=1')).toEqual([])
    })

    it('同名只留一条，位置按首次出现', () => {
        expect(获取认证Cookie名组('dsh-auth-AAA=1; dsh-auth-AAA=2')).toEqual(['dsh-auth-AAA'])
    })

    it('畸形输入一律当空，绝不抛异常', () => {
        expect(获取认证Cookie名组(';;=x; dsh-auth-AAA')).toEqual([])
        expect(获取认证Cookie名组(undefined)).toEqual([])
        expect(获取认证Cookie名组('')).toEqual([])
    })
})

describe('获取当前认证Cookie名组', () => {
    it('HTTP 形态用 url.host 拼名字', () => {
        expect(获取当前认证Cookie名组('127.0.0.1:51234')).toContain(v4主机当前名)
    })

    it('HTTP 与 TLS 两个形态都保，且互不相同', () => {
        const 名组 = 获取当前认证Cookie名组('[::1]:8899')

        expect(名组).toHaveLength(2)
        expect(名组[0]).not.toBe(名组[1])
        expect(名组.every((名字) => 名字.startsWith('dsh-auth-'))).toBe(true)
        expect(名组).toEqual([v6主机当前名, v6主机TLS当前名])
    })
})

describe('判定待删认证Cookie', () => {
    // 门槛是「严格大于」：刚好 20 条不动手，第 21 条进来才动。
    it('20 条不动手，21 条才动手', () => {
        expect(AUTH_COOKIE_SWEEP_THRESHOLD).toBe(20)

        const 二十条 = `${造旧Cookie头(19)}; ${v4主机当前名}=v`
        expect(判定待删认证Cookie(二十条, '127.0.0.1:51234')).toEqual([])

        const 二十一条 = `${造旧Cookie头(20)}; ${v4主机当前名}=v`
        expect(判定待删认证Cookie(二十一条, '127.0.0.1:51234')).toHaveLength(20)
    })

    it('当前页面那条永不进待删名单', () => {
        const 二十一条 = `${造旧Cookie头(20)}; ${v4主机当前名}=v`
        const 待删名组 = 判定待删认证Cookie(二十一条, '127.0.0.1:51234')

        expect(待删名组).toHaveLength(20)
        expect(待删名组).not.toContain(v4主机当前名)
    })

    it('当前名不在 Cookie 头里时没有可保的，21 条全删', () => {
        expect(判定待删认证Cookie(造旧Cookie头(21), '127.0.0.1:51234')).toHaveLength(21)
    })

    // 算不出当前页面的名字就一律不动手：赌错一条正在用的 cookie，用户当场被锁在门外。
    it('算不出保名单时强制为空（即便有 21 条）', () => {
        expect(判定待删认证Cookie(造旧Cookie头(21), '')).toEqual([])
    })
})

describe('造删除响应头组', () => {
    // 整串钉死：Path / Max-Age / HttpOnly / SameSite 的顺序与大小写都照平台签发形态。
    it('属性串逐字固定', () => {
        expect(造删除响应头组(['dsh-auth-AAA'])).toEqual(['dsh-auth-AAA=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict'])
    })
})
