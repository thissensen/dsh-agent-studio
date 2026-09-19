/**
 * dsh-agent-studio 的「面板部件」：真正的面板实现。壳在 `src/client/index.ts`。
 *
 * **谁加载它。** 壳挂在设置页里的 `ShellSection` 用 <script> 标签加载这个文件的
 * 构建产物（host 的 `/api/dsh-agent-studio/client-parts/panel.js` 路由**每次读盘**
 * 伺服），加载完成后壳 `require('dsh-agent-studio-panel')` 拿到的就是这里的
 * `AgentStudioSection`。**改这个文件只需要刷新页面**——它不在 DSH 的启动快照里；
 * 但改壳（以及 lib/、client/ 下的其它文件）仍要重启 DSH。
 *
 * **注册形态。** bundle 的包装层（`vite.shared.ts` 的 renderChunk）把整个模块包进
 * `window.__ModuleLoader__.load({ id, factory })` 外壳，所以这个文件自己**不写**
 * 注册代码，只导出 `AgentStudioSection`。
 *
 * **面板形态（v2）。** Agent 中心 = 顶栏（预设 / 主代理绑定 / 保存区三排）＋
 * 左栏（二级菜单：Agent 池 / 提示词集 / 工具集 / 技能集，各自的项在池名下）＋
 * 主区（选中项的编辑器，顶部一排「新建 / 复制 / 删除」）。四个池互相独立、多对多引用：
 *
 *   - **绑定即接管**（覆盖语义）：绑了代理的预设，提示词、工具面与技能面完全按该代理
 *     装载的集来——一个都没装 = 空（不是"不干预"）；没绑定的预设完全不干预。
 *   - 工具面：装了工具集 = 收窄到它们的并集（空集 = 全排除，含平台装在 agent 本层的
 *     工具）；一个都不装 = 不干预（全给）。
 *   - 技能面同理；「注入运行时环境快照」开关**按代理**（runtimeContextOff）。
 *
 * **数据从哪来。** 全经 `/api/dsh-agent-studio/*`（见 host 侧 `src/host/api.ts`）：
 * 观察结果、插件配置、平台预设列表、模型目录、技能清单，以及写配置与管预设的端点。
 * 面板不自己拼配置、不缓存拷贝，每次打开或点刷新都重新问 host；改动先进草稿
 * （全量四件套），点「保存改动」才写回。
 *
 * @module dsh-agent-studio/client-parts/panel
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import type { ReactElement, ReactNode, CSSProperties, ChangeEvent } from 'react'
import { Button, Checkbox, IconChevronDownOutline14, IconChevronUpOutline14, Input, Menu, Modal, Pill, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PlatformTranslate, CopyKey, Translate } from '../locales'
import { createTranslate, translateZh } from '../locales'
import type { StudioConfig, BackgroundMode, ToolPresentation } from '../../host/types'
// 样式全在 `../styles/`（按功能分文件、共用原子在 `basis`）。
import {
    CLEAR_BUTTON,
    ELLIPSIS,
    ELLIPSIS_FIT,
    FAINT_LINE,
    FIELD_LABEL,
    HAIRLINE,
    HELP_ANCHOR,
    HELP_ANCHOR_FLEX,
    HELP_CARD,
    HELP_CARD_WIDE,
    HINT,
    INLINE_ROW,
    NAV_HEIGHT_RESERVE,
    NOTICE,
    RESET_NATIVE_CONTROL,
    ROW_LAYOUT,
    ROW_SPACER,
    ROW_TAIL,
    SAVE_BAR_CLEAN,
    SAVE_BAR_DIRTY,
    SELECTED_FACE,
    STYLE,
    TREE_INDENT,
} from '../styles'

const { useEffect, useLayoutEffect, useRef, useState } = React
const h = React.createElement

/**
 * 翻译上下文：壳把平台注入的 `t` 经 props 传进来，这里往下发给每个组件。
 *
 * 面板部件是运行时从 host 加载的，**拿不到 cordis ctx**（seed 表里只有 react /
 * primitives 这类基础模块），所以 `t` 只能靠传；默认值是中文兜底——旧壳 + 新部件
 * （用户还没重启）时面板依旧完整可用，只是没有英文。
 */
const TranslateContext = React.createContext<Translate>(translateZh)

/** 取当前翻译器。 */
function useT(): Translate {
    return React.useContext(TranslateContext)
}

// ── 文件私有类型：从 /api/dsh-agent-studio/* 取回与草稿归一化后的数据形状 ──────

/** 观察层采到的一段（平台全量段 / 缓存段共用此形状）。 */
interface SectionObservation {
    name?: string
    enabled?: boolean
    text?: string
}

/** 观察层采到的工具清单各集合 + 来源归属。 */
interface ToolObservation {
    known?: string[]
    visible?: string[]
    restrictable?: string[]
    reachable?: string[]
    owners?: Record<string, string>
}

/** 观察层采到的单个预设的「平台实际投递了什么」。 */
interface ObservationUnit {
    presetId?: string
    observedAt: number
    sections?: SectionObservation[]
    variables?: Record<string, unknown>
    tools?: ToolObservation
}

/** 观察结果的 ready 形态：sessions（本次进程）与 cached（盘上遗留）共用结构。 */
interface ObservationView {
    sessions: ObservationUnit[]
    cached: Record<string, ObservationUnit>
}

/** /skills 端点给的单个 skill 行。 */
interface SkillRow {
    name?: string
    description?: string
    source?: string
}

/** 模型目录里的单个 provider。 */
interface ProviderModel {
    id: string
    name?: string
    models?: ModelInfo[]
}

/** 模型目录里 provider 下的单个模型。 */
interface ModelInfo {
    id: string
    name?: string
}

/** /models/efforts 端点给的单个推理档位。 */
interface EffortInfo {
    id: string
    name?: string
}

/** 平台预设列表里的单个预设。 */
interface Preset {
    id: string
    name?: string
    description?: string
    writable?: boolean
    /** 平台把提示词段钉死了（`complete: true`）——「提示词集」卡片的装载区据此禁用。 */
    promptFixed?: boolean
    /** 预设自己关了运行时快照（`includeRuntimeContext: false`）——快照开关据此禁用。 */
    snapshotFixed?: boolean
}

/** 段的可编辑副本（草稿内；没正文的段不写 `text` 键）。 */
interface DraftSection {
    name: string
    enabled: boolean
    text?: string
}

/** 模型路由的可编辑副本（草稿内，字段恒在但可为 undefined）。 */
interface DraftModel {
    provider: string | undefined
    model: string | undefined
    reasoningEffort: string | undefined
}

/**
 * 池项的「统一」形状：四个池的元素都带这些键（提示词集只用到 sections、工具集只
 * 用到 tools、技能集只用到 skills、代理用到 model/fallbacks/background/各装载名单与 children）。
 * 草稿里每个池都是 DraftItem[]，交叉取用时只访问当前 kind 相关的键。
 */
interface DraftItem {
    id: string
    name: string
    note: string
    model: DraftModel
    /** 备用候选链（有序；自动降级用）。空 = 不接管。 */
    fallbacks: DraftModel[]
    /** 每个候选各自的重试上限（自动降级用）。 */
    maxRetries: number
    background: BackgroundMode
    toolPresentation: ToolPresentation
    promptSets: string[]
    toolSets: string[]
    skillSets: string[]
    children: string[]
    sections: DraftSection[]
    tools: string[]
    skills: string[]
}

/** 预设绑定（草稿内）。 */
interface DraftBinding {
    presetId: string
    agentId: string
}

/** 全量草稿（四个池 + 快照名单 + 绑定）。 */
interface Draft {
    agents: DraftItem[]
    promptSets: DraftItem[]
    toolSets: DraftItem[]
    skillSets: DraftItem[]
    runtimeContextOff: string[]
    bindings: { presets: DraftBinding[] }
}

/** 池的 kind（与 selection.kind 同一套取值）。 */
type PoolKind = 'agent' | 'promptSets' | 'toolSets' | 'skillSets'

/** 集池的 kind（装/卸/改名专用，不含 Agent 池）。 */
type SetKind = 'promptSets' | 'toolSets' | 'skillSets'

/** clone* 接受的输入形状（host 配置与草稿都能喂进来）。 */
interface RawModel {
    provider?: string
    model?: string
    reasoningEffort?: string
}
interface RawAgent {
    id?: string
    name?: string
    note?: string
    model?: RawModel
    fallbacks?: RawModel[]
    maxRetries?: number
    background?: BackgroundMode
    toolPresentation?: ToolPresentation
    promptSets?: string[]
    toolSets?: string[]
    skillSets?: string[]
    children?: string[]
}
interface RawSet {
    id?: string
    name?: string
    note?: string
    sections?: SectionObservation[]
    tools?: string[]
    skills?: string[]
}
interface RawBinding {
    presetId?: string
    agentId?: string
}

