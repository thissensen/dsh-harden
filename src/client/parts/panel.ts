/**
 * 「DSH优化」设置页面板：页头 + 卡片列表。
 *
 * **数据从哪来。** 全经 host 的 `/api/dsh-harden/config`（见 host 侧 `src/host/api.ts`）：
 * 进来读一次配置，控件一动就写回。面板不缓存拷贝、不自己拼配置；写回由 host 转交
 * 平台的 `settings` 服务，插件自己不落任何配置文件。
 *
 * **写回是乐观的、可回滚的。** 改动立刻上屏，POST 失败就退回原值并把原因摆出来
 * ——不让用户对着一个「改了但没生效」的假象。busy 期间控件禁用，防重入。
 *
 * **组件直接用平台官方 primitives**（`@deepseek-ai/dsh-client-ui-primitives`），
 * 不手写 switch/button/input：官方变了我跟着变。样式走 `--dsw-alias-*` 主题 token，不写死颜色。
 *
 * @module dsh-harden/client-panel
 */

import { createElement, useEffect, useState } from 'react'
import type { ChangeEvent, CSSProperties, ReactElement } from 'react'
import {
    Button,
    IconChevronDownOutlineRegular,
    IconChevronUpOutlineRegular,
    IconQuestionOutlineRegular,
    IconRefreshOutlineRegular,
    IconShieldOutlineRegular,
    Input,
    Menu,
    Switch,
    Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { translateHostText, translateZh } from '../locales'
import type { PlatformTranslate } from '../locales'

/** 面板属性（`t` 由壳经 props 传进来——面板拿不到 cordis ctx）。 */
export interface PanelProps {
    t?: PlatformTranslate
}

/**
 * 插件版本号。
 *
 * 由构建期从 `package.json` 注入（见 `vite.config.ts` 的 `define`）——发版只改
 * `package.json` 一处，页面自动跟上，不再有手写常量与真实版本脱节的问题。
 */
const PLUGIN_VERSION = __PLUGIN_VERSION__

/** 包名（页头那行灰字）。 */
const PACKAGE_NAME = 'dsh-harden'

/** 仓库地址（页头 GitHub 按钮跳这里）。 */
const GITHUB_URL = 'https://github.com/thissensen/dsh-harden'

/** 压缩范围（与 host 侧配置同口径）。 */
type CompactionScope = 'all' | 'main' | 'subagent'

/** host 侧配置的形状（每条看护规则一组开关/参数）。 */
interface HardenSettings {
    toolFailureGuard: boolean
    toolFailurePrefixes: string
    emptyOutputGuard: boolean
    networkRetryCount: number
    networkRetryTokens: string
    backgroundJobTool: boolean
    subagentAggregation: boolean
    contextCompaction: boolean
    compactionScope: CompactionScope
    compactionThreshold: string
    compactionInstruction: string
}

/** 兜底重试次数的合法区间（与 host 侧 api.ts 的校验保持一致）。 */
const RETRY_COUNT_MIN = 0
const RETRY_COUNT_MAX = 99

/** 面板加载状态机。 */
type LoadState =
    | { status: 'loading' }
    | { status: 'ready'; settings: HardenSettings }
    | { status: 'failed'; message: string }

/** 写回结果的提示。 */
interface Notice {
    kind: 'ok' | 'error'
    text: string
}

/** 「检查更新」的本地三态占位（接口未定，不真发网络请求）。 */
type UpdatePhase = 'idle' | 'checking' | 'latest'

/** 配置端点（读与写共用）。 */
const CONFIG_ENDPOINT = '/api/dsh-harden/config'

/** 会话修复端点：扫描并修复全部会话文件。 */
const REPAIR_ENDPOINT = '/api/dsh-harden/repair-sessions'

/** 写围栏要求的自定义头：它让请求变成非简单请求，跨站页面伪造不出来。 */
const MUTATION_HEADER = { 'x-dsh-harden': '1' }

/** 拿不到平台 `t` 时的中文兜底（模块级：每次渲染新建引用会让子组件白白重渲）。 */
const FALLBACK_T: PlatformTranslate = translateZh()

// ── 取数与写回 ──────────────────────────────────────────────────────────

/**
 * 取一份 JSON，`ok` 不为 true 就当失败抛出。
 *
 * @param url - 端点。
 * @param options - fetch 选项。
 */
async function fetchJson(url: string, options?: RequestInit): Promise<Record<string, unknown>> {
    const response = await fetch(url, options)
    const data = await response.json()

    if (data?.ok !== true) {
        throw Error(typeof data?.error === 'string' ? data.error : `HTTP ${response.status}`)
    }

    return data
}

/**
 * 打一个写请求。写围栏要求自定义头与 JSON content-type，两者都在这里给齐。
 *
 * @param url - 端点。
 * @param body - 请求体对象。
 */
async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
    return fetchJson(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...MUTATION_HEADER },
        body: JSON.stringify(body),
    })
}

/**
 * 读配置。
 *
 * `config: null` 表示 host 侧设置服务还没就绪——那和「读失败」是两回事，但都得让
 * 用户看见原因，所以这里直接抛出，由面板显示「读取失败 + 原因 + 重试」。
 *
 * @returns 配置快照。
 */
