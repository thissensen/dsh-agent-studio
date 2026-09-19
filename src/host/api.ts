
/**
 * host 半边的 HTTP 路由：面板读数据、写配置、管预设的唯一通路。
 *
 * 为什么需要它：面板要回答的「平台**实际**投递了什么」只存在于 host 进程内存里
 * （见 `observe.js` 里那个 `observations` Map），而写配置与建预设更是只有 host 进程
 * 才干得了的事，浏览器够不到。DSH 的 `webServer` 服务允许插件注册自己的前缀路由，
 * 这就是两者之间的桥。
 *
 * 路由本身不含安全判断：围栏与响应工具都在 `http-guard.js`，各端点的业务在
 * `presets.js` 与本文件。这样每个端点只写「这件事怎么办」，不必各自复述一遍边界。
 *
 * 这里的分发遵守一条：**读端点只过读围栏，写端点再过写围栏**。读围栏对所有请求统一生效，
 * 写围栏（自定义头 + JSON content-type）由各写处理函数自己再过一次。
 *
 * @module dsh-agent-studio/api
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { json, readJsonBody, validateMutationRequest, validateRequestOrigin } from './http-guard.js'
import { mechanismToolNames } from './apply.js'
import { cachedObservations } from './cache.js'
import { BUILTIN_PROMPT_VARIABLES, applyDefaultNames, findLoadConflict, validatePromptVariables } from './config.js'
import { handleListEfforts, handleListModels } from './models.js'
import { observedSessions, skillRowOf } from './observe.js'
import { handleCreatePreset, handleDeletePreset, handleListPresets } from './presets.js'
import type { Ctx, Logger, SettingsScope, StudioConfig } from './types.js'

// ── 本文件私有的宿主形状（宿主注入，精确契约见平台源码；够用即可）─────────────

/** 官方技能服务（主动读清单用）：`list(options)` 的 options 支持 `{ scope, cwd }` 两键。 */
interface LiveSkillService {
    list(options: unknown): Promise<unknown[]>
    [key: string]: unknown
}

/** 宿主 webServer 服务。 */
interface WebServerService {
    register(opts: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): void
    [key: string]: unknown
}

/** `mountApi` 与各端点的取值依赖。 */
interface ApiDeps {
    getScope: () => SettingsScope | undefined
    /** 设置服务本体（`presets.js` 清配置分区要用它的 `mutate`）。 */
    getSettings?: () => unknown
    getSkills?: () => unknown
    getPresets?: () => unknown
    /** 活 agent 名册（`/skills` 的「活 agent 视角」用它的 `list()`；见 `collectLiveSkills`）。 */
    getAgents?: () => unknown
    getLlm?: () => unknown
    trustedHosts?: string[]
}

/** 技能行：与 `observe.skillRowOf` 的返回同形状（面板候选与观察缓存共用）。 */
type SkillRow = ReturnType<typeof skillRowOf>

/** 两处迭代用到的「可观察快照」最小形状（实时会话 + 落盘缓存）。 */
interface ObservationLike {
    variables?: unknown
    skills?: unknown
}

/** 把异常转成可进日志的一行（保留「有 message 用 message、否则退回原值」的旧语义）。 */
function errText(err: unknown): string {
    const e = err as { message?: unknown } | null | undefined
    const message = e?.message
    return (message === undefined || message === null) ? String(err) : String(message)
}

/** 本插件的路由前缀。 */
const API_PREFIX = '/api/dsh-agent-studio'

/**
 * 平台已注册的插值变量名：内置三变量 + 观察到的（实时会话 + 磁盘缓存）。
 *
 * 观察里一次都没采到过变量（冷启动、还没跑过任何会话）时返回 undefined——
 * 那表示「清单不可用」，写入端点退回只做形状校验（见 `validatePromptVariables`）。
 *
 * @returns 变量名数组；清单不可用时 undefined。
 */
function knownPromptVariables(): string[] | undefined {
    const names = new Set(BUILTIN_PROMPT_VARIABLES)
    let seen = false

    const snapshots = [...observedSessions(), ...Object.values(cachedObservations())] as unknown as ObservationLike[]
    for (const snapshot of snapshots) {
        const variables = snapshot.variables as Record<string, unknown> | undefined
        if (variables === undefined) continue

        seen = true
        for (const name of Object.keys(variables)) names.add(name)
    }

    return seen ? [...names] : undefined
}

