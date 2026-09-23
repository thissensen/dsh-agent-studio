/**
 * 插件的配置 schema（v2「Agent 中心」）。
 *
 * 三个池 + 一份绑定，互相独立、多对多引用：
 *
 *   - `agents`      代理池：一个代理 = 「提示词集 + 工具集 + 模型 + 后台模式 + 子代理名册」；
 *   - `promptSets`  提示词集池：有序段清单（带 `text` = 自定义，不带 = 引用平台预设）；
 *   - `toolSets`    工具集池：工具名清单；
 *   - `bindings.presets` 把某个「预设」绑到一个代理上——绑了才干预该预设的装配，
 *     没绑 = 完全不干预（维持「随插随用」语义）。
 *
 * 另有一个**不是池**的字段：`createdPresets` 存本插件建出来的预设的**定义原文**
 * （0.1.7 起平台的预设是运行时注册的插件声明、不落盘，所以借这里落盘，见
 * `PresetDefinitionSchema`）。它与三个池同纪律用数组，但**面板不渲染编辑它**。
 *
 * **三个池都是数组而不是字典，这一点不能改。** 设置服务的写入语义是「对象递归合并、
 * 数组整体替换」，也就是说合并写**删不掉对象里的键**——字典形态下界面永远无法删除
 * 一个成员（v1 的 `entries` 就栽在这里）。数组整体替换天然支持增删与重排。
 * 代价是唯一性得自己保证：id 在各池内唯一，由界面与写入端点把关（见 `findLoadConflict`）。
 *
 * 老键（`presets` 等）不读、不管、不删：settings 合并语义删不掉对象子键，写删除逻辑
 * 也是白写；新结构全部用新键，与老数据不冲突。
 *
 * **字段全部标 `.volatile()`，这不是性能选项而是写入通道的准入条件**（2026-09-24 源码核实）：
 * 平台的 `SettingsForms` 只把 schema 里标了 volatile 的字段投影成可编辑表单
 * （`volatileForm()`），写入时 `write()` 先查有没有 volatile 字段（没有就抛
 * `has no volatile fields`），再逐个校验待写路径落在 volatile 子树里（否则抛
 * `Config field "X" is not volatile`）。不标 = 面板一个字都存不进去，且本插件在官方
 * 设置面板里根本不出现。代价是平台把每个字段包成**引用**（`{ get() }`），插件必须
 * 现取现解包（`readConfig()`）——换来的是改配置不必重启插件，见 `index.ts`。
 *
 * @module dsh-agent-studio/config
 */

import z from '@deepseek-ai/schemastery'
import type {
    AgentConfig,
    BackgroundMode,
    BindingsConfig,
    PresetBinding,
    PromptSetConfig,
    SectionConfig,
    SkillSetConfig,
    StudioConfig,
    ToolPresentation,
    ToolSetConfig,
} from './types.js'

/**
 * 本插件在 profile 里那条 row 的 id。
 *
 * 平台称它为 `SettingsNamespace`（设置命名空间），实际就是 profile patch 里
 * `- insert: [{ id: ... }]` 那个 id——写入端点 `settings.update(ns, …)` 按它定位。
 * 必须与 `cordis.patch.yml` 的 row id 一致，也与 `index.js` 导出的 `name` 一致。
 */
export const SETTINGS_NAMESPACE = 'agent-studio'

/** 段配置：`name` 对应平台的 section 名，自定义项额外带 `text`。 */
export const SectionSchema = z.object({
    name: z.string().required(),
    enabled: z.boolean().default(true),
    text: z.string(),
})

/** 模型路由：provider 与 model 必须成对给；缺省 = 继承会话。 */
const ModelSchema = z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string(),
})

/** 子代理的后台模式：映射到 delegation 的 transport 参数。仅被当子代理时生效。 */
export const BACKGROUND_MODES = ['always-background', 'foreground', 'model-decides'] as const satisfies readonly BackgroundMode[]

/** Agent 模式三档：跟随预设（默认）/ 原生 / 强制 PTC。 */
export const TOOL_PRESENTATIONS = ['follow', 'native', 'ptc'] as const satisfies readonly ToolPresentation[]

/** 自动降级的默认重试上限：与平台默认策略（dsh-llm 的 `maxRetries`）对齐。 */
export const DEFAULT_MAX_RETRIES = 5

