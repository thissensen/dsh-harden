/**
 * 规则 H1（工具调用失败被吞）与 H2（回合无正文收尾）判定逻辑的持久化测试。
 *
 * 被测对象是 `src/host/guard.ts` 导出的 `detectSilentToolFailure()`（H1）与
 * `detectEmptyTurnEnd()`（H2）：入参是 `step-reader.ts` 的回合快照（一回合一读），
 * 命中返回说明文本，未命中返回 null。快照读取与前缀切分各自有用例，接线与旧断言一一对应。
 *
 * H1 的判据是「整段正文 trim 后匹配用户配置的前缀开头」（旧版依赖平台警告文案、
 * reasoning 调用意图与逐行匹配的判据已废弃，对应用例一并删除）。
 *
 * @module dsh-harden/tests/guard
 */

import { describe, expect, it } from 'vitest'
import type { MessageBlock, SessionEventLike, SessionLike } from '../src/host/types.js'
import {
    detectEmptyTurnEnd,
    detectSilentToolFailure,
    parseToolFailurePrefixes,
} from '../src/host/guard.js'
import { readTurnSnapshot } from '../src/host/step-reader.js'

/** 固定的回合号与最后一步步号——每条用例都在同一坐标上判定。 */
const TURN = 3
const LAST_STEP = 4

/** 构造只提供 `snapshotEvents()` 的会话桩。 */
function makeSession(events: readonly SessionEventLike[]): SessionLike {
    return { snapshotEvents: () => events }
}

/** 构造一条 `assistant/message` 事件。 */
function assistantEvent(step: number, content: readonly MessageBlock[]): SessionEventLike {
    return { type: 'assistant/message', data: { turn: TURN, step, message: { content } } }
}

/** 构造一个 reasoning 内容块。 */
function reasoning(text: string): MessageBlock {
    return { type: 'reasoning', text }
}

/** 构造一个 text 内容块。 */
function text(text: string): MessageBlock {
    return { type: 'text', text }
}

/** 一条典型的平台工具失败警告（放在 text 块里）。 */
const WARNING_LINE = '⚠ Could not execute tool(s): "run_code": required field "code" is missing'

/** 用「本回合最后一步只有这一条 assistant/message」的会话跑一次 H1 判定。 */
function detect(content: readonly MessageBlock[], prefixes: string): string | null {
    const session = makeSession([assistantEvent(LAST_STEP, content)])
    return detectSilentToolFailure(readTurnSnapshot(session, TURN), parseToolFailurePrefixes(prefixes))
}

