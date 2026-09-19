
/**
 * 装配期生效逻辑：按插件配置改写模型实际看到的段与工具面。
 *
 * v2 的两条通道仍各自分头走，但「谁在哪一层生效」按代理类型切开了：
 *
 *  1. **段** —— 主代理与子代理都在 `system-prompt/assemble` 瀑布里重建 `result.sections`。
 *     投递顺序就是**数组顺序**（`order` 字段在 `assemble()` 构造投递对象时已被
 *     丢弃，改写它完全无效——已由源码与真机双重确认）。
 *
 *  2. **工具** —— 主代理在装配期挂 `restrict()`；**子代理改在「创建窗口」挂**
 *     （`agent/created` 事件，见 `handleChildCreated`）。原因：`assembly.tools` 在瀑布
 *     **之前**就按未收窄的工具面求值完毕，装配期挂的收窄管不到当次；而 `agent/created`
 *     必然早于子代理的第一次装配（创建 → 挂 composition → 提交首个 prompt），在那里挂，
 *     第一次装配就是收窄后的面，零竞态。子代理因此**不再**走装配期收窄，避免双 restrict
 *     交集打架。
 *     **呈现模式**（三档开关的 `presentAs`）比 `restrict` 更吃时机：它影响 `wireSchemas`
 *     与 SDK 段正文，两者在 `assemble()` 前半段求值 ⇒ 挂点只有「创建窗口」与「预设切换
 *     补救」（`tools/change`，见 `reconcileMainPresentations`）；装配期那次只是保状态，
 *     对当次无效——这就是「切预设后第一条仍是原生」的成因与修复。
 *
 * 不干预原则（规格 3.4）：**未**绑定代理、或代理查不到，就原样透传，一行都不改。
 * **绑定即接管**（用户拍板：2026-09-17 定于段面，2026-09-18 统一到三面）：绑定之后，
 * 段面、工具面、技能面**全部**由该代理装载的集决定——**一个集都没装就是空集**：
 * 投递空提示词、一个工具都不给、一个 skill 都不暴露。三面同一套语义，没有中间态。
 *
 * 工具面的收窄要三招并用，因为平台的 `restrict()` 按设计只收**继承面**（全局 + 祖先层，
 * 见 dsh-tools 的 `view()`），收不动注册在 **agent 本层** 的工具
 * （`subagent`/`list_subagent_models` 就是这样装上去的）：
 *
 *   - 视图层：`restrict({deny/allow})` —— 收继承面；
 *   - 投递层：`restrictToolSchemas()` —— 直接裁本次装配的工具声明，对所有层有效；
 *   - 执行层：`guard()` —— 拦「晚注册逃逸」与本层工具的实际调用。
 *
 * 三招判据同源：**不在工具集并集里的，除机制工具外一律收**。
 *
 * @module dsh-agent-studio/apply
 */

import { appendFileSync } from 'node:fs'

import { agentById, boundAgentId, mergeSections, mergeSkillNames, mergeToolNames } from './config.js'
import { agentOfChildSession, claimChildAgent } from './delegate.js'
import { describePresetResolution, resolvePresetId } from './preset.js'
import { stripSdkEntries } from './sdk-strip.js'
import type { Ctx, Logger, SettingsScope, StudioConfig, SectionConfig, ToolPresentation } from './types.js'

// ── 本文件私有的宿主形状（宿主注入，精确契约见平台源码；够用即可）─────────────

/** 工具服务：restrict / guard / view / presentAs / sdkSection 用到的成员。 */
interface ToolService {
    view(scope: unknown): { visible?: Map<string, unknown>; restrictableNames?: Set<string>; [key: string]: unknown }
    restrict(rule: { allow?: string[]; deny?: string[] }): () => void
    guard(fn: (exec: ToolExecLike) => string | undefined): () => void
    /** 声明本 scope 的呈现模式（三档开关用，须在 scoped ctx 上调用）；返回恢复默认的精确 disposer。 */
    presentAs?(mode: 'native' | 'ptc'): () => void
    sdkSection?(): { text?(context: unknown): string | undefined }
    [key: string]: unknown
}

/** guard 拿到的执行上下文（只用到 `name`）。 */
interface ToolExecLike {
    name?: unknown
    [key: string]: unknown
}

/** agent 的 context（scope key 即 agent 本身）。 */
interface AgentScope {
    tools?: ToolService
    get?(name: string): unknown
    [key: string]: unknown
}

/** 一个 agent（宿主对象；用到的成员才声明）。 */
interface Agent {
    id?: string
    ctx?: AgentScope
    session?: { id?: string; header?: { parentSession?: string; cwd?: string }; [key: string]: unknown }
    [key: string]: unknown
}

/** 技能服务。 */
interface SkillService {
    snapshot?(opts: { scope?: unknown; cwd?: string }): Promise<SkillCatalog>
    get?(name: string, opts: { scope?: unknown; cwd?: string }): Promise<SkillDef | undefined>
    register?(def: SkillDef): () => void
    [key: string]: unknown
}

/** 技能清单快照。 */
interface SkillCatalog {
    skills?: SkillDef[]
    [key: string]: unknown
}

/** 单个技能的定义。 */
interface SkillDef {
    name?: string
    invocation?: { modelInvocable?: boolean; [key: string]: unknown }
    [key: string]: unknown
}

/** 装配期产物里的单条工具声明。 */
interface ToolSchema {
    name?: string
    [key: string]: unknown
}

/** 装配期产物里的一段。 */
interface Section {
    name?: string
    text?: string
    enabled?: boolean
    [key: string]: unknown
}

/** 装配期 `system-prompt/assemble` 的产物（段、动态快照与工具声明）。 */
interface AssembleResult {
    tools?: ToolSchema[]
    sections?: Section[]
    /** 动态运行时快照的命名分片；清空即「本次不投递快照」（见 `rewrite` 末尾）。 */
    contexts?: unknown[]
    [key: string]: unknown
}

/** 装配期 `system-prompt/assemble` 的 context（用到的成员才声明）。 */
interface AssembleContext {
    agent?: Agent
    [key: string]: unknown
}

/**
 * 一次工具 / 技能筛选态。
 *
 * 绑定即接管之后只剩一种语义：**清单就是并集**，空清单 = 全排除。没有第二档，
 * 所以它就是一份名字清单，不需要 `mode` 之类的开关。
 */
type SurfacePolicy = string[]

/** `resolveTarget` 给出的目标画像。 */
interface Target {
    agentId: string | undefined
    label: string
    runtimeSurface: boolean
    sections?: SectionConfig[]
    tools: SurfacePolicy
    skills: SurfacePolicy
}

/**
 * 真机排障追踪：`DSH_AGENT_STUDIO_TRACE` 指向一个文件路径时，把装配期的关键判断
 * 逐行追加进去；没设这个环境变量时**零开销、零副作用**。
 *
 * 为什么需要它：装配的「没生效」有好几种长得一模一样的原因（预设解析不出、没绑定、
 * 配置没读到、监听器没跑到），而宿主的 logger 输出在有些运行形态（headless）里看不到。
 * 有了这一份现场，一条命令就能定位卡在哪一环。
 */
