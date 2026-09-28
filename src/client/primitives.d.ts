/**
 * `@deepseek-ai/dsh-client-ui-primitives` 的自备类型声明。
 *
 * **为什么自备。** 这个包在 link 装法下不会进本项目的 `node_modules`（运行态由平台的
 * ModuleLoader 从 seed 表解析，构建侧已在 `vite.shared.ts` 的 EXTERNAL_MODULES 里列为
 * external），而 `tsconfig.client.json` 又是 `"types": []`（不自动加载 @types）。于是
 * `import … from '@deepseek-ai/dsh-client-ui-primitives'` 在 typecheck 时解析不到类型。
 *
 * 这里只声明本项目用到的几个成员，形状照官方产物的真实 props 抄一份，够用即可。
 * 与 `globals.d.ts` 同纪律：不 import 平台包的类型入口，只声明实际用到的部分。
 *
 * @module dsh-harden/client-primitives-types
 */

declare module '@deepseek-ai/dsh-client-ui-primitives' {
    import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactElement, ReactNode } from 'react'

    /** 按钮：`icon` 是可选的行首图标节点；其余原生 button 属性透传。 */
    export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
        variant?: 'primary' | 'ghost' | 'outline' | 'toolbar'
        size?: 'md' | 'sm'
        icon?: ReactNode
        className?: string
        children?: ReactNode
    }
    export const Button: (props: ButtonProps) => ReactElement

    /** 开关：完全受控；`label` 是无障碍名，必须由调用方给本地化文案。 */
    export interface SwitchProps {
        checked: boolean
        onChange: (next: boolean) => void
        label: string
        disabled?: boolean
        title?: string
        className?: string
    }
    export const Switch: (props: SwitchProps) => ReactElement

    /** 文本输入框：`icon` 是可选的 16px 行首图标节点，其余原生 input 属性透传。 */
    export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
        icon?: ReactNode
        className?: string
    }
    export const Input: (props: InputProps) => ReactElement

    /** 图标：真实实现只吃 `size` 与 `className`（`style` 会被忽略，要布局得外面包一层）。 */
    export interface IconProps {
        size?: number
        className?: string
    }
    export const IconShieldOutlineRegular: (props: IconProps) => ReactElement
    export const IconQuestionOutlineRegular: (props: IconProps) => ReactElement
    export const IconRefreshOutlineRegular: (props: IconProps) => ReactElement

    /** 悬停提示：把气泡挂在单个锚点元素上（锚点自己的事件会被链在提示的处理器之后）。 */
    export interface TooltipProps {
        label: string | (() => string)
        side?: 'right' | 'bottom' | 'top'
        align?: 'center' | 'end'
        delayMs?: number
        gap?: number
        disabled?: boolean
        portal?: boolean
        maxWidth?: number
        children: ReactElement
    }
    export const Tooltip: (props: TooltipProps) => ReactElement

    /**
     * 下拉菜单（平台没有原生 select，下拉一律用它 + 自绘锚点）。
     *
     * 受控：`open` 由调用方管；行选中与关闭各回调一次。`selectedId` 给选中行打勾，
     * `side` / `portal` 控制弹出方向与是否 portal 到 body。
     */
    export interface MenuItem {
        id: string
        label: ReactNode
        disabled?: boolean
        danger?: boolean
        submenu?: readonly MenuItem[]
    }
    export interface MenuSeparator {
        type: 'separator'
        id: string
    }
    export interface MenuLabel {
        type: 'label'
        id: string
        text: string
    }
    export type MenuEntry = MenuItem | MenuSeparator | MenuLabel
    export interface MenuProps {
        open: boolean
        autoFocus?: boolean
        anchor: ReactNode
        items?: readonly MenuEntry[]
        children?: ReactNode
        footer?: readonly MenuEntry[]
        selectedId?: string
        selectedIds?: readonly string[]
        onSelect?: (id: string) => void
        onClose: () => void
        align?: 'start' | 'end'
        side?: 'bottom' | 'top' | 'right'
        portal?: boolean
        closeOnPointerLeave?: boolean
        dense?: boolean
        compact?: boolean
        selection?: 'check' | 'fill'
        getAnchorRect?: () => DOMRect | null
        className?: string
        listClassName?: string
    }
    export const Menu: (props: MenuProps) => ReactElement

    /** 下拉锚点尾部那只朝下的箭头（展开时由调用方换向上箭头，这里只声明两只）。 */
    export const IconChevronDownOutlineRegular: (props: IconProps) => ReactElement
    export const IconChevronUpOutlineRegular: (props: IconProps) => ReactElement

    /** 平台「下拉锚点」常用的菜单面板外壳（本项目未用到，声明留给后续）。 */
    export interface MenuSurfaceProps extends HTMLAttributes<HTMLDivElement> {
        compact?: boolean
    }
    export const MenuSurface: (props: MenuSurfaceProps) => ReactElement
}