describe('detectSilentToolFailure', () => {
    describe('命中：整段开头命中前缀', () => {
        it('整段以警告开头时命中', () => {
            const result = detect([text(WARNING_LINE)], '⚠ Could not execute tool')

            expect(result).not.toBeNull()
            expect(result).toContain('⚠ Could not execute tool')
        })

        it('整段前后有空白时，trim 后开头仍命中', () => {
            const result = detect([text(`   ${WARNING_LINE}   `)], '  ⚠ Could not execute tool  ')

            expect(result).not.toBeNull()
        })

        it('前缀组里夹杂空行与空白行时，跳过它们仍命中', () => {
            const prefixes = '\n   \n⚠ Could not execute tool\n\t\n'
            const result = detect([text(WARNING_LINE)], prefixes)

            expect(result).not.toBeNull()
        })

        it('多前缀按行分隔是 OR：命中第 2 条也算', () => {
            const prefixes = 'Error: tool failed\n⚠ Could not execute tool'
            const result = detect([text(WARNING_LINE)], prefixes)

            expect(result).not.toBeNull()
        })

        it('命中说明回显去空白后的整段开头，便于日志定位', () => {
            const result = detect([text(`  ${WARNING_LINE}  `)], '⚠ Could not execute tool')

            expect(result).toContain(WARNING_LINE)
        })
    })

    describe('放行：前缀未配置、未命中或已有工具调用', () => {
        it('正文前面有别的话、警告在中部单独一行时不命中', () => {
            const body = `状态：完成\n\n报告正文如下。\n${WARNING_LINE}\n以上。`
            expect(detect([text(body)], '⚠ Could not execute tool')).toBeNull()
        })

        it('前缀出现在整段中间（不在开头）时不命中', () => {
            const body = '前文 ⚠ Could not execute tool 后文'
            expect(detect([text(body)], '⚠ Could not execute tool')).toBeNull()
        })

        it('大小写不同时不命中', () => {
            expect(detect([text(WARNING_LINE)], '⚠ could not execute tool')).toBeNull()
        })

        it('有 tool-call 块时一律放行', () => {
            const content: MessageBlock[] = [
                text(WARNING_LINE),
                { type: 'tool-call', id: 'call_1', name: 'run_code' },
            ]

            expect(detect(content, '⚠ Could not execute tool')).toBeNull()
        })

        it('前缀为空串时不拦', () => {
            expect(detect([text(WARNING_LINE)], '')).toBeNull()
        })

        it('前缀只有空行与空白时不拦', () => {
            expect(detect([text(WARNING_LINE)], '\n   \n\t')).toBeNull()
        })

        it('本回合没有对应的 assistant/message 事件时不拦', () => {
            const session = makeSession([
                { type: 'turn/start', data: { turn: TURN } },
                assistantEvent(LAST_STEP + 1, [text(WARNING_LINE)]),
            ])
            const snapshot = readTurnSnapshot(session, TURN + 1)

            expect(detectSilentToolFailure(snapshot, parseToolFailurePrefixes('⚠ Could not execute tool'))).toBeNull()
        })

        it('session.snapshotEvents() 抛异常时不向外抛，按未命中处理', () => {
            const session: SessionLike = {
                snapshotEvents: () => {
                    throw new Error('会话日志读取失败')
                },
            }
            const snapshot = readTurnSnapshot(session, TURN)

            expect(detectSilentToolFailure(snapshot, parseToolFailurePrefixes('⚠ Could not execute tool'))).toBeNull()
        })
    })
})

describe('detectEmptyTurnEnd', () => {
    /** 用「本回合只有这些 assistant/message 事件」的会话跑一次 H2 判定。 */
    function detectTurn(events: readonly SessionEventLike[], turn: number): string | null {
        return detectEmptyTurnEnd(readTurnSnapshot(makeSession(events), turn))
    }

    it('命中：最后一步只有 reasoning，没有正文也没有工具调用', () => {
        const result = detectTurn([assistantEvent(LAST_STEP, [reasoning('让我想想这个问题')])], TURN)

        expect(result).not.toBeNull()
        expect(result).toContain(String(LAST_STEP))
    })

    it('命中：多步时只看最后一步，前面有正文不算数', () => {
        const result = detectTurn([
            assistantEvent(LAST_STEP, [text('我先说明一下计划。')]),
            assistantEvent(LAST_STEP + 1, [reasoning('计划已经想清楚了')]),
        ], TURN)

        expect(result).not.toBeNull()
    })

    it('放行：最后一步有实质正文', () => {
        const result = detectTurn([
            assistantEvent(LAST_STEP, [reasoning('想完了'), text('任务完成')]),
        ], TURN)

        expect(result).toBeNull()
    })

    it('放行：最后一步有 tool-call 块', () => {
        const content: MessageBlock[] = [
            reasoning('开始执行'),
            { type: 'tool-call', id: 'call_1', name: 'run_code' },
        ]

        expect(detectTurn([assistantEvent(LAST_STEP, content)], TURN)).toBeNull()
    })

    it('放行：最后一步既无 reasoning 也无正文的空消息', () => {
        expect(detectTurn([assistantEvent(LAST_STEP, [])], TURN)).toBeNull()
    })

    it('放行：本回合没有任何 assistant/message 事件', () => {
        const events: SessionEventLike[] = [{ type: 'turn/start', data: { turn: TURN } }]

        expect(detectTurn(events, TURN)).toBeNull()
    })

    it('放行：只有别的回合的消息，不跨回合误判', () => {
        const events = [assistantEvent(LAST_STEP, [reasoning('上一回合的思考')])]

        expect(detectTurn(events, TURN + 1)).toBeNull()
    })

    it('放行：同一步的正文块在 reasoning 之后，取该步最后一条消息', () => {
        const events = [
            assistantEvent(LAST_STEP, [reasoning('先想')]),
            assistantEvent(LAST_STEP, [reasoning('再想'), text('说清楚了')]),
        ]

        expect(detectTurn(events, TURN)).toBeNull()
    })

    it('session.snapshotEvents() 抛异常时按未命中处理', () => {
        const session: SessionLike = {
            snapshotEvents: () => {
                throw new Error('会话日志读取失败')
            },
        }

        expect(detectEmptyTurnEnd(readTurnSnapshot(session, TURN))).toBeNull()
    })
})