const trace = (line: string) => {
    const path = process.env.DSH_AGENT_STUDIO_TRACE
    if (path === undefined || path === '') return

    try {
        appendFileSync(path, `${new Date().toISOString()} ${line}\n`)

    } catch {
        // 追踪失败绝不能影响装配本身
    }
}

/** 把异常转成可进日志的一行（保留「有 message 用 message、否则退回原值」的旧语义）。 */
function errText(err: unknown): string {
    const e = err as { message?: unknown } | null | undefined
    const message = e?.message
    return (message === undefined || message === null) ? String(err) : String(message)
}

/**
 * 永远不受工具集收窄的**机制工具**（不是「保留名」）：
 *
 *  1. `run_code` —— PTC 的呈现传输保留名，收掉它 PTC 直接失效；
 *  2. `structured_output` —— 子代理向父会话汇报结果的机制工具（平台注册在子代理本层），
 *     收掉它子代理就哑了。
 *
 * **派活工具不再豁免**（2026-09-17 用户拍板：工具集是工具面的唯一真相）：派活工具
 * （`studio_delegate`/`studio_list_subagents`/官方 `subagent`）跟别的工具一视同仁——
 * 工具集里写了才给。配了子代理名册却没写派活工具，界面会在保存前提示。
 */
const MECHANISM_TOOL_NAMES = new Set(['run_code', 'structured_output'])

/**
 * 机制工具名单的一份拷贝，给面板用。
 *
 * 名单只有这一份真相（就是上面那个集合），面板通过 HTTP 端点取，不在 client 里另抄一份。
 *
 * @returns 永远不收窄的机制工具名。
 */
export function mechanismToolNames(): string[] {
    return [...MECHANISM_TOOL_NAMES]
}

/** 视图读不到时的占位：guard 对任何名字都「管不着」。 */
const NO_RESTRICTABLE_NAMES: Set<string> = new Set()

/** 已挂过的工具收窄，键是 agent 对象。配置一变就整体重挂。 */
const appliedSurfaces = new WeakMap<Agent, { signature: string; disposers: Array<() => void> }>()

/** 子代理在创建窗口挂的执行期 guard，键是 agent 对象；同一 agent 重挂前先撤旧的。 */
const childGuards = new WeakMap<Agent, Array<() => void>>()

/** 已挂过的技能面（agent 层同名覆盖），键是 agent 对象；名单或清单一变就整体重挂。 */
const appliedSkills = new WeakMap<Agent, { signature: string; disposers: Array<() => void> }>()

/**
 * 已声明的工具呈现模式与其精确 disposer，键是 agent 对象。
 *
 * 为什么单独记 mode：`presentAs` **同一 scope 只能声明一次**（同一 layer 上二次声明
 * 直接抛 `conflicts with ... already declared for this scope`）——所以重挂前必须先
 * dispose 旧的，同模式则直接跳过。这就是「幂等与撤销」的全部内容。
 */
const appliedPresentations = new WeakMap<Agent, { mode: 'native' | 'ptc'; dispose: () => void }>()

/**
 * 挂上段拼接、工具收窄与子代理创建窗口挂钩。
 *
 * 由调用方在 `settings` 服务就绪后调用——拿不到设置服务时不挂，
 * 插件退回纯观察，与「缺省不干预」一致。
 *
 * @param ctx - 插件所在的 context。
 * @param logger - 用于报错与诊断的 logger。
 * @param settingsScope - 本插件设置命名空间的 scope，提供 `get()`。
 */
