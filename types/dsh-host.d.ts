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
