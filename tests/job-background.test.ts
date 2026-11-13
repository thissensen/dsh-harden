/**
 * 工具 `job_background`（`src/host/job-background.ts`）的接线测试。
 *
 * **为什么不导出私有函数。** `validateArgs` 与 `resolveWorkdir` 全仓各只有一处引用，为了测试
 * 把它们导出等于把内部实现变成对外承诺。这里改走真实入口：`mountJobBackground` → 假 ctx 的
 * `inject` 立刻同步回调 → 从假 `tools.register` 捕获 definition 与注册选项 → 直接
 * `await definition.execute(args, exec)`；参数校验与 workdir 解析因此都是被真实执行的。
 *
 * `defineTool` 的产物 `execute` 直接可调、入参形状就是 `(args, exec)`（已用探针核实）。
 *
 * @module dsh-harden/tests/job-background
 */

import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SandboxPreparationError, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import { mountJobBackground } from '../src/host/job-background.js'
import type { Ctx, Logger } from '../src/host/types.js'

/** 假会话头里的 cwd：用平台自己的路径解析算出来，Windows 与 Linux 上都成立。 */
const 会话工作区 = resolve('dsh-harden-tests', '会话工作区')

/** 假 agent 的 id（断言 job owner 用）。 */
const 代理ID = 'agent-1'

/** 假 `jobs.start` 返回的 job id。 */
const 任务ID = 'job_background-1'

/** `shell.resolve` 收到的请求里本测试断言用到的字段（字段名对齐平台）。 */
interface 请求记录 {
    command: string
    workdir?: string
    timeoutMs?: number
    onExpiry?: 'kill' | 'none'
}

/** `jobs.start` 收到的 spec 里本测试断言用到的字段。 */
interface 任务记录 {
    kind: string
    label: string
    owner?: string
    /** job hooks：平台 registry 会调 `run()`，用例自己调才能拿到 `done`。 */
    run(): { done: Promise<{ status: string; detail?: string }> }
}

/** `tools.register` 的第二个参数：本工具只用到步级准入判定。 */
interface 注册选项 {
    when: () => boolean
}

/** `defineTool` 产物里本测试用到的面。 */
interface 工具定义面 {
    execute(args: unknown, exec: unknown): Promise<{ kind: string; jobId: string }>
}

/** `execute` 的 `exec` 参数（形状对齐平台，只给本工具读的那几个字段）。 */
interface 执行环境 {
    agent: { id: string; session: { header: { cwd: string } } }
    signal: AbortSignal
    callId: string
}

/** 假宿主：注入立刻回调，服务按名现取，注册的 definition 与选项都记账。 */
interface 假宿主 {
    readonly 依赖记录组: (readonly string[])[]
    readonly 请求记录组: 请求记录[]
    readonly 任务记录组: 任务记录[]
    readonly 注册组: 工具定义面[]
    /** 每次注册收到的选项——开关改成平台步级准入后，判据在这里。 */
    readonly 注册选项组: 注册选项[]
}

/** 造一次工具调用的执行环境。 */
function 造执行环境(): 执行环境 {
    return {
        agent: { id: 代理ID, session: { header: { cwd: 会话工作区 } } },
        signal: new AbortController().signal,
        callId: 'call-1',
    }
}

/**
 * 挂一遍工具并返回各项记账。
 *
 * @param 是否启用 - 现取现解的开关判定（测试里可随时翻转）；注册时作为步级准入交给平台。
 * @param 启动错误 - 假 `shell.execute` 抛出的错误；不给就抛「不该被调用」的哨兵。
 */
function 造宿主(是否启用: () => boolean, 启动错误?: Error): 假宿主 {
    const 依赖记录组: (readonly string[])[] = []
    const 请求记录组: 请求记录[] = []
    const 任务记录组: 任务记录[] = []
    const 注册组: 工具定义面[] = []
    const 注册选项组: 注册选项[] = []

    // 假 shell：resolve 记账后原样回抛——工具只消费 resolve 的结果，本测试也只断言那个入参。
    const 假shell = {
        sandboxMode: undefined,
        resolve(request: 请求记录): 请求记录 {
            请求记录组.push(request)
            return { ...request }
        },
        execute: async (): Promise<never> => {
            throw 启动错误 ?? new Error('本测试只验到 resolve 为止：shell.execute 不该被调用')
        },
    }

    const 假jobs = {
        start(spec: 任务记录): string {
            任务记录组.push(spec)
            return 任务ID
        },
    }

    // 平台把第二个参数当步级准入：原样收下，由用例现取现判。
    const 假tools = {
        register(definition: 工具定义面, options: 注册选项): void {
            注册组.push(definition)
            注册选项组.push(options)
        },
    }

    const 服务表: Record<string, unknown> = { shell: 假shell, jobs: 假jobs, tools: 假tools }

    // 外层与内层两个假上下文共用同一套服务取用与注入回调。
    const 工具上下文: Ctx = {
        get<T>(name: string): T | undefined {
            return 服务表[name] as T | undefined
        },
        // 本模块注册后不再监听事件，`Ctx` 的必供成员补个空桩。
        on() {},
        inject(依赖组: readonly string[], callback: (ctx: Ctx) => void): void {
            依赖记录组.push(依赖组)
            callback(工具上下文)
        },
    }

    const 日志: Logger = { info() {}, warn() {}, error() {} }
    const 上下文: Ctx = { logger: 日志, ...工具上下文 }

    mountJobBackground(上下文, 日志, 是否启用)

    return {
        依赖记录组,
        请求记录组,
        任务记录组,
        注册组,
        注册选项组,
    }
}

