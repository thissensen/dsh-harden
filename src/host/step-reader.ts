/**
 * 「本回合最后一步的 assistant 消息快照」——规则 H1 与 H2 的判定输入。
 *
 * **记忆而不是扫会话日志。** 旧实现每回合全量扫一遍会话事件、找该回合 step 最大的 assistant/message；
 * 平台已把那组同步读取面标 deprecated「新调用禁止」，而 `ctx.agents.turnBoundaryOf()` 只给位置号、
 * 拿不到消息正文。现在改由 `session/event` 观察者增量记下每个会话最后一条 assistant 消息
 * （见 `mountTurnSnapshotMemory`），回合收尾时只查一次记忆。
 *
 * **一回合一读。** H1 与 H2 看的是同一条消息：调用方（`index.ts` 的回合收尾监听器）先读一次快照
 * 再分发给两条规则，不必各查一遍记忆、各拼一遍正文。
 *
 * @module dsh-harden/step-reader
 */

import type { AssistantMessageLike, Ctx, SessionEventLike, SessionLike } from './types.js'

/** 回合最后一步的快照；正文与思考都已按换行拼接并 trim，判定规则直接拿去比对。 */
export interface TurnSnapshot {
    readonly step: number
    /** 这一步是否发起了工具调用。 */
    readonly hasToolCall: boolean
    /** text 块先按换行拼接、再 trim（与旧实现同序，别改成先 trim 再拼）。 */
    readonly wholeText: string
    readonly wholeReasoning: string
}

/** 一个会话记住的「最后一条 assistant 消息」：只记最新一条，不累积。 */
interface 回合消息记忆 {
    readonly turn: number
    readonly step: number
    readonly message: AssistantMessageLike
    /** 写下这条记忆的挂载代号（见 `当前挂载代号`）。 */
    readonly 挂载代号: number
}

/** 每个会话的回合消息记忆；键是 session 对象本身（WeakMap 让会话回收时记忆自动消失）。 */
const 回合消息记忆组 = new WeakMap<object, 回合消息记忆>()

/**
 * 当前挂载的代号：每挂一次加一。
 *
 * **为什么需要它。** 热重载复用模块实例时 `回合消息记忆组` 还在，旧监听器在回合中途留下的快照会
 * 一直留到回合收尾；若只比回合号，收尾时会把那份**过时的**（step 更小）快照当成本回合最后一步，
 * H2 就会对着一步只有思考的消息误伤。比代号后旧挂载的记忆一律作废 ⇒ 该回合漏判（宁可漏判、不可误伤）。
 */
let 当前挂载代号 = 0

/**
 * 挂「回合消息记忆」：订阅 `session/event`，把每个会话最后一条 `assistant/message` 记下来。
 *
 * **为什么够用。** `session/event` 是 post-commit（平台先把事件写进日志、再通知观察者），所以回合
 * 收尾判定那一刻，记忆里已经是本回合最后一条 assistant 消息。
 *
 * **已接受的语义变化。** 插件热重载正好夹在回合中间时，当前回合此前写下的消息没进记忆 ⇒ 该回合
 * H1/H2 漏判——宁可漏判、不可误伤。旧挂载在回合中途留下的那份记忆按挂载代号作废（见
 * `当前挂载代号`），不会拿陈旧快照误伤。
 *
 * **本轮未验证的假设。** `session/event` 给出的 session 与 `agent.session` 是同一个对象（记忆按它
 * 做键）；真机任务首查这一条。
 *
 * @param ctx - cordis 上下文。
 */
export function mountTurnSnapshotMemory(ctx: Ctx): void {
    当前挂载代号 += 1
    const 本次挂载代号 = 当前挂载代号

    ctx.on('session/event', (sessionRaw: unknown, eventRaw: unknown): void => {
        if (eventRaw === null || typeof eventRaw !== 'object') return

        const event = eventRaw as SessionEventLike
        if (event.type !== 'assistant/message') return

        const turn = event.data?.turn
        const step = event.data?.step
        const message = event.data?.message
        if (typeof turn !== 'number' || Number.isInteger(turn) === false) return
        if (typeof step !== 'number' || Number.isInteger(step) === false) return
        if (message === undefined || message === null || typeof message !== 'object') return

        const 上一条记忆 = 回合消息记忆组.get(sessionRaw as object)
        // 同回合里步号更小的旧消息不许盖掉新的：判定看的是最后一步，被盖回去就是误判。
        if (上一条记忆 !== undefined && 上一条记忆.turn === turn && 上一条记忆.step > step) return

        回合消息记忆组.set(sessionRaw as object, { turn, step, message, 挂载代号: 本次挂载代号 })
    })
}

/**
 * 取某回合**最后一步**的消息快照。
 *
 * 规则 H1 与 H2 在 `agent/turn-stopping` 上判定时用：那一刻的载荷没有 step 号，只能取记忆里该回合
 * step 最大的那条（记忆只留最新一条，同一步出现多条时后者胜）。
 *
 * @param session - agent 的会话（记忆的键）。
 * @param turn - 回合号。
 * @returns 最后一步的快照；记忆里没有该回合的消息、或记忆来自旧的挂载时返回 null（放行）。
 */
export function readTurnSnapshot(session: SessionLike, turn: number): TurnSnapshot | null {
    const 记忆 = 回合消息记忆组.get(session)
    if (记忆 === undefined || 记忆.turn !== turn) return null
    if (记忆.挂载代号 !== 当前挂载代号) return null

    return 投影回合快照(记忆.message, 记忆.step)
}

/**
 * 把一条 assistant 消息投影成判定用的快照：正文与思考各自按换行拼接、最后整体 trim。
 *
 * **拼接与 trim 的顺序不能换。** text 块先按换行拼起来、再对整体 trim；反过来会把块间换行吃掉，
 * H1 的整段前缀比对与 H2 的「有没有正文」都跟着变。
 *
 * @param message - 一条 assistant 消息。
 * @param step - 这条消息所在的步号（写进快照，命中说明回显它）。
 * @returns 判定用的快照。
 */
export function 投影回合快照(message: AssistantMessageLike, step: number): TurnSnapshot {
    const 正文块组: string[] = []
    const 思考块组: string[] = []
    let 是否发起工具调用 = false

    for (const block of message.content ?? []) {
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
        step,
        hasToolCall: 是否发起工具调用,
        wholeText: 正文块组.join('\n').trim(),
        wholeReasoning: 思考块组.join('\n').trim(),
    }
}
