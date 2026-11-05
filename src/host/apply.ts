
/**
 * 装配期生效逻辑：按插件配置改写模型实际看到的段与工具面。
 *
 * v2 的两条通道仍各自分头走：
 *
 *  1. **段** —— 主代理与子代理都在 `system-prompt/assemble` 瀑布里重建 `result.sections`。
 *     投递顺序就是**数组顺序**（`order` 字段在 `assemble()` 构造投递对象时已被
 *     丢弃，改写它完全无效——已由源码与真机双重确认）。
 *
 *  2. **工具** —— 工具面**趁早挂**：主代理与子代理都在「创建窗口」（`agent/created`）
 *     挂 `restrict()` + `guard()`（主代理按「预设 → 绑定」解析，见 `handleMainCreated`；
 *     子代理查映射表，见 `handleChildCreated`）。原因：平台在进瀑布**之前**就让 provider
 *     按视图收齐工具声明（瀑布收到的 assembly 里**没有** `tools`，返回后又被 provider
 *     那份覆盖），装配期挂的收窄管不到当次；而 `agent/created` 必然早于第一次装配。
 *     切预设**不重建 agent**、改配置也不发 `agent/created`，所以另有两个重挂点
 *     （`tools/change` 与 `settings/document-updated`，见 `reconcileMainSurfaces`）；
 *     装配期那次只是第 4 道兜底。
 *
 * 不干预原则（规格 3.4）：**未**绑定代理、或代理查不到，就原样透传，一行都不改。
 * **绑定即接管**（用户拍板：2026-09-17 定于段面，2026-09-18 统一到三面）：绑定之后，
 * 段面、工具面、技能面**全部**由该代理装载的集决定——**一个集都没装就是空集**：
 * 投递空提示词、一个工具都不给、一个 skill 都不暴露。三面同一套语义，没有中间态。
 *
 * 工具面的收窄要两招并用，因为平台的 `restrict()` 按设计只收**继承面**（全局 + 祖先层，
 * 见 dsh-tools 的 `view()`），收不动注册在 **agent 本层** 的工具
 * （`subagent`/`list_subagent_models` 就是这样装上去的）：
 *
 *   - 视图层：`restrict({deny/allow})` —— 收继承面；
 *   - 执行层：`guard()` —— 拦「晚注册逃逸」与本层工具的实际调用。声明层没有落点
 *     （瀑布产物里没有 `tools`），本层工具只能在这里拦，表现为「能看不能调」。
 *
 * 两招判据同源：**不在工具集并集里的，除机制工具外一律收**。
 *
 * @module dsh-agent-studio/apply
 */

import { appendFileSync } from 'node:fs'

import { SETTINGS_NAMESPACE, agentById, boundAgentId, mergeSections, mergeSkillNames, mergeToolNames } from './config.js'
import { agentOfChildSession } from './delegate.js'
import { describePresetResolution, resolvePresetId } from './preset.js'
import { stripSdkEntries } from './sdk-strip.js'
import type { Ctx, Logger, SettingsScope, StudioConfig, SectionConfig } from './types.js'

// ── 本文件私有的宿主形状（宿主注入，精确契约见平台源码；够用即可）─────────────

