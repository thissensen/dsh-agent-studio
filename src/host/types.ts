/**
 * 项目内的共享类型：配置领域模型 + 用到的宿主上下文形状。
 *
 * 宿主（cordis / dsh-*）的类型声明从 0.1.7 起随包发布，但本项目**不直接 import 它们的
 * 类型**（那会把插件与平台包的类型入口绑死，而两边的解析路径在 link 装法下未必一致）。
 * 这里只声明**本项目实际用到的成员**，够用即可、不追全量；写之前一律去
 * `<DSH 安装目录>/node_modules/@deepseek-ai/` 的源码注册处核对（规范第 60 条）。
 *
 * @module dsh-agent-studio/host-types
 */

// ── 配置领域模型（settings 命名空间 `agent-studio` 的形态）─────────────────────

/** 子代理的后台模式：映射到派活语义。仅被当子代理时生效。 */
export type BackgroundMode = 'always-background' | 'foreground' | 'model-decides'

/**
 * Agent 模式（Agent 级三档，2026-09-18 用户拍板；界面文案从「工具调用方式」改为「Agent 模式」）：
 * `follow` = 跟随预设（插件不声明）；`native` = 本 agent 一律不用 PTC；
 * `ptc` = 一律用 PTC（即使预设不是）。
 *
 * 机制：`agent.ctx.tools.presentAs(mode)`——就近 scope 覆盖预设层的声明
 * （声明在不同层，不冲突；同一 scope 只能声明一次，重复挂会抛错，见 apply.ts 的幂等）。
 */
export type ToolPresentation = 'follow' | 'native' | 'ptc'

/** 段配置：`name` 对应平台的 section 名；带 `text` 的是自定义段。 */
export interface SectionConfig {
    name?: string
    enabled?: boolean
    text?: string
}

/** 模型路由：provider 与 model 成对给；缺省 = 继承会话。 */
export interface ModelConfig {
    provider?: string
    model?: string
    reasoningEffort?: string
}

/** 一个代理。 */
export interface AgentConfig {
    id?: string
    name?: string
    note?: string
    model?: ModelConfig
    /** 每个候选各自的重试上限（自动降级用；默认 5，与平台默认对齐）。 */
    maxRetries?: number
    /** 备用候选（有序）：主选失败后依次顶上。空 = 自动降级不接管。 */
    fallbacks?: ModelConfig[]
    background?: BackgroundMode
    /** Agent 模式：`follow`（默认）不干预；`native`/`ptc` 对本 agent 强制。 */
    toolPresentation?: ToolPresentation
    promptSets?: string[]
    toolSets?: string[]
    skillSets?: string[]
    children?: string[]
}

/** 提示词集。 */
export interface PromptSetConfig {
    id?: string
    name?: string
    note?: string
    sections?: SectionConfig[]
}

/** 工具集。 */
export interface ToolSetConfig {
    id?: string
    name?: string
    note?: string
    tools?: string[]
}

/** 技能集：勾选的 skill 名单。 */
export interface SkillSetConfig {
    id?: string
    name?: string
    note?: string
    skills?: string[]
}

/** 预设 → 主代理的绑定。 */
export interface PresetBinding {
    presetId?: string
    agentId?: string
}

export interface BindingsConfig {
    presets?: PresetBinding[]
}

/**
 * 一条构成声明里的 row（预设的 `plugins` 元素）。
 *
 * **这是平台的 `EntryOptions`**（`cordis-plugin-loader`），本插件只声明用到的几个键。
 * `disabled` 可能是布尔（写死的开关），也可能是**表达式节点** `{ __jsExpr: 源码 }`
 * ——形状就是 `!!js` 标量在 YAML 里的写法，`isJsExpr()` 靠 `'__jsExpr' in value` 认它。
 */
export interface PresetPluginRow {
    id?: string
    name?: string
    config?: unknown
    disabled?: boolean | { __jsExpr: string }
    group?: boolean
    isolate?: unknown
    [key: string]: unknown
}

