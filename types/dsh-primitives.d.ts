/**
 * `@deepseek-ai/dsh-client-ui-primitives` 的自备类型。
 *
 * 为什么自备：该包运行态**没有**类型声明——package.json 的 `types` 指向
 * `lib/types/index.d.ts`，而那个目录在本机产物里并不存在。这里按官方源码
 * `packages/client/ui-primitives/src/*.tsx` 的真实 props 抄一份，够用即可，
 * 不追全量（图标、Markdown、JsonTree 等本项目用不到的部分不列）。
 *
 * 与官方的一处**有意放宽**：`DisclosureRow.title` 官方写 `string`，但实现里
 * 是直接当行内容渲染的 ⇒ 塞节点运行时合法，这里放宽成 `ReactNode`，
 * 好把「▾ ☑ 分组名 3/12」这种组头塞进去（方案见交接文档 §3.5）。
 */

declare module '@deepseek-ai/dsh-client-ui-primitives' {
    import type {
        ButtonHTMLAttributes,
        HTMLAttributes,
        InputHTMLAttributes,
        ReactElement,
        ReactNode,
    } from 'react'

    export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
        variant?: 'primary' | 'ghost' | 'outline' | 'toolbar'
        size?: 'md' | 'sm'
        icon?: ReactNode
        className?: string
        children?: ReactNode
    }
    export const Button: (props: ButtonProps) => ReactElement

    export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
        icon?: ReactNode
        className?: string
    }
    export const Input: (props: InputProps) => ReactElement

    export interface ModalProps {
        open: boolean
        onClose: () => void
        title: string
        description?: string
        children?: ReactNode
        footer?: ReactNode
        className?: string
        contentClassName?: string
    }
    /** 非 headless 时 `closeLabel` 必填（无障碍名）；headless 时不接受它。 */
    export type ModalComponentProps = ModalProps &
        ({ headless: true; closeLabel?: never } | { headless?: false; closeLabel: string })
    export const Modal: (props: ModalComponentProps) => ReactElement

    export interface HoverCardProps {
        anchor: ReactNode
        content: ReactNode
        openDelayMs?: number
        disabled?: boolean
        copyText?: string
        copyLabel: string
        copiedLabel: string
    }
    export const HoverCard: (props: HoverCardProps) => ReactElement

    export interface SwitchProps {
        checked: boolean
        onChange: (next: boolean) => void
        label: string
        disabled?: boolean
        title?: string
        className?: string
    }
    export const Switch: (props: SwitchProps) => ReactElement

    export interface TagProps extends HTMLAttributes<HTMLSpanElement> {
        tone?: 'outline' | 'solid' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger'
        className?: string
        children?: ReactNode
    }
    export const Tag: (props: TagProps) => ReactElement

    export interface PillProps extends ButtonHTMLAttributes<HTMLButtonElement> {
        active?: boolean
        className?: string
        children?: ReactNode
    }
    export const Pill: (props: PillProps) => ReactElement

    /**
     * 勾选框：`input` + 可见文字一起包进 `<label>`，**只解构 6 个 props**
     * （`checked / onChange / label / disabled / title / className`），没有 `...rest`
     * ⇒ `style` 传不进去（同下文图标那节），要参与 flex 布局就在外面包一层带样式的元素。
     * `label` 必填、且是**它自己渲染的那层 span**——点文字即切换，但名字进去就丢样式
     * 控制权（`ellipsis` 拿不回）⇒ **要「名字可缩 + 出省略号」的行别用它装名字**，
     * 改「锁 16px 宽的壳 + 自绘名字 span」（把平台那层 span 的 6px gap 与空标签裁掉）。
     */
    export interface CheckboxProps {
        checked: boolean
        onChange: (next: boolean) => void
        label: string
        disabled?: boolean
        title?: string
        className?: string
    }
    export const Checkbox: (props: CheckboxProps) => ReactElement

    export interface DisclosureRowProps {
        icon: ReactNode
        /** 官方类型是 `string`；实现里当行内容渲染，这里放宽成节点，见文件头注释。 */
        title: ReactNode
        open: boolean
        expandable: boolean
        onToggle: () => void
        expandOnRowClick?: boolean
        previewChevron?: boolean
        keepContentWhenOpen?: boolean
        collapsedContent?: ReactNode
        children?: ReactNode
        className?: string
        rowClassName?: string
        leadingClassName?: string
        chevronClassName?: string
        titleClassName?: string
    }
    export const DisclosureRow: (props: DisclosureRowProps) => ReactElement

    export interface MenuItem {
        id: string
        label: ReactNode
        disabled?: boolean
        icon?: ReactNode
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
        items: readonly MenuEntry[]
        footer?: readonly MenuEntry[]
        selectedId?: string
        selectedIds?: readonly string[]
        onSelect: (id: string) => void
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
    }
    export const Menu: (props: MenuProps) => ReactElement

    export interface StateDotProps {
        state: 'done' | 'warning' | 'ongoing' | 'error' | 'idle'
        size?: number
        className?: string
    }
    export const StateDot: (props: StateDotProps) => ReactElement

    /**
     * 图标组件（只列本项目用到的）。真实实现是 `({ size = 14, className }) => <svg …>`：
     * **只吃 size 与 className**，`style` 会被忽略 ⇒ 要参与 flex 布局得自己在外面
     * 包一层带样式的 span。
     */
    export interface IconProps {
        size?: number
        className?: string
    }
    /**
     * 图标名照真实包写（`lib/types/icons/index.d.ts` 里是 `…OutlineRegular / …OutlineMedium`
     * 这一套，没有数字后缀的「…14」形态）。名字写错不会让 `vite build` 失败——它把
     * primitives 当 external、不做导出校验——只有 `pnpm typecheck` 会红。
     */
    export const IconChevronDownOutlineRegular: (props: IconProps) => ReactElement
    export const IconChevronUpOutlineRegular: (props: IconProps) => ReactElement
}
