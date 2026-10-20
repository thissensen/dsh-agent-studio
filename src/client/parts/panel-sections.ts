/**
 * 提示词集编辑器的正文：段怎么分组与预览、段里的 id 怎么改（含引用守卫），以及装载浮层。
 *
 * @module dsh-agent-studio/client-parts/panel-sections
 */
import * as React from 'react'
import type { ChangeEvent } from 'react'
import {
    Button,
    Checkbox,
    IconChevronDownOutlineRegular,
    IconChevronUpOutlineRegular,
    Input,
    Modal,
    Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { CopyKey, Translate } from '../locales'
import { STYLE, ROW_SPACER, ROW_TAIL } from '../styles'
import { useT } from './panel-translate'
import type {
    Draft,
    DraftItem,
    DraftSection,
    PlatformSection,
    PoolKind,
    SetKind,
    SectionPickerState,
    IdEditorProps,
    SectionEditorProps,
} from './panel-types'
import { PTC_REQUIRED_SECTIONS } from './panel-constants'
import { DEFAULT_NAME_KEYS, pickDefaultName, agentLabel } from './panel-draft'
import { h, FieldRow, HelpTip, moveButtons, formButtons } from './panel-widgets'

const { useState } = React

/**
 * 平台预设按「关键度」分组——用户要挑哪些段留下时，先看到最不该丢的。
 *
 * 分类只按段名（各插件注册时的名字空间前缀），不读正文、不猜内容；
 * 认不出的名字归「其他」，绝不编造用途。
 */
const SECTION_GROUP_RULES: { titleKey: CopyKey; test: (name: string) => boolean }[] = [
    { titleKey: 'section.group.persona', test: (name) => name === 'harness:identity' || name.startsWith('deployment:persona') },
    { titleKey: 'section.group.toolGuide', test: (name) => name.startsWith('tool:') },
    { titleKey: 'section.group.toolMode', test: (name) => name.startsWith('tools:') },
    { titleKey: 'section.group.runtime', test: (name) => name.startsWith('context:') || name.startsWith('app:') || name.startsWith('harness:') || name.startsWith('ui:') || name.startsWith('plan:') },
]

/**
 * PTC 模式专属的两个段——它们由工具服务在 `presentAs('ptc')` 时注册，
 * 正文**随每次装配动态生成**（写死在提示词集里反而会过期）：
 *
 *  - `tools:ptc-only`：声明「只能用 run_code 调用工具」这条规则；
 *  - `tools:sdk`：把当前工具目录渲染成 run_code 的 SDK 声明。
 *
 * 覆盖语义下，**排除它们 = PTC 直接哑掉**（模型不知道要写 run_code、
 * 也看不到任何工具），所以行里带一句提醒。
 */
const PTC_SECTION_NOTE_KEYS: Record<string, CopyKey> = {
    'tools:ptc-only': 'section.ptcOnlyNote',
    'tools:sdk': 'section.sdkNote',
}

/**
 * id 编辑行：平时显示 `id 值 +「修改」按钮`；展开后是输入框 + 确定/取消，
 * 并把「谁在引用它」摆在下面——确认后调用方会把引用**一起改掉**
 * （草稿内同步更新，绝不留下悬空引用）。
 *
 * @param props - `{ id, referenceText, onRename }`：`onRename(newId)` 返回
 *   错误描述（改不动）或 null（已成功改掉，含全部引用）。
 */
export function IdEditor(props: IdEditorProps) {
    const { id, referenceText, onRename } = props
    const t = useT()
    const [editing, setEditing] = useState(false)
    const [value, setValue] = useState(id)
    const [error, setError] = useState<string | null>(null)

    if (editing !== true) {
        return h(FieldRow, {
            key: 'idRow',
            label: 'id',
            children: h('span', { key: 'value' }, id),
            // 「修改」是行尾操作：走 tail，自然宽、顶到最右（主控件槽留给左侧的 id 文本）。
            tail: h(Button, {
                key: 'rename',
                type: 'button',
                variant: 'outline',
                size: 'sm',
                onClick: () => {
                    setValue(id)
                    setError(null)
                    setEditing(true)
                },
                title: referenceText,
            }, t('common.rename')),
        })
    }

    return h('div', { key: 'idEdit', style: { paddingLeft: '2px' } }, [
        h(FieldRow, {
            key: 'row',
            label: 'id',
            children: h(Input, {
                key: 'input',
                type: 'text',
                value,
                placeholder: t('preset.newId'),
                onChange: (event: ChangeEvent<HTMLInputElement>) => {
                    setValue(event.target.value)
                    setError(null)
                },
            }),
            tail: formButtons({
                okText: t('common.ok'),
                onOk: () => {
                    const message = onRename(value.trim())
                    if (message === null) setEditing(false)
                    else setError(message)
                },
                onCancel: () => setEditing(false),
            }, t),
        }),
        error !== null
            ? h('div', { key: 'error', style: STYLE.warning }, error)
            : h('div', { key: 'ref', style: STYLE.hint }, referenceText),
    ])
}

/**
 * 集被哪些代理装载着（「修改」的引用提示）。
 * @param draft - 当前草稿。
 * @param kind - 集池名（`promptSets` / `toolSets` / `skillSets`）。
 * @param setId - 集 id。
 * @param t - 翻译器。
 */
export function setReferenceText(draft: Draft, kind: PoolKind, setId: string, t: Translate): string {
    const users = draft.agents.filter((agent) => (agent[kind as SetKind] ?? []).includes(setId))
    if (users.length === 0) return t('ref.setNone')

    const names = users.map((agent) => agentLabel(agent, t)).join(t('common.listSep'))

    return t('ref.setUsers', { agents: names, count: users.length })
}

/**
 * 代理被谁引用（「修改」的引用提示）：预设绑定 + 子代理名册。
 * @param draft - 当前草稿。
 * @param agentId - 代理 id。
 * @param t - 翻译器。
 */
export function agentReferenceText(draft: Draft, agentId: string, t: Translate): string {
    const parts = []

    const bound = draft.bindings.presets.filter((binding) => binding.agentId === agentId)
    if (bound.length > 0) {
        const presets = bound.map((binding) => binding.presetId).join(t('common.listSep'))
        parts.push(t('ref.boundByPreset', { presets }))
    }

    const parents = draft.agents.filter((agent) => agent.id !== agentId && (agent.children ?? []).includes(agentId))
    if (parents.length > 0) {
        const names = parents.map((agent) => agentLabel(agent, t)).join(t('common.listSep'))
        parts.push(t('ref.usedAsChild', { agents: names }))
    }

    if (parts.length === 0) return t('ref.agentNone')

    return t('ref.agentParts', { parts: parts.join(t('common.clauseSep')) })
}

/**
 * 新 id 的公共校验：非空、形状（配置键要稳当，只收保守字符集）、同池不撞。
 * @param pool - 同池的现有项。
 * @param oldId - 当前 id（等于新值时直接放行——用户没改）。
 * @param newId - 目标 id。
 * @param t - 翻译器。
 * @returns 错误描述；可用时 null。
 */
export function validateNewId(pool: DraftItem[], oldId: string, newId: string, t: Translate): string | null {
    if (newId === '') return t('validate.idEmpty')
    if (!/^[A-Za-z0-9_-]+$/.test(newId)) return t('validate.idCharset')
    if (newId === oldId) return null
    if (pool.some((item) => item.id === newId)) return t('validate.idTaken', { id: newId })

    return null
}

/**
 * 把段列表分成 `[[组名 key, 段...], ...]`：**按首个匹配的规则分组**（规则之间的
 * 前缀有重叠，比如 `harness:identity` 也会命中 `harness:`——必须先匹配先算），
 * 输出按规则顺序（关键的在前），认不出的名字进「其他」；空组不产出。
 * @param sections - `[{ name, text }]`。
 */
function groupPlatformSections(sections: PlatformSection[]): [CopyKey, PlatformSection[]][] {
    const buckets = new Map<CopyKey, PlatformSection[]>()
    for (const section of sections) {
        const rule = SECTION_GROUP_RULES.find((candidate) => candidate.test(section.name as string))
        const titleKey = rule === undefined ? 'section.group.other' : rule.titleKey

        const bucket = buckets.get(titleKey) ?? []
        bucket.push(section)
        buckets.set(titleKey, bucket)
    }

    const ordered = SECTION_GROUP_RULES
        .map((rule) => [rule.titleKey, buckets.get(rule.titleKey)])
        .filter((entry): entry is [CopyKey, PlatformSection[]] => entry[1] !== undefined)
    const rest = buckets.get('section.group.other')

    return rest === undefined ? ordered : [...ordered, ['section.group.other', rest]]
}

// ── 段编辑器（提示词集编辑器的正文） ────────────────────────────────────

/**
 * 段清单：一行一段，可开关、可上下移动、可展开看正文、可增删。
 *
 * **两类行**（判据与 host 侧 `apply.js` 的 `buildSections` 同源）：
 *  - **引用平台预设**（没正文）：正文随平台走（平台升级即更新），展开里可预览；
 *  - **自定义**（自带正文）：可改名、排序、移除、展开编辑正文。
 *
 * 界面只问「挑哪些段拼进去」，不再解释底下的覆盖语义（机制细节留在本文件与
 * `docs/` 里）；要保留平台自带的哪一段，用「+ 平台预设」把它加进来。
 *
 * 段清单是数组，增删改排都是整体替换——这也正是 host 侧写通道能表达删除的原因。
 *
 * @param props - `{ sections, platformSections, variables, onChange }`。
 *   `platformSections` 是平台全量段（观察层采的，进本插件改写之前的那份，
 *   带 `text` 供预览）；`variables` 是平台已注册的插值变量（名字 → 值）。
 */
export function SectionEditor(props: SectionEditorProps) {
    const { sections, platformSections, variables, onChange } = props
    const t = useT()
    const [expandedIndex, setExpandedIndex] = useState<number | null>(null)

    /** 「+ 平台预设」弹窗；null = 关着。`query` 搜名字、`preview` 展开看正文的那一段。 */
    const [picker, setPicker] = useState<SectionPickerState | null>(null)

    const platformNames = platformSections.map((section) => section.name)
    const platformByName = new Map(platformSections.map((section) => [section.name, section]))

    /**
     * 改一段并交回新数组。段清单是数组，增删改排都是整体替换——
     * 这也正是 host 侧写通道能表达删除的原因。
     */
    function updateAt(index: number, patch: Partial<DraftSection>) {
        onChange(sections.map((section, position) => (position === index ? { ...section, ...patch } : section)))
    }

    /**
     * 上下移动一段。
     *
     * 展开标记存的是**下标**，所以移动之后必须跟着挪——不然展开的正文会留在原来那行
     * 上，看着像「一拖动，展开的就换成别的段了」。不用段名当标记：段名可以重复、
     * 也可以为空，拿它做标记会让同名的两段一起展开。
     */
    function moveSection(index: number, delta: number) {
        const target = index + delta
        if (target < 0 || target >= sections.length) return

        const next = sections.slice()
        const [moved] = next.splice(index, 1)
        next.splice(target, 0, moved)
        onChange(next)

        if (expandedIndex === index) setExpandedIndex(target)
        else if (expandedIndex === target) setExpandedIndex(index)
    }

    function removeSection(index: number) {
        onChange(sections.filter((section, position) => position !== index))

        if (expandedIndex === index) setExpandedIndex(null)
        else if (expandedIndex !== null && expandedIndex > index) setExpandedIndex(expandedIndex - 1)
    }

    /** 加一条平台预设引用（名字来自平台清单，正文随平台走）。弹窗不关，方便连着加。 */
    function addPlatformSection(name: string) {
        if (name === '' || sections.some((section) => section.name === name)) return

        onChange([...sections, { name, enabled: true }])
    }

    /** 加一条自定义项（自带正文）：预填默认名（名称必填，默认值只是兜底），展开让用户改。 */
    function addCustomSection() {
        const taken = new Set(sections.map((section) => section.name))
        const name = pickDefaultName(t(DEFAULT_NAME_KEYS.sections), taken)
        onChange([...sections, { name, enabled: true, text: '' }])
        setExpandedIndex(sections.length)
    }

    // 弹窗内容：按「关键度」分组（身份与人设、工具用法最靠前——删了会明显变笨），
    // 支持按名字搜索；每行可展开看平台正文本体。
    const pickerQuery = (picker?.query ?? '').trim().toLowerCase()
    const pickerRows = platformSections.filter(
        (section) => pickerQuery === '' || (section.name as string).toLowerCase().includes(pickerQuery),
    )
    const pickerGroupList = groupPlatformSections(pickerRows)

    const rowNodes = sections.map((section, index) => {
        // 自带正文的才是自定义项（`apply.js` 的 buildSections 正是按它注入的）。
        const isCustom = section.text !== undefined
        // 位次取平台全量清单里的位置；名字不在里面（平台改版删过的段名、或手写配置
        // 的幽灵段）时说清楚，不拿「第 0 位」糊弄。
        // 行尾徽章只剩两类：**「自定义」（自带正文）与「PTC专属」（必备段）**——同一个
        // 位置、同一个圆框；两者同时成立时让必备段说话（锁定比来源更要紧）。
        // 2026-09-18 用户两次裁撤：先去掉「平台第 N 位」（段顺序本来就由清单数组决定），
        // 再去掉「不在平台清单里」（那类提示挪到展开区里说，行上不挂噪音）。
        const 不在平台清单 = platformNames.indexOf(section.name) < 0
        const ptcNoteKey = PTC_SECTION_NOTE_KEYS[section.name]
        // 必备段（PTC 那两条）：勾选与「移除」锁死，**上移 / 下移照旧可用**——
        // 锁的是「在不在清单里」，顺序由用户定（见 PTC_REQUIRED_SECTIONS）。
        const isRequired = PTC_REQUIRED_SECTIONS.includes(section.name)
        const positionText = isRequired === true
            ? t('section.ptcRequiredShort')
            : (isCustom === true ? t('section.customTag') : null)
        // 徽章的悬停说明：必备段给整句（行上只有「PTC专属」四个字）。
        const positionTitle = isRequired === true ? t('section.ptcRequired') : undefined

        const isTop = index === 0
        const isBottom = index === sections.length - 1

        // 行的排布：**左 = 勾选框 + 文本（可缩），右 = 徽章 / 箭头 / 按钮（永不压缩）**，
        // 中间一个弹簧把右侧推到行尾。窄容器里先缩文本，不缩控件——名称一长就把
        // 「收起 / 移除」压成竖排文字，是第十八轮用户报的坑。
        const 段名 = section.name === '' ? t('section.unnamed') : section.name

        const head = h('div', { key: 'head', style: STYLE.rowNowrap }, [
            // 平台 `Checkbox` 的 `label` 由它自己渲染一层 span（不吃 style）——段名要
            // 「可缩 + 出省略号」就不能塞给它，否则名字的截断与省略号都拿不回来。
            // 这里把勾选框锁成 16px 的壳（平台 CSS 写死的尺寸）：裁掉它那 6px 的 gap
            // 与空标签，名字仍用自绘 span——**截断、省略号、收缩全在手上**。
            // 空 `label` 让勾选框自身没有可访问名（与换件前的裸 `input` 一致）。
            h('span', {
                key: 'enabled',
                style: { display: 'inline-flex', flex: 'none', width: '16px', overflow: 'hidden' },
            }, h(Checkbox, {
                checked: isRequired === true ? true : section.enabled !== false,
                disabled: isRequired,
                onChange: (next: boolean) => updateAt(index, { enabled: next }),
                label: '',
            })),
            h('span', {
                key: 'name',
                title: 段名,
                // 段名**可缩**（窄容器先让位）+ 160px 上限：挤不下出省略号，不折行。
                style: { flex: '0 1 auto', minWidth: '0', maxWidth: '160px', ...STYLE.ellipsis },
            }, 段名),
            // 非必备段才在段名后挂注记：必备段的提示挪到了行尾徽章（同一位置、同一圆框）。
            isRequired === false && ptcNoteKey !== undefined ? h('span', {
                key: 'ptcNote',
                title: t(ptcNoteKey),
                style: { ...STYLE.hintGrow, fontSize: '11px', ...STYLE.ellipsis },
            }, t(ptcNoteKey)) : null,
            h('span', { key: 'spacer', style: ROW_SPACER }),
            // 徽章不吃 `style`，包一层 flex:none 的 span 才不会被压（Tag 文字是 nowrap 的）。
            // 必备段走**同一个位置、同一个圆框**（用户点名：像「自定义」那样固定住）——
            // 它比「自定义」更要紧，所以两者同时成立时让必备段说话。
            positionText === null ? null : h('span', {
                key: 'position',
                style: { display: 'inline-flex', ...ROW_TAIL },
                title: positionTitle,
            }, h(Tag, {
                tone: 'outline',
            }, positionText)),
            ...moveButtons({ isTop, isBottom, onMove: (delta) => moveSection(index, delta) }, t),
            h(Button, {
                key: 'toggle',
                type: 'button',
                size: 'sm',
                style: ROW_TAIL,
                onClick: () => setExpandedIndex(expandedIndex === index ? null : index),
            }, expandedIndex === index ? t('section.collapse') : t('section.expand')),
            h(Button, {
                key: 'remove',
                type: 'button',
                size: 'sm',
                style: ROW_TAIL,
                disabled: isRequired,
                onClick: () => removeSection(index),
            }, t('common.remove')),
        ])

        const detail = expandedIndex !== index ? null : h('div', { key: 'detail', style: { paddingLeft: '22px' } }, [
            isCustom === true ? h(FieldRow, {
                key: 'nameRow',
                label: t('common.name'),
                children: h(Input, {
                    key: 'name',
                    type: 'text',
                    value: section.name,
                    placeholder: t('section.namePlaceholder'),
                    onChange: (event: ChangeEvent<HTMLInputElement>) => updateAt(index, { name: event.target.value }),
                }),
            }) : null,
            // 非自定义段**只读**（2026-09-18 用户拍板「能看不能改」）：它引用平台正文，
            // 要改就改平台——不再提供「就地填内容覆盖」的输入框，免得 name/text 的语义漂移。
            isCustom === true ? h('textarea', {
                key: 'text',
                value: section.text ?? '',
                placeholder: t('section.textPlaceholder'),
                onChange: (event: ChangeEvent<HTMLTextAreaElement>) => updateAt(index, { text: event.target.value === '' ? undefined : event.target.value }),
                style: STYLE.textarea,
            }) : null,
            h('div', { key: 'plain', style: STYLE.hint },
                isCustom === true
                    ? t('section.customNote')
                    : t('section.platformNote')),
            // 必备段展开后补两句：整句提示（行上只有短标记）＋「它是什么、缺了会怎样」。
            isRequired === false
                ? null
                : h('div', { key: 'ptcDetail', style: STYLE.hint }, t('section.ptcRequired')),
            isRequired === false || ptcNoteKey === undefined
                ? null
                : h('div', { key: 'ptcNoteDetail', style: STYLE.hint }, t(ptcNoteKey)),
            isCustom !== true
                ? (typeof platformByName.get(section.name)?.text === 'string'
                    ? h('pre', { key: 'platformText', style: STYLE.sectionText }, platformByName.get(section.name)!.text)
                    : h('div', { key: 'noText', style: STYLE.hint },
                        // 「不在平台清单里」（幽灵段）与「在清单里但这轮没采到」是两回事，分开说。
                        不在平台清单
                            ? t('section.ghostNote')
                            : t('section.noTextNote')))
                : null,
        ])

        // key 只用下标，**不能把段名拼进去**：段名一变 React 就会卸载重建这一整行，
        // 正在输入的段名输入框会跟着失焦，一个字都敲不进去。
        // `data-section-row` 是定位锚点：名字进了 `Checkbox` 的 `label` 之后，
        // 「名字 → 这一行」的父节点层数变了，测试与走查按锚点找才不漂。
        return h('div', {
            key: `section-${index}`,
            'data-section-row': '',
            style: STYLE.listRow,
        }, [head, detail])
    })

    // 覆盖语义 + 可用变量的两句提示，放在清单最上方。
    const variableNames = Object.keys(variables ?? {})
    const variableList = variableNames.map((name) => {
        const value = variables[name]

        return value === null || value === undefined
            ? `{{${name}}}`
            : `{{${name}}}${t('section.variableAssign')}${value}`
    }).join(' · ')

    const lead = h('div', { key: 'lead' }, [
        h('div', { key: 'rule', style: STYLE.hint }, t('section.lead')),
        variableNames.length === 0
            ? null
            : h('div', { key: 'vars', style: STYLE.hint }, t('section.variables', { list: variableList })),
    ])

    const addRow = h('div', { key: 'add', style: { ...STYLE.row, marginTop: '6px' } }, [
        h(Button, {
            key: 'custom',
            type: 'button',
            variant: 'outline',
            onClick: addCustomSection,
        }, t('section.addCustom')),
        h(Button, {
            key: 'platform',
            type: 'button',
            variant: 'outline',
            onClick: () => setPicker({ query: '', preview: null }),
        }, t('section.addPlatform')),
        platformNames.length === 0
            ? h('span', { key: 'cold', style: STYLE.hint }, t('section.coldHint'))
            : null,
    ])

    // 弹窗（遮罩 + 卡片）。段正文在观察层里存着，这里直接给预览——用户不用先加上再看。
    const pickerRow = (section: PlatformSection) => {
        const added = sections.some((candidate) => candidate.name === section.name)
        const isOpen = picker?.preview === section.name
        const firstLine = (section.text ?? '').split('\n').find((line) => line.trim() !== '') ?? ''
        const ptcNoteKey = PTC_SECTION_NOTE_KEYS[section.name]

        // 预览锚点的那行小字：没采到 / 空段 / 首行正文，三种退化各说各的。
        let previewText = firstLine
        if (section.text === undefined) previewText = t('section.notCollectedShort')
        else if (firstLine === '') previewText = t('section.emptyShort')

        return h('div', { key: section.name, style: STYLE.listRow }, [
            h('div', { key: 'head', style: STYLE.rowNowrap }, [
                // 展开标记走平台 chevron（不用 `▸`/`▾` 字符：字体里缺字形时会整个
                // 消失，用户报过「收起时箭头直接不见」）。方向是用户点名的——
                // 展开 = 朝上、收起 = 朝下。字号抬到 13px 与面板基准同级（见下方 list）。
                h(Button, {
                    key: 'name',
                    type: 'button',
                    size: 'sm',
                    style: { ...ROW_TAIL, fontSize: '13px' },
                    onClick: () => setPicker({ ...picker!, preview: isOpen ? null : section.name }),
                }, [
                    h(isOpen ? IconChevronUpOutlineRegular : IconChevronDownOutlineRegular, { key: 'mark', size: 12 }),
                    h('span', { key: 'label' }, section.name),
                ]),
                // 右侧这条预览用户点名要「能看完整内容」（2026-09-18）：复用问号浮层，
                // 悬停弹全文（wide 档：更宽、按原样换行、限高可滚）。
                h(HelpTip, {
                    key: 'preview',
                    size: 'wide',
                    text: section.text === undefined
                        ? t('section.notCollected')
                        : (section.text === '' ? t('section.emptyBody') : section.text),
                    children: h('span', { style: { ...STYLE.hint, minWidth: '0', ...STYLE.ellipsis } }, previewText),
                }),
                h(Button, {
                    key: 'add',
                    type: 'button',
                    variant: 'outline',
                    style: ROW_TAIL,
                    onClick: () => addPlatformSection(section.name),
                    disabled: added,
                }, added ? t('common.added') : t('common.add')),
            ]),
            // PTC 专属段：正文是动态生成的，排除的后果也不直观——这里先讲清。
            ptcNoteKey === undefined ? null : h('div', {
                key: 'ptcNote',
                style: { ...STYLE.hint, fontSize: '11px', paddingLeft: '14px' },
            }, t(ptcNoteKey)),
            isOpen
                ? h('pre', { key: 'text', style: STYLE.sectionText },
                    section.text ?? t('section.pickerNoBody'))
                : null,
        ])
    }

    // 弹窗（平台 `Modal`，遮罩点击 / Esc 关闭内建）。段正文在观察层里存着，这里直接
    // 给预览——用户不用先加上再看。搜索框原来挂在自绘弹窗的标题行（`head` 槽），
    // 平台 `Modal` 没有那个槽，于是挪到正文顶部。
    // 列表外裹一层**受控高度的滚动区**：平台 `Modal` 的卡片没有 max-height，段清单
    // 长起来会把卡片顶穿视口（用户报「框超出了界面，下面还选不到」——整个弹窗既
    // 滚不动、又裁在屏幕外）。`min(calc(100vh - 230px), 620px)`：小窗口按视口给
    // 头尾留够，大屏上不超 620；搜索框留在滚动区外，滚列表时它不动。
    const pickerNode = picker === null ? null : h(Modal, {
        key: 'picker',
        open: true,
        onClose: () => setPicker(null),
        title: t('section.pickerTitle'),
        closeLabel: t('common.close'),
    }, [
        h(Input, {
            key: 'query',
            type: 'text',
            value: picker.query,
            placeholder: t('section.searchPlaceholder'),
            onChange: (event: ChangeEvent<HTMLInputElement>) => setPicker({ ...picker, query: event.target.value }),
        }),
        h('div', {
            key: 'list',
            style: {
                display: 'flex',
                flexDirection: 'column',
                overflowY: 'auto',
                overflowX: 'hidden',
                maxHeight: 'min(calc(100vh - 230px), 620px)',
                // 弹窗 portal 到 body，**不继承面板的 13px 基准**；不立基准的话
                // 说明文字会拿到浏览器默认的 16px——比段名（12px）还大，主次颠倒
                // （用户报「右侧的文字太大了，最好和左侧一样大」）。
                fontSize: '13px',
            },
        }, pickerGroupList.length === 0
            ? h('div', { key: 'noMatch', style: STYLE.hint }, t('section.noMatch'))
            : pickerGroupList.flatMap(([titleKey, groupSections]) => [
                h('div', { key: `g-${titleKey}`, style: { ...STYLE.hint, marginTop: '6px' } }, t(titleKey)),
                ...groupSections.map(pickerRow),
            ])),
    ])

    return h('div', null, [lead, rowNodes, addRow, pickerNode])
}
