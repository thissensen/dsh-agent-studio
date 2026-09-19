/**
 * 工具来源归因：某个工具名是哪个插件注册的。
 *
 * **为什么要它。** 面板把几十个工具铺成一张清单，用户找工具只能一行行扫。平台给出的
 * `view()` 只有名字与可见性，**注册者不在工具定义里**（会话日志里也只记名字、描述、
 * 参数），所以归属只能在注册发生的那一刻亲手记下来。
 *
 * **怎么记。** 与 dsh-context 的 attribution 是同一套机制，这里是它的精简版：
 *
 *  1. cordis 每次读服务属性都会触发 `internal/get` 瀑布，并把**读它的那个 context**
 *     作为第一个参数传进来。插件注册工具前必然先读 `tools` 服务，于是「谁读的」≈
 *     「谁注册的」——把这一刻的 reader 记下来；
 *  2. 顺手把该实例的 `register` 包一层，注册发生时把上一步记下的 reader 名连同工具名
 *     存进一张表。
 *
 * 两条都是 best-effort：读取与注册之间隔了一个 await 时，记录可能被别的读取顶掉
 * （dsh-context 的注释里同样承认这一点）。归因错一两个不影响用途——面板拿它分组，
 * 归不到的名字落到「其他来源」，不会凭空编出处。
 *
 * `FIRST_PARTY_SOURCES` 兜的是**本插件挂上之前**就注册完的官方工具：那一刻没有观察者，
 * 只能按名字认。表抄自 dsh-context 的同名表（Apache-2.0），值写成包名的短形式
 * （去掉 `@deepseek-ai/` 前缀），与 live 记录里的插件名长短一致、界面好读。
 *
 * @module dsh-agent-studio/attribution
 */

import type { Ctx, Logger } from './types.js'

/** 本插件自己注册的工具——注册者不言自明，不必等 live 记录。 */
const SELF_TOOL_NAMES = new Set(['studio_list_subagents', 'studio_delegate'])

/** 本插件的归因名（也是包名）。 */
const SELF_OWNER = 'dsh-agent-studio'

/** 官方工具 → 提供它的包（短名）。 */
const FIRST_PARTY_SOURCES: Record<string, string> = Object.freeze({
    read: 'dsh-tool-fs',
    write: 'dsh-tool-fs',
    edit: 'dsh-tool-fs',
    read_image: 'dsh-tool-fs',
    glob: 'dsh-tool-fs-search',
    grep: 'dsh-tool-fs-search',
    str_replace_editor: 'dsh-tool-str-replace-editor',
    bash: 'dsh-tool-bash',
    pwsh: 'dsh-tool-pwsh',
    web_search: 'dsh-tool-web',
    web_fetch: 'dsh-tool-web',
    job_output: 'dsh-tool-jobs',
    job_list: 'dsh-tool-jobs',
    job_kill: 'dsh-tool-jobs',
    ask_user_question: 'dsh-tool-ask-user',
    plan: 'dsh-plan-mode',
    exit_plan_mode: 'dsh-plan-mode',
    skill: 'dsh-tool-skill',
    todo_write: 'dsh-tool-todo',
    subagent: 'dsh-tool-subagent',
    subagent_fork: 'dsh-tool-subagent',
    send_message: 'dsh-tool-subagent-control',
    interrupt_agent: 'dsh-tool-subagent-control',
    list_agents: 'dsh-tool-subagent-control',
    ralph: 'dsh-tool-ralph',
    workflow: 'dsh-tool-workflow',
    run_code: 'dsh-tools',
    schedule_create: 'dsh-schedule',
    schedule_list: 'dsh-schedule',
    schedule_delete: 'dsh-schedule',
    create_goal: 'dsh-tool-goal',
    get_goal: 'dsh-tool-goal',
    update_goal: 'dsh-tool-goal',
    lsp: 'dsh-tool-lsp',
})

/**
 * MCP 代理工具的来源：`dsh-mcp-client` 把工具命名成 `mcp__<server>__<原名>`，
 * 分隔的 `__` 是**最后**一个（server 名自己可能带下划线）。
 *
 * @param name - 工具名。
 * @returns `mcp:<server>`；不是 MCP 工具时为 undefined。
 */
