/**
 * 「子代理通知暂存」进度行判据的测试。
 *
 * 被测对象是 `src/client/progress-match.ts` 的 `createProgressTracker()`：逐条喂会话事件，
 * 命中返回 true。事件形态全部取自真机会话存档（各工作区目录下的 `session.v4.jsonl.zstd`），
 * 只保留判定用到的字段，消息正文截短。
 *
 * 关键样本：
 * - 假阳性（平台把用户排队消息改道，落同形的 canceled 事件）：session-8ca513a9 seq376-378、
 *   session-b63d4ee4 seq895-897、session-8d6fa915 seq330-332；
 * - 真阳性（插件摘除结算通知）：session-36760d94 seq82-87。
 *
 * @module dsh-harden/tests/progress-match
 */

import { describe, expect, it } from 'vitest'
import { createProgressTracker } from '../src/client/progress-match.js'
import type { ProgressEvent } from '../src/client/progress-match.js'

/** 造一条平台收件簿事件（`agent/inbox/spliced`）：只填判定用到的字段。 */
function 造收件簿事件(seq: number, data: ProgressEvent['data']): ProgressEvent {
    return { type: 'agent/inbox/spliced', seq, data }
}

/** 造一条「纯插入」形态：平台把消息插进收件箱（真机里没有 removedCount / outcome）。 */
function 造插入(seq: number, 消息组: unknown[]): ProgressEvent {
    return 造收件簿事件(seq, { inserted: 消息组 })
}

/** 造一条「取消摘除」形态：摘掉 1 条、不补任何消息。 */
function 造摘除(seq: number): ProgressEvent {
    return 造收件簿事件(seq, { removedCount: 1, inserted: [], outcome: 'canceled' })
}

/** 造一条「就地替换」形态：摘掉 1 条、补进新消息。 */
function 造替换(seq: number, 消息组: unknown[]): ProgressEvent {
    return 造收件簿事件(seq, { removedCount: 1, inserted: 消息组, outcome: 'canceled' })
}

/** 造一条结算通知：子代理结算时平台插进父代理收件箱的那条消息。 */
function 造结算通知(会话标识: string): unknown {
    return {
        content: [
            { type: 'text', text: `Background subagent ${会话标识} finished its work.` },
            { type: 'text', text: 'Its closing message:' },
            { type: 'text', text: '…' },
        ],
        source: {
            kind: 'subagent-settled',
            form: 'notice',
            summary: `Background subagent ${会话标识} settled`,
            senderSessionId: 会话标识,
        },
        role: 'user',
        id: '通知标识',
    }
}

/** 造一条聚合消息：插件把多条结算通知合成的那条（与结算通知同 kind）。 */
function 造聚合消息(): unknown {
    return {
        content: [{ type: 'text', text: '3 background subagents settled…' }],
        source: {
            kind: 'subagent-settled',
            form: 'notice',
            summary: '3 background subagents settled',
            senderSessionId: '0c9d6128',
        },
        role: 'user',
        id: '聚合消息标识',
    }
}

/** 造一条用户消息：平台把用户排队消息改道时走的也是这条 splice 路径（假阳性来源）。 */
function 造用户消息(): unknown {
    return {
        content: [{ type: 'text', text: '…' }],
        source: { kind: 'user', rpcId: '…', clientTimeZone: 'Asia/Shanghai' },
        role: 'user',
        id: '用户消息标识',
    }
}

