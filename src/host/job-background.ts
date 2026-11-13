/**
 * dsh-harden —— 工具 `job_background`。
 *
 * 把一个命令注册成后台 job（`ctx.jobs`），进程由 `ctx.shell` 承载：立刻返回
 * `{ kind: 'background', jobId }`，模型随后用 `job_output` 读输出、`job_kill` 停任务。
 * 这是 dsh-tool-pwsh 的 `run_in_background` 分支的独立拆出——把后台能力交给专门的工具，
 * 前台 pwsh 保持轻量。
 *
 * **job 必须带 owner**（2026-09-28 真机实测修正了此前的错误取舍）：`ctx.jobs.start()`
 * 的 `servesOwner()` 在 owner 为空时**只看全局层**有没有 controller；`dsh-tool-jobs`
 * 挂在 agent preset 里、不在全局层，所以不带 owner 会被
 * `no job controller serves this agent` 直接拒掉。带 `owner: exec.agent?.id`
 * 才走 `servesOwner(liveAgent)` 那条能命中 preset controller 的路——与官方
 * `dsh-tool-pwsh` 的后台分支同款。
 *
 * **timeoutMs 语义**（用户定稿）：填了 → `onExpiry: 'kill'`（到点杀）；不填 →
 * `onExpiry: 'none'`（不 arm 期限，靠 `job_kill` 手动停）。
 *
 * **启用开关交给平台的步级准入**（0.2.2）：`tools.register(definition, { when: isEnabled })` 注册一次，
 * 平台每一步对可见工具各求一次 `when`；返回 false 时该工具既不进模型可见的声明、也不能被派发。
 * 所以不再自己监听设置文档更新事件来摘除重挂——准入本来就要每步重算，
 * 插件侧再记一份只会多一处与平台判定打架的记账。
 *
 * **不设 `outputLimitBytes`**：完成通知的内联上限（`inlineOutputBytes`，默认 2048 字节）
 * 与 `job_output` 的读取本来就是两档边界，生产方自拍一个上限只会把读取也一并截断。
 *
 * **内部函数逐字对照** `dsh-tool-pwsh/src/background.ts`（0.2.2-rc.2 起从 `lib/index.js` 拆出；仅加类型注解）：
 * - `sandboxNotes` / `processOutcome` / `processSources` / `processJob`
 * - **有意不跟进** `processJob` 新增的 `failure()`：本工具是纯后台，终态由 `done` 自己给出。
 *
 * @module dsh-harden/job-background
 */

import { isAbsolute, resolve } from 'node:path'

import { TOOL_ABORTED, defineTool } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import {
    ESCALATION_TARGETS,
    approveEscalation,
    escalationHintMarker,
    sandboxDenialMarker,
    sandboxPermissionsDescription,
    validateEscalationArgs,
} from '@deepseek-ai/dsh-sandbox'

import type { Ctx, Logger } from './types.js'

/** 工具名。与 job kind 同名——平台按 `<kind>-N` 生成 id。 */
const TOOL_NAME = 'job_background'

/** label 从 command 截取的字符数（description 缺省时用）。 */
const LABEL_COMMAND_MAX = 60

/** 沙箱模式字面量联合（本文件自用；不 import 平台类型，理由见 types.ts）。 */
type SandboxModeLike = 'read-only' | 'workspace-write' | 'danger-full-access'

// ── 平台面类型（本文件自用，不 import 平台类型，理由见 types.ts）────────────

/** `ctx.shell` 里本工具用到的面。 */
interface ShellServiceLike {
    readonly sandboxMode: SandboxModeLike | undefined
    resolve(request: ShellExecRequestLike): ShellSpecLike
    execute(spec: ShellSpecLike): Promise<ShellExecutionLike>
}

/** 传给 `ctx.shell.resolve` 的请求（字段名对齐平台）。 */
interface ShellExecRequestLike {
    command: string
    workdir?: string
    timeoutMs?: number
    onExpiry?: 'kill' | 'none'
    signal?: AbortSignal
    dshEnv?: unknown
    sandboxPolicy?: unknown
}

/** `ctx.shell.resolve` 的返回值——完整 spec，`execute` 时再加 signal。 */
interface ShellSpecLike {
    readonly command: string
    readonly timeoutMs: number
    readonly onExpiry: 'kill' | 'none'
    readonly dshEnv?: unknown
    readonly sandboxPolicy?: unknown
    readonly signal?: AbortSignal
}

