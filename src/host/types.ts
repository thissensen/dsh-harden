/**
 * dsh-harden —— 项目内共享类型。
 *
 * 平台类型声明从 0.1.7 起随包发布，但本项目**不直接 import 它们的类型**（会把插件与
 * 平台包的类型入口绑死，link 装法下路径未必一致，与 dsh-agent-studio 同纪律）。
 * 这里只声明本项目实际用到的成员，写之前一律去
 * `<DSH 安装目录>/node_modules/@deepseek-ai/` 的源码核实。
 *
 * @module dsh-harden/host-types
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

// ── 配置领域模型（settings 命名空间 harden 的形态）───────────────────────────

/**
 * 「上下文自动压缩」的作用范围。
 *
 * - `all`：主代理与子代理都压（默认）。
 * - `main`：只压主代理，子代理保持原样。
 * - `subagent`：只压子代理，主代理保持原样。
 */
export type CompactionScope = 'all' | 'main' | 'subagent'

/**
 * 插件配置。字段全部可选——真实值由平台 settings 服务持有，
 * 插件只在 `apply` 时读一次 schema 快照，运行时按引用现取现解包。
 */
export interface HardenConfig {
    /** 规则 H1：工具调用失败被吞。默认 true。 */
    toolFailureGuard?: boolean
    /** 规则 H1：识别「工具失败提示」的行首前缀（一行一条，OR；空串 = 不拦）。 */
    toolFailurePrefixes?: string
    /** 规则 H2：回合无正文收尾。默认 true。 */
    emptyOutputGuard?: boolean
    /** 规则 H3：网络请求中断时，官方重试耗尽后的兜底重试次数。默认 5。 */
    networkRetryCount?: number
    /** 规则 H3：触发兜底重试的失败特征清单（code 名或 HTTP 状态码，逗号分隔）。 */
    networkRetryTokens?: string
    /** 工具 `job_background`（把命令放后台 job 执行）的开关。默认 true。 */
    backgroundJobTool?: boolean
    /** 规则「上下文自动压缩」的开关。默认 true。 */
    contextCompaction?: boolean
    /** 规则「上下文自动压缩」：总开关打开时，压缩作用在哪些会话上。默认 `all`。 */
    compactionScope?: CompactionScope
    /** 触发自动压缩的上下文 token 阈值（字符串，如 `200K`）。 */
    compactionThreshold?: string
    /** 交给摘要模型的压缩指令；用户可改。 */
    compactionInstruction?: string
    /** 规则「子代理通知聚合」的开关。默认 false。 */
    subagentAggregation?: boolean
}

/** settings 服务里本插件用到的部分。 */
export interface SettingsService {
    update(namespace: string, patch: object): void
}

/** cordis 上下文里本插件用到的部分。 */
export interface Ctx {
    readonly logger?: Logger
    on?(event: string, listener: (...args: unknown[]) => unknown, options?: { prepend?: boolean }): void
    inject?(deps: readonly string[], callback: (ctx: Ctx) => void): void
    get?<T = unknown>(name: string): T | undefined
    /** 登记随插件生命周期回收的副作用。 */
    effect?(callback: () => void | (() => void)): void
    readonly settings?: SettingsService
    readonly webServer?: WebServerService
    /** 平台 token 计量服务（压缩判定阈值用）。 */
    readonly tokenMeter?: TokenMeterService
    /** 平台 LLM 服务（压缩的摘要调用用）。 */
    readonly llm?: LlmService
    /** 平台 agent 注册表服务（子代理通知聚合判「还有没有别的活跃子代理」用）。 */
    readonly agents?: AgentRegistryService
}

export interface Logger {
    info?(message: string, ...args: unknown[]): void
    warn?(message: string, ...args: unknown[]): void
    error?(message: string, ...args: unknown[]): void
}

// ── 平台服务面（压缩模块用，只声明本项目读到的成员）──────────────────────

/** 一条 priced 会话表面节点（`ctx.tokenMeter.measure()` 返回的 `nodes` 元素）。 */
export interface TokenSurfaceNodeLike {
    readonly seq: number
    readonly tokens: number
    readonly heuristicTokens: number
}

