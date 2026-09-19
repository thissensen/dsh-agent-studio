/**
 * 装配期观察：记录每个 agent 实际拿到了什么。
 *
 * 这一层**只读**——它不改段、不改工具，只把观察到的事实留下来，为面板提供
 * 「当前生效面」。之所以先做它：
 *
 *  - 它是设计决策「未配置的预设如实回显平台当前实际投递的内容」的数据来源；
 *  - 它同时是「生效工具面预览」的来源——两个功能共用同一份观察结果；
 *  - 不改行为，所以可以独立上线并验证，出问题也不影响用户。
 *
 * 观察点有两个，对应模型实际看到的两样东西：
 *
 *  1. `system-prompt/assemble` —— 记下**平台全量的段清单**：handler 的第一个参数
 *     `assembly` 就是进瀑布前的那一份，本插件与其他插件的段改写都发生在它之后。
 *     取它而不是瀑布走完的 `result.sections`——改写后的清单只含真正投递的段，
 *     被本插件排除的段不在里面，面板就认不出「这条是平台预设、只是被我关掉了」。
 *     注意段已**求值**（`text` 函数已被 `assemble()` 调用过），且 `order` 字段已被丢弃，
 *     只剩数组顺序——这正是平台原顺序。
 *
 *  2. `ctx.tools.view(scope)` —— 该 agent 实际可见的工具集合。这是视图层，
 *     `tools:sdk` 的成员表也由它派生（见 docs/platform-capabilities.md §3）。
 *
 * 观察结果按会话 id 存在内存里，带上限，避免长会话把内存吃掉。
 *
 * @module dsh-agent-studio/observe
 */

import { rememberPresetObservation } from './cache.js'
import { resolvePresetId } from './preset.js'

import type { Ctx, Logger } from './types.js'

/** 最多保留多少个会话的观察结果。超出后丢弃最早记录的那个。 */
const MAX_TRACKED_SESSIONS = 50

/** 一段被观察到的段（只留面板用得到的字段）。 */
interface SectionFact {
    name?: string
    textLength: number | null
    text: string | null
}

/** 工具可见面（观察层只取这三个名字数组）。 */
interface ToolSurfaces {
    visible: string[]
    known?: string[]
    restrictable?: string[]
}

/** 一份完整的工具观察事实。 */
interface ToolFacts {
    visible: string[]
    known?: string[]
    restrictable?: string[]
    reachable?: string[]
    owners?: Record<string, string>
}

/** 平台技能摘要（dsh-skill 的 `toSummary` 产物，只取面板用到的字段）。 */
interface SkillSummary {
    name?: string
    description?: string
    source?: string
    whenToUse?: string
    resourceBase?: { kind?: string; path?: string }
}

/** 面板用的技能行（与 `/skills` 直读共用同一形状）。 */
interface SkillRow {
    name?: string
    description: string
    source: string
    whenToUse?: string
    resourceBase?: { kind: string; path?: string }
}

/** 单个会话的观察结果（面板读它显示「当前生效面」）。 */
interface Observation {
    sessionId?: string
    presetId?: string
    bornPreset?: string
    sections: SectionFact[]
    variables: Record<string, string | null>
    tools?: ToolFacts
    skills?: SkillRow[]
    observedAt: number
}

/** 装配期 handler 的 `context` 参数（只取本插件用到的字段）。 */
interface AssembleContext {
    agent?: {
        session?: {
            id?: string
            header?: { agentPreset?: string; parentSession?: string; cwd?: string }
        }
        ctx?: unknown
    }
    scope?: unknown
}

/** `system-prompt/assemble` 的 `assembly` 参数（进瀑布前的全量段清单）。 */
interface Assembly {
    sections?: Array<{ name?: string; text?: string }>
    variables?: Record<string, unknown>
}

/** 宿主 `tools` 服务（观察层只用 `view`）。 */
interface ToolsService {
    view(scope: unknown): {
        visible: Map<string, unknown>
        knownNames?: Iterable<string>
        restrictableNames?: Iterable<string>
    } | undefined
}

/** 宿主 `skills` 服务（观察层只用 `snapshot`）。 */
interface SkillsService {
    snapshot(options: { scope: unknown; cwd?: string }): Promise<{ skills?: SkillSummary[] }>
}

/** 每个会话的观察结果：段清单 + 工具清单 + 身份信息。 */
const observations = new Map<string, Observation>()