export function mountApply(ctx: Ctx, logger: Logger, settingsScope: SettingsScope) {
    trace('mountApply 被调用')

    /** 决策链只报告一次，避免每一步装配都刷屏。 */
    let reportedFirstDecision = false

    /**
     * 把本次装配的决策链打一行出来。
     *
     * 「没生效」有好几种截然不同的原因，而光看结果（段数没变）它们长得一模一样：
     * 取不到 agent 的 scope context、解析不出预设、预设没绑定代理、代理被删了。
     * 这一行把判断依据一次给全，不用逐项试。
     */
    const reportFirstDecision = (facts: string[]) => {
        if (reportedFirstDecision) return
        reportedFirstDecision = true

        logger.info?.(`[agent-studio] 装配决策 · ${facts.join(' · ')}`)
    }

    /**
     * 子代理的**创建窗口**：认领身份 + 挂工具面收窄 + 声明 Agent 模式。
     *
     * 认领 = 把「这个子代理会话属于哪个代理」记进 `delegate.js` 的映射表，装配期的段
     * 拼接就靠它。配对按父会话：`studio_delegate` 在 `start()` 调用**前**把
     * `{ 父会话, 代理 id }` 放进待认领队列——同步入队保证了它一定早于创建。
     *
     * 事件里拿不到「是哪个 claim 触发的创建」，同父并发派活时按队列顺序（FIFO）配对；
     * 可续子代理那条路另有预生成会话 id 的精确配对（见 `delegate.js`），不走队列。
     *
     * 挂工具面在这里而不是装配期，是因为 `agent/created` 早于第一次装配（见模块头注释）。
     * 名单**当场验证**：`restrict()` 点名的名字必须全在当时的可收窄集合里，否则整次调用
     * 抛错。所以 allow 取「可收窄集合 ∩ 工具集并集」，再加回保留名——保留名永远放行，
     * 而 `run_code` 不在可收窄集合里（视图单独附加它），天然不会进 allow。
     *
     * 注意子代理的工具面挂在 `toolNames === undefined` 的出口**之前**——「没装工具集」
     * 和「收窄成空」是两回事。
     */
    const handleChildCreated = (agent: Agent) => {
        const childId = agent?.id
        const parentSessionId = agent?.session?.header?.parentSession
        if (typeof childId !== 'string') return

        // 精确登记优先：可续子代理的会话 id 由派活方在 start 前指定，映射那时就写好了；
        // 冷恢复重建的 agent 也命中这里（会话 id 不变，映射还在），直接按它重挂收窄。
        let agentId = agentOfChildSession(childId)

        if (agentId === undefined && typeof parentSessionId === 'string') {
            agentId = claimChildAgent({ childId, parentSessionId })
        }

        if (agentId === undefined) return

        const config = settingsScope.get()
        const agentConfig = agentById(config, agentId)
        if (agentConfig === undefined) return

        // Agent 模式（三档开关）：`presentAs` 影响 `wireSchemas` 与 SDK 段正文，两者在
        // 装配前半段求值，装配期挂只对**下一次**生效，所以在这个创建窗口挂。
        applyToolPresentation(logger, ctx, agent, presentationOf(config, agentId), `子代理=${agentId}`)

        // 绑定即接管：一个集都没装就是空并集（一个工具都不给），与「装了空集」同义。
        const toolNames = mergeToolNames(config, agentConfig.toolSets) ?? []
        mountChildToolSurface(logger, agent, toolNames, `子代理=${agentId}`)
    }

    /**
     * 主代理的**创建窗口**：能解析出「预设 → 绑定代理」时当场声明 Agent 模式。
     *
     * 主代理的身份（`bindings.presets` 里那个绑定）在装配期才被 `resolveTarget` 使用，
     * 但预设解析（`agentPresets.composedPreset`）在创建时通常已可用——正常创建路径
     * 都会先 join 预设再发布（平台 `agent/created` 的 warning 就是为异常路径准备的）。
     * 解析不出来时静默跳过（走 `follow`，对没挂过声明的是零动作），装配期那次会兜底；
     * **切预设**引出的第二条路在 `reconcileMainPresentations`。
     *
     * @param agent - 刚创建的 agent。
     */
    const handleMainCreated = (agent: Agent) => {
        const parentSessionId = agent?.session?.header?.parentSession
        // 子代理（有父会话）走 handleChildCreated；这里只看主代理。
        if (typeof parentSessionId === 'string') return

        const config = settingsScope.get()
        if (config === undefined) return

        // Agent 模式（三档开关）：同一创建窗口，理由见子代理分支。
        applyMainPresentation(ctx, logger, config, agent, '创建窗口')
    }

    /**
     * 预设切换的补救：平台「切换预设」走 `AgentPresets.select()` → `recompose()`，
     * 只对**已有 agent** 重绑 standing scope（`binding.rebind(…)`）——不重建 agent、
     * 不发 `agent/created`。于是创建窗口没有第二次机会，而装配期那次挂对当次太晚
     * （`wireSchemas` 与 SDK 段正文在瀑布之前已求值）⇒ 真机现象：切预设后的
     * **第一条**消息仍是原生、第二条才 PTC（2026-09-19 会话取证：
     * `agent-preset/selected` 落在第一条 `turn/start` 之前，但 agent 早于它创建）。
     *
     * 这条监听补的就是那个缺口：`recompose()` 收尾会 `emit('tools/change')`，那一刻
     * 新预设已绑好、第一条消息还没发。事件**不带参数**（平台自己也只把它当「重算」
     * 信号，见 `dsh-tool-subagent` 的同名监听），所以这里遍历活 agent、对每个主代理
     * 走与创建窗口同一套解析——幂等（同档跳过），未绑定的走 `follow` 撤销。
     *
     * 判据与 `handleMainCreated` 一致（`parentSession` 非字符串 = 主代理）：可续子代理
     * 有自己的契约（走 `handleChildCreated` 的认领路），不能被主代理的绑定误挂。
     */
    const reconcileMainPresentations = () => {
        const config = settingsScope.get()
        if (config === undefined) return

        const registry = ctx.get?.('agents') as { list?(): Agent[] } | undefined
        if (typeof registry?.list !== 'function') return

        const mains = registry.list().filter((agent) => typeof agent?.session?.header?.parentSession !== 'string')
        trace(`预设切换补救 · tools/change · 主代理 ${mains.length} 个`)

        for (const agent of mains) {
            applyMainPresentation(ctx, logger, config, agent, '预设切换补救')
        }
    }

    ctx.on('tools/change', (() => {
        // 同 `agent/created`：异常绝不能外泄。`emit` 是同步分发，抛出去会打断触发方
        // （平台在 `recompose()` 里把整次 emit 包了 try，但别赌别人的边界）。
        try {
            reconcileMainPresentations()

        } catch (err) {
            logger.warn?.(`[agent-studio] 预设切换补救失败，已跳过：${errText(err)}`)
        }
    }) as (...args: unknown[]) => void)

    ctx.on('agent/created', (({ agent }: { agent: Agent }) => {
        // 这一层绝不能让异常外泄：它跑在宿主的创建事务里，抛错会连子代理的创建一起带塌。
        try {
            handleChildCreated(agent)
            handleMainCreated(agent)

        } catch (err) {
            logger.warn?.(`[agent-studio] 子代理创建窗口处理失败，已跳过：${errText(err)}`)
        }
    }) as (...args: unknown[]) => void)

    /**
     * 按配置改写本次装配的产物；查不到配置就原样返回。
     *
     * 这里每一步都踩在宿主内部结构上（预设服务的 scope 链、段与工具的形状、
     * SDK 段的注册方法），任何一步失配都只该退回「不干预」而**不是**把异常
     * 扔给调用方——那会让用户的这一次请求直接失败。边界包在调用点，见下。
     */
    const rewrite = async (result: AssembleResult, context: AssembleContext): Promise<AssembleResult> => {
        const agent = context?.agent as Agent
        const agentCtx = agent?.ctx
        trace(`assemble 到达 · agent=${agent?.id ?? '无'}`)

        if (agentCtx === undefined) {
            trace('agent.ctx 缺失，退出')
            reportFirstDecision(['agent.ctx=无'])
            return result
        }

        const presetId = resolvePresetId(ctx, agentCtx)
        trace(`presetId=${presetId ?? '解析不出'} · ${describePresetResolution(ctx, agentCtx).join(' · ')}`)

        if (presetId === undefined) {
            reportFirstDecision(['预设=解析失败', ...describePresetResolution(ctx, agentCtx)])
            return result
        }

        const config = settingsScope.get()

        const target = resolveTarget(config, agent, presetId)
        trace(`target=${target === undefined ? '无' : target.label} · configAgents=${config?.agents?.length ?? 'N/A'} · bindings=${JSON.stringify(config?.bindings?.presets ?? 'N/A')}`)

        // 运行时快照开关（**代理级**，2026-09-17 从预设级改过来：开关住在 Agent 的提示词面里）。
        // 判据只在这里算一次，落点在函数末尾那次 `contexts` 清空（未绑定 = 不干预，判据自然为假）。
        const snapshotOff = config?.runtimeContextOff?.includes(target?.agentId as string) === true

        // Agent 模式（三档）：装配期这一次是**保状态**——创建窗口挂过的不重复挂
        // （幂等），配置变过的（改了档 / 代理被解绑）在这里重挂或撤销；挂完对
        // **下一次**装配生效（`wireSchemas` 在瀑布之前已求值）。
        try {
            applyToolPresentation(logger, ctx, agent, presentationOf(config, target?.agentId), target?.label ?? '未绑定（撤销声明）')

        } catch (err) {
            logger.warn?.(`[agent-studio] Agent 模式处理失败，已跳过：${errText(err)}`)
        }

        if (target === undefined) {
            reportFirstDecision([
                `预设=${presetId}`,
                '未绑定主代理',
                `已配置代理=${config?.agents?.length ?? 0}`,
                ...describePresetResolution(ctx, agentCtx),
            ])
            return result
        }

        // 技能面：装配瀑布早于 `agent/pre-step` 的技能目录发布（agent-loop 的 preStep 里
        // 先 assemble、后发 pre-step），所以在这里挂就对**本次**请求生效——主、子代理同一条路。
        try {
            await applySkillSurface(logger, agent, target.skills, target.label)

        } catch (err) {
            logger.warn?.(`[agent-studio] 技能面处理失败，已跳过：${errText(err)}`)
        }

        const tools = ctx.get?.('tools')
        let next = result

        // 工具面：只有「创建窗口没挂过」的（主代理、未被认领的兜底路径）才在装配期挂视图收窄。
        // 创建窗口已挂过的子代理不挂第二道 restrict（交集打架）；它的 guard 在创建窗口挂、
        // 声明层裁剪则由下面这一步统一负责。
        if (target.runtimeSurface && tools !== undefined) {
            if (applyToolSurface(logger, tools as ToolService, agent, target.tools, target.label)) {
                refreshSdkSection(tools as ToolService, context, result)
            }
        }

        // 声明层裁剪：本次装配的 `assembly.tools` 是在瀑布之前求值的，光靠视图挡不住第一次；
        // 这里按同源判据把声明也裁一遍——**对所有路径生效**（含创建窗口已挂的子代理），
        // 它同时是收「agent 本层工具」（subagent / list_subagent_models，restrict 收不动）
        // 的投递层手段。
        const schemas = restrictToolSchemas(result?.tools, target.tools)
        if (schemas !== undefined) next = { ...next, tools: schemas }

        // SDK 声明正文（PTC 下模型唯一的工具知识来源）走的是另一条投递通道，上面那步
        // 管不到它；按同一判据再裁一道，让本层漏网工具连「能看」都不剩。
        let sdkRemovedNames: string[] = []
        if (tools !== undefined) {
            sdkRemovedNames = stripSdkSectionText(tools as ToolService, agent, target.tools, next, target.label)
        }

        const declared = `声明 ${result?.tools?.length ?? 0}→${next?.tools?.length ?? 0}`

        // 段面：**绑定即接管**（覆盖语义）——清单即投递的全部内容，没列出的平台预设一律
        // 不投递；一个集都没装 = 投递空清单（`mergeSections` 返回 undefined）。
        const sections = buildSections(next?.sections, target.sections ?? [])
        trace(`段：配置=${target.sections === undefined ? '无（空清单）' : target.sections.map((s) => `${s.name}${s.text !== undefined ? '(自带)' : ''}`).join('|')} · 平台=${Array.isArray(next?.sections) ? next.sections.map((s) => s?.name).join('|') : '非数组'} · 结果=${sections.map((s) => s?.name).join('|') || '（空）'}`)

        reportFirstDecision([
            target.label,
            `段 ${next?.sections?.length}→${sections.length}`,
            declared,
            ...(snapshotOff ? [`快照 清空 ${next?.contexts?.length ?? 0} 条`] : []),
            ...(sdkRemovedNames.length > 0 ? [`SDK 声明裁掉 ${sdkRemovedNames.join('|')}`] : []),
        ])

        // 运行时快照：**不吃平台的开关，直接在这条瀑布里清 `contexts`**。
        //
        // 平台确实给了 `systemPrompt.suppressRuntimeContext()`，也把判据写进了 `assemble()`
        // 的返回值里（抑制时 `contexts: []`），抑制器本身工作正常（离线最小复现可证）。
        // 但它把抑制器挂进**服务实例自己那条 scope**，从 `agent.ctx` 调过去落点不由我们
        // 掌握：2026-09-18 真机取证——host 日志「已关闭 agent … 的运行时环境快照注入」
        // 明明打过了，会话里那一整片 `sandbox:policy` / `approval:policy` /
        // `tool-normalizer:top-errors` 照旧投给了模型，模型在自己的思考里把
        // 「unrecovered errors: 377」原样复述了出来。
        //
        // 而这条瀑布是**唯一**的产出口（agent-loop 的 `preStep` 只在这里 assemble 一次），
        // 段面过滤（上面的 `sections`）在这里是实测有效的，所以 `contexts` 也在同一处清：
        // 清完平台自己就会算出「没有快照」——从没有过则整条不投递，曾经有过则投一条
        // 「作废」通知，两种情况都是我们要的，不需要插件再管。
        if (snapshotOff) next = { ...next, contexts: [] }

        return { ...next, sections }
    }

    ctx.on('system-prompt/assemble', (async (_assembly: unknown, context: AssembleContext, next: () => Promise<AssembleResult>) => {
        // `next()` 留在边界外：宿主自己的异常照常向上传播，不归插件管。
        const result = await next()

        try {
            return await rewrite(result, context)

        } catch (err) {
            logger.warn?.(`[agent-studio] 装配期改写失败，已退回不干预：${errText(err)}`)
            return result
        }
    }) as (...args: unknown[]) => void)

    logger.info?.('[agent-studio] 装配期生效逻辑已挂上（含子代理创建窗口挂钩）')
}