/**
 * 主动读技能清单：与**官方会话界面同路的两个视角**（活 agent 优先）。
 *
 * **为什么不是 `list({})`。** 技能发现 provider（`skill-filesystem` 等行）挂在**预设的
 * standing scope** 上，不在全局层；`list({})`（无 scope）只看全局层——部署里没有 provider，
 * 永远读出空清单（2026-09-17 真机实测：端点返回 `{"source":"live","skills":[]}`，而观察层
 * 在装配期采到过 3 个 skill）。
 *
 * **① 活 agent 视角（主路）。** 与官方 `SessionSkillCatalog`、装配期采集同款：
 * `agents.list()` 的每个活 agent，用**它自己的** scoped skills 服务
 * （`agentPresets.serviceFor(agent, 'skills')`——两者都是 typert 在案的公开面）+
 * `{ cwd, scope: agent }` 读。**按 agent 注册 provider 的技能**（如 `dsh-skills-manager`
 * 带来的 `~/.cc-switch/skills` 那批，source `agent-ccswitch`）只有这条路能看到；
 * 同时带上该 agent 会话的 `cwd`，项目级技能目录（`<cwd>/.agents/skills` 等）也一并读到。
 * `serviceFor` 拿不到（该 agent 的预设没挂 skills）时退回全局 skills 服务。
 *
 * **② 预设视角（没有活 agent 时的路由，如冷启动）。** 全走 `agentPresets` 的公开面：
 * `list()` 拿全部预设，逐个 `standingKeyFor(id)` 拿 scope key；`standingKeyFor` 的语义是
 * 「解析**或建立**」（内部 single-flight 的 `ensureStanding`）——官方 session-controller
 * 渲染技能目录走的就是它 ⇒ 顺带把尚未挂载的预设挂上是平台认可的读法（挂失败的会被平台
 * 自行摘掉、之后重试）。破损（`broken`）预筛跳过、每个最多等 800ms。
 *
 * 两个视角**取并集**（按名字去重；单条读失败不影响其它来源）。一条路都走不通时返回
 * undefined（和「确实是空清单」区分开——调用方会继续回退缓存）。
 *
 * @param deps - `{ getSkills, getPresets, getAgents }`。
 * @returns 合并去重后的技能行。
 */
async function collectLiveSkills(deps: ApiDeps): Promise<SkillRow[] | undefined> {
    const skills = deps.getSkills?.() as LiveSkillService | undefined
    if (skills?.list === undefined) return undefined

    const delay = (毫秒: number) => new Promise((resolve) => setTimeout(resolve, 毫秒))
    const presets = deps.getPresets?.() as {
        list?: () => Promise<unknown>
        standingKeyFor?: (id: string) => Promise<unknown>
        serviceFor?: (agent: unknown, name: string) => unknown
    } | undefined
    const agents = deps.getAgents?.() as { list?: () => unknown } | undefined
    /** 待读组：同一个 skills 服务接口、不同的 options（agent 视角带 cwd，预设视角只带 scope）。 */
    const 读取目标组: Array<{ service: LiveSkillService; options: Record<string, unknown> }> = []

    // ① 活 agent 视角：有没有 agent、读没读到都不影响下面预设视角的兜底。
    const agentList = typeof agents?.list === 'function' ? agents.list() : []
    for (const agent of Array.isArray(agentList) ? agentList : []) {
        const scoped = (presets?.serviceFor?.(agent, 'skills') ?? skills) as LiveSkillService | undefined
        if (scoped?.list === undefined) continue

        const cwd = (agent as { session?: { header?: { cwd?: unknown } } } | undefined)?.session?.header?.cwd
        读取目标组.push({
            service: scoped,
            options: typeof cwd === 'string' && cwd !== '' ? { cwd, scope: agent } : { scope: agent },
        })
    }

    // ② 预设视角。
    if (typeof presets?.list === 'function' && typeof presets.standingKeyFor === 'function') {
        let list: unknown = []
        try {
            list = await presets.list()

        } catch {
            // 列不出预设（服务异常）：当作「一个 scope 都没有」，退回全局视角。
            list = []
        }

        for (const preset of Array.isArray(list) ? list : []) {
            const row = preset as { id?: unknown; broken?: unknown }
            // 破损的预设必抛（`resolveMountable` 的语义）——从清单里就跳过。
            if (typeof row.id !== 'string' || row.broken !== undefined) continue

            try {
                // 首次挂载可能慢；给每个最多 800ms，卡住/失败就跳过。
                const key = await Promise.race([presets.standingKeyFor(row.id), delay(800)])
                if (key !== undefined) 读取目标组.push({ service: skills, options: { scope: key } })

            } catch {
                // 挂载失败的预设跳过，不影响其它预设的读取。
            }
        }
    }

    // 一个来源都没有（两个服务都缺席）时退回全局视图——多数部署读出来是空，
    // 但至少不把「无 scope」当成硬错误；调用方拿到空列表会继续回退缓存。
    if (读取目标组.length === 0) 读取目标组.push({ service: skills, options: {} })

    const merged = new Map<string, SkillRow>()
    let reached = false

    for (const 目标 of 读取目标组) {
        try {
            const list = await 目标.service.list(目标.options)
            if (!Array.isArray(list)) continue
            reached = true

            for (const skill of list) {
                const s = skill as { name?: string }
                if (typeof s?.name !== 'string' || merged.has(s.name)) continue
                merged.set(s.name, skillRowOf(skill as Parameters<typeof skillRowOf>[0]))
            }

        } catch {
            // 单个来源读失败不影响其它来源。
        }
    }

    return reached ? [...merged.values()] : undefined
}

