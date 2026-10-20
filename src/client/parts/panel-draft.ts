/**
 * 草稿层：把 host 的配置归一化成可编辑的四件套，改名 / 引用 / 装载重叠都在这里判。
 *
 * @module dsh-agent-studio/client-parts/panel-draft
 */
import type {
    SectionObservation,
    Preset,
    DraftSection,
    DraftModel,
    DraftItem,
    DraftBinding,
    Draft,
    PoolKind,
    RawModel,
    RawAgent,
    RawSet,
    RawBinding,
    RawPoolItem,
    RefsOf,
} from './panel-types'
import type { CopyKey, Translate } from '../locales'
import type { StudioConfig } from '../../host/types'
import { PTC_REQUIRED_SECTIONS, REQUIRED_TOOLS, DEFAULT_RETRIES } from './panel-constants'

// ── 草稿 ────────────────────────────────────────────────────────────────

/**
 * 段的可编辑副本。
 *
 * `enabled` 归一化成显式布尔、`text` 保持「有字符串才有」的语义——与 host 侧
 * `apply.js` 的判据同源（有无正文决定它是自定义还是平台预设引用）。
 */
export function cloneSection(section: SectionObservation): DraftSection {
    return {
        name: section?.name ?? '',
        enabled: section?.enabled !== false,
        text: typeof section?.text === 'string' ? section.text : undefined,
    }
}

/** 模型路由的可编辑副本。 */
export function cloneModel(model: RawModel | undefined): DraftModel {
    return {
        provider: model?.provider,
        model: model?.model,
        reasoningEffort: model?.reasoningEffort,
    }
}

/** 代理的可编辑副本。字段顺序固定——脏检查是序列化比对，顺序必须稳定。 */
export function cloneAgent(agent: RawAgent): DraftItem {
    return {
        id: agent?.id ?? '',
        name: agent?.name ?? '',
        note: agent?.note ?? '',
        model: cloneModel(agent?.model),
        fallbacks: (agent?.fallbacks ?? []).map(cloneModel),
        maxRetries: agent?.maxRetries ?? DEFAULT_RETRIES,
        background: agent?.background ?? 'model-decides',
        toolPresentation: agent?.toolPresentation ?? 'follow',
        promptSets: [...(agent?.promptSets ?? [])],
        toolSets: [...(agent?.toolSets ?? [])],
        skillSets: [...(agent?.skillSets ?? [])],
        children: [...(agent?.children ?? [])],
    } as DraftItem
}

/** 提示词集的可编辑副本。 */
export function clonePromptSet(set: RawSet): DraftItem {
    return {
        id: set?.id ?? '',
        name: set?.name ?? '',
        note: set?.note ?? '',
        sections: (set?.sections ?? []).map(cloneSection),
    } as DraftItem
}

/** 工具集的可编辑副本。 */
export function cloneToolSet(set: RawSet): DraftItem {
    return {
        id: set?.id ?? '',
        name: set?.name ?? '',
        note: set?.note ?? '',
        tools: [...(set?.tools ?? [])],
    } as DraftItem
}

/** 技能集的可编辑副本。 */
export function cloneSkillSet(set: RawSet): DraftItem {
    return {
        id: set?.id ?? '',
        name: set?.name ?? '',
        note: set?.note ?? '',
        skills: [...(set?.skills ?? [])],
    } as DraftItem
}

/** 预设绑定的可编辑副本。 */
export function cloneBinding(binding: RawBinding): DraftBinding {
    return { presetId: binding?.presetId ?? '', agentId: binding?.agentId ?? '' }
}

// ── 池的通用取用（四个池名字不同、形状一样，界面到处要按 kind 取） ──────────

/** 某个池在草稿里的数组；`kind` 与 selection.kind 同一套取值（Agent 池是 `'agent'`）。 */
export function poolOf(draft: Draft | null | undefined, kind: PoolKind): DraftItem[] {
    if (kind === 'agent') return draft?.agents ?? []

    return draft?.[kind] ?? []
}

/** 池的界面名词的字典 key（英文里用单数：这些位置大多是「一个 X」的语境）。 */
export function nounKeyOf(kind: PoolKind): CopyKey {
    if (kind === 'agent') return 'noun.agent'
    if (kind === 'promptSets') return 'noun.promptSets'
    if (kind === 'toolSets') return 'noun.toolSets'

    return 'noun.skillSets'
}

/** 池的界面名词。 */
export function nounOf(kind: PoolKind, t: Translate): string {
    return t(nounKeyOf(kind))
}

