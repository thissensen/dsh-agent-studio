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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { json, readJsonBody, validateMutationRequest, validateRequestOrigin } from './http-guard.js';
import { cachedObservations } from './cache.js';
import { BUILTIN_PROMPT_VARIABLES, applyDefaultNames, findLoadConflict, validatePromptVariables } from './config.js';
import { handleListEfforts, handleListModels } from './models.js';
import { observedSessions, ownersFor, skillRowOf } from './observe.js';
import { resolvePresetId } from './preset.js';
import { handleCreatePreset, handleDeletePreset, handleListPresets } from './presets.js';
/** 把异常转成可进日志的一行（保留「有 message 用 message、否则退回原值」的旧语义）。 */
function errText(err) {
    const e = err;
    const message = e?.message;
    return (message === undefined || message === null) ? String(err) : String(message);
}
/** 本插件的路由前缀。 */
const API_PREFIX = '/api/dsh-agent-studio';
/**
 * 等一会儿（毫秒）：两个「实时读」的视角都拿它给作用域租约挂超时，
 * 挂载卡住时不能让端点跟着卡死。
 * @param 毫秒 - 等待时长。
 */
function delay(毫秒) {
    return new Promise((resolve) => setTimeout(resolve, 毫秒));
}
/**
 * 平台已注册的插值变量名：内置三变量 + 观察到的（实时会话 + 磁盘缓存）。
 *
 * 观察里一次都没采到过变量（冷启动、还没跑过任何会话）时返回 undefined——
 * 那表示「清单不可用」，写入端点退回只做形状校验（见 `validatePromptVariables`）。
 *
 * @returns 变量名数组；清单不可用时 undefined。
 */