/** 从落盘的观察结果里收技能行（按名字去重，跨预设合并）。 */
function cachedSkillRows(): SkillRow[] {
    const rows: SkillRow[] = []
    const seen = new Set<string>()

    const snapshots = [...observedSessions(), ...Object.values(cachedObservations())] as unknown as ObservationLike[]
    for (const snapshot of snapshots) {
        const skills = (snapshot.skills ?? []) as Array<{ name?: string }>
        for (const skill of skills) {
            const s = skill as { name?: string }
            if (typeof s?.name !== 'string' || seen.has(s.name)) continue
            seen.add(s.name)
            rows.push(skillRowOf(skill as Parameters<typeof skillRowOf>[0]))
        }
    }

    return rows
}

/**
 * 「技能集」候选清单：**主动**问官方技能服务，不等任何对话。
 *
 * 顺序：预设视角的直读（`collectLiveSkills`）→ 观察缓存（装配期采到的那份，按预设）。
 * 直读拿到非空就当场返回；拿不到（或读到空）就退缓存——面板在冷启动、技能服务缺席、
 * 预设还没挂载这些情况下都能列出候选（或如实列出空清单），而不是一片空白。
 *
 * @param res - Node 的响应对象。
 * @param deps - `{ getSkills, getPresets }`。
 */
async function handleListSkills(res: ServerResponse, deps: ApiDeps): Promise<void> {
    const live = await collectLiveSkills(deps)
    if (live !== undefined && live.length > 0) {
        json(res, 200, { ok: true, source: 'live', skills: live })
        return
    }

    const cached = cachedSkillRows()
    json(res, 200, {
        ok: true,
        source: cached.length > 0 ? 'cache' : 'live',
        skills: cached.length > 0 ? cached : live ?? [],
    })
}

/**
 * 伺服用 client 侧的「部件」脚本（拆分后 panel.js 这类运行时加载的文件）。
 *
 * 只认白名单形状的文件名（`[a-z0-9-]+.js`，防目录穿越）；**每次请求都读盘**，所以
 * 改完部件刷新页面即生效——不必重启 DSH（主 bundle 仍受启动快照约束）。读盘失败
 * 回 404，壳那边会把它显示成「界面模块加载失败」的可重试卡片。
 *
 * @param res - Node 的响应对象。
 * @param partName - 路由里 `client-parts/` 后面那一段。
 */
function handleClientPart(res: ServerResponse, partName: string): void {
    if (!/^[a-z0-9-]+\.js$/.test(partName)) {
        json(res, 404, { ok: false, error: `unknown client part: ${partName}` })
        return
    }

    let source: string | undefined
    try {
        source = readFileSync(fileURLToPath(new URL(`../client/parts/${partName}`, import.meta.url)), 'utf8')

    } catch {
        json(res, 404, { ok: false, error: `client part not found: ${partName}` })
        return
    }

    res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
    })
    res.end(source as string)
}