/** 新建池项时的 id 前缀。 */
export function idBaseOf(kind: PoolKind): string {
    if (kind === 'agent') return 'agent'
    if (kind === 'promptSets') return 'prompt-set'
    if (kind === 'toolSets') return 'tool-set'
    return 'skill-set'
}

/** 新建 / 复制 / 导入池项时的通用克隆器（只取归位时用得着的那些键）。 */
export function cloneItemOf(kind: PoolKind, item: RawAgent | RawSet): DraftItem {
    if (kind === 'agent') return cloneAgent(item)
    if (kind === 'promptSets') return clonePromptSet(item)
    if (kind === 'toolSets') return cloneToolSet(item)
    return cloneSkillSet(item)
}

/**
 * 各类名称的默认值：新建时预填、加载草稿时给空名补齐。
 *
 * 规则与 host 侧 `config.js` 的 `applyDefaultNames` 同源——名称必填，默认值
 * 只是兜底；两处都补过之后，界面上看到的名字与保存下去的名字永远一致。
 */
export const DEFAULT_NAME_KEYS: Record<string, CopyKey> = {
    agents: 'defaultName.agents',
    promptSets: 'defaultName.promptSets',
    toolSets: 'defaultName.toolSets',
    skillSets: 'defaultName.skillSets',
    sections: 'defaultName.sections',
}

/** 取一个没被占用的默认名（记进 `taken`），规则同 host 侧 `pickDefaultName`。 */
export function pickDefaultName(base: string, taken: Set<string>): string {
    if (!taken.has(base)) {
        taken.add(base)
        return base
    }

    let index = 2
    while (taken.has(`${base} ${index}`)) index += 1

    const name = `${base} ${index}`
    taken.add(name)
    return name
}

/** 给一组项里所有空名的补默认名（返回新数组，不改原元素）。 */
export function fillNames<T extends { name?: string }>(items: T[], base: string): T[] {
    const taken = new Set<string>()
    for (const item of items) {
        if (typeof item?.name === 'string' && item.name !== '') taken.add(item.name)
    }

    return items.map((item) => {
        if (typeof item?.name === 'string' && item.name !== '') return item

        return { ...item, name: pickDefaultName(base, taken) }
    })
}

/**
 * 滤掉指向「已经不存在」的预设的绑定——面板加载配置时的自愈（2026-09-19 用户报的
 * 「删不掉 Agent」的客户端半边）。
 *
 * 预设删掉之后，`bindings.presets` 里指向它的条目就是悬空引用：删 Agent 的拦截与
 * 「被引用」提示都按它算，而那个预设已经没了、绑定也没有解除入口——绑到它的 Agent
 * 被永久锁死。在草稿层滤掉，面板就不再认这些幽灵引用；用户下次「保存改动」时自然
 * 落盘清掉（host 侧删预设时也会主动清，这是双保险）。
 *
 * 预设清单读不出来（空数组）时不过滤：那分不清「幽灵」与「这次没读到清单」，
 * 宁可留着也不能把用户的绑定误删。滤过的配置同时是脏检查的比较基准（见 `refresh`），
 * 所以自愈本身不会把面板顶成「有未保存的改动」。
 *
 * @param config - 从 host 读回的插件配置。
 * @param presets - 平台当前真实存在的预设。
 * @returns 滤掉幽灵绑定后的配置；没有可滤项时原样返回。
 */
export function dropGhostBindings(config: StudioConfig | null, presets: Preset[]): StudioConfig | null {
    const bindings = config?.bindings?.presets
    if (config === null || Array.isArray(bindings) === false || presets.length === 0) return config

    const alive = new Set(presets.map((preset) => preset.id))
    const kept = bindings.filter((binding) => alive.has(binding?.presetId ?? ''))
    if (kept.length === bindings.length) return config

    return { ...config, bindings: { ...config.bindings, presets: kept } }
}

/**
 * 从插件配置取一份全量草稿（四个池 + 快照名单 + 绑定）。配置可能是 null
 * （服务未就绪），给空池。
 *
 * 空名在这里统一补默认名——`isDirty` 的比较基准也走这同一个函数，
 * 所以「补名」不会把干净的草稿判成脏的。
 *
 * @param config - 插件配置。
 * @param t - 翻译器（空名的默认值要按当前语言生成）。
 */
