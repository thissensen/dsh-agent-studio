/**
 * 通用小件与各组件共用的 `h`：单选 / 卡片 / 字段行 / 上下移动与表单按钮 / 问号浮层 / 候选行。
 *
 * @module dsh-agent-studio/client-parts/panel-widgets
 */
import * as React from 'react'
import { createPortal } from 'react-dom'
import type { ReactElement, ReactNode } from 'react'
import { Button, IconChevronDownOutlineRegular, IconChevronUpOutlineRegular, useAnchoredPosition } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CopyKey, Translate } from '../locales'
import type { BackgroundMode, ToolPresentation } from '../../host/types'
import {
    STYLE,
    FIELD_LABEL,
    HELP_ANCHOR,
    HELP_ANCHOR_FLEX,
    HELP_CARD,
    HELP_CARD_WIDE,
    ROW_TAIL,
} from '../styles'
import type {
    ChoiceProps,
    ConfigCardProps,
    MenuAnchorProps,
    HelpTipProps,
    FieldRowProps,
    MoveButtonsProps,
    FormButtonsProps,
    CandidateRowProps,
} from './panel-types'

const { useEffect, useRef, useState } = React

export const h = React.createElement

/** 子代理后台模式。映射到官方派活语义，仅被当子代理时生效。 */
/** 选项数组都带上显式元素类型：否则 `Choice` 的泛型会从字面量推成 `string`，丢掉值域。 */
/** `labelKey` 而不是文案：这两排是模块级常量，`t` 到渲染时才拿得到。 */
export const BACKGROUND_MODES: { id: BackgroundMode; labelKey: CopyKey }[] = [
    { id: 'always-background', labelKey: 'background.always' },
    { id: 'foreground', labelKey: 'background.foreground' },
    { id: 'model-decides', labelKey: 'background.modelDecides' },
]

/** Agent 模式三档（id 与 host 侧 `TOOL_PRESENTATIONS` 同一套；文案见字典）。 */
export const TOOL_PRESENTATIONS: { id: ToolPresentation; labelKey: CopyKey }[] = [
    { id: 'follow', labelKey: 'presentation.follow' },
    { id: 'native', labelKey: 'presentation.native' },
    { id: 'ptc', labelKey: 'presentation.ptc' },
]

/** 把带 `labelKey` 的选项表翻成 `Choice` 要的 `label`。 */
export function choiceOptions<T extends string>(options: { id: T; labelKey: CopyKey }[], t: Translate): { id: T; label: string }[] {
    return options.map((option) => ({ id: option.id, label: t(option.labelKey) }))
}

// ── 小控件 ──────────────────────────────────────────────────────────────

/**
 * 一组互斥单选（后台模式用）。
 * @param props - `{ options, value, onChange }`。
 */
export function Choice<T extends string>(props: ChoiceProps<T>) {
    const { options, value, onChange } = props

    return h('span', { style: { display: 'inline-flex', gap: '4px' } },
        options.map((option) => {
            const style = option.id === value ? { ...STYLE.tab, ...STYLE.tabActive } : STYLE.tab

            return h('button', {
                key: option.id,
                type: 'button',
                onClick: () => onChange(option.id),
                style,
            }, option.label)
        }))
}

/**
 * 一张配置卡片：标题 + 说明 + 内容。面板里那几张卡片都是这三段，
 * 抽出来之后改版式只改这一处。
 * @param props - `{ title, hint, children }`；`hint` 可省。
 */
export function ConfigCard(props: ConfigCardProps) {
    const { title, hint, disabled, children } = props

    return h('div', { style: { ...STYLE.card, ...(disabled === true ? { opacity: 0.55 } : {}) } }, [
        h('div', { key: 'title', style: STYLE.cardTitle }, title),
        hint === undefined ? null : h('div', { key: 'hint', style: STYLE.hint }, hint),
        children,
    ])
}

