/**
 * 主区卡片：Agent 详情（身份 / 提示词集 / 工具集 / 模型与后台 / 子代理）与集库（池操作按钮 + 集编辑器）。
 *
 * @module dsh-agent-studio/client-parts/panel-main
 */
import * as React from 'react'
import type { ChangeEvent } from 'react'
import { Button, Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BackgroundMode, ToolPresentation } from '../../host/types'
import { ROW_SPACER, ROW_TAIL, STYLE } from '../styles'
import { useT } from './panel-translate'
import type {
    AgentPanelProps,
    ChildPickerProps,
    PoolActionsProps,
    SetEditorCardProps,
    SetLoadSectionProps,
} from './panel-types'
import { agentLabel, nounOf, poolOf, setLabel } from './panel-draft'
import { IdEditor } from './panel-sections'
import { FallbackList, RouteRows, parseRetryCount } from './panel-routes'
import {
    BACKGROUND_MODES,
    Choice,
    CandidateRow,
    ConfigCard,
    FieldRow,
    HelpTip,
    TOOL_PRESENTATIONS,
    choiceOptions,
    h,
    moveButtons,
} from './panel-widgets'

const { useState } = React

// ── 主区：Agent 详情 ────────────────────────────────────────────────────

/**
 * 代理详情：身份、提示词集、工具集、模型与后台、子代理。
 *
 * 「集」在这里只做装载/卸载/调序/跳转编辑——集本身住在池里（多对多共享），
 * 编辑集的内容要进「集库」视图，改一次所有装载它的代理一起变。
 *
 * @param props - 面板传下来的状态与事件。
 */
