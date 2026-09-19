/**
 * 卡片与正文的样式：一张卡片怎么包、说明小字怎么显、提示条与段预览长什么样。
 *
 * @module dsh-agent-studio/client-parts/styles/content
 */
import type { CSSProperties } from 'react'
import { ELLIPSIS, ELLIPSIS_FIT, FAINT_LINE, HAIRLINE, HINT, NOTICE } from './basis'

const HINT_GROW: CSSProperties = {
    ...HINT,
    flex: '1 1 auto',
    minWidth: '0',
}

const HINT_ELLIPSIS: CSSProperties = {
    ...HINT,
    ...ELLIPSIS_FIT,
}

export const CONTENT = {
    card: {
        border: HAIRLINE,
        borderRadius: '0.6em',
        padding: '0.75em 0.9em',
        marginBottom: '0.9em',
    },
    cardTitle: {
        fontWeight: '600',
        marginBottom: '0.45em',
    },
    hint: HINT,
    // 说明小字要吃掉整行剩余宽度（右侧还有操作项时，挤的该是它、不是按钮）。
    hintGrow: HINT_GROW,
    // 另一种：按内容宽度排，超长截断——名字旁边挂计数、注记这类短尾用。
    hintEllipsis: HINT_ELLIPSIS,
    // 同一条截断规则，但不吃 hint 的灰字与行距（正文里的名字用）。
    ellipsis: ELLIPSIS,
    ellipsisFit: ELLIPSIS_FIT,
    warning: {
        opacity: 0.9,
        margin: '0.15em 0',
    },
    error: {
        ...NOTICE,
        border: '1px solid rgba(220,90,90,0.7)',
    },
    ok: {
        ...NOTICE,
        border: '1px solid rgba(90,180,120,0.7)',
    },
    // 列表行的分隔线：行与行之间一条淡线，扫起来不糊成一片。
    listRow: {
        borderTop: FAINT_LINE,
    },
    // 段正文的只读预览（弹窗与展开区共用）。
    // 这段自带 12px 字号，下面的 em 按它自己的字号换算（不是面板的 13px）。
    sectionText: {
        margin: '0.35em 0 0',
        padding: '0.7em',
        maxHeight: '18em',
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontSize: '12px',
        lineHeight: '1.5',
        background: 'rgba(127,127,127,0.12)',
        borderRadius: '0.5em',
    },
}