describe('参数校验', () => {
    it('command 空串或全空白被拒，且不启动 job', async () => {
        const 宿主 = 造宿主(() => true)
        const 定义 = 宿主.注册组[0]

        await expect(定义.execute({ command: '' }, 造执行环境()))
            .rejects.toThrow('command 不能为空字符串')
        await expect(定义.execute({ command: '   ' }, 造执行环境()))
            .rejects.toThrow('command 不能为空字符串')

        expect(宿主.任务记录组.length).toBe(0)
    })

    it('description 空串被拒，且不启动 job', async () => {
        const 宿主 = 造宿主(() => true)

        await expect(
            宿主.注册组[0].execute({ command: 'echo hi', description: '' }, 造执行环境()),
        ).rejects.toThrow('description 不能为空字符串')

        expect(宿主.任务记录组.length).toBe(0)
    })

    it('timeoutMs 为 0 或负数被拒，且不启动 job', async () => {
        const 宿主 = 造宿主(() => true)
        const 定义 = 宿主.注册组[0]

        await expect(
            定义.execute({ command: 'echo hi', timeoutMs: 0 }, 造执行环境()),
        ).rejects.toThrow('timeoutMs 必须是正数')
        await expect(
            定义.execute({ command: 'echo hi', timeoutMs: -1 }, 造执行环境()),
        ).rejects.toThrow('timeoutMs 必须是正数')

        expect(宿主.任务记录组.length).toBe(0)
    })

    it('timeoutMs 为 NaN / Infinity 被拒（平台参数层先拦下）', async () => {
        const 宿主 = 造宿主(() => true)
        const 定义 = 宿主.注册组[0]

        await expect(
            定义.execute({ command: 'echo hi', timeoutMs: Number.NaN }, 造执行环境()),
        ).rejects.toThrow()
        await expect(
            定义.execute({ command: 'echo hi', timeoutMs: Number.POSITIVE_INFINITY }, 造执行环境()),
        ).rejects.toThrow()

        expect(宿主.任务记录组.length).toBe(0)
    })
})

describe('workdir 解析', () => {
    it('不给 workdir 时用会话头 cwd', async () => {
        const 宿主 = 造宿主(() => true)

        await 宿主.注册组[0].execute({ command: 'echo hi' }, 造执行环境())

        expect(宿主.请求记录组[0].workdir).toBe(会话工作区)
    })

    it('相对路径相对会话头 cwd 解析成绝对路径', async () => {
        const 宿主 = 造宿主(() => true)

        await 宿主.注册组[0].execute({ command: 'echo hi', workdir: '日志目录' }, 造执行环境())

        expect(宿主.请求记录组[0].workdir).toBe(resolve(会话工作区, '日志目录'))
    })

    it('绝对路径原样传下去', async () => {
        const 宿主 = 造宿主(() => true)
        const 另一种工作区 = resolve(会话工作区, '..', '另一个工作区')

        await 宿主.注册组[0].execute({ command: 'echo hi', workdir: 另一种工作区 }, 造执行环境())

        expect(宿主.请求记录组[0].workdir).toBe(另一种工作区)
    })
})

describe('timeoutMs 与 onExpiry', () => {
    it('给了 timeoutMs → kill', async () => {
        const 宿主 = 造宿主(() => true)

        await 宿主.注册组[0].execute({ command: 'echo hi', timeoutMs: 1000 }, 造执行环境())

        expect(宿主.请求记录组[0].timeoutMs).toBe(1000)
        expect(宿主.请求记录组[0].onExpiry).toBe('kill')
    })

    it('没给 timeoutMs → none，且请求里根本不带这个字段', async () => {
        const 宿主 = 造宿主(() => true)

        await 宿主.注册组[0].execute({ command: 'echo hi' }, 造执行环境())

        expect(宿主.请求记录组[0].onExpiry).toBe('none')
        expect(Object.hasOwn(宿主.请求记录组[0], 'timeoutMs')).toBe(false)
    })
})