/** `ctx.tokenMeter.measure()` 的返回值里本项目用到的字段。 */
export interface TokenMeasurementLike {
    readonly totalTokens: number
    readonly nodes: readonly TokenSurfaceNodeLike[]
}

/**
 * 平台 token 计量服务。
 *
 * `measure` 用 `totalTokens` 判阈值；`estimateMessage` 用于压缩后收缩校验。
 */
export interface TokenMeterService {
    measure(session: unknown, requestHeader?: unknown): TokenMeasurementLike
    estimateMessage(message: unknown): number
}

/** 平台 LLM 服务（本插件只用到流式调用）。 */
export interface LlmService {
    stream(options: unknown): AsyncIterable<unknown>
}

/** 最近一次路由请求的头（只声明本项目读到的字段）。 */
export interface RequestHeaderLike {
    readonly config?: { readonly provider?: string; readonly model?: string; readonly maxTokens?: number }
    readonly tools?: unknown
}

// ── 平台会话与消息（只声明本插件读到的形状）───────────────────────────────

/** 会话日志里的一条消息内容块。只声明本项目会读的两种。 */
export type MessageBlock =
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: 'reasoning'; readonly text: string }
    | { readonly type: 'tool-call'; readonly id: string; readonly name: string }
    | { readonly type: string }

/** 一条 assistant 消息（只声明 content）。 */
export interface AssistantMessageLike {
    readonly content?: readonly MessageBlock[]
}

/** 一条会话事件（只声明本项目读到的字段）。 */
export interface SessionEventLike {
    readonly type: string
    readonly data?: {
        readonly turn?: number
        readonly step?: number
        readonly message?: AssistantMessageLike
    }
}

/** Session 里本项目用到的面。 */
export interface SessionLike {
    snapshotEvents(): readonly SessionEventLike[]
    /**
     * 追加一条会话事件（规则 H3 写重试事件用）。
     *
     * 可选：平台的 `Session` 一定实现它，但测试桩只关心读取面、不必造写入面；
     * 缺失时 H3 照常重试，只是界面看不到那一行提示。
     */
    append?(type: string, data: unknown, opts?: unknown): { seq: number } | void
    /** 当前会话表面的节点 seq 清单（压缩判定与区间选择用）。 */
    readonly surface?: { readonly nodes: readonly number[]; readonly replaceGeneration?: number }
    /** 按 seq 取一条会话事件（压缩的摘要调用要复用它派生消息）。 */
    eventAt?(seq: number): SessionEventLike | undefined
    /** 把一条会话事件投影成模型消息（压缩的摘要调用用）。 */
    deriveEventMessage?(event: unknown): unknown
    /** 最近一次路由请求的头（压缩取 provider/model/tools 用）。 */
    requestHeader?(): RequestHeaderLike | undefined
    /** 会话折叠出的工具历史（压缩的摘要调用要原样透传）。 */
    toolHistory?(): unknown
    /** 会话当前的尾部 seq（诊断用）。 */
    readonly seq?: number
    /** 会话 id（压缩的摘要调用要原样透传）。 */
    readonly id?: string
    /**
     * 会话头。压缩判定「主代理还是子代理」读 `origin`（子代理为 `'subagent'`）；
     * 子代理通知聚合读 `parentSession`（直接父会话 id，根代理没有）。
     */
    readonly header?: {
        readonly origin?: string
        readonly delegationDepth?: number
        readonly parentSession?: string
    }
}

/** Agent 里本项目用到的面。 */
export interface AgentLike {
    readonly session: SessionLike
    /** 投递一条引导消息；回合收尾边界上用它把回合掰回再走一步。 */
    steer?(message: unknown): void
    /** agent 的选项；压缩的摘要调用用它做 provider/model 的兜底来源。 */
    readonly options?: { readonly provider?: string; readonly model?: string }
}

// ── 事件载荷（agent/turn-stopping）─────────────────────────────────────────

