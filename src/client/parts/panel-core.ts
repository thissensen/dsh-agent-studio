/**
 * 面板本体：AgentStudioSection 与 PanelBody——取数 / 草稿 / 交互全在这里，文案从 context 取翻译器。
 *
 * @module dsh-agent-studio/client-parts/panel-core
 */
import * as React from 'react'
import type { ChangeEvent } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PlatformTranslate } from '../locales'
import { createTranslate } from '../locales'
// 样式全在 `../styles/`（按功能分文件、共用原子在 `basis`）。
import { STYLE } from '../styles'

import { TranslateContext, useT } from './panel-translate'
import type {
    DraftItem,
    Draft,
    PoolKind,
    SetKind,
    ViewState,
    ReadyView,
    BarForm,
    CreateForm,
    ActionState,
    MountBridgeState,
    Selection,
    ImportConfirm,
    RawPoolItem,
    TransferGroup,
    ToolObservation,
} from './panel-types'
import {
    ENDPOINTS,
    postJson,
    loadObservation,
    loadSkills,
    loadTools,
    loadConfig,
    loadPresets,
    loadModels,
    loadEfforts,
} from './panel-api'
import {
    observationFor,
    platformSectionsOf,
    promptVariablesOf,
    mergeToolObservations,
    toolRowsFor,
    skillRowsFor,
} from './panel-observe'
import {
    cloneAgent,
    poolOf,
    nounOf,
    idBaseOf,
    cloneItemOf,
    DEFAULT_NAME_KEYS,
    pickDefaultName,
    dropGhostBindings,
    draftFor,
    ensurePtcSections,
    ensureRequiredTools,
    isDirty,
    availableId,
    agentLabel,
    setLabel,
    presetText,
    loadConflictFor,
    findDraftConflict,
    readImportItems,
    mergePoolItems,
} from './panel-draft'
import { h } from './panel-widgets'
import {
    setReferenceText,
    agentReferenceText,
    validateNewId,
    SectionEditor,
} from './panel-sections'
import { ToolPicker, SkillPicker } from './panel-pickers'

import { NavColumn, PresetBar, SaveBar, downloadJson } from './panel-chrome'
import {
    ExportDialog,
    ImportDialog,
    exportPayloadOf,
    transferKeyOf,
    transferPoolGroup,
} from './panel-transfer'

import { AgentPanel, PoolActions, SetEditorCard } from './panel-main'

const { useEffect, useRef, useState } = React

/** 池级导入文件里的 `kind` 取值表：认不出的按「当前左栏选中的池」处理（老行为）。 */
const POOL_KIND_BY_NAME: Record<string, PoolKind> = {
    agent: 'agent',
    promptSets: 'promptSets',
    toolSets: 'toolSets',
    skillSets: 'skillSets',
}

// ── 面板本体 ────────────────────────────────────────────────────────────

/**
 * 面板部件对外的入口：把壳传进来的平台 `t` 包成面板用的翻译器，用 context 发给下面
 * 所有组件。
 *
 * 面板是运行时从 host 加载的，拿不到 cordis ctx，所以 `t` 只能由壳经 props 送进来；
 * 壳缺失或还没更新时是 `undefined` ⇒ `createTranslate` 退回中文，界面完整可用。
 *
 * @param props - `{ t }`：壳从 platform slot props 取到的翻译器。
 */
export function AgentStudioSection(props: { t?: PlatformTranslate }) {
    const t = React.useMemo(() => createTranslate(props.t), [props.t])

    return h(TranslateContext.Provider, { value: t }, h(PanelBody))
}

