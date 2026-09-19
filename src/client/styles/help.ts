/**
 * 问号锚点与浮层的样式（自绘，替代平台的 `HoverCard`——后者在设置页里层级不够）。
 *
 * @module dsh-agent-studio/client-parts/styles/help
 */
import type { CSSProperties } from 'react'

/**
 * 问号锚点（`HelpTip` 的触发圆标）。自绘一个 18px 的圆：平台图标集里
 * 没有「带圈问号」这一形态（`IconQuestionOutline14` 是裸问号，观感不搭）。
 *
 * 圆标自带 12px 字号，`em` 按它自己的字号换算（1.5em = 18px）。
 */
export const HELP_ANCHOR: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 'none',
    width: '1.5em',
    height: '1.5em',
    border: '1px solid rgba(127,127,127,0.5)',
    borderRadius: '50%',
    fontSize: '12px',
    lineHeight: '1',
    cursor: 'pointer',
}

/**
 * 问号卡。视觉照平台的 `HoverCard` 卡片（244 宽 / r12 / 12-16 内边距 / 阴影 lv3）；
 * 底色在两种主题下都固定 `#2C2C2E`，所以文字色也固定浅色——不能吃主题 token，
 * 否则亮主题下会变成深底深字。
 *
 * 宽度与限高保持平台的像素档（那是平台给的尺寸）；内边距、圆角、行距跟字号走。
 */
export const HELP_CARD: CSSProperties = {
    position: 'fixed',
    zIndex: 1100,
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.45em',
    width: '244px',
    // 限高可滚：短提示用不到，长内容（段预览）不至于顶穿视口。
    // 用 `min(…, dvh)` 的相对写法：窗口矮的时候跟着缩，别把卡片顶出屏。
    maxHeight: 'min(340px, calc(100dvh - 24px))',
    overflowY: 'auto',
    padding: '0.9em 1.25em',
    borderRadius: '0.9em',
    background: '#2C2C2E',
    boxShadow: 'var(--dsw-shadow-lv3)',
    color: '#FFFFFF',
    fontSize: '13px',
    lineHeight: '1.55',
}

/**
 * 长正文（平台预设段的预览）的浮层卡：比小卡宽，正文按原样换行。
 * 白字浅底是刻意的（同 HELP_CARD，不吃主题 token）。
 */
export const HELP_CARD_WIDE: CSSProperties = {
    ...HELP_CARD,
    width: 'min(460px, 70vw)',
    maxHeight: 'min(380px, calc(100dvh - 24px))',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
}

/** 自定义锚点时的占位样式：占满弹性空间（锚点自己就是被悬停的那段文字）。 */
export const HELP_ANCHOR_FLEX: CSSProperties = {
    flex: '1 1 auto',
    minWidth: 0,
    display: 'flex',
}

/**
 * 清单树的二级行缩进：与平台 `DisclosureRow` 组头的 leading 槽对齐
 * （16px 的 chevron 槽 + 6px 的 margin-right），使两级行的勾选框落在同一条
 * 竖线上（第十八轮用户反馈：二级行贴着左边、两个勾选框对不齐）。
 * `--dsh-content-font-delta` 跟着设置里的字号偏好缩放，字号改了也保持对齐。
 */
export const TREE_INDENT = 'calc(22px + var(--dsh-content-font-delta, 0px))'
