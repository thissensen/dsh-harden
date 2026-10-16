/**
 * 信任主机清单双读的测试。
 *
 * 被测对象是 `src/host/api.ts` 的 `readTrustedHosts()`：平台在不同运行时把这份清单挂在
 * 不同服务上——桌面端 0.2.0-rc.2 由 `webRuntime` 提供 bind 之后的 LAN 字面量，
 * 0.2.1-alpha.5 移除了该服务、只剩 `webStartup`。所以要按 `webRuntime` → `webStartup`
 * 的顺序双读，取到空数组也是合法清单（不回落），都拿不到才回空清单——围栏随之退化成
 * 只允许回环地址，是安全默认。
 *
 * 断言直接验真实返回值，不 mock 框架：桩只实现 `ctx.get` 的查表语义——表里没有该名字
 * 就返回 undefined，与 cordis 里「服务不存在」一致。
 *
 * @module dsh-harden/tests/trusted-hosts
 */

import { describe, expect, it } from 'vitest'
import { readTrustedHosts } from '../src/host/api.js'
import type { Ctx } from '../src/host/types.js'

/** 一个只实现 `get` 查表语义的上下文桩；没登记的名字一律 undefined。 */
function 造上下文桩(服务表: Record<string, unknown>): Ctx {
    return {
        get: (name: string): unknown => 服务表[name],
    } as Ctx
}

describe('信任主机清单双读', () => {
    it('两者都在时取 webRuntime 的清单（rc.2）', () => {
        const 运行时清单组 = ['runtime.example:3080']
        const 启动清单组 = ['startup.example:3080', 'startup.example:3443']
        const ctx = 造上下文桩({
            webRuntime: { trustedHosts: 运行时清单组 },
            webStartup: { trustedHosts: 启动清单组 },
        })

        expect(readTrustedHosts(ctx)).toEqual(运行时清单组)
        expect(readTrustedHosts(ctx)).not.toEqual(启动清单组)
    })

    it('只有 webStartup 时取它的清单（alpha.5）', () => {
        const 启动清单组 = ['startup.example:3080']
        const ctx = 造上下文桩({ webStartup: { trustedHosts: 启动清单组 } })

        expect(readTrustedHosts(ctx)).toEqual(启动清单组)
    })

    it('两者都没有时回空清单', () => {
        expect(readTrustedHosts(造上下文桩({}))).toEqual([])
    })

    it('webRuntime 的清单不是数组时按「没有这个来源」处理', () => {
        const 非数组值组: unknown[] = ['runtime.example:3080', { host: 'runtime.example' }, undefined]

        for (const 非数组值 of 非数组值组) {
            const 有兜底 = 造上下文桩({
                webRuntime: { trustedHosts: 非数组值 },
                webStartup: { trustedHosts: ['startup.example:3080'] },
            })
            expect(readTrustedHosts(有兜底)).toEqual(['startup.example:3080'])

            const 无兜底 = 造上下文桩({ webRuntime: { trustedHosts: 非数组值 } })
            expect(readTrustedHosts(无兜底)).toEqual([])
        }
    })

    it('webRuntime 是空数组时回空清单，不回落 webStartup', () => {
        const ctx = 造上下文桩({
            webRuntime: { trustedHosts: [] },
            webStartup: { trustedHosts: ['startup.example:3080'] },
        })

        expect(readTrustedHosts(ctx)).toEqual([])
    })

    it('webStartup 的清单不是数组且 webRuntime 缺席时回空清单', () => {
        const ctx = 造上下文桩({ webStartup: { trustedHosts: 'startup.example:3080' } })

        expect(readTrustedHosts(ctx)).toEqual([])
    })

    it('桩连 get 都没有时回空清单，不抛', () => {
        const ctx = {} as Ctx

        expect(() => readTrustedHosts(ctx)).not.toThrow()
        expect(readTrustedHosts(ctx)).toEqual([])
    })
})