/** 一个代理。 */
const AgentSchema = z.object({
    id: z.string().required(),
    name: z.string().default(''),
    note: z.string().default(''),
    model: ModelSchema.default({}),
    /** 每个候选各自重试的上限（自动降级；0 = 不重试、失败即换下一个候选）。 */
    maxRetries: z.number().step(1).min(0).default(DEFAULT_MAX_RETRIES),
    /** 备用候选链（有序）。空 = 自动降级不接管，重试行为与平台默认一致。 */
    fallbacks: z.array(ModelSchema).default([]),
    background: z.union(BACKGROUND_MODES).default('model-decides'),
    /** Agent 模式：`follow` = 跟随预设（不声明）；`native`/`ptc` = 本 agent 强制（各 agent 独立）。 */
    toolPresentation: z.union(TOOL_PRESENTATIONS).default('follow'),
    /** 已装提示词集，**有序**——集在列表里的顺序就是它的段在投递清单里的顺序。 */
    promptSets: z.array(z.string()).default([]),
    /** 已装工具集。装了 = 工具面收窄到并集；一个没装 = 不干预（全给）。 */
    toolSets: z.array(z.string()).default([]),
    /** 已装技能集。装了 = 只用并集里的 skill（其余对模型隐藏）；一个没装 = 不干预（全给）。 */
    skillSets: z.array(z.string()).default([]),
    /** 这个代理可以派出去的子代理 id 名册。 */
    children: z.array(z.string()).default([]),
})

/** 提示词集。 */
const PromptSetSchema = z.object({
    id: z.string().required(),
    name: z.string().default(''),
    note: z.string().default(''),
    sections: z.array(SectionSchema).default([]),
})

/** 工具集。 */
const ToolSetSchema = z.object({
    id: z.string().required(),
    name: z.string().default(''),
    note: z.string().default(''),
    tools: z.array(z.string()).default([]),
})

/** 技能集：勾选的 skill 名单（名字来自平台的 skill 注册表）。 */
const SkillSetSchema = z.object({
    id: z.string().required(),
    name: z.string().default(''),
    note: z.string().default(''),
    skills: z.array(z.string()).default([]),
})

/**
 * 预设 → 主代理的绑定。
 *
 * 同样是数组（对象键删不掉 ⇒ 没法解绑）。`presetId` 在数组里唯一。
 */
const PresetBindingSchema = z.object({
    presetId: z.string().required(),
    agentId: z.string().required(),
})

const BindingsSchema = z.object({
    presets: z.array(PresetBindingSchema).default([]),
})

/**
 * 自建预设的定义（0.1.7 起平台把预设从「目录里的文件」改成「插件声明」）。
 *
 * `id` / `name` / `description` 是给人看的那三项，平台 `register()` 直接收；
 * 构成声明放 `presetYaml`（entry-list YAML 文本）——**为什么不存解析好的 `plugins` 数组**：
 * 平台的 `settings` 写入通道重建 volatile 配置时会把 `!!js` 表达式求值成普通值
 * （2026-09-24 真机实测：磁盘上留下 `disabled: true`），表达式一进配置就没了条件语义。
 * 文本不会被求值，读出来再解析即可原样还原。**本字段面板不渲染编辑。**
 *
 * 为什么要把整份定义存进插件配置：注册是**运行时**的、平台不落盘，插件下次启动又被重新
 * 装配 ⇒ 不存就全丢。存这里等于借平台的 settings 通道落盘（插件自己不写文件）。
 *
 * **`z.string()` 那一支是给旧数据留的**（2026-09-24）：旧版本的 `createdPresets` 是字符串
 * id 数组，schema 若不认，平台校验不过会让**整条 row 失效**——用户的 agents / promptSets
 * 会一起读不出来。旧 id 对应的定义已经无处可寻（旧模型下那是平台目录里的文件），所以这一
 * 支只在读出时补成 `{ id }` 形状（`readConfig()` 里归一），面板上如实显示为一条空定义，
 * 用户删掉它即可；**不会**被当成能注册的预设（没有构成声明，注册表跳过）。
 */
const PresetDefinitionSchema = z.union([
    z.object({
        id: z.string().required(),
        name: z.string(),
        description: z.string(),
        presetYaml: z.string(),
    }),
    z.string(),
])

