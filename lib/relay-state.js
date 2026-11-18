/**
 * 模型自动降级中转层的纯逻辑：候选链、状态机、事件与通知数据。
 *
 * **为什么单独成一层。** v4 会话把「重试链」的身份定义成 `(turn, step, provider, policyKey)`
 * （`dsh-session-persistence-jsonl/lib/worker.cjs:12446-12462`）：同一条链上的 `retry` 要从 1
 * 逐条 +1，一条链只认一个 `retryId`。中转层对外永远自称一个 provider（`RELAY_PROVIDER`），
 * 候选的真实身份只能靠 `policyKey` 承住——换候选后开的是另一条链，不撞旧链的不变量。
 * 判定与数据构造都在这里定形，宿主层只负责把结果交给 `session.append`。
 *
 * **为什么是纯函数。** 这里不 import 任何 `@deepseek-ai/*` 包、不做 IO、不注册监听、不留状态：
 * 链从配置现算，会话状态由调用方持有并回传。这样「这次失败该重试、该换候选，还是该让位」
 * 可以脱离平台的挂钩顺序单独推演。
 *
 * @module dsh-agent-studio/relay-state
 */
import { randomUUID } from 'node:crypto';
/** 中转层对外统一自称的 provider；候选真身藏在 `policyKey` 里（见 `policyKeyOf`）。 */
export const RELAY_PROVIDER = 'studio-relay';
/** 平台默认的可重试错误码（dsh-llm 的 `DEFAULT_RETRYABLE_CODES`；策略缺席时的兜底）。 */
export const DEFAULT_RETRYABLE_CODES = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'];
/**
 * 重试退避：与平台默认策略同参（500ms 起、指数翻倍、上限 10s、±10% 抖动）。
 * 不做成可配——「重试时间可配」是用户明确不要的那类开关。
 */
export const BACKOFF = { initialDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0.1 };
/**
 * 非法重试上限的兜底值：与 `config.ts` 的 `DEFAULT_MAX_RETRIES`（schema 默认 5）对齐。
 *
 * 这里不复用那份常量：`config.ts` 依赖 `@deepseek-ai/schemastery`，而本模块要保持零平台依赖，
 * 否则纯逻辑就没法脱离平台单独求值。
 */
const FALLBACK_MAX_RETRIES = 5;
/**
 * 一条配置里的候选：provider 与 model 都填了才算候选。
 *
 * 半配（只填一半、填的不是字符串、填了空串）一律按「没配」处理：宁可当它没有这个候选，
 * 也不把半条路由交给平台。
 */
export function completeRouteOf(value) {
    const row = value;
    if (row === null || row === undefined)
        return undefined;
    if (typeof row.provider !== 'string' || row.provider === '')
        return undefined;
    if (typeof row.model !== 'string' || row.model === '')
        return undefined;
    const route = { provider: row.provider, model: row.model };
    if (typeof row.reasoningEffort === 'string' && row.reasoningEffort !== '')
        route.reasoningEffort = row.reasoningEffort;
    return route;
}
/**
 * 组装一条候选链：主候选打头，备用按配置顺序跟上，`provider/model` 相同的不重复进链。
 *
 * 没有完整主候选、或者去重后没有第二个候选 ⇒ 返回 undefined。这是「该代理不走中转」的
 * 唯一表达，调用方据此决定不接管（行为与平台默认一致）。
 *
 * @param agent - 该代理的配置。
 * @returns 候选链；不接管时 undefined。
 */
export function chainOf(agent) {
    const head = completeRouteOf(agent.model);
    if (head === undefined)
        return undefined;
    const routes = [head];
    const seen = new Set([routeLabelOf(head)]);
    for (const row of agent.fallbacks ?? []) {
        const route = completeRouteOf(row);
        if (route === undefined)
            continue;
        const label = routeLabelOf(route);
        if (seen.has(label))
            continue;
        seen.add(label);
        routes.push(route);
    }
    // 中转层不能当中转层的后端：候选配成 `studio-relay` 会让转发回到自己（无限递归），
    // 主候选与备用一律过滤掉。过滤后不足两条 = 这条链不存在，该代理不走中转。
    const relayRoutes = routes.filter((route) => route.provider !== RELAY_PROVIDER);
    // 只有主候选 = 失败后没有下一个可换，等同没配备用候选。
    if (relayRoutes.length < 2)
        return undefined;
    const agentId = typeof agent.id === 'string' ? agent.id : '';
    const name = typeof agent.name === 'string' && agent.name !== '' ? agent.name : agentId;
    return { agentId, name, routes: relayRoutes, maxRetries: agent.maxRetries ?? FALLBACK_MAX_RETRIES };
}
/**
 * 每个候选各自的重试上限。
 *
 * 非法值（非整数、负数）在这里统一退回默认：盘上手改与面板都可能塞进坏值，且配置类型只是
 * 声明、挡不住存量数据，所以校验只在此一处做，其余函数直接用返回值。
 */
