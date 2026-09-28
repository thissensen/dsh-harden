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
    IconQuestionOutlineRegular,
    IconRefreshOutlineRegular,
    IconShieldOutlineRegular,
    Input,
    Modal,
    Switch,
    Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { translateHostText, translateZh } from '../locales'
import type { PlatformTranslate } from '../locales'

/** 面板属性（`t` 由壳经 props 传进来——面板拿不到 cordis ctx）。 */
export interface PanelProps {
    t?: PlatformTranslate
}

/** 插件版本号（与 `package.json` 的 `version` 保持一致）。 */
const PLUGIN_VERSION = '0.0.1-preview.1'

/** 包名（页头那行灰字）。 */
const PACKAGE_NAME = 'dsh-harden'

/** host 侧配置的形状（每条看护规则一组开关/参数）。 */
interface HardenSettings {
    toolFailureGuard: boolean
    toolFailurePrefixes: string
    emptyOutputGuard: boolean
    networkRetryCount: number
    networkRetryTokens: string
    backgroundJobTool: boolean
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

/** 装载 / 卸载「打开文件夹」接管的方向（弹窗文案按它分岔）。 */
type OpenFolderToggle = 'load' | 'unload'

/** 配置端点（读与写共用）。 */
const CONFIG_ENDPOINT = '/api/dsh-harden/config'

/** 「打开文件夹」接管端点：读装载状态、装载/卸载。 */
const OPEN_FOLDER_ENDPOINT = '/api/dsh-harden/open-folder'

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
    }
}

