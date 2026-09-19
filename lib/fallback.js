/**
 * 模型自动降级：主选失败后按候选链依次顶上。
 *
 * **为什么由插件来做。** 平台的内置重试（`dsh-llm-retry`）只在一个 provider 内
 * 重试到上限，用尽后这次请求就彻底失败；用户要的是「这个模型不行就换下一个
 * （可跨供应商）」。在 `agent/request-error` 瀑布上 `prepend` 抢在内置重试之前，
 * 才能既保留「重试 N 次」、又在其后接一条候选链——接管后内置重试被完全覆盖。
 *
 * **链的形态**（设计定稿）：
 *   - `routes[0]` 恒为「不改写」档：子代理 = 启动时给的路由（或继承），主代理 =
 *     对话界面选的模型——插件不抢用户的选择，只在失败后接管；
 *   - 主代理在它之后接「主模型配置」（`agent.model`，后备形态），再接备用候选；
 *   - 子代理直接接备用候选（它的 `model` 配置已经落在启动参数里，不用再放链上）。
 *   - 「不改写」档上的重试与候选一样计（主模型先试 N 次，失败才往下走）。
 *
 * **重试语义**：可重试码（平台码表：`EMPTY_RESPONSE` / `RATE_LIMIT` / `SERVER` /
 * `TIMEOUT` / `TRANSPORT`）在当前候选上重试到上限（默认 5，与平台默认对齐）才换
 * 下一个；码表外的错误（额度耗尽、凭据失效……）不重试、直接换候选。全链走完 =
 * 彻底失败（不调下游 ⇒ `agent-loop` 抛错，与「没人接管」时的终态一致）。
 *
 * **状态**：按 agent 对象记在内存里（WeakMap）——子代理的 agent 是一次性的，天然
 * 「每次新派活从头走」；主代理长寿命，「当次会话不自动切回」。用户手动换模型时
 * （平台解决出的路由变了）当场清状态，把方向盘还回去。
 *
 * **留痕**：重试照 `dsh-llm-retry` 的格式落 `llm/retry` / `llm/retry-started` 会话
 * 事件（聊天界面与状态投影认的就是这套字段，少了界面上的「重试中」就不显示）；
 * 换候选时另发一条与平台 `modelSwitchNotice` 同形的通知，进会话历史让模型知道
 * 上面的回答是旧模型产出的。
 *
 * @module dsh-agent-studio/fallback
 */
import { randomUUID } from 'node:crypto';
import { DEFAULT_MAX_RETRIES, agentById, boundAgentId } from './config.js';
import { agentOfChildSession } from './delegate.js';
import { resolvePresetId } from './preset.js';
/** 平台默认的可重试错误码（dsh-llm 的 `DEFAULT_RETRYABLE_CODES`；策略缺席时的兜底）。 */
const DEFAULT_RETRYABLE_CODES = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'];
/**
 * 重试退避：与平台默认策略同参（500ms 起、指数翻倍、上限 10s、±10% 抖动）。
 * 不做成可配——「重试时间可配」是用户明确不要的那类开关。
 */
const BACKOFF = { initialDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0.1 };
/**
 * 组装降级链（子代理与主代理的链首语义不同，见模块头注释）。
 *
 * @param agentConfig - 该代理的配置。
 * @param isChild - 是不是子代理。
 * @returns 降级链；没配备用候选时 undefined（= 不接管，行为与平台默认一致）。
 */
