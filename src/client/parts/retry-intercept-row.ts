/**
 * 「重试链已修正」提示行：会话回合尾部一行浅色小字，说明本回合的重试链被插件归一过。
 *
 * **为什么走插槽。** host 侧的重试链写入拦截器（`src/host/retry-intercept.ts`）在重试事件落盘
 * 前改写违反平台不变量的字段——它写的是**平台自己的事件类型**（`llm/retry` / `llm/retry-started`），
 * 插件没有自己的事件可挂。往会话流里插自定义事件会威胁「会话能不能打开」（会话事件类型表是平台
 * 硬编码白名单，见 `.harness/05-坑册.md`），所以提示不做成会话节点，改走平台插槽
 * `conversation.chat.turnTail`——它与 `conversation.chat.node` 是两套东西：节点按会话事件投影，
 * 插槽是平台渲染回合尾部时现取的组件，插件只贡献一行、不往会话里写任何东西。
 * 插槽给的 `turn` 不是数字，是平台的回合位置对象（回合号在 `turn.turn`），由 `取回合号()` 取号。
 *
 * **数据从哪来。** 修正是 host 进程内存里的一张账（`GET /api/dsh-harden/retry-intercepts?session=`），
 * 组件挂载时与位置变化时拉一次，按当前回合号数出 N。拉取失败 / 403 / 形状不符一律静默：
 * **不显示、不影响会话渲染**——这行是锦上添花，坏了不能拖累聊天。
 *
 * 视觉与「插件介入」行（parts/nudge-row.ts）、「子代理通知暂存」行（parts/progress-row.ts）同款：
 * 同一套 CSS 变量与布局。
 *
 * @module dsh-harden/client-retry-intercept-row
 */