/** `ctx.shell.execute` 返回的进程句柄（只声明本工具用到的面）。 */
interface ShellExecutionLike {
    readonly status: string
    readonly exitCode: number | null
    readonly signal: string | null
    readonly sandbox?: SandboxInfoLike
    readonly done: Promise<void>
    readonly observed: {
        readonly stdout: StreamReaderLike
        readonly stderr: StreamReaderLike
    }
    kill(): boolean
}

interface StreamReaderLike {
    readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean }
}

interface SandboxInfoLike {
    readonly mode: SandboxModeLike
    readonly denied: boolean
    readonly runnerFailed?: boolean
}

/** `ctx.jobs` 里本工具用到的面。 */
interface JobsServiceLike {
    start(spec: JobSpecLike): string
}

interface JobSpecLike {
    kind: string
    label: string
    owner?: string
    output?: readonly JobOutputSourceLike[]
    run(): JobHooksLike
}

interface JobOutputSourceLike {
    channel: string
    read(fromByte: number): { text: string; nextOffset: number; lossy: boolean }
}

interface JobHooksLike {
    cancel(reason?: string): void
    done: Promise<JobOutcomeLike>
}

interface JobOutcomeLike {
    status: 'completed' | 'killed' | 'failed'
    detail?: string
    result?: string
}

/** `ctx.tools.register` 返回精确 disposer；`when` 是步级准入判定（false ⇒ 既不进声明也不可派发）。 */
interface ToolRuntimeLike {
    register(definition: unknown, options?: { when?: () => boolean }): () => void
}

/** `ctx.sandboxPolicy` 里本工具用到的面。 */
interface SandboxPolicyResolverLike {
    resolve(input: object): { mode: SandboxModeLike; workspaceRoot?: string } | undefined
}

/** `ctx.shellEnv` 里本工具用到的面。 */
interface ShellEnvServiceLike {
    collect(exec: unknown): unknown
}

/** `execute` 的 `exec` 参数里本工具用到的字段。 */
interface ExecLike {
    readonly agent?: { readonly id?: string; readonly session?: unknown }
    readonly signal: AbortSignal
    readonly callId: string
}

// ── 工具参数形态 ─────────────────────────────────────────────────────────

interface JobBackgroundArgs {
    command: string
    description?: string
    workdir?: string
    timeoutMs?: number
    sandbox_permissions?: string
    justification?: string
}

// ── 沙箱错误的可读终态说明 ────────────────────────────────────────────────

/**
 * 平台明写「按 code 路由、不要解析 message」；`SandboxUnavailableError` 的原文长达数百字符，
 * 原样进 job 终态只会变成模型与用户眼里的噪音，所以认识的 code 换成中文说明，其余沿用原文。
 *
 * code 按字段读、不判 `instanceof`：真出现两份 `dsh-llm` 时类身份对不上，按字段读照样能路由。
 *
 * rc.1 的 `SANDBOX_UNSUPPORTED_POLICY` 保留：桌面端内嵌运行时仍是 rc.1，那里仍会抛它；rc.2 已删该码，
 * 桌面端升到 rc.2 之后可以删掉这一条（两套产物各自独立升级，见 `.harness/05-坑册.md` 环境事实）。
 */
const 沙箱错误说明表: ReadonlyMap<string, string> = new Map([
    ['SANDBOX_UNAVAILABLE', '沙箱不可用：本机没有可用的沙箱后端，命令未执行'],
    ['SANDBOX_UNSUPPORTED_POLICY', '沙箱拒绝这条权限组合：当前部署不支持请求的策略，命令未执行'],
    ['SANDBOX_INVALID_ROOT', '沙箱根目录不可用：额外的可写目录不存在、不是目录或是符号链接，命令未执行'],
    ['SANDBOX_PREPARATION_FAILED', '沙箱准备失败：本机沙箱后端没能准备好受限进程所需的宿主状态，命令未执行'],
    ['SANDBOX_INVALID_TEMP_ROOT', '沙箱临时目录不可用：宿主临时目录落在工作区内，命令未执行'],
])

// ── 内部函数（逐字对照 dsh-tool-pwsh/src/background.ts）─────────────────

/**
 * 与 `dsh-tool-pwsh/src/background.ts` 的 `sandboxNotes` 逐字一致。
 *
 * 终态说明里值得一记的 sandbox 事实：runner 从未跑命令、或命令被策略拒绝。
 * @param sandbox - 已落定的沙箱事实（未 confinement 时为 undefined）。
 * @param escalationModes - 本组合 advertise 的升级目标。
 * @returns 要附加的标记，最早的在先。
 */