/** 工具服务：restrict / guard / view 用到的成员。 */
interface ToolService {
    view(scope: unknown): { visible?: Map<string, unknown>; restrictableNames?: Set<string>; [key: string]: unknown }
    restrict(rule: { allow?: string[]; deny?: string[] }): () => void
    guard(fn: (exec: ToolExecLike) => string | undefined): () => void
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

/** 装配期产物里的一段。 */
interface Section {
    name?: string
    text?: string
    enabled?: boolean
    [key: string]: unknown
}

/**
 * 装配期 `system-prompt/assemble` 的产物（段与动态快照）。
 *
 * **没有 `tools`**：平台在进瀑布之前就按视图收齐工具声明，瀑布收到的 assembly 里不含它，
 * 返回后再由 provider 那份覆盖（0.2.2 源码）。所以声明层在瀑布里没有可改的字段。
 */
interface AssembleResult {
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
 *  1. `run_code` —— **防御性放行，不是兼容分支**：呈现由执行器决定之后它只在 PTC 执行器
 *     选中的组合里出现，而它恰恰是 PTC 下模型唯一能调的工具——漏网路径上收掉它，整条会话
 *     的工具调用会全废；
 *  2. `structured_output` —— 子代理向父会话汇报结果的机制工具（平台注册在子代理本层），
 *     收掉它子代理就哑了。
 *
 * **派活工具不再豁免**（2026-09-17 用户拍板：工具集是工具面的唯一真相）：派活工具
 * （`studio_delegate`/`studio_list_subagents`/官方 `subagent`）跟别的工具一视同仁——
 * 工具集里写了才给。配了子代理名册却没写派活工具，界面会在保存前提示。
 */
const MECHANISM_TOOL_NAMES = new Set(['run_code', 'structured_output'])

/** 视图读不到时的占位：guard 对任何名字都「管不着」。 */
const NO_RESTRICTABLE_NAMES: Set<string> = new Set()

/** 已挂过的工具收窄，键是 agent 对象。配置一变就整体重挂。 */
const appliedSurfaces = new WeakMap<Agent, { signature: string; disposers: Array<() => void> }>()

/**
 * 本插件正在改工具层的那一刻。
 *
 * `restrict()` / `guard()` 与它们的 disposer 都会**同步**发一次 `tools/change`：
 * `dsh-scope` 的 `ScopedLayers.effect()` 收尾就调 `onChange`，dsh-tools 把它接成
 * `ctx.emit('tools/change')`。那一趟是本插件自己的改动引起的，重挂点重入进去会
 * 「边挂边判」——同一份面挂出两套，前一套的 disposer 还没记表就丢了。
 */
let mutatingSurfaces = false

/** 子代理在创建窗口挂的执行期 guard，键是 agent 对象；同一 agent 重挂前先撤旧的。 */
const childGuards = new WeakMap<Agent, Array<() => void>>()

/** 已挂过的技能面（agent 层同名覆盖），键是 agent 对象；名单或清单一变就整体重挂。 */
const appliedSkills = new WeakMap<Agent, { signature: string; disposers: Array<() => void> }>()

/**
 * 挂上段拼接、工具收窄与三个重挂点（创建窗口 / 配置变更 / 切预设）。
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
     * 子代理的**创建窗口**：查映射表 + 挂工具面收窄。
     *
     * 映射由 `delegate.js` 在派活**前**写好（预生成会话 id 的精确登记），装配期的段
     * 拼接就靠它；这里只查表，查不到就什么都不做（官方 `subagent` 派出的子代理、
     * 以及重启后丢了映射的旧子会话都走这条，装配期照样退回默认面）。
     *
     * 挂工具面在这里而不是装配期，是因为 `agent/created` 早于第一次装配（见模块头注释）。
     * 名单**当场验证**：`restrict()` 点名的名字必须全在当时的可收窄集合里，否则整次调用
     * 抛错。所以 allow 取「可收窄集合 ∩ 工具集并集」，再加回保留名——保留名永远放行，
     * 而 `run_code` 不在可收窄集合里（`restrict()` 禁止点名它），天然不会进 allow。
     *
     * 注意子代理的工具面挂在 `toolNames === undefined` 的出口**之前**——「没装工具集」
     * 和「收窄成空」是两回事。
     */
    const handleChildCreated = (agent: Agent) => {
        const childId = agent?.id
        if (typeof childId !== 'string') return

        // 映射在派活前就写好了；冷恢复重建的 agent 也命中这里（会话 id 不变，映射还在），
        // 直接按它重挂收窄。
        const agentId = agentOfChildSession(childId)
        if (agentId === undefined) return

        const config = settingsScope.get()
        const agentConfig = agentById(config, agentId)
        if (agentConfig === undefined) return

        // 绑定即接管：一个集都没装就是空并集（一个工具都不给），与「装了空集」同义。
        const toolNames = mergeToolNames(config, agentConfig.toolSets) ?? []
        mountChildToolSurface(logger, agent, toolNames, `子代理=${agentId}`)
    }