/**
 * 平台对 volatile 字段的包装：`get()` 返回当前快照。
 *
 * 平台改配置时就地更新这个引用（`loader/volatile-update`），所以**引用本身一直有效**，
 * 插件不必重启、也不必重新拿 config。
 */
interface ConfigRef<T> {
    get(): T
}

/**
 * 配置的声明形态（schema 的**输出**类型）。
 *
 * 每个顶层字段都被平台包成引用，所以这里不是 `StudioConfig`，而是它的引用形态——
 * 断言成它，`Config` 的字段集合与类型才继续受 `StudioConfig` 约束（少一个字段、
 * 类型对不上都会红），同时如实反映「取值要过一层 `get()`」。
 */
type ConfigOutputShape = { [K in keyof StudioConfig]: ConfigRef<StudioConfig[K]> }

/**
 * 顶层配置。平台按名字 `Config` 认它（`apply(ctx, config)` 的 config 就是它的解析结果）。
 *
 * 每个字段都标 `.volatile()`：全部字段都是本插件面板的编辑对象，而平台的写入通道只认
 * volatile 字段（理由见文件头注释）。
 */
export const Config = z.object({
    version: z.number().default(2).volatile(),
    createdPresets: z.array(PresetDefinitionSchema).default([]).volatile(),
    agents: z.array(AgentSchema).default([]).volatile(),
    promptSets: z.array(PromptSetSchema).default([]).volatile(),
    toolSets: z.array(ToolSetSchema).default([]).volatile(),
    skillSets: z.array(SkillSetSchema).default([]).volatile(),
    /**
     * 「关闭运行时环境快照注入」的**代理 id** 名单（数组：合并写删不掉对象键，且就地增删）。
     * 名单里的代理（绑定的主代理、或本插件派出去的子代理），装配期不投递官方的
     * runtime context 快照（沙箱策略 / 审批提示 / 工具失败统计那一整块）。默认名单为空
     * = 照常注入（官方默认行为）。
     *
     * 2026-09-17（第十五轮）语义从「预设 id」改为「代理 id」：开关搬进了 Agent 的
     * 提示词面（它是这个代理的提示词行为的一部分），跟着代理走——绑定即接管。
     */
    runtimeContextOff: z.array(z.string()).default([]).volatile(),
    bindings: BindingsSchema.default({}).volatile(),
}) as z<ConfigOutputShape>

/**
 * 一个顶层字段值是不是 volatile 引用。
 *
 * 要认两种情况：平台给的是引用（正常路径），而自检脚本与单元测试直接构造普通对象传进
 * `apply()`（没有 schema 解析这一步）。平台的 `isVolatile()` 靠内部 symbol 判断，本项目
 * 不引它的包，用结构判断——配置数据全是纯 JSON 值，不会有别的对象长着 `get` 方法。
 */
function isConfigRef(value: unknown): value is ConfigRef<unknown> {
    return typeof value === 'object' && value !== null && typeof (value as ConfigRef<unknown>).get === 'function'
}

/**
 * 取插件配置的当前值。
 *
 * **现取现解包**：面板随时可能改配置，所以每次要配置时都调它，别把结果存起来当快照。
 *
 * 顺带把 `createdPresets` 里的**遗留形态**（旧版存的字符串 id 数组）规范成定义对象
 * （2026-09-24）：平台侧 schema 是 `z.union([定义, z.string()])`，校验能过、值原样留着，
 * 到这一个出口才归一——这样旧盘上的数据照样读得出来，而不是让整条 row 失效。
 *
 * @param config - `apply(ctx, config)` 收到的那份（平台校验并解析过，volatile 字段是引用）。
 * @returns 普通对象形态的配置；解包不会改动入参。
 */
export function readConfig(config: unknown): StudioConfig {
    const 配置来源 = (config ?? {}) as Record<string, unknown>
    const 当前配置: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(配置来源)) {
        当前配置[key] = isConfigRef(value) ? value.get() : value
    }

    if (Array.isArray(当前配置.createdPresets)) {
        当前配置.createdPresets = 当前配置.createdPresets.map((项: unknown) => (
            typeof 项 === 'string' ? { id: 项 } : 项
        ))
    }

    return 当前配置 as StudioConfig
}

