/**
 * 从会话日志里读「某回合最后一步的 assistant 消息快照」——规则 H1 与 H2 的判定输入。
 *
 * **读取面收敛点。** 这里用到平台的 `Session.snapshotEvents()`，它已被平台标为
 * deprecated（2026-09-27 核实）；平台建议改用 `ctx.sessionQuery` 或
 * `ctx.sessionProjections`（见 dsh-agent-preset/skills 的 practices.md）。
 * 所以整个读取面**收敛在这一个文件里**，将来只改这一处。
 *
 * **一回合一读。** H1 与 H2 看的是同一条消息：调用方（`index.ts` 的回合收尾监听器）
 * 先读一次快照再分发给两条规则，不必各扫一遍会话、各拼一遍正文。
 *
 * @module dsh-harden/step-reader
 */

import type { AssistantMessageLike, SessionEventLike, SessionLike } from './types.js'

/** 回合最后一步的快照；正文与思考都已按换行拼接并 trim，判定规则直接拿去比对。 */
export interface TurnSnapshot {
    readonly step: number
    /** 这一步是否发起了工具调用。 */
    readonly hasToolCall: boolean
    /** text 块先按换行拼接、再 trim（与旧实现同序，别改成先 trim 再拼）。 */
    readonly wholeText: string
    readonly wholeReasoning: string
}

/**
 * 读会话事件；任何读取失败都当作空数组——看护层不能因为读不到历史就把会话搞挂。
 *
 * `snapshotEvents()` 平台已标 deprecated，形状也可能随版本变（例如返回非数组）；
 * 这里的 catch 是刻意的：读历史失败只该让本轮判定落空（放行），不该把异常抛进正常回合。
 *
 * @param session - agent 的会话。
 * @returns 事件组；读不到时为空数组。
 */
export function readEventsSafely(session: SessionLike): readonly SessionEventLike[] {
    try {
        const events = session.snapshotEvents()

        return Array.isArray(events) ? events : []

    } catch {
        return []
    }
}

/**
 * 取某回合**最后一步**的消息快照。
 *
 * 规则 H1 与 H2 在 `agent/turn-stopping` 上判定时用：那一刻的载荷没有 step 号，
 * 只能读会话里该回合 step 最大的那条；同一步出现多条时后者胜（与平台按 seq 追加的顺序一致）。
 *
 * @param session - agent 的会话。
 * @param turn - 回合号。
 * @returns 最后一步的快照；该回合没有任何可用 assistant 消息时返回 null。
 */
export function readTurnSnapshot(session: SessionLike, turn: number): TurnSnapshot | null {
    let lastStep = -1
    let lastMessage: AssistantMessageLike | null = null

    for (const event of readEventsSafely(session)) {
        if (event.type !== 'assistant/message') continue
        if (event.data?.turn !== turn) continue

        const step = event.data.step
        const message = event.data.message
        if (step === undefined || message === undefined || message === null) continue
        if (step < lastStep) continue

        lastStep = step
        lastMessage = message
    }

    if (lastMessage === null) return null

    const 正文块组: string[] = []
    const 思考块组: string[] = []
    let 是否发起工具调用 = false

    for (const block of lastMessage.content ?? []) {
        if (block.type === 'tool-call') {
            是否发起工具调用 = true
            continue
        }

        if (block.type !== 'text' && block.type !== 'reasoning') continue

        const 文本 = (block as { text?: unknown }).text
        if (typeof 文本 !== 'string') continue

        if (block.type === 'text') {
            正文块组.push(文本)
        } else {
            思考块组.push(文本)
        }
    }

    return {
        step: lastStep,
        hasToolCall: 是否发起工具调用,
        wholeText: 正文块组.join('\n').trim(),
        wholeReasoning: 思考块组.join('\n').trim(),
    }
}
