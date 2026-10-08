/**
 * 规则「子代理通知聚合」——host 侧核心。
 *
 * **现象**：多个可续接（continuable）子代理并行结算时，平台每结算一个就往父代理的收件箱
 * 插一条结算通知并唤醒一次（`dsh-subagent` 的 `notifySettlement`）：父代理被吵醒 N 次、
 * 收到 N 条零散通知。
 *
 * **做法**：挂平台公开事件 `agent/inbox/inserted`（emit）。只要父代理名下还有别的活跃子代理，
 * 就把这条通知**摘出收件箱**、记进内存账本；最后一条结算通知到达时，把账本 + 本条合成**一条**
 * 聚合消息，就地替换掉这条通知——父代理只被唤醒一次，一条消息看到全部子代理的收尾。
 * 被摘掉的通知不写会话事件（本模块不调 `session.append`），不留痕，这是设计取舍。
 * 单个子代理（无兄弟且账本为空）的结算通知不压不聚合，与平台原样一致（用户定稿）。
 *
 * **三处关键防御**：
 * ① **重入**：`inbox.replace` 与 `agent.followup` 内部都会再 splice 并**同步** emit 一条
 * `agent/inbox/inserted`，聚合消息自己就会重入本监听器。故本模块发出的聚合消息 id 一律
 * **先记账、后投递**；命中记账就原样放行。
 * ② **setImmediate 兜底**：`agent/disposed` 的 emit 在 handle disposal 内部（含 await 边界），
 * 而被移除子代理自己的 `notifySettlement` 在其后的微任务里才发出。同步查 `list()` 会看到
 * 0 个活跃子，把一个马上要正常聚合的账本提前投出去；所以兜底一律排到宏任务——那时正常聚合
 * 路径已走完、账本已清，就不会误投。
 * ③ **排除 sender**：判「还有没有别的活跃子代理」时把通知的发送者排除在外——它可能已从
 * registry 移除（此刻它不再是兄弟），也可能还在（同一个 id 不该算自己的兄弟）。
 *
 * **异常边界**：本模块的异常绝不许干扰平台投递，两个监听器各自 try-catch 后放行。
 *
 * @module dsh-harden/subagent-aggregate
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'

import type {
    AgentDisposedPayload,
    AgentRegistryService,
    Ctx,
    HardenConfig,
    InboxInsertedPayload,
    Logger,
} from './types.js'

/** 聚合消息里的一个 text 块（平台只接受 text 块）。 */
interface AggregateTextBlock {
    readonly type: 'text'
    readonly text: string
}

/** 结算通知里的一个内容块（本项目只读 text 块，其余跳过）。 */
interface SettlementBlockLike {
    readonly type: string
    readonly text?: string
}

/** 账本里的一条记录：某个子代理的结算通知。 */
interface SettlementRecord {
    /** 发通知的子代理会话 id。 */
    readonly childId: string
    /** 平台给的原内容块（结束原因行 + 收尾说明 + 收尾正文）。 */
    readonly content: readonly SettlementBlockLike[]
}

/** 聚合消息的来源标记：沿用平台的 `subagent-settled`，界面才会照常渲染来源那一行。 */
interface AggregateMessageSource {
    readonly kind: 'subagent-settled'
    readonly form: 'notice'
    /** 一行摘要，写进 source.summary 供界面折叠显示。 */
    readonly summary: string
    /** 最后一条通知的发送者；平台靠它标注来源子代理。 */
    readonly senderSessionId: string
}

/** 平台 `@deepseek-ai/dsh-llm` 里本项目用到的部分。 */
interface LlmMessageFactory {
    createUserMessage(input: {
        readonly content: readonly AggregateTextBlock[]
        readonly source: AggregateMessageSource
    }): { readonly id: string }
}

/**
 * 平台自带的消息构造器。
 *
 * **为什么走顶层静态导入而不是 `createRequire`。** require 是 Node 原生 CJS 通道，
 * `vi.mock` 拦不住它——测试一触发聚合路径就 MODULE_NOT_FOUND，这条路没法验
 * （`job-background.ts` 对 `dsh-llm` 已是同款静态导入先例）。自备声明
 * （`types/dsh-host.d.ts`）把它的返回标成 `unknown`，这里按本模块的实际用法收窄；
 * 真实契约在平台源码里。
 */
const llmMessageFactory = createUserMessage as LlmMessageFactory['createUserMessage']

/** 本模块的活状态（模块内，不导出）。 */
interface AggregationState {
    /** 已压住的通知：key 是父会话 id。 */
    readonly pendingByParent: Map<string, SettlementRecord[]>
    /** 本模块自己发出的聚合消息 id——重入防御（见文件头 ①）。 */
    readonly ownMessageIds: Set<string>
}