/**
 * 取一个代理。
 * @param config - 插件配置。
 * @param agentId - 代理 id。
 * @returns 代理；不存在时 undefined。
 */
export function agentById(config: StudioConfig | undefined, agentId: unknown): AgentConfig | undefined {
    if (typeof agentId !== 'string' || agentId === '') return undefined

    return config?.agents?.find((agent) => agent.id === agentId)
}

/**
 * 取某个预设绑定的主代理 id。
 * @param config - 插件配置。
 * @param presetId - 预设 id。
 * @returns 代理 id；该预设没绑定时 undefined（= 插件完全不干预它）。
 */
export function boundAgentId(config: StudioConfig | undefined, presetId: unknown): string | undefined {
    if (typeof presetId !== 'string' || presetId === '') return undefined

    return config?.bindings?.presets?.find((binding) => binding.presetId === presetId)?.agentId
}

/**
 * 把一组提示词集按装载顺序合并成一份段清单。
 *
 * 集在 `promptSetIds` 里的顺序、集内段的顺序，就是最终的顺序。找不到的集静默跳过
 * （预设被删、集被删都会造成悬空引用，那是常态而不是故障）。同名的段后到者不覆盖
 * ——正常路径下装载重叠校验已经拦住了，这里只是防御性的保序去重。
 *
 * @param config - 插件配置。
 * @param promptSetIds - 已装提示词集 id 列表。
 * @returns 合并后的段清单；一个集都没装时返回 undefined（段面不干预）。
 */
export function mergeSections(config: StudioConfig | undefined, promptSetIds: unknown): SectionConfig[] | undefined {
    if (!Array.isArray(promptSetIds) || promptSetIds.length === 0) return undefined

    const sections: SectionConfig[] = []
    const named = new Set<string>()

    for (const setId of promptSetIds) {
        const set = config?.promptSets?.find((candidate) => candidate.id === setId)
        if (set === undefined) continue

        for (const section of set.sections ?? []) {
            // 无名段（用户新建段时忘填）按默认名投递——空名只影响显示，不该让整段消失。
            // 占位的 `named` 同时承载「已投递段名」与「已发出去的默认名」，序号天然不撞。
            let name = section?.name
            if (name === undefined || name === '') {
                name = pickDefaultName(DEFAULT_NAMES.sections, named)
            } else {
                if (named.has(name)) continue
                named.add(name)
            }

            sections.push(name === section?.name ? section : { ...section, name })
        }
    }

    return sections.length === 0 ? undefined : sections
}

/**
 * 把一组工具集按装载顺序合并成一份工具名单（保序去重）。
 *
 * @param config - 插件配置。
 * @param toolSetIds - 已装工具集 id 列表。
 * @returns 工具名单；一个集都没装时返回 undefined（工具面不干预）。
 */
export function mergeToolNames(config: StudioConfig | undefined, toolSetIds: unknown): string[] | undefined {
    if (!Array.isArray(toolSetIds) || toolSetIds.length === 0) return undefined

    const names: string[] = []
    const seen = new Set<string>()

    for (const setId of toolSetIds) {
        const set = config?.toolSets?.find((candidate) => candidate.id === setId)
        if (set === undefined) continue

        for (const name of set.tools ?? []) {
            if (typeof name !== 'string' || seen.has(name)) continue
            seen.add(name)
            names.push(name)
        }
    }

    return names
}

/**
 * 把一组技能集按装载顺序合并成一份 skill 名单（保序去重）。
 *
 * @param config - 插件配置。
 * @param skillSetIds - 已装技能集 id 列表。
 * @returns skill 名单；一个集都没装时返回 undefined（技能面不干预）。
 */
export function mergeSkillNames(config: StudioConfig | undefined, skillSetIds: unknown): string[] | undefined {
    if (!Array.isArray(skillSetIds) || skillSetIds.length === 0) return undefined

    const names: string[] = []
    const seen = new Set<string>()

    for (const setId of skillSetIds) {
        const set = config?.skillSets?.find((candidate) => candidate.id === setId)
        if (set === undefined) continue

        for (const name of set.skills ?? []) {
            if (typeof name !== 'string' || seen.has(name)) continue
            seen.add(name)
            names.push(name)
        }
    }

    return names
}

