/**
 * 模型选择与自动降级：主模型与备用候选共用的三级联动三行，以及备用候选的调序与增删。
 *
 * @module dsh-agent-studio/client-parts/panel-routes
 */
import * as React from 'react'
import type { CSSProperties } from 'react'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { Button, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { FAINT_LINE, ROW_SPACER, ROW_TAIL, STYLE } from '../styles'
import { useT } from './panel-translate'
import type { EffortState, FallbackListProps, RouteRowsProps } from './panel-types'
import { DEFAULT_RETRIES } from './panel-constants'
import { FieldRow, h, menuAnchor, moveButtons } from './panel-widgets'

const { useEffect, useState } = React

// ── 模型选择与自动降级 ──────────────────────────────────────────────────

/**
 * 三级联动三行：供应商 / 模型 / 思考强度。主模型与每个备用候选共用这一份
 * （2026-09-19 用户点名：三级联动抽成可复用组件，两边共用）。
 *
 * 档位集合随模型变（见 `lib/models.js`），所以选中模型后立刻现问 host，
 * 读到的直接进「思考强度」下拉——不让用户再点一次按钮。读失败就落在卡片里。
 *
 * @param props - `{ value, models, warnings, tail, onChange, onLoadEfforts }`。
 */
export function RouteRows(props: RouteRowsProps) {
    const { value, models, warnings, tail, onChange, onLoadEfforts } = props
    const t = useT()
    const [effortsState, setEffortsState] = useState<EffortState>({ status: 'idle' })
    /** 三档下拉（`Menu`）各自的展开态。 */
    const [providerOpen, setProviderOpen] = useState(false)
    const [modelOpen, setModelOpen] = useState(false)
    const [effortOpen, setEffortOpen] = useState(false)

    const providerOptions = models.map((provider) => ({ id: provider.id, label: provider.name ?? provider.id }))
    const selectedProvider = models.find((provider) => provider.id === value?.provider)
    const modelOptions = (selectedProvider?.models ?? []).map((model) => ({ id: model.id, label: model.name ?? model.id }))

    const effortProvider = value?.provider
    const effortModel = value?.model

    useEffect(() => {
        if (effortProvider === undefined || effortModel === undefined) {
            setEffortsState({ status: 'idle' })
            return
        }

        setEffortsState({ status: 'busy' })

        async function load() {
            try {
                const list = await onLoadEfforts(effortProvider as string, effortModel as string)
                setEffortsState({ status: 'ok', list })

            } catch (err) {
                setEffortsState({ status: 'failed', message: (err as Error).message })
            }
        }

        load()
    }, [effortProvider, effortModel])

    const effortOptions = (effortsState.list ?? []).map((effort) => ({ id: effort.id, label: effort.name ?? effort.id }))

    let effortPlaceholder = t('model.effortDefault')
    if (effortProvider === undefined || effortModel === undefined) effortPlaceholder = t('model.pickModelFirst')
    else if (effortsState.status === 'busy') effortPlaceholder = t('model.loadingEfforts')
    else if (effortsState.status === 'failed') effortPlaceholder = t('model.effortsFailed')
    else if (effortOptions.length === 0) effortPlaceholder = t('model.noEfforts')

    // 三档的菜单条目与触发按钮上的显示名。空 id（`''`）就是「没选」那一条，
    // 语义与原来的 `<select>` 空选项一致：选它 = 写回 undefined（继承本会话）。
    const providerItems: MenuEntry[] = [
        { id: '', label: t('model.inherit') },
        ...providerOptions.map((option) => ({ id: option.id, label: option.label })),
    ]
    const modelItems: MenuEntry[] = [
        { id: '', label: t('model.inherit') },
        ...modelOptions.map((option) => ({ id: option.id, label: option.label })),
    ]
    const effortItems: MenuEntry[] = [
        { id: '', label: effortPlaceholder },
        ...effortOptions.map((option) => ({ id: option.id, label: option.label })),
    ]

    const providerChoice = providerOptions.find((option) => option.id === value?.provider)
    const modelChoice = modelOptions.find((option) => option.id === value?.model)
    const effortChoice = effortOptions.find((option) => option.id === value?.reasoningEffort)
    const providerText = providerChoice === undefined ? t('model.inherit') : providerChoice.label
    const modelText = modelChoice === undefined ? t('model.inherit') : modelChoice.label
    const effortText = effortChoice === undefined ? effortPlaceholder : effortChoice.label

    return h('div', null, [
        h(FieldRow, {
            key: 'providerRow',
            label: t('model.provider'),
            // 「?」浮层挂在第一行行尾（主模型那份才有）：说明主代理的后备形态。
            ...tail === undefined ? {} : { tail },
            children: h(Menu, {
                // `FieldRow` 把 children 摊成数组渲染，数组元素没 key 会触发
                // React 的 "unique key" 警告（单元素数组也一样报）。
                key: 'menu',
                open: providerOpen,
                anchor: menuAnchor({
                    open: providerOpen,
                    text: providerText,
                    onClick: () => setProviderOpen(!providerOpen),
                }),
                items: providerItems,
                selectedId: value?.provider === undefined ? '' : value.provider,
                onSelect: (id: string) => {
                    onChange({ provider: id === '' ? undefined : id, model: undefined, reasoningEffort: undefined })
                    setProviderOpen(false)
                },
                onClose: () => setProviderOpen(false),
                side: 'bottom',
                portal: true,
            }),
        }),
        h(FieldRow, {
            key: 'modelRow',
            label: t('model.model'),
            children: h(Menu, {
                key: 'menu',
                open: modelOpen,
                anchor: menuAnchor({
                    open: modelOpen,
                    text: modelText,
                    disabled: selectedProvider === undefined,
                    onClick: () => setModelOpen(!modelOpen),
                }),
                items: modelItems,
                selectedId: value?.model === undefined ? '' : value.model,
                onSelect: (id: string) => {
                    onChange({ ...value, model: id === '' ? undefined : id, reasoningEffort: undefined })
                    setModelOpen(false)
                },
                onClose: () => setModelOpen(false),
                side: 'bottom',
                portal: true,
            }),
        }),
        h(FieldRow, {
            key: 'effortRow',
            label: t('model.effort'),
            children: h(Menu, {
                key: 'menu',
                open: effortOpen,
                anchor: menuAnchor({
                    open: effortOpen,
                    text: effortText,
                    disabled: effortOptions.length === 0,
                    onClick: () => setEffortOpen(!effortOpen),
                }),
                items: effortItems,
                selectedId: value?.reasoningEffort === undefined ? '' : value.reasoningEffort,
                onSelect: (id: string) => {
                    onChange({ ...value, reasoningEffort: id === '' ? undefined : id })
                    setEffortOpen(false)
                },
                onClose: () => setEffortOpen(false),
                side: 'bottom',
                portal: true,
            }),
        }),
        effortsState.status === 'failed'
            ? h('div', { key: 'failed', style: STYLE.error }, t('model.effortsError', { message: effortsState.message ?? '' }))
            : null,
        warnings === undefined || warnings.length === 0 ? null : h('div', { key: 'warnings', style: STYLE.warning },
            t('model.warnings', { list: warnings.join(t('common.clauseSep')) })),
    ])
}

/**
 * 备用候选列表：每行一个三级联动 + 调序（↑↓）+ 移除，可「+ 添加」。
 *
 * 顺序就是降级顺序——第一行最先顶上；一个候选都没有 = 自动降级不接管
 * （重试行为与平台默认一致）。调序与技能集的装载行同一套观感。
 *
 * @param props - `{ rows, models, onChange, onLoadEfforts }`。
 */
export function FallbackList(props: FallbackListProps) {
    const { rows, models, onChange, onLoadEfforts } = props
    const t = useT()

    /** 调序 / 移除 / 追加都按「整体替换」写回，与草稿层的数组语义一致。 */
    function moveRow(index: number, delta: number) {
        const target = index + delta
        if (target < 0 || target >= rows.length) return

        const next = rows.slice()
        const [moved] = next.splice(index, 1)
        next.splice(target, 0, moved)
        onChange(next)
    }

    const rowNodes = rows.map((row, index) => h('div', {
        key: `fallback-${index}`,
        style: { marginTop: '8px', paddingTop: '6px', borderTop: FAINT_LINE },
    }, [
        h('div', { key: 'head', style: STYLE.rowNowrap }, [
            h('span', { key: 'label', style: STYLE.hintEllipsis },
                t('model.fallbackIndex', { index: index + 1 })),
            h('span', { key: 'spacer', style: ROW_SPACER }),
            ...moveButtons({
                isTop: index === 0,
                isBottom: index === rows.length - 1,
                onMove: (delta) => moveRow(index, delta),
            }, t),
            h(Button, {
                key: 'remove',
                type: 'button',
                size: 'sm',
                style: ROW_TAIL,
                onClick: () => onChange(rows.filter((_row, position) => position !== index)),
            }, t('common.remove')),
        ]),
        h(RouteRows, {
            key: 'route',
            value: row,
            models,
            onChange: (next) => onChange(rows.map((candidate, position) => (position === index ? next : candidate))),
            onLoadEfforts,
        }),
    ]))

    return h('div', { style: { marginTop: '10px' } }, [
        h('div', { key: 'head', style: STYLE.rowNowrap }, [
            h('span', { key: 'label', style: { ...STYLE.hint, fontWeight: '600', flex: '0 1 auto', minWidth: '0' } },
                t('model.fallbacks')),
            h('span', { key: 'spacer', style: ROW_SPACER }),
            h(Button, {
                key: 'add',
                type: 'button',
                size: 'sm',
                style: ROW_TAIL,
                onClick: () => onChange([...rows, { provider: undefined, model: undefined, reasoningEffort: undefined }]),
            }, t('model.addFallback')),
        ]),
        rows.length === 0
            ? h('div', { key: 'empty', style: STYLE.hint }, t('model.fallbacksEmpty'))
            : null,
        ...rowNodes,
    ])
}

/** 重试次数的输入解析：非负整数才收（空/坏值退回默认），与 host 的 `retryLimit` 同口径。 */
export function parseRetryCount(text: string): number {
    const value = Number.parseInt(text, 10)
    if (Number.isSafeInteger(value) === false || value < 0) return DEFAULT_RETRIES

    return value
}
