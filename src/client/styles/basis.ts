/**
 * 样式原子：跨功能复用的那一层。
 *
 * 面板的样式分两档——**原子**（本文件：一行怎么排、小字什么样、线多粗、按钮怎么归零）
 * 与**功能样式**（同目录的 `shell` / `content` / `control` / `help`，各自只管一块界面）。
 * 功能层只引用原子、不自己现拼：同一个值要调时只有这里一处。
 *
 * **长度单位约定**：间距与圆角这类「跟字号成比例」的值一律用 `em`（基准 = 面板根的
 * 13px，见 `shell.ts` 的 `PANEL.fontSize`）——宿主调字号时它们跟着缩放，不必逐处改数；
 * 线宽（1px）、字号本身、以及照平台抄的像素档（帮助卡 244px 那种）保持 `px`。
 *
 * @module dsh-agent-studio/client-parts/styles/basis
 */
import type { CSSProperties } from 'react'

/**
 * 关掉浏览器对表单控件的**原生绘制**。
 *
 * 不关的话，凡是**被点过或悬停过**的裸 `button`，UA 都会按系统主题重画一圈边界色，
 * 而且离开交互后不会自行还原：`border-color` 会从我们写的 `transparent` 变成 UA 的
 * `buttonborder`（暗色主题下就是白色）。面板顶部那排预设 Tab 因此看起来像"同时选中
 * 了好几个"——2026-09-16 实测复现过，未交互时 computed 值是我们的，
 * 点过一次之后就变成 `rgb(255,255,255)`。
 *
 * `border: 1px solid transparent` 挡不住它：那是绘制层的行为，不是 CSS 的 border 属性。
 * 只有 `appearance: none` 能让控件完全交给我们自己的样式。
 *
 * **绝不能加到 `<input type="checkbox">` 上**——工具勾选与段开关都用它，
 * 关掉原生绘制会把勾选框变成空白方块。`<select>` 也不能加，否则下拉箭头会消失。
 */
export const RESET_NATIVE_CONTROL: CSSProperties = {
    appearance: 'none',
    WebkitAppearance: 'none',
    outline: 'none',
}

/** 一行控件排布（左文本 / 弹簧 / 右操作）；吸顶行也复用它，只多压一层定位与底色。 */
export const ROW_LAYOUT: CSSProperties = {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.6em',
    padding: '0.25em 0',
}

/**
 * 行内小组合（勾选框 + 文字、图标 + 文字这类）：横排、竖直居中、留一点间距。
 * 面板里这种组合出现多次，形态必须一致，所以提成原子。
 */
export const INLINE_ROW: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.6em',
}

/** 行内不换行的那种（列表行头、字段行）：操作项挤不掉左侧文本，多长的名字都截断。 */
export const ROW_NOWRAP: CSSProperties = {
    ...ROW_LAYOUT,
    flexWrap: 'nowrap',
}

/** 弹簧：把同一行右侧的操作项推到行尾。 */
export const ROW_SPACER: CSSProperties = { flex: '1 1 auto', minWidth: '0' }

/** 行尾项：不给它 `flex: none` 的话，名称一长最先被压扁的是按钮（会变竖排文字）。 */
export const ROW_TAIL: CSSProperties = { flex: 'none' }

/** 平台控件统一的重置 + 中性底：面板里所有「看着像纯文本」的按钮共用（预设 Tab、左栏项）。 */
export const CLEAR_BUTTON: CSSProperties = {
    ...RESET_NATIVE_CONTROL,
    border: '1px solid transparent',
    // 未选中态把颜色也写死一次，不只依赖上面的简写——简写被覆盖时还有这条兜着
    borderColor: 'transparent',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    // 字重给一个显式基线：选中态会把它改成 500；这里若留空，React 在「选中 → 未选中」时得
    // 移除 fontWeight，而上面的 font 简写已经把它重置掉 ⇒ 报
    // "Removing a style property during rerender"，字重不保证还原（3b 走查发现）。
    fontWeight: '400',
    cursor: 'pointer',
}

/** 选中面：刻意不止靠边框——背景与字重也给一份，万一原生绘制又在某个状态下冒出来，
 *  「哪个才是我在编辑的」仍然一眼可辨。 */
export const SELECTED_FACE: CSSProperties = {
    borderColor: 'currentColor',
    background: 'rgba(127,127,127,0.22)',
    fontWeight: '500',
}

/** 分隔线：卡片边框与吸顶行的上下沿共用同一条。 */
export const HAIRLINE = '1px solid rgba(127,127,127,0.28)'

/** 更淡的一条线：列表行之间用。 */
export const FAINT_LINE = '1px solid rgba(127,127,127,0.16)'

/** 动作反馈条（成功 / 失败）的公共壳，两者只差边框色。 */
export const NOTICE: CSSProperties = {
    borderRadius: '0.45em',
    padding: '0.6em 0.75em',
    margin: '0.15em 0',
}

/** 说明小字：`pre-line` 让 `\n` 断行（子代理卡与后台模式的说明靠它），不含 `\n` 的不受影响。 */
export const HINT: CSSProperties = {
    opacity: 0.65,
    margin: '0.15em 0',
    whiteSpace: 'pre-line',
}

/** 一行装不下就截断成一行——折行会把整列撑高，反而更难扫。 */
export const ELLIPSIS: CSSProperties = {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
}

/** 上一条的「按内容排、不抢空间」版本：名字后头还要挂计数、注记这类短尾时用。 */
export const ELLIPSIS_FIT: CSSProperties = {
    ...ELLIPSIS,
    flex: '0 1 auto',
    minWidth: '0',
}