/** 导入文件里的一项：四个池的原始项（带哪几个键由池名决定）。 */
type RawPoolItem = RawAgent & RawSet

/** 段编辑器里一节候选段（platformSections 的形状：名字经过过滤，恒在）。 */
interface PlatformSection {
    name: string
    text: string | undefined
}

/** 工具清单的一行（toolRowsFor 产出）。 */
interface ToolRow {
    name: string
    checked: boolean
}

/** 技能清单的一行（skillRowsFor 产出；没名字的 skill 不进清单）。 */
interface SkillRowOut {
    name: string
    description: string
    source: string
    checked: boolean
}

/** 工具清单的 owners（名字 → 来源）。 */
type ToolOwners = Record<string, string>

/** 模型选择的三级联动里「思考强度」的取数态。 */
interface EffortState {
    status: 'idle' | 'busy' | 'ok' | 'failed'
    list?: EffortInfo[]
    message?: string
}

/** 「+ 平台预设」弹窗的局部态。 */
interface SectionPickerState {
    query: string
    preview: string | null
}

/** 面板本体的视图状态（loading / ready / failed）。 */
type ViewState =
    | { status: 'loading'; config?: StudioConfig | null }
    | { status: 'ready'; config?: StudioConfig | null; sessions: ObservationUnit[]; cached: Record<string, ObservationUnit>; presets: Preset[]; models: ProviderModel[]; modelWarnings: string[]; skills: SkillRow[] }
    | { status: 'failed'; config?: StudioConfig | null; message: string }

/** 视图状态里「数据都在」的那一支（嵌套函数里读 ready 字段用）。 */
type ReadyView = Extract<ViewState, { status: 'ready' }>

/** 导入合并时引用校验的基准（三个集池的 id 集合）。 */
interface RefsOf {
    promptSets: Set<string>
    toolSets: Set<string>
    skillSets: Set<string>
}

/** 顶栏「新建/删除预设」表单态。 */
type BarForm =
    | { kind: 'create'; from: string; id: string; name: string; description: string }
    | { kind: 'delete' }
    | null

/** 顶栏表单的补丁（部分字段）。 */
interface BarFormPatch {
    from?: string
    id?: string
    name?: string
    description?: string
}

/** 「新建预设」那一支表单的字段（`createPreset` 读写用）。 */
type CreateForm = Extract<BarForm, { kind: 'create' }>

/** 动作（保存 / 导入导出）的反馈态。 */
type ActionState =
    | { status: 'idle' }
    | { status: 'busy' }
    | { status: 'ok'; message: string }
    | { status: 'failed'; message: string }

/** 左栏与编辑器共用的选中项：Agent 池看 agentId、集池看 setId，用不到的留空。 */
interface Selection {
    kind: PoolKind
    agentId?: string | null
    setId?: string | null
}

// ── 组件 props 接口 ───────────────────────────────────────────────────

/** 一排单选档位（后台模式、Agent 模式共用）；`T` 是各档自己的值域。 */
interface ChoiceProps<T extends string> {
    options: { id: T; label: string }[]
    value: T
    onChange: (id: T) => void
}
interface ConfigCardProps {
    title: string
    hint?: string
    /**
     * 视觉上的「这张卡被平台锁了」：整卡淡一层。
     * **只管视觉**——交互禁用由卡内各区自己决定（快照开关与装载区锁的不是同一件事）。
     */
    disabled?: boolean
    children: ReactNode
}
interface FieldRowProps {
    label: string
    style?: CSSProperties
    /** 行尾附加项（按钮对等）：自然宽、顶到最右，不参与主控件的「撑满」。 */
    tail?: ReactNode
    children: ReactNode
}
interface MoveButtonsProps {
    isTop: boolean
    isBottom: boolean
    onMove: (delta: number) => void
}
interface FormButtonsProps {
    okText: string
    okDisabled?: boolean
    onOk: () => void
    onCancel: () => void
}
interface CandidateRowProps {
    label: string
    items: { id: string; label: string; title?: string }[]
    onPick: (id: string) => void
}
interface MenuAnchorProps {
    open: boolean
    text: ReactNode
    disabled?: boolean
    onClick: () => void
}
interface HelpTipProps {
    text: ReactNode
    /** 自定义锚点（不给 = 行内「?」圆标）：弹窗预览用它把整段文字变成悬停锚点。 */
    children?: ReactNode
    /** 浮层尺寸档：`wide` 给长正文用（更宽、自动换行、限高可滚），默认是小卡。 */
    size?: 'default' | 'wide'
}
interface IdEditorProps {
    id: string
    referenceText: string
    onRename: (newId: string) => string | null
}
interface SectionEditorProps {
    sections: DraftSection[]
    platformSections: PlatformSection[]
    variables: Record<string, unknown>
    onChange: (sections: DraftSection[]) => void
}
interface ToolPickerProps {
    rows: ToolRow[]
    owners: ToolOwners | undefined
    onChange: (names: string[]) => void
}
interface SkillPickerProps {
    rows: SkillRowOut[]
    onChange: (names: string[]) => void
}
interface GroupHeadProps {
    /** 组名：勾选框的可见文字，也是折叠开关的无障碍名锚点。 */
    name: string
    /** 「已勾 / 可勾」计数（`3/12`）——拼装在调用点，组件不认两个数。 */
    count: string
    /** 整组是否都在（组勾选框的选中态；部分勾选不画中间态）。 */
    allChecked: boolean
    folded: boolean
    onChange: (next: boolean) => void
    onToggle: () => void
}
interface RouteRowsProps {
    value: DraftModel
    models: ProviderModel[]
    /** 读档位的警告（主模型那份传；候选行不显示，省一块屏）。 */
    warnings?: string[]
    /** 第一行（供应商）行尾的附加项——主模型在那儿挂「?」浮层。 */
    tail?: ReactNode
    onChange: (model: DraftModel) => void
    onLoadEfforts: (provider: string, model: string) => Promise<EffortInfo[]>
}
interface FallbackListProps {
    /** 候选行（有序）；空数组 = 不接管自动降级。 */
    rows: DraftModel[]
    models: ProviderModel[]
    onChange: (rows: DraftModel[]) => void
    onLoadEfforts: (provider: string, model: string) => Promise<EffortInfo[]>
}
interface PresetBarProps {
    presets: Preset[]
    selectedPresetId: string | null
    busy: boolean
    form: BarForm
    agents: DraftItem[]
    boundAgentId: string | undefined
    onSelect: (presetId: string) => void
    onBind: (agentId: string | undefined) => void
    onOpenForm: (form: BarForm) => void
    onFormPatch: (changes: BarFormPatch) => void
    onCloseForm: () => void
    onCreatePreset: () => void
    onDeletePreset: () => void
    onExport: () => void
    onImport: (event: ChangeEvent<HTMLInputElement>) => void
}
interface SaveBarProps {
    busy: boolean
    dirty: boolean
    savedOnce: boolean
    poolWord: string
    onSave: () => void
    onExportPool: () => void
    onImportPool: (event: ChangeEvent<HTMLInputElement>) => void
    /** 上报自身高度：左栏要按它往下让位，免得两行吸顶叠在一起。 */
    onHeightChange: (height: number) => void
}
interface NavColumnProps {
    agents: DraftItem[]
    promptSets: DraftItem[]
    toolSets: DraftItem[]
    skillSets: DraftItem[]
    selection: Selection
    /** 上方吸附行（保存行）占掉的高度，含两行之间的间隙——左栏要按它往下让位。 */
    stuckOffset: number
    onSelectAgent: (agentId: string) => void
    onSelectSet: (kind: PoolKind, setId: string) => void
    onOpenPool: (kind: PoolKind) => void
}
interface AgentPanelProps {
    agent: DraftItem
    draft: Draft
    observation: ObservationUnit | undefined
    models: ProviderModel[]
    modelWarnings: string[]
    snapshotOn: boolean
    /** 当前预设把提示词段钉死了（`complete: true`）⇒「提示词集」卡的装载区禁用。 */
    promptLocked: boolean
    /** 当前预设自己关了运行时快照（`includeRuntimeContext: false`）⇒ 快照开关禁用。 */
    snapshotFixed: boolean
    idReferenceText: string
    onPatch: (changes: Partial<DraftItem>) => void
    onLoadSet: (kind: SetKind, setId: string) => void
    onUnloadSet: (kind: SetKind, index: number) => void
    onMoveSet: (kind: SetKind, index: number, delta: number) => void
    onOpenSet: (kind: PoolKind, setId: string) => void
    onLoadEfforts: (provider: string, model: string) => Promise<EffortInfo[]>
    onToggleSnapshot: (on: boolean) => void
    onRenameId: (oldId: string, newId: string) => string | null
}
interface SetLoadSectionProps {
    kind: PoolKind
    draft: Draft
    loadedIds: string[]
    onLoad: (setId: string) => void
    onUnload: (index: number) => void
    onMove: (index: number, delta: number) => void
    onOpen: (setId: string) => void
}
interface ChildPickerProps {
    agent: DraftItem
    draft: Draft
    onToggle: (childId: string, attached: boolean) => void
}
interface PoolActionsProps {
    noun: string
    canCopy: boolean
    canRemove: boolean
    onAdd: () => void
    onDuplicate: () => void
    onRemove: () => void
}
interface SetEditorCardProps {
    kind: PoolKind
    set: DraftItem
    idReferenceText: string
    onPatch: (setId: string, changes: Partial<DraftItem>) => void
    onRenameId: (oldId: string, newId: string) => string | null
    renderEditor: (set: DraftItem) => ReactElement
}