/**
 * 该 agent 这次该用哪套面。
 *
 * 两个来源，按优先级：
 *
 *  1. **本插件派出去的子代理** —— 查映射表；没有就按父会话从待认领队列兜底认领一次
 *     （`agent/created` 挂钩没赶上的情况）。认领成功的这次在装配期挂收窄，所以
 *     `runtimeSurface` 为真；映射命中的（创建窗口已挂过）为假。
 *  2. **预设绑定的主代理** —— `bindings.presets` 里查。没绑定 = 不干预。
 *
 * 官方 `subagent` 工具派出的子代理没有登记，会落到第 2 条——与「预设主配置」
 * 同面，这正是 v1 就有的语义。
 *
 * @param config - 插件配置。
 * @param agent - 本次装配的 agent。
 * @param presetId - 它当前所在的预设 id。
 * @returns 目标画像；没有可用配置时 undefined。
 */
function resolveTarget(config: StudioConfig | undefined, agent: Agent, presetId: string | undefined): Target | undefined {
    const session = agent?.session
    const sessionId = typeof session?.id === 'string' ? session.id : undefined
    const parentSessionId = session?.header?.parentSession
    const isChildSession = typeof parentSessionId === 'string'

    let agentId = sessionId === undefined ? undefined : agentOfChildSession(sessionId)
    let isClaimedChild = agentId !== undefined
    let runtimeSurface = true

    if (isClaimedChild && isChildSession) {
        // 创建窗口已挂过工具面，装配期只做段。
        runtimeSurface = false

    } else if (agentId === undefined && isChildSession && sessionId !== undefined) {
        agentId = claimChildAgent({ childId: sessionId, parentSessionId })
        isClaimedChild = agentId !== undefined
    }

    if (agentId === undefined) agentId = boundAgentId(config, presetId)

    const agentConfig = agentById(config, agentId)
    if (agentConfig === undefined) return undefined

    return {
        agentId,
        label: isClaimedChild
            ? `子代理=${agentId}`
            : `预设=${presetId} · 主代理=${agentId}`,
        runtimeSurface,
        sections: mergeSections(config, agentConfig.promptSets),
        tools: toolPolicyOf(config, agentConfig.toolSets),
        skills: skillPolicyOf(config, agentConfig.skillSets),
    }
}

/**
 * 把「已装工具集」解析成一份筛选清单。
 *
 * **绑定即接管**：并集就是清单。一个集都没装 = 空清单 = 一个工具都不给。
 *
 * @param config - 插件配置。
 * @param toolSetIds - 该代理已装的工具集 id。
 * @returns 工具名清单；一个都没装时是空数组。
 */
function toolPolicyOf(config: StudioConfig | undefined, toolSetIds: unknown): SurfacePolicy {
    return mergeToolNames(config, toolSetIds) ?? []
}

