/**
 * 控件形态的样式：预设 Tab、左栏项、多行输入框、菜单锚点，以及字段行标签。
 *
 * 都是「平台控件之外我们自己画的那几类小件」——形态集中在这儿，改一处全变。
 *
 * @module dsh-agent-studio/client-parts/styles/control
 */
import type { CSSProperties } from 'react'
import { CLEAR_BUTTON, HINT, SELECTED_FACE } from './basis'

/**
 * 「左标签右控件」那一行的标签（与 `FieldRow` 配套）。
 *
 * 宽度**内容自适应**，不设固定槽：曾经写死 `minWidth: '84px'`，而「id」两个字
 * 只占 11px ⇒ 左边白留 73px 空档，输入框离标签老远（winform 里对应 AutoSize）。
 * 以后要调标签宽度，只改这一处常量。
 */
export const FIELD_LABEL: CSSProperties = { ...HINT }

export const CONTROL = {
    tab: {
        ...CLEAR_BUTTON,
        padding: '0.3em 0.9em',
        borderRadius: '999px',
    },
    tabActive: SELECTED_FACE,
    navItem: {
        ...CLEAR_BUTTON,
        display: 'block',
        width: '100%',
        padding: '0.45em',
        borderRadius: '0.45em',
        textAlign: 'left',
    },
    navItemActive: SELECTED_FACE,
    // `<select>` 那一档已换平台 `Menu`，它的原生外观问题随之消失。
    textarea: {
        outline: 'none',
        width: '100%',
        minHeight: '5.4em',
        padding: '0.45em',
        border: '1px solid rgba(127,127,127,0.45)',
        borderRadius: '0.3em',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        resize: 'vertical',
    },
    // 菜单触发器（`menuAnchor`）的基底：文字顶左、chevron 顶右，宽度跟着字段槽撑满。
    menuAnchor: {
        borderRadius: '0.6em',
        gap: '0.45em',
        justifyContent: 'space-between',
        width: '100%',
        boxSizing: 'border-box',
    },
    // 清单树（工具 / 技能）的组头行：自绘，不用平台 `DisclosureRow`——平台件展开态
    // 固定画「下箭头」、收起态在没给 `icon` 时干脆不画（悬停才浮出一个下箭头），
    // 与面板「展开朝上 / 收起朝下」的约定相反（2026-09-19 用户报「收起后箭头消失、
    // 看着全是下箭头」）。尺寸照抄平台行：24px 行高、标题走 secondary 档字号与次级色
    // ——二级行的 `TREE_INDENT`（22px = 16px 图标槽 + 6px 隙）据此仍与组头勾选框同一条竖线。
    groupRow: {
        display: 'flex',
        alignItems: 'center',
        height: 'calc(24px + var(--dsh-content-font-delta, 0px))',
        fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
        color: 'var(--dsw-alias-label-secondary)',
    },
    // 组头的折叠开关：16px 图标槽（与平台 `.leading` 同尺寸），箭头常显（收起朝下 /
    // 展开朝上，见调用点）。`border-box` 不能省——底样式带 1px 透明边框，不并入盒宽
    // 就会把 16px 的槽撑成 18px，二级行的缩进立刻对不上。
    groupChevron: {
        ...CLEAR_BUTTON,
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxSizing: 'border-box',
        width: 'calc(16px + var(--dsh-content-font-delta, 0px))',
        height: 'calc(16px + var(--dsh-content-font-delta, 0px))',
        marginRight: '6px',
        padding: '0',
        color: 'var(--dsw-alias-label-tertiary)',
    },
}