function sandboxNotes(
    sandbox: SandboxInfoLike | undefined,
    escalationModes: readonly string[],
): string[] {
    if (sandbox?.runnerFailed === true) {
        return [
            `[sandbox: the sandbox runner itself failed under ${sandbox.mode} mode — the command did not run; this is a sandbox problem, not a command failure]`,
        ]
    }
    if (sandbox?.denied === true) {
        const notes = [sandboxDenialMarker(sandbox.mode)]
        if (escalationModes.length > 0) notes.push(escalationHintMarker('command'))
        return notes
    }
    return []
}

/**
 * 与 `dsh-tool-pwsh/src/background.ts` 的 `processOutcome` 逐字一致。
 *
 * 把已落定的后台进程映射到通用 job-outcome 词汇：`killed` 保持 `killed`
 * （detail 记信号），其余一律 `completed`（detail 记退出码）。非零退出被
 * 报告而非失败，与前台渲染口径一致。sandbox 事实并入 detail——一个 job 的
 * 终态理由就是每个读者看到的唯一一行。
 * @param proc - 已落定的进程句柄。
 * @param escalationModes - 本组合 advertise 的升级目标。
 * @returns 供 `ctx.jobs` 登记的结果。
 */
function processOutcome(
    proc: ShellExecutionLike,
    escalationModes: readonly string[],
): JobOutcomeLike {
    const base: JobOutcomeLike =
        proc.status === 'killed'
            ? {
                  status: 'killed',
                  detail: proc.signal !== null ? `signal: ${proc.signal}` : 'killed before exit',
              }
            : {
                  status: 'completed',
                  detail: `exit code: ${proc.exitCode ?? 0}`,
              }
    const notes = sandboxNotes(proc.sandbox, escalationModes)
    return notes.length === 0
        ? base
        : { ...base, detail: `${base.detail}; ${notes.join(' ')}` }
}

/**
 * 与 `dsh-tool-pwsh/src/background.ts` 的 `processSources` 逐字一致。
 *
 * 把进程的非消费式流读者做成 registry pull source。它们懒绑定——进程在 starter
 * 里 spawn，admission 之后才有值；spawn 前的读返回空，pump 不动模型的消费游标。
 * spawn 被拒时的 stderr reader 会带上 provider 的 spawn-failure note。
 * @param proc - 已启动进程的观察流读取器（启动前返回 undefined）。
 * @returns 每条流一个 source，stdout 在前。
 */
function processSources(
    proc: () => ShellExecutionLike | undefined,
): JobOutputSourceLike[] {
    const source = (channel: 'stdout' | 'stderr'): JobOutputSourceLike => ({
        channel,
        read: (fromByte: number) => {
            const live = proc()
            return live === undefined
                ? { text: '', nextOffset: fromByte, lossy: false }
                : live.observed[channel].readFrom(fromByte)
        },
    })
    return [source('stdout'), source('stderr')]
}

/**
 * 结构对照 `dsh-tool-pwsh/src/background.ts` 的 `processJob`（上游多返回 `failure()`，本工具纯后台、有意不抄）。
 *
 * 在 job admission 后适配异步 shell 准备，而不暴露半个进程：`cancel` 先
 * abort controller、再 kill 进程；`done` 挂在 `shell.execute` 返回的进程句柄上，
 * 进程 settle 后投影成 job outcome。
 * @param start - 用 job 自己的取消信号启动进程。
 * @param outcome - 把已落定进程投成 job outcome。
 * @returns 同步 job hooks，其完成含准备阶段与进程落定。
 */
function processJob(
    start: (signal: AbortSignal) => Promise<ShellExecutionLike>,
    outcome: (proc: ShellExecutionLike) => JobOutcomeLike,
): JobHooksLike {
    const controller = new AbortController()
    let proc: ShellExecutionLike | undefined
    return {
        cancel: (reason?: string) => {
            if (controller.signal.aborted) return
            controller.abort(reason)
            proc?.kill()
        },
        done: (async () => {
            try {
                proc = await start(controller.signal)
                try {
                    if (controller.signal.aborted) proc.kill()
                } finally {
                    await proc.done
                }
                return outcome(proc)
            } catch (err) {
                let 终态明细 = err instanceof Error ? err.message : String(err)
                const 沙箱错误码 = (err as { code?: unknown } | null)?.code

                if (typeof 沙箱错误码 === 'string') {
                    const 沙箱错误说明 = 沙箱错误说明表.get(沙箱错误码)
                    if (沙箱错误说明 !== undefined) 终态明细 = `${沙箱错误说明}（${沙箱错误码}）`
                }

                return {
                    status: controller.signal.aborted && proc === undefined ? 'killed' : 'failed',
                    detail: 终态明细,
                }
            }
        })(),
    }
}