/** host 侧的全部端点。写端点另需自定义头，见 `postJson`。 */
const ENDPOINTS = {
    observation: '/api/dsh-agent-studio/observation',
    config: '/api/dsh-agent-studio/config',
    skills: '/api/dsh-agent-studio/skills',
    presets: '/api/dsh-agent-studio/presets',
    models: '/api/dsh-agent-studio/models',
    efforts: '/api/dsh-agent-studio/models/efforts',
    createPreset: '/api/dsh-agent-studio/presets/create',
    deletePreset: '/api/dsh-agent-studio/presets/delete',
}

/** 写围栏要求的自定义头：它让请求变成非简单请求，跨站页面伪造不出来。 */
const MUTATION_HEADER = { 'x-dsh-agent-studio': '1' }

/** 子代理后台模式。映射到官方派活语义，仅被当子代理时生效。 */
/** 选项数组都带上显式元素类型：否则 `Choice` 的泛型会从字面量推成 `string`，丢掉值域。 */
/** `labelKey` 而不是文案：这两排是模块级常量，`t` 到渲染时才拿得到。 */
const BACKGROUND_MODES: { id: BackgroundMode; labelKey: CopyKey }[] = [
    { id: 'always-background', labelKey: 'background.always' },
    { id: 'foreground', labelKey: 'background.foreground' },
    { id: 'model-decides', labelKey: 'background.modelDecides' },
]

/** Agent 模式三档（id 与 host 侧 `TOOL_PRESENTATIONS` 同一套；文案见字典）。 */
const TOOL_PRESENTATIONS: { id: ToolPresentation; labelKey: CopyKey }[] = [
    { id: 'follow', labelKey: 'presentation.follow' },
    { id: 'native', labelKey: 'presentation.native' },
    { id: 'ptc', labelKey: 'presentation.ptc' },
]

/** 把带 `labelKey` 的选项表翻成 `Choice` 要的 `label`。 */
function choiceOptions<T extends string>(options: { id: T; labelKey: CopyKey }[], t: Translate): { id: T; label: string }[] {
    return options.map((option) => ({ id: option.id, label: t(option.labelKey) }))
}

// ── 取数与写回 ──────────────────────────────────────────────────────────

/**
 * 取一份 JSON，`ok` 不为 true 就当失败抛出。
 * @param url - 端点。
 * @param options - fetch 选项。
 */
async function fetchJson(url: string, options?: RequestInit): Promise<Record<string, unknown>> {
    const rep = await fetch(url, options)
    const data = await rep.json()

    if (data?.ok !== true) {
        throw Error(data?.error ?? `HTTP ${rep.status}`)
    }

    return data
}

/**
 * 打一个写请求。写围栏要求自定义头与 JSON content-type，两者都在这里给齐。
 * @param url - 端点。
 * @param body - 请求体对象。
 */
async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
    return fetchJson(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...MUTATION_HEADER },
        body: JSON.stringify(body),
    })
}

/**
 * 读观察结果。
 *
 * `sessions` 是 host 进程这次采到的，`cached` 是上次留下的（按预设索引）。
 * 工具名与平台预设名只在装配期存在，所以冷启动时只有 `cached` 能列候选——
 * 见 `observationFor`。
 */
async function loadObservation(): Promise<{ sessions: ObservationUnit[]; cached: Record<string, ObservationUnit> }> {
    const data = await fetchJson(ENDPOINTS.observation)
    return {
        sessions: Array.isArray(data.sessions) ? data.sessions : [],
        cached: (data.cached ?? {}) as Record<string, ObservationUnit>,
    }
}

/**
 * 读技能清单（host 侧**主动**问官方技能服务，不等任何对话）。
 *
 * 失败不抛给调用方：技能候选为空只是「这次没读到」，不该让整个面板打不开；
 * 读不到时退回空数组（技能集编辑器会显示对应的提示文案）。
 */
async function loadSkills(): Promise<SkillRow[]> {
    try {
        const data = await fetchJson(ENDPOINTS.skills)
        return Array.isArray(data.skills) ? data.skills : []

    } catch {
        return []
    }
}

/** 读插件配置（可能是 null：设置服务未就绪）。 */
async function loadConfig(): Promise<StudioConfig | null> {
    const data = await fetchJson(ENDPOINTS.config)
    return (data.config as StudioConfig | null | undefined) ?? null
}

/** 读平台预设列表（id、显示名、描述、可写性）。 */
async function loadPresets(): Promise<Preset[]> {
    const data = await fetchJson(ENDPOINTS.presets)
    return Array.isArray(data.presets) ? data.presets : []
}

/**
 * 读模型目录（provider + 模型清单）。
 *
 * `warnings` 记的是「某个 provider 的模型清单没读出来」——host 侧遇到这种情况会跳过
 * 那一个（而不是让整份清单空掉），但用户在面板上得看见少的是谁，
 * 否则只会以为那个 provider 根本不存在。
 */
async function loadModels(): Promise<{ providers: ProviderModel[]; warnings: string[] }> {
    const data = await fetchJson(ENDPOINTS.models)

    return {
        providers: Array.isArray(data.providers) ? data.providers : [],
        warnings: Array.isArray(data.warnings) ? data.warnings : [],
    }
}

/**
 * 读某个模型支持的推理档位。档位集合随模型变，所以只能在选中后现问。
 * @param provider - provider id。
 * @param model - model id。
 */
async function loadEfforts(provider: string, model: string): Promise<EffortInfo[]> {
    const query = `?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`
    const data = await fetchJson(`${ENDPOINTS.efforts}${query}`)
    return Array.isArray(data.efforts) ? data.efforts : []
}

// ── 事实整理（纯函数，界面用它把观察结果讲成人话） ───────────────────────

/**
 * 某个预设的观察事实——「平台实际投递了什么」的全部来源。
 *
 * 优先**这次进程**采到的（同一预设可能有好几个会话，取最新的那个），没有就退回
 * host 从盘上带来的那份：工具名只在装配期存在（它属于会话的 scope 层），所以冷启动、
 * 还没对过话时，盘上那份是唯一能让面板列出完整候选的东西（见 `lib/cache.js`）。
 * 两份形状一样，界面不用分情况。
 *
 * @param viewState - 面板状态（`sessions` 与 `cached`）。
 * @param presetId - 预设 id。
 */
function observationFor(viewState: ObservationView, presetId: string): ObservationUnit | undefined {
    const matched = viewState.sessions.filter((session) => session.presetId === presetId)
    if (matched.length === 0) return viewState.cached?.[presetId]

    return matched.slice().sort((left, right) => right.observedAt - left.observedAt)[0]
}

/**
 * 平台全量段（进本插件改写之前的那份）：`[{ name, text }]`。
 *
 * `text` 是平台当次求值的正文（观察层新留的字段），「+ 平台预设」弹窗的预览靠它；
 * 旧版本缓存里没这个字段，取不到就退化成没有预览（绝不因此报错）。
 */
function platformSectionsOf(observation: ObservationUnit | undefined): PlatformSection[] {
    return (observation?.sections ?? [])
        .filter((section): section is SectionObservation & { name: string } => section?.name !== undefined)
        .map((section) => ({
            name: section.name,
            text: typeof section.text === 'string' ? section.text : undefined,
        }))
}

/** 平台已注册的插值变量（名字 → 值）；观察层没采过时是空对象。 */
function promptVariablesOf(observation: ObservationUnit | undefined): Record<string, unknown> {
    return observation?.variables ?? {}
}