/**
 * 每个预设「本插件收窄之前」的那份可见面。
 *
 * 面板要判「勾了这个工具到底有没有用」只能靠它：工具的可见面是**所有层收窄的交集**，
 * 预设自己挂的工具守卫、平台层挂的限制都会把名字挡在外面，而本插件的收窄又混在同一份
 * 结果里分不开——唯一能拆开的机会是**本插件挂上收窄之前**（见 handler 里的注释）。
 * 采到之后按预设粘住：那次之后读到的都只是「本插件保留下来的那点」。
 */
const reachableByPreset = new Map<string, string[]>()

function remember(sessionId: string, snapshot: Observation): void {
    if (observations.has(sessionId)) observations.delete(sessionId)
    observations.set(sessionId, snapshot)

    while (observations.size > MAX_TRACKED_SESSIONS) {
        const oldest = observations.keys().next().value
        observations.delete(oldest as string)
    }
}

/**
 * 取一个会话最近的观察结果。面板读它来显示「当前生效面」。
 * @param sessionId - 会话 id。
 * @returns 观察结果，从未观察过时为 undefined。
 */
export function observeFor(sessionId: string): Observation | undefined {
    return observations.get(sessionId)
}

/** 列出所有已观察到的会话，供面板列出「有哪些 agent 正在跑」。 */
export function observedSessions(): Observation[] {
    return [...observations.values()]
}

/**
 * 读某 agent 的工具视图：可见的、已知的、可收窄的。
 *
 * 面板要回答「这个工具来自哪一层」「为什么放不进来」，判据只能是这三个集合本身
 * （`dsh-tools` 的 `view()` 返回值）：
 *
 *   - 在 `restrictableNames` 里 = **继承来的**。预设层、宿主层、profile bundle 都落在
 *     这一档——平台不再往下细分到 row，所以界面也别假装分得出来；
 *   - 在 `knownNames` 里却不在 `visible` 里 = 已知但这个 agent 拿不到，即「放不进来」；
 *   - 在 `visible` 里却不在 `restrictableNames` 里 = 该 agent **本层注册**的
 *     （子代理的机制工具就是这样），本插件的 `restrict()` 收不动它。
 *
 * @param ctx - 插件所在的 context。
 * @param scope - 要观察的 scope（即 `context.scope`，不是 agent 对象）。
 * @returns `{ visible, known, restrictable }` 三个名字数组；视图读不到时返回 undefined。
 */
function readToolSurfaces(ctx: Ctx, scope: unknown): ToolSurfaces | undefined {
    try {
        const tools = ctx.get?.('tools') as ToolsService | undefined
        if (tools?.view === undefined) return undefined

        // 参数必须是 scope：`view(scope)` 会把它喂给 `chainLayers` / `peek`
        // （dsh-tools 第 2854 行）。传 agent 对象会取不到层级。
        const view = tools.view(scope)
        if (view?.visible === undefined) return undefined

        return {
            // `visible` 是 Map（名字 → 定义），要取名字必须走 keys()。
            visible: [...view.visible.keys()].sort(),
            known: view.knownNames === undefined ? undefined : [...view.knownNames].sort(),
            restrictable: view.restrictableNames === undefined ? undefined : [...view.restrictableNames].sort(),
        }

    } catch {
        // 视图不可读是可接受的状态（注册表未就绪、或该 scope 尚无层级）。
        // 观察失败绝不能影响请求本身。
        return undefined
    }
}

/**
 * 技能摘要 → 面板候选行。这是**唯一**的形状定义：装配期观察与 `/skills` 直读
 * （`api.js`）共用它，两条路给面板的行永远长得一样。
 *
 * `resourceBase` 只收面板要用的两位（目录类技能给目录路径，面板按它分组）；
 * 其余形态（`url` / `opaque`、或平台压根没给的 runtime 技能）只留 `kind`——
 * 面板把它们归进「（无目录信息）」，不编造目录。
 *
 * @param skill - 平台技能摘要（`dsh-skill` 的 `toSummary` 产出）。
 * @returns `{ name, description, source, whenToUse, resourceBase }`。
 */
export function skillRowOf(skill: SkillSummary | undefined): SkillRow {
    const base = skill?.resourceBase

    return {
        name: skill?.name,
        description: typeof skill?.description === 'string' ? skill.description : '',
        source: typeof skill?.source === 'string' ? skill.source : '',
        whenToUse: typeof skill?.whenToUse === 'string' ? skill.whenToUse : undefined,
        resourceBase: resourceBaseOf(base),
    }
}

