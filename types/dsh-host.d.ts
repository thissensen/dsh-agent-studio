/**
 * 宿主包（cordis / dsh-*）的自备类型声明。
 *
 * 为什么自备：这些包的 package.json 都写着 `types: lib/types/index.d.ts`，
 * 而本机产物里**那个目录并不存在**（与 client 侧的 `dsh-client-ui-primitives`
 * 是同一个套路——发布时漏了）。这里按项目里的**实际用法**声明够用的形状，
 * 不追全量；形状偏宽松是刻意的：宿主对象由平台在运行时注入，精确契约在平台源码里。
 */

declare module '@deepseek-ai/schemastery' {
    /** Schemastery 的 schema 对象：修饰方法链式返回自身。 */
    export interface Schema<T = unknown> {
        required(): Schema<T>
        default(value: unknown): Schema<T>
        description(text: string): Schema<T>
        /** 数值约束（`maxRetries` 这类计数字段用）。 */
        min(value: number): Schema<T>
        max(value: number): Schema<T>
        step(value: number): Schema<T>
    }

    export interface SchemasteryNamespace {
        object<T = unknown>(shape: Record<string, unknown>): Schema<T>
        string(): Schema<string>
        number(): Schema<number>
        boolean(): Schema<boolean>
        array<T = unknown>(item: unknown): Schema<T[]>
        union<T = unknown>(items: readonly unknown[]): Schema<T>
        const<T extends string>(value: T): Schema<T>
    }

    const z: SchemasteryNamespace
    export default z
}

declare module '@deepseek-ai/dsh-tools' {
    /** 工具的形参声明（与平台 defineTool 的 parameters 同形）。 */
    export interface ToolParameter {
        type: string
        required?: boolean
        description?: string
    }

    /** 工具被调用时拿到的执行上下文。 */
    export interface ToolExec {
        agent?: unknown
        /** 调用方的取消信号（长任务用）。 */
        signal?: unknown
        [key: string]: unknown
    }

    export interface ToolDefinition {
        name: string
        description: string
        parameters: Record<string, ToolParameter>
        output?: {
            schema?: Record<string, unknown>
            /**
             * 渲染工具结果。`result` 是 `execute` 的返回值，形状由各工具自己定
             * （本项目的派活工具返回的是结果对象，不是字符串）⇒ 这里不设限。
             */
            render?: (args: unknown, result: unknown) => unknown
        }
        /** 同并发安全相关：平台用它决定能否并行调用。 */
        isConcurrencySafe?: () => boolean
        execute: (args: unknown, exec: ToolExec) => unknown
    }

    export function defineTool(definition: ToolDefinition): ToolDefinition
}

declare module '@deepseek-ai/dsh-agent-presets' {
    /** 一份「已挂载的预设」。 */
    export interface PresetMount {
        presetId: string
        [key: string]: unknown
    }

    /** 某个 scope 上「常驻」的预设挂载（agentCtx → 它挂的预设）。 */
    export function standingMountFor(scope: unknown): PresetMount | undefined

    /** 当前所有活着的预设挂载。 */
    export function livePresetMounts(): PresetMount[]
}

declare module '@deepseek-ai/dsh-scope' {
    /** 取一个 context 的 scope key。 */
    export function scopeOf(ctx: unknown): string | undefined

    /** 取 scope key 的父级（standing 预设挂在 agent scope 的父级上）。 */
    export function scopeParentOf(scopeKey: string): string | undefined
}