export function AgentPanel(props: AgentPanelProps) {
    const {
        agent, draft, observation, models, modelWarnings, snapshotOn, idReferenceText,
        promptLocked, snapshotFixed,
        onPatch, onLoadSet, onUnloadSet, onMoveSet, onOpenSet, onLoadEfforts,
        onToggleSnapshot, onRenameId,
    } = props

    const t = useT()

    // 这一卡不给说明文字（第十八轮用户反馈）：名称 / 备注看 placeholder 就够，
    // id 的用途写在子代理卡上——那才是模型真会读它的地方。
    const identityCard = h(ConfigCard, {
        key: 'identity',
        title: t('agent.identity'),
        children: [
            // 三档「Agent 模式」（用户点名）：声明落在 agent 自己的 scope 上，
            // 就近覆盖预设层的呈现——主代理与子代理各设各的，互不影响。
            // `Choice<ToolPresentation>` 是显式实例化：泛型函数直接交给 createElement
            // 时类型实参会退化成约束（string），那样 onChange 的值域就丢了。
            h(FieldRow, {
                key: 'presentationRow',
                label: t('agent.presentation'),
                children: h(Choice<ToolPresentation>, {
                    key: 'choice',
                    options: choiceOptions(TOOL_PRESENTATIONS, t),
                    value: agent.toolPresentation,
                    onChange: (toolPresentation) => onPatch({ toolPresentation }),
                }),
            }),
            h('div', { key: 'presentationHint', style: STYLE.hint }, t('agent.presentationHint')),
            h(IdEditor, {
                key: 'id',
                id: agent.id,
                referenceText: idReferenceText,
                onRename: (newId) => onRenameId(agent.id, newId),
            }),
            h(FieldRow, {
                key: 'nameRow',
                label: t('common.name'),
                children: h(Input, {
                    key: 'name',
                    type: 'text',
                    value: agent.name,
                    placeholder: agent.id,
                    onChange: (event: ChangeEvent<HTMLInputElement>) => onPatch({ name: event.target.value }),
                }),
            }),
            h(FieldRow, {
                key: 'noteRow',
                label: t('common.note'),
                children: h(Input, {
                    key: 'note',
                    type: 'text',
                    value: agent.note,
                    placeholder: t('agent.notePlaceholder'),
                    onChange: (event: ChangeEvent<HTMLInputElement>) => onPatch({ note: event.target.value }),
                }),
            }),
        ],
    })

    // 预设把提示词段钉死时（`complete: true`）整卡淡一层、装载区不可点：平台会在装配
    // 瀑布**之后**把段清单强制换回它那一段，这儿怎么配都不生效（2026-09-18 用户点名）。
    //
    // **快照开关不受它管**——那是另一个旗标（`includeRuntimeContext`）的事，两者独立，
    // 所以禁用只落在装载区，整卡不加 `pointerEvents`（否则会把快照开关一起锁掉）。
    const promptSetsCard = h(ConfigCard, {
        key: 'promptSets',
        title: t('agent.promptSets'),
        hint: promptLocked === true ? t('agent.promptSetsFixed') : t('agent.promptSetsHint'),
        disabled: promptLocked,
        children: [
            // 「注入运行时环境快照」开关住在说明文本下方（用户第十五轮点名）：
            // 它是这个代理提示词行为的一部分；开关本身按代理生效（runtimeContextOff）。
            // 问号浮层用自绘 `HelpTip`——平台 `HoverCard` 的卡片层级（100）低于
            // 设置页弹层（1000），在设置页里永远显示在背面（见 HelpTip 的注释）。
            h('div', { key: 'snapshot', style: STYLE.rowNowrap }, [
                h(Switch, {
                    key: 'check',
                    checked: snapshotOn === true,
                    disabled: snapshotFixed,
                    onChange: (next: boolean) => onToggleSnapshot(next),
                    // 平台的 label 是**无障碍名**（不可见）⇒ 行里的可见说明另写一个 span；
                    // 少了它，界面上这一行只剩一个滑块，用户不知道它是什么（3b 走查发现）。
                    label: t('agent.snapshot'),
                }),
                h('span', { key: 'caption', style: STYLE.hint }, t('agent.snapshot')),
                h(HelpTip, {
                    key: 'help',
                    text: snapshotFixed === true ? `${t('agent.snapshotFixed')}\n${t('agent.snapshotHelp')}` : t('agent.snapshotHelp'),
                }),
            ]),
            // 装载区锁了就不给点：`pointerEvents` 比逐个控件传 `disabled` 改动小，
            // 而且这一块全是自己的按钮与菜单。
            h('div', {
                key: 'load',
                ...promptLocked === true ? { style: { pointerEvents: 'none' } } : {},
            }, [
                h(SetLoadSection, {
                    key: 'section',
                    kind: 'promptSets',
                    draft,
                    loadedIds: agent.promptSets,
                    onLoad: (setId) => onLoadSet('promptSets', setId),
                    onUnload: (index) => onUnloadSet('promptSets', index),
                    onMove: (index, delta) => onMoveSet('promptSets', index, delta),
                    onOpen: (setId) => onOpenSet('promptSets', setId),
                }),
            ]),
        ],
    })

    const toolSetsCard = h(ConfigCard, {
        key: 'toolSets',
        title: t('agent.toolSets'),
        hint: t('agent.toolSetsHint'),
        children: [
            h(SetLoadSection, {
                key: 'load',
                kind: 'toolSets',
                draft,
                loadedIds: agent.toolSets,
                onLoad: (setId) => onLoadSet('toolSets', setId),
                onUnload: (index) => onUnloadSet('toolSets', index),
                onMove: (index, delta) => onMoveSet('toolSets', index, delta),
                onOpen: (setId) => onOpenSet('toolSets', setId),
            }),
        ],
    })

    const skillSetsCard = h(ConfigCard, {
        key: 'skillSets',
        title: t('agent.skillSets'),
        hint: t('agent.skillSetsHint'),
        children: h(SetLoadSection, {
            key: 'load',
            kind: 'skillSets',
            draft,
            loadedIds: agent.skillSets,
            onLoad: (setId) => onLoadSet('skillSets', setId),
            onUnload: (index) => onUnloadSet('skillSets', index),
            onMove: (index, delta) => onMoveSet('skillSets', index, delta),
            onOpen: (setId) => onOpenSet('skillSets', setId),
        }),
    })

    const modelCard = h(ConfigCard, {
        key: 'model',
        title: t('agent.modelCard'),
        children: [
            // 「重试次数」放主模型上方（用户点名）：它是降级链的节拍器——
            // 每个候选各自重试到这个数才换下一个。
            h(FieldRow, {
                key: 'retryRow',
                label: t('model.maxRetries'),
                children: h(Input, {
                    key: 'retries',
                    type: 'number',
                    min: 0,
                    step: 1,
                    value: String(agent.maxRetries),
                    onChange: (event: ChangeEvent<HTMLInputElement>) => onPatch({ maxRetries: parseRetryCount(event.target.value) }),
                }),
            }),
            h(RouteRows, {
                key: 'picker',
                value: agent.model,
                models,
                warnings: modelWarnings,
                // 主代理是「后备形态」：平时用对话界面选的模型，它失败才轮到这条链。
                tail: h(HelpTip, { key: 'help', size: 'wide', text: t('model.primaryHelp') }),
                onChange: (model) => onPatch({ model }),
                onLoadEfforts,
            }),
            h(FieldRow, {
                key: 'backgroundRow',
                label: t('agent.background'),
                style: { marginTop: '6px' },
                children: h(Choice<BackgroundMode>, {
                    key: 'choice',
                    options: choiceOptions(BACKGROUND_MODES, t),
                    value: agent.background,
                    onChange: (background) => onPatch({ background }),
                }),
            }),
            h('div', { key: 'backgroundHint', style: STYLE.hint }, t('agent.backgroundHint')),
            // 备用模型排卡片最后（用户 2026-09-19 点名）：主模型与后台模式是常设项，
            // 降级链是失败兜底，读完主设置再读它。
            h(FallbackList, {
                key: 'fallbacks',
                rows: agent.fallbacks,
                models,
                onChange: (fallbacks) => onPatch({ fallbacks }),
                onLoadEfforts,
            }),
        ],
    })

    const childrenCard = h(ConfigCard, {
        key: 'children',
        title: t('agent.children'),
        hint: t('agent.childrenHint'),
        children: h(ChildPicker, {
            key: 'picker',
            agent,
            draft,
            onToggle: (childId, attached) => onPatch({
                children: attached
                    ? agent.children.filter((candidate) => candidate !== childId)
                    : [...agent.children, childId],
            }),
        }),
    })

    return h('div', null, [identityCard, promptSetsCard, toolSetsCard, skillSetsCard, modelCard, childrenCard])
}

