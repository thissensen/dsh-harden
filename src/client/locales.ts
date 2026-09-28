/**
 * 「DSH优化」设置页的文案字典（zh / en）。
 *
 * 中文是源语言；`en` 声明成 `Record<CopyKey, string>`，漏一条 typecheck 直接红。
 * 占位符用 `{name}`，由 `t` 的第二参数插值。
 *
 * @module dsh-harden/client-locales
 */

/** 翻译函数的形态（平台注入的那份）。 */
export type PlatformTranslate = (key: string, params?: Record<string, string | number>) => string

/** 本插件在平台 locale 服务里注册的命名空间。 */
export const LOCALE_NS = 'harden'

/** 中文（源语言）。key 集合就是权威集合。 */
export const zh = {
    'shell.sectionLabel': 'DSH优化',
    'nudge.rowAria': '插件介入',
    'nudge.toolFailure': 'DSH优化：工具调用失败，已提示模型重新发起（第 {p1} 次）',
    'nudge.emptyTurn': 'DSH优化：回合没有答复就收尾，已提示模型补充正文（第 {p1} 次）',

    'header.name': 'DSH优化',
    'header.checkUpdate': '检查更新',
    'header.checking': '检查中…',
    'header.upToDate': '已是最新',
    'header.github': 'GitHub',
    'header.githubUnset': '仓库地址未定，暂不可用',

    'rule.toolFailureGuard.title': '工具调用失败续跑',
    'rule.toolFailureGuard.desc': '解决有时因为工具调用失败导致的会话突然中断',
    'rule.toolFailureGuard.help':
        '模型发起的工具调用没执行成功、框架却把回合当作正常结束时，注入一条提示让模型重新发起，不让对话静默中断。',

    'field.toolFailurePrefixes.title': '失败提示前缀',
    'field.toolFailurePrefixes.hint': '只填固定前缀，一行一条',
    'field.toolFailurePrefixes.help':
        '平台把工具调用失败时，会把一段警告写进模型正文；这里填这段警告的固定开头，整段匹配开头（不拆行）。留空 = 不匹配任何警告，规则不生效。区分大小写。',
    'field.toolFailurePrefixes.placeholder': '⚠ Could not execute tool',

    'rule.emptyOutputGuard.title': '回合无正文收尾',
    'rule.emptyOutputGuard.desc': '解决模型只输出思考、没给正文就结束回合的问题',
    'rule.emptyOutputGuard.help':
        '模型在最后一步只有思考、既没有回复用户也没有发起工具调用时，把回合拉回再走一步，要求它把结果讲清楚。',

    'rule.networkRetry.title': '网络请求中断续跑',
    'rule.networkRetry.desc': '解决网络请求中断时，官方重试次数不够、会话直接失败的问题',
    'rule.networkRetry.help':
        '官方重试次数用尽后，插件按下面配置的失败特征再补几轮，让 502、限流、超时、流中断这类瞬时故障多几次机会。',

    'field.retryCount.title': '网络重试次数',
    'field.retryCount.desc': '因网络请求中断时的重试次数，全局生效',
    'field.retryCount.help': '官方重试耗尽后，插件最多再补几次。填 0 表示不兜底；范围 0 到 99。',
    'field.retryCount.invalid': '重试次数必须是 0 到 99 的整数',

    'field.retryTokens.title': '触发重试的失败特征',
    'field.retryTokens.desc': '命中这些错误码或 HTTP 状态码时才兜底重试',
    'field.retryTokens.help':
        '逗号分隔，可混填错误码（SERVER、RATE_LIMIT、TIMEOUT、TRANSPORT 等）与 HTTP 状态码（502、429 等）。留空表示不重试任何失败。',

    'api.settingsNotReady': '设置服务未就绪，暂时不能写入',
    'api.bodyReadFailed': '请求体读取失败：{p1}',
    'api.writeFailed': '写入失败：{p1}',
    'api.forbiddenHost': '不允许的来源',
    'api.forbiddenMutation': '不允许的写入请求',
    'api.contentTypeInvalid': '请求类型必须是 application/json',
    'api.unknownAction': '未知操作：{p1} {p2}',
    'api.toolFailureGuardNotBoolean': 'toolFailureGuard 必须是布尔值',
    'api.emptyOutputGuardNotBoolean': 'emptyOutputGuard 必须是布尔值',
    'api.networkRetryCountInvalid': 'networkRetryCount 必须是 0 到 99 的整数',
    'api.networkRetryTokensInvalid': 'networkRetryTokens 必须是不超过 200 字的字符串',
    'api.toolFailurePrefixesInvalid': 'toolFailurePrefixes 必须是不超过 2000 字的字符串',
    'api.backgroundJobToolNotBoolean': 'backgroundJobTool 必须是布尔值',
    'api.openFolderEnabledNotBoolean': 'enabled 必须是布尔值',
    'api.openFolderRowMissing': '找不到「打开文件夹」相关插件行',
    'api.openFolderToggleFailed': '切换失败：{p1}',

    'rule.backgroundJobTool.title': '后台任务工具',
    'rule.backgroundJobTool.desc': '创建工具对接 pwsh，让模型能把长命令丢到后台跑，不占住当前回合',
    'rule.backgroundJobTool.help':
        '开启后，模型可以用 job_background 工具起后台命令，再用 job_list / job_output / job_kill 查看和停止。关闭后该工具从工具表里消失。',

    'rule.openFolder.title': '打开文件夹接管',
    'rule.openFolder.desc': '让「打开方式 → 资源管理器」真正弹出窗口',
    'rule.openFolder.help':
        '装载后由本插件接管打开文件夹，点「打开方式 → 资源管理器」会弹出窗口（插件已修好平台原版的窗口不可见问题）。代价：接管期间官方那批启动器（VS Code、Cursor、Git Bash、Windows Terminal 等）不可用。卸载后官方启动器全部恢复。',
    'rule.openFolder.load': '装载',
    'rule.openFolder.unload': '卸载',
    'rule.openFolder.loaded': '已装载：本插件接管中，官方启动器暂不可用',
    'rule.openFolder.unloaded': '未装载：官方启动器可用',
    'openFolder.restartTitle': '需要重启 DSH',
    'openFolder.restartLoadDesc': '已装载「打开文件夹」接管。请重启 DSH 桌面端，改动才会生效。',
    'openFolder.restartUnloadDesc': '已卸载「打开文件夹」接管。请重启 DSH 桌面端，官方启动器才会恢复。',

    'panel.settingsNotReady': '设置服务未就绪',

    'common.loading': '正在读取配置…',
    'common.failed': '读取失败',
    'common.retry': '重试',
    'common.saved': '已保存',
    'common.saveFailed': '保存失败',
    'common.gotIt': '知道了',
    'common.close': '关闭',
} as const