export function draftFor(config: StudioConfig | null | undefined, t: Translate): Draft {
    return {
        agents: fillNames((config?.agents ?? []).map(cloneAgent), t(DEFAULT_NAME_KEYS.agents)),
        promptSets: (config?.promptSets ?? []).map((set) => {
            const copy = clonePromptSet(set)
            copy.sections = ensurePtcSections(fillNames(copy.sections, t(DEFAULT_NAME_KEYS.sections)))
            return copy
        }),
        toolSets: fillNames((config?.toolSets ?? []).map(cloneToolSet), t(DEFAULT_NAME_KEYS.toolSets))
            .map((set) => ({ ...set, tools: ensureRequiredTools(set.tools) })),
        skillSets: fillNames((config?.skillSets ?? []).map(cloneSkillSet), t(DEFAULT_NAME_KEYS.skillSets)),
        runtimeContextOff: [...(config?.runtimeContextOff ?? [])],
        bindings: { presets: (config?.bindings?.presets ?? []).map(cloneBinding) },
    }
}

/**
 * 必备段补位：缺的追加到清单末尾、`enabled` 一律纠正为 true。
 * 已有同名段**只纠 `enabled`，不碰正文**——用户自己写过 `tools:sdk` 的话正文是他的。
 *
 * 放在草稿层而不是装配期：配置是唯一真相，用户在界面上看得见、也能自己调顺序；
 * 装配期偷偷注入会让「配置里没有、实际却投递」，将来对着配置会看不懂。
 *
 * @param sections - 一个提示词集的段清单（已补过默认名）。
 * @returns 保证含必备段的新清单（原数组不被改动）。
 */
export function ensurePtcSections(sections: DraftSection[]): DraftSection[] {
    const present = new Set(sections.map((section) => section.name))
    const next = sections.map((section) => (
        PTC_REQUIRED_SECTIONS.includes(section.name) === true && section.enabled === false
            ? { ...section, enabled: true }
            : section
    ))

    for (const name of PTC_REQUIRED_SECTIONS) {
        if (present.has(name) === false) next.push({ name, enabled: true })
    }

    return next
}

/**
 * 必备工具补位：缺的追加到清单末尾，已有的一律不动（位置与顺序是用户的）。
 *
 * 与 `ensurePtcSections` 同一个理由放在草稿层：配置是唯一真相，界面上看得见、也能自己
 * 调顺序；装配期偷偷注入会让「配置里没有、实际却投递」，将来对着配置会看不懂。
 *
 * @param tools - 一个工具集的工具名清单。
 * @returns 保证含必备工具的新清单（原数组不被改动）。
 */
export function ensureRequiredTools(tools: string[]): string[] {
    const next = [...tools]

    for (const name of REQUIRED_TOOLS) {
        if (next.includes(name) === false) next.push(name)
    }

    return next
}

/**
 * 磁盘上的配置是否缺必备项（段缺 / 被手动关掉，工具集缺必备工具）。缺 ⇒ 也算
 * 「有未保存的改动」：草稿里已经补好了，用户点一次「保存改动」就落盘（插件不自动写盘）。
 *
 * @param config - 插件配置（可能是 null：服务未就绪）。
 * @returns 任何一个集缺必备项时为 true。
 */
export function missingRequiredItems(config: StudioConfig | null | undefined): boolean {
    for (const set of config?.promptSets ?? []) {
        const sections = set.sections ?? []

        for (const name of PTC_REQUIRED_SECTIONS) {
            const found = sections.find((section) => section.name === name)
            if (found === undefined || found.enabled === false) return true
        }
    }

    for (const set of config?.toolSets ?? []) {
        const tools = set.tools ?? []

        for (const name of REQUIRED_TOOLS) {
            if (tools.includes(name) === false) return true
        }
    }

    return false
}

/** 草稿与配置是否一致。用序列化比对就够——草稿都是纯 JSON 数据。 */
export function isDirty(draft: Draft | null, config: StudioConfig | null | undefined, t: Translate): boolean {
    if (draft === null) return false

    // 必备项：草稿里已补齐、磁盘上还没有 ⇒ 也算改动（保存一次即对齐）。
    if (JSON.stringify(draft) !== JSON.stringify(draftFor(config, t))) return true

    return missingRequiredItems(config)
}

/**
 * 池内取一个没被占用的 id：`<base>-1`、`<base>-2`……
 * @param base - id 前缀。
 * @param taken - 已占用的 id 集合。
 */
export function availableId(base: string, taken: Set<string>): string {
    let index = 1
    while (taken.has(`${base}-${index}`)) index += 1

    return `${base}-${index}`
}