function buildChain(agentConfig, isChild) {
    const fallbacks = [];
    for (const row of agentConfig.fallbacks ?? []) {
        const route = completeRoute(row);
        if (route !== undefined)
            fallbacks.push(route);
    }
    if (fallbacks.length === 0)
        return undefined;
    const routes = [null];
    if (isChild === false) {
        const head = completeRoute(agentConfig.model);
        if (head !== undefined)
            routes.push(head);
    }
    routes.push(...fallbacks);
    return { routes, maxRetries: retryLimit(agentConfig.maxRetries) };
}
/** provider 与 model 都填了的候选；半配（只填一半）视为没配。 */
function completeRoute(row) {
    if (row?.provider === undefined || row.model === undefined)
        return undefined;
    if (row.provider === '' || row.model === '')
        return undefined;
    const route = { provider: row.provider, model: row.model };
    if (row.reasoningEffort !== undefined && row.reasoningEffort !== '')
        route.reasoningEffort = row.reasoningEffort;
    return route;
}
/** 重试上限：非负整数才收（面板/手改都可能塞进坏值），否则退回默认。 */
function retryLimit(value) {
    if (typeof value !== 'number' || Number.isSafeInteger(value) === false || value < 0)
        return DEFAULT_MAX_RETRIES;
    return value;
}
/** 这次请求的可重试码表：平台给的策略优先（provider 可定制），缺了用平台默认。 */
function retryableCodesOf(policy) {
    const codes = policy?.retryableCodes;
    if (Array.isArray(codes) && codes.length > 0 && codes.every((code) => typeof code === 'string') === true) {
        return codes;
    }
    return DEFAULT_RETRYABLE_CODES;
}
/** 第 `retry` 次重试的退避时长（照平台的 localDelay：指数翻倍 + 抖动，封顶 maxDelayMs）。 */
function backoffDelay(retry) {
    const exponent = Math.min(retry - 1, 1024);
    const exponential = Math.min(BACKOFF.initialDelayMs * 2 ** exponent, BACKOFF.maxDelayMs);
    const jitter = 1 - BACKOFF.jitterRatio + 2 * BACKOFF.jitterRatio * Math.random();
    return Math.min(exponential * jitter, BACKOFF.maxDelayMs);
}
/**
 * 重试事件的 `policyKey`：算法照 `dsh-llm-retry` 的 `retryPolicyKey()`——会话投影按
 * `[provider, policyKey]` 分键，键一致界面上的重试状态才接得上。
 */
function policyKeyOf(policy) {
    const p = policy;
    return JSON.stringify([
        p?.mode ?? 'normal',
        p?.maxRetries ?? DEFAULT_MAX_RETRIES,
        [...retryableCodesOf(policy)].sort(),
        p?.initialDelayMs ?? BACKOFF.initialDelayMs,
        p?.maxDelayMs ?? BACKOFF.maxDelayMs,
        p?.jitterRatio ?? BACKOFF.jitterRatio,
    ]);
}
/** 取一份请求 config 的路由（provider/model）；拿不全时 undefined。 */
function routeOf(config) {
    const c = config;
    if (c === undefined || typeof c.provider !== 'string' || typeof c.model !== 'string')
        return undefined;
    if (c.provider === '' || c.model === '')
        return undefined;
    return { provider: c.provider, model: c.model };
}
/** 路由的显示文本。 */
function routeLabel(route) {
    return `${route.provider}/${route.model}`;
}
/** 两条路由是否相同。 */
function sameRoute(a, b) {
    return a.provider === b.provider && a.model === b.model;
}
/** 用候选路由改写这次请求的 config（继承的思考强度让位给候选自己的）。 */
function overrideRoute(resolved, candidate) {
    const { reasoningEffort: _inherited, ...rest } = resolved;
    return {
        ...rest,
        provider: candidate.provider,
        model: candidate.model,
        ...candidate.reasoningEffort === undefined ? {} : { reasoningEffort: candidate.reasoningEffort },
    };
}
/** 可取消的等待：到时返回 true；中途被中止返回 false。 */
async function waitFor(delayMs, signal) {
    if (signal?.aborted === true)
        return false;
    return await new Promise((resolve) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener?.('abort', onAbort);
            resolve(true);
        }, delayMs);
        function onAbort() {
            clearTimeout(timer);
            resolve(false);
        }
        signal?.addEventListener?.('abort', onAbort, { once: true });
    });
}
/**
 * 排定一次重试：先落 `llm/retry`（界面据此显示「正在重试」）、退避等待、
 * 再落 `llm/retry-started`，最后返回 `{ kind: 'retry' }` 让 `agent-loop` 重跑本 step。
 *
 * 事件字段照 `dsh-llm-retry` 的 `backoff()`——会话投影（`llmRetry`）与聊天界面
 * 认的就是那套字段。
 *
 * @param agent - 正在重试的 agent。
 * @param fields - 失败现场的 payload。
 * @param retry - 这一次是第几次重试（从 1 起）。
 * @param maxRetries - 当前候选的重试上限。
 * @returns 重试决策；等待被中止时 undefined（= 彻底失败）。
 */
