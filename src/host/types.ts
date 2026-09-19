/**
 * 项目内的共享类型：配置领域模型 + 用到的宿主上下文形状。
 *
 * 宿主（cordis / dsh-*）没有可用的类型声明（见 `types/dsh-host.d.ts` 的说明），
 * 这里只声明**本项目实际用到的成员**，够用即可、不追全量。服务接口带索引签名是
 * 刻意的：各文件可以在自己那边断言更细的形状，不必回头改这个文件（改它要串行）。
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
 * 插件配置。
 *
 * 字段全部可选：读取时 schema 的 `.default()` 会补值，但**写入端点的部分键**
 * （没发某个键的老客户端）确实可能是 undefined——「不发 = 这一项不参与写入」，
 * 所以类型必须如实反映。
 */
export interface StudioConfig {
    version?: number
    createdPresets?: string[]
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

/** 本插件设置命名空间的 scope（`settings.register` 的返回值）。 */
export interface SettingsScope {
    get(): StudioConfig
    update(patch: unknown): Promise<void>
    [key: string]: unknown
}

export interface SettingsService {
    register(namespace: string, schema: unknown, options?: { base?: unknown }): SettingsScope
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