export function retryLimitOf(chain) {
    const limit = chain.maxRetries;
    if (Number.isSafeInteger(limit) === false || limit < 0)
        return FALLBACK_MAX_RETRIES;
    return limit;
}
/** 取链上第 `index` 个候选；越界（负数、或越过链尾）钳到最近的边界。链非空由 `chainOf` 保证。 */
export function routeAt(chain, index) {
    if (index < 0)
        return chain.routes[0];
    if (index >= chain.routes.length)
        return chain.routes[chain.routes.length - 1];
    return chain.routes[index];
}
/** 路由的显示文本：`provider/model`。 */
export function routeLabelOf(route) {
    return `${route.provider}/${route.model}`;
}
/** 这次请求的可重试码表：平台给的策略优先（provider 可定制），缺了用平台默认。 */
export function retryableCodesOf(policy) {
    const codes = policy?.retryableCodes;
    if (Array.isArray(codes) && codes.length > 0 && codes.every((code) => typeof code === 'string'))
        return codes;
    return DEFAULT_RETRYABLE_CODES;
}
/** 第 `retry` 次重试的退避时长（照平台的 localDelay：指数翻倍 + 抖动，封顶 maxDelayMs）。 */
export function backoffDelayOf(retry) {
    // 平台语义下 retry 从 1 起：坏值（含 NaN）在这里挡成 1——坏值直接进指数会变成分数，退避比第一次还短。
    const attempt = Number.isFinite(retry) ? Math.max(1, Math.trunc(retry)) : 1;
    const exponent = Math.min(attempt - 1, 1024);
    const exponential = Math.min(BACKOFF.initialDelayMs * 2 ** exponent, BACKOFF.maxDelayMs);
    const jitter = 1 - BACKOFF.jitterRatio + 2 * BACKOFF.jitterRatio * Math.random();
    return Math.min(exponential * jitter, BACKOFF.maxDelayMs);
}
/**
 * 这条路由的 `policyKey`：真实候选的 `[provider, model]`。
 *
 * **为什么不能照抄平台的 `retryPolicyKey()`（mode/maxRetries/码表/退避打包成 JSON）。**
 * v4 会话把重试链的身份定义为 `(turn, step, provider, policyKey)`
 * （`dsh-session-persistence-jsonl/lib/worker.cjs:12446-12462`），并要求同一条链上 `retry` 从 1
 * 逐条 +1、一条链只有一个 `retryId`。中转层的 provider 恒为 `'studio-relay'`：同一个
 * `policyKey` 下换候选，平台会认为这还是原来那条链，于是 `retry` 从头计数、`retryId` 换人，
 * 直接违反不变量，整份会话读不回来。把候选的真实 provider/model 编进 `policyKey`，换候选
 * 天然开出新链，身份与真身一一对得上。
 */
export function policyKeyOf(route) {
    return JSON.stringify([route.provider, route.model]);
}
/**
 * 这次失败该怎么处置：在候选上重试、换下一个候选、还是让位给平台。
 *
 * 纯函数——只读入参，不改 `state`；调用方按决定自己推进状态。
 *
 * 判定顺序不能换：先让位（撞上下文换模型也没用），再谈重试与换候选。
 * 重试上限是**每个候选各自**的，换候选后 `retryCount` 由调用方归 0。
 */
export function decideFailure(input) {
    const { chain, state } = input;
    // 上下文超限不换候选：换个模型也不会让这段对话变短，交给平台的压缩自愈。
    if (input.code === 'CONTEXT_WINDOW_EXCEEDED')
        return { kind: 'yield', reason: 'overflow' };
    const current = routeAt(chain, state.candidateIndex);
    // 平台策略本身不允许空码表，空数组只可能是脏数据：与 `retryableCodesOf` 同口径退回默认五码。
    const codes = input.retryableCodes !== undefined && input.retryableCodes.length > 0
        ? input.retryableCodes
        : DEFAULT_RETRYABLE_CODES;
    const canRetry = codes.includes(input.code) && state.retryCount < retryLimitOf(chain);
    if (canRetry) {
        return { kind: 'retry', route: current, retry: state.retryCount + 1, policyKey: policyKeyOf(current) };
    }
    const nextIndex = state.candidateIndex + 1;
    if (nextIndex < chain.routes.length) {
        const next = routeAt(chain, nextIndex);
        // policyKey 跟的是即将重试的那个候选：新链的身份必须与真身一致。
        return { kind: 'switch', route: next, from: current, policyKey: policyKeyOf(next) };
    }
    return { kind: 'yield', reason: 'exhausted' };
}
/**
 * 构造 `llm/retry` 事件的数据（界面据此显示「正在重试」，会话投影也认这套字段）。
 *
 * `provider` 填中转层自己而不是被调用的平台 provider：事件落在我方 provider 名下，
 * 候选真身由 `policyKey` 交代。
 */
export function retryEventData(input) {
    return {
        retryId: input.retryId,
        turn: input.turn,
        step: input.step,
        provider: RELAY_PROVIDER,
        mode: 'normal',
        policyKey: policyKeyOf(input.route),
        retry: input.retry,
        maxRetries: input.maxRetries,
        delayMs: input.delayMs,
        failure: input.failure,
    };
}
/** 构造 `llm/retry-started` 事件的数据（退避等待结束后、真正重跑这一步之前追加）。 */
export function retryStartedData(input) {
    return { retryId: input.retryId, turn: input.turn, step: input.step, retry: input.retry };
}
/**
 * 构造换候选的通知消息（与平台 `modelSwitchNotice` 同形：user 角色、插件来源、notice 形态、
 * 摘要截 120 字）。
 *
 * `source.kind` 必须是 `plugin:<插件名>`——v4 会话格式直接拒 v3 的裸 `'plugin'`，
 * 而这条消息会由宿主层直接 append 到会话。
 */
export function switchNoticeOf(from, to, code) {
    const fromLabel = routeLabelOf(from);
    const toLabel = routeLabelOf(to);
    const summary = `${fromLabel} → ${toLabel}`;
    return {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: `[model fallback: ${fromLabel} failed (${code}); the session continues with ${toLabel}]` }],
        source: {
            kind: 'plugin:agent-studio',
            form: 'notice',
            summary: summary.length <= 120 ? summary : `${summary.slice(0, 119)}…`,
        },
    };
}
