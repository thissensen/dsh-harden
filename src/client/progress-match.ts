/**
 * 「子代理通知暂存」进度行的判据：纯逻辑，不 import react / @deepseek-ai/* / 任何有副作用的模块。
 *
 * **判据 = 邻接配对。** 本行只在两件事同时成立时命中：
 *
 *   1. 前一条事件是「结算通知纯插入」——类型是 agent/inbox/spliced、不带 removedCount（不是
 *      replace / 摘除）、inserted 是数组且含 source.kind === 'subagent-settled' 的消息；
 *   2. 本条是「取消摘除」——agent/inbox/spliced + outcome === 'canceled' + removedCount === 1
 *      + inserted 为空，且与前一条的 seq 整数相邻。
 *
 * **为什么单条判不出来。** 平台落下的 canceled + removedCount: 1 + inserted: [] 有多处来源，
 * 结构化字段完全同形：插件 inbox.remove() 摘掉结算通知、平台把用户排队消息改道（remove 后
 * steer 到 next-step）、agent 清空队列。只看这一条分不出语义——假阳性正是「用户排队消息改道」：
 * 没有子代理的会话也显示了本行（用户报告：session-8ca513a9 seq377）。
 *
 * **样本依据（2026-10-09 全量扫描：97 个会话文件）。** 新判据命中 12 处、全为真阳性——
 * session-36760d94 的 8 处（seq 83 / 85 / 179 / 181 / 215 / 219 / 271 / 275，4 批聚合）、
 * session-02f6f500 的 3 处（seq 196 / 205 / 218）、session-4b297760 的 1 处（seq 253）；修复前的
 * 单条判据 24 处命中里多出的 12 处误报全被排除——session-8ca513a9 seq377（用户排队消息改道）、
 * session-b63d4ee4 seq896（前一条是 step/start）、session-8d6fa915 seq331（前一条是用户消息的
 * 纯插入），连真阳性会话内部也有两处（36760d94 seq176 / 229，前一条同样是用户消息的纯插入）。
 *
 * **取舍：宁可漏不可误伤。** 判据倚赖的平台事实一旦变化，本行退回**不显示**（不报错、不误伤）。
 *
 * **平台依赖明账**：① agent/inbox/spliced 的 outcome / removedCount / inserted 三个字段；
 * ② 「结算通知插入与插件摘除相邻（同一同步栈）」这一事实；③ 事件 seq 整型单调递增——
 * transient 事件（如 assistant/live-chunk）的 seq 是小数（durableCursor + 1 - 1/(n+1)，
 * 见 dsh-api-session-controller/lib/client.js），必须忽略且不影响状态。
 *
 * @module dsh-harden/client-progress-match
 */

/** 收件簿变更事件的类型名（平台自落）。 */
const SPLICED_EVENT_TYPE = 'agent/inbox/spliced'

/** 结算通知的消息来源名（模块六认的那一种）。 */
const SETTLED_SOURCE_KIND = 'subagent-settled'

/**
 * 喂进判定器的会话事件（最小结构：只声明判定用到的字段）。
 *
 * `data` 带索引签名：平台的会话事件还带 id / source / target 等一堆字段，有了它可以直接
 * 把平台事件对象喂进来（否则 TS 的弱类型检查会以「没有共同属性」拒收）。
 */
export interface ProgressEvent {
    type: string
    seq: number
    data: {
        inserted?: unknown
        removedCount?: unknown
        outcome?: unknown
        [key: string]: unknown
    }
}

/** inserted 数组里的一条消息（只声明判定用到的 source.kind）。 */
interface InsertedMessageLike {
    source?: { kind?: unknown }
}

/** 一次「已暂存」判定。 */
export interface ProgressTracker {
    /** 喂入一条会话事件；本事件是否应触发「已暂存」行。 */
    feed(event: ProgressEvent): boolean
}

/** 是否是「结算通知纯插入」：平台把一条 subagent-settled 通知原样插进收件箱（插件摘除前的那条）。 */
function isSettledInsert(event: ProgressEvent): boolean {
    if (event.type !== SPLICED_EVENT_TYPE) return false
    // 带 removedCount 就是 replace / 摘除，不是纯插入。
    if (event.data.removedCount !== undefined) return false

    const inserted = event.data.inserted
    if (Array.isArray(inserted) === false || inserted.length === 0) return false

    return inserted.some((item) => (item as InsertedMessageLike | undefined)?.source?.kind === SETTLED_SOURCE_KIND)
}

/**
 * 建一个判定器。
 *
 * 状态只有「上一条事件的 seq」与「上一条是不是结算通知纯插入」两项，二者配对才算命中。
 */
export function createProgressTracker(): ProgressTracker {
    let lastSeq: number | undefined = undefined
    let lastWasSettledInsert = false

    return {
        feed(event) {
            // transient 事件的 seq 是小数，不是会话里的持久序号：不判定，也不动状态。
            if (Number.isInteger(event.seq) === false) return false

            // 没有上一条、或 seq 回退 / 相等（换会话、窗口重建、多会话交错）：丢掉旧状态，
            // 按本条形态重新起头，这一条不判定。
            if (lastSeq === undefined || event.seq <= lastSeq) {
                lastSeq = event.seq
                lastWasSettledInsert = isSettledInsert(event)

                return false
            }

            const followsSettledInsert = lastWasSettledInsert && lastSeq === event.seq - 1
            const hit =
                followsSettledInsert &&
                event.type === SPLICED_EVENT_TYPE &&
                event.data.outcome === 'canceled' &&
                event.data.removedCount === 1 &&
                Array.isArray(event.data.inserted) &&
                event.data.inserted.length === 0

            lastSeq = event.seq
            lastWasSettledInsert = isSettledInsert(event)

            return hit
        },
    }
}
