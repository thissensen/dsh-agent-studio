/**
 * 样式出口：面板的样式按功能拆在 `src/client/styles/` 下，这里汇总成一张表。
 *
 * - `basis` —— 共用原子（行怎么排、小字什么样、线多粗）
 * - `shell` —— 面板骨架与两排吸顶
 * - `content` —— 卡片与正文
 * - `control` —— 控件形态
 * - `help` —— 问号锚点与浮层
 *
 * 出口名与形态保持不变（`STYLE` 这张表与各常量）——拆分只动源码组织，调用点不重新拼。
 *
 * @module dsh-agent-studio/client-parts/styles
 */
import type { CSSProperties } from 'react'
import { SHELL } from './shell'
import { CONTENT } from './content'
import { CONTROL } from './control'

export const STYLE = { ...SHELL, ...CONTENT, ...CONTROL } as unknown as Record<string, CSSProperties>

export * from './basis'
export { NAV_HEIGHT_RESERVE, SAVE_BAR_CLEAN, SAVE_BAR_DIRTY } from './shell'
export { FIELD_LABEL } from './control'
export { HELP_ANCHOR, HELP_ANCHOR_FLEX, HELP_CARD, HELP_CARD_WIDE, TREE_INDENT } from './help'