/** 行的显示名：优先名字，没名字退回 id。 */
function labelOf(item: { name?: string; id?: string } | undefined): string {
    return item?.name !== undefined && item.name !== '' ? item.name : item?.id ?? '（无名）'
}

/**
 * 各类名称的默认值：新建时预填，空名在读取 / 写入 / 投递三处补齐。
 *
 * 给默认名的理由：没名字的项在界面上认不出、无名段还会在投递时被静默丢掉——
 * 补一个显眼的默认名，问题就从「消失」变成「可见、可改」。
 */
export const DEFAULT_NAMES = {
    agents: '未命名代理',
    promptSets: '未命名提示词集',
    toolSets: '未命名工具集',
    skillSets: '未命名技能集',
    sections: '未命名段',
}

/**
 * 取一个没被占用的默认名，并把它记进 `taken`（调用方不用再补记）。
 * @param base - 默认名。
 * @param taken - 已占用的名字集合；会被就地更新。
 * @returns 空闲的默认名；`base` 被占时带序号（`未命名段 2`、`未命名段 3`……）。
 */
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

/**
 * 给一个池里所有空名的项补默认名（不改原数组元素）。
 *
 * 非数组原样返回：写入端点的部分键（没发 skillSets 的老客户端）是 `undefined`，
 * 补成 `[]` 会在合并写里**清空**现有值——保持 `undefined` 才是「这一项不参与写入」。
 */