// ── 本工具特有辅助 ────────────────────────────────────────────────────────

/**
 * 参数校验（错误正文用中文，给模型看）。
 */
function validateArgs(args: JobBackgroundArgs): void {
    if (args.command.trim().length === 0) {
        throw new Error('command 不能为空字符串')
    }
    if (args.description !== undefined && args.description.trim().length === 0) {
        throw new Error('description 不能为空字符串')
    }
    if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
        throw new Error(`timeoutMs 必须是正数，收到 ${JSON.stringify(args.timeoutMs)}`)
    }
    validateEscalationArgs(args.sandbox_permissions, args.justification)
}

/**
 * 与 `dsh-tool-pwsh/src/index.ts` 的 `resolveWorkdir` 逻辑一致：显式 workdir 优先，
 * 相对路径以会话头 cwd 为基准；都没给就不传，交给 executor 默认。
 */
function resolveWorkdir(modelWorkdir: string | undefined, exec: ExecLike): string | undefined {
    const session = exec.agent?.session as { header?: { cwd?: string } } | undefined
    const headerCwd = session?.header?.cwd
    if (modelWorkdir === undefined) return headerCwd
    if (headerCwd !== undefined && !isAbsolute(modelWorkdir)) {
        return resolve(headerCwd, modelWorkdir)
    }
    return modelWorkdir
}

/**
 * 与 `dsh-tool-pwsh/src/index.ts` 的 `toolAborted` 一致。
 */
function toolAborted(): Error {
    const error = new HarnessError('工具调用已中止', TOOL_ABORTED) as Error & { name: string }
    error.name = 'AbortError'
    return error
}

/**
 * 解析一次沙箱升级请求。未填两个参数时返回 undefined；填了但组合不支持升级
 * 则抛错（fail-closed），成功则返回获准的目标模式。
 */
async function resolveApprovedMode(
    args: JobBackgroundArgs,
    exec: ExecLike,
    approver: Parameters<typeof approveEscalation>[1]['approver'],
    sandboxPolicy: SandboxPolicyResolverLike | undefined,
): Promise<string | undefined> {
    if (args.sandbox_permissions === undefined || args.justification === undefined) {
        return undefined
    }
    if (sandboxPolicy === undefined) {
        throw new Error('当前组合不支持沙箱升级（未挂沙箱策略服务）')
    }
    const session = exec.agent?.session
    const policy = sandboxPolicy.resolve(session === undefined ? {} : { session })
    if (policy === undefined) {
        throw new Error('当前组合不支持沙箱升级（沙箱策略解析失败）')
    }
    return await approveEscalation(
        {
            requestedMode: args.sandbox_permissions,
            justification: args.justification,
            effectiveMode: policy.mode,
            subject: 'command',
        },
        {
            approver,
            agent: exec.agent,
            callId: exec.callId,
            toolName: TOOL_NAME,
            signal: exec.signal,
        },
    )
}

// ── 工具 description ─────────────────────────────────────────────────────

const TOOL_DESCRIPTION =
    'Run a shell command as a background job and return its job id immediately. ' +
    'Short output arrives with the completion notice; use job_output for longer output or early collection, and job_kill to stop it. ' +
    'When timeoutMs is omitted the command runs with no deadline until stopped explicitly; when given the command is killed on expiry. ' +
    'Paths use the session workspace by default; a relative workdir resolves against the session cwd. ' +
    'Managed $DSH_* variables expose current harness environment facts. ' +
    'Commands may run under a file sandbox; a blocked file operation is reported in the terminal detail as a policy denial.'

// ── 挂载 ─────────────────────────────────────────────────────────────────

/**
 * 挂载 `job_background` 工具。
 *
 * 需要在组合里挂载 `shell` / `jobs` / `tools` 三个服务；任一缺失就如实降级
 * （打警告、不注册工具）。`shell` 带沙箱时一并 advertise 沙箱升级参数。
 *
 * @param ctx - cordis 上下文。
 * @param logger - 日志出口。
 * @param isEnabled - 现取现解包的启用判定，注册时作为平台的步级准入 `when`；默认恒 true。
 */
