/**
 * dsh-harden —— client 半边：注册进 DSH 设置页的 React 面板。
 *
 * 这个文件是「壳」，只做三件事：
 *
 *   1. 向外导出 `inject` / `apply`——平台加载 client bundle 时按 cordis 插件形态取；
 *      bundle 的 `window.__ModuleLoader__.load({ id, factory })` 外壳由构建层
 *      （`vite.shared.ts` 的 renderChunk）统一包好，源文件里**不手写**注册代码；
 *   2. 把 zh / en 两份字典注册进平台的 locale 服务，给 section descriptor 写上命名空间；
 *   3. 挂一个 `settings.section`，渲染 `HardenPanel`。
 *
 * **只注册一个 `settings.section`。** 平台在渲染 section 列表时，第二个注册会抛错并让
 * 整页空白（参考项目的 client/index.ts 有同样注释）。
 *
 * 除设置页 section 外，本壳还注册两个会话节点（各自的 conversation.chat.node 渲染器
 * + uiConversation.events.register 定义），都显示成一行浅色系统提示：
 *
 *   - 「插件介入」把看护层注入的纠正消息摆出来（parts/nudge-row.ts）；
 *   - 「子代理通知暂存」在等待期间提示结算通知被压住了（parts/progress-row.ts）。
 *
 * 两个节点定义都在本文件里，各自的 kind 与渲染器 key 一一对应。
 *
 * @module dsh-harden/client
 */

import { createElement } from 'react'
import type { ReactElement } from 'react'
import { en, LOCALE_NS, translateZh, zh } from './locales'
import type { PlatformTranslate } from './locales'
import { NudgeRow } from './parts/nudge-row'
import type { NudgeRowProps } from './parts/nudge-row'
import { ProgressRow } from './parts/progress-row'
import type { ProgressRowProps } from './parts/progress-row'
import { HardenPanel } from './parts/panel'

/** `settings.section` 的登记描述符（本壳用到的字段）。 */
interface SectionDescriptor {
    name: string
    id: string
    order: number
    /** 文案命名空间：平台据此把绑好的 `t` 注入本组件 props。 */
    locale: string
    label: () => string
    inject: () => Record<string, unknown>
}

/** `conversation.chat.node` 的登记描述符（本壳用到的字段）。 */
interface ChatNodeDescriptor {
    name: string
    /** 渲染器 key：与节点定义的 kind 一一对应。 */
    key: string
    /** 文案命名空间：平台据此把绑好的 t 注入渲染器 props。 */
    locale: string
}

/** `conversation.chat.node` 渲染器属性里平台保证注入的部分（node 的具体形状由各渲染器自定）。 */
interface ChatNodeRenderProps {
    node: { kind: string; data: unknown }
    t?: PlatformTranslate
}

/** 平台 locale 服务里本壳用到的部分。 */
interface LocaleService {
    register(ns: string, dicts: Record<string, Record<string, string>>): () => void
    bind(ns: string): PlatformTranslate
}

/** client 根上下文里本壳用到的部分。 */
interface ClientContext {
    /** 登记随插件生命周期回收的副作用。 */
    effect(callback: () => void | (() => void), label?: string): void
    slots: {
        inject(name: string, register: () => void): void
        /** `settings.section`：注册项带 id / order / label，平台把绑好的 t 注入组件。 */
        register(descriptor: SectionDescriptor, component: (props: { t?: PlatformTranslate }) => ReactElement): void
        /**
         * `conversation.chat.node`：按 key 挂渲染器，平台把会话节点与绑好的 t 注入组件。
         *
         * 泛型是因为每个渲染器只认自己那份 node 形状（`props.node.data` 各异）；
         * 平台传进来的其余字段照旧透传。
         */
        register<Props extends ChatNodeRenderProps>(descriptor: ChatNodeDescriptor, component: (props: Props) => ReactElement): void
    }
    locale: LocaleService
    /** 会话流服务：注册本插件自己的 Chat 节点定义。 */
    uiConversation: ConversationService
}