import { createElement, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { IconShieldOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { translateZh } from '../locales'
import type { PlatformTranslate } from '../locales'
import { 取回合号, 统计回合修正数, 读记录组 } from '../retry-intercept-match'

/** 拦截记录端点：会话 id 走 query；GET 不需要自定义头（写围栏只管写请求）。 */
const INTERCEPTS_ENDPOINT = '/api/dsh-harden/retry-intercepts'

/** 同一会话两次拉取之间的最小间隔：回合推进会让本组件频繁重渲，别把界面刷爆。 */
const 重拉间隔毫秒 = 1000

/**
 * 平台插槽给的回合位置（`TurnLocation` 的本地声明，只留本组件用到的那一格）。
 *
 * client 侧不 import 宿主包，平台类型一律自备（同 `primitives.d.ts` 的纪律）。
 */
interface 回合位置 {
    /** 回合号——平台的 `TurnLocation.turn`。 */
    turn?: unknown
}

/**
 * 渲染器属性：`turn` / `seq` 由平台 renderSlot 注入（`turn` 是位置对象，不是数字），
 * 会话 id 有两条来源（见各字段注释）。
 */
export interface RetryInterceptRowProps {
    /** 当前会话 id（会话作用域插槽的标准座席）。 */
    sessionId?: string
    /** 当前会话 id（注册处 `inject` 注入的官方面，标准座席为空时兜底）。 */
    注入会话ID?: string
    /** 本行所属的回合位置（对象）；位置不是回合/步时平台不传这一格。 */
    turn?: 回合位置
    /** 回合尾部当前的会话序号：随回合推进变化，用它触发重拉。 */
    seq: number
    /** 平台绑定的翻译函数。 */
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
 * 渲染一行「插件介入：平台重试链序号已修正（本回合 N 处）」。
 *
 * @param props - 平台注入的会话 id、回合位置与翻译函数。
 */
export function RetryInterceptRow(props: RetryInterceptRowProps): ReactElement | null {
    // 会话 id 的两条来源都是平台官方面：会话作用域的标准座席 props.sessionId 未经真机验证
    // （平台不灌这一格，这行就永远静默不显示），故注册处再用官方 inject 面注入一份
    // props.注入会话ID 兜底；两条都空就不显示（拉取效果体里排空，不抛）。
    let sessionId = props.sessionId
    if (sessionId === undefined || sessionId === '') sessionId = props.注入会话ID

    // 插槽给的是回合位置对象（回合号在 turn.turn），拿不到数字 = 本回合没有可显示的东西。
    const 回合号 = 取回合号(props.turn)
    const seq = props.seq
    const t = props.t ?? FALLBACK_T

    // null = 还没数出结果（没拉过 / 拉失败 / 本回合没有修正），此时不渲染。
    const [本回合修正处数, set本回合修正处数] = useState<number | null>(null)
    const 上次拉取时刻 = useRef(0)
    const 拉取中 = useRef(false)
    // 「当前会话 id」的准星：换会话时上一会话的 fetch 可能还在途，靠它认出那份过期的回包。
    const 当前会话ID = useRef(sessionId)
    // 「当前回合号」的准星：同一个会话里换回合时（提示行插槽按位置重建、平台也可能复用实例），
    // 上一回合的 fetch 也可能还在途——会话 id 没变，只看会话 id 认不出它，得再靠这一格认。
    const 当前回合号 = useRef(回合号)

    // 换会话时平台若复用同一个组件实例，上一会话的「已修正 N 处」会挂到新会话上（显示假信息），
    // 上一会话的 1 秒节流还会吃掉新会话的第一次拉取——节流账、准星与处数一起清。
    useEffect(() => {
        当前会话ID.current = sessionId
        上次拉取时刻.current = 0
        拉取中.current = false
        set本回合修正处数(null)
    }, [sessionId])

    // 换回合同理：这个数字只属于某一个 (会话, 回合) 组合，新回合没拉到数据前不能沿用旧值；
    // 准星跟着回合走——在途的那份上一回合回包要靠它认出来（比对在下面 load() 里）。
    useEffect(() => {
        当前回合号.current = 回合号
        set本回合修正处数(null)
    }, [回合号])

    useEffect(() => {
        // 两条来源都空就没法查记录：这行是锦上添花，静默不显示即可。
        if (sessionId === undefined || sessionId === '') return
        // 拿不到回合号（平台没给这一格 / 声明变了）就数不了本回合：同样静默不显示。
        if (回合号 === null) return

        const now = Date.now()
        const 距上次拉取 = now - 上次拉取时刻.current
        // 自我节流：同一会话至少间隔 1 秒才重拉。被节流跳过的这一次不排重试——回合
        // 还在走，下一次位置变化就会带着最新记录回来（实时性换界面压力，够用即可）。
        if (拉取中.current || 距上次拉取 < 重拉间隔毫秒) return

        上次拉取时刻.current = now
        拉取中.current = true

        /**
         * 拉一次拦截记录并把本回合的修正处数交给界面；任何失败都静默（不显示、不抛）。
         *
         * @param 会话ID - 当前会话 id（已在效果体内排空，这里按普通参数接收）。
         * @param 取数回合号 - 取数时的回合号（闭包里读不到效果体里收窄过的 `回合号`）。
         */
        async function load(会话ID: string, 取数回合号: number): Promise<void> {
            try {
                const 响应 = await fetch(`${INTERCEPTS_ENDPOINT}?session=${encodeURIComponent(会话ID)}`)
                const 数据 = (await 响应.json()) as { ok?: unknown; 记录组?: unknown };
                if (数据?.ok !== true) return

                // 这一份回包属于发起时那个会话：会话已经换掉就丢弃，别把上一会话的修正处数
                // 写进新会话（换会话时上一会话的 fetch 仍在途，回包会落在重置之后）。
                if (会话ID !== 当前会话ID.current) return

                // 同会话内换回合也一样：上一回合的 fetch 仍在途，回包会把上一回合的处数写进
                // 新回合的视图（显示假信息）——准星已经不是发起时那个回合号，就丢弃这次回包。
                if (取数回合号 !== 当前回合号.current) return

                // 数据没变不 setState：平台对同一值不做无谓重渲，免得白刷一轮。
                const 处数 = 统计回合修正数(读记录组(数据.记录组), 取数回合号)
                set本回合修正处数((上次) => (上次 === 处数 ? 上次 : 处数))

            } catch (err) {
                // 本行是锦上添花：拉不到就不显示，绝不打断会话渲染。
                console.debug('[harden] 拦截记录拉取失败，本行不显示', err)

            } finally {
                拉取中.current = false
            }
        }

        load(sessionId, 回合号)
    }, [sessionId, 回合号, seq])

    // 拿不到回合号 = 本回合没有可显示的东西；处数还没数出来（没拉过 / 拉失败）也都不渲染。
    if (回合号 === null) return null
    if (本回合修正处数 === null || 本回合修正处数 === 0) return null

    return createElement(
        'div',
        { style: ROW, role: 'note', 'aria-label': t('retryIntercept.rowAria') },
        createElement('span', { style: GLYPH }, createElement(IconShieldOutlineRegular, { size: 13 })),
        createElement('span', { style: TEXT }, t('retryIntercept.corrected', { p1: 本回合修正处数 })),
    )
}