/**
 * 把「已装技能集」解析成一份筛选清单（与工具面同一套语义）。
 *
 * **绑定即接管**：并集就是清单。一个集都没装 = 空清单 = 一个 skill 都不暴露。
 *
 * @param config - 插件配置。
 * @param skillSetIds - 该代理已装的技能集 id。
 * @returns skill 名清单；一个都没装时是空数组。
 */
function skillPolicyOf(config: StudioConfig | undefined, skillSetIds: unknown): SurfacePolicy {
    return mergeSkillNames(config, skillSetIds) ?? []
}

/**
 * 按配置的段清单重建投递清单（**覆盖语义**，2026-09-17 用户拍板）。
 *
 * 清单就是投递的全部内容：清单点名的段按数组顺序排（顺序即投递顺序），
 * **没点名的平台预设一律不投递**——要保留哪一段，就把它加进清单。
 * 清单为空（一个集都没装）⇒ 返回空清单，模型这轮收不到任何系统提示词段。
 *
 * 平台预设重建时**透传它的额外字段**（平台预设对象上除 name/text 外的东西原样跟随）；
 * 自定义项没有平台对应物，只带名字与正文。
 *
 * 段名精确匹配，没有通配符：清单里的名字在当前预设下不存在（且没自带正文）只是静默不投递。
 *
 * @param platformSections - 平台本次要投递的段，已求值为字符串。
 * @param sectionConfigs - 合并后的段清单（来自已装提示词集）；没装集时是空数组。
 * @returns 重建后的清单（可能是空数组）。
 */
function buildSections(platformSections: Section[] | undefined, sectionConfigs: SectionConfig[]): Section[] {
    const platformByName = new Map<string, Section>()
    for (const section of Array.isArray(platformSections) ? platformSections : []) {
        if (section?.name === undefined) continue
        platformByName.set(section.name, section)
    }

    const kept: Section[] = []
    for (const config of Array.isArray(sectionConfigs) ? sectionConfigs : []) {
        if (config?.name === undefined || config.name === '') continue
        if (config.enabled === false) continue

        // 配置自带文本 = 自定义项（或有意覆盖平台正文）；否则引用平台本次的正文。
        const platformSection = platformByName.get(config.name)
        const text = config.text ?? platformSection?.text
        if (typeof text !== 'string') continue

        kept.push(platformSection === undefined
            ? { name: config.name, text }
            : { ...platformSection, name: config.name, text })
    }

    return kept
}

/**
 * 在**创建窗口**给一个刚被认领的子代理挂工具面收窄。
 *
 * 与主代理的 `applyToolSurface` 不同，这里是一次性挂载两件套：
 *
 *  - `restrict({ allow })` —— 收**继承面**（global + 祖先层）；名单 = 「可收窄集合 ∩
 *    工具集并集」，**不再有保留名豁免**（2026-09-17 用户拍板：工具集是唯一真相）。
 *    点名的名字都在当场的 restrictable 里，不会触发 `restrict()` 的未知名校验。
 *  - `guard()` —— 执行期兜底，拦两类漏网：晚于挂载才注册的继承工具（MCP 重连等），
 *    以及注册在 **agent 本层**、`restrict()` 按设计收不动的工具
 *    （`subagent`/`list_subagent_models`）。按名字实时判：不在工具集里、又不是
 *    机制工具的一律拦。
 *
 * 机制工具（`run_code`/`structured_output`）永不拦。
 * 视图读不到时**放弃视图收窄**（退默认全给），但 guard 照挂——绝不「当作全排除」。
 *
 * @param logger - 用于报错与诊断的 logger。
 * @param agent - 刚创建的子代理。
 * @param toolNames - 该子代理工具集的并集。
 * @param label - 这套面属于谁，用于日志。
 */
function mountChildToolSurface(logger: Logger, agent: Agent, toolNames: string[], label: string) {
    const tools = agent?.ctx?.tools
    if (tools?.restrict === undefined) return

    const previous = childGuards.get(agent)
    if (previous !== undefined) {
        for (const dispose of previous) dispose()
        childGuards.delete(agent)
    }

    const wanted = new Set(toolNames)
    const restrictable = readRestrictableNames(tools, agent)
    let allowedCount = 0

    if (restrictable.size === 0) {
        logger.warn?.(`[agent-studio] 子代理 ${agent.id} 的工具视图读不到，跳过视图收窄（guard 兜底照挂）`)

    } else {
        const allow = [...restrictable].filter((name) => wanted.has(name))
        allowedCount = allow.length

        try {
            tools.restrict({ allow })

        } catch (err) {
            logger.warn?.(`[agent-studio] 子代理工具面收窄失败，已退回不干预：${errText(err)}`)
        }
    }

    const disposers: Array<() => void> = []
    if (typeof tools.guard === 'function') {
        disposers.push(tools.guard((exec: ToolExecLike) => {
            const name = exec?.name
            if (typeof name !== 'string') return undefined
            if (MECHANISM_TOOL_NAMES.has(name) || wanted.has(name)) return undefined

            return `工具 "${name}" 被排除：${label}（不在该子代理装载的工具集里）`
        }))
    }

    childGuards.set(agent, disposers)
    logger.info?.(`[agent-studio] 子代理 ${agent.id} 工具面已收窄 · ${label} · 放行 ${allowedCount} 个 · guard 兜底已挂`)
}

/**
 * 收窄该 agent 的工具面（主代理路径）。
 *
 * @param logger - 用于报错与诊断的 logger。
 * @param tools - 工具服务。
 * @param agent - 要收窄的 agent，同时是 scope key。
 * @param policy - 这次要用的工具名清单（空清单 = 一个都不给）。
 * @param label - 这套面属于谁，用于日志与拒绝原因。
 * @returns 视图是否**刚刚**被改动——调用方据此决定要不要重生 SDK 段。
 */