async function loadSettings(): Promise<HardenSettings> {
    const data = await fetchJson(CONFIG_ENDPOINT)
    const raw = data.config

    if (raw === null || raw === undefined) throw Error('panel.settingsNotReady')

    const fields = raw as Record<string, unknown>
    return {
        toolFailureGuard: typeof fields.toolFailureGuard === 'boolean' ? fields.toolFailureGuard : true,
        toolFailurePrefixes: typeof fields.toolFailurePrefixes === 'string' ? fields.toolFailurePrefixes : '',
        emptyOutputGuard: typeof fields.emptyOutputGuard === 'boolean' ? fields.emptyOutputGuard : true,
        networkRetryCount: typeof fields.networkRetryCount === 'number' ? fields.networkRetryCount : 3,
        networkRetryTokens: typeof fields.networkRetryTokens === 'string' ? fields.networkRetryTokens : '',
        backgroundJobTool: typeof fields.backgroundJobTool === 'boolean' ? fields.backgroundJobTool : true,
        subagentAggregation: typeof fields.subagentAggregation === 'boolean' ? fields.subagentAggregation : false,
        contextCompaction: typeof fields.contextCompaction === 'boolean' ? fields.contextCompaction : false,
        compactionScope: readCompactionScope(fields.compactionScope),
        compactionThreshold: typeof fields.compactionThreshold === 'string' ? fields.compactionThreshold : '200K',
        compactionInstruction: typeof fields.compactionInstruction === 'string' ? fields.compactionInstruction : '',
    }
}

/** 读压缩范围：只认 main / subagent，其余（含缺字段、老字段残留）一律当 all。 */
function readCompactionScope(value: unknown): CompactionScope {
    if (value === 'main' || value === 'subagent') return value

    return 'all'
}

/** 把异常转成可显示的一行。 */
function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/**
 * 把阈值文本解析成正整数：`K` 等于 1000、`M` 等于 1000000，不区分大小写，允许首尾空白。
 *
 * 口径与 host 侧一致，两边各留一份实现——client 半边够不到 host 模块。
 *
 * @param text - 用户填的阈值文本。
 * @returns 解析出的正整数；格式不对或不是正数时返回 null。
 */
function parseThresholdText(text: string): number | null {
    const trimmed = text.trim()
    const matched = /^(\d+)([KkMm]?)$/.exec(trimmed)
    if (matched === null) return null

    const base = Number.parseInt(matched[1], 10)
    if (base <= 0) return null

    const unit = matched[2].toUpperCase()
    if (unit === 'K') return base * 1000
    if (unit === 'M') return base * 1000000

    return base
}


// ── 面板 ────────────────────────────────────────────────────────────────

/**
 * 面板组件。
 *
 * @param props - 壳传进来的翻译函数（拿不到时退回中文）。
 */
export function HardenPanel(props: PanelProps): ReactElement {
    const t = props.t ?? FALLBACK_T
    const [state, setState] = useState<LoadState>({ status: 'loading' })
    const [attempt, setAttempt] = useState(0)
    const [busy, setBusy] = useState(false)
    const [notice, setNotice] = useState<Notice | null>(null)
    const [updatePhase, setUpdatePhase] = useState<UpdatePhase>('idle')

    useEffect(() => {
        let alive = true

        // 效果本身不能是 async（返回值要留给清理），所以内部起一个具名异步函数；
        // 卸载后靠 alive 标志丢弃迟到的结果。
        async function load(): Promise<void> {
            try {
                const settings = await loadSettings()
                if (alive) setState({ status: 'ready', settings })

            } catch (error) {
                if (alive) setState({ status: 'failed', message: messageOf(error) })
                return
            }
        }

        load()

        return () => {
            alive = false
        }
    }, [attempt])

    // 「检查更新」的占位：接口未定，只在本机走一遍三态，不真发请求。
    useEffect(() => {
        if (updatePhase !== 'checking') return

        const timer = window.setTimeout(() => setUpdatePhase('latest'), 600)
        return () => window.clearTimeout(timer)
    }, [updatePhase])

    /**
     * 把一份配置补丁写回 host：先上屏，再写回；写失败就退回原值并把原因摆出来。
     *
     * 写回的是整份配置——端点按完整快照校验，缺字段会被拒。
     *
     * @param patch - 要改的字段。
     */
    async function applyPatch(patch: Partial<HardenSettings>): Promise<void> {
        if (state.status !== 'ready' || busy) return

        const previous = state.settings
        const optimistic: HardenSettings = { ...previous, ...patch }

        setBusy(true)
        setNotice(null)
        setState({ status: 'ready', settings: optimistic })

        try {
            await postJson(CONFIG_ENDPOINT, optimistic)
            setNotice({ kind: 'ok', text: t('common.saved') })

        } catch (error) {
            setState({ status: 'ready', settings: previous })
            setNotice({
                kind: 'error',
                text: `${t('common.saveFailed')}：${translateHostText(t, messageOf(error))}`,
            })

        } finally {
            setBusy(false)
        }
    }

    /** 读取失败后的重试：回到加载态，把加载效果重新跑一遍。 */
    function retry(): void {
        setState({ status: 'loading' })
        setNotice(null)
        setAttempt(attempt + 1)
    }

    return createElement(
        'div',
        { style: PAGE },
        renderHeader(t, updatePhase, () => setUpdatePhase('checking')),
        renderBody(state, t, busy, applyPatch, retry),
        notice === null
            ? null
            : createElement('div', { style: notice.kind === 'ok' ? NOTICE_OK : NOTICE_ERROR }, notice.text),
    )
}