describe('进度行判据（邻接配对）', () => {
    it('用户排队消息改道（8ca513a9 seq376-378）：不命中', () => {
        const tracker = createProgressTracker()

        expect(tracker.feed(造插入(376, [造用户消息()]))).toBe(false)
        expect(tracker.feed(造摘除(377))).toBe(false)
        expect(tracker.feed(造插入(378, [造用户消息()]))).toBe(false)
    })

    it('结算通知插入后紧跟摘除：命中', () => {
        const tracker = createProgressTracker()

        expect(tracker.feed(造插入(82, [造结算通知('8deaa37a')]))).toBe(false)
        expect(tracker.feed(造摘除(83))).toBe(true)
    })

    it('真机聚合批回放（36760d94 seq82-87）：两批命中，聚合那条不命中', () => {
        const tracker = createProgressTracker()

        const 命中组 = [
            tracker.feed(造插入(82, [造结算通知('8deaa37a')])),
            tracker.feed(造摘除(83)),
            tracker.feed(造插入(84, [造结算通知('6bd9c521')])),
            tracker.feed(造摘除(85)),
            tracker.feed(造插入(86, [造结算通知('0c9d6128')])),
            tracker.feed(造替换(87, [造聚合消息()])),
        ]

        expect(命中组).toEqual([false, true, false, true, false, false])
    })

    it('孤立摘除（前一条是无关事件）：不命中', () => {
        // 真机样本 b63d4ee4 seq896 就是这样：前一条是 step/start。
        const tracker = createProgressTracker()

        expect(tracker.feed({ type: 'step/start', seq: 895, data: {} })).toBe(false)
        expect(tracker.feed(造摘除(896))).toBe(false)
    })

    it('插入与摘除之间夹了别的类型事件：不命中', () => {
        const tracker = createProgressTracker()

        expect(tracker.feed(造插入(42, [造结算通知('甲')]))).toBe(false)
        expect(tracker.feed({ type: 'assistant/message', seq: 43, data: {} })).toBe(false)
        expect(tracker.feed(造摘除(44))).toBe(false)
    })

    it('非 splice 事件：不命中', () => {
        const tracker = createProgressTracker()

        expect(tracker.feed({ type: 'step/start', seq: 1, data: {} })).toBe(false)
        // 字段形状与「取消摘除」一样，但事件类型不对：判据先认类型。
        expect(tracker.feed({ type: 'assistant/message', seq: 2, data: { removedCount: 1, inserted: [], outcome: 'canceled' } })).toBe(false)
    })

    it('连续两批（82-83 紧跟 84-85）：两次独立命中', () => {
        const tracker = createProgressTracker()

        expect(tracker.feed(造插入(82, [造结算通知('8deaa37a')]))).toBe(false)
        expect(tracker.feed(造摘除(83))).toBe(true)
        expect(tracker.feed(造插入(84, [造结算通知('6bd9c521')]))).toBe(false)
        expect(tracker.feed(造摘除(85))).toBe(true)
    })

    it('transient 事件（seq 小数）夹在中间：不干扰配对', () => {
        const tracker = createProgressTracker()

        expect(tracker.feed(造插入(200, [造结算通知('甲')]))).toBe(false)
        expect(tracker.feed({ type: 'assistant/live-chunk', seq: 200.5, data: {} })).toBe(false)
        expect(tracker.feed(造摘除(201))).toBe(true)
    })

    it('seq 回退（换会话 / 窗口重建）：重置状态，不误命中也不漏命中', () => {
        const tracker = createProgressTracker()

        // 第一段会话：正常命中一批。
        expect(tracker.feed(造插入(900, [造结算通知('甲')]))).toBe(false)
        expect(tracker.feed(造摘除(901))).toBe(true)

        // 换到另一段会话（seq 回退）：本条即使自己就是「取消摘除」也不判定——旧状态已作废。
        expect(tracker.feed(造摘除(10))).toBe(false)

        // 回退之后按本条形态重新起头：再走一批仍然命中。
        expect(tracker.feed(造插入(11, [造结算通知('乙')]))).toBe(false)
        expect(tracker.feed(造摘除(12))).toBe(true)
    })

    it('replace 形态（带 removedCount）不置位：紧随其后的摘除不命中', () => {
        const tracker = createProgressTracker()

        expect(tracker.feed(造插入(82, [造结算通知('8deaa37a')]))).toBe(false)
        expect(tracker.feed(造摘除(83))).toBe(true)
        expect(tracker.feed(造替换(87, [造聚合消息()]))).toBe(false)
        expect(tracker.feed(造摘除(88))).toBe(false)
    })
})