/** 本字典的 key 集合。 */
export type CopyKey = keyof typeof zh

/** 英文。 */
export const en: Record<CopyKey, string> = {
    'shell.sectionLabel': 'DSH Optimize',
    'nudge.rowAria': 'Plugin intervention',
    'nudge.toolFailure': 'DSH Optimize: a tool call failed; the model was asked to retry (attempt {p1})',
    'nudge.emptyTurn': 'DSH Optimize: the turn ended without a reply; the model was asked to add one (attempt {p1})',

    'header.name': 'DSH Optimize',
    'header.checkUpdate': 'Check for updates',
    'header.checking': 'Checking…',
    'header.upToDate': 'Up to date',
    'header.github': 'GitHub',
    'header.githubUnset': 'Repository address not decided yet',

    'rule.toolFailureGuard.title': 'Continue after a failed tool call',
    'rule.toolFailureGuard.desc': 'Fixes the conversation stopping abruptly when a tool call fails.',
    'rule.toolFailureGuard.help':
        'When a tool call the model issued did not run and the framework still treats the turn as complete, a note is injected so the model retries instead of the conversation stopping silently.',

    'field.toolFailurePrefixes.title': 'Failure warning prefixes',
    'field.toolFailurePrefixes.hint': 'Fixed prefixes only, one per line',
    'field.toolFailurePrefixes.help':
        'When a tool call fails, the platform writes a warning into the model reply. Enter the fixed beginning of that warning here; the reply is matched as a whole against the start. Empty = no warning is matched and the rule stays off. Case-sensitive.',
    'field.toolFailurePrefixes.placeholder': '⚠ Could not execute tool',

    'rule.emptyOutputGuard.title': 'Turn ends without a reply',
    'rule.emptyOutputGuard.desc': 'Fixes the model ending a turn with only reasoning and no reply to the user.',
    'rule.emptyOutputGuard.help':
        'When the model only thinks in its last step and neither replies to the user nor calls a tool, the turn is pulled back one step and the model is asked to state its result clearly.',

    'rule.networkRetry.title': 'Continue after a network interruption',
    'rule.networkRetry.desc': 'Fixes a failed turn when the official retry budget runs out during a network interruption.',
    'rule.networkRetry.help':
        'After the official retries are exhausted, the plugin adds a few more attempts for the failure kinds listed below, giving transient faults such as 502, rate limits, timeouts and broken streams another chance.',

    'field.retryCount.title': 'Network retry count',
    'field.retryCount.desc': 'How many times to retry when a network request is interrupted; applies to every provider',
    'field.retryCount.help': 'How many extra attempts the plugin makes after the official retries run out. 0 disables it; range 0 to 99.',
    'field.retryCount.invalid': 'Retry count must be an integer between 0 and 99',

    'field.retryTokens.title': 'Failures that trigger a retry',
    'field.retryTokens.desc': 'Only these codes or HTTP statuses are retried by the plugin',
    'field.retryTokens.help':
        'Comma-separated; mix failure codes (SERVER, RATE_LIMIT, TIMEOUT, TRANSPORT) with HTTP statuses (502, 429). Empty means no failure is retried.',

    'api.settingsNotReady': 'Settings service is not ready; cannot write yet',
    'api.bodyReadFailed': 'Failed to read the request body: {p1}',
    'api.writeFailed': 'Write failed: {p1}',
    'api.forbiddenHost': 'Forbidden origin',
    'api.forbiddenMutation': 'Forbidden mutation request',
    'api.contentTypeInvalid': 'Content-type must be application/json',
    'api.unknownAction': 'Unknown action: {p1} {p2}',
    'api.toolFailureGuardNotBoolean': 'toolFailureGuard must be a boolean',
    'api.emptyOutputGuardNotBoolean': 'emptyOutputGuard must be a boolean',
    'api.networkRetryCountInvalid': 'networkRetryCount must be an integer between 0 and 99',
    'api.networkRetryTokensInvalid': 'networkRetryTokens must be a string of at most 200 characters',
    'api.toolFailurePrefixesInvalid': 'toolFailurePrefixes must be a string of at most 2000 characters',
    'api.backgroundJobToolNotBoolean': 'backgroundJobTool must be a boolean',
    'api.openFolderEnabledNotBoolean': 'enabled must be a boolean',
    'api.openFolderRowMissing': 'Could not find the "open folder" plugin rows',
    'api.openFolderToggleFailed': 'Toggle failed: {p1}',

    'rule.backgroundJobTool.title': 'Background task tool',
    'rule.backgroundJobTool.desc': 'Creates a tool wired to pwsh, letting the model run long commands in the background without blocking the turn',
    'rule.backgroundJobTool.help':
        'When on, the model can start background commands with the job_background tool and manage them with job_list / job_output / job_kill. When off, the tool disappears from the tool list.',

    'rule.openFolder.title': 'Take over opening folders',
    'rule.openFolder.desc': 'Makes "Open with → Explorer" actually pop up a window',
    'rule.openFolder.help':
        'When loaded, the plugin takes over opening folders, so "Open with → Explorer" pops up a window (the plugin fixes the invisible-window bug of the platform original). Trade-off: while loaded, the official launchers (VS Code, Cursor, Git Bash, Windows Terminal, etc.) are unavailable. Unload to bring every official launcher back.',
    'rule.openFolder.load': 'Load',
    'rule.openFolder.unload': 'Unload',
    'rule.openFolder.loaded': 'Loaded: the plugin is taking over; official launchers are unavailable',
    'rule.openFolder.unloaded': 'Not loaded: official launchers are available',
    'openFolder.restartTitle': 'Restart DSH to apply',
    'openFolder.restartLoadDesc': 'The folder-opening takeover is now loaded. Restart the DSH desktop app for it to take effect.',
    'openFolder.restartUnloadDesc': 'The folder-opening takeover is now unloaded. Restart the DSH desktop app to bring the official launchers back.',

    'panel.settingsNotReady': 'Settings service is not ready',

    'common.loading': 'Reading configuration…',
    'common.failed': 'Failed to load',
    'common.retry': 'Retry',
    'common.saved': 'Saved',
    'common.saveFailed': 'Save failed',
    'common.gotIt': 'Got it',
    'common.close': 'Close',
}