/**
 * 处理「改三个池与绑定」这个写操作。
 *
 * 写入落在**用户层**：设置服务把 patch 深合并进用户分节并持久化，不碰宿主的
 * 组合配置——这正是插件「不写宿主预设文件」那条立身之本的落地方式。
 *
 * 合并语义（`mergeLayers`）是「对象递归、**数组整体替换**、`undefined` 跳过」，
 * 而三个池与 `bindings.presets` 全是数组，所以要求**四件套一起给全**：界面每次
 * 发的就是一份完整快照，整体替换天然支持增删与重排（合并写删不掉数组元素）。
 *
 * 装载重叠校验（同名段 / 同工具不许跨集重叠）在这里是防线：界面装载那一刻已经
 * 拦过一次，但手改配置文件、老客户端都得在这里被拦住。
 *
 * @param req - Node 的请求对象。
 * @param res - Node 的响应对象。
 * @param deps - `{ getScope, trustedHosts }`；`getScope()` 在服务未就绪时返回 undefined。
 */
async function handleConfigUpdate(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<void> {
    const requestError = validateMutationRequest(req, deps.trustedHosts as unknown[])
    if (requestError !== null) {
        json(res, requestError.statusCode, { ok: false, error: requestError.error })
        return
    }

    const scope = deps.getScope()
    if (scope === undefined) {
        json(res, 503, { ok: false, error: '设置服务未就绪，暂时不能写入' })
        return
    }

    // 体流是唯一会「以异常代替返回值」的一段：畸形 JSON（400）、超大 body（413）。
    // 必须就地接住——HTTP handler 就是这条链的最外层边界，漏出去响应就永远不回。
    let body: {
        agents?: unknown
        promptSets?: unknown
        toolSets?: unknown
        bindings?: unknown
        skillSets?: unknown
        runtimeContextOff?: unknown
    } | undefined
    try {
        body = await readJsonBody(req) as typeof body

    } catch (err) {
        const e = err as { statusCode?: number }
        json(res, e.statusCode ?? 400, { ok: false, error: `请求体读取失败：${errText(err)}` })
        return
    }

    const patch: {
        agents?: unknown
        promptSets?: unknown
        toolSets?: unknown
        bindings?: unknown
        skillSets?: unknown
        runtimeContextOff?: unknown
    } = {
        agents: body?.agents,
        promptSets: body?.promptSets,
        toolSets: body?.toolSets,
        bindings: body?.bindings,
    }

    // 后加的两个键是**可选**的：老客户端不发就保持原值（合并写跳过 undefined），
    // 新客户端总是发全——不用「必须一起给全」卡它们，是因为它们不参与四件套的
    // 「整体替换」关系（skillSets 是独立池、runtimeContextOff 是预设名单）。
    if (body?.skillSets !== undefined) patch.skillSets = body.skillSets
    if (body?.runtimeContextOff !== undefined) patch.runtimeContextOff = body.runtimeContextOff

    if (patch.agents === undefined || patch.promptSets === undefined
        || patch.toolSets === undefined || patch.bindings === undefined) {
        json(res, 400, { ok: false, error: 'agents、promptSets、toolSets、bindings 必须一起给全' })
        return
    }

    // 空名兜底：面板新建时就会预填默认名，这里是防线（手改配置、老客户端）。
    // 规则与面板、投递端同源（`config.js` 的 `applyDefaultNames`）。
    const normalized = applyDefaultNames(patch as StudioConfig)

    const conflict = findLoadConflict(normalized)
    if (conflict !== undefined) {
        json(res, 400, { ok: false, error: conflict })
        return
    }

    // 插值变量校验：段里的 `{{名字}}` 写错（形状不合法 / 平台没注册）会让那一次
    // 请求在渲染期直接抛错，所以在这里先拦；清单不可用时只拦形状、其余收成警告。
    const variableCheck = validatePromptVariables(normalized, knownPromptVariables())
    if (variableCheck.error !== undefined) {
        json(res, 400, { ok: false, error: variableCheck.error })
        return
    }

    // schema 校验不通过、提供方只读之类都是「请求本身的问题」，回 4xx 让面板能显示原因；
    // 这里不吞掉信息，但也不让它变成未捕获异常。
    try {
        await scope.update(normalized)

    } catch (err) {
        json(res, 400, { ok: false, error: `写入失败：${errText(err)}` })
        return
    }

    const warnings = variableCheck.unconfirmed!.length > 0
        ? [`这些插值变量还没被观察到过，确认它们由某个插件注册再用：${variableCheck.unconfirmed!.join('、')}`]
        : []

    json(res, 200, { ok: true, warnings })
}

/**
 * 挂上本插件的 HTTP 路由。
 *
 * 需要 `webServer`（注册路由）与 `webRuntime`（取信任主机清单）两个服务。
 *
 * @param ctx - 插件所在的 context。
 * @param logger - 用于报错的 logger。
 * @param deps - `{ getScope, getPresets, getSkills }` 三个「现问现取」的取值函数：
 *   两个服务在别的注入回调里就绪，而回调先后顺序不作保证，所以路由拿取值函数而不是
 *   现成的对象。`getSkills` 是「技能集候选主动读取」的来源（官方技能服务）。
 */
export function mountApi(ctx: Ctx, logger: Logger, deps: ApiDeps): void {
    const webRuntime = ctx.webRuntime as { trustedHosts?: unknown } | undefined
    const trustedHosts: string[] = Array.isArray(webRuntime?.trustedHosts)
        ? (webRuntime?.trustedHosts as string[])
        : []
    const requestDeps: ApiDeps = { ...deps, trustedHosts }

    const webServer = ctx.webServer as WebServerService | undefined
    webServer?.register({
        kind: 'prefix',
        path: API_PREFIX,

        handler: async (req: IncomingMessage, res: ServerResponse) => {
            const url = new URL(req.url ?? '/', 'http://localhost')
            const path = url.pathname.replace(/\/+$/, '')

            const hostError = validateRequestOrigin(req, trustedHosts)
            if (hostError !== null) {
                json(res, hostError.statusCode, { ok: false, error: hostError.error })
                return
            }

            if (req.method === 'GET' && path === `${API_PREFIX}/observation`) {
                // 三份一起给：`sessions` 是这次进程里采到的，`cached` 是上次留下的（按预设），
                // `mechanismTools` 是永远不受工具集收窄的机制工具（面板据此标出「始终放行」）。
                // 面板优先用第一份，没有就退回第二份——工具名只在装配期存在，冷启动时只有它能把候选列全。
                json(res, 200, {
                    ok: true,
                    sessions: observedSessions(),
                    cached: cachedObservations(),
                    mechanismTools: mechanismToolNames(),
                })
                return
            }

            if (req.method === 'GET' && path === `${API_PREFIX}/config`) {
                json(res, 200, { ok: true, config: deps.getScope()?.get() ?? null })
                return
            }

            if (req.method === 'GET' && path === `${API_PREFIX}/skills`) {
                await handleListSkills(res, requestDeps)
                return
            }

            if (req.method === 'GET' && path.startsWith(`${API_PREFIX}/client-parts/`)) {
                handleClientPart(res, path.slice(`${API_PREFIX}/client-parts/`.length))
                return
            }

            if (req.method === 'GET' && path === `${API_PREFIX}/presets`) {
                await handleListPresets(res, requestDeps as unknown as Parameters<typeof handleListPresets>[1])
                return
            }

            if (req.method === 'GET' && path === `${API_PREFIX}/models`) {
                await handleListModels(res, requestDeps as unknown as Parameters<typeof handleListModels>[1])
                return
            }

            if (req.method === 'GET' && path === `${API_PREFIX}/models/efforts`) {
                await handleListEfforts(req, res, requestDeps as unknown as Parameters<typeof handleListEfforts>[2])
                return
            }

            if (req.method === 'POST' && path === `${API_PREFIX}/config`) {
                await handleConfigUpdate(req, res, requestDeps)
                return
            }

            if (req.method === 'POST' && path === `${API_PREFIX}/presets/create`) {
                await handleCreatePreset(req, res, requestDeps as unknown as Parameters<typeof handleCreatePreset>[2])
                return
            }

            if (req.method === 'POST' && path === `${API_PREFIX}/presets/delete`) {
                await handleDeletePreset(req, res, requestDeps as unknown as Parameters<typeof handleDeletePreset>[2])
                return
            }

            json(res, 404, { ok: false, error: `unknown action: ${req.method} ${path}` })
        },
    })

    logger.info?.(`[agent-studio] HTTP 路由已挂上 · ${API_PREFIX}`)
}