function fillNames<T extends { name?: string }>(items: T[] | undefined, base: string): T[] | undefined {
    if (!Array.isArray(items)) return items

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
 * 给一份配置里的空名补默认值（返回副本，不改入参）。
 *
 * 写入端点用它兜底（手改配置、老客户端），面板加载草稿时用同一套规则，
 * 于是「打开面板看到的名字」与「保存下去的名字」永远一致。
 *
 * @param config - 要规范化的配置（agents / promptSets / toolSets / skillSets）。
 * @returns 补过名的配置。
 */
export function applyDefaultNames(config: StudioConfig | undefined): StudioConfig | undefined {
    if (config === undefined || config === null) return config

    // 只在**本来就有这个键**时才写回：写入端点的部分键（没发 skillSets 的老客户端）
    // 补出一个 `undefined` 值的键，会让「没发的键不参与写入」这条在多处判断里失真。
    const next = { ...config }

    if (Array.isArray(next.agents)) next.agents = fillNames(next.agents, DEFAULT_NAMES.agents)
    if (Array.isArray(next.toolSets)) next.toolSets = fillNames(next.toolSets, DEFAULT_NAMES.toolSets)
    if (Array.isArray(next.skillSets)) next.skillSets = fillNames(next.skillSets, DEFAULT_NAMES.skillSets)

    if (Array.isArray(next.promptSets)) {
        next.promptSets = next.promptSets.map((set) => ({
            ...set,
            sections: fillNames(set?.sections, DEFAULT_NAMES.sections),
        }))
    }

    return next
}

/** 池内有没有重复 id；有就返回那个 id。 */
function findDuplicateId(items: { id?: string }[] | undefined): string | undefined {
    const seen = new Set<string | undefined>()

    for (const item of items ?? []) {
        if (seen.has(item?.id)) return item.id
        seen.add(item.id)
    }

    return undefined
}

/**
 * 装载重叠校验：任意两个已装集之间不许有重叠（同名段 / 同工具）。
 *
 * 这是设计定稿里的硬规则，写入端点与界面各校验一次：界面在「装载」那一刻即时拦，
 * 这里是保存时的防线（手改配置文件、老客户端都绕不过去）。
 *
 * @param config - 将要写入的完整配置。
 * @returns 第一处冲突的中文描述；没有冲突时 undefined。
 */
export function findLoadConflict(config: StudioConfig | undefined): string | undefined {
    const duplicateAgent = findDuplicateId(config?.agents)
    if (duplicateAgent !== undefined) return `代理 id 重复：「${duplicateAgent}」出现了两次。`

    const duplicatePromptSet = findDuplicateId(config?.promptSets)
    if (duplicatePromptSet !== undefined) return `提示词集 id 重复：「${duplicatePromptSet}」出现了两次。`

    const duplicateToolSet = findDuplicateId(config?.toolSets)
    if (duplicateToolSet !== undefined) return `工具集 id 重复：「${duplicateToolSet}」出现了两次。`

    const duplicateSkillSet = findDuplicateId(config?.skillSets)
    if (duplicateSkillSet !== undefined) return `技能集 id 重复：「${duplicateSkillSet}」出现了两次。`

    for (const agent of config?.agents ?? []) {
        const conflict = findAgentLoadConflict(config, agent)
        if (conflict !== undefined) return conflict
    }

    return undefined
}

/**
 * 每个提示词集都常驻的段（界面端由草稿层补齐，与 client 的 `PTC_REQUIRED_SECTIONS`
 * 同一套名字）：PTC 模式下它们是模型唯一的工具知识来源，界面上连勾选与移除都锁死。
 *
 * 这里只用来**豁免装载重叠校验**——它们在所有集里天然重复，不是人为撞车；真投递时
 * `mergeSections` 保序去重，不会投两遍。
 */
export const PTC_REQUIRED_SECTIONS = ['tools:sdk', 'tools:ptc-only']

/**
 * 每个工具集都常驻的工具（界面端由草稿层补齐，与 client 的 `REQUIRED_TOOLS` 同一套名字）。
 *
 * `skill` 是技能清单下发的开关：它在 agent 的工具面里不可见时，平台 `dsh-tool-skill`
 * 把这次快照当成「用不了」，整条技能目录都不注入；反过来，不在工具集里的工具会被
 * guard 排除 ⇒ 模型连调都调不动。所以每个工具集都带上它。
 *
 * 这里只用来**豁免装载重叠校验**——它在所有集里天然重复，不是人为撞车；真投递时
 * `mergeToolNames` 保序去重，不会投两遍。
 */
export const REQUIRED_TOOLS = ['skill']

/**
 * 校验一个代理装载的集之间是否重叠。
 */
function findAgentLoadConflict(config: StudioConfig | undefined, agent: AgentConfig): string | undefined {
    const sectionOwner = new Map<string, string>()
    for (const setId of agent.promptSets ?? []) {
        const set = config?.promptSets?.find((candidate) => candidate.id === setId)
        if (set === undefined) continue

        for (const section of set.sections ?? []) {
            if (section?.name === undefined) continue
            // 必备段在所有集里都有一份，天然「重叠」——不算撞车（见 PTC_REQUIRED_SECTIONS）。
            if (PTC_REQUIRED_SECTIONS.includes(section.name)) continue

            const owner = sectionOwner.get(section.name)
            if (owner !== undefined) {
                return `代理「${labelOf(agent)}」装载的提示词集「${owner}」与「${labelOf(set)}」都含段「${section.name}」——已装集之间不允许重叠。`
            }

            sectionOwner.set(section.name, labelOf(set))
        }
    }

    const toolOwner = new Map<string, string>()
    for (const setId of agent.toolSets ?? []) {
        const set = config?.toolSets?.find((candidate) => candidate.id === setId)
        if (set === undefined) continue

        for (const name of set.tools ?? []) {
            // 必备工具与必备段同理：每个集都有一份，天然「重叠」——不算撞车（见 REQUIRED_TOOLS）。
            if (REQUIRED_TOOLS.includes(name)) continue

            const owner = toolOwner.get(name)
            if (owner !== undefined) {
                return `代理「${labelOf(agent)}」装载的工具集「${owner}」与「${labelOf(set)}」都含工具「${name}」——已装集之间不允许重叠。`
            }

            toolOwner.set(name, labelOf(set))
        }
    }

    const skillOwner = new Map<string, string>()
    for (const setId of agent.skillSets ?? []) {
        const set = config?.skillSets?.find((candidate) => candidate.id === setId)
        if (set === undefined) continue

        for (const name of set.skills ?? []) {
            const owner = skillOwner.get(name)
            if (owner !== undefined) {
                return `代理「${labelOf(agent)}」装载的技能集「${owner}」与「${labelOf(set)}」都含技能「${name}」——已装集之间不允许重叠。`
            }

            skillOwner.set(name, labelOf(set))
        }
    }

    return undefined
}

/** 平台内置的插值变量（dsh-agent-loop 注册的 provider/model/cwd）。 */
export const BUILTIN_PROMPT_VARIABLES = ['provider', 'model', 'cwd']

/** 变量名的合法形状——与平台的 `VARIABLE_NAME` 同源（dsh-system-prompt）。 */
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/

/** 一次插值组：`{{名字}}`，名字里不含花括号（与平台的正则同源）。 */
const INTERPOLATION_GROUP = /^\{\{([^{}]*)\}\}/

/** 一段文本里第一个插值问题的形状。 */
interface InterpolationIssue {
    kind: 'malformed' | 'unknown'
    name: string
}

/**
 * 扫一段文本，找出第一个插值问题。
 *
 * 与平台 `interpolate()` 的扫描语义逐条对齐：
 *  - 孤立 `{{`（后面没有 `}}`）是**字面量**，不算问题；
 *  - `{{` 后面有 `}}` 但中间不是合法变量名 ⇒ `malformed`（平台必抛）；
 *  - 合法名字但不在已知清单里 ⇒ `unknown`（平台在渲染期抛 unknown prompt variable）。
 *
 * @param text - 段正文。
 * @param known - 已知变量名集合（含内置三变量）。
 * @returns `{ kind, name }`；扫完没问题时 undefined（malformed 的 name 是原文片段）。
 */
function findInterpolationIssue(text: string, known: Set<string>): InterpolationIssue | undefined {
    let last = 0

    for (;;) {
        const open = text.indexOf('{{', last)
        if (open < 0) return undefined

        const match = INTERPOLATION_GROUP.exec(text.slice(open))
        if (match === null) {
            if (text.indexOf('}}', open + 2) >= 0) {
                return { kind: 'malformed', name: text.slice(open, open + 16) }
            }

            last = open + 2
            continue
        }

        const name = match[1]
        if (!VARIABLE_NAME.test(name)) return { kind: 'malformed', name: `{{${name}}}` }
        if (!known.has(name)) return { kind: 'unknown', name }

        last = open + match[0].length
    }
}

/** `validatePromptVariables` 的结论。 */
export interface PromptVariableReport {
    error?: string
    unconfirmed?: string[]
}

/**
 * 校验全部提示词集里的插值变量名（写入端点的防线）。
 *
 * 为什么要拦：段文本里的 `{{名字}}` 由平台在**渲染期**插值，写了不合法或没注册的
 * 变量名会让那一次请求**直接抛错**——比「段里有个错别字」严重得多。所以：
 *
 *  - `malformed` **总是**拒绝（平台一定会抛）；
 *  - `unknown` 只在**已知变量清单可用时**拒绝；清单还空着（冷启动、没跑过任何会话）
 *    就放行，并把名字收进 `unconfirmed` 交给界面提示——避免把「插件注册的变量还没被
 *    观察到」误判成「不存在」。
 *
 * @param config - 将要写入的完整配置。
 * @param knownVariables - 平台已注册的变量名；undefined = 清单不可用。
 * @returns `{ error, unconfirmed }`——error 是第一条该拒绝的问题；unconfirmed 是未确认的变量名。
 */
export function validatePromptVariables(config: StudioConfig | undefined, knownVariables: unknown): PromptVariableReport {
    const rosterReady = Array.isArray(knownVariables)
    const known = new Set<string>([...BUILTIN_PROMPT_VARIABLES, ...(Array.isArray(knownVariables) ? knownVariables : [])])
    const unconfirmed = new Set<string>()

    for (const set of config?.promptSets ?? []) {
        for (const section of set?.sections ?? []) {
            if (typeof section?.text !== 'string' || section.text === '') continue

            const issue = findInterpolationIssue(section.text, known)
            if (issue === undefined) continue

            const name = section.name === undefined || section.name === '' ? '未命名' : section.name
            const where = `提示词集「${labelOf(set)}」的段「${name}」`

            if (issue.kind === 'malformed') {
                return { error: `${where} 里有个不合法的插值写法：${issue.name}——变量名只能是小写字母开头的小写字母、数字或下划线。` }
            }

            if (rosterReady) {
                return { error: `${where} 引用了平台没注册的变量 {{${issue.name}}}，渲染时会让这一次请求直接失败。当前可用变量：${[...known].sort().join('、')}。` }
            }

            unconfirmed.add(issue.name)
        }
    }

    return { unconfirmed: [...unconfirmed] }
}