/**
 * 挂载规则「子代理通知聚合」。
 *
 * 用 `ctx.inject(['agents'], cb)` 取 agent 注册表（判「父名下还有没有别的活跃子代理」要它）；
 * 服务缺席就如实降级（打警告、不挂监听器）。
 *
 * @param ctx - cordis 上下文。
 * @param logger - 日志出口。
 * @param current - 现取现解包的配置读取器。
 */
export function mountSubagentAggregation(
    ctx: Ctx,
    logger: Logger,
    current: () => Required<HardenConfig>,
): void {
    if (typeof ctx.inject !== 'function') {
        logger.warn?.('[harden] ctx.inject 不可用，规则「子代理通知聚合」未挂上')
        return
    }

    ctx.inject(['agents'], (svcCtx: Ctx) => {
        const agents = svcCtx.agents
        if (agents === undefined) {
            logger.warn?.('[harden] agents 服务不可用，规则「子代理通知聚合」未挂上')
            return
        }
        if (typeof svcCtx.on !== 'function') {
            logger.warn?.('[harden] ctx.on 不可用，规则「子代理通知聚合」未挂上')
            return
        }

        const state: AggregationState = { pendingByParent: new Map(), ownMessageIds: new Set() }

        svcCtx.on('agent/inbox/inserted', (payloadRaw: unknown): void => {
            try {
                const payload = payloadRaw as InboxInsertedPayload | null
                if (payload === null || typeof payload !== 'object') return

                // 只碰平台的结算通知；其余消息（用户发言、插件投递）一律原样放行。
                const source = payload.message.source
                if (source?.kind !== 'subagent-settled') return

                // 重入防御（见文件头 ①）：本模块自己发出的聚合消息会同步重入这里。
                if (state.ownMessageIds.has(payload.message.id)) return
                if (current().subagentAggregation !== true) return

                const childId = source?.senderSessionId
                if (typeof childId !== 'string') return

                const parent = payload.agent
                const record: SettlementRecord = { childId, content: payload.message.content }

                if (hasOtherLiveChild(agents, parent.id, childId)) {
                    // 父名下还有子代理没结算：先把这条通知摘出收件箱，记进账本。
                    if (parent.inbox.remove(payload.message.id) === false) {
                        // 判得到兄弟、消息却已不在 pending：异常竞态，压不住就原样放行。
                        logger.warn?.(`[harden] 子代理通知聚合：通知已不在 pending，本次未压住（父 ${parent.id}）`)
                        return
                    }

                    const pending = state.pendingByParent.get(parent.id) ?? []
                    pending.push(record)
                    state.pendingByParent.set(parent.id, pending)
                    logger.info?.(`[harden] 子代理通知聚合：压住第 ${pending.length} 条结算通知（父 ${parent.id}）`)
                    return
                }

                // 孤立通知（账本为空，且没有别的活跃子代理）不压不聚合，与平台原样一致——这是交接
                // 文档（用户定稿）§3.1 的口径；改写它没有增益（丢说明行、换消息 id、父代理看到的
                // 模型输入跟着变），属「宁可漏判，不可误伤」该放行的情形。
                const pendingRecords = state.pendingByParent.get(parent.id) ?? []
                if (pendingRecords.length === 0) return

                // 这是最后一条结算通知：账本（含本条）合成一条，就地替换掉它。
                const records = [...takeRecords(state, parent.id), record]
                const aggregate = makeAggregateMessage(records)
                // 记账必须先于投递：replace / followup 都会同步重入本监听器，此刻账本还没清，
                // 少了这条记账就会把聚合消息自己当成新通知再聚合一次（见文件头 ①）。
                state.ownMessageIds.add(aggregate.id)

                if (parent.inbox.replace(payload.message.id, aggregate) === true) {
                    logger.info?.(
                        `[harden] 子代理通知聚合：${records.length} 条结算通知已合成一条就地替换（父 ${parent.id}）`,
                    )
                    return
                }

                // replace 返回 false = 这条通知已不在 pending（异常竞态）；它的全文已在本次事件里
                // 拿到并计入聚合，改走 followup 把父代理叫起来。
                parent.followup(aggregate)
                logger.warn?.(
                    `[harden] 子代理通知聚合：replace 落空，改走 followup 兜底（父 ${parent.id}，${records.length} 条）`,
                )

            } catch (error) {
                // 本模块的异常绝不能干扰平台投递——出错就把这条消息原样放行。
                logger.error?.('[harden] 规则「子代理通知聚合」插入判定异常，已放行该消息', error)
            }
        })

        svcCtx.on('agent/disposed', (payloadRaw: unknown): void => {
            try {
                const payload = payloadRaw as AgentDisposedPayload | null
                if (payload === null || typeof payload !== 'object') return

                const removed = payload.agent
                const parentId = removed.session.header?.parentSession
                // 根代理没有父：它被移除与「某个父名下是不是全结算了」无关。
                if (typeof parentId !== 'string') return

                // 同步快速路径：账本已空（正常聚合路径早走完了）就不排宏任务。
                if (state.pendingByParent.get(parentId) === undefined) return

                // 为什么排宏任务而不是同步查、也不是微任务（见文件头 ②）。
                setImmediate(() => {
                    try {
                        const pending = state.pendingByParent.get(parentId)
                        // 正常聚合路径已经清掉这个账本：本次 disposed 与它赛跑输了，什么都不做。
                        if (pending === undefined) return

                        // 开关中途关掉：压住的那些通知就此丢弃（用户已接受的语义）。
                        if (current().subagentAggregation !== true) {
                            state.pendingByParent.delete(parentId)
                            return
                        }

                        const parent = agents.get(parentId)
                        if (parent === undefined) {
                            // 父代理已不在 registry：没人收这条聚合，清账本了事。
                            state.pendingByParent.delete(parentId)
                            return
                        }

                        // 还有活跃子代理：等下一个结算通知或 disposed 再兜底。
                        // 排除被移除者自己（双保险：它可能还留在 list() 里）。
                        if (hasOtherLiveChild(agents, parentId, removed.id)) return

                        const records = takeRecords(state, parentId)
                        const aggregate = makeAggregateMessage(records)
                        state.ownMessageIds.add(aggregate.id)
                        parent.followup(aggregate)
                        logger.info?.(
                            `[harden] 子代理通知聚合：兜底投递 ${records.length} 条结算通知（父 ${parentId}）`,
                        )

                    } catch (error) {
                        // 延迟回调已经离开监听器的栈，异常逃不回上面的 try：这里必须自成边界，
                        // 否则会变成宿主进程的未捕获异常。
                        logger.error?.('[harden] 规则「子代理通知聚合」兜底投递异常，已放弃本次投递', error)
                    }
                })

            } catch (error) {
                logger.error?.('[harden] 规则「子代理通知聚合」兜底判定异常，已放弃本次兜底', error)
            }
        })
    })
}

