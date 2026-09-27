/**
 * 规则 H1 —— 工具调用失败被吞。
 *
 * **现象**（已核实的真机会话，见 `05-坑册.md` 坑 1）：工具调用失败的那个回合**只有 1 步**
 * ——平台把坏 tool-call 丢弃、把警告塞进 assistant 的 text 块，主循环以为模型说完了，
 * `turn/end: completed`，会话卡死。所以判定必须读**本回合最后一步**的正文；旧实现在
 * `agent/pre-step` 上判「上一步」，那个挂点永远判不到，这是 H1 完全失效的根因。
 *
 * **判据**（用户裁决 2026-09-27）：读最后一步的 text 块，**整段** trim 后 `startsWith`
 * 用户配置的前缀（多条 OR、区分大小写、前缀先 trim）。有 tool-call 块 = 正常干活，放行。
 * **不拆行匹配**：AI 在正文里引用/粘贴平台警告原文（哪怕单独起一行）不应误伤，故只有整段
 * 开头就是警告才算真失败；真失败时整段 trim 后正是警告本身。
 *
 * **动作**：挂点与 H2 相同（`agent/turn-stopping`，serial），命中就 `agent.steer(...)`
 * 把回合掰回再走一步。判定全部收敛在本文件，是明账技术债。
 *
 * @module dsh-harden/guard
 */

import type { SessionLike } from './types.js'
import {
    hasToolCall,
    joinReasoningBlocks,
    joinTextBlocks,
    readLastStepAssistantMessage,
} from './step-reader.js'

/** 纠正消息的正文——用户定稿：'你调用工具失败' + '请重新发起'。 */
export const NUDGE_TEXT =
    '你上一次的工具调用没有成功执行（框架未返回工具结果）。' +
    '请检查工具名与参数后，重新发起这一次调用。'

/** 命中说明里回显的整段文本长度上限。 */
const MATCHED_TEXT_MAX = 120

/**
 * 判定「回合最后一步是不是静默工具失败」。
 *
 * 线性步骤：读最后一步的消息 → 有 tool-call 块放行 → 解析前缀组（空组放行）→
 * 整段 trim 后比对 text（命中即返回说明）→ 否则放行。
 *
 * @param session - agent 的会话。
 * @param turn - 即将关闭的回合号。
 * @param prefixes - 用户配置的前缀组（一行一条，`\n` 分隔）。
 * @returns 命中时返回一句简短说明；未命中返回 null。
 */
export function detectSilentToolFailure(
    session: SessionLike,
    turn: number,
    prefixes: string,
): string | null {
    const last = readLastStepAssistantMessage(session, turn)
    if (last === null) return null
    if (hasToolCall(last.message)) return null

    const prefixList: string[] = []
    for (const rawPrefix of prefixes.split('\n')) {
        const prefix = rawPrefix.trim()
        if (prefix !== '') prefixList.push(prefix)
    }
    if (prefixList.length === 0) return null

    const wholeText = joinTextBlocks(last.message).trim()
    for (const prefix of prefixList) {
        if (wholeText.startsWith(prefix)) return matchedTextNotice(wholeText)
    }

    return null
}

/** 命中时回显的说明：整段太长就截断，避免把整段正文塞进日志。 */
function matchedTextNotice(wholeText: string): string {
    if (wholeText.length <= MATCHED_TEXT_MAX) return `命中工具失败前缀：${wholeText}`

    return `命中工具失败前缀：${wholeText.slice(0, MATCHED_TEXT_MAX)}…`
}

/** 规则 H2 的纠正消息正文。 */
export const EMPTY_TURN_NUDGE_TEXT =
    '你上一次没有给用户任何回复就结束了回合。' +
    '请把当前进展与结果用正文讲清楚，不要让回合在没有答复时收尾。'

/**
 * 判定「回合收尾时是不是没给用户任何答复」（规则 H2）。
 *
 * 与 H1 不同，这里是**结构判定**，不做文本匹配：读本回合最后一步的 assistant 消息，
 * 既没有 tool-call 块、也没有非空 text 块，却有 reasoning（模型确实思考过）——
 * 就是「只输出思考、没正文」的静默收尾。
 *
 * 没有 reasoning 的空消息不算（那更像平台异常，不是本条打击对象），一律放行。
 *
 * @param session - agent 的会话。
 * @param turn - 即将关闭的回合号。
 * @returns 命中时返回一句简短说明；未命中返回 null。
 */
export function detectEmptyTurnEnd(
    session: SessionLike,
    turn: number,
): string | null {
    const last = readLastStepAssistantMessage(session, turn)
    if (last === null) return null
    if (hasToolCall(last.message)) return null
    if (joinTextBlocks(last.message).trim() !== '') return null

    const reasoning = joinReasoningBlocks(last.message)
    if (reasoning.trim() === '') return null

    return `回合在第 ${last.step} 步只有思考、没有正文就收尾`
}
