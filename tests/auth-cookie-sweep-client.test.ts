/**
 * 页面加载触发旧认证 cookie 清理（`src/client/auth-cookie-sweep.ts`）的测试。
 *
 * 被测函数只做三件事：判当前页面是不是本机地址、发一次写请求、把失败吞掉。这里用
 * `vi.stubGlobal` 造 `location` 与 `fetch`，验真打的 URL / 方法 / 写围栏头，以及
 * 「非回环一个请求都不发」「失败不抛」「同一次物化里只发一次」。
 *
 * **模块级「已触发」标记会跨用例残留**：每条用例都经 `vi.resetModules()` + 动态 import 拿一份
 * 新模块实例，否则防重用例会先被前一条用例烧掉标记。
 *
 * @module dsh-harden/tests/auth-cookie-sweep-client
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

/** 一次 fetch 调用的记录。 */
interface Fetch调用 {
    url: string
    init: RequestInit
}

/** 造一份「端点成功」的 fetch 桩，并把每次调用记进 `调用组`。 */
function 造Fetch桩(调用组: Fetch调用[]): (url: string, init: RequestInit) => Promise<unknown> {
    return async (url: string, init: RequestInit) => {
        调用组.push({ url, init })

        return { ok: true, status: 200, json: async () => ({ ok: true, 清理数: 0 }) }
    }
}

/** 造一份新的被测模块实例（模块级「已触发」标记随模块加载重置）。 */
async function 加载被测模块(): Promise<typeof import('../src/client/auth-cookie-sweep.js')> {
    vi.resetModules()
    return await import('../src/client/auth-cookie-sweep.js')
}

/** 在给定主机名下触发一次清理，返回 fetch 的调用记录。 */
async function 触发一次(主机名: string): Promise<Fetch调用[]> {
    const 调用组: Fetch调用[] = []
    vi.stubGlobal('location', { hostname: 主机名 })
    vi.stubGlobal('fetch', 造Fetch桩(调用组))

    const { 触发旧认证Cookie清理 } = await 加载被测模块()
    await 触发旧认证Cookie清理()

    return 调用组
}

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('触发旧认证Cookie清理', () => {
    it('回环地址（127.0.0.1）：发一次写请求，URL、方法、写围栏头都对', async () => {
        const 调用组 = await 触发一次('127.0.0.1')

        expect(调用组).toHaveLength(1)
        expect(调用组[0].url).toBe('/api/dsh-harden/sweep-auth-cookies')
        expect(调用组[0].init.method).toBe('POST')

        const headers = 调用组[0].init.headers as Record<string, string>
        expect(headers['x-dsh-harden']).toBe('1')
        expect(headers['content-type']).toContain('application/json')
    })

    it('回环地址（localhost）：同样发一次', async () => {
        const 调用组 = await 触发一次('localhost')

        expect(调用组).toHaveLength(1)
    })

    it('非回环地址：一个请求都不发', async () => {
        const 调用组 = await 触发一次('harden.example')

        expect(调用组).toHaveLength(0)
    })

    it('fetch 抛错：函数不抛（清理是静默的）', async () => {
        vi.stubGlobal('location', { hostname: '127.0.0.1' })
        vi.stubGlobal('fetch', async () => {
            throw Error('boom')
        })

        const { 触发旧认证Cookie清理 } = await 加载被测模块()

        await expect(触发旧认证Cookie清理()).resolves.toBeUndefined()
    })

    it('防重：同一次物化里连续调两次，只发一次请求', async () => {
        const 调用组: Fetch调用[] = []
        vi.stubGlobal('location', { hostname: '127.0.0.1' })
        vi.stubGlobal('fetch', 造Fetch桩(调用组))

        const { 触发旧认证Cookie清理 } = await 加载被测模块()
        await 触发旧认证Cookie清理()
        await 触发旧认证Cookie清理()

        expect(调用组).toHaveLength(1)
    })
})