/**
 * 页头：左起图标 + 中文名 + 包名 + 版本号，最右是「检查更新」与 GitHub。
 *
 * @param t - 翻译函数。
 * @param phase - 「检查更新」的当前状态。
 * @param onCheck - 点击「检查更新」。
 */
function renderHeader(t: PlatformTranslate, phase: UpdatePhase, onCheck: () => void): ReactElement {
    return createElement(
        'div',
        { style: HEADER },
        createElement('span', { style: HEADER_ICON }, createElement(IconShieldOutlineRegular, { size: 18 })),
        createElement('span', { style: HEADER_NAME }, t('header.name')),
        createElement('span', { style: HEADER_META }, PACKAGE_NAME),
        createElement('span', { style: HEADER_META }, `v${PLUGIN_VERSION}`),
        createElement('span', { style: SPACER }),
        createElement(
            Button,
            {
                variant: 'ghost',
                size: 'sm',
                icon: createElement(IconRefreshOutlineRegular, { size: 14 }),
                disabled: phase === 'checking',
                onClick: onCheck,
            },
            checkLabel(t, phase),
        ),
        createElement(
            Button,
            { variant: 'ghost', size: 'sm', onClick: openGithub },
            t('header.github'),
        ),
    )
}

/** 点页头的 GitHub 按钮：在新标签页打开仓库首页（平台对 `_blank` 的处理与本仓一致）。 */
function openGithub(): void {
    window.open(GITHUB_URL, '_blank', 'noopener,noreferrer')
}

/**
 * 「检查更新」按钮的文案。
 *
 * 三态里走不到「有更新」——接口未定，这里只做本地占位。
 *
 * @param t - 翻译函数。
 * @param phase - 当前状态。
 */
function checkLabel(t: PlatformTranslate, phase: UpdatePhase): string {
    if (phase === 'checking') return t('header.checking')
    if (phase === 'latest') return t('header.upToDate')

    return t('header.checkUpdate')
}

/**
 * 主体：加载中 / 读取失败 / 卡片列表。
 *
 * @param state - 加载状态。
 * @param t - 翻译函数。
 * @param busy - 是否有写回在飞。
 * @param onPatch - 配置补丁写回。
 * @param onRetry - 读取失败后的重试。
 */
function renderBody(
    state: LoadState,
    t: PlatformTranslate,
    busy: boolean,
    onPatch: (patch: Partial<HardenSettings>) => Promise<void>,
    onRetry: () => void,
): ReactElement {
    if (state.status === 'loading') {
        return createElement('div', { style: HINT }, t('common.loading'))
    }

    if (state.status === 'failed') {
        // 失败原因可能是 host 的暗号，也可能是真正的网络错误原文——共享函数两边都认。
        const shownMessage = translateHostText(t, state.message)

        return createElement(
            'div',
            { style: FAIL_CARD },
            createElement('div', { style: FAIL_TITLE }, t('common.failed')),
            createElement('div', { style: FAIL_MESSAGE }, shownMessage),
            createElement(Button, { variant: 'outline', size: 'sm', onClick: onRetry }, t('common.retry')),
        )
    }

    return createElement(
        'div',
        { style: CARD_LIST },
        createElement(ToolFailureCard, { settings: state.settings, t, busy, onPatch }),
        renderSwitchCard({
            title: t('rule.emptyOutputGuard.title'),
            description: t('rule.emptyOutputGuard.desc'),
            help: t('rule.emptyOutputGuard.help'),
            checked: state.settings.emptyOutputGuard,
            disabled: busy,
            onToggle: async (next) => {
                await onPatch({ emptyOutputGuard: next })
            },
        }),
        createElement(NetworkRetryCard, { settings: state.settings, t, busy, onPatch }),
        createElement(CompactionCard, { settings: state.settings, t, busy, onPatch }),
        renderSwitchCard({
            title: t('rule.backgroundJobTool.title'),
            description: t('rule.backgroundJobTool.desc'),
            help: t('rule.backgroundJobTool.help'),
            checked: state.settings.backgroundJobTool,
            disabled: busy,
            onToggle: async (next) => {
                await onPatch({ backgroundJobTool: next })
            },
        }),
        renderSwitchCard({
            title: t('rule.subagentAggregation.title'),
            description: t('rule.subagentAggregation.desc'),
            help: t('rule.subagentAggregation.help'),
            checked: state.settings.subagentAggregation,
            disabled: busy,
            onToggle: async (next) => {
                await onPatch({ subagentAggregation: next })
            },
        }),
        // 只读卡：写入路径上补的这道关卡常驻开启，关掉等于放任坏数据落盘，不存在「关闭」这个状态，卡片只做展示。
        createElement(
            'section',
            { style: CARD },
            createElement(
                'div',
                { style: ROW },
                createElement('span', { style: CARD_TITLE }, t('rule.retryIntercept.title')),
                createElement(Tooltip, {
                    label: t('rule.retryIntercept.help'),
                    side: 'bottom',
                    children: createElement(
                        'span',
                        { style: HELP_ANCHOR },
                        createElement(IconQuestionOutlineRegular, { size: 14 }),
                    ),
                }),
                createElement('span', { style: SPACER }),
                createElement('span', { style: FORCED_LABEL }, t('rule.retryIntercept.forced')),
            ),
            createElement('div', { style: CARD_DESC }, t('rule.retryIntercept.desc')),
        ),
        createElement(SessionRepairCard, { t }),
    )
}

