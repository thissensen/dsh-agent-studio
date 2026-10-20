/**
 * 面板外框三件套：顶栏（预设管理条）／保存行／左栏二级菜单，外加导出用的存文件函数。
 *
 * 导入 / 导出的勾选树与两个弹窗在 `panel-transfer`（这里只留按钮与隐藏文件输入）。
 *
 * @module dsh-agent-studio/client-parts/panel-chrome
 */
import * as React from 'react'
import type { CSSProperties, ChangeEvent } from 'react'
import { Button, Input, Menu, Modal, Pill, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { NAV_HEIGHT_RESERVE, ROW_SPACER, SAVE_BAR_CLEAN, SAVE_BAR_DIRTY, STYLE } from '../styles'
import { useT } from './panel-translate'
import type {
    DraftItem,
    NavColumnProps,
    PoolKind,
    PresetBarProps,
    SaveBarProps,
} from './panel-types'
import { agentLabel, presetText, setLabel } from './panel-draft'
import { FieldRow, formButtons, h, menuAnchor } from './panel-widgets'

const { useLayoutEffect, useRef, useState } = React

// ── 预设管理条 ──────────────────────────────────────────────────────────

/**
 * 顶部管理条：预设 Tab＋主代理绑定＋新建/删除预设＋导入/导出。
 *
 * 第三排「保存区」不在里面——它是独立的吸附行（`SaveBar`），得挂在面板根下才吸得住。
 *
 * Tab 上写预设的**显示名**（预设声明里的 `name`，一般是中文），
 * id 只在没给显示名时顶上，同时挂在 `title` 里备查——用户认的是「标准模式」
 * 而不是 `standard`。
 *
 * @param props - 面板传下来的状态与事件。
 */
export function PresetBar(props: PresetBarProps) {
    const {
        presets, authorable, selectedPresetId, busy, form, agents, boundAgentId,
        onSelect, onBind, onOpenForm, onFormPatch, onCloseForm,
        onCreatePreset, onDeletePreset, onExport, onRequestImport, onImportFile,
    } = props

    const t = useT()

    /** 「来源」与「主代理绑定」两个下拉（`Menu`）的展开态。 */
    const [fromOpen, setFromOpen] = useState(false)
    const [bindOpen, setBindOpen] = useState(false)

    // 平台 `Pill`：自绘胶囊退役（灰底 / 选中描边 / 12px 都跟平台走）；
    // 悬停说明（`title`）与点击照旧。
    const tabs = presets.map((preset) => {
        const 文案 = presetText(preset, t)

        return h(Pill, {
            key: preset.id,
            active: preset.id === selectedPresetId,
            onClick: () => onSelect(preset.id),
            title: 文案.hint,
        }, 文案.name)
    })

    const selectedPreset = presets.find((preset) => preset.id === selectedPresetId)
    const canDelete = selectedPreset?.writable === true && authorable === true
    // 删除确认与绑定标签都要「当前选中的预设叫什么」，算一次共用。
    const selectedPresetName = selectedPreset === undefined ? (selectedPresetId ?? '') : presetText(selectedPreset, t).name

    // 新建 / 删除都走弹窗（`Modal` 壳）：内联表单塞在管理条里会把整条挤变形，
    // 而「从哪个预设复制」这类一次性选择也没必要常驻在那里。
    let formModal = null
    if (form?.kind === 'create') {
        const fromItems: MenuEntry[] = presets.map((preset) => ({ id: preset.id, label: presetText(preset, t).name }))
        const fromChoice = presets.find((preset) => preset.id === form.from)
        const fromText = fromChoice === undefined ? form.from : presetText(fromChoice, t).name

        formModal = h(Modal, {
            key: 'createModal',
            open: true,
            onClose: onCloseForm,
            title: t('preset.createTitle'),
            closeLabel: t('common.close'),
            footer: formButtons({
                okText: t('preset.createOk'),
                okDisabled: busy || form.id === '',
                onOk: onCreatePreset,
                onCancel: onCloseForm,
            }, t),
        }, [
            h(FieldRow, {
                key: 'fromRow',
                label: t('preset.from'),
                children: h(Menu, {
                    // `FieldRow` 把 children 摊成数组渲染，数组元素没 key 会触发
                    // React 的 "unique key" 警告（单元素数组也一样报）。
                    key: 'menu',
                    open: fromOpen,
                    anchor: menuAnchor({
                        open: fromOpen,
                        text: fromText,
                        onClick: () => setFromOpen(!fromOpen),
                    }),
                    items: fromItems,
                    selectedId: form.from,
                    onSelect: (id: string) => {
                        onFormPatch({ from: id })
                        setFromOpen(false)
                    },
                    onClose: () => setFromOpen(false),
                    side: 'bottom',
                    portal: true,
                }),
            }),
            h(FieldRow, {
                key: 'idRow',
                label: t('preset.newId'),
                children: h(Input, {
                    key: 'id',
                    type: 'text',
                    value: form.id,
                    placeholder: t('preset.newIdPlaceholder'),
                    onChange: (event: ChangeEvent<HTMLInputElement>) => onFormPatch({ id: event.target.value }),
                }),
            }),
            h(FieldRow, {
                key: 'nameRow',
                label: t('preset.displayName'),
                children: h(Input, {
                    key: 'name',
                    type: 'text',
                    value: form.name,
                    placeholder: t('preset.optional'),
                    onChange: (event: ChangeEvent<HTMLInputElement>) => onFormPatch({ name: event.target.value }),
                }),
            }),
            // 描述（2026-09-18 用户点名）：写进新预设的定义，会话的预设选择器里
            // 那一行小字就是它。留空 = 从来源预设继承。
            // 多行输入（用户点名）：描述可能是一段话，单行框里写不下、也读不全；
            // 描述现在直接进配置里的定义（由平台的 YAML 落盘），断行原样保留。
            h(FieldRow, {
                key: 'descriptionRow',
                label: t('preset.description'),
                // 多行框高度大，标签对齐首行更像常规表单（其余行维持居中）。
                style: { alignItems: 'flex-start' },
                children: h('textarea', {
                    key: 'description',
                    value: form.description,
                    rows: 3,
                    placeholder: t('preset.descriptionPlaceholder'),
                    onChange: (event: ChangeEvent<HTMLTextAreaElement>) => onFormPatch({ description: event.target.value }),
                    style: STYLE.textarea,
                }),
            }),
            h('div', { key: 'note', style: STYLE.hint }, t('preset.createNote')),
        ])

    } else if (form?.kind === 'delete') {
        formModal = h(Modal, {
            key: 'deleteModal',
            open: true,
            onClose: onCloseForm,
            title: t('preset.deleteTitle'),
            closeLabel: t('common.close'),
            footer: formButtons({
                okText: t('common.delete'),
                okDisabled: busy,
                onOk: onDeletePreset,
                onCancel: onCloseForm,
            }, t),
        }, h('div', { key: 'confirm', style: STYLE.warning },
            t('preset.deleteConfirm', { name: selectedPresetName })))
    }

    // 绑定行只放「主代理」选择器：绑定说明挪到下面一行小字——它一占满整行，
    // 就会把导入 / 导出挤到下一行（用户第 1 条反馈）。
    // 标签里带上**当前预设名**（第十八轮用户反馈）：预设是一排 Tab，写死「本预设」
    // 在多标签之间切换时容易认错人。
    // 菜单里第一条「未绑定」的 id 是空串（= 原 `<select>` 的空选项），选它 = 解除绑定。
    const bindItems: MenuEntry[] = [
        { id: '', label: t('bar.unbound') },
        ...agents.map((agent) => ({ id: agent.id, label: agentLabel(agent, t) })),
    ]
    const bindChoice = agents.find((agent) => agent.id === boundAgentId)
    const bindText = bindChoice === undefined ? t('bar.unbound') : agentLabel(bindChoice, t)

    const bindRow = h(FieldRow, {
        key: 'bind',
        label: t('bar.bindLabel', { preset: selectedPresetName }),
        children: h(Menu, {
            // 同 `fromRow`：`FieldRow` 的摊平渲染要求数组元素带 key。
            key: 'menu',
            open: bindOpen,
            anchor: menuAnchor({
                open: bindOpen,
                text: bindText,
                onClick: () => setBindOpen(!bindOpen),
            }),
            items: bindItems,
            selectedId: boundAgentId === undefined ? '' : boundAgentId,
            onSelect: (id: string) => {
                onBind(id === '' ? undefined : id)
                setBindOpen(false)
            },
            onClose: () => setBindOpen(false),
            side: 'bottom',
            portal: true,
        }),
    })

    // 第 6 条反馈的三排布局：①预设（含新建/删除）②主代理绑定 + 导入导出 ③保存区。
    const divider = (key: string) => h('div', { key, style: STYLE.divider })

    const presetRow = h('div', { key: 'presetRow', style: { ...STYLE.row, width: '100%' } }, [
        ...tabs,
        h('span', { key: 'spacer', style: ROW_SPACER }),
        h(Button, {
            key: 'create',
            type: 'button',
            variant: 'primary',
            size: 'sm',
            onClick: () => onOpenForm({ kind: 'create', from: selectedPresetId as string, id: '', name: '', description: '' }),
            disabled: busy || authorable !== true,
            title: authorable === true ? undefined : t('bar.notAuthorableTitle'),
        }, t('bar.createPreset')),
        h(Button, {
            key: 'removePreset',
            type: 'button',
            // 与「新建预设」同款白底（用户 2026-09-18 点名）：ghost 在卡片底上像纯文本，
            // 删除这种不可撤销的自定义动作更需要一眼可辨的按钮形态。
            variant: 'primary',
            size: 'sm',
            onClick: () => onOpenForm({ kind: 'delete' }),
            disabled: busy || canDelete !== true,
            // 灰的原因分两种，说清楚是哪一种：平台压根没有创作入口，还是这个预设不是这里建的。
            title: canDelete === true
                ? t('bar.deleteEnabledTitle')
                : t(authorable === true ? 'bar.deleteDisabledTitle' : 'bar.notAuthorableTitle'),
        }, t('bar.deletePreset')),
    ])

    const transferRow = h('div', { key: 'transferRow', style: { ...STYLE.row, width: '100%' } }, [
        bindRow,
        h('span', { key: 'spacer', style: ROW_SPACER }),
        h('input', {
            key: 'file',
            id: 'agent-studio-import',
            type: 'file',
            accept: 'application/json,.json',
            style: { display: 'none' },
            onChange: onImportFile,
        }),
        // 隐藏的文件输入不能换成平台 `Input`：按钮先开确认弹窗，弹窗确认后由面板
        // 点开它（原来是 `<label htmlFor>`，换平台件后没有 label 那种转发）。
        h(Button, {
            key: 'import',
            type: 'button',
            variant: 'outline',
            onClick: onRequestImport,
            disabled: busy,
            title: t('bar.importTitle'),
        }, t('bar.import')),
        h(Button, {
            key: 'export',
            type: 'button',
            variant: 'outline',
            onClick: onExport,
            title: t('bar.exportTitle'),
        }, t('bar.export')),
    ])

    // 绑定说明（小字）单独一行——「注入运行时环境快照」开关已挪到 Agent 详情的
    // 提示词集卡片里（第十五轮用户反馈：它属于 Agent 的提示词面）。
    const hintRow = h('div', { key: 'hintRow', style: { ...STYLE.row, width: '100%' } }, [
        h('span', { key: 'bindHint', style: STYLE.hintGrow },
            t('bar.bindHint')),
    ])

    return h('div', { style: STYLE.barColumn }, [
        presetRow,
        divider('divider-1'),
        transferRow,
        hintRow,
        formModal,
    ])
}

// ── 保存行 ──────────────────────────────────────────────────────────────

/**
 * 底部保存行：注册到主页面 + 保存态 + 保存改动。
 *
 * 它挂在面板根下（不是被管理条包着），才吸得住——见 `STYLE.saveBar` 的说明。
 * 每量到一次高度都往上报：左栏要按它往下让位，两行吸顶时不会叠在一起。
 *
 * @param props - 面板传下来的状态与事件。
 */
export function SaveBar(props: SaveBarProps) {
    const {
        busy,
        dirty,
        savedOnce,
        mountMainPage,
        mountAvailable,
        mountDisabled,
        onToggleMountMainPage,
        onSave,
        onHeightChange,
    } = props
    const t = useT()
    const barRef = useRef<HTMLDivElement | null>(null)

    // 宽度变窄时按钮会换行、行变高，所以跟着量而不是只量一次。
    // 用 layout effect：首帧就把高度交出去，左栏不会先吸错位再跳一下。
    useLayoutEffect(() => {
        const node = barRef.current
        if (node === null) return

        onHeightChange(node.getBoundingClientRect().height)

        const observer = new ResizeObserver(() => onHeightChange(node.getBoundingClientRect().height))
        observer.observe(node)

        return () => observer.disconnect()
    }, [onHeightChange])

    // 状态行：默认空；有未保存改动 → 橙字；保存过至少一次之后 → 常显「已保存」。
    let stateText = null
    let stateStyle = STYLE.hint
    if (dirty === true) {
        stateText = t('bar.unsaved')
        stateStyle = STYLE.warning
    } else if (savedOnce === true) {
        stateText = t('bar.saved')
    }

    return h('div', { ref: barRef, style: dirty === true ? SAVE_BAR_DIRTY : SAVE_BAR_CLEAN }, [
        // 「注册到主页面」开关（用户点名）住在保存行最左：它改的是全局开关，与草稿无关，
        // 所以不包 form、不触发保存——点一下就直接落盘。
        h('div', { key: 'mount', style: STYLE.saveBarMount }, [
            h(Switch, {
                key: 'switch',
                checked: mountMainPage,
                disabled: mountDisabled,
                onChange: (next: boolean) => onToggleMountMainPage(next),
                // 平台的 label 是**无障碍名**（不可见）⇒ 可见文案另写一个 span。
                label: t('bar.mountMainPage'),
                title: mountAvailable ? t('bar.mountMainPageTitle') : t('bar.mountUnavailableTitle'),
            }),
            h('span', { key: 'caption', style: STYLE.hint }, t('bar.mountMainPage')),
        ]),
        stateText === null ? null : h('span', { key: 'state', style: stateStyle }, stateText),
        h('span', { key: 'spacer', style: ROW_SPACER }),

        h(Button, {
            key: 'save',
            type: 'button',
            variant: 'primary',
            onClick: onSave,
            disabled: busy || dirty === false,
        }, t('bar.save')),
    ])
}

// ── 左栏 ────────────────────────────────────────────────────────────────

/**
 * 左栏：二级菜单——一级是三个池（Agent 池 / 提示词集 / 工具集），二级是池里的项。
 *
 * 三个池的交互完全一致（第十三轮用户反馈）：点一级 = 切到这个池并**默认选中第一项**
 * （空池落在空态，右边只剩三个按钮）；点二级 = 选中并编辑那一项。
 *
 * 选中项用 **id** 认，不用下标——id 由面板生成、不可编辑，是稳定标识；
 * 用下标的话，删掉上面一项，选中就会滑到别人身上。
 *
 * @param props - 面板传下来的状态与事件。
 */
export function NavColumn(props: NavColumnProps) {
    const { agents, promptSets, toolSets, skillSets, selection, stuckOffset, onSelectAgent, onSelectSet, onOpenPool } = props
    const t = useT()

    /** 一级（池名）+ 二级（项）。`kind` 与 selection.kind 同一套取值。 */
    const groupNode = (kind: PoolKind, title: string, items: DraftItem[], labelOf: (item: DraftItem) => string, onPick: (id: string) => void) => {
        const active = selection.kind === kind
        const selectedId = kind === 'agent' ? selection.agentId : selection.setId

        return h('div', { key: kind, style: STYLE.navGroup }, [
            h('button', {
                // key 不能叫 'title'：卡片定位器（自检脚本）按 `key === 'title'` 认卡片，
                // 撞上会把这一整组当成卡片。
                key: 'groupTitle',
                type: 'button',
                onClick: () => onOpenPool(kind),
                style: {
                    ...STYLE.navItem,
                    fontWeight: '600',
                    ...(active ? STYLE.navItemActive : {}),
                },
            }, title),
            h('div', { key: 'items', style: STYLE.navSub }, items.length === 0
                ? h('div', {
                    key: 'empty',
                    style: { ...STYLE.hint, fontSize: '12px', paddingLeft: '14px', margin: '0' },
                }, t('common.empty'))
                : items.map((item) => h('button', {
                    key: item.id,
                    type: 'button',
                    onClick: () => onPick(item.id),
                    style: {
                        ...STYLE.navItem,
                        paddingLeft: '14px',
                        ...(active && selectedId === item.id ? STYLE.navItemActive : {}),
                        ...STYLE.ellipsis,
                    },
                    title: t('nav.itemTitle', { label: labelOf(item), id: item.id }),
                }, labelOf(item)))),
        ])
    }

    // 吸附位与限高都随让位量走：两行都吸在滚动区顶部，左栏从上方那行的下沿接着吸，
    // 栏高上限也扣掉同样的量，才不会顶着它、也不会捅出滚动容器底部。
    const navStyle: CSSProperties = {
        ...STYLE.nav,
        top: `${stuckOffset}px`,
        maxHeight: `calc(100dvh - ${NAV_HEIGHT_RESERVE}px - ${stuckOffset}px)`,
    }

    return h('nav', { style: navStyle }, [
        groupNode('agent', t('nav.agentPool'), agents, (item) => agentLabel(item, t), onSelectAgent),
        groupNode('promptSets', t('nav.promptSets'), promptSets, (item) => setLabel(item, t), (setId) => onSelectSet('promptSets', setId)),
        groupNode('toolSets', t('nav.toolSets'), toolSets, (item) => setLabel(item, t), (setId) => onSelectSet('toolSets', setId)),
        groupNode('skillSets', t('nav.skillSets'), skillSets, (item) => setLabel(item, t), (setId) => onSelectSet('skillSets', setId)),
    ])
}

/** 把一份 JSON 存成文件（导出树确认后由面板调用；留在 chrome 里免得 transfer 反向依赖它）。 */
export function downloadJson(fileName: string, payload: unknown) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)

    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    anchor.click()
    URL.revokeObjectURL(url)
}
