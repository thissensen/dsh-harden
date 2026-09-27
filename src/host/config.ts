/**
 * 插件的配置 schema。
 *
 * 四条规则的配置：H1 的开关与失败提示前缀、H2 的开关、H3 的重试次数与失败特征。
 *
 * **字段全部标 `.volatile()`**（与 dsh-agent-studio 同纪律，2026-09-24 源码核实）：
 * 平台只把 schema 里标了 volatile 的字段投影成可编辑表单，写入时也只接受
 * volatile 子树里的路径。不标 = 面板一个字都存不进去。代价是平台把每个字段
 * 包成**引用**（`{ get() }`），插件必须现取现解包——换来的是改配置不必重启插件。
 *
 * @module dsh-harden/config
 */

import z from '@deepseek-ai/schemastery'
import type { HardenConfig } from './types.js'

export type { HardenConfig } from './types.js'

/**
 * 本插件在 profile 里那条 row 的 id（平台的 SettingsNamespace）。
 *
 * 必须与 `cordis.patch.yml` 的 row id 一致，也与 `index.ts` 导出的 `name` 一致。
 */
export const SETTINGS_NAMESPACE = 'harden'

/** 默认值：与 `03-模块规格.md` 的规则 H1 一致。 */
export const DEFAULT_TOOL_FAILURE_GUARD = true

/**
 * 默认值：规则 H1 识别的「工具失败提示前缀」。
 *
 * 默认**空串**——装完不填就等于不拦（用户裁决）。用户按自己平台警告文案的固定开头填写。
 */
export const DEFAULT_TOOL_FAILURE_PREFIXES = ''

/** 默认值：与 `03-模块规格.md` 的规则 H2 一致。 */
export const DEFAULT_EMPTY_OUTPUT_GUARD = true

/** 默认值：规则 H3 官方重试耗尽后，插件兜底重试的次数。 */
export const DEFAULT_NETWORK_RETRY_COUNT = 5

/**
 * 默认值：规则 H3 触发重试的失败特征清单。
 *
 * 混装两类 token：`code` 名（英文大写）与 HTTP 状态码（数字）。
 * 前四个与平台官方 `retryableCodes` 默认值对齐；后两个是常见的瞬时 HTTP 状态码。
 */
export const DEFAULT_NETWORK_RETRY_TOKENS = 'SERVER,RATE_LIMIT,TIMEOUT,TRANSPORT,502,429'

/** 默认值：工具 `job_background`（把命令放后台 job 执行）的开关。默认**开**。 */
export const DEFAULT_BACKGROUND_JOB_TOOL = true

/** 默认值：点「打开方式 → 资源管理器」时窗口是否可见。默认**可见**（= 插件修好的行为）。 */
export const DEFAULT_OPEN_FOLDER_VISIBLE = true

/** 平台按这个名字认配置 schema（`Config = { … }` 是平台侧的约定名）。 */
export const Config = z.object({
    toolFailureGuard: z.boolean().default(DEFAULT_TOOL_FAILURE_GUARD).volatile(),
    toolFailurePrefixes: z.string().default(DEFAULT_TOOL_FAILURE_PREFIXES).volatile(),
    emptyOutputGuard: z.boolean().default(DEFAULT_EMPTY_OUTPUT_GUARD).volatile(),
    networkRetryCount: z.number().default(DEFAULT_NETWORK_RETRY_COUNT).volatile(),
    networkRetryTokens: z.string().default(DEFAULT_NETWORK_RETRY_TOKENS).volatile(),
    backgroundJobTool: z.boolean().default(DEFAULT_BACKGROUND_JOB_TOOL).volatile(),
    openFolderVisible: z.boolean().default(DEFAULT_OPEN_FOLDER_VISIBLE).volatile(),
})

/**
 * 从 `apply(ctx, config)` 收到的原始对象里解包出当前值。
 *
 * 平台把 volatile 字段包成引用；引用被就地更新，所以每次调用都要重读——
 * 不能在 `apply` 时解包一次缓存起来。
 *
 * @param raw - `apply` 的第二个参数。
 * @returns 解包后的配置；缺字段与类型不符时回落到默认值。
 */
export function readConfig(raw: unknown): Required<HardenConfig> {
    if (raw === null || typeof raw !== 'object') return defaultConfig()

    const obj = raw as Record<string, unknown>
    return {
        toolFailureGuard: unwrapField(obj.toolFailureGuard, DEFAULT_TOOL_FAILURE_GUARD, 'boolean'),
        toolFailurePrefixes: unwrapField(obj.toolFailurePrefixes, DEFAULT_TOOL_FAILURE_PREFIXES, 'string'),
        emptyOutputGuard: unwrapField(obj.emptyOutputGuard, DEFAULT_EMPTY_OUTPUT_GUARD, 'boolean'),
        networkRetryCount: unwrapField(obj.networkRetryCount, DEFAULT_NETWORK_RETRY_COUNT, 'number'),
        networkRetryTokens: unwrapField(obj.networkRetryTokens, DEFAULT_NETWORK_RETRY_TOKENS, 'string'),
        backgroundJobTool: unwrapField(obj.backgroundJobTool, DEFAULT_BACKGROUND_JOB_TOOL, 'boolean'),
        openFolderVisible: unwrapField(obj.openFolderVisible, DEFAULT_OPEN_FOLDER_VISIBLE, 'boolean'),
    }
}

/** 全默认配置（平台还没注入 settings 时的兜底）。 */
export function defaultConfig(): Required<HardenConfig> {
    return {
        toolFailureGuard: DEFAULT_TOOL_FAILURE_GUARD,
        toolFailurePrefixes: DEFAULT_TOOL_FAILURE_PREFIXES,
        emptyOutputGuard: DEFAULT_EMPTY_OUTPUT_GUARD,
        networkRetryCount: DEFAULT_NETWORK_RETRY_COUNT,
        networkRetryTokens: DEFAULT_NETWORK_RETRY_TOKENS,
        backgroundJobTool: DEFAULT_BACKGROUND_JOB_TOOL,
        openFolderVisible: DEFAULT_OPEN_FOLDER_VISIBLE,
    }
}

/** 从可能是「引用」的值里取一个指定类型的标量；取不到或类型不符就用兜底值。 */
function unwrapField<T>(value: unknown, fallback: T, expectedType: 'boolean' | 'number' | 'string'): T {
    const resolved = readRef(value)
    return typeof resolved === expectedType ? (resolved as T) : fallback
}

/** 若值是平台包出来的 `{ get() }` 引用，取它的当前值；否则原样返回。 */
function readRef(value: unknown): unknown {
    if (value === null || typeof value !== 'object') return value
    const get = (value as { get?: unknown }).get
    if (typeof get !== 'function') return value
    return (get as () => unknown)()
}