/**
 * 把「一个元素或一组元素」统一成数组。
 *
 * `FieldRow` 用它把 children 摊平后再展开传给 `h()`：自检脚本的定位器
 * （形如 `.children.flat()`）只摊一层，多套一层数组它就找不到里面的控件了。
 */
export function itemsOf(value: ReactNode): ReactNode[] {
    return Array.isArray(value) ? value : [value]
}

// ── 菜单锚点 ────────────────────────────────────────────────────────────
/**
 * 菜单触发器的统一锚点按钮：文字 + 尾部 chevron。
 *
 * 为什么不用最省事的默认 `Button`（ghost）：它在设置页的卡片底色上就是一段
 * 纯文本，用户会当成标签而不是下拉（第十八轮用户反馈，并点名参照社区插件
 * DSH-better-sidebar 的 selectAnchor——有边框、有底、尾部带 chevron）。
 * 这里取平台唯一「有边框」的 `outline` 变体打底（hover 反馈由它自带），
 * 只把圆角收到 8px 与旁边的 `Input` 对齐观感。
 *
 * 宽度交给所在的 `FieldRow` 控件槽：槽的 grid stretch 会把 `Menu` 的根壳（`span`，
 * `inline-flex`）拉满，但壳里的锚点自己是 `flex: 0 1 auto` ⇒ 还得 `width: 100%`
 * 才能跟着填满（真机量过：不加就是内容宽的一块，撑不到右缘）。由此也不设 `maxWidth`。
 * `space-between` 让文字顶左、chevron 顶右——撑满之后就是下拉框该有的样子
 * （Button 默认的 `justify-content: center` 会把「文字+箭头」整体摆中间）。
 *
 * chevron 包一层 `flex: none` 的 span：平台图标组件只吃 `size`/`className`，
 * 不接受 `style`，直接放会跟着文字一起被压。
 *
 * @param props - `{ open, text, disabled, onClick }`；`open` 只影响 chevron 朝向。
 */
export function menuAnchor(props: MenuAnchorProps): ReactElement {
    const { open, text, disabled, onClick } = props

    return h(Button, {
        type: 'button',
        variant: 'outline',
        disabled,
        onClick,
        style: STYLE.menuAnchor,
    }, [
        h('span', {
            key: 'text',
            style: { display: 'block', minWidth: '0', ...STYLE.ellipsis },
        }, text),
        h('span', {
            key: 'caret',
            style: { display: 'inline-flex', flex: 'none', color: 'var(--dsw-alias-label-tertiary)' },
        }, h(IconChevronDownOutlineRegular, { size: 12 })),
    ])
}

/**
 * 问号悬浮卡：hover 500ms 后弹出的一段说明（只读）。
 *
 * **为什么不用平台的 `HoverCard`**（它本来是最省事的选择）：它的卡片
 * `z-index: 100` 是组件库内写死的，而宿主设置页是一层 `z-index: 1000` 的全屏
 * 弹层 ⇒ 卡片永远落在设置页**背后**，发暗、看不全（2026-09-17 真机截图取证）。
 * 它不接受 `className`/`style`，插件侧补不了层级，所以这里按同一份视觉抄一个：
 * 244px 宽、12px 圆角、`#2C2C2E` 底、阴影 lv3；层级取平台「菜单 portal」的
 * 1100（`Menu.module.css` 的注释：弹窗内的浮层也必须盖在弹窗之上）。
 *
 * 行为与平台一致：针停在锚点 500ms 才开（防误触），移开即关；卡片挂到 body，
 * 指针可以移到卡片上。
 *
 * @param props - `{ text }`：说明正文；锚点固定是行内的「?」圆标。
 */
