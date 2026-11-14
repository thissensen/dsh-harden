/**
 * 压缩判定、阈值换算与压缩事务的测试。
 *
 * 被测对象是 `src/host/compaction.ts`：两个导出纯函数——`shouldCompactSession()` 决定总开关
 * 与压缩范围下主代理 / 子代理各压不压，`换算阈值Token数()` 把阈值换算成本次判定用的 token 数
 * （比例要乘窗口，绝对写法要被窗口的 90% 夹住）；以及经 `mountContextCompaction()` 挂上的
 * `agent/pre-step` 整条链：区间选择、摘要调用与**压缩事务的四事件契约**（成功写全四类事件；
 * `start` 拿不到 seq 与中途抛错这两条出口都补写带 `error` 的 `compaction/end` 释放锁）。
 * 阈值文本的解析（`1M` / `200K` / `100000` / `60%`）随实现住在 `tests/shared-format.test.ts`
 * ——口径只有一份，测试也只有一份。
 *
 * 事务链的三个私有函数（`runCompactionTransaction` / `selectCompactableRange` /
 * `summarizeWithLlm`）不为测试导出、也不改造：假 ctx 跑掉 `ctx.inject` 的回调就能把整条链接上。
 * 链上经过的都是**平台真实实现**（`toolPairingBalancedBefore`、`BlockAssembler`、
 * `createUserMessage`、`compactCheckpointSource`），桩只承担平台服务边界（llm / tokenMeter /
 * agents / 会话写入通道），没有一条断言是断言桩自己。
 *
 * 纯函数的断言直接验真实返回值，不 mock；日志桩只用来数「窗口未知」的警告条数。
 *
 * @module dsh-harden/tests/compaction
 */

import { describe, expect, it } from 'vitest'
import { mountContextCompaction, shouldCompactSession, 换算阈值Token数 } from '../src/host/compaction.js'
import type {
    AgentRegistryService,
    CompactionScope,
    Ctx,
    HardenConfig,
    LlmService,
    Logger,
    SessionLike,
    TokenMeterService,
} from '../src/host/types.js'

/**
 * 造一份判压缩用的配置。
 *
 * 判定本身只读总开关与范围，其余字段按 `Required<HardenConfig>` **逐字段补齐**——`tests/` 不在
 * 任何 tsconfig 的 include 里，桩缺字段没有任何门槛能发现（`.harness/05-坑册.md` 坑 42）。
 */
function 造配置(contextCompaction: boolean, compactionScope: CompactionScope): Required<HardenConfig> {
    return {
        toolFailureGuard: true,
        toolFailurePrefixes: '',
        emptyOutputGuard: true,
        networkRetryCount: 5,
        networkRetryTokens: '',
        backgroundJobTool: true,
        contextCompaction,
        compactionScope,
        compactionThreshold: '200K',
        compactionInstruction: '',
        subagentAggregation: false,
        ptcBreakLimit: false,
        authCookieSweep: true,
    }
}

/** 造一个判定用的会话：判定只读会话头，其余字段按必填形状补齐（本用例不触达）。 */
function 造会话(会话头?: { readonly origin?: string }): SessionLike {
    return {
        snapshotEvents: () => [],
        append: () => undefined,
        ...(会话头 === undefined ? {} : { header: 会话头 }),
    }
}

/** `agent/pre-step` 监听器的最小形状。 */
type 监听器 = (...args: unknown[]) => unknown

/** 会话桩收下的一条 append 记录。 */
interface 追加记录 {
    readonly type: string
    readonly data: unknown
    readonly opts?: unknown
}

/** 事务用会话桩：6 个表面节点、全是 `user/message`（`toolPairingBalancedBefore` 对每个切点都回 true）。 */
interface 事务会话 {
    readonly 会话: SessionLike
    readonly 追加记录组: 追加记录[]
}

/**
 * 造一个事务用的会话桩。
 *
 * `eventAt` 回的 `seq` 必须与节点相等：`toolPairingBalancedBefore` 会按它判「表面已损坏」。
 * `append` 的返回值是本桩唯一替平台分配的东西——从 101 起逐条 +1，事务把它写进
 * `sourceEventSeqs`。
 *
 * @param 可读到startSeq - false 时 `compaction/start` 的 append 返回 undefined（复现坑 23 的「start 已落库却拿不到 seq」）。
 */