// ── 会话流节点：把看护层注入的消息显示成一行系统提示 ────────────────────────

/** 会话事件（本壳用到的字段；其余字段透传不动）。 */
interface SessionEvent {
    type: string
    seq: number
    time?: number
    data: {
        id?: unknown
        source?: { kind?: string; summary?: string }
        [key: string]: unknown
    }
}

/** 一次会话事件匹配。 */
interface ConversationMatch {
    event: SessionEvent
    id: string
    role: 'start' | 'update'
    location?: unknown
}

/** 会话上下文（本壳用到的字段）。 */
interface ConversationContext {
    key: string
    kind: string
    id: string
    state: unknown
    start?: ConversationMatch
}

/** 会话视图节点（平台按 kind 找到渲染器）。 */
interface ConversationViewNode {
    key: string
    kind: string
    id: string
    target: string
    anchorSeq: number
    location: unknown
    visibility: 'visible' | 'hidden'
    data: unknown
}

/** 会话事件定义（平台 uiConversation.events.register 接受的对象）。 */
interface ConversationEventDefinition {
    kind: string
    target: string
    match(event: SessionEvent): { id: string; role: 'start' } | null
    start(context: ConversationContext, match: ConversationMatch): unknown
    update(context: ConversationContext, match: ConversationMatch): unknown
    buildViewNode(context: ConversationContext): ConversationViewNode | null
}

/** 平台会话服务里本壳用到的部分。 */
interface ConversationService {
    events: {
        register(definition: ConversationEventDefinition): void
    }
}

/** 「插件介入」行的节点状态。 */
interface HardenNudgeState {
    id: string
    seq: number
    time?: number
    source: { kind: string; summary: string }
}

/** 本行在 Chat 里的节点 kind 与渲染器 key（两处必须一致）。 */
const NUDGE_ROW_KIND = 'harden-nudge-row'

/**
 * 「插件介入」行的会话节点定义。
 *
 * 匹配 host 注入的纠正消息（source.kind === 'harden-nudge'），把它投影成一行
 * visibility: 'visible' 的独立节点。**不替换平台自带的 input-message 定义**：
 * 两个定义各自匹配同一事件、生成各自的节点，平台那份被可见性判定
 * （isVisibleChatNode 不渲染 context 节点）吞掉，本行负责显示。
 */
const HARDEN_NUDGE_DEFINITION: ConversationEventDefinition = {
    kind: NUDGE_ROW_KIND,
    target: 'chat',
    match: (event) => {
        if (event.type !== 'user/message') return null
        const source = event.data.source
        if (source?.kind !== 'harden-nudge') return null
        if (typeof source.summary !== 'string') return null
        return { id: String(event.data.id), role: 'start' }
    },
    start: (_context, match) => {
        const source = match.event.data.source as { kind: string; summary: string }
        const state: HardenNudgeState = {
            id: String(match.event.data.id),
            seq: match.event.seq,
            time: match.event.time,
            source: { kind: source.kind, summary: source.summary },
        }
        return state
    },
    update: (context) => context.state,
    buildViewNode: (context) => {
        const state = context.state as HardenNudgeState | undefined
        if (state === undefined) return null
        return {
            key: context.key,
            kind: NUDGE_ROW_KIND,
            id: context.id,
            target: 'chat',
            anchorSeq: state.seq - 0.1,
            location: context.start?.location ?? { kind: 'unresolved' },
            visibility: 'visible',
            data: { seq: state.seq, time: state.time, source: state.source },
        }
    },
}

// ── 会话流节点：「子代理通知暂存」提示 ──────────────────────────────────────

/** 本行在 Chat 里的节点 kind 与渲染器 key（两处必须一致）。 */
const PROGRESS_ROW_KIND = 'harden-progress-row'

/**
 * 本行的业务标识：**固定值是有意的**。
 *
 * 平台按 `kind + id` 建会话上下文（平台 `dsh-client-ui-conversation` 的
 * `conversationContextKey` + `acceptMatch`）：同一个 id 让后续每次命中都落进同一个
 * 上下文、走 `update`，计数才能跨事件累计；换成「一条事件一个 id」，就成了一行行
 * 各报「第 1 条」的独立提示。
 */