/**
 * 工具清单的每一行。
 *
 * v2 全显示、全可勾：候选 = 观察到的全部名字（平台已知 ∪ 可见 ∪ 可收窄 ∪ 上层已放行）
 * ∪ 配置里点过名的，不再有「不可勾」的档位——判「能不能生效」是宿主翻译时的事
 * （见 `apply.js`），界面不替它下结论，也不做隐藏/变灰分支。
 *
 * @param tools - 观察结果里的 `tools` 各集合（可能没有：从没装配过就没有）。
 * @param checkedNames - 当前勾选的名字集合。
 */
function toolRowsFor(tools: ToolObservation | undefined, checkedNames: Set<string>): ToolRow[] {
    const names = new Set([
        ...(tools?.known ?? []),
        ...(tools?.visible ?? []),
        ...(tools?.restrictable ?? []),
        ...(tools?.reachable ?? []),
        ...checkedNames,
    ])

    return [...names].sort().map((name) => ({ name, checked: checkedNames.has(name) }))
}

/**
 * 技能清单的每一行：候选 = host 主动读到的 skill 名字 ∪ 已勾的（配置里点过名的）。
 *
 * 与工具清单同一套原则：全显示、全可勾，不做灰行与隐藏分支。
 * 候选来自 `/skills` 端点（官方技能服务的主动读取，失败时 host 已回退缓存），
 * **不依赖任何对话**——打开面板就能列出。
 *
 * `source` 是技能来源（面板按它分组，见 `SKILL_SOURCE_KEYS`）；已勾却没在
 * 候选里的名字没有它——归「（无来源信息）」组，与旧缓存的退化路径同一条。
 *
 * @param skills - `/skills` 端点给的行（可能为空数组：服务没读到）。
 * @param checkedNames - 当前勾选的名字集合。
 */
function skillRowsFor(skills: SkillRow[] | undefined, checkedNames: Set<string>): SkillRowOut[] {
    const facts = new Map(
        (skills ?? [])
            .filter((skill): skill is SkillRow & { name: string } => skill?.name !== undefined)
            .map((skill) => [skill.name, skill]),
    )
    const names = new Set([...facts.keys(), ...checkedNames])

    return [...names].sort().map((name) => ({
        name,
        description: facts.get(name)?.description ?? '',
        source: facts.get(name)?.source ?? '',
        checked: checkedNames.has(name),
    }))
}

// ── 草稿 ────────────────────────────────────────────────────────────────

/**
 * 段的可编辑副本。
 *
 * `enabled` 归一化成显式布尔、`text` 保持「有字符串才有」的语义——与 host 侧
 * `apply.js` 的判据同源（有无正文决定它是自定义还是平台预设引用）。
 */
function cloneSection(section: SectionObservation): DraftSection {
    return {
        name: section?.name ?? '',
        enabled: section?.enabled !== false,
        text: typeof section?.text === 'string' ? section.text : undefined,
    }
}

/** 模型路由的可编辑副本。 */
function cloneModel(model: RawModel | undefined): DraftModel {
    return {
        provider: model?.provider,
        model: model?.model,
        reasoningEffort: model?.reasoningEffort,
    }
}