describe('detectSilentToolFailure 兜底：前缀以尖括号开头时按行内成对标记判定', () => {
    /** 标记的尖括号开头——写成转义，避免在文档与工具链里被当成 HTML 标签。 */
    const MARKER_HEAD = '\u003c'
    /** 第三方 API 路由下的文本形式工具调用标记（全角竖线原样）——开标记即前缀本身。 */
    const MARKER_PREFIX = `${MARKER_HEAD}｜DSML｜tool_calls`
    const MARKER_INVOKE_LINE = `${MARKER_HEAD}｜DSML｜invoke`
    const MARKER_CLOSE_INVOKE_LINE = `${MARKER_HEAD}/｜DSML｜invoke`
    const MARKER_CLOSE_CALLS_LINE = `${MARKER_HEAD}/｜DSML｜tool_calls`

    /** 真实样本段：开标记行 + invoke 行 + 空行 + 两条闭合标记行。 */
    const MARKER_BLOCK = `${MARKER_PREFIX}\n${MARKER_INVOKE_LINE}\n\n${MARKER_CLOSE_INVOKE_LINE}\n${MARKER_CLOSE_CALLS_LINE}`

    it('第三方路由真实样本：正文在前、标记段在后时命中', () => {
        const body = `已完成这次分析。\n\n${MARKER_BLOCK}`
        const result = detect([text(body)], MARKER_PREFIX)

        expect(result).not.toBeNull()
        expect(result).toContain('命中工具失败前缀')
    })

    it('已接受的代价：正文里完整粘贴成对标记段也算失败', () => {
        const body = `这段是平台告警的原始形态：\n\n${MARKER_BLOCK}\n\n以上为引用。`

        expect(detect([text(body)], MARKER_PREFIX)).not.toBeNull()
    })

    it('放行：只有开标记行、没有闭合标记', () => {
        const body = `正文在前。\n\n${MARKER_PREFIX}\n${MARKER_INVOKE_LINE}`

        expect(detect([text(body)], MARKER_PREFIX)).toBeNull()
    })

    it('放行：只有闭合标记行、没有以开标记开头的行', () => {
        const body = `正文在前。\n\n${MARKER_CLOSE_INVOKE_LINE}\n${MARKER_CLOSE_CALLS_LINE}`

        expect(detect([text(body)], MARKER_PREFIX)).toBeNull()
    })

    it('放行：前缀不以尖括号开头时兜底不触发', () => {
        const body = `别的话开头。\n${WARNING_LINE}\n\u003c/x\u003e`

        expect(detect([text(body)], '⚠ Could not execute tool')).toBeNull()
    })

    it('命中：多前缀按各自配对，半角前缀配半角标记', () => {
        const halfWidthPrefix = `${MARKER_HEAD}|DSML|tool_calls`
        const halfWidthBlock = `${halfWidthPrefix}\n${MARKER_HEAD}|DSML|invoke\n\n${MARKER_HEAD}/|DSML|invoke\n${MARKER_HEAD}/|DSML|tool_calls`
        const prefixes = `${MARKER_PREFIX}\n${halfWidthPrefix}`
        const body = `正文在前。\n\n${halfWidthBlock}`

        expect(detect([text(body)], prefixes)).not.toBeNull()
    })

    it('放行：多前缀不交叉配对', () => {
        const body = `正文在前。\n\n${MARKER_HEAD}alpha 调用\n${MARKER_HEAD}/beta>`
        const prefixes = `${MARKER_HEAD}alpha\n${MARKER_HEAD}beta`

        expect(detect([text(body)], prefixes)).toBeNull()
    })
})