/**
 * 一组集的装载区：已装列表（可调序、卸载、跳转编辑）＋ 未装候选（点击装载）。
 *
 * @param props - `{ kind, draft, loadedIds, onLoad, onUnload, onMove, onOpen }`。
 */
export function SetLoadSection(props: SetLoadSectionProps) {
    const { kind, draft, loadedIds, onLoad, onUnload, onMove, onOpen } = props
    const t = useT()
    const pool = poolOf(draft, kind)
    const noun = nounOf(kind, t)

    const loadedRows = loadedIds.map((setId, index) => {
        const set = pool.find((candidate) => candidate.id === setId)
        const isTop = index === 0
        const isBottom = index === loadedIds.length - 1

        // 尺寸文案分单复数两档：中文一样，英文「1 sections」读着别扭。
        let sizeText = null
        if (set !== undefined) {
            if (kind === 'promptSets') sizeText = t(set.sections.length === 1 ? 'load.count.sectionOne' : 'load.count.sections', { count: set.sections.length })
            else if (kind === 'toolSets') sizeText = t(set.tools.length === 1 ? 'load.count.toolOne' : 'load.count.tools', { count: set.tools.length })
            else sizeText = t(set.skills.length === 1 ? 'load.count.skillOne' : 'load.count.skills', { count: set.skills.length })
        }

        return h('div', { key: `${setId}-${index}`, style: STYLE.rowNowrap }, [
            h('span', { key: 'name', style: STYLE.ellipsisFit },
                set === undefined ? t('load.deletedSet', { id: setId }) : setLabel(set, t)),
            h('span', { key: 'count', style: STYLE.hintEllipsis }, sizeText),
            h('span', { key: 'spacer', style: ROW_SPACER }),
            ...moveButtons({ isTop, isBottom, onMove: (delta) => onMove(index, delta) }, t),
            set === undefined ? null : h(Button, {
                key: 'open',
                type: 'button',
                variant: 'outline',
                size: 'sm',
                style: ROW_TAIL,
                onClick: () => onOpen(setId),
            }, t('common.edit')),
            h(Button, {
                key: 'unload',
                type: 'button',
                size: 'sm',
                style: ROW_TAIL,
                onClick: () => onUnload(index),
            }, t('common.remove')),
        ])
    })

    const candidates = pool.filter((set) => !loadedIds.includes(set.id))
    const candidateRow = h(CandidateRow, {
        key: 'candidates',
        label: t('load.canLoad'),
        items: candidates.map((set) => ({
            id: set.id,
            label: setLabel(set, t),
            title: t('load.loadTitle', { set: setLabel(set, t) }),
        })),
        onPick: onLoad,
    })

    const emptyHint = loadedIds.length === 0
        ? h('div', { key: 'empty', style: STYLE.hint },
            pool.length === 0
                ? t('load.emptyPool', { noun })
                : t('load.emptyLoaded', { noun }))
        : null

    return h('div', null, [emptyHint, loadedRows, candidateRow])
}

/**
 * 子代理名册的挑选区：已挂列表（可移除）＋ 未挂候选（点击挂上）。
 * @param props - `{ agent, draft, onToggle }`。
 */