function 造事务会话(可读到startSeq = true): 事务会话 {
    const 表面节点组 = [1, 2, 3, 4, 5, 6]
    const 追加记录组: 追加记录[] = []
    let 下一个seq = 101

    const 会话: SessionLike = {
        snapshotEvents: () => [],
        append(type: string, data: unknown, opts?: unknown): { seq: number } | void {
            追加记录组.push({ type, data, opts })
            if (type === 'compaction/start' && 可读到startSeq === false) return undefined

            const seq = 下一个seq
            下一个seq += 1

            return { seq }
        },
        surface: { nodes: 表面节点组 },
        eventAt: (seq: number) => (表面节点组.includes(seq) ? { type: 'user/message', seq } : undefined),
        requestHeader: () => ({ config: { provider: 'xkiro', model: 'deepseek-v4' } }),
        toolHistory: () => undefined,
        id: 'session-1',
        header: {},
    }

    return { 会话, 追加记录组 }
}

/** 一次 `ctx.inject` 的记录：依赖组 + 回调（回调不自动执行，用例自己决定跑哪一条）。 */
interface 注入记录 {
    readonly 依赖组: readonly string[]
    readonly 回调: (ctx: Ctx) => void
}

/** 一次压缩接线的现场：挂上的监听器、它写下的日志行与发出去的模型请求。 */
interface 压缩现场 {
    readonly 监听器: 监听器
    readonly 日志行组: string[]
    readonly 模型请求组: unknown[]
}

/**
 * 挂一遍压缩规则，并跑掉 `['llm', 'tokenMeter', 'agents']` 那条 inject 回调。
 *
 * 会话桩由用例自己造（只有 start 是否可读、摘要估计值不同），这里只造平台服务面：6 个节点各
 * 100 精算 / 200 heuristic（精算合计 1000）、窗口 200000、当前有打开的回合。
 *
 * @param 摘要估计token数 - `estimateMessage` 的返回值；给一个大数就撞「摘要不比被遮蔽区间小」。
 */
function 挂上压缩(摘要估计token数: number): 压缩现场 {
    const 监听组 = new Map<string, 监听器>()
    const 注入记录组: 注入记录[] = []
    const 日志行组: string[] = []
    const 模型请求组: unknown[] = []
    const 日志桩: Logger = {
        info(消息: string): void {
            日志行组.push(消息)
        },
        warn(消息: string): void {
            日志行组.push(消息)
        },
    }

    const 宿主: Ctx = {
        on(event: string, listener: 监听器): void {
            监听组.set(event, listener)
        },
        inject(依赖组: readonly string[], 回调: (ctx: Ctx) => void): void {
            注入记录组.push({ 依赖组, 回调 })
        },
        effect(): void {
            // 压缩规则不注册副作用：本模块没有需要随卸载还原的状态（这里被调到就是实现改了形状）。
        },
        get(): undefined {
            return undefined
        },
    }

    mountContextCompaction(宿主, 日志桩, () => ({
        ...造配置(true, 'all'),
        compactionThreshold: '1K',
        compactionInstruction: '把前面的对话浓缩成摘要',
    }))

    const 压缩注入记录 = 注入记录组.find((项) => 项.依赖组.join(',') === 'llm,tokenMeter,agents')
    if (压缩注入记录 === undefined) throw Error('mountContextCompaction 没有注入 llm/tokenMeter/agents')

    const tokenMeter: TokenMeterService = {
        measure: () => ({
            totalTokens: 1000,
            nodes: [1, 2, 3, 4, 5, 6].map((seq) => ({ seq, tokens: 100, heuristicTokens: 200 })),
        }),
        estimateMessage: () => 摘要估计token数,
        contextPressure: () => ({ contextWindow: 200_000 }),
    }
    const llm: LlmService = {
        async *stream(options: unknown) {
            模型请求组.push(options)
            yield { type: 'text-delta', index: 0, text: '前情摘要' }
            yield { type: 'finish', reason: { kind: 'stop' } }
        },
    }
    const agents: AgentRegistryService = {
        get: () => undefined,
        list: () => [],
        turnBoundaryOf: () => ({ openTurnStartSeq: 5, lastTurn: 3 }),
    }

    压缩注入记录.回调({ ...宿主, tokenMeter, llm, agents })

    const 步前监听器 = 监听组.get('agent/pre-step')
    if (步前监听器 === undefined) throw Error('mountContextCompaction 没有挂 agent/pre-step')

    return { 监听器: 步前监听器, 日志行组, 模型请求组 }
}

/** 走一步：pre-step 是 waterfall，先 await next() 再自量；返回下游的决定。 */
async function 走一步(现场: 压缩现场, 会话: SessionLike): Promise<unknown> {
    return await 现场.监听器(
        { agent: { session: 会话, steer: (): void => {} }, signal: undefined },
        async () => '下游决定',
    )
}

