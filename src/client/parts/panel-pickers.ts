/**
 * 工具清单与技能清单两个多选选择器，共用一份折叠组头。
 *
 * @module dsh-agent-studio/client-parts/panel-pickers
 */
import * as React from 'react'
import type { ChangeEvent } from 'react'
import {
    Button,
    Checkbox,
    IconChevronDownOutlineRegular,
    IconChevronUpOutlineRegular,
    Input,
    Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { STYLE, INLINE_ROW, ROW_TAIL, TREE_INDENT } from '../styles'
import { useT } from './panel-translate'
import type { ToolRow, SkillRowOut, GroupHeadProps, ToolPickerProps, SkillPickerProps } from './panel-types'
import { REQUIRED_TOOLS, SKILL_SOURCE_KEYS } from './panel-constants'
import { h } from './panel-widgets'

const { useState } = React

// ── 清单树的组头 ────────────────────────────────────────────────────────

/**
 * 工具 / 技能清单共用的组头行：折叠开关 + 组勾选框 + 「已勾 / 可勾」计数。
 *
 * **自绘，不用平台 `DisclosureRow`**：平台件的方向与面板约定相反——展开态固定画
 * 「下箭头」，收起态在没给 `icon` 时干脆不画（悬停才浮出一个下箭头）。2026-09-19
 * 用户报「收起后箭头消失、看着全是下箭头」，而面板从段清单起就定了「展开朝上 /
 * 收起朝下」（见 `pickerRow` 的注释），这里对齐同一套。尺寸照抄平台行
 * （`STYLE.groupRow`），二级行的 `TREE_INDENT` 仍与这里最左的勾选框落在同一条竖线。
 *
 * 折叠只由最左的箭头触发（点勾选框与计数都不会误折叠）；`data-disclosure-row`
 * 是自检的定位锚点——原来由平台件自带，`tests/helpers.ts` 的 `取分组行` 认它。
 *
 * @param props - `{ name, count, allChecked, folded, onChange, onToggle }`。
 */
export function GroupHead(props: GroupHeadProps) {
    const { name, count, allChecked, folded, onChange, onToggle } = props
    const t = useT()

    return h('div', { 'data-disclosure-row': true, style: STYLE.groupRow }, [
        h('button', {
            key: 'fold',
            type: 'button',
            style: STYLE.groupChevron,
            'aria-expanded': folded !== true,
            'aria-label': t(folded === true ? 'section.expand' : 'section.collapse'),
            onClick: onToggle,
        }, h(folded === true ? IconChevronDownOutlineRegular : IconChevronUpOutlineRegular, { key: 'icon', size: 14 })),
        h('span', { key: 'title', style: INLINE_ROW }, [
            h(Checkbox, {
                key: 'check',
                // 部分勾选不画中间态（要碰 DOM 才有 indeterminate，平台件也不给），
                // 由右边「已勾 / 可勾」交代；组框只表达「整组都在」。
                checked: allChecked,
                onChange,
                label: name,
            }),
            h('span', { key: 'count' }, count),
        ]),
    ])
}

// ── 工具清单 ────────────────────────────────────────────────────────────

/**
 * 工具清单：按来源分组、可折叠、可勾选（勾 = 保留）。
 *
 * v2 全显示全可勾：没有变灰、没有隐藏、没有原因标注——「能不能生效」由宿主在翻译
 * 成平台参数时按平台能力过滤（见 `apply.js`），界面不替它下结论。
 *
 * @param props - `{ rows, owners, onChange }`；`rows` 由 `toolRowsFor` 产出，
 *   `owners` 是名字 → 来源（观察层采的，可能没有）。
 */
export function ToolPicker(props: ToolPickerProps) {
    const { rows, owners, onChange } = props
    const t = useT()
    const [foldedOwners, setFoldedOwners] = useState<string[]>([])
    /** 搜索词：名字多起来（MCP 一接就是几十个）后，靠它快速找到目标。 */
    const [search, setSearch] = useState('')

    const checkedNames = rows.filter((row) => row.checked).map((row) => row.name)
    const query = search.trim().toLowerCase()
    const visibleRows = query === '' ? rows : rows.filter((row) => row.name.toLowerCase().includes(query))
    const hasUnchecked = visibleRows.some((row) => row.checked !== true)

    function toggle(name: string, checked: boolean) {
        onChange(checked
            ? [...new Set([...checkedNames, name])]
            : checkedNames.filter((candidate) => candidate !== name))
    }

    /** 整组勾上或整组取消：组的勾选框与单行走同一条路。 */
    function toggleGroup(groupRows: ToolRow[], checked: boolean) {
        const names = groupRows.map((row) => row.name)

        onChange(checked
            ? [...new Set([...checkedNames, ...names])]
            : checkedNames.filter((candidate) => !names.includes(candidate)))
    }

    function fold(owner: string) {
        setFoldedOwners(foldedOwners.includes(owner)
            ? foldedOwners.filter((name) => name !== owner)
            : [...foldedOwners, owner])
    }

    const countText = query === ''
        ? t('count.kept', { checked: checkedNames.length, total: rows.length })
        : t('count.filtered', { visible: visibleRows.length, total: rows.length, checked: checkedNames.length })

    // 按来源分组，组名来自观察层采的 `owners`（`lib/attribution.js` 在注册时刻记的
    // 注册者）；**MCP 工具按服务器名单独分组**（名字形如 `mcp__server__tool`，一个
    // server 一勾就是一批）；归不到的名字并进「其他来源」——不编造出处。
    // 来源全缺时就只剩一个组，那便平铺，不摆一行什么也没分的组头。
    // 组名是**显示用**的字符串，MCP 组的判别靠同一个前缀（两种语言下都成立）。
    const mcpPrefix = t('tool.mcpPrefix')
    const groupOf = (row: ToolRow) => {
        if (row.name.startsWith('mcp__')) {
            const serverName = row.name.split('__')[1]

            return `${mcpPrefix}${serverName === undefined || serverName === '' ? t('tool.unknownServer') : serverName}`
        }

        return owners?.[row.name] ?? t('tool.otherSource')
    }

    const groups = new Map<string, ToolRow[]>()
    for (const row of visibleRows) {
        const owner = groupOf(row)
        const groupRows = groups.get(owner) ?? []
        groupRows.push(row)
        groups.set(owner, groupRows)
    }
    // 排序：**MCP 组排最前**（接一个 MCP 就是几十个工具，一勾一批，用户先找它们），
    // MCP 之间按服务器名排；其余组照旧按名称字典序。
    const groupList = [...groups.entries()].sort(([left], [right]) => {
        const leftMcp = left.startsWith(mcpPrefix)
        const rightMcp = right.startsWith(mcpPrefix)
        if (leftMcp !== rightMcp) return leftMcp ? -1 : 1

        return left.localeCompare(right)
    })

    const rowNode = (row: ToolRow) => {
        // 必备工具（见 REQUIRED_TOOLS）：勾选框锁死。取消它的那几个入口（单行取消 /
        // 组头取消 / 「全不选」）在草稿层还会再兜一道 `ensureRequiredTools`——这里锁的是界面。
        const isRequired = REQUIRED_TOOLS.includes(row.name)

        return h('div', {
            key: row.name,
            // 二级行缩进：与组头 checkbox 同一条竖线（见 TREE_INDENT）。
            style: { ...STYLE.row, paddingLeft: TREE_INDENT },
        }, [
            h(Checkbox, {
                key: 'check',
                checked: isRequired === true ? true : row.checked,
                disabled: isRequired,
                onChange: (next: boolean) => toggle(row.name, next),
                label: row.name,
            }),
            // 必备标记：`Tag` 不吃 style（文字 nowrap），包一层才不会被压。
            isRequired === false ? null : h('span', {
                key: 'required',
                style: { display: 'inline-flex', ...ROW_TAIL, marginLeft: '6px' },
                title: t('tool.requiredTitle'),
            }, h(Tag, { tone: 'outline' }, t('tool.requiredTag'))),
        ])
    }

    const groupNode = ([owner, groupRows]: [string, ToolRow[]]) => {
        const picked = groupRows.filter((row) => row.checked).length
        const isFolded = foldedOwners.includes(owner)

        const head = h(GroupHead, {
            key: 'head',
            name: owner,
            count: `${picked}/${groupRows.length}`,
            allChecked: groupRows.length > 0 && picked === groupRows.length,
            folded: isFolded,
            onChange: (next: boolean) => toggleGroup(groupRows, next),
            onToggle: () => fold(owner),
        })

        // 折叠 = 组内行不渲染（与平台件同行为），不是藏起来。
        return h('div', { key: owner }, [head, ...(isFolded === true ? [] : groupRows.map(rowNode))])
    }

    const listNodes = groupList.length <= 1 ? visibleRows.map(rowNode) : groupList.map(groupNode)
    const hasMcp = rows.some((row) => row.name.startsWith('mcp__'))

    return h('div', null, [
        h('div', { key: 'tools', style: STYLE.row }, [
            h(Input, {
                key: 'search',
                type: 'text',
                value: search,
                placeholder: t('tool.searchPlaceholder'),
                onChange: (event: ChangeEvent<HTMLInputElement>) => setSearch(event.target.value),
            }),
            h(Button, {
                key: 'all',
                type: 'button',
                onClick: () => onChange([...new Set([...checkedNames, ...visibleRows.map((row) => row.name)])]),
                disabled: hasUnchecked === false,
            }, t('common.selectAll')),
            h(Button, {
                key: 'none',
                type: 'button',
                onClick: () => onChange(checkedNames.filter((name) => !visibleRows.some((row) => row.name === name))),
                disabled: checkedNames.length === 0,
            }, t('common.selectNone')),
            h('span', { key: 'count', style: STYLE.hint }, countText),
        ]),

        h('div', { key: 'list' }, listNodes.length === 0
            ? h('div', { key: 'noMatch', style: STYLE.hint }, t('tool.noMatch'))
            : listNodes),

        // 必备工具与必备段同理：先解释一句，否则「勾选框点不动」看着像坏了。
        h('div', { key: 'requiredHint', style: { ...STYLE.hint, marginTop: '4px' } },
            t('tool.requiredHint')),

        // MCP 工具本来就是工具、按服务器名分组显示在这份清单里；没有就什么都不出现——
        // 不说一句的话，用户会以为「MCP 集」没做（2026-09-17 用户反馈）。
        hasMcp === true ? null : h('div', { key: 'mcpHint', style: { ...STYLE.hint, marginTop: '4px' } },
            t('tool.mcpHint')),
    ])
}

// ── 技能清单 ────────────────────────────────────────────────────────────

/**
 * 技能清单：按来源分组、可折叠、可勾选（勾 = 保留）。
 *
 * 与工具清单同一套原则（全显示、全可勾）：勾中的 skill 照常放行，没勾的对
 * **模型**隐藏——但你在输入框仍能手调它们（菜单会标「仅用户」）。
 *
 * 分组键是技能的来源（`source`，平台扫描根的标识，见表）；一个可认的来源都
 * 没有时退化成平铺——不摆没有信息量的组头，同工具清单的「来源全缺」一策。
 *
 * @param props - `{ rows, onChange }`；`rows` 由 `skillRowsFor` 产出。
 */
export function SkillPicker(props: SkillPickerProps) {
    const { rows, onChange } = props
    const t = useT()
    const [foldedGroups, setFoldedGroups] = useState<string[]>([])
    const [search, setSearch] = useState('')

    const checkedNames = rows.filter((row) => row.checked).map((row) => row.name)
    const query = search.trim().toLowerCase()
    const visibleRows = query === '' ? rows : rows.filter((row) => row.name.toLowerCase().includes(query))
    const hasUnchecked = visibleRows.some((row) => row.checked !== true)

    function toggle(name: string, checked: boolean) {
        onChange(checked
            ? [...new Set([...checkedNames, name])]
            : checkedNames.filter((candidate) => candidate !== name))
    }

    /** 整组勾上或整组取消：组的勾选框与单行走同一条路。 */
    function toggleGroup(groupRows: SkillRowOut[], checked: boolean) {
        const names = groupRows.map((row) => row.name)

        onChange(checked
            ? [...new Set([...checkedNames, ...names])]
            : checkedNames.filter((candidate) => !names.includes(candidate)))
    }

    function fold(group: string) {
        setFoldedGroups(foldedGroups.includes(group)
            ? foldedGroups.filter((name) => name !== group)
            : [...foldedGroups, group])
    }

    // 组键 = 来源的显示名；认不出的来源原样显示，没有来源的归「（无来源信息）」。
    // 组按显示名字典序排，不做优先级推断。
    const unknownGroup = t('skill.unknownSource')
    const groupOf = (row: SkillRowOut) => {
        if (typeof row.source !== 'string' || row.source === '') return unknownGroup

        const sourceKey = SKILL_SOURCE_KEYS[row.source]

        return sourceKey === undefined ? row.source : t(sourceKey)
    }

    const groups = new Map<string, SkillRowOut[]>()
    for (const row of visibleRows) {
        const group = groupOf(row)
        const groupRows = groups.get(group) ?? []
        groupRows.push(row)
        groups.set(group, groupRows)
    }
    const groupList = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))
    const hasSources = groupList.some(([group]) => group !== unknownGroup)

    const rowNode = (row: SkillRowOut) => h('div', {
        key: row.name,
        // 二级行缩进：与组头 checkbox 同一条竖线（见 TREE_INDENT）。
        style: { ...STYLE.rowNowrap, paddingLeft: TREE_INDENT },
    }, [
        // 技能名原来「不缩」（`0 0 auto`）：名字进 `label` 后自身不可控，改由外层
        // 包装收住——除不缩外还要 `nowrap`，窄窗口里名字折行会撑高整行。
        h('span', {
            key: 'name',
            style: { display: 'inline-flex', flex: 'none', whiteSpace: 'nowrap' },
        }, h(Checkbox, {
            checked: row.checked,
            onChange: (next: boolean) => toggle(row.name, next),
            label: row.name,
        })),
        h('span', {
            key: 'description',
            style: { ...STYLE.hintGrow, ...STYLE.ellipsis },
            title: row.description,
        }, row.description),
    ])

    const groupNode = ([group, groupRows]: [string, SkillRowOut[]]) => {
        const picked = groupRows.filter((row) => row.checked).length
        const isFolded = foldedGroups.includes(group)

        const head = h(GroupHead, {
            key: 'head',
            name: group,
            count: `${picked}/${groupRows.length}`,
            allChecked: groupRows.length > 0 && picked === groupRows.length,
            folded: isFolded,
            onChange: (next: boolean) => toggleGroup(groupRows, next),
            onToggle: () => fold(group),
        })

        return h('div', { key: group }, [head, ...(isFolded === true ? [] : groupRows.map(rowNode))])
    }

    const listNodes = hasSources ? groupList.map(groupNode) : visibleRows.map(rowNode)

    return h('div', null, [
        h('div', { key: 'skills', style: STYLE.row }, [
            h(Input, {
                key: 'search',
                type: 'text',
                value: search,
                placeholder: t('skill.searchPlaceholder'),
                onChange: (event: ChangeEvent<HTMLInputElement>) => setSearch(event.target.value),
            }),
            h(Button, {
                key: 'all',
                type: 'button',
                onClick: () => onChange([...new Set([...checkedNames, ...visibleRows.map((row) => row.name)])]),
                disabled: hasUnchecked === false,
            }, t('common.selectAll')),
            h(Button, {
                key: 'none',
                type: 'button',
                onClick: () => onChange(checkedNames.filter((name) => !visibleRows.some((row) => row.name === name))),
                disabled: checkedNames.length === 0,
            }, t('common.selectNone')),
            h('span', { key: 'count', style: STYLE.hint },
                query === ''
                    ? t('count.kept', { checked: checkedNames.length, total: rows.length })
                    : t('count.filtered', { visible: visibleRows.length, total: rows.length, checked: checkedNames.length })),
        ]),

        h('div', { key: 'list' }, rows.length === 0
            ? h('div', { key: 'cold', style: STYLE.hint }, t('skill.coldHint'))
            : visibleRows.length === 0
                ? h('div', { key: 'noMatch', style: STYLE.hint }, t('skill.noMatch'))
                : listNodes),

        // 同名技能为什么会「只有一个」：解释清单的形态（被遮蔽的候选平台不报）。
        // 名字与组头一一对应（见 SKILL_SOURCE_KEYS）。
        // 编号列表而不是一句长串：六档优先级挤在一行里没人读得下去（`STYLE.hint`
        // 的 `pre-line` 负责断行）。
        h('div', { key: 'rankHint', style: { ...STYLE.hint, marginTop: '4px' } }, t('skill.rankHint')),
    ])
}