export function HelpTip(props: HelpTipProps): ReactElement {
    const { text, children, size = 'default' } = props
    const [open, setOpen] = useState(false)
    const anchorRef = useRef<HTMLSpanElement | null>(null)
    const cardRef = useRef<HTMLDivElement | null>(null)
    const timerRef = useRef<number | null>(null)
    const closeTimerRef = useRef<number | null>(null)

    function clearOpenTimer() {
        if (timerRef.current !== null) {
            window.clearTimeout(timerRef.current)
            timerRef.current = null
        }
    }

    function clearCloseTimer() {
        if (closeTimerRef.current !== null) {
            window.clearTimeout(closeTimerRef.current)
            closeTimerRef.current = null
        }
    }

    function scheduleOpen() {
        clearCloseTimer()
        if (open) return

        clearOpenTimer()
        timerRef.current = window.setTimeout(() => setOpen(true), 500)
    }

    function scheduleClose() {
        clearOpenTimer()
        clearCloseTimer()
        closeTimerRef.current = window.setTimeout(() => setOpen(false), 120)
    }

    // 定位用平台的 `useAnchoredPosition`（与平台浮层同一套几何）：跟随滚动、跟随卡片
    // 自身尺寸变化，并把结果夹在视口内。它只支持上下两个方向 ⇒ 卡片落在锚点下方、右对齐。
    const pos = useAnchoredPosition({
        open,
        anchorRef,
        panelRef: cardRef,
        side: 'bottom',
        align: 'end',
        gap: 8,
        margin: 8,
    })

    // 卸载时把两个定时器清掉（面板随时可能被折叠/切走）。
    useEffect(() => () => {
        clearOpenTimer()
        clearCloseTimer()
    }, [])

    const anchor = h('span', {
        // Fragment 的两个子项按数组渲染 ⇒ 都要 key（同类问题见 `FieldRow` 的 children）。
        key: 'anchor',
        ref: anchorRef,
        onPointerEnter: () => scheduleOpen(),
        onPointerLeave: () => scheduleClose(),
        style: children === undefined ? HELP_ANCHOR : HELP_ANCHOR_FLEX,
    }, children ?? '?')

    if (!open) return anchor

    const card = h('div', {
        ref: cardRef,
        style: {
            ...(size === 'wide' ? HELP_CARD_WIDE : HELP_CARD),
            ...(pos === null ? { visibility: 'hidden' } : pos),
        },
        onPointerEnter: () => clearCloseTimer(),
        onPointerLeave: () => scheduleClose(),
    }, text)

    return h(React.Fragment, null, [anchor, createPortal(card, document.body, 'card')])
}

/**
 * 字段行：「左标签 + 右控件」那一行。面板里凡是要对齐的输入行都走它，
 * 标签样式（`FIELD_LABEL`）与行的排布因此只有一处定义。
 *
 * **控件槽占满剩余宽度、右缘顶齐卡片**（2026-09-18 用户反馈「有的长有的短不好看」）。
 * 槽是单行 `grid`：靠 grid item 的默认 `stretch`，任何 `width: auto` 的子项都会被
 * 拉满轨道。之所以不用 flex 直接排——平台 `Input` 的外壳（`span`）是 `inline-flex`
 * 且只吃 `className`、不吃 `style`（`style` 会落到内层 `<input>` 上），在 flex 行里
 * 没法从外面让它伸展；grid 的 stretch 不看组件内部实现，照样拉满。
 *
 * 主控件区（`children`）：一个 ⇒ 撑满（`1fr`）；多个 ⇒ 各自自然宽（都撑满就并排
 * 抢空间了）。行尾的按钮对（「修改」「确定/取消」）一律走 `tail`——自然宽、顶到最右。
 *
 * @param props - `{ label, style, tail, children }`：`style` 是给这一行的额外样式
 *   （如 `marginTop`）；`children` 是主控件；`tail` 是行尾附加项（可选）。
 */