/**
 * `agent/turn-stopping` 的载荷。
 *
 * serial 模式：监听器在回合收尾前被依次等待，没有 `next`。要反对收尾就调
 * `agent.steer(...)`，平台会重读收件箱——有新的引导就再走一步，没有才真正关闭回合。
 *
 * 规则 H1 与 H2 都挂在这个点上。
 */
export interface TurnStoppingPayload {
    readonly agent: AgentLike
    readonly turn: number
    readonly signal?: unknown
}

// ── 事件载荷（agent/request-error）────────────────────────────────────────

/**
 * 平台归一化后的模型请求失败事实（只声明本插件读到的字段）。
 *
 * `code` 一定有（平台保证），`status` 只在 provider 返回了 HTTP 状态时才有——
 * 超时与流中断这两类常见网络故障没有 status，判定时必须允许只看 code。
 */
export interface LlmFailureLike {
    readonly message?: string
    readonly code?: string
    readonly status?: number
}

/** `agent/request-error` 的载荷。 */
export interface RequestErrorPayload {
    readonly agent: AgentLike
    readonly turn: number
    readonly step: number
    readonly provider: string
    readonly failure: LlmFailureLike
    readonly signal?: unknown
}

/**
 * `agent/request-error` 监听器能返回的动作。
 *
 * 平台只认 `{ kind: 'retry' }`（整次请求重跑）与 `undefined`（不接管，失败终止）。
 * 平台没有「断点续写」能力，故没有第三种动作可选。
 */
export type RequestErrorAction = { readonly kind: 'retry' } | undefined

// ── 规则「子代理通知聚合」用到的平台面 ──────────────────────────────────────

/** Agent 收件箱里本项目用到的面。 */
export interface InboxLike {
    /** 摘掉一条还在 pending 里的消息；已被取走时返回 false。 */
    remove(messageId: string): boolean
    /** 就地替换一条还在 pending 里的消息；已被取走时返回 false。 */
    replace(messageId: string, newMessage: unknown): boolean
}

/** 消息的生产者标记里本项目读到的字段。 */
export interface MessageSourceLike {
    /** 结算通知为 `'subagent-settled'`。 */
    readonly kind?: string
    /** 结算通知里 = 发通知的子代理会话 id。 */
    readonly senderSessionId?: string
}

/** 一条收件箱消息里本项目读到的面（结算通知与聚合消息同形）。 */
export interface InboxMessageLike {
    /** 消息身份：`inbox.remove` / `inbox.replace` 与防重入记账都按它比对。 */
    readonly id: string
    /** 模型可见内容块。 */
    readonly content: readonly MessageBlock[]
    readonly source?: MessageSourceLike
}

/** Agent 里聚合模块用到的面。 */
export interface AggregationAgentLike {
    readonly id: string
    readonly session: SessionLike
    readonly inbox: InboxLike
    /** 排队一条普通后续回合并唤醒（兜底投递用）。 */
    followup(message: unknown): void
}

/** 平台的 agent 注册表服务（`ctx.agents`）：本项目只读这两个方法。 */
export interface AgentRegistryService {
    /** 按会话 id 取活跃 agent；不在时返回 undefined。 */
    get(id: string): AggregationAgentLike | undefined
    /** 全部活跃 agent（注册顺序）。 */
    list(): readonly AggregationAgentLike[]
}

/**
 * `agent/inbox/inserted` 的载荷（emit 模式：每次收件箱插入都同步发一次，
 * 含平台投递的结算通知与插件自己的 replace / followup 投递）。
 */
export interface InboxInsertedPayload {
    readonly agent: AggregationAgentLike
    readonly message: InboxMessageLike
}

/** `agent/disposed` 的载荷（emit 模式：被移除的是 agent 自己，不是它的父）。 */
export interface AgentDisposedPayload {
    readonly agent: AggregationAgentLike
}

// ── webServer（api.ts 注册前缀路由用）─────────────────────────────────────

/**
 * 宿主 webServer 服务：插件据此注册自己的前缀路由。
 *
 * 形状照平台公开面：`kind: 'prefix'` 表示 `path` 是前缀（其下所有路径都进同一个 handler）。
 */
export interface WebServerService {
    register(opts: {
        kind: string
        path: string
        handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
    }): void
}
