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
    /** 「打开文件夹」时资源管理器窗口是否可见。默认 true。 */
    openFolderVisible?: boolean
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
}

export interface Logger {
    info?(message: string, ...args: unknown[]): void
    warn?(message: string, ...args: unknown[]): void
    error?(message: string, ...args: unknown[]): void
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
    append?(type: string, data: unknown): void
}

/** Agent 里本项目用到的面。 */
export interface AgentLike {
    readonly session: SessionLike
    /** 投递一条引导消息；回合收尾边界上用它把回合掰回再走一步。 */
    steer?(message: unknown): void
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
