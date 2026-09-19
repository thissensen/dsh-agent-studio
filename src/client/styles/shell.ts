/**
 * 面板骨架的样式：外壳、两排吸顶、左右两栏的排布。
 *
 * 这一层只管「大块怎么摆」，块里面的卡片与正文在 `content`、控件形态在 `control`。
 *
 * @module dsh-agent-studio/client-parts/styles/shell
 */
import type { CSSProperties } from 'react'
import { ROW_LAYOUT, ROW_NOWRAP } from './basis'

/**
 * 左栏限高要预留的窗口外空间（180px）：底层滚动容器的上沿 104px（真机量的——1420×900 下
 * 宿主设置弹层上下各留 50px、弹层内标题区 54px）加上底部余量。吸顶行的实测高度另行扣掉
 * （见 `NavColumn` 的 `stuckOffset`），所以栏底始终落在滚动容器以内。
 */
export const NAV_HEIGHT_RESERVE = 180

/**
 * 面板根：只有布局。状态框（橙 / 绿）归吸顶的保存行，别往这儿挂。
 *
 * 这里的 `fontSize: 13px` 是整个面板的**字号基准**——各处相对单位（`em`）都按它换算。
 */
const PANEL: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.1em',
    padding: '1.25em',
    fontSize: '13px',
    lineHeight: '1.6',
}

// 顶栏的两排布局（第 6 条反馈）：预设 / 主代理 + 导入导出。第三排「保存区」拆成独立的
// 吸顶行（`SAVE_BAR`）——它得挂在面板根下才吸得住，上下的分隔线也跟着它走。
const BAR_COLUMN: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.6em',
}

// 保存行吸顶（2026-09-19 用户点名）：与左栏同一套吸附手法。
//
// ① 它必须是**面板根的直接子元素**：`position: sticky` 的活动范围以父元素为界，
//    留在 `barColumn` 里就只能在那百来像素里滑一下，滚过管理条立马跟着走。
// ② 吸附位取 `top: 0`（贴住滚动区顶）：位置留空隙的话，穿过去的内容会从那道缝里
//    露出来（真机踩过）。留白改由自己的 padding 给，它在背景里，吸住时也遮得住。
// ③ 四周留白对称，按钮才落在两条边框正中间、**也才不贴着左右边框**（`ROW_LAYOUT` 的
//    左右 padding 是 0，不吃掉的话「保存改动」直接顶在框上）；上下那条线由状态框给
//    （框是整圈的，自己再画一根分隔线就是两层边框打架）。
// 左栏按这一行的实测高度往下让位（`NavColumn` 的 `stuckOffset`），两行都不叠。
const SAVE_BAR: CSSProperties = {
    ...ROW_LAYOUT,
    position: 'sticky',
    top: '0',
    zIndex: 10,
    padding: '0.75em',
    // 底色不能省，否则穿过去的内容与这一行叠字。面板自己不吃背景色
    // （宿主弹层的底透下来），所以取宿主弹层卡片同一档的层级 token
    // ——`layer-2` 正是 `settings-general` 那张卡片的底（真机比对过：
    // 取 `layer-1` 会深一档，成一条颜色不同的横带）。
    background: 'var(--dsw-alias-bg-layer-2)',
}

// 有未保存改动时那一圈橙色边框（第 6 条反馈）。只给边框相关属性，与 `SAVE_BAR` 合并
// 使用——不叠加 padding，免得布局在脏 / 净两态之间跳。
const DIRTY_FRAME: CSSProperties = {
    border: '1px solid rgba(230,150,60,0.85)',
    borderRadius: '0.6em',
    boxShadow: '0 0 0 1px rgba(230,150,60,0.25)',
}

// 没有未保存改动时的绿色边框（与橙框同位置、同形状）——「已保存 / 有改动」一眼可辨。
const CLEAN_FRAME: CSSProperties = {
    border: '1px solid rgba(90,180,120,0.55)',
    borderRadius: '0.6em',
    boxShadow: '0 0 0 1px rgba(90,180,120,0.18)',
}

/** 保存行的两态：组合落在样式层，组件按 `dirty` 二选一，不在调用点现拼「哪层盖哪层」。 */
export const SAVE_BAR_DIRTY: CSSProperties = { ...SAVE_BAR, ...DIRTY_FRAME }
export const SAVE_BAR_CLEAN: CSSProperties = { ...SAVE_BAR, ...CLEAN_FRAME }

// 左栏只是「现在在编辑谁」的开关，内容全在主区，所以给到能放下代理名的最小宽度即可。
//
// `minWidth: '0'` 不能省：flex item 的默认值是 `min-width: auto`，它会认内容的最小
// 宽度，光写 `flex-basis: 100px` 根本不生效（实测被顶到 188px）。
//
// 吸附固定（2026-09-19 用户点名）：原来写死的 520px 限高，项一多在 520px 处硬切、
// 下面留一大块白。改成贴着视口吸顶、高度吃满可用视口（`dvh` 相对写法），内容超长时
// **栏内**滚动——页面本身怎么滚，它都停在眼前。
//
// 吸附位与限高不在这里写死：底部保存行也吸在滚动区顶部，左栏得从它的下沿接着吸，
// 所以由 `NavColumn` 把 `NAV_HEIGHT_RESERVE` 与让位量一起算成行内样式。
const NAV: CSSProperties = {
    flex: '0 0 10em',
    minWidth: '0',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.3em',
    position: 'sticky',
    alignSelf: 'flex-start',
    overflowY: 'auto',
    overflowX: 'hidden',
}

/** 面板骨架。合并进 `STYLE` 的那份在 `./index`。 */
export const SHELL = {
    panel: PANEL,
    barColumn: BAR_COLUMN,
    saveBar: SAVE_BAR,
    divider: {
        borderTop: '1px solid rgba(127,127,127,0.22)',
    },
    body: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '1.25em',
    },
    nav: NAV,
    // 二级菜单：一级（池名）+ 二级（池里的项）。
    navGroup: {
        display: 'flex',
        flexDirection: 'column',
        gap: '0.15em',
        marginBottom: '0.45em',
    },
    navSub: {
        display: 'flex',
        flexDirection: 'column',
        gap: '0.15em',
    },
    detail: {
        flex: '1 1 auto',
        minWidth: '0',
    },
    // 列表行的两种排法（原子在 `basis`，这里只是给它们短名，供 `STYLE.row` 取用）。
    row: ROW_LAYOUT,
    rowNowrap: ROW_NOWRAP,
}