/** 一张开关卡片的渲染参数。 */
interface SwitchCardProps {
    title: string
    description: string
    help: string
    checked: boolean
    disabled: boolean
    onToggle: (next: boolean) => void
}

/**
 * 渲染一张开关卡片：标题 + 问号说明 + 贴右的开关，下面一行描述。
 *
 * @param props - 卡片文案、当前值与变更回调。
 */
function renderSwitchCard(props: SwitchCardProps): ReactElement {
    return createElement(
        'section',
        { style: CARD },
        createElement(
            'div',
            { style: ROW },
            createElement('span', { style: CARD_TITLE }, props.title),
            // Tooltip 要 clone 它的 children 来挂锚点，所以锚点元素必须放进 props.children——
            // 走 createElement 的第三参数会被 React 的类型判成「P 里必填的 children 没给」。
            createElement(Tooltip, {
                label: props.help,
                side: 'bottom',
                children: createElement(
                    'span',
                    { style: HELP_ANCHOR },
                    createElement(IconQuestionOutlineRegular, { size: 14 }),
                ),
            }),
            createElement('span', { style: SPACER }),
            createElement(Switch, {
                checked: props.checked,
                onChange: props.onToggle,
                disabled: props.disabled,
                label: props.title,
            }),
        ),
        createElement('div', { style: CARD_DESC }, props.description),
    )
}

/** 「修复损坏会话」卡片的渲染参数。 */
interface SessionRepairCardProps {
    t: PlatformTranslate
}

/** 一次修复的汇总（卡片内展示）。 */
interface RepairSummary {
    总数: number
    无需修复数: number
    已修复数: number
    修不了数: number
    读取失败数: number
    /** 修不了 / 读取失败的条目（最多展示前 10 条，其余只报数量）。 */
    失败明细组: { 会话: string; 原因: string }[]
}

/** 失败明细最多列出的条数：再多会把卡片撑得很长，剩下的只报数量。 */
const REPAIR_DETAIL_LIMIT = 10

/**
 * 「修复损坏会话」卡片：标题 + 问号说明 + 贴右的修复按钮，下面一行描述与结果汇总。
 *
 * **为什么是独立组件。** 修复动作有自己的忙碌态与结果，与配置写回的全局 busy 互不相干；
 * 状态留在卡片自己这里，面板不必为它扩参。
 *
 * @param props - 翻译函数。
 */
function SessionRepairCard(props: SessionRepairCardProps): ReactElement {
    const [busy, setBusy] = useState(false)
    const [summary, setSummary] = useState<RepairSummary | null>(null)
    const [failureText, setFailureText] = useState<string | null>(null)

    /** 点「一键扫描并修复」：POST 端点，成功后把汇总摊在卡片里。 */
    async function 修复Btn_Click(): Promise<void> {
        if (busy) return

        setBusy(true)
        setSummary(null)
        setFailureText(null)

        try {
            const data = await postJson(REPAIR_ENDPOINT, {})

            // 明细组是不可信输入：非数组按空数组处理，只留下「修不了 / 读取失败」两类。
            const 原始明细组: unknown[] = Array.isArray(data.明细组) ? data.明细组 : []
            const 失败明细组: { 会话: string; 原因: string }[] = []

            for (const 明细 of 原始明细组) {
                const 条目 = 明细 as { filePath?: unknown; status?: unknown; reason?: unknown }
                if (条目.status !== 'unrepairable' && 条目.status !== 'read-failed') continue

                // 会话名＝路径倒数第二段（会话目录名）；不足两段（没有目录部分）时退回整串。
                const 会话名 = String(条目.filePath).split(/[\\/]/).at(-2) ?? String(条目.filePath)

                失败明细组.push({ 会话: 会话名, 原因: String(条目.reason ?? '') })
            }

            setSummary({
                总数: Number(data.总数),
                无需修复数: Number(data.通过数),
                已修复数: Number(data.已修复数),
                修不了数: Number(data.修不了数),
                读取失败数: Number(data.读取失败数),
                失败明细组: 失败明细组.slice(0, REPAIR_DETAIL_LIMIT),
            })

        } catch (error) {
            setFailureText(messageOf(error))

        } finally {
            setBusy(false)
        }
    }

    const summaryLine = summary === null
        ? null
        : createElement(
            'div',
            { style: CARD_DESC },
            props.t('repair.done', {
                p1: summary.总数,
                p2: summary.无需修复数,
                p3: summary.已修复数,
                p4: summary.修不了数,
                p5: summary.读取失败数,
            }),
        )

    // 明细只列前 10 条：两类失败的总数减去已列出的条数，就是被截掉没列出的条数。
    const detailLines: ReactElement[] = []

    if (summary !== null) {
        for (const [index, 明细] of summary.失败明细组.entries()) {
            const 原因文本 = translateHostText(props.t, 明细.原因)

            detailLines.push(
                createElement(
                    'div',
                    { key: `${明细.会话}-${index}`, style: DETAIL_LINE },
                    `${明细.会话}：${原因文本}`,
                ),
            )
        }

        const 未列出数 = summary.修不了数 + summary.读取失败数 - summary.失败明细组.length

        if (未列出数 > 0) {
            detailLines.push(
                createElement('div', { key: 'more', style: DETAIL_LINE }, props.t('repair.more', { p1: 未列出数 })),
            )
        }
    }

    const failureLine = failureText === null
        ? null
        : createElement('div', { style: NOTICE_ERROR }, `${props.t('repair.failed')}：${translateHostText(props.t, failureText)}`)

    return createElement(
        'section',
        { style: CARD },
        createElement(
            'div',
            { style: ROW },
            createElement('span', { style: CARD_TITLE }, props.t('repair.title')),
            createElement(Tooltip, {
                label: props.t('repair.help'),
                side: 'bottom',
                children: createElement(
                    'span',
                    { style: HELP_ANCHOR },
                    createElement(IconQuestionOutlineRegular, { size: 14 }),
                ),
            }),
            createElement('span', { style: SPACER }),
            createElement(
                Button,
                {
                    variant: 'primary',
                    size: 'sm',
                    disabled: busy,
                    onClick: () => void 修复Btn_Click(),
                },
                busy ? props.t('repair.running') : props.t('repair.button'),
            ),
        ),
        createElement('div', { style: CARD_DESC }, props.t('repair.desc')),
        summaryLine,
        detailLines,
        failureLine,
    )
}

