/**
 * 规则「突破 PTC 120 秒限制」：把 PTC 运行时的程序预算抬到平台计时器上限。
 *
 * **为什么直接改 `ptcRuntime.config` 而不包装 `resolve`。** 包装 `resolve` 也改不了 `run()` 的
 * `spec.timeoutMs <= config.maxTimeoutMs` 上界校验——超过上界的 spec 会在程序启动前抛错；而
 * `config` 的那两个数字同时决定默认值与上界，改一处就两头一起抬，且一个字都不碰平台代码。
 *
 * **为什么两个字段必须一起抬。** 平台 `run()` 校验 `spec.timeoutMs <= config.maxTimeoutMs`，
 * 只抬 `timeoutMs` 会让每个程序在启动前就抛错——两个数字必须同时到上限。
 *
 * **失效症状（排查先看这两条）。** 开关打开后程序仍被 120 秒杀掉、日志里没有「PTC 程序预算
 * 已抬到 …」那行，说明本模块没挂上，或 `config` 被冻结（下方 warn 文案）。
 *
 * 本模块不许 import 任何 `@deepseek-ai/*` 包：CI 上没有宿主包，只认 `./types.js` 里的本地类型。
 *
 * @module dsh-harden/ptc-budget
 */

import type { Ctx, Logger, PtcRuntimeService } from './types.js'

/** 平台计时器上限（@deepseek-ai/dsh-timeout 的 MAX_TIMER_DELAY_MS，0.2.1-rc.2 实读）。 */
export const PTC_BUDGET_MAX_MS = 2_147_483_647

/**
 * 原值的挂载键。用 Symbol.for 挂在 runtime 对象上：插件 reload 后模块会重新求值，
 * 只有挂在实例上才认得出「这个实例的预算是我抬起来的」。
 */
const ORIGINAL_BUDGET_KEY = Symbol.for('dsh-harden.ptcBudgetOriginal')

/** 抬升前捕获到的那两个数字。 */
interface 原预算 {
    timeoutMs: number
    maxTimeoutMs: number
}

/** 同一个 runtime 只警告一次，免得每次改配置都往日志里灌一遍。 */
const 已警告组 = new WeakSet<object>()

/**
 * 挂 PTC 程序预算的开关。
 *
 * **为什么这条 inject 只依赖 `ptcRuntime`。** 可选服务并进共享的依赖列表会把整条 fiber
 * 停在 INACTIVE ⇒ 回调永不执行（`.harness/05-坑册.md` 坑 37）。没装 PTC 的 profile 里
 * 这个服务本来就不存在，本段逻辑跟着一起缺席才是对的。
 *
 * @param ctx - cordis 上下文。
 * @param logger - 日志出口。
 * @param isEnabled - 现取现解包的开关读取器（volatile 字段改了要重读）。
 */
export function mountPtcBudget(ctx: Ctx, logger: Logger, isEnabled: () => boolean): void {
    ctx.inject(['ptcRuntime'], (ptcCtx: Ctx) => {
        const runtime = ptcCtx.ptcRuntime
        const 同步预算 = (): void => applyPtcBudget(runtime, isEnabled(), logger)

        同步预算()
        // 不按命名空间过滤：读一个布尔的成本可忽略，过滤反而多一处静默失效点。
        ptcCtx.on('settings/document-updated', () => 同步预算())
        // 插件卸载 / reload 时还原，别把抬过的上限留给下一份插件实例。
        ptcCtx.effect(() => () => applyPtcBudget(runtime, false, logger), 'harden: ptc budget')
    })
}

/**
 * 按目标态收敛 runtime 的预算（幂等，不返回 disposer）。
 *
 * @param runtime - PTC 运行时服务实例（`ctx.ptcRuntime`）。
 * @param enabled - 目标态：true 抬到上限，false 写回原值。
 * @param logger - 日志出口。
 */
export function applyPtcBudget(runtime: unknown, enabled: boolean, logger: Logger): void {
    if (runtime === null || typeof runtime !== 'object') return

    const config = (runtime as PtcRuntimeService).config
    if (config === null || typeof config !== 'object') return

    // 静默返回：基类 `PtcRuntime` 的 `timeout` 默认就是 undefined，允许 PTC 实现没有预算概念。
    if (typeof config.timeoutMs !== 'number' || typeof config.maxTimeoutMs !== 'number') return

    const 挂载表 = runtime as Record<symbol, 原预算 | undefined>
    const 已记录 = 挂载表[ORIGINAL_BUDGET_KEY]

    try {
        if (enabled) {
            // 已有原值就返回：重捕获会把抬高的值当原值，关了再也降不回来。
            if (已记录 !== undefined) return

            const 原值: 原预算 = { timeoutMs: config.timeoutMs, maxTimeoutMs: config.maxTimeoutMs }
            挂载表[ORIGINAL_BUDGET_KEY] = 原值
            config.timeoutMs = PTC_BUDGET_MAX_MS
            config.maxTimeoutMs = PTC_BUDGET_MAX_MS
            // 日志必须打捕获到的原值：两个字段此刻已经被改过，读 config 只会看到上限。
            logger.info?.(
                `[harden] PTC 程序预算已抬到 ${PTC_BUDGET_MAX_MS} ms（原值 timeoutMs=${原值.timeoutMs}, maxTimeoutMs=${原值.maxTimeoutMs}）`,
            )
            return
        }

        if (已记录 === undefined) return

        config.timeoutMs = 已记录.timeoutMs
        config.maxTimeoutMs = 已记录.maxTimeoutMs
        delete 挂载表[ORIGINAL_BUDGET_KEY]
        logger.info?.(
            `[harden] PTC 程序预算已还原（timeoutMs=${已记录.timeoutMs}, maxTimeoutMs=${已记录.maxTimeoutMs}）`,
        )

    } catch (error) {
        if (已警告组.has(runtime)) return

        已警告组.add(runtime)
        logger.warn?.('[harden] PTC 程序预算改不动（config 被冻结或字段只读），该开关不生效', error)
    }
}
