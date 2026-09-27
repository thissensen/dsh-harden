/**
 * 「插件介入」系统行：把看护层的纠正消息显示成一行浅色系统提示。
 *
 * **为什么单独注册一行。** 看护层注入的消息 source.kind 是 harden-nudge，
 * 平台自带的 input-message 定义把它投影成 context 节点，而客户端的可见性
 * 判定（isVisibleChatNode 不渲染 context）会把它吞掉——界面看不到。
 * 本行不走 input-message：index.ts 另注册一个 harden-nudge-row 节点定义，
 * 把同一事件投影成 visibility: 'visible' 的独立节点，视觉上像平台自带的
 * 「思考中」「重试」提示，不是用户发言。
 *
 * @module dsh-harden/client-nudge-row
 */

import { createElement } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { IconShieldOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { translateHostText } from '../locales'
import type { PlatformTranslate } from '../locales'

/** 纠正消息的来源标记（host 侧 HardenNudgeMessageSource 的客户端镜像）。 */
interface NudgeSource {
    kind: string
    form?: string
    summary: string
}

/** 本行拿到的会话节点（只声明用到的字段）。 */
export interface NudgeRowNode {
    kind: string
    data: { source: NudgeSource }
}

/** 渲染器属性（node 与 t 都由平台 renderSlot 注入）。 */
export interface NudgeRowProps {
    node: NudgeRowNode
    t?: PlatformTranslate
}

/** 行容器：与平台「思考中」「重试」同一种浅色小字行。 */
const ROW: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '2px 0',
    color: 'var(--dsw-alias-label-secondary)',
    fontSize: 13,
    lineHeight: '20px',
}

/** 行首图标容器。 */
const GLYPH: CSSProperties = {
    display: 'inline-flex',
    flex: 'none',
    color: 'var(--dsw-alias-label-tertiary)',
}

/** 正文：一行到底，超出用省略号，不折行。 */
const TEXT: CSSProperties = {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
}

/**
 * 渲染一行「插件介入」提示。
 *
 * @param props - 平台注入的会话节点与翻译函数。
 */
export function NudgeRow(props: NudgeRowProps): ReactElement {
    const summary = props.node.data.source.summary
    const aria = props.t === undefined ? summary : props.t('nudge.rowAria')

    // summary 是 host 传来的暗号（平台把 notice 的 summary 类型写死成 string，
    // 塞不了对象）；拆解与翻译在 locales.ts 里，与设置页的报错共用一份。
    const shown = props.t === undefined ? summary : translateHostText(props.t, summary)

    return createElement(
        'div',
        { style: ROW, role: 'note', 'aria-label': aria },
        createElement('span', { style: GLYPH }, createElement(IconShieldOutlineRegular, { size: 13 })),
        createElement('span', { style: TEXT }, shown),
    )
}