function applyToolSurface(logger: Logger, tools: ToolService, agent: Agent, policy: SurfacePolicy, label: string): boolean {
    const applied = appliedSurfaces.get(agent)

    // 内容签名而不是引用比较：设置服务每次解析都给出新的快照对象，
    // 比引用会让每次装配都当成「配置变了」白重挂一遍。
    const signature = `${label}\u0000${policy.join('\u0000')}`
    if (applied !== undefined && applied.signature === signature) return false

    const hadApplied = applied !== undefined
    if (applied !== undefined) {
        for (const dispose of applied.disposers) dispose()
        appliedSurfaces.delete(agent)
    }

    // 撤掉面也是「视图刚被改动」——旧的收窄摘下来之后，SDK 段同样得按新视图重生，
    // 否则撤销的那一次装配里，模型看到的 SDK 正文还是收窄后那份。所以这里返回
    // `hadApplied`：只要刚刚撤过东西，就值得重生一次。
    if (tools?.view === undefined || tools.restrict === undefined) return hadApplied

    // 集合在挂载时成形：guard 跑在执行期热路径上，别在里头反复建集合。
    const keepNames = new Set(policy)

    /** 按筛选态判一个名字该不该排除。机制工具永远不排除。 */
    const isDenied = (name: string) => {
        if (MECHANISM_TOOL_NAMES.has(name)) return false

        return !keepNames.has(name)
    }

    // guard 的判据只有一条：不在工具集里、又不是机制工具的，一律拦。这样两类漏网都
    // 逃不掉——晚于挂载才注册的继承工具（MCP 重连等），以及注册在 agent 本层、
    // `restrict()` 按设计收不动的工具（`subagent`/`list_subagent_models`）。
    const denyReason = (exec: ToolExecLike) => {
        const name = exec?.name
        if (typeof name !== 'string' || !isDenied(name)) return undefined

        return `工具 "${name}" 被排除：${label}`
    }

    // restrict 只能点名「当场可收窄」的名字（视图校验，错一个整次抛错）；
    // 本层工具与晚注册的继承工具交给声明层裁 + guard。
    const deny = [...readRestrictableNames(tools, agent)].filter(isDenied)

    const agentCtx = agent.ctx as AgentScope
    const disposers: Array<() => void> = []

    try {
        if (deny.length > 0) disposers.push(agentCtx.tools!.restrict({ deny }))
        disposers.push(agentCtx.tools!.guard(denyReason))

    } catch (err) {
        // 收窄失败只撤销收窄本身，段过滤照常生效——比整个改写退回要精细。
        for (const dispose of disposers) dispose()
        logger.warn?.(`[agent-studio] 工具面收窄失败，已退回不干预：${errText(err)}`)
        return false
    }

    appliedSurfaces.set(agent, { signature, disposers })
    logger.info?.(`[agent-studio] 已收窄 agent ${agent.id} 的工具面 · ${label} · 收起 ${deny.length} 个 · guard 兜底已挂`)
    return true
}

/**
 * 裁掉本次装配要投递给模型的工具声明里不在工具集里的那些。
 *
 * **为什么光靠视图收窄不够。** `assembly.tools` 由工具服务的 schema provider 在瀑布
 * **之前**求值，而视图收窄是瀑布里才挂上的——于是某个 agent 的**第一次**装配拿到的仍是
 * 未收窄的全量声明；而且 `restrict()` 按设计收不动 **agent 本层** 注册的工具
 * （`subagent`/`list_subagent_models`）。声明层是这两类漏网的共同解药：投递什么，我们说了算。
 *
 * 判据与 `applyToolSurface` 同源：**不在工具集里、又不是机制工具的一律裁**。
 * 机制工具（`run_code`/`structured_output`）永不裁。
 *
 * @param schemas - 本次装配要投递的工具声明。
 * @param policy - 这次要用的工具名清单（空清单 = 全裁）。
 * @returns 裁过的声明；没有可裁的（一个都没被排除）返回 undefined。
 */
function restrictToolSchemas(schemas: ToolSchema[] | undefined, policy: SurfacePolicy): ToolSchema[] | undefined {
    if (!Array.isArray(schemas)) return undefined

    const keepNames = new Set(policy)

    const kept = schemas.filter((schema) => {
        const name = schema?.name
        if (typeof name !== 'string') return true
        if (MECHANISM_TOOL_NAMES.has(name)) return true

        return keepNames.has(name)
    })

    return kept.length === schemas.length ? undefined : kept
}

/**
 * 按技能集收窄该 agent 的技能面：**把没勾的 skill 对模型隐藏**。
 *
 * 机制（2026-09-17 读平台源码确认）：skill 注册表按 scope 分层、**就近层赢**，而
 * 「模型能不能调用」由 skill 自己的 `invocation.modelInvocable` 决定——技能目录
 * （`<available_skills>`）与 `skill` 工具都跟着它过滤。于是收窄 = 在 **agent 层**
 * 注册一份**同名覆盖**：复制原 skill 的完整定义、只翻掉 `modelInvocable`。
 * `userInvocable` 原样保留 ⇒ 用户在输入框手调不受影响（菜单会标「仅用户」）。
 *
 * 只动「清单里有、但不在并集里」的那些；并集里的原样放行。清单与技能表都没变时整段
 * 跳过——装配期是热路径，重挂只发生在真的变化时。**卸掉全部技能集 = 空清单 = 全隐藏**，
 * 走的是同一条路（这里没有「撤销挂载」那种第三态）。
 *
 * @param logger - 用于报错与诊断的 logger。
 * @param agent - 目标 agent，同时是注册要落的 scope key。
 * @param policy - 这次要用的 skill 名清单（空清单 = 全隐藏）。
 * @param label - 这套面属于谁，用于日志。
 */
async function applySkillSurface(logger: Logger, agent: Agent, policy: SurfacePolicy, label: string) {
    if (policy === undefined) return

    const applied = appliedSkills.get(agent)

    const agentCtx = agent?.ctx as AgentScope
    const skillService = (typeof agentCtx?.get === 'function' ? agentCtx.get('skills') : undefined) as SkillService | undefined
    if (skillService?.snapshot === undefined || skillService.register === undefined || skillService.get === undefined) {
        trace(`技能面 · skills 服务拿不到（agent.ctx.get 返回 ${skillService === undefined ? 'undefined' : typeof skillService}）· ${label}`)
        logger.warn?.(`[agent-studio] 技能服务不可用，技能面保持原样 · ${label}`)
        return
    }

    const cwd = agent?.session?.header?.cwd

    let catalog: SkillCatalog | undefined
    try {
        catalog = await skillService.snapshot({ scope: agent, cwd })

    } catch (err) {
        trace(`技能面 · 清单读取失败：${errText(err)} · ${label}`)
        logger.warn?.(`[agent-studio] 技能清单读取失败，技能面保持原样 · ${label}：${errText(err)}`)
        return
    }

    const listed = Array.isArray(catalog?.skills) ? catalog.skills : []
    const include = new Set(policy)
    const hidden = listed
        .map((skill) => skill?.name)
        .filter((name): name is string => typeof name === 'string' && !include.has(name))

    const signature = `${label}\u0000${policy.join('\u0000')}\u0000${listed.map((skill) => skill?.name).join('\u0000')}`
    trace(`技能面 · ${label} · 清单 ${listed.length} 个 · 并集 ${policy.length} 个 · 隐藏 ${hidden.length} 个${applied !== undefined && applied.signature === signature ? '（无变化，跳过）' : ''}`)
    if (applied !== undefined && applied.signature === signature) return

    if (applied !== undefined) {
        for (const dispose of applied.disposers) dispose()
        appliedSkills.delete(agent)
    }

    const disposers: Array<() => void> = []
    for (const name of hidden) {
        try {
            const full = await skillService.get(name, { scope: agent, cwd })
            if (full === undefined) continue

            disposers.push(skillService.register({
                ...full,
                invocation: { ...(full.invocation ?? {}), modelInvocable: false },
            }))

        } catch (err) {
            logger.warn?.(`[agent-studio] 隐藏技能「${name}」失败，跳过这一个 · ${label}：${errText(err)}`)
        }
    }

    appliedSkills.set(agent, { signature, disposers })
    logger.info?.(`[agent-studio] 已收窄 agent ${agent.id} 的技能面 · ${label} · 隐藏 ${disposers.length}/${listed.length} 个 · 放行 ${policy.length} 个`)
}