/**
 * 「资源基座」摘成面板要用的两位。
 * @param base - 平台技能摘要的 `resourceBase`（`directory` / `url` / `opaque` 三态联合）。
 * @returns `{ kind, path? }`；平台没给（runtime 技能）时 undefined。
 */
function resourceBaseOf(base: { kind?: string; path?: string } | undefined): { kind: string; path?: string } | undefined {
    if (typeof base?.kind !== 'string') return undefined
    if (base.kind !== 'directory' || typeof base.path !== 'string') return { kind: base.kind }

    return { kind: 'directory', path: base.path }
}

/**
 * 读某 agent 看到的 skill 清单（面板「技能集」的候选来源）。
 *
 * 用 `snapshot` 而不是 `list`：两者给的都是「就近层赢」的合并结果，但 `snapshot`
 * 额外告诉我们发现是否完整——清单不完整时面板可以等下一次装配自愈。
 * `scope` 传 agent 对象（与平台自己的技能目录同源），于是采到的是**这个 agent**
 * 视角的清单（含本插件注册的隐藏覆盖，名字与来源不受影响）。
 *
 * @param ctx - 插件所在的 context。
 * @param context - 本次装配的 context（`agent` 是 viewing scope）。
 * @returns `[{ name, description, source, whenToUse, resourceBase }]`；读不到时返回 undefined。
 */
async function readSkillCatalog(ctx: Ctx, context: unknown): Promise<SkillRow[] | undefined> {
    try {
        const skills = ctx.get?.('skills') as SkillsService | undefined
        if (skills?.snapshot === undefined) return undefined

        const agent = (context as { agent?: { session?: { header?: { cwd?: string } } } } | undefined)?.agent
        const snapshot = await skills.snapshot({
            scope: agent,
            cwd: agent?.session?.header?.cwd,
        })

        // 只留面板要用的字段：正文不进观察（可能很大，面板也不展示）。
        return (snapshot?.skills ?? []).map((skill) => skillRowOf(skill))

    } catch {
        // 清单读不到是可接受的状态（技能服务缺席、发现失败）。观察失败绝不能影响请求。
        return undefined
    }
}

/**
 * 每个工具名的来源，交给面板分组用（`lib/attribution.js` 供 `ownerOf`）。
 * 归因拿不到的名字**不进表**——界面把它们并进「其他来源」，不编造出处。
 *
 * @param names - 要归因的工具名。
 * @param ownerOf - 归因查询；没挂归因层时是 undefined，整表就不产出。
 * @returns 名字 → 来源；没挂归因时 undefined。
 */
function ownersFor(names: string[], ownerOf?: (name: string) => string | undefined): Record<string, string> | undefined {
    if (typeof ownerOf !== 'function') return undefined

    const owners: Record<string, string> = {}
    for (const name of names) {
        const owner = ownerOf(name)
        if (owner !== undefined) owners[name] = owner
    }

    return owners
}

/**
 * 挂上观察点。
 * @param ctx - 插件所在的 context。
 * @param logger - 用于报错的 logger。
 * @param deps - `{ ownerOf }`：工具来源查询（可选，缺了就不产出来源表）。
 */