describe('正常路径', () => {
    it('返回 background 与 jobId，job 带上 kind / owner / label', async () => {
        const 宿主 = 造宿主(() => true)

        const 结果 = await 宿主.注册组[0].execute(
            { command: 'echo hi', description: '跑个命令' },
            造执行环境(),
        )

        expect(结果).toEqual({ kind: 'background', jobId: 任务ID })
        expect(宿主.依赖记录组[0]).toEqual(['shell', 'jobs', 'tools'])
        expect(宿主.任务记录组[0].kind).toBe('job_background')
        expect(宿主.任务记录组[0].owner).toBe(代理ID)
        expect(宿主.任务记录组[0].label).toBe('跑个命令')
    })

    it('没给 description 时 label 取 command 前 60 字', async () => {
        const 宿主 = 造宿主(() => true)
        const 长命令 = 'x'.repeat(70)

        await 宿主.注册组[0].execute({ command: 长命令 }, 造执行环境())

        expect(宿主.任务记录组[0].label).toBe(长命令.slice(0, 60))
    })

    it('spec 不带 outputLimitBytes（截断交给通知内联与读取两档边界）', async () => {
        const 宿主 = 造宿主(() => true)

        await 宿主.注册组[0].execute({ command: 'echo hi' }, 造执行环境())

        expect(Object.hasOwn(宿主.任务记录组[0], 'outputLimitBytes')).toBe(false)
    })
})

describe('启动失败的终态明细', () => {
    it('沙箱不可用的 code 换成中文说明，原文不进终态', async () => {
        // 平台真实抛的就是这个类（原文长达数百字符），顺带证明按 code 的路由吃得下它的子类。
        const 宿主 = 造宿主(() => true, new SandboxUnavailableError('workspace-write'))

        await 宿主.注册组[0].execute({ command: 'echo hi' }, 造执行环境())
        const 终态 = await 宿主.任务记录组[0].run().done

        expect(终态.status).toBe('failed')
        expect(终态.detail).toBe('沙箱不可用：本机没有可用的沙箱后端，命令未执行（SANDBOX_UNAVAILABLE）')
    })

    it('沙箱准备失败的 code 换成中文终态', async () => {
        const 宿主 = 造宿主(() => true, new SandboxPreparationError('private temp dir setup failed', 'SANDBOX_PREPARATION_FAILED'))

        await 宿主.注册组[0].execute({ command: 'echo hi' }, 造执行环境())
        const 终态 = await 宿主.任务记录组[0].run().done

        expect(终态.status).toBe('failed')
        expect(终态.detail).toBe('沙箱准备失败：本机沙箱后端没能准备好受限进程所需的宿主状态，命令未执行（SANDBOX_PREPARATION_FAILED）')
    })

    it('宿主临时目录落在工作区内的 code 单列一条中文终态', async () => {
        const 宿主 = 造宿主(() => true, new SandboxPreparationError('temp root lies inside the workspace', 'SANDBOX_INVALID_TEMP_ROOT'))

        await 宿主.注册组[0].execute({ command: 'echo hi' }, 造执行环境())
        const 终态 = await 宿主.任务记录组[0].run().done

        expect(终态.status).toBe('failed')
        expect(终态.detail).toBe('沙箱临时目录不可用：宿主临时目录落在工作区内，命令未执行（SANDBOX_INVALID_TEMP_ROOT）')
    })

    it('rc.1 运行时的 SANDBOX_UNSUPPORTED_POLICY 仍按码换中文（桌面端还在 rc.1）', async () => {
        // rc.2 的沙箱包已删这条码，但桌面端内嵌运行时仍是 rc.1、仍会抛它；按字段路由，构造等价错误即可。
        const 旧码错误 = Object.assign(new Error('sandbox policy unsupported'), { code: 'SANDBOX_UNSUPPORTED_POLICY' })
        const 宿主 = 造宿主(() => true, 旧码错误)

        await 宿主.注册组[0].execute({ command: 'echo hi' }, 造执行环境())
        const 终态 = await 宿主.任务记录组[0].run().done

        expect(终态.status).toBe('failed')
        expect(终态.detail).toBe('沙箱拒绝这条权限组合：当前部署不支持请求的策略，命令未执行（SANDBOX_UNSUPPORTED_POLICY）')
    })

    it('不认识的错误沿用原文', async () => {
        const 宿主 = 造宿主(() => true, new Error('spawn ENOENT'))

        await 宿主.注册组[0].execute({ command: 'echo hi' }, 造执行环境())
        const 终态 = await 宿主.任务记录组[0].run().done

        expect(终态.status).toBe('failed')
        expect(终态.detail).toBe('spawn ENOENT')
    })
})

describe('设置开关', () => {
    it('开关关掉时注册选项的 when 判 false', () => {
        const 宿主 = 造宿主(() => false)

        expect(宿主.注册选项组[0].when()).toBe(false)
    })

    it('翻回开启后 when 判 true，且全程只注册一次', () => {
        let 启用中 = false
        const 宿主 = 造宿主(() => 启用中)

        expect(宿主.注册选项组[0].when()).toBe(false)

        启用中 = true

        expect(宿主.注册选项组[0].when()).toBe(true)
        expect(宿主.注册选项组.length).toBe(1)
    })

    it('开关关掉但直接调用 execute 仍会真的起 job', async () => {
        const 宿主 = 造宿主(() => false)

        // 准入判在平台侧（when 决定声明与派发），工具内不再自查：
        // 绕开平台直接调 definition.execute 就该照常跑，留残影说明旧的那道兜底没删净。
        const 结果 = await 宿主.注册组[0].execute({ command: 'echo hi' }, 造执行环境())

        expect(结果).toEqual({ kind: 'background', jobId: 任务ID })
        expect(宿主.任务记录组.length).toBe(1)
    })
})