/** 代理的可编辑副本。字段顺序固定——脏检查是序列化比对，顺序必须稳定。 */
function cloneAgent(agent: RawAgent): DraftItem {
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
function clonePromptSet(set: RawSet): DraftItem {
    return {
        id: set?.id ?? '',
        name: set?.name ?? '',
        note: set?.note ?? '',
        sections: (set?.sections ?? []).map(cloneSection),
    } as DraftItem
}

/** 工具集的可编辑副本。 */
function cloneToolSet(set: RawSet): DraftItem {
    return {
        id: set?.id ?? '',
        name: set?.name ?? '',
        note: set?.note ?? '',
        tools: [...(set?.tools ?? [])],
    } as DraftItem
}

/** 技能集的可编辑副本。 */
function cloneSkillSet(set: RawSet): DraftItem {
    return {
        id: set?.id ?? '',
        name: set?.name ?? '',
        note: set?.note ?? '',
        skills: [...(set?.skills ?? [])],
    } as DraftItem
}

/** 预设绑定的可编辑副本。 */
function cloneBinding(binding: RawBinding): DraftBinding {
    return { presetId: binding?.presetId ?? '', agentId: binding?.agentId ?? '' }
}

// ── 池的通用取用（四个池名字不同、形状一样，界面到处要按 kind 取） ──────────

/** 某个池在草稿里的数组；`kind` 与 selection.kind 同一套取值（Agent 池是 `'agent'`）。 */
function poolOf(draft: Draft | null | undefined, kind: PoolKind): DraftItem[] {
    if (kind === 'agent') return draft?.agents ?? []

    return draft?.[kind] ?? []
}

/** 池的界面名词的字典 key（英文里用单数：这些位置大多是「一个 X」的语境）。 */
function nounKeyOf(kind: PoolKind): CopyKey {
    if (kind === 'agent') return 'noun.agent'
    if (kind === 'promptSets') return 'noun.promptSets'
    if (kind === 'toolSets') return 'noun.toolSets'

    return 'noun.skillSets'
}

/** 池的界面名词。 */
function nounOf(kind: PoolKind, t: Translate): string {
    return t(nounKeyOf(kind))
}

/** 新建池项时的 id 前缀。 */
function idBaseOf(kind: PoolKind): string {
    if (kind === 'agent') return 'agent'
    if (kind === 'promptSets') return 'prompt-set'
    if (kind === 'toolSets') return 'tool-set'
    return 'skill-set'
}

/** 新建 / 复制 / 导入池项时的通用克隆器（只取归位时用得着的那些键）。 */
function cloneItemOf(kind: PoolKind, item: RawAgent | RawSet): DraftItem {
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
const DEFAULT_NAME_KEYS: Record<string, CopyKey> = {
    agents: 'defaultName.agents',
    promptSets: 'defaultName.promptSets',
    toolSets: 'defaultName.toolSets',
    skillSets: 'defaultName.skillSets',
    sections: 'defaultName.sections',
}

/** 取一个没被占用的默认名（记进 `taken`），规则同 host 侧 `pickDefaultName`。 */
function pickDefaultName(base: string, taken: Set<string>): string {
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
function fillNames<T extends { name?: string }>(items: T[], base: string): T[] {
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
function dropGhostBindings(config: StudioConfig | null, presets: Preset[]): StudioConfig | null {
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
function draftFor(config: StudioConfig | null | undefined, t: Translate): Draft {
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
function ensurePtcSections(sections: DraftSection[]): DraftSection[] {
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
function ensureRequiredTools(tools: string[]): string[] {
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
function missingRequiredItems(config: StudioConfig | null | undefined): boolean {
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
function isDirty(draft: Draft | null, config: StudioConfig | null | undefined, t: Translate): boolean {
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
function availableId(base: string, taken: Set<string>): string {
    let index = 1
    while (taken.has(`${base}-${index}`)) index += 1

    return `${base}-${index}`
}

/** 代理的显示名：优先名字，没名字退回 id。 */
function agentLabel(agent: DraftItem | undefined, t: Translate): string {
    return agent?.name !== '' && agent?.name !== undefined ? agent.name : agent?.id ?? t('common.unnamed')
}

/** 集的显示名：优先名字，没名字退回 id。 */
function setLabel(set: DraftItem | undefined, t: Translate): string {
    return set?.name !== '' && set?.name !== undefined ? set.name : set?.id ?? t('common.unnamed')
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
function loadConflictFor(
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
function setMemberNames(set: DraftItem | undefined, kind: PoolKind): string[] {
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
function memberNounKeyOf(kind: PoolKind): CopyKey {
    if (kind === 'promptSets') return 'member.promptSets'
    if (kind === 'toolSets') return 'member.toolSets'

    return 'member.skillSets'
}

/** 成员名的名词（装载重叠校验的提示文案用）。 */
function memberNounOf(kind: PoolKind, t: Translate): string {
    return t(memberNounKeyOf(kind))
}

/**
 * 保存前的全量静态校验（host 侧还会再校验一次，这里是即时反馈）。
 * @param draft - 当前草稿。
 * @param t - 翻译器。
 * @returns 问题描述；没问题时 null。
 */
function findDraftConflict(draft: Draft, t: Translate): string | null {
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
function findLoadedOverlap(
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

// ── 小控件 ──────────────────────────────────────────────────────────────

/**
 * 一组互斥单选（后台模式用）。
 * @param props - `{ options, value, onChange }`。
 */
function Choice<T extends string>(props: ChoiceProps<T>) {
    const { options, value, onChange } = props

    return h('span', { style: { display: 'inline-flex', gap: '4px' } },
        options.map((option) => {
            const style = option.id === value ? { ...STYLE.tab, ...STYLE.tabActive } : STYLE.tab

            return h('button', {
                key: option.id,
                type: 'button',
                onClick: () => onChange(option.id),
                style,
            }, option.label)
        }))
}

/**
 * 一张配置卡片：标题 + 说明 + 内容。面板里那几张卡片都是这三段，
 * 抽出来之后改版式只改这一处。
 * @param props - `{ title, hint, children }`；`hint` 可省。
 */
function ConfigCard(props: ConfigCardProps) {
    const { title, hint, disabled, children } = props

    return h('div', { style: { ...STYLE.card, ...(disabled === true ? { opacity: 0.55 } : {}) } }, [
        h('div', { key: 'title', style: STYLE.cardTitle }, title),
        hint === undefined ? null : h('div', { key: 'hint', style: STYLE.hint }, hint),
        children,
    ])
}

/**
 * 把「一个元素或一组元素」统一成数组。
 *
 * `FieldRow` 用它把 children 摊平后再展开传给 `h()`：自检脚本的定位器
 * （形如 `.children.flat()`）只摊一层，多套一层数组它就找不到里面的控件了。
 */
function itemsOf(value: ReactNode): ReactNode[] {
    return Array.isArray(value) ? value : [value]
}

// ── 菜单锚点 ────────────────────────────────────────────────────────────
/**
 * 菜单触发器的统一锚点按钮：文字 + 尾部 chevron。
 *
 * 为什么不用最省事的默认 `Button`（ghost）：它在设置页的卡片底色上就是一段
 * 纯文本，用户会当成标签而不是下拉（第十八轮用户反馈，并点名参照社区插件
 * DSH-better-sidebar 的 selectAnchor——有边框、有底、尾部带 chevron）。
 * 这里取平台唯一「有边框」的 `outline` 变体打底（hover 反馈由它自带），
 * 只把圆角收到 8px 与旁边的 `Input` 对齐观感。
 *
 * 宽度交给所在的 `FieldRow` 控件槽：槽的 grid stretch 会把 `Menu` 的根壳（`span`，
 * `inline-flex`）拉满，但壳里的锚点自己是 `flex: 0 1 auto` ⇒ 还得 `width: 100%`
 * 才能跟着填满（真机量过：不加就是内容宽的一块，撑不到右缘）。由此也不设 `maxWidth`。
 * `space-between` 让文字顶左、chevron 顶右——撑满之后就是下拉框该有的样子
 * （Button 默认的 `justify-content: center` 会把「文字+箭头」整体摆中间）。
 *
 * chevron 包一层 `flex: none` 的 span：平台图标组件只吃 `size`/`className`，
 * 不接受 `style`，直接放会跟着文字一起被压。
 *
 * @param props - `{ open, text, disabled, onClick }`；`open` 只影响 chevron 朝向。
 */
function menuAnchor(props: MenuAnchorProps): ReactElement {
    const { open, text, disabled, onClick } = props

    return h(Button, {
        type: 'button',
        variant: 'outline',
        disabled,
        onClick,
        style: STYLE.menuAnchor,
    }, [
        h('span', {
            key: 'text',
            style: { display: 'block', minWidth: '0', ...STYLE.ellipsis },
        }, text),
        h('span', {
            key: 'caret',
            style: { display: 'inline-flex', flex: 'none', color: 'var(--dsw-alias-label-tertiary)' },
        }, h(IconChevronDownOutline14, { size: 12 })),
    ])
}

/**
 * 问号悬浮卡：hover 500ms 后弹出的一段说明（只读）。
 *
 * **为什么不用平台的 `HoverCard`**（它本来是最省事的选择）：它的卡片
 * `z-index: 100` 是组件库内写死的，而宿主设置页是一层 `z-index: 1000` 的全屏
 * 弹层 ⇒ 卡片永远落在设置页**背后**，发暗、看不全（2026-09-17 真机截图取证）。
 * 它不接受 `className`/`style`，插件侧补不了层级，所以这里按同一份视觉抄一个：
 * 244px 宽、12px 圆角、`#2C2C2E` 底、阴影 lv3；层级取平台「菜单 portal」的
 * 1100（`Menu.module.css` 的注释：弹窗内的浮层也必须盖在弹窗之上）。
 *
 * 行为与平台一致：针停在锚点 500ms 才开（防误触），移开即关；卡片挂到 body，
 * 指针可以移到卡片上。
 *
 * @param props - `{ text }`：说明正文；锚点固定是行内的「?」圆标。
 */
function HelpTip(props: HelpTipProps): ReactElement {
    const { text, children, size = 'default' } = props
    const [open, setOpen] = useState(false)
    const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
    const anchorRef = useRef<HTMLSpanElement | null>(null)
    const cardRef = useRef<HTMLDivElement | null>(null)
    const timerRef = useRef<number | null>(null)
    const closeTimerRef = useRef<number | null>(null)

    function clearOpenTimer() {
        if (timerRef.current !== null) {
            window.clearTimeout(timerRef.current)
            timerRef.current = null
        }
    }

    function clearCloseTimer() {
        if (closeTimerRef.current !== null) {
            window.clearTimeout(closeTimerRef.current)
            closeTimerRef.current = null
        }
    }

    function scheduleOpen() {
        clearCloseTimer()
        if (open) return

        clearOpenTimer()
        timerRef.current = window.setTimeout(() => setOpen(true), 500)
    }

    function scheduleClose() {
        clearOpenTimer()
        clearCloseTimer()
        closeTimerRef.current = window.setTimeout(() => setOpen(false), 120)
    }

    // 定位：贴锚点右侧 8px；快出视口底就往上顶（与平台 HoverCard 同一套算法）。
    useEffect(() => {
        if (!open) {
            setPos(null)
            return
        }

        function place() {
            const anchor = anchorRef.current
            if (anchor === null) return

            const rect = anchor.getBoundingClientRect()
            const height = cardRef.current?.offsetHeight ?? 0
            const width = cardRef.current?.offsetWidth ?? 244
            const top = rect.top + height > window.innerHeight - 8
                ? Math.max(8, window.innerHeight - height - 8)
                : rect.top
            // 右侧放不下就往左让：自定义锚点（弹窗里那条预览）可能贴着右缘，
            // 老实现只贴 `rect.right + 8`，wide 卡会整块出屏。
            const left = Math.max(8, Math.min(rect.right + 8, window.innerWidth - width - 8))
            setPos({ left, top })
        }

        place()
        window.addEventListener('scroll', place, true)
        window.addEventListener('resize', place)

        return () => {
            window.removeEventListener('scroll', place, true)
            window.removeEventListener('resize', place)
        }
    }, [open])

    // 卸载时把两个定时器清掉（面板随时可能被折叠/切走）。
    useEffect(() => () => {
        clearOpenTimer()
        clearCloseTimer()
    }, [])

    const anchor = h('span', {
        // Fragment 的两个子项按数组渲染 ⇒ 都要 key（同类问题见 `FieldRow` 的 children）。
        key: 'anchor',
        ref: anchorRef,
        onPointerEnter: () => scheduleOpen(),
        onPointerLeave: () => scheduleClose(),
        style: children === undefined ? HELP_ANCHOR : HELP_ANCHOR_FLEX,
    }, children ?? '?')

    if (!open) return anchor

    const card = h('div', {
        ref: cardRef,
        style: {
            ...(size === 'wide' ? HELP_CARD_WIDE : HELP_CARD),
            ...(pos === null ? { visibility: 'hidden' } : { left: `${pos.left}px`, top: `${pos.top}px` }),
        },
        onPointerEnter: () => clearCloseTimer(),
        onPointerLeave: () => scheduleClose(),
    }, text)

    return h(React.Fragment, null, [anchor, createPortal(card, document.body, 'card')])
}

/**
 * 字段行：「左标签 + 右控件」那一行。面板里凡是要对齐的输入行都走它，
 * 标签样式（`FIELD_LABEL`）与行的排布因此只有一处定义。
 *
 * **控件槽占满剩余宽度、右缘顶齐卡片**（2026-09-18 用户反馈「有的长有的短不好看」）。
 * 槽是单行 `grid`：靠 grid item 的默认 `stretch`，任何 `width: auto` 的子项都会被
 * 拉满轨道。之所以不用 flex 直接排——平台 `Input` 的外壳（`span`）是 `inline-flex`
 * 且只吃 `className`、不吃 `style`（`style` 会落到内层 `<input>` 上），在 flex 行里
 * 没法从外面让它伸展；grid 的 stretch 不看组件内部实现，照样拉满。
 *
 * 主控件区（`children`）：一个 ⇒ 撑满（`1fr`）；多个 ⇒ 各自自然宽（都撑满就并排
 * 抢空间了）。行尾的按钮对（「修改」「确定/取消」）一律走 `tail`——自然宽、顶到最右。
 *
 * @param props - `{ label, style, tail, children }`：`style` 是给这一行的额外样式
 *   （如 `marginTop`）；`children` 是主控件；`tail` 是行尾附加项（可选）。
 */
function FieldRow(props: FieldRowProps) {
    const { label, style, tail, children } = props
    const items = itemsOf(children)
    const tails = tail === undefined ? [] : itemsOf(tail)

    const main = items.length === 1
        ? 'minmax(0, 1fr)'
        : items.map(() => 'minmax(0, auto)').join(' ')
    const template = tails.length === 0 ? main : `${main} auto`

    return h('div', { style: style === undefined ? STYLE.row : { ...STYLE.row, ...style } }, [
        // `key: 'label'` 是自检脚本认「这一行有标签」的锚点，别改。
        h('span', { key: 'label', style: FIELD_LABEL }, label),
        h('div', {
            key: 'controls',
            style: {
                flex: '1 1 auto',
                minWidth: 0,
                display: 'grid',
                gridTemplateColumns: template,
                alignItems: 'center',
                gap: '8px',
            },
        }, [
            ...items,
            tails.length === 0
                ? null
                : h('div', {
                    key: 'tail',
                    style: { display: 'flex', alignItems: 'center', gap: '8px' },
                }, tails),
        ]),
    ])
}

/**
 * 「上移 / 下移」按钮对：段行、集装载行与备用候选三处的逐字级重复（连首尾禁用的
 * 算法都一样）。
 *
 * 返回**元素数组**而不是组件：它在父行的 flex 里必须直接当子项。
 * 一对箭头**自成一组**（外层 `span` 带 `ROW_TAIL`、组内 gap 收到 2px）——
 * 用户点名「箭头之间再小点」：原来两个箭头各占一个父行 gap（8px），
 * 现在整组只占一个，组内也更紧。图标改用平台 chevron（`↑`/`↓` 字符有缺字形的
 * 风险，同「展开箭头」那条）；图标没有文本 ⇒ **无障碍名必须给 `aria-label`**，
 * 与同一排的「展开」按钮取同一档 12px，大小才齐。
 *
 * @param props - `{ isTop, isBottom, onMove }`：`onMove(delta)` 收到 -1 / +1。
 * @param t - 翻译器（两个按钮的无障碍名）。
 */
function moveButtons(props: MoveButtonsProps, t: Translate): ReactElement[] {
    const { isTop, isBottom, onMove } = props

    return [
        h('span', { key: 'move', style: { display: 'inline-flex', gap: '2px', ...ROW_TAIL } }, [
            h(Button, {
                key: 'up',
                type: 'button',
                size: 'sm',
                'aria-label': t('common.moveUp'),
                onClick: () => onMove(-1),
                disabled: isTop,
            }, h(IconChevronUpOutline14, { key: 'icon', size: 12 })),
            h(Button, {
                key: 'down',
                type: 'button',
                size: 'sm',
                'aria-label': t('common.moveDown'),
                onClick: () => onMove(1),
                disabled: isBottom,
            }, h(IconChevronDownOutline14, { key: 'icon', size: 12 })),
        ]),
    ]
}

/**
 * 「确定 / 取消」按钮对。同样返回元素数组（理由同 `moveButtons`）。
 *
 * @param props - `{ okText, okDisabled, onOk, onCancel }`。
 * @param t - 翻译器（「取消」是这里自己的文案）。
 */
function formButtons(props: FormButtonsProps, t: Translate): ReactElement[] {
    const { okText, okDisabled, onOk, onCancel } = props
    const disabled = okDisabled === true

    return [
        h(Button, {
            key: 'ok',
            type: 'button',
            variant: 'primary',
            onClick: onOk,
            disabled,
        }, okText),
        h(Button, { key: 'cancel', type: 'button', onClick: onCancel }, t('common.cancel')),
    ]
}

/**
 * 候选行（「可装载：+ xxx」）：集装载区与子代理名册两处的逐字级重复。
 *
 * @param props - `{ label, items, onPick }`：`items` 是 `[{ id, label, title }]`，
 *   `onPick(id)` 收到点中的那个 id；空清单整行不画。
 */
function CandidateRow(props: CandidateRowProps): ReactElement | null {
    const { label, items, onPick } = props
    if (items.length === 0) return null

    return h('div', { key: 'candidates', style: { ...STYLE.row, marginTop: '4px' } }, [
        h('span', { key: 'label', style: STYLE.hint }, label),
        ...items.map((item) => h(Button, {
            key: item.id,
            type: 'button',
            size: 'sm',
            style: ROW_TAIL,
            onClick: () => onPick(item.id),
            title: item.title,
        }, `+ ${item.label}`)),
    ])
}

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
 * PTC 模式必备的两个段（2026-09-18 用户拍板）：**每个提示词集都常驻**（草稿层补位，
 * 见 `ensurePtcSections`），勾选框与「移除」锁死，**顺序仍可调**。
 *
 * 为什么常驻无害：这两个段只在 PTC 模式下由平台注册，原生模式下 `buildSections`
 * 找不到同名平台段是**静默跳过**（不报错、不留空行）；反过来，PTC 模式缺了它们，
 * 模型既不知道要写 `run_code`、也看不到任何工具。
 */
const PTC_REQUIRED_SECTIONS = ['tools:sdk', 'tools:ptc-only']

/**
 * 每个工具集都常驻的工具（2026-09-18 用户拍板：与必备段同一套「必勾」待遇）。
 *
 * `skill` 是技能清单下发的开关——平台 `dsh-tool-skill` 在 pre-step 里先看这个工具在不在
 * 该 agent 的工具面里，不在就当作「这份清单用不了」，整条技能目录都不注入；而工具集是
 * 收窄语义，不在集里的工具连调用都会被 guard 排除 ⇒ 漏勾它，技能等于废掉。
 *
 * 所以每个工具集都带上它：清单里那一行勾选框与「全不选」都动不了它，顺序照旧
 * （工具清单是数组，勾选顺序就是投递顺序）。名字与 host `config.ts` 的 `REQUIRED_TOOLS`
 * 是同一套——那边靠它豁免装载重叠校验。
 */
const REQUIRED_TOOLS = ['skill']

/**
 * 自动降级的默认重试上限：与 host 侧 `config.js` 的 `DEFAULT_MAX_RETRIES`
 * （schema 默认值、也是平台的 `maxRetries` 默认）同一个数。
 * 面板只负责显示与编辑坏值兜底，真值以 host 的 schema 为准。
 */
const DEFAULT_RETRIES = 5

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
function IdEditor(props: IdEditorProps) {
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
                onChange: (event) => {
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
function setReferenceText(draft: Draft, kind: PoolKind, setId: string, t: Translate): string {
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
function agentReferenceText(draft: Draft, agentId: string, t: Translate): string {
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
function validateNewId(pool: DraftItem[], oldId: string, newId: string, t: Translate): string | null {
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
function SectionEditor(props: SectionEditorProps) {
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
                    onChange: (event) => updateAt(index, { name: event.target.value }),
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
                    h(isOpen ? IconChevronUpOutline14 : IconChevronDownOutline14, { key: 'mark', size: 12 }),
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
            onChange: (event) => setPicker({ ...picker, query: event.target.value }),
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
function GroupHead(props: GroupHeadProps) {
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
        }, h(folded === true ? IconChevronDownOutline14 : IconChevronUpOutline14, { key: 'icon', size: 14 })),
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
function ToolPicker(props: ToolPickerProps) {
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
                onChange: (event) => setSearch(event.target.value),
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
 * 技能来源 → 组头的显示名。来源是平台文件系统扫描根的标识（`dsh-skill-filesystem`
 * 的 `roots()` 里那个 `source`），六个平台值 + 两个 agent 源别名（`agent-*`——
 * skills-manager 那类「按 agent 注册」的 provider 标的，`agent-agents` 就是
 * `user-agents` 的同一目录）；认不出的（runtime 注册、将来的其它 provider）
 * **原样显示**——不编造出处。
 *
 * 不用 `resourceBase.path` 分组：真机实测它是**技能自己的子目录**
 * （`…\.agents\skills\code-style`），拿它分组等于一技能一组。
 */
const SKILL_SOURCE_KEYS: Record<string, CopyKey> = {
    'project-dsh': 'skill.source.projectDsh',
    'project-agents': 'skill.source.projectAgents',
    custom: 'skill.source.custom',
    'user-dsh': 'skill.source.userDsh',
    'user-agents': 'skill.source.userAgents',
    bundled: 'skill.source.bundled',
    'agent-agents': 'skill.source.userAgents',
    'agent-ccswitch': 'skill.source.ccswitch',
}

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
function SkillPicker(props: SkillPickerProps) {
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
                onChange: (event) => setSearch(event.target.value),
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
function RouteRows(props: RouteRowsProps) {
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
function FallbackList(props: FallbackListProps) {
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
function parseRetryCount(text: string): number {
    const value = Number.parseInt(text, 10)
    if (Number.isSafeInteger(value) === false || value < 0) return DEFAULT_RETRIES

    return value
}

// ── 预设管理条 ──────────────────────────────────────────────────────────

/**
 * 顶部管理条：预设 Tab＋主代理绑定＋新建/删除预设＋导入/导出。
 *
 * 第三排「保存区」不在里面——它是独立的吸附行（`SaveBar`），得挂在面板根下才吸得住。
 *
 * Tab 上写预设的**显示名**（平台 `preset.yml` 里的 `name`，一般是中文），
 * id 只在没给显示名时顶上，同时挂在 `title` 里备查——用户认的是「标准模式」
 * 而不是 `standard`。
 *
 * @param props - 面板传下来的状态与事件。
 */
function PresetBar(props: PresetBarProps) {
    const {
        presets, selectedPresetId, busy, form, agents, boundAgentId,
        onSelect, onBind, onOpenForm, onFormPatch, onCloseForm,
        onCreatePreset, onDeletePreset, onExport, onImport,
    } = props

    const t = useT()

    /** 「来源」与「主代理绑定」两个下拉（`Menu`）的展开态。 */
    const [fromOpen, setFromOpen] = useState(false)
    const [bindOpen, setBindOpen] = useState(false)

    // 平台 `Pill`：自绘胶囊退役（灰底 / 选中描边 / 12px 都跟平台走）；
    // 悬停说明（`title`）与点击照旧。
    const tabs = presets.map((preset) => h(Pill, {
        key: preset.id,
        active: preset.id === selectedPresetId,
        onClick: () => onSelect(preset.id),
        title: preset.description ?? preset.id,
    }, preset.name ?? preset.id))

    const selectedPreset = presets.find((preset) => preset.id === selectedPresetId)
    const canDelete = selectedPreset?.writable === true

    // 新建 / 删除都走弹窗（`Modal` 壳）：内联表单塞在管理条里会把整条挤变形，
    // 而「从哪个预设复制」这类一次性选择也没必要常驻在那里。
    let formModal = null
    if (form?.kind === 'create') {
        const fromItems: MenuEntry[] = presets.map((preset) => ({ id: preset.id, label: preset.name ?? preset.id }))
        const fromChoice = presets.find((preset) => preset.id === form.from)
        const fromText = fromChoice === undefined ? form.from : fromChoice.name ?? fromChoice.id

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
                    onChange: (event) => onFormPatch({ id: event.target.value }),
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
                    onChange: (event) => onFormPatch({ name: event.target.value }),
                }),
            }),
            // 描述（2026-09-18 用户点名）：写进新预设的 `preset.yml`，会话的预设选择器里
            // 那一行小字就是它。留空 = 从来源预设继承（平台复制的默认行为）。
            // 多行输入（用户点名）：描述可能是一段话，单行框里写不下、也读不全；
            // 写入端 `yamlScalar` 对含换行的值走双引号标量，断行原样保留。
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
            t('preset.deleteConfirm', { name: selectedPreset?.name ?? selectedPresetId ?? '' })))
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
        label: t('bar.bindLabel', { preset: selectedPreset?.name ?? selectedPresetId ?? '' }),
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
            disabled: busy,
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
            title: canDelete === true ? t('bar.deleteEnabledTitle') : t('bar.deleteDisabledTitle'),
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
            onChange: onImport,
        }),
        // 隐藏的文件输入不能换成平台 `Input`，所以触发按钮用它自己的 onClick 把
        // 那个 input 点开（原来是 `<label htmlFor>`，换平台件后没有 label 那种转发）。
        h(Button, {
            key: 'import',
            type: 'button',
            variant: 'outline',
            onClick: () => {
                const node = document.getElementById('agent-studio-import')
                if (node !== null) node.click()
            },
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
 * 底部保存行：保存态 + 池级导入导出 + 保存改动。
 *
 * 它挂在面板根下（不是被管理条包着），才吸得住——见 `STYLE.saveBar` 的说明。
 * 每量到一次高度都往上报：左栏要按它往下让位，两行吸顶时不会叠在一起。
 *
 * @param props - 面板传下来的状态与事件。
 */
function SaveBar(props: SaveBarProps) {
    const { busy, dirty, savedOnce, poolWord, onSave, onExportPool, onImportPool, onHeightChange } = props
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
        stateText === null ? null : h('span', { key: 'state', style: stateStyle }, stateText),
        h('span', { key: 'spacer', style: ROW_SPACER }),

        // 池级导入导出：名字随左栏一级菜单变化，导的是**这一个池**的全部项。
        h('input', {
            key: 'poolFile',
            id: 'agent-studio-import-pool',
            type: 'file',
            accept: 'application/json,.json',
            style: { display: 'none' },
            onChange: onImportPool,
        }),
        h(Button, {
            key: 'poolImport',
            type: 'button',
            variant: 'outline',
            onClick: () => {
                const node = document.getElementById('agent-studio-import-pool')
                if (node !== null) node.click()
            },
            disabled: busy,
            title: t('bar.poolImportTitle', { pool: poolWord }),
        }, t('bar.poolImport', { pool: poolWord })),
        h(Button, {
            key: 'poolExport',
            type: 'button',
            variant: 'outline',
            onClick: onExportPool,
            title: t('bar.poolExportTitle', { pool: poolWord }),
        }, t('bar.poolExport', { pool: poolWord })),

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
function NavColumn(props: NavColumnProps) {
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

// ── 主区：Agent 详情 ────────────────────────────────────────────────────

/**
 * 代理详情：身份、提示词集、工具集、模型与后台、子代理。
 *
 * 「集」在这里只做装载/卸载/调序/跳转编辑——集本身住在池里（多对多共享），
 * 编辑集的内容要进「集库」视图，改一次所有装载它的代理一起变。
 *
 * @param props - 面板传下来的状态与事件。
 */
function AgentPanel(props: AgentPanelProps) {
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
                    onChange: (event) => onPatch({ name: event.target.value }),
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
                    onChange: (event) => onPatch({ note: event.target.value }),
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
                    onChange: (event) => onPatch({ maxRetries: parseRetryCount(event.target.value) }),
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
function SetLoadSection(props: SetLoadSectionProps) {
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
function ChildPicker(props: ChildPickerProps) {
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
function PoolActions(props: PoolActionsProps) {
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
function SetEditorCard(props: SetEditorCardProps) {
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
                    onChange: (event) => onPatch(set.id, { name: event.target.value }),
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
                    onChange: (event) => onPatch(set.id, { note: event.target.value }),
                }),
            }),
            renderEditor(set),
        ],
    })
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
function AgentStudioSection(props: { t?: PlatformTranslate }) {
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
            const [observationData, config, presets, modelCatalog, skills] = await Promise.all([
                loadObservation(),
                loadConfig(),
                loadPresets(),
                loadModels(),
                loadSkills(),
            ])

            // 幽灵绑定自愈（见 `dropGhostBindings`）：滤过的版本同时充当草稿来源与
            // 脏检查的比较基准——自愈本身不该被算成「有未保存的改动」。
            const liveConfig = dropGhostBindings(config, presets)

            setViewState({
                status: 'ready',
                sessions: observationData.sessions,
                cached: observationData.cached,
                config: liveConfig,
                presets,
                models: modelCatalog.providers,
                modelWarnings: modelCatalog.warnings,
                skills,
            })

            setSelectedPresetId((current) => {
                if (current !== null && presets.some((preset) => preset.id === current)) return current
                return presets[0]?.id ?? null
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

    /** 把一份 JSON 存成文件（总导出与池级导出共用）。 */
    function downloadJson(fileName: string, payload: unknown) {
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)

        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = fileName
        anchor.click()
        URL.revokeObjectURL(url)
    }

    /**
     * 导出**全部**配置：带版本号的 JSON 文件。
     *
     * 导的是草稿——面板上看到的就是用户手上的版本，未保存的改动也一起带走
     * （导完点不点保存由用户自己决定）。按钮的悬停提示里写明了「全部数据」。
     */
    function exportConfig() {
        const payload = {
            version: 2,
            exportedAt: new Date().toISOString(),
            agents: draft?.agents ?? [],
            promptSets: draft?.promptSets ?? [],
            toolSets: draft?.toolSets ?? [],
            skillSets: draft?.skillSets ?? [],
            runtimeContextOff: draft?.runtimeContextOff ?? [],
            bindings: draft?.bindings ?? { presets: [] },
        }

        downloadJson('agent-studio-config.json', payload)
    }

    /** 导出当前一级菜单那个池的全部项（草稿，含未保存的改动）。 */
    function exportPool() {
        const kind = selection.kind
        const payload = {
            version: 2,
            kind,
            exportedAt: new Date().toISOString(),
            items: poolOf(draft, kind),
        }

        downloadJson(`agent-studio-${kind}.json`, payload)
    }

    /** 从导入文件里取一个池的项：池级文件是 `items`，全量文件退回同名字段。 */
    function readImportItems(payload: Record<string, unknown>, kind: PoolKind): RawPoolItem[] {
        if (Array.isArray(payload?.items)) return payload.items

        const key = kind === 'agent' ? 'agents' : kind
        return Array.isArray(payload?.[key]) ? payload[key] : []
    }

    /** 三个集池的 id 集合：Agent 的引用校验基准（现有草稿）。 */
    function refsOf(draft: Draft): RefsOf {
        return {
            promptSets: new Set(draft.promptSets.map((set) => set.id)),
            toolSets: new Set(draft.toolSets.map((set) => set.id)),
            skillSets: new Set(draft.skillSets.map((set) => set.id)),
        }
    }

    /** 导入报错文案里的项名：有名字用名字，没有就用 id。 */
    function importLabelOf(item: DraftItem) {
        return typeof item?.name === 'string' && item.name !== '' ? item.name : item?.id ?? ''
    }

    /** Agent 的引用校验：引用的集必须在（现有 + 同批导入的）池里，缺一个就整批拒绝。 */
    function assertRefsOk(kind: PoolKind, item: DraftItem, refs: RefsOf) {
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
     * 把一个池的导入项并进草稿——**判 id、重复报错、不重复追加**（2026-09-17 拍板）。
     *
     * 撞 id 时整批拒绝（不覆盖、不改名、不重写引用）：合并结果先落在草稿里，
     * 用户看过再点保存。Agent 额外做引用校验，`refs` 是（合并后的）三个集池的 id 集合。
     *
     * @param kind - 池名（`'agent'` / `'promptSets'` / `'toolSets'` / `'skillSets'`）。
     * @param existing - 草稿里的现有数组。
     * @param incoming - 导入的原始项（会过一遍归位克隆）。
     * @param refs - 引用校验基准；只对 Agent 用。
     * @returns 合并后的新数组。
     */
    function mergePoolItems(kind: PoolKind, existing: DraftItem[], incoming: RawPoolItem[], refs?: RefsOf): DraftItem[] {
        if (incoming.length === 0) return existing

        const taken = new Map(existing.map((item) => [item.id, item]))
        const added = []

        for (const raw of incoming) {
            const item = cloneItemOf(kind, raw)
            if (item.id === '' || item.id === undefined) {
                throw Error(t('validate.importIdEmpty', { noun: nounOf(kind, t) }))
            }

            const before = taken.get(item.id)
            if (before !== undefined) {
                throw Error(t('validate.importIdClash', {
                    id: item.id,
                    label: importLabelOf(item),
                    beforeId: before.id,
                    beforeLabel: importLabelOf(before),
                }))
            }

            if (kind === 'agent') assertRefsOk(kind, item, refs!)
            taken.set(item.id, item)
            added.push(item)
        }

        return [...existing, ...added]
    }

    /** 导入当前一级菜单那个池：池级文件（或全量文件里的对应字段）并进草稿。 */
    async function importPool(event: ChangeEvent<HTMLInputElement>) {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (file === undefined) return

        setActionState({ status: 'busy' })

        try {
            const payload = JSON.parse(await file.text())
            const kind = selection.kind
            const incoming = readImportItems(payload, kind)
            if (incoming.length === 0) throw Error(t('validate.importNoItems'))

            const before = poolOf(draft!, kind)
            const next = mergePoolItems(kind, before, incoming, refsOf(draft!))
            const key = kind === 'agent' ? 'agents' : kind

            patchDraft({ [key]: next })
            setActionState({
                status: 'ok',
                message: t('validate.importPoolDone', { count: next.length - before.length, noun: nounOf(kind, t) }),
            })

        } catch (err) {
            setActionState({ status: 'failed', message: t('validate.importFailed', { message: (err as Error).message }) })
        }
    }

    /**
     * 导入全部配置：把一份备份**合并进当前草稿**（不直接落盘）。
     *
     * 内部就是**依次调子导入**（先集后代理——代理要引用集，反了会自己报缺集），
     * 规则与池级导入同一套：判 id、撞了就整批拒绝、不重复追加。
     */
    async function importConfig(event: ChangeEvent<HTMLInputElement>) {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (file === undefined) return

        setActionState({ status: 'busy' })

        try {
            const payload = JSON.parse(await file.text())

            const skillSets = mergePoolItems('skillSets', draft!.skillSets, readImportItems(payload, 'skillSets'))
            const promptSets = mergePoolItems('promptSets', draft!.promptSets, readImportItems(payload, 'promptSets'))
            const toolSets = mergePoolItems('toolSets', draft!.toolSets, readImportItems(payload, 'toolSets'))

            // Agent 的引用校验基准 = 上面三个池**合并后**的 id 集合。
            const refs = {
                promptSets: new Set(promptSets.map((set) => set.id)),
                toolSets: new Set(toolSets.map((set) => set.id)),
                skillSets: new Set(skillSets.map((set) => set.id)),
            }
            const agents = mergePoolItems('agent', draft!.agents, readImportItems(payload, 'agent'), refs)

            patchDraft({ agents, promptSets, toolSets, skillSets })
            setActionState({
                status: 'ok',
                message: t('validate.importConfigDone', {
                    promptSets: promptSets.length - draft!.promptSets.length,
                    toolSets: toolSets.length - draft!.toolSets.length,
                    skillSets: skillSets.length - draft!.skillSets.length,
                    agents: agents.length - draft!.agents.length,
                }),
            })

        } catch (err) {
            setActionState({ status: 'failed', message: t('validate.importFailed', { message: (err as Error).message }) })
        }
    }

    /** 新建预设（走平台复制 API；描述由 host 侧补写进新预设的 `preset.yml`）。 */
    async function createPreset() {
        setActionState({ status: 'busy' })

        try {
            const created = await postJson(ENDPOINTS.createPreset, {
                from: (barForm as CreateForm).from,
                id: (barForm as CreateForm).id,
                name: (barForm as CreateForm).name === '' ? undefined : (barForm as CreateForm).name,
                description: (barForm as CreateForm).description === '' ? undefined : (barForm as CreateForm).description,
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

    /** 删除当前预设（平台只让删用户自己建的）。 */
    async function deletePreset() {
        setActionState({ status: 'busy' })

        try {
            await postJson(ENDPOINTS.deletePreset, { id: selectedPresetId })

            setBarForm(null)
            setSelectedPresetId(null)
            await refresh(false)
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

    const observation = observationFor(viewState, selectedPresetId)
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
                rows: toolRowsFor(observation?.tools, new Set(set.tools)),
                owners: observation?.tools?.owners,
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

    // 池级导入导出的按钮名跟着左栏一级菜单走；Agent 池用「Agent」而不是「代理」
    // （用户第 2 条反馈里的原话就是「Agent导出」）。
    const poolWord = selection.kind === 'agent' ? 'Agent' : nounOf(selection.kind, t)

    // 状态框（橙 / 绿）归保存行——`dirty` 已是它的 prop，面板根只剩布局。
    return h('div', { style: STYLE.panel }, [
        h(PresetBar, {
            key: 'bar',
            presets: viewState.presets,
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
            onExport: exportConfig,
            onImport: importConfig,
        }),
        // 保存行与左栏是两个各自吸顶的块：保存行在前，左栏在 `body` 里按它让位。
        h(SaveBar, {
            key: 'saveBar',
            busy,
            dirty,
            savedOnce,
            poolWord,
            onSave: saveDraft,
            onExportPool: exportPool,
            onImportPool: importPool,
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
    ])
}


/** 面板部件对外的唯一出口：壳拿到它挂进 settings.section。 */
export { AgentStudioSection }