describe('shouldCompactSession（总开关与压缩范围）', () => {
    it('总开关关：任何范围下主代理与子代理都不压', () => {
        for (const 范围 of ['all', 'main', 'subagent'] as const) {
            const 配置 = 造配置(false, 范围)

            expect(shouldCompactSession(配置, 造会话())).toBe(false)
            expect(shouldCompactSession(配置, 造会话({ origin: 'subagent' }))).toBe(false)
        }
    })

    it('范围 all：主代理与子代理都压', () => {
        const 配置 = 造配置(true, 'all')

        expect(shouldCompactSession(配置, 造会话())).toBe(true)
        expect(shouldCompactSession(配置, 造会话({ origin: 'subagent' }))).toBe(true)
    })

    it('范围 main：只压主代理，子代理保持原样', () => {
        const 配置 = 造配置(true, 'main')

        expect(shouldCompactSession(配置, 造会话())).toBe(true)
        expect(shouldCompactSession(配置, 造会话({ origin: 'subagent' }))).toBe(false)
    })

    it('范围 subagent：只压子代理，主代理保持原样', () => {
        const 配置 = 造配置(true, 'subagent')

        expect(shouldCompactSession(配置, 造会话())).toBe(false)
        expect(shouldCompactSession(配置, 造会话({ origin: 'subagent' }))).toBe(true)
    })

    it('会话头没有 origin（主代理）时按主代理算', () => {
        expect(shouldCompactSession(造配置(true, 'main'), 造会话({}))).toBe(true)
        expect(shouldCompactSession(造配置(true, 'subagent'), 造会话({}))).toBe(false)
    })
})

describe('换算阈值Token数', () => {
    /**
     * 收集 warn 的日志桩。
     *
     * 「窗口未知只警告一次」是模块级状态、全进程只响一次，所以本 describe 的用例**必须按声明
     * 顺序跑**，且共用同一个桩——最后两条正验的是「第二次不再响」。
     */
    const 警告组: string[] = []
    const 日志桩: Logger = {
        warn: (message: string): void => {
            警告组.push(message)
        },
    }

    it('绝对写法 + 窗口未知 ⇒ 原样用', () => {
        expect(换算阈值Token数({ 绝对token数: 200000 }, undefined, 日志桩)).toBe(200000)
    })

    it('绝对写法低于窗口 90% ⇒ 原样用', () => {
        expect(换算阈值Token数({ 绝对token数: 200000 }, 1000000, 日志桩)).toBe(200000)
    })

    it('绝对写法超过窗口 90% ⇒ 夹到窗口的 90%', () => {
        expect(换算阈值Token数({ 绝对token数: 1000000 }, 1000000, 日志桩)).toBe(Math.floor(1000000 * 0.9))
    })

    it('比例写法 + 窗口已知 ⇒ 窗口乘比例向下取整', () => {
        expect(换算阈值Token数({ 窗口比例: 0.6 }, 1000001, 日志桩)).toBe(Math.floor(1000001 * 0.6))
    })

    it('比例 100% ⇒ 等于窗口', () => {
        expect(换算阈值Token数({ 窗口比例: 1 }, 128000, 日志桩)).toBe(128000)
    })

    it('比例写法 + 窗口未知 ⇒ null，并警告一次', () => {
        expect(换算阈值Token数({ 窗口比例: 0.6 }, undefined, 日志桩)).toBeNull()
        expect(警告组).toHaveLength(1)
    })

    it('窗口未知再调一次仍 null，但不再警告（全进程只警告一次）', () => {
        expect(换算阈值Token数({ 窗口比例: 0.6 }, undefined, 日志桩)).toBeNull()
        expect(换算阈值Token数({ 窗口比例: 1 }, undefined, 日志桩)).toBeNull()
        expect(警告组).toHaveLength(1)
    })
})

/**
 * 期望值的推导链（免得将来看着像魔法数）：阈值 `1K` ⇒ 1000；窗口 200000 ⇒
 * `min(1000, 180000)` = 1000；保留量 `floor(1000 × 0.3)` = 300；从尾部按精算 100 累加 ⇒
 * 300 落在第 4 个节点 ⇒ `keepFromIdx` = 3；首节点是 `user/message` ⇒ `firstIdx` = 0；
 * `toolPairingBalancedBefore(session, 4)` = true ⇒ 区间 `1..3`，遮蔽 `[1, 2, 3]`；
 * heuristic 合计 200×3 = **600**（写进事件），精算合计 100×3 = **300**（只做收缩校验）。
 *
 * 调常量（`RETAIN_RATIO` / `WINDOW_CEILING_RATIO` / `SUMMARY_MAX_TOKENS`）时，断言的
 * 1 / 3 / 600 / 8192 要跟着改。
 */