export function mountObservation(ctx: Ctx, logger: Logger, deps: { ownerOf?: (name: string) => string | undefined } = {}): void {
    const ownerOf = deps.ownerOf

    ctx.on('system-prompt/assemble', async (assemblyArg: unknown, contextArg: unknown, nextArg: unknown) => {
        const next = nextArg as () => Promise<unknown>
        const context = contextArg as AssembleContext | undefined
        const assembly = assemblyArg as Assembly | undefined

        // 收窄**之前**先读一次视图：这一份里被排除的只有**别人**的收窄（预设自带的工具守卫、
        // 平台层），因为本插件的 `restrict()` 是接下来的瀑布里才挂上的。只认第一次——之后再读，
        // 本插件自己的收窄已经生效，就分不清是「谁」挡的了。
        const session = context?.agent?.session
        const sessionId = session?.id
        const isFirstSight = sessionId !== undefined && !observations.has(sessionId)
        const reachable = isFirstSight ? readToolSurfaces(ctx, context?.scope)?.visible : undefined

        const result = await next()

        // 段的权威快照取**进瀑布前**那份（见模块头注释）：只有它含被本插件排除的段。
        const sections = assembly?.sections
        if (!Array.isArray(sections) || sessionId === undefined) return result

        const surfaces = readToolSurfaces(ctx, context?.scope)
        const skills = await readSkillCatalog(ctx, context)
        // 当前预设必须走 resolvePresetId；出生预设只留作对照——两者实测会不一致
        // （见 docs/platform-capabilities.md §5.1），而预设自己打的日志更不可信：
        // 实验台是从别的预设复制来的，它的 guard 里硬编码着原来的预设名。
        const presetId = resolvePresetId(ctx, context?.agent?.ctx)

        if (presetId !== undefined && reachable !== undefined) reachableByPreset.set(presetId, reachable)

        // 上面那份「收窄之前的可见面」要**粘住**：拿不到新的就用该预设上次采到的
        // （进程重启后第一次装配会重采，所以这份记忆自己会接上）。
        const reachableNames = presetId === undefined ? reachable : reachableByPreset.get(presetId)

        // 数组顺序即平台原顺序——按观察到的顺序记，不做任何排序。
        // 正文一起留下（`text`）：面板的「平台预设预览」靠它。段正文是平台当次求值的
        // 的结果（`text` 函数已调用过），最大的段（tools:sdk）也就 2 万字符量级。
        const sectionFacts: SectionFact[] = (sections).map((s) => ({
            name: s?.name,
            textLength: typeof s?.text === 'string' ? s.text.length : null,
            text: typeof s?.text === 'string' ? s.text : null,
        }))

        // 插值变量：`assembly.variables` 在进瀑布前就求值完毕（内置 provider/model/cwd +
        // 各插件注册的），键就是段里能写的 `{{名字}}`。面板据此列「可用变量」，
        // 写入端点据此拦「未知变量」（写了平台没注册的变量，渲染时会让整个请求抛错）。
        const variables: Record<string, string | null> = {}
        for (const [name, value] of Object.entries(assembly?.variables ?? {})) {
            variables[name] = typeof value === 'string' ? value : null
        }

        let toolFacts: ToolFacts | undefined
        if (surfaces !== undefined) {
            const allNames: string[] = [...new Set([
                ...(surfaces.visible ?? []),
                ...(surfaces.known ?? []),
                ...(surfaces.restrictable ?? []),
                ...(reachableNames ?? []),
            ])]

            toolFacts = {
                ...surfaces,
                reachable: reachableNames,
                owners: ownersFor(allNames, ownerOf),
            }
        }

        remember(sessionId, {
            sessionId,
            presetId,
            bornPreset: session?.header?.agentPreset,
            sections: sectionFacts,
            variables,
            tools: toolFacts,
            skills,
            observedAt: Date.now(),
        })

        // 另按预设落一份到盘上：进程重启后还没对过话时，面板就靠它列工具候选与段预览。
        // 装配期是热路径，所以这一步只在内容真的变化时落盘（见 `cache.js`）。
        rememberPresetObservation(presetId as string, { sections: sectionFacts, variables, tools: toolFacts, skills }, logger)

        // 只在该会话首次被观察时打，避免每个请求都刷屏。
        if (isFirstSight) {
            logger.info?.(
                `[agent-studio] 首次观察到会话 ${sessionId.slice(0, 18)}… · 预设 ${presetId ?? '解析不出'} · 段 ${sections.length} · 工具 ${surfaces?.visible?.length ?? '?'}`,
            )

            // 清单也打出来。它同时是验证生效层（段过滤 / 工具收窄）真的改动了投递的直接证据，
            // 也是日志侧复现面板显示内容的唯一途径。
            // 第三行是「**别人**放行的那一份」（本插件收窄之前），他报「放行了却没有」时就靠它定案：
            // 名单里的名字不在这一份里 ⇒ 被预设自己的守卫或平台层挡掉了，本插件放行不了。
            logger.info?.(`[agent-studio] 平台段清单 · ${sections.map((s) => s?.name).join(' · ')}`)
            logger.info?.(`[agent-studio] 工具清单 · ${surfaces?.visible?.join(' · ') ?? '（视图读不到）'}`)
            logger.info?.(`[agent-studio] 上层已放行 · ${reachableNames?.join(' · ') ?? '（读不到）'}`)
        }

        return result
    })

    logger.info?.('[agent-studio] 装配期观察已挂上')
}