export function ChildPicker(props: ChildPickerProps) {
    const { agent, draft, onToggle } = props
    const t = useT()

    const attachedRows = agent.children.map((childId) => {
        const child = draft.agents.find((candidate) => candidate.id === childId)

        return h('div', { key: childId, style: STYLE.rowNowrap }, [
            h('span', { key: 'name', style: STYLE.ellipsisFit },
                child === undefined ? t('child.deletedAgent', { id: childId }) : agentLabel(child, t)),
            child === undefined ? null : h('span', { key: 'note', style: STYLE.hintEllipsis },
                child.note),
            h('span', { key: 'spacer', style: ROW_SPACER }),
            h(Button, {
                key: 'remove',
                type: 'button',
                size: 'sm',
                style: ROW_TAIL,
                onClick: () => onToggle(childId, true),
            }, t('common.remove')),
        ])
    })

    const candidates = draft.agents.filter(
        (candidate) => candidate.id !== agent.id && !agent.children.includes(candidate.id),
    )
    const candidateRow = h(CandidateRow, {
        key: 'candidates',
        label: t('child.canAttach'),
        items: candidates.map((candidate) => ({ id: candidate.id, label: agentLabel(candidate, t) })),
        onPick: (childId) => onToggle(childId, false),
    })

    const emptyHint = agent.children.length === 0
        ? h('div', { key: 'empty', style: STYLE.hint }, t('child.empty'))
        : null

    return h('div', null, [emptyHint, attachedRows, candidateRow])
}

// ── 主区：集库 ──────────────────────────────────────────────────────────

/**
 * 集库的通用骨架：集列表（新建/复制/删除）＋选中集的编辑器。
 *
 * 提示词集库与工具集库只有编排不同（编辑器是段清单 vs 工具勾选），
 * 列表与操作这一套完全一样，抽成一个组件、编辑器由 `renderEditor` 传入。
 *
 * @param props - `{ kind, draft, selectionId, onSelect, onAdd, onDuplicate, onRemove, onPatch, renderEditor }`。
 */
/**
 * 池编辑区顶部的三个按钮：新建 / 复制 / 删除。
 *
 * 三个池共用同一套（第十三轮用户反馈：「新添复制删除按钮在对应的右侧顶部」）；
 * 池为空时右侧也只剩这三个按钮（复制/删除置灰）。
 */
export function PoolActions(props: PoolActionsProps) {
    const { noun, canCopy, canRemove, onAdd, onDuplicate, onRemove } = props
    const t = useT()

    return h('div', { key: 'poolActions', style: { ...STYLE.row, marginBottom: '6px' } }, [
        h(Button, { key: 'add', type: 'button', variant: 'primary', onClick: onAdd }, t('set.add', { noun })),
        h(Button, {
            key: 'duplicate',
            type: 'button',
            variant: 'outline',
            onClick: onDuplicate,
            disabled: canCopy !== true,
            title: t('set.copyTitle', { noun }),
        }, t('common.copy')),
        h(Button, {
            key: 'remove',
            type: 'button',
            onClick: onRemove,
            disabled: canRemove !== true,
            title: t('set.removeTitle', { noun }),
        }, t('common.delete')),
    ])
}

/**
 * 集编辑器：选中集的身份 + 正文编辑器。
 *
 * 集列表住在左栏（二级菜单），这里只管「选中那一个」——三个池的编辑区因此长得一样：
 * 顶部一排按钮（`PoolActions`）+ 一张编辑卡。
 */
export function SetEditorCard(props: SetEditorCardProps) {
    const { kind, set, idReferenceText, onPatch, onRenameId, renderEditor } = props
    const t = useT()

    // 提示词集这一档不给说明（`bodyHint` 留 undefined）：段编辑器自己带了引子，
    // 卡片说明只会跟它重复一遍。
    let bodyHint: string | undefined = t('set.skillHint')
    if (kind === 'promptSets') bodyHint = undefined
    else if (kind === 'toolSets') bodyHint = t('set.toolHint')

    return h(ConfigCard, {
        key: 'editor',
        title: t('set.editorTitle', { set: setLabel(set, t) }),
        hint: bodyHint,
        children: [
            h(IdEditor, {
                key: 'id',
                id: set.id,
                referenceText: idReferenceText,
                onRename: (newId) => onRenameId(set.id, newId),
            }),
            h(FieldRow, {
                key: 'nameRow',
                label: t('common.name'),
                children: h(Input, {
                    key: 'name',
                    type: 'text',
                    value: set.name,
                    placeholder: set.id,
                    onChange: (event: ChangeEvent<HTMLInputElement>) => onPatch(set.id, { name: event.target.value }),
                }),
            }),
            h(FieldRow, {
                key: 'noteRow',
                label: t('common.note'),
                children: h(Input, {
                    key: 'note',
                    type: 'text',
                    value: set.note,
                    placeholder: t('set.notePlaceholder'),
                    onChange: (event: ChangeEvent<HTMLInputElement>) => onPatch(set.id, { note: event.target.value }),
                }),
            }),
            renderEditor(set),
        ],
    })
}