/** 工具失败续跑卡片的渲染参数。 */
interface ToolFailureCardProps {
    settings: HardenSettings
    t: PlatformTranslate
    busy: boolean
    onPatch: (patch: Partial<HardenSettings>) => Promise<void>
}

/**
 * 工具失败续跑卡片：开关 + 失败提示前缀多行框。
 *
 * **为什么是组件而不是渲染函数。** 多行框需要一份「正在编辑的草稿」，而草稿是组件私有状态
 * ——普通渲染函数没法在内部调 hooks。做成独立组件后，面板只管已保存的配置，草稿留在卡片自己
 * 这里。草稿为 null 表示「跟随已保存值」，失焦时等于原值就不发请求。
 *
 * **为什么用原生 textarea。** 平台 primitives 没有多行输入组件，这里直接用原生元素，
 * 样式照 CARD / TEXTAREA 的 token 用法。
 *
 * @param props - 已保存配置、翻译函数、写回忙碌标记与补丁写回入口。
 */
function ToolFailureCard(props: ToolFailureCardProps): ReactElement {
    const [prefixesDraft, setPrefixesDraft] = useState<string | null>(null)

    const prefixesText = prefixesDraft ?? props.settings.toolFailurePrefixes

    /** 提交失败提示前缀：等于原值就不发请求。 */
    async function commitPrefixes(): Promise<void> {
        if (prefixesDraft === null) return

        setPrefixesDraft(null)

        if (prefixesDraft === props.settings.toolFailurePrefixes) return

        await props.onPatch({ toolFailurePrefixes: prefixesDraft })
    }

    /** 切换规则 H1 开关。 */
    async function toggleGuard(next: boolean): Promise<void> {
        await props.onPatch({ toolFailureGuard: next })
    }

    /** 多行框内容变更：只更新草稿，失焦时才提交。 */
    function handlePrefixesChange(event: ChangeEvent<HTMLTextAreaElement>): void {
        setPrefixesDraft(event.target.value)
    }

    const prefixesArea = createElement('textarea', {
        style: TEXTAREA,
        rows: 4,
        value: prefixesText,
        disabled: props.busy,
        placeholder: props.t('field.toolFailurePrefixes.placeholder'),
        'aria-label': props.t('field.toolFailurePrefixes.title'),
        onChange: handlePrefixesChange,
        onBlur: commitPrefixes,
    })

    return createElement(
        'section',
        { style: CARD },
        createElement(
            'div',
            { style: ROW },
            createElement('span', { style: CARD_TITLE }, props.t('rule.toolFailureGuard.title')),
            createElement(Tooltip, {
                label: props.t('rule.toolFailureGuard.help'),
                side: 'bottom',
                children: createElement(
                    'span',
                    { style: HELP_ANCHOR },
                    createElement(IconQuestionOutlineRegular, { size: 14 }),
                ),
            }),
            createElement('span', { style: SPACER }),
            createElement(Switch, {
                checked: props.settings.toolFailureGuard,
                onChange: toggleGuard,
                disabled: props.busy,
                label: props.t('rule.toolFailureGuard.title'),
            }),
        ),
        createElement('div', { style: CARD_DESC }, props.t('rule.toolFailureGuard.desc')),
        createElement('div', { style: FIELD_LABEL }, props.t('field.toolFailurePrefixes.hint')),
        prefixesArea,
        createElement('div', { style: CARD_DESC }, props.t('field.toolFailurePrefixes.help')),
    )
}

