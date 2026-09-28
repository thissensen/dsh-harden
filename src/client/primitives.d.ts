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
    import type { ButtonHTMLAttributes, InputHTMLAttributes, KeyboardEventHandler, ReactElement, ReactNode } from 'react'

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

    /**
     * 居中对话框（portal 到 body）。
     *
     * 非 headless 模式渲染默认头部与关闭按钮，此时 closeLabel 必填（无障碍名）；
     * headless: true 时头部整块由调用方自绘，closeLabel 不再需要。
     */
    export type ModalProps = {
        open: boolean
        onClose: () => void
        title: string
        description?: string
        children?: ReactNode
        footer?: ReactNode
        className?: string
        contentClassName?: string
        onKeyDownCapture?: KeyboardEventHandler<HTMLDivElement>
        backdropBlur?: boolean
        shortcutModal?: string
    } & (
        | { headless: true; closeLabel?: never }
        | { headless?: false; closeLabel: string }
    )
    export const Modal: (props: ModalProps) => ReactElement | null

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
}
