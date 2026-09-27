/**
 * 规则 H1（工具调用失败被吞）与 H2（回合无正文收尾）判定逻辑的持久化测试。
 *
 * 被测对象是 `src/host/guard.ts` 导出的 `detectSilentToolFailure()`（H1）与
 * `detectEmptyTurnEnd()`（H2）：命中返回说明文本，未命中返回 null。
 *
 * H1 的判据是「读最后一步正文，整段 trim 后匹配用户配置的前缀开头」（旧版依赖平台警告文案、
 * reasoning 调用意图与逐行匹配的判据已废弃，对应用例一并删除）。
 *
 * @module dsh-harden/tests/guard
 */

import { describe, expect, it } from 'vitest'
import type { MessageBlock, SessionEventLike, SessionLike } from '../src/host/types.js'
import { detectEmptyTurnEnd, detectSilentToolFailure } from '../src/host/guard.js'

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
    return detectSilentToolFailure(session, TURN, prefixes)
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

            expect(detectSilentToolFailure(session, TURN + 1, '⚠ Could not execute tool')).toBeNull()
        })

        it('session.snapshotEvents() 抛异常时不向外抛，按未命中处理', () => {
            const session: SessionLike = {
                snapshotEvents: () => {
                    throw new Error('会话日志读取失败')
                },
            }

            expect(detectSilentToolFailure(session, TURN, '⚠ Could not execute tool')).toBeNull()
        })
    })
})

describe('detectEmptyTurnEnd', () => {
    /** 用「本回合只有这些 assistant/message 事件」的会话跑一次 H2 判定。 */
    function detectTurn(events: readonly SessionEventLike[], turn: number): string | null {
        return detectEmptyTurnEnd(makeSession(events), turn)
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

        expect(detectEmptyTurnEnd(session, TURN)).toBeNull()
    })
})