/**
 * 把 host 传来的暗号翻成一句人话。
 *
 * host 侧的文本是 `key` 或 `key|参数1|参数2` 形式——平台把 notice 的 summary
 * 类型写死成 string，塞不了对象，只能这样传。**两处消费方共用这一份**：
 * 「插件介入」行（nudge-row）与设置页的报错（panel）。
 *
 * 拆不出已知 key 就原样返回：旧会话日志里的中文、以及真正的网络错误原文
 * （如 `HTTP 500`）都该照常显示，不能变成空白。
 *
 * @param t - 翻译函数。
 * @param raw - host 传来的原始文本，可能是暗号也可能已经是人话。
 * @returns 翻译后的文本，或原文本。
 */
export function translateHostText(t: PlatformTranslate, raw: string): string {
    const parts = raw.split('|')
    const key = parts[0]

    // 平台查不到的 key 会原样返回 key 本身——用这个判据，不自建 key 清单（会漂移）。
    if (t(key) === key) return raw

    return t(key, { p1: parts[1] ?? '', p2: parts[2] ?? '' })
}

/**
 * 不依赖平台时的中文兜底翻译器。
 *
 * @returns 直接读 `zh` 的翻译函数。
 */
export function translateZh(): PlatformTranslate {
    return (key, params) => {
        const raw = (zh as Record<string, string>)[key] ?? key
        if (params === undefined) return raw
        return raw.replace(/\{(\w+)\}/g, (match, name: string) =>
            name in params ? String(params[name]) : match,
        )
    }
}