    /**
     * 主代理的**创建窗口**：能解析出「预设 → 绑定代理」时当场把工具面收窄。
     *
     * 主代理的身份（`bindings.presets` 里那个绑定）在装配期才被 `resolveTarget` 使用，
     * 但预设解析（`agentPresets.composedPreset`）在创建时通常已可用——正常创建路径
     * 都会先 join 预设再发布（平台 `agent/created` 的 warning 就是为异常路径准备的）。
     * 解析不出来时静默跳过，装配期那次会兜底；**切预设**与**改配置**引出的另两条路在
     * `reconcileMainSurfaces`。
     *
     * @param agent - 刚创建的 agent。
     */
    const handleMainCreated = (agent: Agent) => {
        const parentSessionId = agent?.session?.header?.parentSession
        // 子代理（有父会话）走 handleChildCreated；这里只看主代理。
        if (typeof parentSessionId === 'string') return

        const surface = mainSurfaceOf(ctx, settingsScope.get(), agent)
        if (surface === undefined) return

        const tools = agent?.ctx?.tools
        if (tools === undefined) return

        applyToolSurface(logger, tools, agent, surface.tools, surface.label)
    }

    /**
     * 把活着的主代理的工具面重挂到「预设 → 绑定」当下该有的样子。
     *
     * 两个调用点各补一个「创建窗口不会再来一次」的缺口：
     *
     *  - `tools/change`：平台「切换预设」走 `AgentPresets.select()` → `recompose()`，
     *    只对**已有 agent** 重绑 standing scope——不重建 agent、不发 `agent/created`。
     *    `recompose()` 收尾会 `emit('tools/change')`，那一刻新预设已绑好、第一条消息还
     *    没发。事件**不带参数**（平台自己也只把它当「重算」信号，见 `dsh-tool-subagent`
     *    的同名监听），所以这里遍历活 agent 逐个重算。
     *  - `settings/document-updated`：面板保存、手改配置文件都会改掉「预设 → 绑定」与
     *    工具集，同样不发 `agent/created`。
     *
     * 解析不出目标面 = 这个主代理此刻不该被接管 ⇒ 撤掉已挂的收窄，别把上一个绑定的面留在
     * 进程里。一个绑定都没有时同理（谁都该「不干预」），那条分支只撤、不解析预设。
     * 判据与 `handleMainCreated` 一致（`parentSession` 非字符串 = 主代理）：子代理有
     * 自己的契约（创建窗口按映射表挂收窄），不能被主代理的绑定误挂。
     *
     * @param source - 这次重挂是打哪儿来的（进 trace 与 warn，排障对时序用）。
     */
    const reconcileMainSurfaces = (source: string) => {
        const config = settingsScope.get()

        const registry = ctx.get?.('agents') as { list?(): Agent[] } | undefined
        if (typeof registry?.list !== 'function') return

        const mains = registry.list().filter((agent) => typeof agent?.session?.header?.parentSession !== 'string')
        trace(`${source} · 主代理 ${mains.length} 个`)

        // `tools/change` 是高频无参事件：一个绑定都没有就没有可接管的主代理，只剩「把挂过
        // 的收窄撤掉」这一件事——不做逐 agent 的预设解析（每个 agent 只查一次记表）。
        if ((config?.bindings?.presets ?? []).length === 0) {
            for (const agent of mains) withdrawToolSurface(agent)
            return
        }

        for (const agent of mains) {
            try {
                const surface = mainSurfaceOf(ctx, config, agent)
                if (surface === undefined) {
                    withdrawToolSurface(agent)
                    continue
                }

                const tools = agent?.ctx?.tools
                if (tools === undefined) continue

                applyToolSurface(logger, tools, agent, surface.tools, surface.label)

            } catch (err) {
                logger.warn?.(`[agent-studio] ${source} · 主代理 ${agent?.id ?? '无'} 的工具面重挂失败，已跳过：${errText(err)}`)
            }
        }
    }

    ctx.on('tools/change', (() => {
        // 自己刚改的那一次不发重挂：`restrict()`/`guard()` 的 emit 是同步的，
        // 重入进来会边挂边判（见 `mutatingSurfaces`）。
        if (mutatingSurfaces) return

        // 同 `agent/created`：异常绝不能外泄。`emit` 是同步分发，抛出去会打断触发方
        // （平台在 `recompose()` 里把整次 emit 包了 try，但别赌别人的边界）。
        try {
            reconcileMainSurfaces('tools/change')

        } catch (err) {
            logger.warn?.(`[agent-studio] 预设切换补救失败，已跳过：${errText(err)}`)
        }
    }) as (...args: unknown[]) => void)

