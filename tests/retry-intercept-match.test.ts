/**
 * 「重试链已修正」提示行判据的测试。
 *
 * 被测对象是 `src/client/retry-intercept-match.ts` 的 `统计回合修正数()`：给定 host 端点
 * `GET /api/dsh-harden/retry-intercepts` 的记录组与当前回合号，数出该回合有几处修正。
 * 记录形态取自 host 侧契约（`{ 回合, 步, 序号, 时间戳 }`），只保留判定用到的字段。
 * 另外覆盖 `取回合号()`：插槽给的 `turn` 是平台的位置对象（`TurnLocation`），回合号在 `turn.turn`。
 *
 * 记录组是 HTTP 响应体 ⇒ 当不可信输入：字段类型不符的条目跳过、不计入（也不抛）。
 *
 * @module dsh-harden/tests/retry-intercept-match
 */

import { describe, expect, it } from 'vitest'
import { 取回合号, 统计回合修正数, 读记录组 } from '../src/client/retry-intercept-match.js'
import type { 拦截记录 } from '../src/client/retry-intercept-match.js'

/** 造一条本回合（第 3 回合）的拦截记录。 */
function 造记录(): 拦截记录 {
    return { 回合: 3 }
}

describe('重试链修正行判据（按回合计数）', () => {
    it('没有记录（会话上没发生过修正）：0 处', () => {
        expect(统计回合修正数([], 3)).toBe(0)
    })

    it('记录组里只有别的回合：本回合 0 处', () => {
        expect(统计回合修正数([{ 回合: 1 }, { 回合: 2 }], 3)).toBe(0)
    })

    it('本回合 1 条：1 处', () => {
        expect(统计回合修正数([造记录()], 3)).toBe(1)
    })

    it('本回合多条 + 夹着别的回合：只数本回合', () => {
        const 记录组: 拦截记录[] = [{ 回合: 1 }, 造记录(), { 回合: 3 }, { 回合: 4 }, 造记录()]

        expect(统计回合修正数(记录组, 3)).toBe(3)
    })

    it('回合字段是字符串：不计入（也不抛）', () => {
        const 记录组 = [造记录(), { 回合: '3' }] as unknown as 拦截记录[]

        expect(统计回合修正数(记录组, 3)).toBe(1)
    })

    it('回合字段缺失 / 记录本身不是对象：不计入（也不抛）', () => {
        const 记录组 = [{ 步: 1 }, null, '3', 造记录()] as unknown as 拦截记录[]

        expect(统计回合修正数(记录组, 3)).toBe(1)
    })

    it('读记录组：不是数组（形状不符）→ 空数组 → 0 处', () => {
        expect(读记录组(undefined)).toEqual([])
        expect(读记录组({ 记录组: 'x' })).toEqual([])
        expect(读记录组(null)).toEqual([])
        expect(统计回合修正数(读记录组(null), 3)).toBe(0)
    })

    it('读记录组：数组原样收下，逐条计数', () => {
        expect(统计回合修正数(读记录组([造记录(), 造记录()]), 3)).toBe(2)
    })
})

describe('取回合号（插槽给的 turn 是位置对象，回合号在 turn.turn）', () => {
    it('平台真实形态：从 位置.turn 取到回合号', () => {
        const 位置 = { turn: 1, start: 0, end: 2, status: 'completed', steps: [], data: {} }

        expect(取回合号(位置)).toBe(1)
    })

    it('位置里没有 turn 这一格：null', () => {
        expect(取回合号({ start: 0, end: 2 })).toBe(null)
    })

    it('turn 不是数字（字符串 / 嵌套对象）：null', () => {
        expect(取回合号({ turn: '1' })).toBe(null)
        expect(取回合号({ turn: { turn: 1 } })).toBe(null)
    })

    it('turn 不是有限数（NaN / Infinity）：null', () => {
        expect(取回合号({ turn: Number.NaN })).toBe(null)
        expect(取回合号({ turn: Number.POSITIVE_INFINITY })).toBe(null)
    })

    it('turn 是 null / undefined：null', () => {
        expect(取回合号({ turn: null })).toBe(null)
        expect(取回合号({ turn: undefined })).toBe(null)
    })

    it('位置本身是 null / undefined（平台位置不是回合/步时不传这一格）：null', () => {
        expect(取回合号(null)).toBe(null)
        expect(取回合号(undefined)).toBe(null)
    })

    it('直接传数字：null —— 平台给的是对象，我们只认声明形态', () => {
        // 平台的 owner props 是 { turn: TurnLocation, seq, openFile }，回合号只在 位置.turn 里；
        // 顺手认下数字等于给「props 形状变了」留一条静默通道，故这里必须是 null。
        expect(取回合号(1)).toBe(null)
    })
})