/**
 * 本插件建出来的预设。
 *
 * 0.1.7 起平台把预设从「目录里的文件」改成「插件声明」（`agentPresets.register(definition)`），
 * 而**注册是运行时的、不落盘**——同一个插件在下次启动时只是又一次被装配，注册全都消失。
 * 所以本插件把定义存进**自己的配置**（平台负责落盘），启动时照着重新注册；
 * 「可删」的判据就是「定义在这份清单里」（注销器只在本进程活着，重启后由这份清单补出）。
 *
 * **存的是 YAML 文本，不是解析好的对象**（2026-09-24 真机实测）：平台的
 * `settings` 写入通道在重建 volatile 配置时会把 `!!js` 表达式**求值成普通值**
 * （磁盘上留下 `disabled: true`），于是「按平台 / 环境开合」的语义会在新建那一刻被固化。
 * 文本是惰性的、不会被求值，读出来再解析即可原样还原表达式节点——这份文本用的就是平台
 * 自己的 entry-list 方言（`!!js` 标量），与 `readDocument()` 给的形态同源。
 */
export interface PresetDefinitionConfig {
    id?: string
    name?: string
    description?: string
    /** 构成声明（entry-list YAML 文本；`plugins` 数组那一份）。 */
    presetYaml?: string
}

/**
 * 插件配置。
 *
 * 字段全部可选：读取时 schema 的 `.default()` 会补值，但**写入端点的部分键**
 * （没发某个键的老客户端）确实可能是 undefined——「不发 = 这一项不参与写入」，
 * 所以类型必须如实反映。
 */
export interface StudioConfig {
    version?: number
    /**
     * 本插件建出来的预设（定义原文；启动时照它重新注册，见 `PresetDefinitionConfig`）。
     *
     * 类型是定义对象——但**旧盘上的数据可能是字符串 id**（那时预设是平台目录里的文件，
     * 这里只记来源标记）。schema 认那种形态只为「旧配置不至于让整条 row 失效」，读出时由
     * `readConfig()` 归一成 `{ id }`；它没有构成声明、因而注册不了（见 `PresetDefinitionSchema`）。
     */
    createdPresets?: PresetDefinitionConfig[]
    agents?: AgentConfig[]
    promptSets?: PromptSetConfig[]
    toolSets?: ToolSetConfig[]
    skillSets?: SkillSetConfig[]
    runtimeContextOff?: string[]
    bindings?: BindingsConfig
}

// ── 宿主 ────────────────────────────────────────────────────────────────────

/** 宿主 logger（cordis logger 的子集；各项都可能是可选方法）。 */
export interface Logger {
    info?(...args: unknown[]): void
    warn?(...args: unknown[]): void
    error?(...args: unknown[]): void
    debug?(...args: unknown[]): void
}

/**
 * 本插件自造的配置作用域（`index.ts` 里构造）。
 *
 * 读的那一半解包平台交进来的 config；写的那一半把 patch 交回平台的 `settings` 服务。
 * 三层（生效 / 派活 / 降级）与 HTTP 端点只认这个接口，跟平台实现的换法解耦。
 */
export interface SettingsScope {
    get(): StudioConfig
    update(patch: unknown): Promise<void>
}

/**
 * 平台的 `settings` 服务（实现是 `SettingsForms`）。只声明本项目用到的成员。
 *
 * `ns` 是 profile entry id（就是 `SETTINGS_NAMESPACE`）。合并语义：对象递归、
 * **数组整体替换**、`undefined` 跳过 ⇒ 可增删的集合一律用数组（见 `config.ts`）。
 */
export interface SettingsService {
    update(ns: string, patch: object, expectedRevision?: number): Promise<void>
    [key: string]: unknown
}

/**
 * 插件所在的 context。
 *
 * `[key: string]: unknown` 让各文件能就地断言自己用到的宿主细节（比如 `tools`
 * 的方法形状），不把整个宿主契约摊到这个文件里。
 */
export interface Ctx {
    logger?: Logger
    get?<T = unknown>(name: string): T
    /**
     * 注册事件监听。`options.prepend` 把监听器排到链首——瀑布事件里谁在前谁先拿决策权，
     * 自动降级要靠它抢在内置重试（`dsh-llm-retry`）之前。
     */
    on(event: string, handler: (...args: unknown[]) => void, options?: { prepend?: boolean }): void
    inject(names: string[], callback: (ctx: Ctx) => void): void
    settings?: SettingsService
    tools?: unknown
    webServer?: unknown
    webRuntime?: unknown
    subagents?: unknown
    fiber?: unknown
    [key: string]: unknown
}