function mcpSourceOf(name: string): string | undefined {
    if (name.startsWith('mcp__') !== true) return undefined

    const cut = name.lastIndexOf('__')
    if (cut < 5) return undefined

    const server = name.slice(5, cut)
    return server === '' ? undefined : `mcp:${server}`
}

/** 宿主 `tools` 服务的最小形状（归因只用到 `register`）。 */
interface ToolsService {
    register: AttributableRegister
}

/** `tools.register` 的形状，带一层 `attributedOriginal` 标记（本插件与 dsh-context 都往它上挂）。 */
interface AttributableRegister {
    (definition: unknown): unknown
    attributedOriginal?: AttributableRegister
}

/** 宿主 context 上一处会读到的运行时形状（attribution 只读 `fiber.name`）。 */
interface FiberHolder {
    fiber?: { name?: string }
}

/**
 * 挂上归因钩子。
 *
 * 注册的钩子随插件 ctx 的生命周期走；`register` 的包装不主动卸除——
 * 本插件在进程内常驻，重载走的是宿主重启，没有需要还原的场景。
 *
 * @param ctx - 插件所在的 context。
 * @param logger - 用于报告的 logger。
 * @returns `{ ownerOf }`：查一个工具名的来源，查不到时 undefined。
 */
export function mountAttribution(ctx: Ctx, logger: Logger): { ownerOf(name: string): string | undefined } {
    /** 注册时刻记下的工具名 → 注册者名字。 */
    const live = new Map<string, string>()
    /** 包装过的实例（幂等，别越包越深）。 */
    const wrappedInstances = new WeakSet<object>()
    /** 最后一次读 `tools` 服务的 context——下一次注册的归属就是它。 */
    let lastReader: unknown

    /** 本插件自己的 fiber 名：被它读出来的不算别人的注册。 */
    const selfName = (ctx.fiber as FiberHolder | undefined)?.fiber?.name

    /**
     * 读当前归属：reader 缺失、是 root、或就是本插件自己时给 undefined，
     * 交给静态兜底表——宁可不标，也不能把归属安错人。
     */
    const readerName = (): string | undefined => {
        const name = (lastReader as FiberHolder | undefined)?.fiber?.name
        if (typeof name !== 'string' || name === '' || name === 'root' || name === selfName) return undefined

        return name
    }

    /** 把实例的 `register` 包一层，把注册时刻的 reader 记进 live 表。 */
    const wrapInstance = (tools: unknown): void => {
        if (tools === null || typeof tools !== 'object' || wrappedInstances.has(tools)) return

        const svc = tools as ToolsService
        const register = svc.register
        if (typeof register !== 'function') return
        wrappedInstances.add(tools)

        // 已被别人（dsh-context 也这么包）包过时剥到最初的那个：两层都认
        // `attributedOriginal` 这个标记，叠着包不会越包越深。
        const original = (register as AttributableRegister).attributedOriginal ?? (register as AttributableRegister)
        if (typeof original !== 'function') return

        const wrappedRegister: AttributableRegister = function (this: unknown, definition: unknown): unknown {
            const owner = readerName()
            const def = definition as { name?: string }
            if (owner !== undefined && typeof def?.name === 'string') live.set(def.name, owner)

            return (original as AttributableRegister).call(this, definition)
        }
        wrappedRegister.attributedOriginal = original
        svc.register = wrappedRegister
    }

    ctx.on('internal/get', (reader: unknown, name: unknown, _error: unknown, next: unknown) => {
        const callNext = next as () => unknown
        if (name !== 'tools') return callNext()

        const tools = callNext()
        lastReader = reader
        wrapInstance(tools)

        return tools
    })

    // 挂载时实例可能已经被读过（比如本插件的观察层）：先包一次，抓之后的注册。
    wrapInstance(ctx.get?.('tools'))

    logger.info?.('[agent-studio] 工具来源归因已挂上')

    return {
        ownerOf(name: string): string | undefined {
            const mcp = mcpSourceOf(name)
            if (mcp !== undefined) return mcp
            if (SELF_TOOL_NAMES.has(name)) return SELF_OWNER

            return live.get(name) ?? FIRST_PARTY_SOURCES[name]
        },
    }
}