/** 设置页里的面板本体（数据与交互都在这里，文案从 context 取翻译器）。 */
function PanelBody() {
    const t = useT()
    const [viewState, setViewState] = useState<ViewState>({ status: 'loading' })
    const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null)
    const [selection, setSelection] = useState<Selection>({ kind: 'agent', agentId: null })
    const [draft, setDraft] = useState<Draft | null>(null)
    const [actionState, setActionState] = useState<ActionState>({ status: 'idle' })
    const [barForm, setBarForm] = useState<BarForm>(null)
    /** 这次打开面板里保存过至少一次。底栏的「已保存」行默认空、保存后显示且不消失。 */
    const [savedOnce, setSavedOnce] = useState(false)
    /** 底部保存行的实测高度：左栏按它往下让位（吸附行不写死高度，窗口窄了按钮会换行）。 */
    const [saveBarHeight, setSaveBarHeight] = useState(0)
    /** 导出树弹窗：`true` = 弹着。勾选态由弹窗自己持有（关掉即卸载，下次打开回到全勾）。 */
    const [exportOpen, setExportOpen] = useState(false)
    /** 导入树弹窗的文件内容（已解析、已分组）：`null` = 不弹。 */
    const [importGroups, setImportGroups] = useState<TransferGroup[] | null>(null)
    /**
     * 上一次选中的导入文件里各池的**原始项**：树只带 id 与名字，合并要整份数据。
     * 用 ref 而不是 state——它不参与渲染。
     */
    const importedItems = useRef<Record<PoolKind, RawPoolItem[]>>({ agent: [], promptSets: [], toolSets: [], skillSets: [] })
    /**
     * 主页面挂载的运行时桥：壳在 `apply` 里把它挂到 window 上，缺席 = 旧壳
     * （那时总是渲染真面板，开关置灰）。**必须放在所有早返回之前**——hooks 的顺序
     * 不能随分支变，否则 React 报 "Rendered more hooks than during the previous render"。
     */
    const [mountBridge, setMountBridge] = useState<MountBridgeState>({ available: false, ready: true, mounted: true })
    /** 切换开关的请求在飞：防重入（与 `busy` 分开，保存行各有各的禁用口径）。 */
    const [mountBusy, setMountBusy] = useState(false)
    /**
     * 每个预设的**实时**工具候选（`/tools` 端点，切到该预设时拉一次）。
     * 与观察缓存分开存：一个是平台此刻的面，一个是装配期采的副本，界面上取并集。
     */
    const [toolsByPreset, setToolsByPreset] = useState<Record<string, ToolObservation>>({})
    /** 正在飞的 `/tools` 请求（按预设 id）：挡并发；失败后不自己重试，等下一次切回。 */
    const toolsInFlight = useRef<Set<string>>(new Set())

    const busy = actionState.status === 'busy'
    // 提到这里算，是因为保存按钮与状态提示都要用它
    const dirty = isDirty(draft, viewState.config, t)

    /**
     * 重新问一遍 host。四份数据一起拉，避免中途出现半新半旧的界面。
     *
     * @param showLoading - 是否先切到 loading 态。切换预设时静默重读，免得整页闪一下。
     * @returns 这次的配置（失败时 null），供调用方决定要不要重建草稿。
     */
    async function refresh(showLoading = true) {
        if (showLoading) setViewState({ status: 'loading' })

        try {
            const [observationData, config, presetRows, modelCatalog, skills] = await Promise.all([
                loadObservation(),
                loadConfig(),
                loadPresets(),
                loadModels(),
                loadSkills(),
            ])

            // 幽灵绑定自愈（见 `dropGhostBindings`）：滤过的版本同时充当草稿来源与
            // 脏检查的比较基准——自愈本身不该被算成「有未保存的改动」。
            const liveConfig = dropGhostBindings(config, presetRows.presets)

            setViewState({
                status: 'ready',
                sessions: observationData.sessions,
                cached: observationData.cached,
                config: liveConfig,
                presets: presetRows.presets,
                authorable: presetRows.authorable,
                models: modelCatalog.providers,
                modelWarnings: modelCatalog.warnings,
                skills,
            })

            setSelectedPresetId((current) => {
                if (current !== null && presetRows.presets.some((preset) => preset.id === current)) return current
                return presetRows.presets[0]?.id ?? null
            })

            // 草稿只在这里建一次：之后**不再**跟随每一次刷新重建——v2 的草稿是全量
            // 四件套，与「正在看哪个预设」无关，用户手上的未保存改动不该被任何一次
            // 重读冲掉。保存之后的同步重建由 `saveDraft` 显式做（那时值可能被宿主
            // 的 schema 规范化过，重建才能让脏检查回到准确状态）。
            if (draft === null && liveConfig !== null) setDraft(draftFor(liveConfig, t))

            return liveConfig

        } catch (err) {
            setViewState({ status: 'failed', message: (err as Error).message })
            return null
        }
    }

    useEffect(() => {
        refresh()
    }, [])

    // 切预设就拉一次该预设的实时工具候选：打开面板、还没对过话时也能列全（观察缓存可能是空的）。
    // 失败不写进 `toolsByPreset`、也不在这里重试——下一次切回这个预设时会再拉一次。
    useEffect(() => {
        if (selectedPresetId === null) return
        if (toolsByPreset[selectedPresetId] !== undefined) return
        if (toolsInFlight.current.has(selectedPresetId)) return

        const presetId = selectedPresetId
        toolsInFlight.current.add(presetId)

        async function pullTools(): Promise<void> {
            try {
                const tools = await loadTools(presetId)
                if (tools !== undefined) setToolsByPreset((current) => ({ ...current, [presetId]: tools }))

            } finally {
                toolsInFlight.current.delete(presetId)
            }
        }

        pullTools()
    }, [selectedPresetId])

    // 选中项校正：池非空但当前没选中（打开面板时），或选中的被删了 ⇒ 落到第一个。
    // 「一级菜单默认选中第一个」这条（用户第 3 条反馈）在初始打开时同样成立。
    useEffect(() => {
        if (draft === null) return

        setSelection((current) => {
            if (current.kind === 'agent') {
                if (draft.agents.some((agent) => agent.id === current.agentId)) return current

                return { kind: 'agent', agentId: draft.agents[0]?.id ?? null }
            }

            if (draft[current.kind].some((set) => set.id === current.setId)) return current

            return { kind: current.kind, setId: draft[current.kind][0]?.id ?? null }
        })
    }, [draft])

    // 运行时桥（壳挂的 `window.__dshAgentStudioMount`）：旧壳没有它 ⇒ 什么都不做，
    // 面板照旧按「开关恒为开」回显。桥的值会变（设置页那份一改，在世的实例都跟着改；
    // 主区那份在开关关掉时连槽位一起被摘掉），所以订阅一次、每次变化重读两个值。
    useEffect(() => {
        const bridge = window.__dshAgentStudioMount
        if (bridge === undefined) return

        // 函数声明会被提升，TS 在闭包里不肯沿用守卫的收窄 ⇒ 用显式类型的局部量承接。
        const liveBridge: MountBridge = bridge

        function syncMount(): void {
            setMountBridge({ available: true, ready: liveBridge.ready(), mounted: liveBridge.mounted() })
        }

        syncMount()

        return bridge.subscribe(syncMount)
    }, [])

    /**
     * 改草稿。四个池各自整体替换，与 host 侧的合并语义一致。
     *
     * 提示词池与工具池额外各过一道补位（`ensurePtcSections` / `ensureRequiredTools`）：
     * **任何写入路径**（新建 / 复制 / 导入 / 加段 / 勾选 / 调序）都保证必备项在里面——
     * 它们是锁定项，不该指望每个调用方各记一次。
     */
    function patchDraft(changes: Partial<Draft>) {
        setDraft((current) => {
            const next: Draft = { ...current!, ...changes }

            if (changes.promptSets !== undefined) {
                next.promptSets = changes.promptSets.map((set) => ({ ...set, sections: ensurePtcSections(set.sections ?? []) }))
            }

            if (changes.toolSets !== undefined) {
                next.toolSets = changes.toolSets.map((set) => ({ ...set, tools: ensureRequiredTools(set.tools) }))
            }

            return next
        })
    }

    /**
     * 切到另一个预设：纯视图切换。
     *
     * v2 的草稿是全量四件套（与「正在看哪个预设」无关），所以切换**不丢任何改动**、
     * 也不需要在切之前拦一道确认——用户接着编辑就行；观察数据与预设列表早已全量
     * 拉过，也不用重读。
     */
    function switchPreset(presetId: string) {
        if (presetId === selectedPresetId) return
        setSelectedPresetId(presetId)
    }

    /** 把当前草稿写回 host。 */
    async function saveDraft() {
        setActionState({ status: 'busy' })

        try {
            // 宁可拒存，也不落一份无效配置：host 侧还会再校验一次，这里是即时反馈。
            const conflict = findDraftConflict(draft!, t)
            if (conflict !== null) throw Error(conflict)

            await postJson(ENDPOINTS.config, draft)

            const nextConfig = await refresh()
            // 用 host 复核过的值重建草稿：schema 可能补过默认值，不跟随的话
            // 脏检查会一直显示「有未保存的改动」。
            if (nextConfig !== null) setDraft(draftFor(nextConfig, t))

            // 保存成功的反馈走底栏那行「已保存」（默认空、保存后显示且不消失），
            // 不再同时占用动作提示条——同一个事实不报两遍。
            setSavedOnce(true)
            setActionState({ status: 'idle' })

        } catch (err) {
            setActionState({ status: 'failed', message: (err as Error).message })
        }
    }


    /**
     * 导出树确认：把勾中的项存成 JSON 文件。
     *
     * 导的是草稿——面板上看到的就是用户手上的版本，未保存的改动也一起带走
     * （导完点不点保存由用户自己决定）。文件里只有四个池，不带绑定与开关。
     *
     * @param selected - 树里勾中的键。
     */
    function confirmExport(selected: string[]) {
        downloadJson('agent-studio-config.json', exportPayloadOf(draft!, selected))
        setExportOpen(false)
        setActionState({ status: 'ok', message: t('transfer.exportOk', { count: selected.length }) })
    }

    /**
     * 导入第一步：解析文件、按池分组，弹勾选树。
     *
     * 老池级文件继续认（`items` 是数组时池由 `kind` 决定，认不出 kind 就退回左栏选中的池）；
     * 一个可导入项都没有 ⇒ 按校验失败处理，不弹树。
     */
    async function importConfig(event: ChangeEvent<HTMLInputElement>) {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (file === undefined) return

        setActionState({ status: 'busy' })

        try {
            const payload = JSON.parse(await file.text())

            const 声明池 = typeof payload?.kind === 'string' ? POOL_KIND_BY_NAME[payload.kind] : undefined
            const 读取池: PoolKind[] = Array.isArray(payload?.items)
                ? [声明池 ?? selection.kind]
                : ['agent', 'promptSets', 'toolSets', 'skillSets']

            const 分组: TransferGroup[] = []
            const 原始项: Record<PoolKind, RawPoolItem[]> = { agent: [], promptSets: [], toolSets: [], skillSets: [] }
            for (const kind of 读取池) {
                const items = readImportItems(payload, kind)
                原始项[kind] = items
                分组.push(transferPoolGroup(kind, items, t))
            }

            const 可导入数 = 分组.reduce((sum, group) => sum + group.items.length, 0)
            if (可导入数 === 0) throw Error(t('validate.importNoItems'))

            importedItems.current = 原始项
            setImportGroups(分组)
            setActionState({ status: 'idle' })

        } catch (err) {
            setActionState({ status: 'failed', message: t('validate.importFailed', { message: (err as Error).message }) })
        }
    }

    /**
     * 导入树确认：勾中的项按池**依次合并**进草稿（先三个集、再 Agent——代理要引用集，
     * 反了会自己报缺集）。合并规则一字不改：撞 id 且没开覆盖就整批拒绝、Agent 缺引用
     * 也整批拒绝，文案由 `mergePoolItems` 抛。
     *
     * @param result - 树里勾中的键 + 「撞 id 是否覆盖」开关。
     */
    function confirmImport(result: ImportConfirm) {
        const 选中键 = new Set(result.selected)
        const 取池 = (kind: PoolKind) => importedItems.current[kind]
            .filter((item) => 选中键.has(transferKeyOf(kind, item.id ?? '')))

        try {
            const incomingSkillSets = 取池('skillSets')
            const incomingPromptSets = 取池('promptSets')
            const incomingToolSets = 取池('toolSets')
            const incomingAgents = 取池('agent')

            const skillSets = mergePoolItems(
                'skillSets',
                draft!.skillSets,
                incomingSkillSets,
                undefined,
                result.overwrite,
                t,
            )
            const promptSets = mergePoolItems(
                'promptSets',
                draft!.promptSets,
                incomingPromptSets,
                undefined,
                result.overwrite,
                t,
            )
            const toolSets = mergePoolItems(
                'toolSets',
                draft!.toolSets,
                incomingToolSets,
                undefined,
                result.overwrite,
                t,
            )

            // Agent 的引用校验基准 = 上面三个池**合并后**的 id 集合。
            const refs = {
                promptSets: new Set(promptSets.map((set) => set.id)),
                toolSets: new Set(toolSets.map((set) => set.id)),
                skillSets: new Set(skillSets.map((set) => set.id)),
            }
            const agents = mergePoolItems(
                'agent',
                draft!.agents,
                incomingAgents,
                refs,
                result.overwrite,
                t,
            )

            patchDraft({ agents, promptSets, toolSets, skillSets })
            setActionState({
                status: 'ok',
                message: t('validate.importConfigDone', {
                    promptSets: incomingPromptSets.length,
                    toolSets: incomingToolSets.length,
                    skillSets: incomingSkillSets.length,
                    agents: incomingAgents.length,
                }),
            })

        } catch (err) {
            setActionState({ status: 'failed', message: t('validate.importFailed', { message: (err as Error).message }) })

        } finally {
            // 成败都关树：失败文案落在面板的动作提示条上，留着弹窗会把它挡住。
            setImportGroups(null)
        }
    }

    /** 新建预设（host 侧读来源预设的构成声明、注册一份新 id 的定义，并把定义存进插件配置）。 */
    async function createPreset() {
        setActionState({ status: 'busy' })

        try {
            // 显示名 / 描述留空 = 继承来源预设的（host 按来源定义的原文继承）。内置预设**没有**
            // 自己发布的文案（平台不给这类预设发，见 `presetText()`）⇒ host 继承不到，由这里
            // 按字典补上；否则新预设连名字都没有，面板与平台自己的预设选择器都会显示成 id。
            const 来源预设 = (viewState as ReadyView).presets.find((preset) => preset.id === (barForm as CreateForm).from)
            const 来源文案 = 来源预设 === undefined ? undefined : presetText(来源预设, t)
            const 继承名 = 来源文案?.平台已发布 === true ? undefined : 来源文案?.name
            const 继承描述 = 来源文案?.平台已发布 === true ? undefined : 来源文案?.hint

            const created = await postJson(ENDPOINTS.createPreset, {
                from: (barForm as CreateForm).from,
                id: (barForm as CreateForm).id,
                name: (barForm as CreateForm).name === '' ? 继承名 : (barForm as CreateForm).name,
                description: (barForm as CreateForm).description === '' ? 继承描述 : (barForm as CreateForm).description,
            })

            setBarForm(null)
            await refresh(false)
            setSelectedPresetId(created.id as string)
            // warning 自带「预设已创建，但…」的完整句子：有它就展示它（比如描述没写上），
            // 没有才是干净的成功文案。
            const warning = typeof created.warning === 'string' && created.warning !== '' ? created.warning : undefined
            setActionState({ status: 'ok', message: warning ?? t('preset.created', { id: String(created.id) }) })

        } catch (err) {
            setActionState({ status: 'failed', message: (err as Error).message })
        }
    }

    /** 删除当前预设（只删得掉本插件建的那些，判据在 host 侧）。 */
    async function deletePreset() {
        setActionState({ status: 'busy' })

        try {
            const 被删预设 = selectedPresetId
            await postJson(ENDPOINTS.deletePreset, { id: 被删预设 })

            setBarForm(null)
            setSelectedPresetId(null)
            await refresh(false)
            // 平台那份绑定已随预设删掉，草稿里这条却还留着 ⇒ 补上同一刀：只摘掉指向它的
            // 绑定，别的字段是用户的编辑，这条自愈不该顺手改它们。不摘的话，脏检查会把
            // 这次**自愈**读成「用户改了没保存」——用户什么都没改，却被要求保存一次
            // （坑册坑 40；比较基准那边由 `dropGhostBindings` 滤）。
            setDraft((current) => {
                if (current === null || 被删预设 === null) return current

                const kept = current.bindings.presets.filter((binding) => binding.presetId !== 被删预设)
                if (kept.length === current.bindings.presets.length) return current

                return { ...current, bindings: { presets: kept } }
            })
            setActionState({ status: 'ok', message: t('preset.deleted') })

        } catch (err) {
            setActionState({ status: 'failed', message: (err as Error).message })
        }
    }

    // ── 集与代理的编辑动作 ──────────────────────────────────────────────

    /** 对某条集打补丁（集库编辑器用）。 */
    function patchSet(kind: SetKind, setId: string, changes: Partial<DraftItem>) {
        patchDraft({
            [kind]: draft![kind].map((set) => (set.id === setId ? { ...set, ...changes } : set)),
        })
    }

    /** 对某个代理打补丁。 */
    function patchAgent(agentId: string, changes: Partial<DraftItem>) {
        patchDraft({
            agents: draft!.agents.map((agent) => (agent.id === agentId ? { ...agent, ...changes } : agent)),
        })
    }

    /**
     * 改一个集的 id，并把**引用它的代理装载列表一起改掉**（草稿内同步；保存才落盘）。
     *
     * 这就是「点击判断是否有 Agent 用着他」的落地：有引用不是拒绝，而是明确列出
     * 引用者、随改随更新——任何情况下都不留悬空引用（悬空会让那个装载在装配时
     * 被静默跳过，配置看起来「失效」）。
     *
     * @param kind - 集池名。
     * @param oldId - 当前 id。
     * @param newId - 目标 id。
     * @returns 错误描述；成功（含「没改」）时 null。
     */
    function renameSetId(kind: SetKind, oldId: string, newId: string) {
        const error = validateNewId(poolOf(draft, kind), oldId, newId, t)
        if (error !== null) return error
        if (newId === oldId) return null

        const nextPool = poolOf(draft, kind).map((set) => (set.id === oldId ? { ...set, id: newId } : set))
        const nextAgents = draft!.agents.map((agent) => {
            const loaded = agent[kind] ?? []
            if (!loaded.includes(oldId)) return agent

            return { ...agent, [kind]: loaded.map((setId) => (setId === oldId ? newId : setId)) }
        })

        patchDraft({ [kind]: nextPool, agents: nextAgents })
        if (selection.kind === kind && selection.setId === oldId) setSelection({ kind, setId: newId })

        return null
    }

    /**
     * 改一个代理的 id，并同步更新预设绑定与其它代理的子代理名册（草稿内同步）。
     *
     * @param oldId - 当前 id。
     * @param newId - 目标 id。
     * @returns 错误描述；成功（含「没改」）时 null。
     */
    function renameAgentId(oldId: string, newId: string) {
        const error = validateNewId(draft!.agents, oldId, newId, t)
        if (error !== null) return error
        if (newId === oldId) return null

        const nextAgents = draft!.agents.map((agent) => {
            const renamed = agent.id === oldId ? { ...agent, id: newId } : agent
            if (!(renamed.children ?? []).includes(oldId)) return renamed

            return { ...renamed, children: renamed.children.map((childId) => (childId === oldId ? newId : childId)) }
        })
        const nextBindings = draft!.bindings.presets.map((binding) => (
            binding.agentId === oldId ? { ...binding, agentId: newId } : binding
        ))

        patchDraft({ agents: nextAgents, bindings: { presets: nextBindings } })
        if (selection.kind === 'agent' && selection.agentId === oldId) setSelection({ kind: 'agent', agentId: newId })

        return null
    }

    /** 装载一个集（先过重叠校验）。 */
    function loadSet(agentId: string, kind: SetKind, setId: string) {
        const agent = draft!.agents.find((candidate) => candidate.id === agentId)
        if (agent === undefined) return

        const conflict = loadConflictFor(draft!, kind, agent[kind], setId, t)
        if (conflict !== null) {
            setActionState({ status: 'failed', message: conflict })
            return
        }

        patchAgent(agentId, { [kind]: [...agent[kind], setId] })
        setActionState({ status: 'idle' })
    }

    /** 卸载一个集。 */
    function unloadSet(agentId: string, kind: SetKind, index: number) {
        const agent = draft!.agents.find((candidate) => candidate.id === agentId)
        if (agent === undefined) return

        patchAgent(agentId, { [kind]: agent[kind].filter((_setId, position) => position !== index) })
    }

    /** 调一个集在装载列表里的顺序。 */
    function moveSet(agentId: string, kind: SetKind, index: number, delta: number) {
        const agent = draft!.agents.find((candidate) => candidate.id === agentId)
        if (agent === undefined) return

        const target = index + delta
        if (target < 0 || target >= agent[kind].length) return

        const next = agent[kind].slice()
        const [moved] = next.splice(index, 1)
        next.splice(target, 0, moved)
        patchAgent(agentId, { [kind]: next })
    }

    /** 处理左栏对代理的三种操作。 */
    function addAgent() {
        const id = availableId('agent', new Set(draft!.agents.map((agent) => agent.id)))
        const taken = new Set(draft!.agents.map((agent) => agent.name))
        const agent = cloneAgent({ id })
        agent.name = pickDefaultName(t(DEFAULT_NAME_KEYS.agents), taken)

        patchDraft({ agents: [...draft!.agents, agent] })
        setSelection({ kind: 'agent', agentId: id })
    }

    function duplicateAgent() {
        const source = draft!.agents.find((agent) => agent.id === selection.agentId)
        if (source === undefined) return

        const id = availableId('agent', new Set(draft!.agents.map((agent) => agent.id)))
        const taken = new Set(draft!.agents.map((agent) => agent.name))
        const copy = cloneAgent(source)
        copy.id = id
        copy.name = pickDefaultName(source.name === '' ? t(DEFAULT_NAME_KEYS.agents) : t('common.copySuffix', { name: source.name }), taken)

        patchDraft({ agents: [...draft!.agents, copy] })
        setSelection({ kind: 'agent', agentId: id })
    }

    function removeAgent() {
        const agent = draft!.agents.find((candidate) => candidate.id === selection.agentId)
        if (agent === undefined) return

        // 被引用时先拦：子代理名册与预设绑定都指着它的话，直接删会让那些引用悬空。
        const usedAsChild = draft!.agents.filter(
            (candidate) => candidate.id !== agent.id && candidate.children.includes(agent.id),
        )
        const boundPresets = draft!.bindings.presets.filter((binding) => binding.agentId === agent.id)

        if (usedAsChild.length > 0 || boundPresets.length > 0) {
            const parts = []
            if (usedAsChild.length > 0) {
                parts.push(t('ref.usedAsChild', { agents: usedAsChild.map((child) => agentLabel(child, t)).join(t('common.listSep')) }))
            }
            if (boundPresets.length > 0) {
                const presets = boundPresets.map((binding) => binding.presetId).join(t('common.listSep'))
                parts.push(t('ref.boundByPreset', { presets }))
            }

            const message = t('validate.removeAgentRefs', {
                agent: agentLabel(agent, t),
                parts: parts.join(t('common.commaSep')),
            })
            setActionState({ status: 'failed', message })
            return
        }

        const rest = draft!.agents.filter((candidate) => candidate.id !== agent.id)
        patchDraft({ agents: rest })
        setSelection({ kind: 'agent', agentId: rest[0]?.id ?? null })
        setActionState({ status: 'idle' })
    }

    /** 处理集库对集的三种操作。 */
    function addSet(kind: SetKind) {
        const pool = poolOf(draft, kind)
        const id = availableId(idBaseOf(kind), new Set(pool.map((set) => set.id)))
        const taken = new Set(pool.map((set) => set.name))
        const set = cloneItemOf(kind, { id })
        set.name = pickDefaultName(t(DEFAULT_NAME_KEYS[kind]), taken)

        patchDraft({ [kind]: [...pool, set] })
        setSelection({ kind, setId: id })
    }

    function duplicateSet(kind: SetKind) {
        const pool = poolOf(draft, kind)
        const source = pool.find((set) => set.id === selection.setId)
        if (source === undefined) return

        const id = availableId(idBaseOf(kind), new Set(pool.map((set) => set.id)))
        const taken = new Set(pool.map((set) => set.name))
        const copy = cloneItemOf(kind, source)
        copy.id = id
        copy.name = pickDefaultName(source.name === '' ? t(DEFAULT_NAME_KEYS[kind]) : t('common.copySuffix', { name: source.name }), taken)

        patchDraft({ [kind]: [...pool, copy] })
        setSelection({ kind, setId: id })
    }

    function removeSet(kind: SetKind) {
        const set = draft![kind].find((candidate) => candidate.id === selection.setId)
        if (set === undefined) return

        const users = draft!.agents.filter((agent) => agent[kind].includes(set.id))
        if (users.length > 0) {
            const agents = users.map((agent) => agentLabel(agent, t)).join(t('common.listSep'))
            setActionState({
                status: 'failed',
                message: t('validate.removeSetInUse', { set: setLabel(set, t), agents }),
            })
            return
        }

        patchDraft({ [kind]: draft![kind].filter((candidate) => candidate.id !== set.id) })
        setSelection({ kind, setId: null })
        setActionState({ status: 'idle' })
    }

    /**
     * 点左栏一级（池名）：切到这个池，并**默认选中第一项**（用户第 3 条反馈）——
     * 池是空的就落在空态，右边只剩三个按钮。
     */
    function openPool(kind: PoolKind) {
        if (kind === 'agent') {
            setSelection({ kind, agentId: draft!.agents[0]?.id ?? null })
            return
        }

        setSelection({ kind, setId: draft![kind][0]?.id ?? null })
    }

    /** 切某个代理的「注入运行时环境快照」开关（草稿态，点「保存改动」才落盘）。 */
    function toggleSnapshot(agentId: string, on: boolean) {
        const rest = draft!.runtimeContextOff.filter((id) => id !== agentId)
        patchDraft({ runtimeContextOff: on ? rest : [...rest, agentId] })
    }

    /**
     * 切「注册到主页面」。写的是 host 上的**全局开关**：不进草稿、不触发保存，
     * 所以直接打端点，成功才回填桥（桥再把新值分发给两页实例）。
     *
     * 这里是本功能唯一的 UI 异常边界：失败落进动作提示条，不弹窗、不往外抛。
     */
    async function toggleMountMainPage(next: boolean): Promise<void> {
        const bridge = window.__dshAgentStudioMount
        if (bridge === undefined) return

        setMountBusy(true)

        try {
            await postJson(ENDPOINTS.ui, { mountMainPage: next })
            bridge.setMounted(next)
            setActionState({ status: 'idle' })

        } catch (err) {
            setActionState({ status: 'failed', message: (err as Error).message })

        } finally {
            setMountBusy(false)
        }
    }

    // ── 渲染 ────────────────────────────────────────────────────────────

    if (viewState.status === 'loading') {
        return h('div', { style: STYLE.panel }, h('p', { style: STYLE.hint }, t('view.loading')))
    }

    if (viewState.status === 'failed') {
        return h('div', { style: STYLE.panel }, [
            h('p', { key: 'title' }, t('view.failed')),
            h('p', { key: 'message', style: STYLE.hint }, viewState.message),
            h('p', { key: 'hint', style: STYLE.hint }, t('view.failedHint')),
        ])
    }

    if (viewState.presets.length === 0) {
        return h('div', { style: STYLE.panel }, [
            h('p', { key: 'title' }, t('view.noPresets')),
            h('p', { key: 'hint', style: STYLE.hint }, t('view.noPresetsHint')),
            h(Button, { key: 'retry', type: 'button', onClick: () => refresh() }, t('view.retry')),
        ])
    }

    if (draft === null || selectedPresetId === null) {
        return h('div', { style: STYLE.panel }, h('p', { style: STYLE.hint }, t('view.preparing')))
    }

    // 「注册到主页面」三态：桥缺席（旧壳）⇒ 总是渲染真面板，显示 true 并置灰（诚实回显）；
    // 桥在但配置还没到 ⇒ 显示配置里的值并置灰；都就绪 ⇒ 用桥的真实状态。
    const configMountOn = viewState.config?.mountMainPage !== false
    let mountOn = true
    if (mountBridge.available === true && mountBridge.ready === true) {
        mountOn = mountBridge.mounted

    } else if (mountBridge.available === true) {
        mountOn = configMountOn
    }

    const mountDisabled = mountBridge.available === false || mountBridge.ready === false || busy || mountBusy

    const observation = observationFor(viewState, selectedPresetId)
    // 工具候选 = 实时读数 ∪ 观察缓存 ∪ 已勾（已勾由 `toolRowsFor` 兜）；段与变量仍只来自观察，
    // 那两样的权威来源就是装配期采到的那一份。
    const toolFacts = mergeToolObservations(toolsByPreset[selectedPresetId], observation?.tools)
    const boundAgentId = draft.bindings.presets.find((binding) => binding.presetId === selectedPresetId)?.agentId

    // 这个预设的两个「平台钉死」旗标，由 host 侧读 composition 得出（平台服务不给这个信息）：
    // `promptFixed` 锁提示词集的装载区，`snapshotFixed` 锁快照开关，**两件事互不相干**。
    const selectedPreset = viewState.presets.find((preset) => preset.id === selectedPresetId)

    /**
     * 一个集的编辑器：提示词集是段清单、工具集是工具勾选、技能集是技能勾选。
     * 三者共用同一套「勾 / 不勾」的交互骨架，分派只看 kind。
     */
    function renderSetEditor(kind: PoolKind, set: DraftItem) {
        if (kind === 'promptSets') {
            return h(SectionEditor, {
                key: 'editor',
                sections: set.sections,
                platformSections: platformSectionsOf(observation),
                variables: promptVariablesOf(observation),
                onChange: (sections) => patchSet('promptSets', set.id, { sections }),
            })
        }

        if (kind === 'toolSets') {
            return h(ToolPicker, {
                key: 'editor',
                rows: toolRowsFor(toolFacts, new Set(set.tools)),
                owners: toolFacts?.owners,
                onChange: (names) => patchSet('toolSets', set.id, { tools: names }),
            })
        }

        return h(SkillPicker, {
            key: 'editor',
            rows: skillRowsFor((viewState as ReadyView).skills, new Set(set.skills)),
            onChange: (names) => patchSet('skillSets', set.id, { skills: names }),
        })
    }

    const actionNote = actionState.status === 'idle' || actionState.status === 'busy' ? null : h('div', {
        key: 'action',
        style: actionState.status === 'failed' ? STYLE.error : STYLE.ok,
    }, actionState.message)

    let detail = null
    if (selection.kind === 'agent') {
        const agent = draft.agents.find((candidate) => candidate.id === selection.agentId)

        detail = h('div', { key: 'agentDetail' }, [
            h(PoolActions, {
                key: 'actions',
                noun: nounOf('agent', t),
                canCopy: agent !== undefined,
                canRemove: agent !== undefined,
                onAdd: addAgent,
                onDuplicate: duplicateAgent,
                onRemove: removeAgent,
            }),
            agent === undefined
                ? h('div', { key: 'empty', style: STYLE.hint }, t('view.emptyAgentPool'))
                : h(AgentPanel, {
                    key: `agent-${agent.id}`,
                    agent,
                    draft,
                    observation,
                    models: viewState.models,
                    modelWarnings: viewState.modelWarnings,
                    snapshotOn: draft.runtimeContextOff.includes(agent.id) !== true,
                    promptLocked: selectedPreset?.promptFixed === true,
                    snapshotFixed: selectedPreset?.snapshotFixed === true,
                    idReferenceText: agentReferenceText(draft, agent.id, t),
                    onPatch: (changes) => patchAgent(agent.id, changes),
                    onLoadSet: (kind, setId) => loadSet(agent.id, kind, setId),
                    onUnloadSet: (kind, index) => unloadSet(agent.id, kind, index),
                    onMoveSet: (kind, index, delta) => moveSet(agent.id, kind, index, delta),
                    onOpenSet: (kind, setId) => setSelection({ kind, setId }),
                    onLoadEfforts: loadEfforts,
                    onToggleSnapshot: (on) => toggleSnapshot(agent.id, on),
                    onRenameId: (oldId, newId) => renameAgentId(oldId, newId),
                }),
        ])

    } else {
        const kind = selection.kind
        const noun = nounOf(kind, t)
        const set = draft[kind].find((candidate) => candidate.id === selection.setId)

        detail = h('div', { key: `${kind}Detail` }, [
            h(PoolActions, {
                key: 'actions',
                noun,
                canCopy: set !== undefined,
                canRemove: set !== undefined,
                onAdd: () => addSet(kind),
                onDuplicate: () => duplicateSet(kind),
                onRemove: () => removeSet(kind),
            }),
            set === undefined
                ? h('div', { key: 'empty', style: STYLE.hint }, t('view.emptyPool', { noun }))
                : h(SetEditorCard, {
                    // key 带上 setId：切换集 / 改 id 时重建组件，id 编辑态不会残留。
                    key: `editor-${set.id}`,
                    kind,
                    set,
                    idReferenceText: setReferenceText(draft, kind, set.id, t),
                    onPatch: (setId, changes) => patchSet(kind, setId, changes),
                    onRenameId: (oldId, newId) => renameSetId(kind, oldId, newId),
                    renderEditor: (target) => renderSetEditor(kind, target),
                }),
        ])
    }

    // 导入 / 导出共用一棵勾选树：两个弹窗各自持有勾选态，关掉即卸载（下次打开回到默认全勾）。
    const exportDialog = exportOpen !== true ? null : h(ExportDialog, {
        key: 'exportDialog',
        open: true,
        draft,
        onClose: () => setExportOpen(false),
        onConfirm: confirmExport,
    })

    const importDialog = importGroups === null ? null : h(ImportDialog, {
        key: 'importDialog',
        open: true,
        groups: importGroups,
        onClose: () => setImportGroups(null),
        onConfirm: confirmImport,
    })

    // 状态框（橙 / 绿）归保存行——`dirty` 已是它的 prop，面板根只剩布局。
    return h('div', { style: STYLE.panel }, [
        h(PresetBar, {
            key: 'bar',
            presets: viewState.presets,
            authorable: viewState.authorable,
            selectedPresetId,
            busy,
            form: barForm,
            agents: draft.agents,
            boundAgentId,
            onSelect: switchPreset,
            onBind: (agentId) => {
                const rest = draft.bindings.presets.filter((binding) => binding.presetId !== selectedPresetId)
                const next = agentId === undefined ? rest : [...rest, { presetId: selectedPresetId, agentId }]
                patchDraft({ bindings: { presets: next } })
            },
            onOpenForm: setBarForm,
            onFormPatch: (changes) => setBarForm((current) => ({ ...current!, ...changes })),
            onCloseForm: () => setBarForm(null),
            onCreatePreset: createPreset,
            onDeletePreset: deletePreset,
            onExport: () => setExportOpen(true),
            // 顶栏「导入」直接点开系统文件框：覆盖开关已经挪进树弹窗，不用先问一遍。
            onRequestImport: () => {
                const node = document.getElementById('agent-studio-import')
                if (node !== null) node.click()
            },
            onImportFile: importConfig,
        }),
        // 保存行与左栏是两个各自吸顶的块：保存行在前，左栏在 `body` 里按它让位。
        h(SaveBar, {
            key: 'saveBar',
            busy,
            dirty,
            savedOnce,
            mountMainPage: mountOn,
            mountAvailable: mountBridge.available,
            mountDisabled,
            onToggleMountMainPage: toggleMountMainPage,
            onSave: saveDraft,
            onHeightChange: setSaveBarHeight,
        }),
        actionNote,
        h('div', { key: 'body', style: STYLE.body }, [
            h(NavColumn, {
                key: 'nav',
                agents: draft.agents,
                promptSets: draft.promptSets,
                toolSets: draft.toolSets,
                skillSets: draft.skillSets,
                selection,
                stuckOffset: saveBarHeight,
                onSelectAgent: (agentId) => setSelection({ kind: 'agent', agentId }),
                onSelectSet: (kind, setId) => setSelection({ kind, setId }),
                onOpenPool: openPool,
            }),
            h('div', { key: 'detail', style: STYLE.detail }, [detail]),
        ]),
        exportDialog,
        importDialog,
    ])
}