/**
 * 取走某个父的账本（取走即清空）。
 *
 * @param state - 活状态。
 * @param parentId - 父会话 id。
 * @returns 已压住的记录组；账本为空时是空数组。
 */
function takeRecords(state: AggregationState, parentId: string): SettlementRecord[] {
    const records = state.pendingByParent.get(parentId) ?? []
    state.pendingByParent.delete(parentId)

    return records
}

/**
 * 该父名下还有没有别的活跃子代理。
 *
 * 直接子代理的判定与 `dsh-subagent` 内部同款：会话头的 `parentSession` 指向父会话。
 *
 * @param agents - agent 注册表。
 * @param parentId - 父会话 id。
 * @param excludedChildId - 不算兄弟的那个子代理（通知的发送者 / 刚被移除者）。
 * @returns 还有别的活跃子代理返回 true。
 */
function hasOtherLiveChild(
    agents: AgentRegistryService,
    parentId: string,
    excludedChildId: string,
): boolean {
    return agents.list().some(
        (candidate) => candidate.session.header?.parentSession === parentId && candidate.id !== excludedChildId,
    )
}

/**
 * 把账本里的记录合成一条聚合消息。
 *
 * 每条的正文**逐段搬平台原文**（结束原因行整段 + 收尾正文块），不自己重组文案：
 * 平台将来改结算文案时，聚合消息跟着一起变，不会两处漂移。
 *
 * @param records - 已压住的结算记录组（含最后一条）。
 * @returns 一条可直接交给 `inbox.replace` / `agent.followup` 的 user 消息。
 */
function makeAggregateMessage(records: readonly SettlementRecord[]): { readonly id: string } {
    const content: AggregateTextBlock[] = [
        {
            type: 'text',
            text: `${records.length} background subagents have all finished their work. Combined settlement notices:`,
        },
    ]

    for (const record of records) {
        const reason = readBlockText(record.content[0])
        if (reason !== undefined) content.push({ type: 'text', text: reason })

        // 平台把收尾正文放在 index ≥ 2（[1] 是「Its closing message:」那句说明）；没有就跳过收尾段。
        for (const closing of record.content.slice(2)) {
            const text = readBlockText(closing)
            if (text !== undefined) content.push({ type: 'text', text })
        }
    }

    const lastRecord = records[records.length - 1]

    return llmMessageFactory({
        content,
        source: {
            kind: 'subagent-settled',
            form: 'notice',
            summary: `${records.length} background subagents settled`,
            senderSessionId: lastRecord.childId,
        },
    })
}

/**
 * 读一个内容块的正文。
 *
 * 只认 text 块：平台若换形状（非 text 块、或整条通知没有内容块）就整段跳过，
 * 不往聚合里塞空块。
 *
 * @param block - 记录里的一个内容块；越界时是 undefined。
 * @returns 块的正文；读不到时返回 undefined。
 */
function readBlockText(block: SettlementBlockLike | undefined): string | undefined {
    if (block === undefined) return undefined
    if (block.type !== 'text') return undefined

    return typeof block.text === 'string' ? block.text : undefined
}