export function mountJobBackground(
    ctx: Ctx,
    logger: Logger,
    isEnabled: () => boolean = () => true,
): void {
    ctx.inject(['shell', 'jobs', 'tools'], (jobCtx: Ctx) => {
        const shell = jobCtx.get<ShellServiceLike>('shell')
        const jobs = jobCtx.get<JobsServiceLike>('jobs')
        const tools = jobCtx.get<ToolRuntimeLike>('tools')

        if (shell === undefined || jobs === undefined || tools === undefined) {
            logger.warn?.(
                '[harden] job_background 未注册：缺少 shell / jobs / tools 服务之一',
            )
            return
        }

        const defaultMode = shell.sandboxMode
        const escalationModes: string[] = defaultMode === undefined ? [] : [...ESCALATION_TARGETS]
        const sandboxPolicy =
            defaultMode === undefined
                ? undefined
                : jobCtx.get<SandboxPolicyResolverLike>('sandboxPolicy')
        const shellEnv = jobCtx.get<ShellEnvServiceLike>('shellEnv')
        const approver = jobCtx.get<Parameters<typeof approveEscalation>[1]['approver']>('approval')

        const definition = defineTool({
            name: TOOL_NAME,
            description: TOOL_DESCRIPTION,
            parameters: {
                command: {
                    type: 'string',
                    required: true,
                    description: 'The shell command to execute in the background.',
                },
                description: {
                    type: 'string',
                    description:
                        'Human-readable one-line description; used as the job label when given. Defaults to the first 60 characters of command.',
                },
                workdir: {
                    type: 'string',
                    description:
                        'Working directory for this command. Defaults to the session workspace; a relative path is resolved against it.',
                },
                timeoutMs: {
                    type: 'number',
                    description:
                        'Timeout in milliseconds. When given, the command is killed at expiry; when omitted, no deadline is armed and the job runs until stopped with job_kill.',
                },
                sandbox_permissions: {
                    type: 'string',
                    ...(escalationModes.length > 0 ? { enum: escalationModes } : {}),
                    description: sandboxPermissionsDescription('command'),
                },
                justification: {
                    type: 'string',
                    description:
                        'Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access. Use the language of the user’s current request.',
                },
            },
            output: {
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        kind: { type: 'string', required: true, const: 'background' },
                        jobId: { type: 'string', required: true },
                    },
                },
                render: (_args, value) => [
                    { type: 'text', text: `started background job ${value.jobId}` },
                ],
            },
            async execute(args, exec) {
                validateArgs(args)

                const typedExec = exec as unknown as ExecLike
                const workdir = resolveWorkdir(args.workdir, typedExec)
                const approvedMode = await resolveApprovedMode(
                    args,
                    typedExec,
                    approver,
                    sandboxPolicy,
                )

                const request: ShellExecRequestLike = {
                    command: args.command,
                    ...(workdir !== undefined ? { workdir } : {}),
                    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
                }

                if (shellEnv !== undefined) {
                    request.dshEnv = shellEnv.collect(exec)
                }

                if (sandboxPolicy !== undefined && typedExec.agent !== undefined) {
                    const resolved = sandboxPolicy.resolve({ session: typedExec.agent.session })
                    if (resolved !== undefined) {
                        request.sandboxPolicy =
                            approvedMode === undefined
                                ? resolved
                                : { ...resolved, mode: approvedMode }
                    }
                }

                const spec = shell.resolve({
                    ...request,
                    onExpiry: args.timeoutMs !== undefined ? 'kill' : 'none',
                })

                if (typedExec.signal.aborted) throw toolAborted()

                let proc: ShellExecutionLike | undefined
                const jobId = jobs.start({
                    kind: TOOL_NAME,
                    label: args.description ?? args.command.slice(0, LABEL_COMMAND_MAX),
                    owner: typedExec.agent?.id,
                    output: processSources(() => proc),
                    run: () => {
                        const hooks = processJob(
                            async (signal) => {
                                proc = await shell.execute({ ...spec, signal })
                                return proc
                            },
                            (started) => processOutcome(started, escalationModes),
                        )
                        return hooks
                    },
                })

                logger.info?.(
                    `[harden] job_background 已启动：${jobId}（${args.command.slice(0, 80)}）`,
                )

                // 字面量类型由 output.schema 的 `const: 'background'` 钉死，
                // 不加 as const 会被推断成 string，与声明对不上。
                return { kind: 'background' as const, jobId }
            },
        })

        // 开关交给平台的步级准入：关掉即不进声明、不可派发，不必自己记账与重算。
        tools.register(definition, { when: isEnabled })
        logger.info?.(
            `[harden] 工具 ${TOOL_NAME} 已注册（沙箱升级=${escalationModes.length > 0 ? '开' : '关'}）`,
        )
    })
}