async function scheduleRetry(agent, fields, retry, maxRetries) {
    const retryId = randomUUID();
    const delayMs = backoffDelay(retry);
    agent.session.append('llm/retry', {
        retryId,
        turn: fields.turn,
        step: fields.step,
        provider: fields.provider,
        mode: 'normal',
        policyKey: policyKeyOf(fields.retryPolicy),
        retry,
        maxRetries,
        delayMs,
        failure: fields.failure,
    });
    if (await waitFor(delayMs, fields.signal) === false)
        return undefined;
    agent.session.append('llm/retry-started', {
        retryId,
        turn: fields.turn,
        step: fields.step,
        retry,
    });
    return { kind: 'retry' };
}
/**
 * 换候选后给模型的一条通知：与平台 `modelSwitchNotice` 同形（user 角色、plugin
 * 来源、notice 形态、摘要截 120 字）。
 */
function switchNotice(notice) {
    const reason = notice.code === undefined ? 'failed' : `failed (${notice.code})`;
    const summary = `${notice.from} → ${notice.to}`;
    return {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: `[model fallback: ${notice.from} ${reason}; the session continues with ${notice.to}]` }],
        source: {
            kind: 'plugin',
            plugin: 'agent-studio',
            form: 'notice',
            summary: summary.length <= 120 ? summary : `${summary.slice(0, 119)}…`,
        },
    };
}
/**
 * 挂上自动降级的三个监听（`agent/request` / `agent/request-error` / `agent/pre-step`），
 * 全部 `prepend` 抢在平台内置处理之前。
 *
 * 全局注册一条、按 payload 里的 agent 现算归属——不挂在各 agent 的 ctx 上，是因为
 * 备用候选随时可改，现算省掉「配置变了要重挂」的一整套失效逻辑；没配备用候选的
 * agent 每次都会走到「原样放行」的出口，行为与不装插件时一致。
 *
 * @param ctx - 插件所在的 context。
 * @param logger - 用于诊断的 logger。
 * @param settingsScope - 本插件设置命名空间的 scope。
 */
