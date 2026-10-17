/**
 * 信任主机清单来源的测试。
 *
 * 被测对象是 `src/host/api.ts` 的 `readTrustedHosts()`：信任清单的唯一来源是 `webStartup`
 * 服务（平台 `--trusted-host` 传进来的显式信任清单），别的服务上挂了同名清单也不读。
 * 服务缺席或字段形状不可用就回空清单——围栏随之退化成只允许回环地址，是安全默认；
 * 空数组是合法清单，不当作缺席。
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

describe('信任主机清单读取', () => {
    it('webStartup 给出清单就原样返回', () => {
        const 启动清单组 = ['startup.example:3080']
        const ctx = 造上下文桩({ webStartup: { trustedHosts: 启动清单组 } })

        expect(readTrustedHosts(ctx)).toEqual(启动清单组)
    })

    it('webStartup 的清单是空数组时回空清单——空数组是合法清单，不当作缺席', () => {
        const ctx = 造上下文桩({ webStartup: { trustedHosts: [] } })

        expect(readTrustedHosts(ctx)).toEqual([])
    })

    it('webStartup.trustedHosts 不是数组时回空清单', () => {
        const 非数组值组: unknown[] = ['startup.example:3080', { host: 'startup.example' }, undefined]

        for (const 非数组值 of 非数组值组) {
            const ctx = 造上下文桩({ webStartup: { trustedHosts: 非数组值 } })

            expect(readTrustedHosts(ctx)).toEqual([])
        }
    })

    it('webStartup 缺席时回空清单——围栏退化为只允许回环', () => {
        expect(readTrustedHosts(造上下文桩({}))).toEqual([])
    })

    it('webRuntime 存在也不读（来源单源）', () => {
        const 运行时清单组 = ['runtime.example:3080']
        const 启动清单组 = ['startup.example:3080']
        const ctx = 造上下文桩({
            webRuntime: { trustedHosts: 运行时清单组 },
            webStartup: { trustedHosts: 启动清单组 },
        })

        expect(readTrustedHosts(ctx)).toEqual(启动清单组)
    })
})