/** 代理的显示名：优先名字，没名字退回 id。 */
export function agentLabel(agent: DraftItem | undefined, t: Translate): string {
    return agent?.name !== '' && agent?.name !== undefined ? agent.name : agent?.id ?? t('common.unnamed')
}

/** 集的显示名：优先名字，没名字退回 id。 */
export function setLabel(set: DraftItem | undefined, t: Translate): string {
    return set?.name !== '' && set?.name !== undefined ? set.name : set?.id ?? t('common.unnamed')
}

/**
 * 平台**内置预设**的名字与说明键。
 *
 * 平台不发布这 4 个预设的 `name` / `description` —— 判据与平台一致（`dsh-agent-preset-registry`
 * 的 `isBuiltInPreset()`：没发布名字且 id 命中这张表），文案由**客户端字典**给。
 * 面板直接读 `name` 的话，整排 Tab 会显示成 `standard` / `ptc`。
 */
export const BUILT_IN_PRESET_KEYS: Record<string, { name: CopyKey; hint: CopyKey }> = {
    standard: { name: 'preset.builtIn.standard', hint: 'preset.builtIn.standardHint' },
    ptc: { name: 'preset.builtIn.ptc', hint: 'preset.builtIn.ptcHint' },
    minimal: { name: 'preset.builtIn.minimal', hint: 'preset.builtIn.minimalHint' },
    cordis: { name: 'preset.builtIn.cordis', hint: 'preset.builtIn.cordisHint' },
}

/**
 * 预设的显示文案：内置预设查字典，其余用预设自己发布的，都没有才退回 id。
 *
 * @param preset - 面板拿到的那一行预设。
 * @param t - 当前语言的翻译函数。
 * @returns `name` / `hint` 供界面显示；`平台已发布` 为假表示这份文案是**本地字典补的**
 *          ——新建预设时要显式带上它（host 那边继承不到来源预设没发布的名字）。
 */
export function presetText(preset: Preset, t: Translate): { name: string; hint: string; 平台已发布: boolean } {
    // 名字为空 = 平台没发布（内置预设就是这样）。host 把平台的 `undefined` 归一成了 `null`
    // （见 `presets.ts` 的 `listPresets()`），两种都当「没发布」。
    if (preset.name === null || preset.name === undefined) {
        const keys = BUILT_IN_PRESET_KEYS[preset.id]
        if (keys !== undefined) return { name: t(keys.name), hint: t(keys.hint), 平台已发布: false }
    }

    return { name: preset.name ?? preset.id, hint: preset.description ?? preset.id, 平台已发布: true }
}

/**
 * 把某个集装进代理时的重叠校验：已装的集之间不许有同名段 / 同工具。
 *
 * 与 host 侧 `config.js` 的 `findLoadConflict` 同源，但这里是**装载那一刻**的即时
 * 拦截——等保存时才报错的话，用户已经装完一屏、还得自己找出是哪个冲突。
 *
 * @param draft - 当前草稿。
 * @param kind - `'promptSets'` 或 `'toolSets'`。
 * @param loadedIds - 该代理已装的集 id。
 * @param setId - 要装进去的集 id。
 * @param t - 翻译器。
 * @returns 冲突描述；没冲突时 null。
 */
export function loadConflictFor(
    draft: Draft,
    kind: PoolKind,
    loadedIds: string[],
    setId: string,
    t: Translate,
): string | null {
    if (loadedIds.includes(setId)) return null

    const pool = poolOf(draft, kind)
    const incoming = pool.find((set) => set.id === setId)
    if (incoming === undefined) return null

    const incomingNames = new Set(
        setMemberNames(incoming, kind).filter((name) => name !== '' && name !== undefined),
    )

    for (const loadedId of loadedIds) {
        const loaded = pool.find((set) => set.id === loadedId)
        if (loaded === undefined) continue

        const overlap = setMemberNames(loaded, kind).find((name) => incomingNames.has(name))
        if (overlap === undefined) continue

        return t('validate.loadConflict', {
            noun: nounOf(kind, t),
            loaded: setLabel(loaded, t),
            incoming: setLabel(incoming, t),
            member: memberNounOf(kind, t),
            name: overlap,
        })
    }

    return null
}