describe('mountContextCompaction + 压缩事务（四事件契约与锁释放）', () => {
    it('成功路径：四类事件按契约顺序写全，compactionId 贯穿、② ③ 相邻、end 不带 error', async () => {
        const 现场 = 挂上压缩(10)
        const { 会话, 追加记录组 } = 造事务会话()

        expect(await 走一步(现场, 会话)).toBe('下游决定')

        // ② 与 ③ 之间不许插任何东西：这条顺序断言同时钉住「相邻」，user/message 只出现一次。
        expect(追加记录组.map((记录) => 记录.type)).toEqual(['compaction/start', 'compaction/summary', 'user/message', 'compaction/end'])

        const [启动记录, 摘要记录, 替换记录, 结束记录] = 追加记录组
        const { compactionId } = 启动记录.data as { compactionId: string }
        expect(typeof compactionId).toBe('string')
        expect(启动记录.data).toEqual({ compactionId, turn: 3 })

        expect(摘要记录.data).toEqual({
            compactionId,
            summary: [{ type: 'text', text: '前情摘要' }],
            rawOutput: [{ type: 'text', text: '前情摘要' }],
            llmStreamCall: true,
            shadowedRange: { start: 1, end: 3 },
            shadowedSeqs: [1, 2, 3],
            // 写进事件的是 heuristic（200×3），不是精算（100×3）——坑 24 的口径，混了就错。
            shadowedTokenCount: 600,
            provider: 'xkiro',
            model: 'deepseek-v4',
            maxTokens: 8192,
        })

        const 替换消息 = 替换记录.data as {
            readonly role: string
            readonly content: readonly { readonly type: string; readonly text?: string }[]
            readonly source: unknown
        }
        expect(替换消息.role).toBe('user')
        // source 由平台 compactCheckpointSource 造：与本次事务同一个 compactionId。
        expect(替换消息.source).toEqual({ kind: 'compact-checkpoint', compactionId })
        expect(替换消息.content[0].text).toContain('<compacted-summary>')
        expect(替换消息.content.at(-1)).toEqual({ type: 'text', text: '</compacted-summary>' })

        // 契约硬字段：替换区间 + 三个来源（start seq / summary seq / 全部被遮蔽 seq）。
        // 101 / 102 是桩唯一替平台分配的东西（起始 101、逐条 +1）。
        expect(替换记录.opts).toEqual({
            surfaceOp: { op: 'replace', startSeq: 1, endSeq: 3 },
            sourceEventSeqs: [101, 102, 1, 2, 3],
        })

        // 成功出口的 end 必须没有 error 键（toEqual 会因多出 error 而失败）。
        expect(结束记录.data).toEqual({ compactionId, turn: 3 })

        // 摘要调用确实按当前路由发给模型（真实入参形状顺带钉一下）。
        expect(现场.模型请求组[0]).toMatchObject({
            provider: 'xkiro',
            model: 'deepseek-v4',
            maxTokens: 8192,
            sessionId: 'session-1',
            purpose: 'compaction',
        })
    })

    it('start 拿不到 seq：补写一条带 error 的 compaction/end，会话不被永久锁死', async () => {
        const 现场 = 挂上压缩(10)
        const { 会话, 追加记录组 } = 造事务会话(false)

        expect(await 走一步(现场, 会话)).toBe('下游决定')

        // 没有 summary / 替换消息，但 start 已经落库（持有锁）⇒ 必须补一条 end（坑 23）。
        expect(追加记录组.map((记录) => 记录.type)).toEqual(['compaction/start', 'compaction/end'])

        const [启动记录, 结束记录] = 追加记录组
        const { compactionId } = 启动记录.data as { compactionId: string }
        expect(结束记录.data).toEqual({
            compactionId,
            turn: 3,
            error: 'compaction: start event seq unavailable',
        })
        expect(现场.日志行组).toContain('[harden] 压缩：start 事件拿不到 seq，已释放锁')
    })

    it('事务中途抛错：补写带 error 的 compaction/end 再抛给外层，替换消息一条都不写', async () => {
        // 摘要估计值大于精算遮蔽量（100×3 = 300）⇒ 撞上「framed summary is not smaller」这条真实校验。
        // 该校验在写 compaction/summary 之前（与官方同序：先估 framed 摘要更小，才落 summary 事件），
        // 所以抛错时 summary 一定没写，事件只剩 start + end。
        const 现场 = 挂上压缩(1_000_000)
        const { 会话, 追加记录组 } = 造事务会话()

        expect(await 走一步(现场, 会话)).toBe('下游决定')

        expect(追加记录组.map((记录) => 记录.type)).toEqual(['compaction/start', 'compaction/end'])

        const [启动记录, 结束记录] = 追加记录组
        const { compactionId } = 启动记录.data as { compactionId: string }
        expect(结束记录.data).toEqual({
            compactionId,
            turn: 3,
            error: 'Error: compaction: framed summary is not smaller than the shadowed range',
        })
        // 异常确实抛出了事务并到达 pre-step 的外层边界（坑 50 的锁泄漏入口），外层照常放行。
        expect(现场.日志行组).toContain('[harden] 规则「上下文自动压缩」判定异常，已放行')
    })
})
