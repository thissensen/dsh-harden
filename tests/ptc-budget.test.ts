/**
 * 规则「突破 PTC 120 秒限制」（`src/host/ptc-budget.ts`）的单元测试。
 *
 * 被测对象是 `applyPtcBudget`：按目标态把 PTC 运行时的那两个预算字段抬到上限 / 写回原值，
 * 幂等且不外抛——开关反复改、config 被冻结、服务形状不对，都不能把配置通路带崩。
 *
 * **不 import 任何 `@deepseek-ai/*` 包**（CI 上没有宿主包）：只造一个带 `config: { timeoutMs, maxTimeoutMs }`
 * 的普通对象当 runtime，断言读的是它上面真实被写进去的值。
 *
 * @module dsh-harden/tests/ptc-budget
 */

import { describe, expect, it } from 'vitest'
import { applyPtcBudget, PTC_BUDGET_MAX_MS } from '../src/host/ptc-budget.js'
import type { Logger } from '../src/host/types.js'

/** 原值的挂载键（与模块内 Symbol.for 的键名一致，断言用它验真被挂上）。 */
const 原值键 = Symbol.for('dsh-harden.ptcBudgetOriginal')

/** 计数型日志桩：info / warn 的实参收进数组，断言读真实条数。 */
interface 日志桩 {
    readonly logger: Logger
    readonly 信息组: unknown[][]
    readonly 警告组: unknown[][]
}

/** 造一个计数型日志桩。 */
function 造日志桩(): 日志桩 {
    const 信息组: unknown[][] = []
    const 警告组: unknown[][] = []

    const logger: Logger = {
        info(...args: unknown[]): void {
            信息组.push(args)
        },
        warn(...args: unknown[]): void {
            警告组.push(args)
        },
    }

    return { logger, 信息组, 警告组 }
}

/** 造 PTC 运行时桩：平台默认的 120 秒程序预算、600 秒上界。 */
function 造运行时(默认预算 = 120_000, 上限 = 600_000): { config: { timeoutMs: number; maxTimeoutMs: number } } {
    return { config: { timeoutMs: 默认预算, maxTimeoutMs: 上限 } }
}

describe('applyPtcBudget', () => {
    it('开关打开时把 timeoutMs 与 maxTimeoutMs 一起写到计时器上限', () => {
        const runtime = 造运行时()

        applyPtcBudget(runtime, true, 造日志桩().logger)

        expect(runtime.config.timeoutMs).toBe(PTC_BUDGET_MAX_MS)
        expect(runtime.config.maxTimeoutMs).toBe(PTC_BUDGET_MAX_MS)
        // 钉住平台计时器上限：常量被误改会让上面两条断言跟着一起错，这条拦住。
        expect(PTC_BUDGET_MAX_MS).toBe(2_147_483_647)
    })

    it('开关关闭时把两个字段写回抬之前的原值', () => {
        const runtime = 造运行时()
        const 日志 = 造日志桩()

        applyPtcBudget(runtime, true, 日志.logger)
        applyPtcBudget(runtime, false, 日志.logger)

        expect(runtime.config.timeoutMs).toBe(120_000)
        expect(runtime.config.maxTimeoutMs).toBe(600_000)
        // 抬一次打一行、还原一次打一行，且整个过程没有警告。
        expect(日志.信息组).toHaveLength(2)
        expect(日志.警告组).toHaveLength(0)
    })

    it('重复打开不会把已抬高的值当成原值', () => {
        const runtime = 造运行时()
        const 日志 = 造日志桩()

        applyPtcBudget(runtime, true, 日志.logger)
        applyPtcBudget(runtime, true, 日志.logger)
        applyPtcBudget(runtime, false, 日志.logger)

        expect(runtime.config.timeoutMs).toBe(120_000)
        expect(runtime.config.maxTimeoutMs).toBe(600_000)
    })

    it('开关本来就关且从未抬过时一个字段都不动', () => {
        const runtime = 造运行时()

        applyPtcBudget(runtime, false, 造日志桩().logger)

        expect(runtime.config.timeoutMs).toBe(120_000)
        expect(runtime.config.maxTimeoutMs).toBe(600_000)
        expect(Object.hasOwn(runtime, 原值键)).toBe(false)
    })

    it('原值本来就高于插件默认上限时关闭也如实写回', () => {
        const runtime = 造运行时(900_000, 1_800_000)
        const 日志 = 造日志桩()

        applyPtcBudget(runtime, true, 日志.logger)
        applyPtcBudget(runtime, false, 日志.logger)

        // 恢复值必须是捕获到的那两个数字，不能拿 120000 / 600000 顶替。
        expect(runtime.config.timeoutMs).toBe(900_000)
        expect(runtime.config.maxTimeoutMs).toBe(1_800_000)
    })

    it('runtime 没有 config 字段时什么都不做也不抛错', () => {
        const 日志 = 造日志桩()

        for (const 入参 of [{}, undefined, null]) {
            expect(() => applyPtcBudget(入参, true, 日志.logger)).not.toThrow()
            expect(() => applyPtcBudget(入参, false, 日志.logger)).not.toThrow()
        }

        expect(日志.警告组).toHaveLength(0)
    })

    it('config 字段不是数字或缺一个时什么都不做', () => {
        const 缺一个 = { config: { timeoutMs: 120_000 } }
        const 类型不符 = { config: { timeoutMs: '120000', maxTimeoutMs: 600_000 } }
        const 日志 = 造日志桩()

        applyPtcBudget(缺一个, true, 日志.logger)
        applyPtcBudget(类型不符, true, 日志.logger)

        // 基类 PtcRuntime 的 timeout 默认就是 undefined，允许 PTC 实现没有预算概念 ⇒ 静默放过。
        expect(缺一个.config).toEqual({ timeoutMs: 120_000 })
        expect(类型不符.config).toEqual({ timeoutMs: '120000', maxTimeoutMs: 600_000 })
        expect(Object.hasOwn(缺一个, 原值键)).toBe(false)
        expect(Object.hasOwn(类型不符, 原值键)).toBe(false)
    })

    it('config 被冻结时只警告一次且不抛错', () => {
        const config = Object.freeze({ timeoutMs: 120_000, maxTimeoutMs: 600_000 })
        const runtime = { config }
        const 日志 = 造日志桩()

        // 开 → 关各写一次字段，两次都撞在同一份冻结 config 上：只有第一次该留警告。
        expect(() => applyPtcBudget(runtime, true, 日志.logger)).not.toThrow()
        expect(() => applyPtcBudget(runtime, false, 日志.logger)).not.toThrow()

        expect(日志.警告组).toHaveLength(1)
        // 两次都没走到「写成功之后」那行日志 ⇒ 关的那次同样撞进了 catch，警告确实被去重了。
        expect(日志.信息组).toHaveLength(0)
        expect(config.timeoutMs).toBe(120_000)
        expect(config.maxTimeoutMs).toBe(600_000)
    })

    it('原值记在 runtime 的 Symbol.for 键上（插件重载也认得出来）', () => {
        const runtime = 造运行时()

        applyPtcBudget(runtime, true, 造日志桩().logger)

        const 记录的原值 = (runtime as Record<symbol, unknown>)[原值键]
        expect(记录的原值).toEqual({ timeoutMs: 120_000, maxTimeoutMs: 600_000 })
    })
})