/** 把异常转成可显示的一行。 */
function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
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
    const [openFolderEnabled, setOpenFolderEnabled] = useState<boolean | null>(null)
    const [restartHint, setRestartHint] = useState<OpenFolderToggle | null>(null)

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

            try {
                const data = await fetchJson(OPEN_FOLDER_ENDPOINT)
                if (alive) setOpenFolderEnabled(data.enabled === true)

            } catch {
                // 读不到就当未装载：按钮照常可用，点了会再试一次。
                if (alive) setOpenFolderEnabled(false)
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

    /**
     * 装载 / 卸载「打开文件夹」接管。
     *
     * 与配置写回分开走：这一步改的是平台插件表（host 侧会成对切换两条 row），
     * 不是插件配置，所以不复用 applyPatch。
     *
     * 成功后弹一次「需重启」提示：装载状态在宿主进程里即时切换，但必须重启 DSH
     * 桌面端才真正生效，不给提示用户会以为已经生效。
     *
     * @param next - true 装载、false 卸载。
     */
    async function toggleOpenFolder(next: boolean): Promise<void> {
        if (openFolderEnabled === null || busy) return

        const previous = openFolderEnabled

        setBusy(true)
        setNotice(null)
        setOpenFolderEnabled(next)

        try {
            await postJson(OPEN_FOLDER_ENDPOINT, { enabled: next })
            setRestartHint(next ? 'load' : 'unload')

        } catch (error) {
            setOpenFolderEnabled(previous)
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

    /** 关掉「需重启」提示。 */
    function closeRestartHint(): void {
        setRestartHint(null)
    }

    // 装载 / 卸载刚成功时弹一次：宿主侧已切换，但浏览器壳不重启看不到变化。
    const restartModal = restartHint === null
        ? null
        : createElement(Modal, {
            open: true,
            onClose: closeRestartHint,
            title: t('openFolder.restartTitle'),
            closeLabel: t('common.close'),
            description: restartHint === 'load' ? t('openFolder.restartLoadDesc') : t('openFolder.restartUnloadDesc'),
            footer: createElement(Button, { variant: 'primary', size: 'sm', onClick: closeRestartHint }, t('common.gotIt')),
        })

    return createElement(
        'div',
        { style: PAGE },
        renderHeader(t, updatePhase, () => setUpdatePhase('checking')),
        renderBody(state, t, busy, applyPatch, retry, openFolderEnabled, toggleOpenFolder),
        notice === null
            ? null
            : createElement('div', { style: notice.kind === 'ok' ? NOTICE_OK : NOTICE_ERROR }, notice.text),
        restartModal,
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
        // GitHub 地址未定：禁用态 + 悬停说明为什么点不动。
        createElement(
            Button,
            { variant: 'ghost', size: 'sm', disabled: true, title: t('header.githubUnset') },
            t('header.github'),
        ),
    )
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
 * @param openFolderEnabled - 「打开文件夹」接管当前是否装载；null = 尚未读到。
 * @param onToggleOpenFolder - 装载 / 卸载「打开文件夹」接管。
 */
function renderBody(
    state: LoadState,
    t: PlatformTranslate,
    busy: boolean,
    onPatch: (patch: Partial<HardenSettings>) => Promise<void>,
    onRetry: () => void,
    openFolderEnabled: boolean | null,
    onToggleOpenFolder: (next: boolean) => Promise<void>,
): ReactElement {
    if (state.status === 'loading') {
        return createElement('div', { style: HINT }, t('common.loading'))
    }

    if (state.status === 'failed') {
        // 失败原因可能是 host 的暗号，也可能是真正的网络错误原文——共享函数两��都认。
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
        renderOpenFolderCard({
            t,
            enabled: openFolderEnabled,
            busy,
            onToggle: onToggleOpenFolder,
        }),
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

/** 「打开文件夹」接管卡片的渲染参数。 */
interface OpenFolderCardProps {
    t: PlatformTranslate
    /** 当前是否已装载；null = 尚未读到。 */
    enabled: boolean | null
    busy: boolean
    onToggle: (next: boolean) => Promise<void>
}

/**
 * 「打开文件夹」接管卡片：一行标题 + 问号说明 + 贴右的装载/卸载按钮，下面两行描述。
 *
 * 与其它卡片不同，这里不是一个持久化的配置开关，而是**运行时装载/卸载**
 * 同包第二个入口（`dsh-harden/open-folder`）：装载时由它接管 `/open-in-app/*`、
 * 同时把官方那行停掉；卸载时反过来，让官方启动器全部回来。
 *
 * @param props - 翻译函数、当前装载状态、忙碌标记与切换回调。
 */
function renderOpenFolderCard(props: OpenFolderCardProps): ReactElement {
    const loaded = props.enabled === true
    const disabled = props.busy || props.enabled === null
    const label = loaded ? props.t('rule.openFolder.unload') : props.t('rule.openFolder.load')

    return createElement(
        'section',
        { style: CARD },
        createElement(
            'div',
            { style: ROW },
            createElement('span', { style: CARD_TITLE }, props.t('rule.openFolder.title')),
            createElement(Tooltip, {
                label: props.t('rule.openFolder.help'),
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
                    variant: loaded ? 'outline' : 'primary',
                    size: 'sm',
                    disabled,
                    onClick: () => void props.onToggle(!loaded),
                },
                label,
            ),
        ),
        createElement('div', { style: CARD_DESC }, props.t('rule.openFolder.desc')),
        createElement(
            'div',
            { style: CARD_DESC },
            props.enabled === null
                ? props.t('common.loading')
                : loaded
                    ? props.t('rule.openFolder.loaded')
                    : props.t('rule.openFolder.unloaded'),
        ),
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
 * 样式照 CARD / FIELD_BOX 的 token 用法。
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

/**
 * 渲染一行带输入控件的设置项：左边标签 + 问号说明，右边贴控件。
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
        createElement('div', { style: FIELD_BOX }, control),
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

const ROW: CSSProperties = { display: 'flex', alignItems: 'center', gap: '0.5em' }

/** 输入行左边那格标签。 */
const FIELD_LABEL: CSSProperties = { color: 'var(--dsw-alias-label-secondary)' }

/** 输入控件的定宽容器：平台 Input 是 span 包 input，宽度只能从外面给。 */
const FIELD_BOX: CSSProperties = { width: '18em', maxWidth: '60%' }

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
