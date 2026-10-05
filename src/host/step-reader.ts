/**
 * 从会话日志里读「回合最后一步的 assistant 消息」——规则 H1 与 H2 的判定输入。
 *
 * **读取面收敛点。** 这里用到平台的 `Session.snapshotEvents()`，它已被平台标为
 * deprecated（2026-09-27 核实）；平台建议改用 `ctx.sessionQuery` 或
 * `ctx.sessionProjections`（见 dsh-agent-preset/skills 的 practices.md）。
 * 所以整个读取面**收敛在这一个文件里**，将来只改这一处。
 *
 * @module dsh-harden/step-reader
 */

import type { AssistantMessageLike, SessionEventLike, SessionLike } from './types.js'

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
 * 取某回合**最后一步**的 assistant 消息。
 *
 * 规则 H2 在 `agent/turn-stopping` 上判定时用：那一刻的载荷没有 step 号，
 * 只能读会话里该回合 step 最大的那条。
 *
 * @param session - agent 的会话。
 * @param turn - 回合号。
 * @returns 最后一步的步号与消息；该回合没有任何 assistant 消息时返回 null。
 */
export function readLastStepAssistantMessage(
    session: SessionLike,
    turn: number,
): { step: number; message: AssistantMessageLike } | null {
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

    return { step: lastStep, message: lastMessage }
}

/** 这一步是否发起了工具调用（有 tool-call 块）。 */
export function hasToolCall(message: AssistantMessageLike | null): boolean {
    if (message === null) return false
    const content = message.content ?? []
    return content.some((block) => block.type === 'tool-call')
}

/** 把消息里的 text 块拼成一段文本（判定平台警告用）。 */
export function joinTextBlocks(message: AssistantMessageLike | null): string {
    return joinBlocks(message, 'text')
}

/** 把消息里的 reasoning 块拼成一段文本（判定「打算调用工具」用）。 */
export function joinReasoningBlocks(message: AssistantMessageLike | null): string {
    return joinBlocks(message, 'reasoning')
}

/** 把消息里某一类内容块拼成一段文本；块之间用换行分隔。 */
function joinBlocks(message: AssistantMessageLike | null, blockType: 'text' | 'reasoning'): string {
    if (message === null) return ''

    const content = message.content ?? []
    const parts: string[] = []
    for (const block of content) {
        if (block.type !== blockType) continue

        const text = (block as { text?: unknown }).text
        if (typeof text === 'string') parts.push(text)
    }

    return parts.join('\n')
}