    // 配置变更的重挂点：面板保存 / 手改配置文件之后，「预设 → 绑定」与工具集都可能变了。
    // 这条只管重挂工具面——自建预设的注册表 sync 在 `index.ts` 那条同名监听里，两件事
    // 分头走。
    ctx.on('settings/document-updated', ((ns: unknown) => {
        if (ns !== SETTINGS_NAMESPACE) return

        try {
            reconcileMainSurfaces('settings/document-updated')

        } catch (err) {
            logger.warn?.(`[agent-studio] 配置变更后重挂工具面失败，已跳过：${errText(err)}`)
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
     * 这里每一步都踩在宿主内部结构上（预设服务的 scope 链、段与工具视图的形状），
     * 任何一步失配都只该退回「不干预」而**不是**把异常扔给调用方——那会让用户的这一次
     * 请求直接失败。边界包在调用点，见下。
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

        const tools = ctx.get?.('tools') as ToolService | undefined
        let next = result

        // 工具面：第 4 道兜底。创建窗口与两个重挂点正常都挂过了，这里幂等跳过；剩下的只有
        // 「创建窗口那一刻还拿不到工具服务」的主代理，以及没有映射的子代理。
        if (target.runtimeSurface && tools !== undefined) {
            applyToolSurface(logger, tools, agent, target.tools, target.label)
        }

        // SDK 声明正文（PTC 下模型唯一的工具知识来源）走的是另一条投递通道，
        // 视图收窄管不到它；按同一判据裁一道，让本层漏网工具连「能看」都不剩。
        let sdkRemovedNames: string[] = []
        if (tools !== undefined) {
            sdkRemovedNames = stripSdkSectionText(tools, agent, target.tools, next, target.label)
        }

        // 平台声明由 provider 在进瀑布之前按视图收齐、瀑布返回后又覆盖回产物里，所以数它
        // 只能读视图（瀑布收到的 `result` 里没有 tools）。
        let declaredCount = 0
        try {
            declaredCount = tools?.view(agent).visible?.size ?? 0

        } catch {
            // 视图读不到就报 0：这一行是排障信息，不该让它把装配带塌。
        }
        const declared = `平台声明 ${declaredCount} 条`

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
 * 主代理那套面的 label。
 *
 * 它是 `applyToolSurface` 幂等签名（`label + 0x00 + 策略`）的一半：`resolveTarget`
 * （装配期兜底）与 `mainSurfaceOf`（创建窗口 + 两个重挂点）必须给出**逐字相同**的字符串，
 * 差一个字就会被当成「面变了」反复重挂，restrict 跟着反复 dispose/apply。
 *
 * @param presetId - 该 agent 所在的预设 id。
 * @param agentId - 该预设绑定的主代理 id。
 * @returns 日志与幂等签名共用的 label。
 */
function mainSurfaceLabel(presetId: string | undefined, agentId: string | undefined): string {
    return `预设=${presetId} · 主代理=${agentId}`
}

/**
 * 该 agent 这次该用哪套面。
 *
 * 两个来源，按优先级：
 *
 *  1. **本插件派出去的子代理** —— 查映射表（`delegate.js` 在派活前写好）。命中即
 *     创建窗口已挂过工具面收窄，装配期只做段，所以 `runtimeSurface` 为假。
 *  2. **预设绑定的主代理** —— `bindings.presets` 里查。没绑定 = 不干预。
 *
 * 没有映射 ⇒ 退回预设绑定的主代理面（与官方 `subagent` 派出的子代理同面，这正是 v1
 * 就有的语义）。
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
    const isClaimedChild = agentId !== undefined
    let runtimeSurface = true

    if (isClaimedChild && isChildSession) {
        // 创建窗口已挂过工具面，装配期只做段。
        runtimeSurface = false
    }

    if (agentId === undefined) agentId = boundAgentId(config, presetId)

    const agentConfig = agentById(config, agentId)
    if (agentConfig === undefined) return undefined

    return {
        agentId,
        label: isClaimedChild
            ? `子代理=${agentId}`
            : mainSurfaceLabel(presetId, agentId),
        runtimeSurface,
        sections: mergeSections(config, agentConfig.promptSets),
        tools: toolPolicyOf(config, agentConfig.toolSets),
        skills: skillPolicyOf(config, agentConfig.skillSets),
    }
}

/**
 * 一个**主代理**此刻该被接管成什么样：工具名清单 + 这套面的 label。
 *
 * 三个提前挂点（创建窗口 / 配置变更 / 切预设）共用它，就是为了让 `applyToolSurface` 的
 * 幂等签名在三处逐字相同——label 各自拼一遍，装配期那次就会与创建窗口那次对不上，
 * 于是每次装配都整体重挂一遍。
 *
 * @param ctx - 插件所在的 context（预设解析要用 `agentPresets`）。
 * @param config - 插件配置。
 * @param agent - 目标主代理。
 * @returns 工具面；该主代理解析不出预设 / 没有绑定 / 代理已被删时 undefined（= 不接管）。
 */
function mainSurfaceOf(ctx: Ctx, config: StudioConfig | undefined, agent: Agent): { tools: SurfacePolicy; label: string } | undefined {
    const presetId = resolvePresetId(ctx, agent?.ctx)
    const agentId = boundAgentId(config, presetId)
    const agentConfig = agentById(config, agentId)
    if (agentConfig === undefined) return undefined

    return {
        tools: toolPolicyOf(config, agentConfig.toolSets),
        label: mainSurfaceLabel(presetId, agentId),
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
 * 在**创建窗口**给一个刚登记过的子代理挂工具面收窄。
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
 * @param label - 这套面属于谁，用于日志、拒绝原因与幂等签名。
 */
function applyToolSurface(logger: Logger, tools: ToolService, agent: Agent, policy: SurfacePolicy, label: string) {
    const applied = appliedSurfaces.get(agent)

    // 内容签名而不是引用比较：设置服务每次解析都给出新的快照对象，
    // 比引用会让每次装配都当成「配置变了」白重挂一遍。
    const signature = `${label}\u0000${policy.join('\u0000')}`
    if (applied !== undefined && applied.signature === signature) return

    withdrawToolSurface(agent)

    if (tools?.view === undefined || tools.restrict === undefined) return

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
    // 本层工具与晚注册的继承工具只能靠 guard 拦（声明层没有落点）。
    const deny = [...readRestrictableNames(tools, agent)].filter(isDenied)

    const agentCtx = agent.ctx as AgentScope
    const disposers: Array<() => void> = []

    mutatingSurfaces = true
    try {
        if (deny.length > 0) disposers.push(agentCtx.tools!.restrict({ deny }))
        disposers.push(agentCtx.tools!.guard(denyReason))

    } catch (err) {
        // 收窄失败只撤销收窄本身，段过滤照常生效——比整个改写退回要精细。
        for (const dispose of disposers) dispose()
        logger.warn?.(`[agent-studio] 工具面收窄失败，已退回不干预：${errText(err)}`)
        return

    } finally {
        mutatingSurfaces = false
    }

    appliedSurfaces.set(agent, { signature, disposers })
    logger.info?.(`[agent-studio] 已收窄 agent ${agent.id} 的工具面 · ${label} · 收起 ${deny.length} 个 · guard 兜底已挂`)
}

/**
 * 撤掉该 agent 已挂的工具面收窄。
 *
 * 两个去处都非撤不可：重挂前要先摘旧的（`restrict`/`guard` 之间是叠加语义，叠着挂会
 * 互相交集），绑定被解除后要撤得掉（否则「不干预」变成「按旧配置继续收」）。
 *
 * @param agent - 目标 agent，同时是收窄记表的键。
 */
function withdrawToolSurface(agent: Agent) {
    const applied = appliedSurfaces.get(agent)
    if (applied === undefined) return

    mutatingSurfaces = true
    try {
        for (const dispose of applied.disposers) dispose()

    } finally {
        mutatingSurfaces = false
    }

    appliedSurfaces.delete(agent)
    trace(`工具面撤回 · agent=${agent?.id ?? '无'}`)
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
 * 段不存在（清单里没点名 `tools:sdk`，或该预设没挂 PTC 执行器）时同样不动。
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
