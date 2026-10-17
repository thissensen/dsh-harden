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
 * **兜底判据**（用户裁决 2026-10-17）：第三方 API 路由下模型先写正文、再吐**文本形式**的工具
 * 调用标记，整段开头不是前缀 ⇒ 上面的判据判不到、回合静默结束。故**仅当前缀以 `<` 开头**时追
 * 加一条：整段含闭合标记（`</` + 前缀去掉首字符）且存在一行 trim 后以该前缀开头，同样算失败。
 * **已接受的代价**：正文里完整粘贴成对标记段会被判为失败；非 `<` 开头的前缀不启用此兜底。
 *
 * **动作**：挂点与 H2 相同（`agent/turn-stopping`，serial），命中就 `agent.steer(...)`
 * 把回合掰回再走一步。判定全部收敛在本文件，是明账技术债。
 *
 * @module dsh-harden/guard
 */

import type { TurnSnapshot } from './step-reader.js'

/** 纠正消息的正文——用户定稿：'你调用工具失败' + '请重新发起'。 */
export const NUDGE_TEXT =
    '你上一次的工具调用没有成功执行（框架未返回工具结果）。' +
    '请检查工具名与参数后，重新发起这一次调用。'

/** 命中说明里回显的整段文本长度上限。 */
const MATCHED_TEXT_MAX = 120

/**
 * 把用户配置的前缀串切成前缀组：按 `\n` 切开、逐条 trim、丢掉空串。
 *
 * @param prefixes - 用户配置的原始前缀串（一行一条）。
 * @returns 前缀组；全是空白时为空数组（H1 随之放行）。
 */
export function parseToolFailurePrefixes(prefixes: string): string[] {
    const 前缀组: string[] = []
    for (const rawPrefix of prefixes.split('\n')) {
        const prefix = rawPrefix.trim()
        if (prefix !== '') 前缀组.push(prefix)
    }

    return 前缀组
}

/**
 * 判定「回合最后一步是不是静默工具失败」（规则 H1）。
 *
 * 线性步骤：快照为空放行 → 有 tool-call 块放行 → 遍历前缀组，整段正文命中即返回说明 →
 * 标记类前缀（`<` 开头）再按「闭合标记 + 开标记行」兜底比对 → 否则放行。
 *
 * **前缀组为空不特判**：空数组进下面的 `for` 天然返回 null；「前缀没配就放行」由调用方
 * （监听器算出的 `是否判工具失败`）挡在门外，这里再写一条就是死分支。
 *
 * @param snapshot - 本回合最后一步的快照；读不到时为 null。
 * @param 前缀组 - 用户配置的前缀组（已切分、trim）。
 * @returns 命中时返回一句简短说明；未命中返回 null。
 */
export function detectSilentToolFailure(
    snapshot: TurnSnapshot | null,
    前缀组: readonly string[],
): string | null {
    if (snapshot === null) return null
    if (snapshot.hasToolCall) return null

    const 整段正文 = snapshot.wholeText
    for (const 前缀 of 前缀组) {
        if (整段正文.startsWith(前缀)) return matchedTextNotice(整段正文)

        // 兜底：第三方 API 路由下模型先写正文、再吐文本形式的工具调用标记，整段开头因此不是前缀。
        // 只认标记类前缀（`<` 开头）——普通警告文案在正文里被引用很常见，放开会大面积误伤。
        // 已接受的代价：正文里完整粘贴成对标记段会被判为失败（2026-10-17 用户裁决）。
        if (!前缀.startsWith('<')) continue

        const 闭合标记 = `</${前缀.slice(1)}`
        if (!整段正文.includes(闭合标记)) continue

        let 是否有开标记行 = false
        for (const 行文本 of 整段正文.split('\n')) {
            if (行文本.trim().startsWith(前缀)) {
                是否有开标记行 = true
                break
            }
        }

        if (是否有开标记行) return matchedTextNotice(整段正文)
    }

    return null
}

/** 命中时回显的说明：整段太长就截断，避免把整段正文塞进日志。 */
function matchedTextNotice(整段正文: string): string {
    if (整段正文.length <= MATCHED_TEXT_MAX) return `命中工具失败前缀：${整段正文}`

    return `命中工具失败前缀：${整段正文.slice(0, MATCHED_TEXT_MAX)}…`
}

/** 规则 H2 的纠正消息正文。 */
export const EMPTY_TURN_NUDGE_TEXT =
    '你上一次没有给用户任何回复就结束了回合。' +
    '请把当前进展与结果用正文讲清楚，不要让回合在没有答复时收尾。'

/**
 * 判定「回合收尾时是不是没给用户任何答复」（规则 H2）。
 *
 * 与 H1 不同，这里是**结构判定**，不做文本匹配：本回合最后一步既没有 tool-call 块、
 * 也没有非空正文，却有思考——就是「只输出思考、没正文」的静默收尾。
 *
 * 没有思考的空消息不算（那更像平台异常，不是本条打击对象），一律放行。
 *
 * @param snapshot - 本回合最后一步的快照；读不到时为 null。
 * @returns 命中时返回一句简短说明；未命中返回 null。
 */
export function detectEmptyTurnEnd(snapshot: TurnSnapshot | null): string | null {
    if (snapshot === null) return null
    if (snapshot.hasToolCall) return null
    if (snapshot.wholeText !== '') return null
    if (snapshot.wholeReasoning === '') return null

    return `回合在第 ${snapshot.step} 步只有思考、没有正文就收尾`
}