/**
 * 运行时快照的开关**不在这里**，在装配瀑布里（见 `rewrite` 末尾那次 `contexts` 清空）。
 *
 * 曾经的实现走 `systemPrompt.suppressRuntimeContext()`：`agent/created` 里提前挂一次，
 * 装配期再兜底保状态。2026-09-18 真机取证推翻了它——抑制器明明挂上了（host 日志里
 * 「已关闭 agent … 的运行时环境快照注入」打过了），快照却照旧投给模型。
 * 平台那套抑制器本身没问题：离线最小复现里，从 agent scope 挂上去，`assemble()` 的
 * `contexts` 立刻清空、撤销后立刻回来。问题在于它挂的是**服务实例自己那条 scope**，
 * 从 `agent.ctx` 调过去的落点不受我们掌握，实测就是没落在本次装配用的那条上。
 * 改成在瀑布里清 `contexts` 之后，落点不再依赖任何 scope 推断。
 */

// ── 工具呈现（三档开关：跟随预设 / 原生 / 强制 PTC）────────────────────────

/**
 * 解析某个 agent 该用的Agent 模式。
 *
 * 缺省（没配 / 代理已删 / 还没解析出绑定）= `follow`：插件不声明，跟随预设。
 * `native` / `ptc` 是本 agent 的强制档——就近 scope 覆盖预设层的声明
 * （平台注释明确支持「PTC 部署下 opt out 的 agent」，两层声明不冲突）。
 *
 * @param config - 插件配置。
 * @param agentId - 代理 id；undefined 时返回 `follow`。
 * @returns 归一化后的三档值。
 */
function presentationOf(config: StudioConfig | undefined, agentId: string | undefined): ToolPresentation {
    const value = agentById(config, agentId)?.toolPresentation
    if (value === 'native' || value === 'ptc') return value

    return 'follow'
}

/**
 * 该 agent 现在的**有效呈现**是否已经不是原生（工具面走了 PTC 传输）。
 *
 * 平台约定（`dsh-tools` 的 `view()`）：非 native 模式会把 `run_code` 附加进可见工具面，
 * native 不会 ⇒ 可见面里已有 `run_code`，就说明这条 scope 链上已经有「非原生」的声明
 * 在生效——至于那份声明是谁挂的（我们上次的 / 同 scope 的其它会话 / 预设自己）不关心。
 *
 * 读不到视图时按「不是」处理：宁可多挂一次（挂了会撞冲突、上层记一条 warn），也不要
 * 因为读不到就漏挂——漏挂意味着这个 agent 悄悄退回原生，那才是真的静默失效。
 *
 * @param agent - 目标 agent，同时是视图的 scope key。
 * @returns 可见面里是否已有 `run_code`。
 */
function presentsPtc(agent: Agent): boolean {
    try {
        return agent?.ctx?.tools?.view(agent)?.visible?.has('run_code') === true

    } catch {
        return false
    }
}

/**
 * 声明 / 撤销该 agent 的工具呈现模式（三档开关的落点）。
 *
 * **幂等与撤销**：平台的 `presentAs` 在同一 scope 上只能声明一次（同一 layer 上
 * 二次声明直接抛错），返回的是「恢复部署默认」的精确 disposer。所以这里有三种走法：
 * 同模式 => 跳过；换档 / 撤销 => 先 dispose 再决定挂不挂。
 *
 * **为什么要先探 `ptcRuntime`**：`ptc` 档下宿主装配期（`wireSchemas`）会向运行时
 * 要 SDK 渲染器，环境里没有 `ctx.ptcRuntime` 就**直接抛错**——那会打断用户这一次
 * 请求。宁可不生效（退回不干预），也不能让装配炸掉。
 *
 * **服务名凭据**（2026-09-19 实测）：运行时由 `dsh-ptc-runtime-node` 提供，服务名是
 * `ptcRuntime`（`dsh-ptc-runtime` 的 `PtcRuntime extends Service` 里 `super(ctx,
 * 'ptcRuntime')`）；平台**没有** `codeRuntime` 这个名字——曾照它探测，导致强制 PTC
 * 恒被误判成「环境无运行时」而永不生效（自检替身也跟着写错，两边一起绿）。
 *
 * **挂载时机**：调用方是「创建窗口」（`agent/created`）与「预设切换补救」
 * （`tools/change`，见 `reconcileMainPresentations`）；装配期那一次只是保状态。
 * `presentAs` 影响 `wireSchemas` 与 SDK 段正文，两者在 `assemble()` 前半段
 * 求值，装配期挂只对**下一次**生效（同「挂载要趁早」那个坑）。
 *
 * @param logger - 用于报错与诊断的 logger。
 * @param ctx - 插件所在的 context（用全局视角探 `ptcRuntime`）。
 * @param agent - 目标 agent，同时是声明要落的 scope key。
 * @param mode - 三档值；`follow` = 撤销已有声明。
 * @param label - 这个决定属于谁，用于日志。
 */
function applyToolPresentation(logger: Logger, ctx: Ctx, agent: Agent, mode: ToolPresentation, label: string) {
    const applied = appliedPresentations.get(agent)

    if (mode === 'follow') {
        if (applied === undefined) return

        applied.dispose()
        appliedPresentations.delete(agent)
        trace(`呈现 · 撤销 · agent=${agent?.id ?? '无'} · ${label}`)
        logger.info?.(`[agent-studio] 已恢复 agent ${agent.id} 的预设默认呈现 · ${label}`)
        return
    }

    if (applied?.mode === mode) return

    if (applied !== undefined) {
        applied.dispose()
        appliedPresentations.delete(agent)
    }

    if (mode === 'ptc' && ctx.get?.('ptcRuntime') === undefined) {
        trace(`呈现 · 缺 ptcRuntime，放弃强制 ptc · agent=${agent?.id ?? '无'}`)
        logger.warn?.(`[agent-studio] 环境没有 ptcRuntime，无法强制 PTC，保持预设默认 · ${label}`)
        return
    }

    const tools = agent?.ctx?.tools
    if (typeof tools?.presentAs !== 'function') {
        trace(`呈现 · 拿不到 presentAs（agent.ctx.tools=${tools === undefined ? 'undefined' : typeof tools}）`)
        return
    }

    try {
        appliedPresentations.set(agent, { mode, dispose: tools.presentAs(mode) })
        trace(`呈现 · 挂上 ${mode} · agent=${agent?.id ?? '无'} · ${label}`)
        logger.info?.(`[agent-studio] 已声明 agent ${agent.id} 的Agent 模式：${mode} · ${label}`)

    } catch (err) {
        // 「这个 scope 上已有一份声明」不是故障，是**切预设路径上的常态**：真机 trace 里
        // 切预设的第一次挂载常撞上它（`one composition selects one presentation`），
        // 几毫秒后同一份又消失、下一次遍历就挂上了（2026-09-19 复现三次，机制像平台
        // `recompose()` 的 rebind 中间态，未彻查——但行为可依赖）。
        // 对「强制 PTC」这个目标而言，**只要该 agent 的有效呈现已经不是原生，状态就已
        // 达成**：那份声明是平台中间态造的、别的会话挂的、还是预设自己带的，都不重要
        // ——不需要（也不该）由我们再声明一次。
        // **不记表**：声明不归我们持有，将来撤销只撤自己挂的那份（记了会误撤别人的）；
        // 而「视为达成」不记表 ⇒ 之后每次 `tools/change` 都会重试一次，「中间态那份」
        // 消失后自然补挂（trace 里 2ms 后那次「挂上」就是它）。
        // 判据用有效视图：非 native 模式才把 `run_code` 附加进可见面（平台约定，见
        // `dsh-tools` 的 `view()`）；读不到视图按「未达成」处理——宁可多报一条 warn，
        // 也别把「其实没成」当成成。
        if (mode === 'ptc' && presentsPtc(agent)) {
            trace(`呈现 · 同 scope 已有声明，视为达成 · agent=${agent?.id ?? '无'} · ${label}`)
            return
        }

        trace(`呈现 · 挂载抛错：${errText(err)} · agent=${agent?.id ?? '无'} · ${label}`)
        logger.warn?.(`[agent-studio] Agent 模式声明失败，保持预设默认：${errText(err)}`)
    }
}