function knownPromptVariables() {
    const names = new Set(BUILTIN_PROMPT_VARIABLES);
    let seen = false;
    const snapshots = [...observedSessions(), ...Object.values(cachedObservations())];
    for (const snapshot of snapshots) {
        const variables = snapshot.variables;
        if (variables === undefined)
            continue;
        seen = true;
        for (const name of Object.keys(variables))
            names.add(name);
    }
    return seen ? [...names] : undefined;
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
 * `list()` 拿全部预设，逐个 `acquireScope(id)` 拿作用域租约；`acquireScope` 的语义是
 * 「解析**或建立**」（与官方 session-controller 渲染技能目录同路）——官方 session-controller
 * 渲染技能目录走的就是它 ⇒ 顺带把尚未挂载的预设挂上是平台认可的读法（挂失败的会被平台
 * 自行摘掉、之后重试）。破损（`broken`）预筛跳过、每个最多等 800ms。
 * **租约必须在读完那份作用域之后再释放**（提前释放会让 key 失效），所以释放函数跟着
 * 读取目标一起走，见下面那个 `finally`。
 *
 * 两个视角**取并集**（按名字去重；单条读失败不影响其它来源）。一条路都走不通时返回
 * undefined（和「确实是空清单」区分开——调用方会继续回退缓存）。
 *
 * @param deps - `{ getSkills, getPresets, getAgents }`。
 * @returns 合并去重后的技能行。
 */
async function collectLiveSkills(deps) {
    const skills = deps.getSkills?.();
    if (skills?.list === undefined)
        return undefined;
    const presets = deps.getPresets?.();
    const agents = deps.getAgents?.();
    /** 待读组：同一个 skills 服务接口、不同的 options（agent 视角带 cwd，预设视角只带 scope）。 */
    const 读取目标组 = [];
    // ① 活 agent 视角：有没有 agent、读没读到都不影响下面预设视角的兜底。
    const agentList = typeof agents?.list === 'function' ? agents.list() : [];
    for (const agent of Array.isArray(agentList) ? agentList : []) {
        const scoped = (presets?.serviceFor?.(agent, 'skills') ?? skills);
        if (scoped?.list === undefined)
            continue;
        const cwd = agent?.session?.header?.cwd;
        读取目标组.push({
            service: scoped,
            options: typeof cwd === 'string' && cwd !== '' ? { cwd, scope: agent } : { scope: agent },
        });
    }
    // ② 预设视角。
    if (typeof presets?.list === 'function' && typeof presets.acquireScope === 'function') {
        let list = [];
        try {
            list = await presets.list();
        }
        catch {
            // 列不出预设（服务异常）：当作「一个 scope 都没有」，退回全局视角。
            list = [];
        }
        for (const preset of Array.isArray(list) ? list : []) {
            const row = preset;
            // 破损的预设必抛（`resolveMountable` 的语义）——从清单里就跳过。
            if (typeof row.id !== 'string' || row.broken !== undefined)
                continue;
            try {
                // 首次挂载可能慢；给每个最多 800ms，卡住/失败就跳过。
                const lease = await Promise.race([presets.acquireScope(row.id), delay(800)]);
                if (lease?.key === undefined)
                    continue;
                读取目标组.push({
                    service: skills,
                    options: { scope: lease.key },
                    释放: async () => {
                        const release = lease[Symbol.asyncDispose];
                        if (typeof release === 'function')
                            await release.call(lease);
                    },
                });
            }
            catch {
                // 挂载失败的预设跳过，不影响其它预设的读取。
            }
        }
    }
    // 一个来源都没有（两个服务都缺席）时退回全局视图——多数部署读出来是空，
    // 但至少不把「无 scope」当成硬错误；调用方拿到空列表会继续回退缓存。
    if (读取目标组.length === 0)
        读取目标组.push({ service: skills, options: {} });
    const merged = new Map();
    let reached = false;
    for (const 目标 of 读取目标组) {
        try {
            const list = await 目标.service.list(目标.options);
            if (!Array.isArray(list))
                continue;
            reached = true;
            for (const skill of list) {
                const s = skill;
                if (typeof s?.name !== 'string' || merged.has(s.name))
                    continue;
                merged.set(s.name, skillRowOf(skill));
            }
        }
        catch {
            // 单个来源读失败不影响其它来源。
        }
        finally {
            // 作用域租约读完即还：租约活着，那份 revision 就不回收。
            await 目标.释放?.();
        }
    }
    return reached ? [...merged.values()] : undefined;
}
/**
 * 按顺序并集：先出现的先留，重复的丢掉（`Set` 的插入顺序就是首次出现的顺序）。
 *
 * @param groups - 各组名字，数组顺序即优先级。
 * @returns 去重后的名字。
 */
function unionNames(groups) {
    const merged = new Set();
    for (const names of groups) {
        for (const name of names ?? [])
            merged.add(name);
    }
    return [...merged];
}
/**
 * 读一个 scope 的工具面（名字三集合）。
 *
 * `view(scope)` 的参数是 scope key；同一次读里 `visible` 是 Map（名字 → 定义），
 * 取名字必须走 `keys()`。
 *
 * @param tools - 官方工具服务。
 * @param scope - 要读的 scope key（agent 对象，或预设 standing scope 的 key）。
 * @returns 三集合；读不到时 undefined。
 */
function readToolNames(tools, scope) {
    try {
        const view = tools.view(scope);
        if (view?.visible === undefined)
            return undefined;
        return {
            visible: [...view.visible.keys()],
            known: view.knownNames === undefined ? [] : [...view.knownNames],
            restrictable: view.restrictableNames === undefined ? [] : [...view.restrictableNames],
        };
    }
    catch {
        // 该 scope 的视图读不出来（如 PTC 预设缺 ptcRuntime）：跳过这一个来源，不影响别的。
        return undefined;
    }
}
/**
 * 实时读某个预设的工具面：与官方界面同路的两个视角（活 agent 优先，预设兜底）。
 *
 * **为什么能实时读。** 官方 `agentPresets.register()` **注册即激活**整棵预设树
 * （`dsh-agent-preset-registry/lib/index.js` 的 `activate`/`acquireScope`），
 * `acquireScope(id)` 于是能拿到该预设 standing scope 的 key；把这个 key 交给
 * `tools.view()`（`dsh-tools/lib/index.js`）读出来的就是该预设此刻的工具面——
 * 不必等任何一个会话先跑起来。
 *
 * **① 活 agent 视角。** `agents.list()` 的每个 agent，先用 `resolvePresetId` 判它跑在
 * 哪个预设上（出生预设不可信，见 `preset.js`），是目标预设的就 `tools.view(agent)`——
 * 对 agent 而言 agent 对象本身就是 scope key（与 `apply.ts` 的 `view(agent)` 同源）。
 *
 * **② 预设视角。** `acquireScope(presetId)` 的语义是「解析**或建立**」，所以没有活
 * agent 时也能读（冷启动就是这个场景）。读失败跳过、不影响另一个视角：破损预设
 * （`agent-preset/invalid`）会让 `acquireScope` 抛，PTC 预设缺 `ptcRuntime` 会让
 * `view` 抛。租约必须在读完那份作用域**之后**再释放（提前释放会让 key 失效），
 * 所以释放跟着读取目标一起走，见下面那个 `finally`。
 *
 * 两个视角的三集合**取并集**（保序去重）；`reachable` 记并集后的 `visible`——它的语义
 * 是「本插件收窄之前的平台面」，此时本插件的 `restrict()` 还没生效，两者同源。
 * `owners` 走观察层同一份归因表。一条路都读不到时返回 undefined（调用方回退缓存）。
 *
 * @param deps - `{ getTools, getPresets, getAgents, getOwnerOf }`。
 * @param presetId - 要读的预设 id。
 * @param ctx - 插件所在的 context（`resolvePresetId` 要查 `agentPresets`）。
 * @returns 五个键的工具事实；两个视角都读不到时 undefined。
 */
async function collectLiveTools(deps, presetId, ctx) {
    const tools = deps.getTools?.();
    if (typeof tools?.view !== 'function')
        return undefined;
    const presets = deps.getPresets?.();
    const agents = deps.getAgents?.();
    /** 待读组：scope key + 读完要还的租约（只有预设视角有）。 */
    const 读取目标组 = [];
    // ① 活 agent 视角：按「这个 agent 跑在哪个预设上」筛，只读目标预设的那几个。
    const agentList = typeof agents?.list === 'function' ? agents.list() : [];
    for (const agent of Array.isArray(agentList) ? agentList : []) {
        const agentCtx = agent?.ctx;
        if (resolvePresetId(ctx, agentCtx) !== presetId)
            continue;
        读取目标组.push({ scope: agent });
    }
    // ② 预设视角：注册即激活 ⇒ 直接拿 standing scope 的 key。
    if (typeof presets?.acquireScope === 'function') {
        try {
            // 首次挂载可能慢；给最多 800ms，卡住就当作这个视角读不到。
            const lease = await Promise.race([presets.acquireScope(presetId), delay(800)]);
            if (lease?.key !== undefined) {
                读取目标组.push({
                    scope: lease.key,
                    释放: async () => {
                        const release = lease[Symbol.asyncDispose];
                        if (typeof release === 'function')
                            await release.call(lease);
                    },
                });
            }
        }
        catch {
            // 破损预设挂不上：整个预设视角跳过，活 agent 视角照旧。
        }
    }
    const 读数组 = [];
    for (const 目标 of 读取目标组) {
        try {
            const names = readToolNames(tools, 目标.scope);
            if (names !== undefined)
                读数组.push(names);
        }
        finally {
            // 作用域租约读完即还：租约活着，那份 revision 就不回收。
            await 目标.释放?.();
        }
    }
    if (读数组.length === 0)
        return undefined;
    const visible = unionNames(读数组.map((读数) => 读数.visible));
    const known = unionNames(读数组.map((读数) => 读数.known));
    const restrictable = unionNames(读数组.map((读数) => 读数.restrictable));
    return {
        visible,
        known,
        restrictable,
        reachable: visible,
        owners: ownersFor(unionNames([visible, known, restrictable]), deps.getOwnerOf) ?? {},
    };
}
/** 从落盘的观察结果里收技能行（按名字去重，跨预设合并）。 */
function cachedSkillRows() {
    const rows = [];
    const seen = new Set();
    const snapshots = [...observedSessions(), ...Object.values(cachedObservations())];
    for (const snapshot of snapshots) {
        const skills = (snapshot.skills ?? []);
        for (const skill of skills) {
            const s = skill;
            if (typeof s?.name !== 'string' || seen.has(s.name))
                continue;
            seen.add(s.name);
            rows.push(skillRowOf(skill));
        }
    }
    return rows;
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
async function handleListSkills(res, deps) {
    const live = await collectLiveSkills(deps);
    if (live !== undefined && live.length > 0) {
        json(res, 200, { ok: true, source: 'live', skills: live });
        return;
    }
    const cached = cachedSkillRows();
    json(res, 200, {
        ok: true,
        source: cached.length > 0 ? 'cache' : 'live',
        skills: cached.length > 0 ? cached : live ?? [],
    });
}
/**
 * 「工具集」候选清单：**实时**读该预设的工具面，读不到就回退观察缓存。
 *
 * 实时读数由 `collectLiveTools` 给（预设注册即激活，不必先对话一次）。读不到的那些
 * 情况——工具服务缺席、预设破损、挂载超时——退回装配期留在盘上的那份；连缓存都没有时
 * 给出五个空集合：面板照常打开、候选区就是空的，不是白屏也不是 500。
 *
 * 响应永远带五个键（`visible` / `known` / `restrictable` / `reachable` / `owners`），
 * 面板不用分情况。
 *
 * @param res - Node 的响应对象。
 * @param presetId - 查询串里的预设 id（调用方已确认非空）。
 * @param deps - `{ getTools, getPresets, getAgents, getOwnerOf }`。
 * @param ctx - 插件所在的 context。
 */
async function handleListTools(res, presetId, deps, ctx) {
    const live = await collectLiveTools(deps, presetId, ctx);
    if (live !== undefined) {
        json(res, 200, { ok: true, source: 'live', tools: live });
        return;
    }
    const cached = cachedObservations()[presetId]?.tools;
    json(res, 200, {
        ok: true,
        source: 'cache',
        tools: {
            visible: cached?.visible ?? [],
            known: cached?.known ?? [],
            restrictable: cached?.restrictable ?? [],
            reachable: cached?.reachable ?? [],
            owners: cached?.owners ?? {},
        },
    });
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
function handleClientPart(res, partName) {
    if (!/^[a-z0-9-]+\.js$/.test(partName)) {
        json(res, 404, { ok: false, error: `unknown client part: ${partName}` });
        return;
    }
    let source;
    try {
        source = readFileSync(fileURLToPath(new URL(`../client/parts/${partName}`, import.meta.url)), 'utf8');
    }
    catch {
        json(res, 404, { ok: false, error: `client part not found: ${partName}` });
        return;
    }
    res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
    });
    res.end(source);
}
/**
 * 写端点的公共围栏：拦住就写好拒绝响应并返回 true，调用方当场 return。
 *
 * 抽出来只为让两个写端点用同一套判据（trustedHosts 的转型与 bindHost 的透传都在这里
 * 照旧传下去），不是新加的一层业务。
 *
 * @param req - Node 的请求对象。
 * @param res - Node 的响应对象。
 * @param deps - `{ trustedHosts, bindHost }`；两者都参与围栏判据。
 * @returns true 表示已经回了拒绝响应。
 */
function guardMutationRequest(req, res, deps) {
    const requestError = validateMutationRequest(req, deps.trustedHosts, deps.bindHost);
    if (requestError === null)
        return false;
    json(res, requestError.statusCode, { ok: false, error: requestError.error });
    return true;
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
 * 拦过一次，但直接改配置或直接调 API 的调用方都得在这里被拦住。
 *
 * @param req - Node 的请求对象。
 * @param res - Node 的响应对象。
 * @param deps - `{ getScope, trustedHosts, bindHost }`；`getScope()` 在服务未就绪时返回 undefined。
 */
async function handleConfigUpdate(req, res, deps) {
    if (guardMutationRequest(req, res, deps))
        return;
    const scope = deps.getScope();
    if (scope === undefined) {
        json(res, 503, { ok: false, error: '设置服务未就绪，暂时不能写入' });
        return;
    }
    // 体流是唯一会「以异常代替返回值」的一段：畸形 JSON（400）、超大 body（413）。
    // 必须就地接住——HTTP handler 就是这条链的最外层边界，漏出去响应就永远不回。
    let body;
    try {
        body = await readJsonBody(req);
    }
    catch (err) {
        const e = err;
        json(res, e.statusCode ?? 400, { ok: false, error: `请求体读取失败：${errText(err)}` });
        return;
    }
    const patch = {
        agents: body?.agents,
        promptSets: body?.promptSets,
        toolSets: body?.toolSets,
        bindings: body?.bindings,
    };
    // 后加的两个键是**可选**的：直接改配置或直接调 API 的调用方不发就保持原值（合并写跳过
    // undefined），面板总是发全——不用「必须一起给全」卡它们，是因为它们不参与四件套的
    // 「整体替换」关系（skillSets 是独立池、runtimeContextOff 是预设名单）。
    if (body?.skillSets !== undefined)
        patch.skillSets = body.skillSets;
    if (body?.runtimeContextOff !== undefined)
        patch.runtimeContextOff = body.runtimeContextOff;
    if (patch.agents === undefined || patch.promptSets === undefined
        || patch.toolSets === undefined || patch.bindings === undefined) {
        json(res, 400, { ok: false, error: 'agents、promptSets、toolSets、bindings 必须一起给全' });
        return;
    }
    // 空名兜底：面板新建时就会预填默认名，这里是防线（直接改配置或直接调 API 的调用方）。
    // 规则与面板、投递端同源（`config.js` 的 `applyDefaultNames`）。
    const normalized = applyDefaultNames(patch);
    const conflict = findLoadConflict(normalized);
    if (conflict !== undefined) {
        json(res, 400, { ok: false, error: conflict });
        return;
    }
    // 插值变量校验：段里的 `{{名字}}` 写错（形状不合法 / 平台没注册）会让那一次
    // 请求在渲染期直接抛错，所以在这里先拦；清单不可用时只拦形状、其余收成警告。
    const variableCheck = validatePromptVariables(normalized, knownPromptVariables());
    if (variableCheck.error !== undefined) {
        json(res, 400, { ok: false, error: variableCheck.error });
        return;
    }
    // schema 校验不通过、提供方只读之类都是「请求本身的问题」，回 4xx 让面板能显示原因；
    // 这里不吞掉信息，但也不让它变成未捕获异常。
    try {
        await scope.update(normalized);
    }
    catch (err) {
        json(res, 400, { ok: false, error: `写入失败：${errText(err)}` });
        return;
    }
    const warnings = variableCheck.unconfirmed.length > 0
        ? [`这些插值变量还没被观察到过，确认它们由某个插件注册再用：${variableCheck.unconfirmed.join('、')}`]
        : [];
    json(res, 200, { ok: true, warnings });
}
/**
 * 处理「主页面挂不挂面板」这个界面偏好的写操作。
 *
 * patch 里只带 `mountMainPage` 一个键：三个池与 `version` 归 `/config` 端点，混进来会让
 * 一次开关切换变成一份配置快照的整体替换（数组整体替换语义），误伤用户正在编辑的池。
 *
 * @param req - Node 的请求对象。
 * @param res - Node 的响应对象。
 * @param deps - `{ getScope, trustedHosts, bindHost }`；`getScope()` 在服务未就绪时返回 undefined。
 */
async function handleUiUpdate(req, res, deps) {
    if (guardMutationRequest(req, res, deps))
        return;
    const scope = deps.getScope();
    if (scope === undefined) {
        json(res, 503, { ok: false, error: '设置服务未就绪，暂时不能写入' });
        return;
    }
    // 体流是唯一会「以异常代替返回值」的一段：畸形 JSON（400）、超大 body（413）。
    // 必须就地接住——HTTP handler 就是这条链的最外层边界，漏出去响应就永远不回。
    let body;
    try {
        body = await readJsonBody(req);
    }
    catch (err) {
        const e = err;
        json(res, e.statusCode ?? 400, { ok: false, error: `请求体读取失败：${errText(err)}` });
        return;
    }
    // 只认真正的布尔：字符串 "true" 在合并写里会被平台当非法值拒掉，早点回人话。
    const mountMainPage = body?.mountMainPage;
    if (typeof mountMainPage !== 'boolean') {
        json(res, 400, { ok: false, error: 'mountMainPage 必须是布尔值' });
        return;
    }
    try {
        await scope.update({ mountMainPage });
    }
    catch (err) {
        json(res, 400, { ok: false, error: `写入失败：${errText(err)}` });
        return;
    }
    json(res, 200, { ok: true, mountMainPage });
}
/**
 * 挂上本插件的 HTTP 路由。
 *
 * 只需要 `webServer`（注册路由）。信任主机清单走**取值式**，它在 `webStartup.trustedHosts`
 * 上——凭据：`<DSH 安装目录>/node_modules/@deepseek-ai/dsh-web-app/lib/startup.js:19`
 * （`const WEB_STARTUP_SERVICE = "webStartup"`）与 `:61-67`
 * （`ctx.provide(WEB_STARTUP_SERVICE, { …, trustedHosts: options.trustedHost ?? [] })`）。
 * 取不到就按空清单处理——影响面只是「用户显式信任的 authority」那一档，不阻塞路由挂载。
 *
 * 围栏与平台同口径：放行只有三档——回环、信任清单、**监听器绑定地址本身**（任意端口）；
 * 平台自己的 /api 围栏就是这么判的（见 `http-guard.ts` 的 `isBindAddressAuthority`），
 * 少了这一档，web 服务绑到具体本机 IP 时平台界面正常、本插件面板整片 403。
 *
 * @param ctx - 插件所在的 context。
 * @param logger - 用于报错的 logger。
 * @param deps - `{ getScope, getPresets, getSkills, getTools, getOwnerOf }` 这几个
 *   「现问现取」的取值函数：服务在别的注入回调里就绪，而回调先后顺序不作保证，所以路由
 *   拿取值函数而不是现成的对象。`getSkills` / `getTools` 是技能与工具候选主动读取的
 *   来源（官方技能服务 / 工具服务），`getOwnerOf` 是工具来源表（与观察层同一份归因）。
 */
export function mountApi(ctx, logger, deps) {
    const webStartup = ctx.get?.('webStartup');
    const declaredHosts = webStartup?.trustedHosts;
    const trustedHosts = Array.isArray(declaredHosts) ? declaredHosts : [];
    // 绑定地址也走取值式：平台 `dsh-host-webserver` 的 `get host()` 给的是配置里那一个具体的
    // 本机 IP 字面量（凭据：`<DSH 安装目录>/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js:297`
    // 的 `get host() { return this.config.host }`）⇒ 读不到就不放宽（围栏照旧只认回环与信任清单）。
    const webServer = ctx.webServer;
    const bindHost = typeof webServer?.host === 'string' ? webServer.host : undefined;
    const requestDeps = { ...deps, trustedHosts, bindHost };
    webServer?.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req, res) => {
            const url = new URL(req.url ?? '/', 'http://localhost');
            const path = url.pathname.replace(/\/+$/, '');
            const hostError = validateRequestOrigin(req, trustedHosts, bindHost);
            if (hostError !== null) {
                json(res, hostError.statusCode, { ok: false, error: hostError.error });
                return;
            }
            if (req.method === 'GET' && path === `${API_PREFIX}/observation`) {
                // 两份一起给：`sessions` 是这次进程里采到的，`cached` 是上次留下的（按预设）。
                // 面板优先用第一份，没有就退回第二份——工具候选的权威来源是 `/tools` 实时端点，
                // 这两份是它读不到时的回退源（工具服务缺席、预设破损时才用得上）。
                json(res, 200, {
                    ok: true,
                    sessions: observedSessions(),
                    cached: cachedObservations(),
                });
                return;
            }
            if (req.method === 'GET' && path === `${API_PREFIX}/config`) {
                json(res, 200, { ok: true, config: deps.getScope()?.get() ?? null });
                return;
            }
            if (req.method === 'GET' && path === `${API_PREFIX}/ui`) {
                // 判据是 `!== false`：scope 缺席（服务未就绪）、老盘没这个键、字段为 true
                // 三种都算「挂」——界面偏好只在「用户明确关掉」这一个方向上有例外。
                json(res, 200, { ok: true, mountMainPage: deps.getScope()?.get()?.mountMainPage !== false });
                return;
            }
            if (req.method === 'GET' && path === `${API_PREFIX}/skills`) {
                await handleListSkills(res, requestDeps);
                return;
            }
            if (req.method === 'GET' && path === `${API_PREFIX}/tools`) {
                // 只过读围栏（上面的 `validateRequestOrigin` 对所有请求统一生效）；
                // 缺 preset 是「请求本身不完整」，回 400 让调用方看见，不当成空候选。
                const presetId = url.searchParams.get('preset');
                if (presetId === null || presetId === '') {
                    json(res, 400, { ok: false, error: '缺少 preset' });
                    return;
                }
                await handleListTools(res, presetId, requestDeps, ctx);
                return;
            }
            if (req.method === 'GET' && path.startsWith(`${API_PREFIX}/client-parts/`)) {
                handleClientPart(res, path.slice(`${API_PREFIX}/client-parts/`.length));
                return;
            }
            if (req.method === 'GET' && path === `${API_PREFIX}/presets`) {
                await handleListPresets(res, requestDeps);
                return;
            }
            if (req.method === 'GET' && path === `${API_PREFIX}/models`) {
                await handleListModels(res, requestDeps);
                return;
            }
            if (req.method === 'GET' && path === `${API_PREFIX}/models/efforts`) {
                await handleListEfforts(req, res, requestDeps);
                return;
            }
            if (req.method === 'POST' && path === `${API_PREFIX}/config`) {
                await handleConfigUpdate(req, res, requestDeps);
                return;
            }
            if (req.method === 'POST' && path === `${API_PREFIX}/ui`) {
                await handleUiUpdate(req, res, requestDeps);
                return;
            }
            if (req.method === 'POST' && path === `${API_PREFIX}/presets/create`) {
                await handleCreatePreset(req, res, requestDeps);
                return;
            }
            if (req.method === 'POST' && path === `${API_PREFIX}/presets/delete`) {
                await handleDeletePreset(req, res, requestDeps);
                return;
            }
            json(res, 404, { ok: false, error: `unknown action: ${req.method} ${path}` });
        },
    });
    logger.info?.(`[agent-studio] HTTP 路由已挂上 · ${API_PREFIX}`);
}