/**
 * 一个集里的成员名（段名 / 工具名 / 技能名）——装载重叠校验用。
 *
 * 必备项要**滤掉**（段的 `PTC_REQUIRED_SECTIONS`、工具的 `REQUIRED_TOOLS`）：它们每个集
 * 都常驻，天然同名，不让人为撞车的判据；host 侧 `findAgentLoadConflict` 走同一口径，
 * 真投递时 `mergeSections` / `mergeToolNames` 保序去重——两边一致，装载第二个集不会被
 * 自己拦下。
 */
export function setMemberNames(set: DraftItem | undefined, kind: PoolKind): string[] {
    if (kind === 'promptSets') {
        return (set?.sections ?? [])
            .map((section) => section.name)
            .filter((name) => PTC_REQUIRED_SECTIONS.includes(name) === false)
    }

    if (kind === 'toolSets') {
        return (set?.tools ?? []).filter((name) => REQUIRED_TOOLS.includes(name) === false)
    }

    return [...(set?.skills ?? [])]
}

/** 成员名的名词的字典 key（装载重叠校验的提示文案用）。 */
export function memberNounKeyOf(kind: PoolKind): CopyKey {
    if (kind === 'promptSets') return 'member.promptSets'
    if (kind === 'toolSets') return 'member.toolSets'

    return 'member.skillSets'
}

/** 成员名的名词（装载重叠校验的提示文案用）。 */
export function memberNounOf(kind: PoolKind, t: Translate): string {
    return t(memberNounKeyOf(kind))
}

/**
 * 保存前的全量静态校验（host 侧还会再校验一次，这里是即时反馈）。
 * @param draft - 当前草稿。
 * @param t - 翻译器。
 * @returns 问题描述；没问题时 null。
 */
export function findDraftConflict(draft: Draft, t: Translate): string | null {
    const pools: [DraftItem[], CopyKey][] = [
        [draft.agents, 'noun.agent'],
        [draft.promptSets, 'noun.promptSets'],
        [draft.toolSets, 'noun.toolSets'],
        [draft.skillSets, 'noun.skillSets'],
    ]

    for (const [items, nounKey] of pools) {
        const noun = t(nounKey)
        const seen = new Set()
        for (const item of items) {
            if (item.id === '' || item.id === undefined) return t('validate.poolIdEmpty', { noun })
            if (item.name === undefined || item.name.trim() === '') return t('validate.poolNameEmpty', { noun })
            if (seen.has(item.id)) return t('validate.poolIdDup', { noun, id: item.id })
            seen.add(item.id)
        }
    }

    for (const set of draft.promptSets) {
        for (const section of set.sections ?? []) {
            if (section.name === undefined || section.name.trim() === '') {
                return t('validate.sectionNameEmpty', { set: setLabel(set, t) })
            }
        }
    }

    for (const agent of draft.agents) {
        const promptConflict = findLoadedOverlap(draft, 'promptSets', agent.promptSets, t)
        if (promptConflict !== null) {
            return t('validate.loadedOverlap', { agent: agentLabel(agent, t), noun: t('noun.promptSets'), detail: promptConflict })
        }

        const toolConflict = findLoadedOverlap(draft, 'toolSets', agent.toolSets, t)
        if (toolConflict !== null) {
            return t('validate.loadedOverlap', { agent: agentLabel(agent, t), noun: t('noun.toolSets'), detail: toolConflict })
        }

        const skillConflict = findLoadedOverlap(draft, 'skillSets', agent.skillSets, t)
        if (skillConflict !== null) {
            return t('validate.loadedOverlap', { agent: agentLabel(agent, t), noun: t('noun.skillSets'), detail: skillConflict })
        }
    }

    return null
}

/** 一个代理已装集之间的重叠（段名 / 工具名 / 技能名），返回第一处。 */
export function findLoadedOverlap(
    draft: Draft,
    kind: PoolKind,
    loadedIds: string[],
    t: Translate,
): string | null {
    const pool = poolOf(draft, kind)
    const owner = new Map<string, DraftItem>()

    for (const setId of loadedIds) {
        const set = pool.find((candidate) => candidate.id === setId)
        if (set === undefined) continue

        for (const name of setMemberNames(set, kind)) {
            if (name === '' || name === undefined) continue

            const before = owner.get(name)
            if (before !== undefined) {
                return t('validate.loadedContains', {
                    a: setLabel(before, t),
                    b: setLabel(set, t),
                    member: memberNounOf(kind, t),
                    name,
                })
            }

            owner.set(name, set)
        }
    }

    return null
}

