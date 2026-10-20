/**
 * 导入 / 导出共用的一棵勾选树：顶栏两个按钮各开一个弹窗，弹窗里是同一棵树。
 *
 * 导出只装草稿的**四个池**（预设绑定、运行时快照名单、「注册到主页面」开关都不进文件）；
 * 导入先由面板解析文件、再交给这棵树挑要并哪些项。勾选键是 `<池名>:<id>`——池之间的
 * id 可以同名（导入文件尤其如此），裸 id 会撞。
 *
 * @module dsh-agent-studio/client-parts/panel-transfer
 */
import * as React from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { Checkbox, Modal, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { STYLE, TREE_INDENT } from '../styles'
import type { Translate } from '../locales'
import { useT } from './panel-translate'
import type {
    Draft,
    DraftItem,
    ExportDialogProps,
    ImportDialogProps,
    PoolKind,
    TransferGroup,
    TransferTreeProps,
} from './panel-types'
import { importLabelOf, nounOf } from './panel-draft'
import { GroupHead } from './panel-pickers'
import { formButtons, h } from './panel-widgets'

const { useState } = React

// ── 勾选键与分组 ────────────────────────────────────────────────────────

/**
 * 一项的勾选键：`<池名>:<id>`。
 *
 * @param kind - 项所属的池。
 * @param id - 项在池里的 id。
 */
export function transferKeyOf(kind: PoolKind, id: string): string {
    return `${kind}:${id}`
}

/** 一组分组里全部项的勾选键：默认全勾与整组勾/取消都按它算。 */
function transferKeysOf(groups: TransferGroup[]): string[] {
    return groups.flatMap((group) => group.items.map((item) => transferKeyOf(group.kind, item.id)))
}

/**
 * 一个池 → 树里的一个分组（导出与导入共用，标题与行文案只在这里定一次）。
 *
 * 标题：Agent 池用左栏那一档名字（`Agent 池` / `Agents`），三个集池用池名词。
 * 行文案走导入那边同一套取名口径（没名字就用 id）。
 *
 * @param kind - 池名。
 * @param items - 池里的项（草稿项或导入文件里的原始项都行，只读 id / name）。
 * @param t - 翻译器。
 */
export function transferPoolGroup(kind: PoolKind, items: { id?: string; name?: string }[], t: Translate): TransferGroup {
    return {
        kind,
        title: kind === 'agent' ? t('nav.agentPool') : nounOf(kind, t),
        items: items.map((item) => ({ id: item.id ?? '', label: importLabelOf(item) })),
    }
}

/** 当前草稿的四个池 → 树的四个分组（顺序同左栏）。 */
export function transferGroupsOf(draft: Draft, t: Translate): TransferGroup[] {
    return [
        transferPoolGroup('agent', draft.agents, t),
        transferPoolGroup('promptSets', draft.promptSets, t),
        transferPoolGroup('toolSets', draft.toolSets, t),
        transferPoolGroup('skillSets', draft.skillSets, t),
    ]
}

// ── 导出内容 ────────────────────────────────────────────────────────────

/** 导出文件的形状：版本 + 时间 + 四个池（只含勾中的项）。 */
export interface ExportPayload {
    version: 2
    exportedAt: string
    agents: DraftItem[]
    promptSets: DraftItem[]
    toolSets: DraftItem[]
    skillSets: DraftItem[]
}

/** 一个池里勾中的那些项。 */
function pickedOf(kind: PoolKind, items: DraftItem[], keys: Set<string>): DraftItem[] {
    return items.filter((item) => keys.has(transferKeyOf(kind, item.id)))
}

/**
 * 导出文件的内容：**只含勾中的项**，四个池的键都给（没勾就是空数组）。
 *
 * 预设绑定与各开关**不进导出**（用户拍板）：绑定指回平台预设、开关是挂载偏好，
 * 它们都不是「这四个池的配置」。
 *
 * @param draft - 当前草稿（含未保存的改动）。
 * @param selected - 勾中的勾选键。
 */
export function exportPayloadOf(draft: Draft, selected: string[]): ExportPayload {
    const 选中键 = new Set(selected)

    return {
        version: 2,
        exportedAt: new Date().toISOString(),
        agents: pickedOf('agent', draft.agents, 选中键),
        promptSets: pickedOf('promptSets', draft.promptSets, 选中键),
        toolSets: pickedOf('toolSets', draft.toolSets, 选中键),
        skillSets: pickedOf('skillSets', draft.skillSets, 选中键),
    }
}

// ── 勾选态的两条纯操作（两个弹窗共用）──────────────────────────────────

/** 单项勾 / 取消。 */
function applyKeyToggle(selected: string[], key: string, checked: boolean): string[] {
    return checked ? [...selected, key] : selected.filter((current) => current !== key)
}

/** 整组勾 / 取消。 */
function applyGroupToggle(selected: string[], keys: string[], checked: boolean): string[] {
    if (checked === false) return selected.filter((current) => !keys.includes(current))

    return [...new Set([...selected, ...keys])]
}

// ── 勾选树 ──────────────────────────────────────────────────────────────

/**
 * 弹窗里的滚动区（规范第 41 条）。平台 `Modal` 的卡片没有 `max-height`、`.body`
 * 也不滚：长清单自己裹一层受控高度的滚动区，否则会把卡片顶穿视口。
 *
 * `fontSize` 不能省：弹窗 portal 到 body，不继承面板的 13px 基准。
 */
const SCROLL_AREA: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    overflowY: 'auto',
    overflowX: 'hidden',
    maxHeight: 'min(calc(100vh - 230px), 620px)',
    fontSize: '13px',
}