/** 网络重试卡片的渲染参数。 */
interface NetworkRetryCardProps {
    settings: HardenSettings
    t: PlatformTranslate
    busy: boolean
    onPatch: (patch: Partial<HardenSettings>) => Promise<void>
}

/**
 * 网络重试卡片：两个输入框（重试次数、失败特征）。
 *
 * **为什么是组件而不是渲染函数。** 两个输入框各需要一份「正在编辑的草稿」，
 * 而草稿是组件私有状态——普通渲染函数没法在内部调 hooks。做成独立组件后，
 * 面板只管已保存的配置，草稿留在卡片自己这里。草稿为 null 表示「跟随已保存值」。
 *
 * @param props - 已保存配置、翻译函数、写回忙碌标记与补丁写回入口。
 */
function NetworkRetryCard(props: NetworkRetryCardProps): ReactElement {
    const [countDraft, setCountDraft] = useState<string | null>(null)
    const [tokensDraft, setTokensDraft] = useState<string | null>(null)

    const countText = countDraft ?? String(props.settings.networkRetryCount)
    const tokensText = tokensDraft ?? props.settings.networkRetryTokens

    /** 提交重试次数：草稿非法就丢弃，等于原值就不发请求。 */
    async function commitCount(): Promise<void> {
        if (countDraft === null) return

        setCountDraft(null)

        const parsed = Number.parseInt(countDraft, 10)
        const inRange = parsed >= RETRY_COUNT_MIN && parsed <= RETRY_COUNT_MAX
        if (Number.isInteger(parsed) === false || inRange === false) return
        if (parsed === props.settings.networkRetryCount) return

        await props.onPatch({ networkRetryCount: parsed })
    }

    /** 提交失败特征：等于原值就不发请求。 */
    async function commitTokens(): Promise<void> {
        if (tokensDraft === null) return

        setTokensDraft(null)

        if (tokensDraft === props.settings.networkRetryTokens) return

        await props.onPatch({ networkRetryTokens: tokensDraft })
    }

    const countInput = createElement(Input, {
        type: 'number',
        min: RETRY_COUNT_MIN,
        max: RETRY_COUNT_MAX,
        value: countText,
        disabled: props.busy,
        'aria-label': props.t('field.retryCount.title'),
        onChange: (event) => setCountDraft(event.target.value),
        onBlur: commitCount,
    })

    const tokensInput = createElement(Input, {
        type: 'text',
        value: tokensText,
        disabled: props.busy,
        'aria-label': props.t('field.retryTokens.title'),
        onChange: (event) => setTokensDraft(event.target.value),
        onBlur: commitTokens,
    })

    return createElement(
        'section',
        { style: CARD },
        createElement(
            'div',
            { style: ROW },
            createElement('span', { style: CARD_TITLE }, props.t('rule.networkRetry.title')),
            createElement(Tooltip, {
                label: props.t('rule.networkRetry.help'),
                side: 'bottom',
                children: createElement(
                    'span',
                    { style: HELP_ANCHOR },
                    createElement(IconQuestionOutlineRegular, { size: 14 }),
                ),
            }),
        ),
        createElement('div', { style: CARD_DESC }, props.t('rule.networkRetry.desc')),
        renderFieldRow(props.t, 'field.retryCount', countInput),
        renderFieldRow(props.t, 'field.retryTokens', tokensInput),
    )
}

/** 上下文自动压缩卡片的渲染参数。 */
interface CompactionCardProps {
    settings: HardenSettings
    t: PlatformTranslate
    busy: boolean
    onPatch: (patch: Partial<HardenSettings>) => Promise<void>
}

/**
 * 上下文自动压缩卡片：开关 + 触发阈值输入框 + 摘要指令多行框。
 *
 * **为什么是组件而不是渲染函数。** 阈值框与指令框各需要一份「正在编辑的草稿」，
 * 而草稿是组件私有状态——普通渲染函数没法在内部调 hooks。做成独立组件后，
 * 面板只管已保存的配置，草稿留在卡片自己这里。草稿为 null 表示「跟随已保存值」。
 *
 * **为什么用原生 textarea。** 平台 primitives 没有多行输入组件，这里直接用原生元素，
 * 样式照 CARD / TEXTAREA 的 token 用法。
 *
 * @param props - 已保存配置、翻译函数、写回忙碌标记与补丁写回入口。
 */
