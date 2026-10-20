/**
 * 面板各模块共用的形状：观察结果、草稿四件套，以及每个组件的 props。
 *
 * @module dsh-agent-studio/client-parts/panel-types
 */
import type {
    ReactElement,
    ReactNode,
    CSSProperties,
    ChangeEvent,
} from 'react'
import type { StudioConfig, BackgroundMode, ToolPresentation } from '../../host/types'

// ── 部件各模块共用的类型：从 /api/dsh-agent-studio/* 取回与草稿归一化后的数据形状 ──────

/** 观察层采到的一段（平台全量段 / 缓存段共用此形状）。 */
export interface SectionObservation {
    name?: string
    enabled?: boolean
    text?: string
}

/** 观察层采到的工具清单各集合 + 来源归属。 */
export interface ToolObservation {
    known?: string[]
    visible?: string[]
    restrictable?: string[]
    reachable?: string[]
    owners?: Record<string, string>
}

/** 观察层采到的单个预设的「平台实际投递了什么」。 */
export interface ObservationUnit {
    presetId?: string
    observedAt: number
    sections?: SectionObservation[]
    variables?: Record<string, unknown>
    tools?: ToolObservation
}

/** 观察结果的 ready 形态：sessions（本次进程）与 cached（盘上遗留）共用结构。 */
export interface ObservationView {
    sessions: ObservationUnit[]
    cached: Record<string, ObservationUnit>
}

/** /skills 端点给的单个 skill 行。 */
export interface SkillRow {
    name?: string
    description?: string
    source?: string
}

/** 模型目录里的单个 provider。 */
export interface ProviderModel {
    id: string
    name?: string
    models?: ModelInfo[]
}

/** 模型目录里 provider 下的单个模型。 */
export interface ModelInfo {
    id: string
    name?: string
}

/** /models/efforts 端点给的单个推理档位。 */
export interface EffortInfo {
    id: string
    name?: string
}

/** 平台预设列表里的单个预设。 */
export interface Preset {
    id: string
    /** 平台发布的名字；**内置预设不发布**（host 那边是 `null`）⇒ 显示名走 `presetText()`。 */
    name?: string | null
    description?: string | null
    writable?: boolean
    /** 平台把提示词段钉死了（`complete: true`）——「提示词集」卡片的装载区据此禁用。 */
    promptFixed?: boolean
    /** 预设自己关了运行时快照（`includeRuntimeContext: false`）——快照开关据此禁用。 */
    snapshotFixed?: boolean
}

/** 段的可编辑副本（草稿内；没正文的段不写 `text` 键）。 */
export interface DraftSection {
    name: string
    enabled: boolean
    text?: string
}

/** 模型路由的可编辑副本（草稿内，字段恒在但可为 undefined）。 */
export interface DraftModel {
    provider: string | undefined
    model: string | undefined
    reasoningEffort: string | undefined
}

/**
 * 池项的「统一」形状：四个池的元素都带这些键（提示词集只用到 sections、工具集只
 * 用到 tools、技能集只用到 skills、代理用到 model/fallbacks/background/各装载名单与 children）。
 * 草稿里每个池都是 DraftItem[]，交叉取用时只访问当前 kind 相关的键。
 */
