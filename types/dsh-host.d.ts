/**
 * 宿主包（`@deepseek-ai/*`）的自备类型声明。
 *
 * 为什么自备：这些包只随 DSH 安装、不在 npm registry，CI 上装不出来；
 * 而 `tsconfig.json` 的 include 里有 `types/*.d.ts`。这里按项目里的**实际用法**
 * 声明够用的形状，不追全量；形状偏宽松是刻意的：宿主对象由平台在运行时注入，
 * 精确契约在平台源码里。
 */

declare module '@deepseek-ai/schemastery' {
    /** Schemastery 的 schema 对象：修饰方法链式返回自身。 */
    export interface Schema<T = unknown> {
        required(): Schema<T>
        default(value: unknown): Schema<T>
        description(text: string): Schema<T>
        /** 数值约束（`networkRetryCount` 这类计数字段用）。 */
        min(value: number): Schema<T>
        max(value: number): Schema<T>
        step(value: number): Schema<T>
        /**
         * 标记为「UI 可编辑」字段。
         *
         * 在平台语义里这不是性能选项，而是**写入通道的准入条件**（见 `config.ts` 顶部注释）；
         * 本文件只声明形状，平台的包装（`{ get() }`）由 `readConfig()` 现取现解包。
         */
        volatile(): Schema<T>
    }

    export interface SchemasteryNamespace {
        object<T = unknown>(shape: Record<string, unknown>): Schema<T>
        string(): Schema<string>
        number(): Schema<number>
        boolean(): Schema<boolean>
        array<T = unknown>(item: unknown): Schema<T[]>
        union<T = unknown>(items: readonly unknown[]): Schema<T>
        const<T extends string>(value: T): Schema<T>
    }

    /**
     * `as z<形状>` 这种写法要求 `z` 能**带类型参数当类型用**（真实包里 `Schema` 本身
     * 就是可调用的 interface，所以 `z<T>` 成立）。这里用一个同名 class 补上这副身份
     * ——ambient module 里 `interface` 不足以让 `z` 被当成类型，`class` 才有值+类型两副身份。
     */
    export declare class z<T = unknown> extends Schema<T> {}

    const z: SchemasteryNamespace
    export default z
}

declare module '@deepseek-ai/dsh-tools' {
    /** 工具被中止时平台用的错误码（值就是字符串 'ABORTED'）。 */
    export const TOOL_ABORTED: string
    export const TOOL_ABORTED_BEFORE_DISPATCH: string

    /**
     * `defineTool` 的入参。
     *
     * 形状刻意宽松：本文件只为「CI 上没有宿主包」时兜底，让 `execute` / `render`
     * 这类回调从上下文拿到显式类型（否则 TS 报隐式 any）。真正的契约在平台源码里。
     */
    export interface DefineToolOptions {
        name: string
        description: string
        parameters: Record<string, unknown>
        output?: {
            schema?: Record<string, unknown>
            render?: (args: any, value: any) => unknown
            presentationMeta?: (args: any, value: any) => unknown
        }
        execute(args: any, exec: any): unknown
        isConcurrencySafe?(args: any): boolean
        [key: string]: unknown
    }

    export function defineTool(options: DefineToolOptions): any
}

declare module '@deepseek-ai/dsh-llm' {
    /** 平台统一的请求失败错误（`code` 携带失败分类）。 */
    export class HarnessError extends Error {
        constructor(message: string, code?: string, options?: { cause?: unknown })
        readonly code?: string
    }

    /**
     * 增量 chunk 组装器（压缩的摘要调用收集流式输出用）。
     *
     * 形状刻意宽松：只为「CI 上没有宿主包」时兜底；真实契约在平台源码里。
     */
    export class BlockAssembler {
        push(chunk: unknown): void
        blocks(): { type: string; text?: string; [key: string]: unknown }[]
        readonly finish: { kind: string }
        readonly usage: unknown
    }

    /** 构造一条带稳定身份与 source 的 user 消息（压缩的 checkpoint 用）。 */
    export function createUserMessage(input: {
        content: readonly unknown[]
        source: unknown
    }): unknown
}

declare module '@deepseek-ai/dsh-compaction' {
    /** 一次压缩事务的稳定身份（官方为 branded string，构造器不做校验）。 */
    export type CompactionId = string & { readonly __compactionIdBrand?: 'CompactionId' }
    export function CompactionId(id: string): CompactionId

    /** 压缩 checkpoint 的消息来源（替换会话历史那条 user/message 的 source）。 */
    export interface CompactionCheckpointSource {
        readonly kind: 'compact-checkpoint'
        readonly compactionId: CompactionId
        readonly sourceCommandId?: string
    }
    export function compactCheckpointSource(compactionId: CompactionId, sourceCommandId?: string): CompactionCheckpointSource

    /** 切点是否落在工具调用对中间（落在中间就不能切）。 */
    export function toolPairingBalancedBefore(session: unknown, seq: number): boolean
}

declare module '@deepseek-ai/dsh-sandbox' {
    /** 可申请提权的沙箱档位。 */
    export const ESCALATION_TARGETS: readonly string[]

    /** 审批请求通道的结构形状（工具层闭包后传下来）。 */
    export interface EscalationApprover {
        request(req: unknown): Promise<string>
    }

    /**
     * `approveEscalation` 需要的审批配料。
     *
     * `approver` **必须含 `undefined`**——它表示「没有组合审批服务」，调用方也按含
     * undefined 收；声明成必填会让取值处凭空多出一层 undefined 而对不上。
     */
    export interface EscalationApproval {
        approver: EscalationApprover | undefined
        [key: string]: unknown
    }

    export function approveEscalation(request: unknown, approval: EscalationApproval): Promise<string>
    export function escalationHintMarker(subject: string): string
    export function sandboxDenialMarker(mode: string): string
    export function sandboxPermissionsDescription(subject: string): string
    export function validateEscalationArgs(
        sandboxPermissions: string | undefined,
        justification: string | undefined,
    ): void
}