/**
 * 一棵勾选树：组头可折叠、可整组勾选，二级行逐项勾选。
 *
 * 组头复用工具树 / 技能树的 `GroupHead`（箭头方向与面板约定一致），二级行的缩进走
 * 同一个 `TREE_INDENT`——三种树看起来是同一件东西。空组整组不渲染。
 *
 * @param props - `{ groups, selected, onToggle, onToggleGroup }`。
 */
export function TransferTree(props: TransferTreeProps): ReactElement {
    const { groups, selected, onToggle, onToggleGroup } = props
    const t = useT()
    const [foldedKinds, setFoldedKinds] = useState<PoolKind[]>([])

    function fold(kind: PoolKind) {
        setFoldedKinds(foldedKinds.includes(kind)
            ? foldedKinds.filter((current) => current !== kind)
            : [...foldedKinds, kind])
    }

    const visibleGroups = groups.filter((group) => group.items.length > 0)

    return h('div', { style: { display: 'flex', flexDirection: 'column' } }, visibleGroups.map((group) => {
        const keys = transferKeysOf([group])
        const picked = keys.filter((key) => selected.includes(key)).length
        const folded = foldedKinds.includes(group.kind)

        const head = h(GroupHead, {
            key: 'head',
            name: group.title,
            count: t('transfer.count', { checked: picked, total: group.items.length }),
            allChecked: picked === group.items.length,
            folded,
            onChange: (next: boolean) => onToggleGroup(keys, next),
            onToggle: () => fold(group.kind),
        })

        const rows = group.items.map((item) => {
            const key = transferKeyOf(group.kind, item.id)

            return h('div', {
                key,
                // 二级行缩进：与组头勾选框同一条竖线（与工具树同理）。
                style: { ...STYLE.row, paddingLeft: TREE_INDENT },
            }, h(Checkbox, {
                key: 'check',
                checked: selected.includes(key),
                onChange: (next: boolean) => onToggle(key, next),
                label: item.label,
            }))
        })

        return h('div', { key: group.kind }, [head, ...(folded === true ? [] : rows)])
    }))
}

// ── 导出弹窗 ────────────────────────────────────────────────────────────

/**
 * 导出弹窗：勾哪些项就导哪些项。
 *
 * 每次打开都由面板重新挂载 ⇒ `useState` 的初值就是「全部勾上」，不必额外重置。
 *
 * @param props - `{ open, draft, onClose, onConfirm }`：`onConfirm` 收勾中的键。
 */
export function ExportDialog(props: ExportDialogProps): ReactElement {
    const { open, draft, onClose, onConfirm } = props
    const t = useT()
    const groups = transferGroupsOf(draft, t)
    const [selected, setSelected] = useState<string[]>(() => transferKeysOf(groups))

    function toggle(key: string, checked: boolean) {
        setSelected(applyKeyToggle(selected, key, checked))
    }

    function toggleGroup(keys: string[], checked: boolean) {
        setSelected(applyGroupToggle(selected, keys, checked))
    }

    return h(Modal, {
        open,
        onClose,
        title: t('transfer.titleExport'),
        closeLabel: t('common.close'),
        footer: formButtons({
            okText: t('transfer.exportSelected'),
            okDisabled: selected.length === 0,
            onOk: () => onConfirm(selected),
            onCancel: onClose,
        }, t),
    }, h('div', { key: 'scroll', style: SCROLL_AREA }, h(TransferTree, {
        groups,
        selected,
        onToggle: toggle,
        onToggleGroup: toggleGroup,
    })))
}

// ── 导入弹窗 ────────────────────────────────────────────────────────────

/**
 * 导入弹窗：文件解析完先挑「并哪些项进去」，撞 id 时覆盖与否也在这一步定。
 *
 * 覆盖开关默认关 = 撞 id 整批拒绝（老行为）；两行说明是静态的，开关只决定走哪一条。
 *
 * @param props - `{ open, groups, onClose, onConfirm }`：`groups` 由面板从文件解析出来，
 *   `onConfirm` 收 `{ selected, overwrite }`。
 */
export function ImportDialog(props: ImportDialogProps): ReactElement {
    const { open, groups, onClose, onConfirm } = props
    const t = useT()
    const [selected, setSelected] = useState<string[]>(() => transferKeysOf(groups))
    const [overwrite, setOverwrite] = useState(false)

    function toggle(key: string, checked: boolean) {
        setSelected(applyKeyToggle(selected, key, checked))
    }

    function toggleGroup(keys: string[], checked: boolean) {
        setSelected(applyGroupToggle(selected, keys, checked))
    }

    return h(Modal, {
        open,
        onClose,
        title: t('transfer.titleImport'),
        closeLabel: t('common.close'),
        footer: formButtons({
            okText: t('transfer.importSelected'),
            okDisabled: selected.length === 0,
            onOk: () => onConfirm({ selected, overwrite }),
            onCancel: onClose,
        }, t),
    }, [
        h('div', { key: 'overwrite', style: STYLE.rowNowrap }, [
            h(Switch, {
                key: 'switch',
                checked: overwrite,
                onChange: (next: boolean) => setOverwrite(next),
                // 平台的 label 是**无障碍名**（不可见）⇒ 可见文案另写一个 span。
                label: t('import.overwrite'),
            }),
            h('span', { key: 'caption', style: STYLE.hint }, t('import.overwrite')),
        ]),
        h('div', { key: 'on', style: STYLE.hint }, t('import.overwriteOn')),
        h('div', { key: 'off', style: STYLE.hint }, t('import.overwriteOff')),
        h('div', { key: 'scroll', style: SCROLL_AREA }, h(TransferTree, {
            groups,
            selected,
            onToggle: toggle,
            onToggleGroup: toggleGroup,
        })),
    ])
}