export function FieldRow(props: FieldRowProps) {
    const { label, style, tail, children } = props
    const items = itemsOf(children)
    const tails = tail === undefined ? [] : itemsOf(tail)

    const main = items.length === 1
        ? 'minmax(0, 1fr)'
        : items.map(() => 'minmax(0, auto)').join(' ')
    const template = tails.length === 0 ? main : `${main} auto`

    return h('div', { style: style === undefined ? STYLE.row : { ...STYLE.row, ...style } }, [
        // `key: 'label'` 是自检脚本认「这一行有标签」的锚点，别改。
        h('span', { key: 'label', style: FIELD_LABEL }, label),
        h('div', {
            key: 'controls',
            style: {
                flex: '1 1 auto',
                minWidth: 0,
                display: 'grid',
                gridTemplateColumns: template,
                alignItems: 'center',
                gap: '8px',
            },
        }, [
            ...items,
            tails.length === 0
                ? null
                : h('div', {
                    key: 'tail',
                    style: { display: 'flex', alignItems: 'center', gap: '8px' },
                }, tails),
        ]),
    ])
}

/**
 * 「上移 / 下移」按钮对：段行、集装载行与备用候选三处的逐字级重复（连首尾禁用的
 * 算法都一样）。
 *
 * 返回**元素数组**而不是组件：它在父行的 flex 里必须直接当子项。
 * 一对箭头**自成一组**（外层 `span` 带 `ROW_TAIL`、组内 gap 收到 2px）——
 * 用户点名「箭头之间再小点」：原来两个箭头各占一个父行 gap（8px），
 * 现在整组只占一个，组内也更紧。图标改用平台 chevron（`↑`/`↓` 字符有缺字形的
 * 风险，同「展开箭头」那条）；图标没有文本 ⇒ **无障碍名必须给 `aria-label`**，
 * 与同一排的「展开」按钮取同一档 12px，大小才齐。
 *
 * @param props - `{ isTop, isBottom, onMove }`：`onMove(delta)` 收到 -1 / +1。
 * @param t - 翻译器（两个按钮的无障碍名）。
 */
export function moveButtons(props: MoveButtonsProps, t: Translate): ReactElement[] {
    const { isTop, isBottom, onMove } = props

    return [
        h('span', { key: 'move', style: { display: 'inline-flex', gap: '2px', ...ROW_TAIL } }, [
            h(Button, {
                key: 'up',
                type: 'button',
                size: 'sm',
                'aria-label': t('common.moveUp'),
                onClick: () => onMove(-1),
                disabled: isTop,
            }, h(IconChevronUpOutlineRegular, { key: 'icon', size: 12 })),
            h(Button, {
                key: 'down',
                type: 'button',
                size: 'sm',
                'aria-label': t('common.moveDown'),
                onClick: () => onMove(1),
                disabled: isBottom,
            }, h(IconChevronDownOutlineRegular, { key: 'icon', size: 12 })),
        ]),
    ]
}

/**
 * 「确定 / 取消」按钮对。同样返回元素数组（理由同 `moveButtons`）。
 *
 * @param props - `{ okText, okDisabled, onOk, onCancel }`。
 * @param t - 翻译器（「取消」是这里自己的文案）。
 */
export function formButtons(props: FormButtonsProps, t: Translate): ReactElement[] {
    const { okText, okDisabled, onOk, onCancel } = props
    const disabled = okDisabled === true

    return [
        h(Button, {
            key: 'ok',
            type: 'button',
            variant: 'primary',
            onClick: onOk,
            disabled,
        }, okText),
        h(Button, { key: 'cancel', type: 'button', onClick: onCancel }, t('common.cancel')),
    ]
}

/**
 * 候选行（「可装载：+ xxx」）：集装载区与子代理名册两处的逐字级重复。
 *
 * @param props - `{ label, items, onPick }`：`items` 是 `[{ id, label, title }]`，
 *   `onPick(id)` 收到点中的那个 id；空清单整行不画。
 */
export function CandidateRow(props: CandidateRowProps): ReactElement | null {
    const { label, items, onPick } = props
    if (items.length === 0) return null

    return h('div', { key: 'candidates', style: { ...STYLE.row, marginTop: '4px' } }, [
        h('span', { key: 'label', style: STYLE.hint }, label),
        ...items.map((item) => h(Button, {
            key: item.id,
            type: 'button',
            size: 'sm',
            style: ROW_TAIL,
            onClick: () => onPick(item.id),
            title: item.title,
        }, `+ ${item.label}`)),
    ])
}