export interface DraftItem {
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
export interface DraftBinding {
    presetId: string
    agentId: string
}

/** 全量草稿（四个池 + 快照名单 + 绑定）。 */
export interface Draft {
    agents: DraftItem[]
    promptSets: DraftItem[]
    toolSets: DraftItem[]
    skillSets: DraftItem[]
    runtimeContextOff: string[]
    bindings: { presets: DraftBinding[] }
}

/** 池的 kind（与 selection.kind 同一套取值）。 */
export type PoolKind = 'agent' | 'promptSets' | 'toolSets' | 'skillSets'

/** 集池的 kind（装/卸/改名专用，不含 Agent 池）。 */
export type SetKind = 'promptSets' | 'toolSets' | 'skillSets'

/** clone* 接受的输入形状（host 配置与草稿都能喂进来）。 */
export interface RawModel {
    provider?: string
    model?: string
    reasoningEffort?: string
}
export interface RawAgent {
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
export interface RawSet {
    id?: string
    name?: string
    note?: string
    sections?: SectionObservation[]
    tools?: string[]
    skills?: string[]
}
export interface RawBinding {
    presetId?: string
    agentId?: string
}

/** 导入文件里的一项：四个池的原始项（带哪几个键由池名决定）。 */
export type RawPoolItem = RawAgent & RawSet

/** 段编辑器里一节候选段（platformSections 的形状：名字经过过滤，恒在）。 */
export interface PlatformSection {
    name: string
    text: string | undefined
}

/** 工具清单的一行（toolRowsFor 产出）。 */
export interface ToolRow {
    name: string
    checked: boolean
}

/** 技能清单的一行（skillRowsFor 产出；没名字的 skill 不进清单）。 */
export interface SkillRowOut {
    name: string
    description: string
    source: string
    checked: boolean
}

/** 工具清单的 owners（名字 → 来源）。 */
export type ToolOwners = Record<string, string>

/** 模型选择的三级联动里「思考强度」的取数态。 */
export interface EffortState {
    status: 'idle' | 'busy' | 'ok' | 'failed'
    list?: EffortInfo[]
    message?: string
}

/** 「+ 平台预设」弹窗的局部态。 */
export interface SectionPickerState {
    query: string
    preview: string | null
}

/** 面板本体的视图状态（loading / ready / failed）。 */
export type ViewState =
    | { status: 'loading'; config?: StudioConfig | null }
    | { status: 'ready'; config?: StudioConfig | null; sessions: ObservationUnit[]; cached: Record<string, ObservationUnit>; presets: Preset[]; authorable: boolean; models: ProviderModel[]; modelWarnings: string[]; skills: SkillRow[] }
    | { status: 'failed'; config?: StudioConfig | null; message: string }

/** 视图状态里「数据都在」的那一支（嵌套函数里读 ready 字段用）。 */
export type ReadyView = Extract<ViewState, { status: 'ready' }>

/** 导入合并时引用校验的基准（三个集池的 id 集合）。 */
export interface RefsOf {
    promptSets: Set<string>
    toolSets: Set<string>
    skillSets: Set<string>
}

/** 顶栏「新建/删除预设」表单态。 */
export type BarForm =
    | { kind: 'create'; from: string; id: string; name: string; description: string }
    | { kind: 'delete' }
    | null

/** 顶栏表单的补丁（部分字段）。 */
export interface BarFormPatch {
    from?: string
    id?: string
    name?: string
    description?: string
}

/** 「新建预设」那一支表单的字段（`createPreset` 读写用）。 */
export type CreateForm = Extract<BarForm, { kind: 'create' }>

/** 动作（保存 / 导入导出）的反馈态。 */
export type ActionState =
    | { status: 'idle' }
    | { status: 'busy' }
    | { status: 'ok'; message: string }
    | { status: 'failed'; message: string }

/**
 * 主页面挂载的运行时桥状态（壳挂在 window 上的 __dshAgentStudioMount）。
 *
 * `available` 是桥在不在：旧壳没有它 ⇒ 开关置灰并提示重启。`ready` 是壳读到
 * host 那个开关没有——没读到之前用配置里的值回显，面板不能比 host 更早知道答案。
 */
export interface MountBridgeState {
    available: boolean
    ready: boolean
    mounted: boolean
}

/** 左栏与编辑器共用的选中项：Agent 池看 agentId、集池看 setId，用不到的留空。 */
export interface Selection {
    kind: PoolKind
    agentId?: string | null
    setId?: string | null
}

/**
 * 导入 / 导出树的一个分组：一个池一组，行只有 id 与显示名（合并要用的整份数据在
 * 面板的引用里备着，树不装业务字段）。勾选键是 `<kind>:<id>`（见 panel-transfer）。
 */
export interface TransferGroup {
    kind: PoolKind
    title: string
    items: { id: string; label: string }[]
}

/** 导入弹窗确认时交回去的结果：勾中的键 + 撞 id 要不要覆盖。 */
export interface ImportConfirm {
    selected: string[]
    overwrite: boolean
}

// ── 组件 props 接口 ───────────────────────────────────────────────────

/** 一排单选档位（后台模式、Agent 模式共用）；`T` 是各档自己的值域。 */
export interface ChoiceProps<T extends string> {
    options: { id: T; label: string }[]
    value: T
    onChange: (id: T) => void
}
export interface ConfigCardProps {
    title: string
    hint?: string
    /**
     * 视觉上的「这张卡被平台锁了」：整卡淡一层。
     * **只管视觉**——交互禁用由卡内各区自己决定（快照开关与装载区锁的不是同一件事）。
     */
    disabled?: boolean
    children: ReactNode
}
export interface FieldRowProps {
    label: string
    style?: CSSProperties
    /** 行尾附加项（按钮对等）：自然宽、顶到最右，不参与主控件的「撑满」。 */
    tail?: ReactNode
    children: ReactNode
}
export interface MoveButtonsProps {
    isTop: boolean
    isBottom: boolean
    onMove: (delta: number) => void
}
export interface FormButtonsProps {
    okText: string
    okDisabled?: boolean
    onOk: () => void
    onCancel: () => void
}
export interface CandidateRowProps {
    label: string
    items: { id: string; label: string; title?: string }[]
    onPick: (id: string) => void
}
export interface MenuAnchorProps {
    open: boolean
    text: ReactNode
    disabled?: boolean
    onClick: () => void
}
export interface HelpTipProps {
    text: ReactNode
    /** 自定义锚点（不给 = 行内「?」圆标）：弹窗预览用它把整段文字变成悬停锚点。 */
    children?: ReactNode
    /** 浮层尺寸档：`wide` 给长正文用（更宽、自动换行、限高可滚），默认是小卡。 */
    size?: 'default' | 'wide'
}
export interface IdEditorProps {
    id: string
    referenceText: string
    onRename: (newId: string) => string | null
}
export interface SectionEditorProps {
    sections: DraftSection[]
    platformSections: PlatformSection[]
    variables: Record<string, unknown>
    onChange: (sections: DraftSection[]) => void
}
export interface ToolPickerProps {
    rows: ToolRow[]
    owners: ToolOwners | undefined
    onChange: (names: string[]) => void
}
export interface SkillPickerProps {
    rows: SkillRowOut[]
    onChange: (names: string[]) => void
}
export interface GroupHeadProps {
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
export interface RouteRowsProps {
    value: DraftModel
    models: ProviderModel[]
    /** 读档位的警告（主模型那份传；候选行不显示，省一块屏）。 */
    warnings?: string[]
    /** 第一行（供应商）行尾的附加项——主模型在那儿挂「?」浮层。 */
    tail?: ReactNode
    onChange: (model: DraftModel) => void
    onLoadEfforts: (provider: string, model: string) => Promise<EffortInfo[]>
}
export interface FallbackListProps {
    /** 候选行（有序）；空数组 = 不接管自动降级。 */
    rows: DraftModel[]
    models: ProviderModel[]
    onChange: (rows: DraftModel[]) => void
    onLoadEfforts: (provider: string, model: string) => Promise<EffortInfo[]>
}
export interface PresetBarProps {
    presets: Preset[]
    /** 平台的预设创作入口在不在（不在 = 新建与删除都置灰）。 */
    authorable: boolean
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
    /** 导出按钮：打开导出勾选树。 */
    onExport: () => void
    /** 导入按钮：直接点开隐藏的文件输入（覆盖开关在树弹窗里，不再先弹确认框）。 */
    onRequestImport: () => void
    /** 隐藏文件输入的 onChange：面板解析文件、弹导入勾选树。 */
    onImportFile: (event: ChangeEvent<HTMLInputElement>) => void
}
export interface SaveBarProps {
    busy: boolean
    dirty: boolean
    savedOnce: boolean
    /** 「注册到主页面」的当前值：桥缺席时恒为 true——旧壳总是渲染真面板。 */
    mountMainPage: boolean
    /** 运行时桥在不在：旧壳没有它，开关置灰（提示重启）。 */
    mountAvailable: boolean
    /** 什么时候点不动：桥缺席 / 还没读到 / 保存或切换正在飞。 */
    mountDisabled: boolean
    /** 切「注册到主页面」：写 host 上的全局开关，不经草稿、不触发保存。 */
    onToggleMountMainPage: (next: boolean) => void
    onSave: () => void
    /** 上报自身高度：左栏要按它往下让位，免得两行吸顶叠在一起。 */
    onHeightChange: (height: number) => void
}
export interface TransferTreeProps {
    groups: TransferGroup[]
    /** 勾中的勾选键（`<kind>:<id>`）。 */
    selected: string[]
    onToggle: (key: string, checked: boolean) => void
    /** 整组勾 / 取消：`keys` 是这一组的全部勾选键。 */
    onToggleGroup: (keys: string[], checked: boolean) => void
}
export interface ExportDialogProps {
    open: boolean
    /** 导出源：当前草稿（含未保存的改动）。 */
    draft: Draft
    onClose: () => void
    /** 点「导出选中项」：把勾中的键交回去，面板据此拼文件。 */
    onConfirm: (selected: string[]) => void
}
export interface ImportDialogProps {
    open: boolean
    /** 面板解析好的文件内容（一个池一组）。 */
    groups: TransferGroup[]
    onClose: () => void
    onConfirm: (result: ImportConfirm) => void
}
export interface NavColumnProps {
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
export interface AgentPanelProps {
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
export interface SetLoadSectionProps {
    kind: PoolKind
    draft: Draft
    loadedIds: string[]
    onLoad: (setId: string) => void
    onUnload: (index: number) => void
    onMove: (index: number, delta: number) => void
    onOpen: (setId: string) => void
}
export interface ChildPickerProps {
    agent: DraftItem
    draft: Draft
    onToggle: (childId: string, attached: boolean) => void
}
export interface PoolActionsProps {
    noun: string
    canCopy: boolean
    canRemove: boolean
    onAdd: () => void
    onDuplicate: () => void
    onRemove: () => void
}
export interface SetEditorCardProps {
    kind: PoolKind
    set: DraftItem
    idReferenceText: string
    onPatch: (setId: string, changes: Partial<DraftItem>) => void
    onRenameId: (oldId: string, newId: string) => string | null
    renderEditor: (set: DraftItem) => ReactElement
}