function CompactionCard(props: CompactionCardProps): ReactElement {
    const [thresholdDraft, setThresholdDraft] = useState<string | null>(null)
    const [instructionDraft, setInstructionDraft] = useState<string | null>(null)
    /** 压缩范围下拉（`Menu`）的展开态。 */
    const [scopeMenuOpen, setScopeMenuOpen] = useState(false)

    const thresholdText = thresholdDraft ?? props.settings.compactionThreshold
    const instructionText = instructionDraft ?? props.settings.compactionInstruction

    const thresholdInvalid = parseThresholdText(thresholdText) === null

    /** 提交触发阈值：非法就丢弃，等于原值就不发请求。 */
    async function commitThreshold(): Promise<void> {
        if (thresholdDraft === null) return

        setThresholdDraft(null)

        if (parseThresholdText(thresholdDraft) === null) return
        if (thresholdDraft === props.settings.compactionThreshold) return

        await props.onPatch({ compactionThreshold: thresholdDraft })
    }

    /** 提交摘要指令：等于原值就不发请求。 */
    async function commitInstruction(): Promise<void> {
        if (instructionDraft === null) return

        setInstructionDraft(null)

        if (instructionDraft === props.settings.compactionInstruction) return

        await props.onPatch({ compactionInstruction: instructionDraft })
    }

    /** 切换上下文自动压缩开关。 */
    async function toggleCompaction(next: boolean): Promise<void> {
        await props.onPatch({ contextCompaction: next })
    }

    /** 提交压缩范围：等于原值就不发请求。 */
    async function commitCompactionScope(next: CompactionScope): Promise<void> {
        if (next === props.settings.compactionScope) return

        await props.onPatch({ compactionScope: next })
    }

    /** 多行框内容变更：只更新草稿，失焦时才提交。 */
    function handleInstructionChange(event: ChangeEvent<HTMLTextAreaElement>): void {
        setInstructionDraft(event.target.value)
    }

    const thresholdInput = createElement(Input, {
        type: 'text',
        value: thresholdText,
        disabled: props.busy,
        placeholder: props.t('field.compactionThreshold.placeholder'),
        'aria-label': props.t('field.compactionThreshold.title'),
        onChange: (event) => setThresholdDraft(event.target.value),
        onBlur: commitThreshold,
    })

    const thresholdHint = thresholdInvalid
        ? createElement('div', { style: NOTICE_ERROR }, props.t('field.compactionThreshold.invalid'))
        : null

    const instructionArea = createElement('textarea', {
        style: TEXTAREA,
        rows: 6,
        value: instructionText,
        disabled: props.busy,
        placeholder: props.t('field.compactionInstruction.placeholder'),
        'aria-label': props.t('field.compactionInstruction.title'),
        onChange: handleInstructionChange,
        onBlur: commitInstruction,
    })

    const scopeLabels: Record<CompactionScope, string> = {
        all: props.t('field.compactionScope.optionAll'),
        main: props.t('field.compactionScope.optionMain'),
        subagent: props.t('field.compactionScope.optionSubagent'),
    }

    const scopeItems: MenuEntry[] = [
        { id: 'all', label: scopeLabels.all },
        { id: 'main', label: scopeLabels.main },
        { id: 'subagent', label: scopeLabels.subagent },
    ]

    // 平台没有原生 select；下拉一律是「自绘锚点 + Menu」，锚点文字顶左、箭头贴右。
    const scopeMenu = createElement(Menu, {
        open: scopeMenuOpen,
        anchor: createElement(
            Button,
            {
                type: 'button',
                variant: 'outline',
                disabled: props.busy,
                onClick: () => setScopeMenuOpen(!scopeMenuOpen),
                style: MENU_ANCHOR,
            },
            [
                createElement('span', { key: 'text', style: MENU_ANCHOR_TEXT }, scopeLabels[props.settings.compactionScope]),
                createElement(
                    'span',
                    { key: 'caret', style: MENU_ANCHOR_CARET },
                    createElement(
                        scopeMenuOpen ? IconChevronUpOutlineRegular : IconChevronDownOutlineRegular,
                        { size: 12 },
                    ),
                ),
            ],
        ),
        items: scopeItems,
        selectedId: props.settings.compactionScope,
        onSelect: (id: string) => {
            setScopeMenuOpen(false)
            commitCompactionScope(id as CompactionScope)
        },
        onClose: () => setScopeMenuOpen(false),
        side: 'bottom',
        portal: true,
    })

    return createElement(
        'section',
        { style: CARD },
        createElement(
            'div',
            { style: ROW },
            createElement('span', { style: CARD_TITLE }, props.t('rule.contextCompaction.title')),
            createElement(Tooltip, {
                label: props.t('rule.contextCompaction.help'),
                side: 'bottom',
                children: createElement(
                    'span',
                    { style: HELP_ANCHOR },
                    createElement(IconQuestionOutlineRegular, { size: 14 }),
                ),
            }),
            createElement('span', { style: SPACER }),
            createElement(Switch, {
                checked: props.settings.contextCompaction,
                onChange: toggleCompaction,
                disabled: props.busy,
                label: props.t('rule.contextCompaction.title'),
            }),
        ),
        createElement('div', { style: CARD_DESC }, props.t('rule.contextCompaction.desc')),
        renderFieldRow(props.t, 'field.compactionScope', scopeMenu),
        renderFieldRow(props.t, 'field.compactionThreshold', thresholdInput),
        thresholdHint,
        createElement('div', { style: FIELD_LABEL }, props.t('field.compactionInstruction.title')),
        instructionArea,
        createElement('div', { style: CARD_DESC }, props.t('field.compactionInstruction.help')),
    )
}