const PROGRESS_ROW_ID = 'harden-subagent-aggregation'

/** 「子代理通知暂存」行的节点状态。 */
interface HardenProgressState {
    /** 本会话累计暂存的结算通知条数（文案里的 N）。 */
    count: number
}

/**
 * 「子代理通知暂存」行的会话节点定义。
 *
 * 匹配 host 压住兄弟子代理的结算通知时、平台自动落盘的收件簿摘除事件
 * （`agent/inbox/spliced`：摘掉 1 条、没有补进任何消息、结果是被取消）。判定只看
 * 结构化字段，不依赖任何文案。**这条事件在聊天里本来没有痕迹**（没插入任何消息），
 * 本定义把它投影成一行 visibility: 'visible' 的独立提示。
 *
 * 已知不精确：用户在界面上撤回自己排队中的消息时，平台走的是同一条摘除路径
 * （摘 1 条、结果 canceled），本行会跟着多算一条（无伤功能）。
 */
const HARDEN_PROGRESS_DEFINITION: ConversationEventDefinition = {
    kind: PROGRESS_ROW_KIND,
    target: 'chat',
    match: (event) => {
        if (event.type !== 'agent/inbox/spliced') return null
        if (event.data.outcome !== 'canceled') return null
        if (event.data.removedCount !== 1) return null
        if (Array.isArray(event.data.inserted) === false || event.data.inserted.length > 0) return null

        return { id: PROGRESS_ROW_ID, role: 'start' }
    },
    start: () => ({ count: 1 }),
    update: (context) => {
        const state = context.state as HardenProgressState
        return { count: state.count + 1 }
    },
    buildViewNode: (context) => {
        const state = context.state as HardenProgressState | undefined
        const anchorSeq = context.start?.event.seq
        if (state === undefined || anchorSeq === undefined) return null

        return {
            key: context.key,
            kind: PROGRESS_ROW_KIND,
            id: context.id,
            target: 'chat',
            // 与「插件介入」行同款：-0.1 让它排在本条事件自身之前。
            anchorSeq: anchorSeq - 0.1,
            location: context.start?.location ?? { kind: 'unresolved' },
            visibility: 'visible',
            data: { count: state.count },
        }
    },
}

/** 本插件依赖的平台服务（只列名字，平台按它决定何时调用 `apply`）。 */
export const inject = ['slots', 'locale', 'uiConversation']

/**
 * 插件入口（client 半边）。
 *
 * @param ctx - client 根上下文。
 */
export function apply(ctx: ClientContext): void {
    ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'harden: locale dictionaries')

    const t = ctx.locale.bind(LOCALE_NS)

    ctx.slots.inject('settings.section', () => {
        ctx.slots.register(
            {
                name: 'settings.section',
                id: 'harden',
                order: 22,
                locale: LOCALE_NS,
                label: () => t('shell.sectionLabel'),
                inject: () => ({}),
            },
            (props) => createElement(HardenPanel, { t: props.t ?? translateZh() }),
        )
    })

    ctx.uiConversation.events.register(HARDEN_NUDGE_DEFINITION)
    ctx.uiConversation.events.register(HARDEN_PROGRESS_DEFINITION)

    ctx.slots.inject('conversation.chat.node', () => {
        ctx.slots.register(
            {
                name: 'conversation.chat.node',
                key: NUDGE_ROW_KIND,
                locale: LOCALE_NS,
            },
            (props: NudgeRowProps) => createElement(NudgeRow, props),
        )
    })

    ctx.slots.inject('conversation.chat.node', () => {
        ctx.slots.register(
            {
                name: 'conversation.chat.node',
                key: PROGRESS_ROW_KIND,
                locale: LOCALE_NS,
            },
            (props: ProgressRowProps) => createElement(ProgressRow, props),
        )
    })
}