/** 从导入文件里取一个池的项：池级文件是 `items`，全量文件退回同名字段。 */
export function readImportItems(payload: Record<string, unknown>, kind: PoolKind): RawPoolItem[] {
    if (Array.isArray(payload?.items)) return payload.items

    const key = kind === 'agent' ? 'agents' : kind
    return Array.isArray(payload?.[key]) ? payload[key] : []
}

/** 三个集池的 id 集合：Agent 的引用校验基准（现有草稿）。 */
export function refsOf(draft: Draft): RefsOf {
    return {
        promptSets: new Set(draft.promptSets.map((set) => set.id)),
        toolSets: new Set(draft.toolSets.map((set) => set.id)),
        skillSets: new Set(draft.skillSets.map((set) => set.id)),
    }
}

/**
 * 项的显示名（导入报错文案与导入 / 导出树的行文案共用）：有名字用名字，没有就用 id。
 *
 * 参数只取 id / name：导入文件里读出来的是**原始项**（还没过归位克隆），树也要它。
 */
export function importLabelOf(item: { id?: string; name?: string }) {
    return typeof item?.name === 'string' && item.name !== '' ? item.name : item?.id ?? ''
}

/** Agent 的引用校验：引用的集必须在（现有 + 同批导入的）池里，缺一个就整批拒绝。 */
export function assertRefsOk(
    kind: PoolKind,
    item: DraftItem,
    refs: RefsOf,
    t: Translate,
) {
    if (kind !== 'agent') return

    const missing: string[] = []
    for (const setId of item.promptSets ?? []) {
        if (!refs.promptSets.has(setId)) missing.push(t('validate.importSetRef', { noun: t('noun.promptSets'), id: setId }))
    }
    for (const setId of item.toolSets ?? []) {
        if (!refs.toolSets.has(setId)) missing.push(t('validate.importSetRef', { noun: t('noun.toolSets'), id: setId }))
    }
    for (const setId of item.skillSets ?? []) {
        if (!refs.skillSets.has(setId)) missing.push(t('validate.importSetRef', { noun: t('noun.skillSets'), id: setId }))
    }

    if (missing.length > 0) {
        const agent = importLabelOf(item)
        throw Error(t('validate.importAgentRefs', { agent, missing: missing.join(t('common.listSep')) }))
    }
}

/**
 * 把一个池的导入项并进草稿——判 id，撞 id 时按 `overwrite` 决定**覆盖还是整批拒绝**
 * （拒绝是 2026-09-17 定下的老规矩；2026-09-20 用户加开关，默认仍是拒绝，覆盖要显式打开）。
 *
 * 覆盖 = 用导入项替换同 id 的现有项，**保持它原来的位置**（不追加到尾部，也不改名、
 * 不去动别处的引用）。合并结果先落在草稿里，用户看过再点保存。
 * Agent 额外做引用校验，`refs` 是（合并后的）三个集池的 id 集合。
 *
 * @param kind - 池名（`'agent'` / `'promptSets'` / `'toolSets'` / `'skillSets'`）。
 * @param existing - 草稿里的现有数组。
 * @param incoming - 导入的原始项（会过一遍归位克隆）。
 * @param refs - 引用校验基准；只对 Agent 用。
 * @param overwrite - 撞 id 时是否用导入项覆盖现有项。
 * @returns 合并后的新数组。
 */
export function mergePoolItems(
    kind: PoolKind,
    existing: DraftItem[],
    incoming: RawPoolItem[],
    refs: RefsOf | undefined,
    overwrite: boolean,
    t: Translate,
): DraftItem[] {
    if (incoming.length === 0) return existing

    const taken = new Map(existing.map((item) => [item.id, item]))
    const items = [...existing]

    for (const raw of incoming) {
        const item = cloneItemOf(kind, raw)
        if (item.id === '' || item.id === undefined) {
            throw Error(t('validate.importIdEmpty', { noun: nounOf(kind, t) }))
        }

        const before = taken.get(item.id)
        if (before !== undefined && overwrite !== true) {
            throw Error(t('validate.importIdClash', {
                id: item.id,
                label: importLabelOf(item),
                beforeId: before.id,
                beforeLabel: importLabelOf(before),
            }))
        }

        if (kind === 'agent') {
            assertRefsOk(
                kind,
                item,
                refs!,
                t,
            )
        }

        if (before === undefined) {
            items.push(item)

        } else {
            const at = items.findIndex((current) => current.id === item.id)
            items[at] = item
        }

        taken.set(item.id, item)
    }

    return items
}