export function mountFallback(ctx, logger, settingsScope) {
    const states = new WeakMap();
    /** 取（或建）一个 agent 的降级状态。 */
    function stateOf(agent) {
        const known = states.get(agent);
        if (known !== undefined)
            return known;
        const created = {
            activeIndex: 0,
            retryCount: 0,
            stepKey: undefined,
            lastUsed: undefined,
            notice: undefined,
        };
        states.set(agent, created);
        return created;
    }
    /**
     * 这个 agent 的降级链；没配备用候选（或不是本插件管的 agent）时 undefined。
     *
     * 子代理靠派活时的身份登记（`agentOfChildSession`）认领，主代理走
     * 「预设 → 绑定」——与装配期同一条解析路径。
     */
    function chainFor(agent) {
        const config = settingsScope.get();
        const parentSessionId = agent.session.header?.parentSession;
        const isChild = typeof parentSessionId === 'string';
        let agentId;
        if (isChild) {
            const sessionId = agent.session.id;
            if (typeof sessionId === 'string')
                agentId = agentOfChildSession(sessionId);
        }
        else {
            agentId = boundAgentId(config, resolvePresetId(ctx, agent.ctx));
        }
        if (agentId === undefined)
            return undefined;
        const agentConfig = agentById(config, agentId);
        if (agentConfig === undefined)
            return undefined;
        return buildChain(agentConfig, isChild);
    }
    /**
     * 切到下一个候选；已在链尾（没有更多候选）时返回 false。
     * 顺手记下待发通知——真正投递给模型要等下一次 pre-step。
     */
    function advance(state, chain, code) {
        const nextIndex = state.activeIndex + 1;
        const candidate = chain.routes[nextIndex];
        if (candidate === undefined || candidate === null)
            return false;
        const previous = chain.routes[state.activeIndex];
        const from = previous === null || previous === undefined
            ? (state.lastUsed === undefined ? 'the current model' : routeLabel(state.lastUsed))
            : routeLabel(previous);
        state.notice = { from, to: routeLabel(candidate), code };
        state.activeIndex = nextIndex;
        state.retryCount = 0;
        return true;
    }
    /** 请求前：降级中就把这次请求换成当前候选的路由（链首那一档 = 不改写）。 */
    async function rewriteRequest(payload, next) {
        const resolved = await next();
        try {
            const agent = payload?.agent;
            if (agent === undefined)
                return resolved;
            const chain = chainFor(agent);
            if (chain === undefined)
                return resolved;
            const state = stateOf(agent);
            const incoming = routeOf(resolved);
            // 平台这次给出的路由 ≠ 我们上次实际用的路由 ⇒ 用户手动换了模型（或平台默认
            // 改了）：让位——清降级状态、本次不改写。
            //
            // 比的是 `lastUsed` 而不是「平台自己的选择」：平台的会话路由会**粘住上一次
            // 请求头**（`requestProposal(persistedHeader)`），我们上次改写出来的候选会被
            // 它延续到下一个 turn——那是「当次会话不自动切回」的来源，不是用户切的。
            const userSwitched = incoming !== undefined && state.lastUsed !== undefined
                && sameRoute(state.lastUsed, incoming) === false;
            if (userSwitched) {
                state.activeIndex = 0;
                state.retryCount = 0;
                state.notice = undefined;
            }
            const candidate = chain.routes[state.activeIndex];
            if (candidate === undefined || candidate === null) {
                if (incoming !== undefined)
                    state.lastUsed = incoming;
                return resolved;
            }
            state.lastUsed = candidate;
            return overrideRoute(resolved, candidate);
        }
        catch (err) {
            logger.warn?.(`[agent-studio] 自动降级改写失败，本次不干预：${String(err)}`);
            return resolved;
        }
    }
    /**
     * 失败后：可重试码就在当前候选上重试到上限，否则换下一个候选；全链走完时
     * 返回 undefined 且不调下游——瀑布就此终止，这次请求彻底失败。
     */
    async function decideRetry(payload, next) {
        const fields = payload;
        const agent = fields?.agent;
        if (fields === undefined || agent === undefined)
            return await next();
        if (fields.signal?.aborted === true)
            return undefined;
        try {
            const chain = chainFor(agent);
            // 不接管 = 原样放行：内置重试（dsh-llm-retry）照常
            if (chain === undefined)
                return await next();
            const state = stateOf(agent);
            const stepKey = `${String(fields.turn)}/${String(fields.step)}`;
            if (state.stepKey !== stepKey) {
                state.stepKey = stepKey;
                state.retryCount = 0;
            }
            const code = typeof fields.failure?.code === 'string' ? fields.failure.code : undefined;
            const retryable = code !== undefined && retryableCodesOf(fields.retryPolicy).includes(code);
            const withinLimit = state.retryCount < chain.maxRetries;
            if (retryable && withinLimit) {
                state.retryCount += 1;
            }
            else if (advance(state, chain, code) === false) {
                return undefined;
            }
            return await scheduleRetry(agent, fields, Math.max(state.retryCount, 1), chain.maxRetries);
        }
        catch (err) {
            logger.warn?.(`[agent-studio] 自动降级判定失败，交回内置重试：${String(err)}`);
            return await next();
        }
    }
    /** pre-step：把待发的切换通知追加进这次请求的输入。 */
    async function announceSwitch(payload, next) {
        const fields = payload;
        const decision = await next();
        const agent = fields?.agent;
        if (agent === undefined)
            return decision;
        const state = states.get(agent);
        if (state?.notice === undefined)
            return decision;
        if (decision === undefined || decision.kind === 'reject' || fields?.signal?.aborted === true)
            return decision;
        const notice = state.notice;
        state.notice = undefined;
        return { ...decision, messages: [...(decision.messages ?? []), switchNotice(notice)] };
    }
    ctx.on('agent/request', rewriteRequest, { prepend: true });
    ctx.on('agent/request-error', decideRetry, { prepend: true });
    ctx.on('agent/pre-step', announceSwitch, { prepend: true });
    logger.info?.('[agent-studio] 模型自动降级已挂上');
}