describe('readTurnSnapshot', () => {
    it('取该回合里步号最大的那条消息', () => {
        const session = makeSession([
            assistantEvent(LAST_STEP, [text('早一步')]),
            assistantEvent(LAST_STEP + 2, [text('最后一步')]),
            assistantEvent(LAST_STEP + 1, [text('中间一步')]),
        ])
        const snapshot = readTurnSnapshot(session, TURN)

        expect(snapshot?.step).toBe(LAST_STEP + 2)
        expect(snapshot?.wholeText).toBe('最后一步')
    })

    it('同一步出现多条消息时后者胜', () => {
        const session = makeSession([
            assistantEvent(LAST_STEP, [reasoning('先想'), text('旧正文')]),
            assistantEvent(LAST_STEP, [text('新正文')]),
        ])
        const snapshot = readTurnSnapshot(session, TURN)

        expect(snapshot?.wholeText).toBe('新正文')
    })

    it('正文与思考各自按换行拼接后再 trim（不是先 trim 再拼）', () => {
        const session = makeSession([
            assistantEvent(LAST_STEP, [
                text('  第一段  '),
                text('第二段'),
                reasoning('  想来想去  '),
                reasoning('再想一层'),
            ]),
        ])
        const snapshot = readTurnSnapshot(session, TURN)

        expect(snapshot?.wholeText).toBe('第一段  \n第二段')
        expect(snapshot?.wholeReasoning).toBe('想来想去  \n再想一层')
    })

    it('有 tool-call 块时 hasToolCall 为 true', () => {
        const session = makeSession([
            assistantEvent(LAST_STEP, [
                text('先说明'),
                { type: 'tool-call', id: 'call_1', name: 'run_code' },
            ]),
        ])
        const snapshot = readTurnSnapshot(session, TURN)

        expect(snapshot?.hasToolCall).toBe(true)
    })

    it('该回合没有 assistant/message 时返回 null', () => {
        const session = makeSession([
            { type: 'turn/start', data: { turn: TURN } },
            assistantEvent(LAST_STEP, [text('这是本回合的消息')]),
        ])

        expect(readTurnSnapshot(session, TURN + 1)).toBeNull()
    })

    it('session.snapshotEvents() 抛异常时返回 null', () => {
        const session: SessionLike = {
            snapshotEvents: () => {
                throw new Error('会话日志读取失败')
            },
        }

        expect(readTurnSnapshot(session, TURN)).toBeNull()
    })
})

describe('parseToolFailurePrefixes', () => {
    it('空串切成空数组', () => {
        expect(parseToolFailurePrefixes('')).toEqual([])
    })

    it('只有空行与空白时切成空数组', () => {
        expect(parseToolFailurePrefixes('\n  \n\t\n')).toEqual([])
    })

    it('多行里只留非空条目并逐条 trim', () => {
        expect(parseToolFailurePrefixes('  第一前缀  \n\n\t第二前缀\n   \n')).toEqual(['第一前缀', '第二前缀'])
    })
})

describe('命中说明的截断（回显上限 120 字）', () => {
    /** 命中说明的固定开头——长度参与截断断言。 */
    const NOTICE_HEAD = '命中工具失败前缀：'
    const PREFIX = '⚠ Could not execute tool'
    const MAX = 120

    it('整段恰 120 字时完整回显、不以省略号结尾', () => {
        const body = `${PREFIX}${'x'.repeat(MAX - PREFIX.length)}`
        const result = detect([text(body)], PREFIX)

        expect(body.length).toBe(MAX)
        expect(result).toBe(`${NOTICE_HEAD}${body}`)
    })

    it('整段超过 120 字时截到 120 字再加省略号', () => {
        const body = `${PREFIX}${'x'.repeat(200)}`
        const result = detect([text(body)], PREFIX)

        expect(result).toBe(`${NOTICE_HEAD}${body.slice(0, MAX)}…`)
        expect(result?.length).toBe(NOTICE_HEAD.length + MAX + 1)
    })
})