/**
 * 给一个**主代理**按「预设 → 绑定代理」声明 Agent 模式（三档开关）。
 *
 * 两个调用点共用：创建窗口（`agent/created`）与预设切换补救（`tools/change`）。
 * 未绑定 / 解析不出预设 ⇒ `follow` ⇒ 撤销已有声明——对没挂过的 agent 是零动作
 * （幂等表里没有它），对「绑定过又被解绑」的 agent 才是撤销。
 *
 * @param ctx - 插件所在的 context。
 * @param logger - 用于报错与诊断的 logger。
 * @param config - 插件配置。
 * @param agent - 目标主代理。
 * @param source - 这次调用是打哪儿来的（进日志与 trace，排障对齐时序用）。
 */
function applyMainPresentation(ctx: Ctx, logger: Logger, config: StudioConfig | undefined, agent: Agent, source: string) {
    const presetId = resolvePresetId(ctx, agent?.ctx)
    const agentId = boundAgentId(config, presetId)

    applyToolPresentation(logger, ctx, agent, presentationOf(config, agentId), `主代理=${agentId ?? '未绑定'} · 来源=${source}`)
}

/**
 * 读某 agent 视图层能收窄的工具名。
 *
 * 参数传 **agent 对象**是正确的：agent 本身就是它的 scope key（dsh-agent 的
 * `agentCarrier()` 文档原话 "the subject agent and scope key"），`view()` 沿它的
 * scope 链（agent → 预设 standing composition）取层级。曾有一次质疑「这里该传
 * scope 而不是 agent」——两者是同一个东西，不要改。
 *
 * guard 跑在执行期热路径上，而插件**绝不能**因为自身的问题打断用户的工具调用：
 * 读不到视图就当作「管不着」，把决定权交还给视图层。
 *
 * @param tools - 工具服务。
 * @param agent - 要读的 agent，同时是 scope key。
 * @returns 可收窄的继承工具名；读不到时返回空集合。
 */
function readRestrictableNames(tools: ToolService, agent: Agent): Set<string> {
    try {
        return tools.view(agent).restrictableNames as Set<string>

    } catch {
        return NO_RESTRICTABLE_NAMES
    }
}

/**
 * 收窄**刚**挂上时，本次装配构造出的 `tools:sdk` 正文还是按旧视图生成的
 * ——它的 `text` 在瀑布之前就被 `assemble()` 求值了。就地重生一份，
 * 免得该 agent 的第一次装配把已收起的工具写进 SDK 声明。
 *
 * `sdkSection()` 是宿主工具服务的公开方法，每次调用返回一份新的段注册，
 * 其 `text(context)` 按**当前**视图求值，所以重调一次即可。
 *
 * @param tools - 工具服务。
 * @param context - 本次装配的 context（`text` 需要它的 `scope`）。
 * @param result - 本次装配的产物，就地替换 SDK 段的正文。
 */
function refreshSdkSection(tools: ToolService, context: unknown, result: AssembleResult) {
    const sections = result?.sections
    if (!Array.isArray(sections)) return

    const sdkSection = sections.find((section) => section?.name === 'tools:sdk')
    if (sdkSection === undefined) return

    const text = tools?.sdkSection?.()?.text?.(context)
    if (typeof text === 'string') sdkSection.text = text
}

/**
 * 把 `tools:sdk` 段正文里「收不动、又调不了」的工具删掉，让声明与执行一致。
 *
 * **为什么单有一道**：SDK 正文照当前视图生成，而 `restrict()` 按设计只收继承面
 * ——注册在 agent 本层的工具（`subagent`/`list_subagent_models` 这类）收不掉，
 * 于是它们留在声明里，调用却被 guard 拒（「能看不能调」）。判据与 guard 同源：
 * 「视图可见 − 工具集并集 − 机制工具」正是 guard 会拦的全部名字，删干净即两边一致。
 *
 * **为什么每次装配都走**：平台正文每次按当前视图重生，本层工具恒在其中；裁剪是
 * 幂等的（没有目标名字就原样返回），开销只有一次视图读取与一次子串检查。
 *
 * 视图读不到时静默跳过（与 `restrict`/`guard` 的「读不到视图就放手」一致）；
 * 段不存在（原生呈现、或清单里没点名 `tools:sdk`）时同样不动。
 *
 * @param tools - 工具服务。
 * @param agent - 目标 agent，同时是视图的 scope key。
 * @param policy - 这次要用的工具名清单（空清单 = 条目全删）。
 * @param result - 本次装配的产物，就地替换 SDK 段正文。
 * @param label - 这套面属于谁，用于追踪。
 * @returns 实际删掉的工具名（去重）；没删时为 `[]`。
 */
function stripSdkSectionText(tools: ToolService, agent: Agent, policy: SurfacePolicy, result: AssembleResult, label: string): string[] {
    const sdkSection = result?.sections?.find((section) => section?.name === 'tools:sdk')
    if (typeof sdkSection?.text !== 'string') return []

    let visible: Map<string, unknown> | undefined
    try {
        const value = tools.view(agent).visible
        if (value instanceof Map) visible = value as Map<string, unknown>

    } catch {
        return []
    }
    if (visible === undefined) return []

    const keep = new Set(policy)
    const removeNames = new Set<string>()
    for (const name of visible.keys()) {
        if (MECHANISM_TOOL_NAMES.has(name) || keep.has(name)) continue
        removeNames.add(name)
    }
    if (removeNames.size === 0) return []

    const stripped = stripSdkEntries(sdkSection.text, removeNames)
    if (stripped.removed.length === 0) return []

    sdkSection.text = stripped.text

    const removedNames = [...new Set(stripped.removed)]
    trace(`SDK 声明裁剪 · ${label} · 删 ${removedNames.join('|')}`)
    return removedNames
}
