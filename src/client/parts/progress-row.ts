/**
 * 「子代理通知暂存」提示行：等待期间显示一行浅色小字，说明结算通知被压住了。
 *
 * **为什么单独注册一行。** host 压住兄弟子代理的结算通知时，平台会往会话里落一条
 * 收件簿摘除事件（agent/inbox/spliced：摘掉 1 条、不补任何消息）。这条事件对界面
 * 是隐形的——它什么都没插入，聊天里看不到任何痕迹。本行不走平台自带的任何节点：
 * index.ts 另注册一个 harden-progress-row 定义，把同一事件投影成
 * visibility: 'visible' 的独立节点，让用户等待期间知道「通知没丢，只是被压住了」。
 *
 * 视觉与「插件介入」行（parts/nudge-row.ts）同款：同一套 CSS 变量与布局。
 *
 * @module dsh-harden/client-progress-row
 */

import { createElement } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { IconShieldOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { translateZh } from '../locales'
import type { PlatformTranslate } from '../locales'

/** 本行拿到的会话节点（只声明用到的字段）。 */
export interface ProgressRowNode {
    kind: string
    /** 本会话累计压住的结算通知条数（文案里的 N）。 */
    data: { count: number }
}

/** 渲染器属性（node 与 t 都由平台 renderSlot 注入）。 */
export interface ProgressRowProps {
    node: ProgressRowNode
    t?: PlatformTranslate
}

/** 拿不到平台 `t` 时的中文兜底（模块级：每次渲染新建引用会让子组件白白重渲）。 */
const FALLBACK_T: PlatformTranslate = translateZh()

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
 * 渲染一行「子代理结算通知已暂存」提示。
 *
 * @param props - 平台注入的会话节点与翻译函数。
 */
export function ProgressRow(props: ProgressRowProps): ReactElement {
    const t = props.t ?? FALLBACK_T

    return createElement(
        'div',
        { style: ROW, role: 'note' },
        createElement('span', { style: GLYPH }, createElement(IconShieldOutlineRegular, { size: 13 })),
        createElement('span', { style: TEXT }, t('progress.held', { p1: props.node.data.count })),
    )
}