/**
 * 渲染一行带输入控件的设置项：左边标签 + 问号说明，右边贴控件。
 *
 * 标签与问号居左，控件槽**定宽**、由弹簧推到卡片右缘——几行右缘因此一律对齐（用户定稿：控件不撑满
 * 整行）。**槽里用 grid 不用 flex**：平台 Input 的外壳是 span 且不吃外部宽度，flex 里从外面拉不满；
 * grid item 默认 stretch，不看组件内部实现照样拉满。
 *
 * @param t - 翻译函数。
 * @param keyBase - 文案 key 前缀（`.title` / `.help` 由这里补）。
 * @param control - 行尾的输入控件。
 */
function renderFieldRow(t: PlatformTranslate, keyBase: string, control: ReactElement): ReactElement {
    return createElement(
        'div',
        { style: ROW },
        createElement('span', { style: FIELD_LABEL }, t(`${keyBase}.title`)),
        createElement(Tooltip, {
            label: t(`${keyBase}.help`),
            side: 'bottom',
            children: createElement(
                'span',
                { style: HELP_ANCHOR },
                createElement(IconQuestionOutlineRegular, { size: 14 }),
            ),
        }),
        createElement('span', { style: SPACER }),
        createElement('div', { style: FIELD_SLOT }, control),
    )
}

// ── 样式（全走主题 token，不写死颜色）────────────────────────────────────

/** 页面容器。 */
const PAGE: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.2em',
    padding: '1.2em',
    fontSize: '13px',
    lineHeight: 1.6,
}

const HEADER: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '0.6em',
}

const HEADER_ICON: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    color: 'var(--dsw-alias-label-secondary)',
}

const HEADER_NAME: CSSProperties = { fontWeight: 600, fontSize: '1.15em' }

const HEADER_META: CSSProperties = { color: 'var(--dsw-alias-label-tertiary)' }

/** 弹簧：把同一行右侧的操作项推到行尾。 */
const SPACER: CSSProperties = { flex: '1 1 auto', minWidth: '0' }

/** 卡片容器：多张卡片纵向排列。 */
const CARD_LIST: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.8em',
}

const CARD: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.35em',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '0.6em',
    padding: '0.9em 1em',
    background: 'var(--dsw-alias-bg-layer-1)',
}

const CARD_TITLE: CSSProperties = { fontWeight: 600 }

const CARD_DESC: CSSProperties = { color: 'var(--dsw-alias-label-secondary)' }

/** 只读卡的「常驻开启」小标：灰字（三级文本色），与行内问号 HELP_ANCHOR 同一口径。 */
const FORCED_LABEL: CSSProperties = {
    color: 'var(--dsw-alias-label-tertiary)',
    fontSize: '0.92em',
}

/** 修复明细行：小字 + 次级文本色（失败条目本身不是操作失败，不用错误红）；长原因换行不撑破卡片。 */
const DETAIL_LINE: CSSProperties = {
    fontSize: '0.92em',
    color: 'var(--dsw-alias-label-secondary)',
    wordBreak: 'break-word',
}

const ROW: CSSProperties = { display: 'flex', alignItems: 'center', gap: '0.5em' }

/** 输入行左边那格标签。 */
const FIELD_LABEL: CSSProperties = { color: 'var(--dsw-alias-label-secondary)' }

/** 字段行的控件槽：定宽（相对单位，随面板字号缩放），由弹簧推到卡片右缘；槽内用 grid 让平台控件撑满槽宽。 */
const FIELD_SLOT: CSSProperties = {
    flex: 'none',
    width: '18em',
    maxWidth: '60%',
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr)',
    alignItems: 'center',
}

/** 多行输入框：平台 primitives 无多行组件，直接用原生 textarea，样式照 CARD 的 token 用法。 */
const TEXTAREA: CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '0.4em',
    padding: '0.5em 0.6em',
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'inherit',
    font: 'inherit',
    resize: 'vertical',
}

/** 问号锚点：图标只吃 size/className，要参与 flex 布局得自己在外面包一层。 */
const HELP_ANCHOR: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    color: 'var(--dsw-alias-label-tertiary)',
    cursor: 'help',
}

/** 下拉锚点按钮：文字顶左、箭头贴右，跟着容器撑满。 */
const MENU_ANCHOR: CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    justifyContent: 'space-between',
    gap: '0.45em',
}

/** 锚点里的文字：允许收缩并出省略号。 */
const MENU_ANCHOR_TEXT: CSSProperties = {
    display: 'block',
    minWidth: '0',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
}

/** 锚点尾部的箭头槽：图标只吃 size/className，包一层免得被文字压。 */
const MENU_ANCHOR_CARET: CSSProperties = {
    display: 'inline-flex',
    flex: 'none',
    color: 'var(--dsw-alias-label-tertiary)',
}

const HINT: CSSProperties = { color: 'var(--dsw-alias-label-secondary)' }

const FAIL_CARD: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '0.5em',
    border: '1px solid var(--dsw-alias-state-error-primary)',
    borderRadius: '0.6em',
    padding: '0.9em 1em',
}

const FAIL_TITLE: CSSProperties = { fontWeight: 600 }

const FAIL_MESSAGE: CSSProperties = { color: 'var(--dsw-alias-label-secondary)' }

const NOTICE_OK: CSSProperties = { color: 'var(--dsw-alias-state-success-primary)' }

const NOTICE_ERROR: CSSProperties = { color: 'var(--dsw-alias-state-error-primary)' }
