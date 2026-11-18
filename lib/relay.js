/**
 * 虚拟 LLM provider「中转层」：把「一个代理 = 一条候选链」做成平台认得的一个模型。
 *
 * **为什么要有这一层。** 「失败后换模型」如果靠改写平台解出来的路由，就得跟平台内部
 * 解出来的请求头对账，那条老路已经被平台禁掉了（改写出来的 provider 与请求头不一致时
 * 请求直接被拒）。让**本插件自己就是一个 provider**：聊天选择器里每个代理各出现一个
 * 模型（id = 代理 id），选中它 = 这次派活整条走本层；真正的候选 provider/model 由
 * `policyKey` 交代给会话投影（见 `relay-state.ts`）。平台看见的永远是一个稳定身份，
 * 换候选不会撞 v4 会话的重试链不变量。
 *
 * **为什么注册时只认常数。** 平台在 `registerAdapter()` 里就把 `providerInfo()` 与
 * `providerRetryPolicy()` 的结果快照走了（`dsh-llm/lib/index.js:1978-1981`），之后不再
 * 重问；这两个方法现读配置等于「改了也不生效」。重试上限因此恒为 0：重试与换候选全由
 * 本层的 `agent/request-error` 监听器决定，平台再重试一遍就是把每次失败翻倍。
 *
 * **为什么 adapter 是普通对象。** 平台不检查 `instanceof LlmAdapter`，只按键调用那 8 个
 * 方法，且**没有空守卫**——少一个就是运行期 TypeError。普通对象没有基类默认实现，所以
 * 连 `prepareCall` 都得自己装配（`{ model, stream }`）。
 *
 * **为什么不改 `options`。** 平台交给 adapter 的请求是冻结的（`dsh-agent-loop` 的
 * `prepareRequest` 用 `Object.freeze` 定稿），一律 `{ ...options, … }` 换字段；
 * `sessionId` 必须原样带下去，转发出去的内层调用靠它把重试与用量记到同一条会话上。
 *
 * **为什么转发用 `llm.stream()`。** 那是公开入口，走 `llm/stream` 瀑布、凭证、用量全套；
 * 内层抛错会被 llm 层转成终止 `finish` 块（`dsh-llm/lib/index.js` 的
 * `adapterFailureChunk`），与「adapter 直接抛错」的协议一致，所以这里 `yield*` 内层流即可，
 * 不用 try/catch 猜异常。
 *
 * @module dsh-agent-studio/relay
 */
import { randomUUID } from 'node:crypto';
import { agentById } from './config.js';
import { BACKOFF, DEFAULT_RETRYABLE_CODES, RELAY_PROVIDER, backoffDelayOf, chainOf, decideFailure, retryEventData, retryLimitOf, retryStartedData, retryableCodesOf, routeAt, routeLabelOf, switchNoticeOf, } from './relay-state.js';
/** 代理模型在聊天选择器里的 provider 显示名（`providerInfo().name`，必须非空）；中英同串：平台按原样渲染、不做本地化。 */
const RELAY_NAME = '中转 / Relay';
/** 状态表上限：进程里的会话数可能无限，状态表不能跟着长（超出按插入顺序删最早的）。 */
const STATE_LIMIT = 200;
/** 元数据缓存上限：反复改配置会留下一串过期签名，攒着没用。 */
const METADATA_LIMIT = 200;
/**
 * 中转层声明的重试策略：平台**一次都不重试**（`maxRetries: 0`）。
 *
 * 重试与换候选全由本层的 `agent/request-error` 监听器决定；平台若再重试一遍，等于把
 * 每次失败都翻倍成两次请求。码表与退避照平台默认档（`relay-state.ts` 的
 * `DEFAULT_RETRYABLE_CODES` / `BACKOFF`），退避时长由本层自己算（`backoffDelayOf`）。
 *
 * 必须是**常数**：平台在 `registerAdapter()` 时就快照走了（`dsh-llm/lib/index.js:1978-1981`）。
 */
const RELAY_RETRY_POLICY = {
    mode: 'normal',
    maxRetries: 0,
    retryableCodes: [...DEFAULT_RETRYABLE_CODES],
    initialDelayMs: BACKOFF.initialDelayMs,
    maxDelayMs: BACKOFF.maxDelayMs,
    jitterRatio: BACKOFF.jitterRatio,
};
/** 中转层是否已注册成功（`registerAdapter()` 成功才为真；`llm` 缺席或注册失败时保持为假）。 */
let ready = false;
/** 这个进程里中转层能不能用；其它层据此决定要不要把路由指过来。 */
export function relayReady() {
    return ready;
}
/**
 * 挂上中转层：一个虚拟 provider + 两个监听。
 *
 * adapter 注册失败只记日志：provider 没了，本插件其它层（观察 / 配置 / 派活）照旧工作，
 * 不能因为一个可选能力把插件整体拖垮。
 *
 * @param ctx - 插件所在的 context。
 * @param logger - 用于诊断的 logger。
 * @param getConfig - 现取当前配置（volatile 字段是活引用，不能缓存）。
 */
export function mountRelay(ctx, logger, getConfig) {
    const context = { logger, getConfig, states: new Map() };
    ctx.inject(['llm'], (llmCtx) => {
        const llm = llmCtx.get?.('llm');
        if (llm === undefined) {
            logger.error?.('[agent-studio] 中转层取不到 llm 服务；虚拟 provider 未注册');
            return;
        }
        const adapterContext = {
            ...context,
            llm,
            metadata: new Map(),
        };
        // 8 个方法一个都不能少：平台按键直接调，没有空守卫，也没给普通对象留默认实现。
        const adapter = {
            providerInfo: () => ({ id: RELAY_PROVIDER, name: RELAY_NAME }),
            providerRetryPolicy: () => RELAY_RETRY_POLICY,
            imageRequestPricing: () => undefined,
            imageRequestTarget: (_provider, _model, image) => ({
                width: image.width,
                height: image.height,
                maxBytes: image.bytes,
            }),
            listModels: (provider) => relayListModels(adapterContext, provider),
            resolveModel: (provider, model, signal) => (relayResolveModel(adapterContext, provider, model, signal)),
            prepareCall: async (provider, model, signal) => ({
                model: await relayResolveModel(adapterContext, provider, model, signal),
                stream: (options) => relayStream(adapterContext, options),
            }),
            stream: (options) => relayStream(adapterContext, options),
        };
        try {
            llm.registerAdapter([RELAY_PROVIDER], adapter);
            ready = true;
            logger.info?.(`[agent-studio] 中转层已注册 · provider=${RELAY_PROVIDER}`);
        }
        catch (err) {
            logger.error?.('[agent-studio] 中转层注册失败；虚拟 provider 不可用', err);
        }
    });
    // 必须 prepend：平台自己的重试（`dsh-llm-retry`）也挂在这条瀑布上，落在它后面就轮不到
    // 我们决定「这次是重试、是换候选、还是让位」。
    ctx.on('agent/request-error', (payload, next) => relayRequestError(context, payload, next), { prepend: true });
    // 状态按会话记在内存里，会话一销毁就删。平台给所有插件都会发这个事件，不带 `global`
    // 只在本插件自己的 context 上报，别的插件建的会话（子代理）就漏了——那些最需要清理。
    ctx.on('session/disposed', (session) => {
        const id = session?.id;
        if (typeof id === 'string')
            context.states.delete(id);
    }, { global: true });
}
/**
 * 聊天选择器里列出的「模型」：只列**配有候选链**的代理。
 *
 * **绝不抛。** 平台会逐条校验（`provider` 必须等于注册名、`id` 非空且不重复、`name`
 * 非空，`dsh-llm/lib/index.js:2192-2210`），任何一条不合格或整体抛错 ⇒ 这个 provider 在
 * 聊天选择器里**整组消失**（`dsh-api-session-controller/lib/index.js:555-566`）。所以这里
 * 只做形状搬运：读配置出问题就带着已收集的那几条返回。
 *
 * @param context - 本层挂载期上下文。
 * @param provider - 平台传进来的注册名（原样回填，它是校验项之一）。
 * @returns 每个有链的代理一条；一条都没有时为空数组（不抛）。
 */
async function relayListModels(context, provider) {
    const models = [];
    const seen = new Set();
    try {
        for (const agent of context.getConfig().agents ?? []) {
            const chain = chainOf(agent);
            if (chain === undefined || chain.agentId === '')
                continue;
            if (seen.has(chain.agentId))
                continue;
            seen.add(chain.agentId);
            models.push({
                provider,
                id: chain.agentId,
                name: chain.name,
                description: descriptionOfChain(chain),
            });
        }
    }
    catch (err) {
        context.logger.warn?.(`[agent-studio] 列中转模型失败，先返回已收集的 ${models.length} 条：${String(err)}`);
    }
    return models;
}
/**
 * 解析「代理 → 模型元数据」，供聊天选择器与内层调用前的档位校验使用。
 *
 * **任何情况都不抛**（与 `relayListModels` 同一个理由：一抛整组消失）：未知代理 id、
 * 配置读不出来、平台解析失败，一律退回「它就是它自己」的最小形状。
 *
 * @param context - adapter 上下文。
 * @param provider - 平台传进来的注册名（原样回填，平台校验它必须相等）。
 * @param model - 代理 id（对我们来说模型 id 就是代理 id）。
 * @param signal - 平台这次调用的取消信号。
 * @returns 平台认的模型元数据。
 */
async function relayResolveModel(context, provider, model, signal) {
    const minimal = { provider, id: model, name: model };
    try {
        const chain = chainOfAgent(context, model);
        if (chain === undefined)
            return minimal;
        const routes = await routeMetadataOf(context, chain, signal);
        const resolved = {
            provider,
            id: model,
            name: chain.name,
            description: descriptionOfChain(chain),
        };
        // 上下文窗口只按**主候选**上报（用户拍板）：主候选取不到就不报，绝不拿备用候选的
        // 窗口冒充本代理的窗口——窗口报大了平台会按错的上限做压缩。
        const contextWindow = routes[0].contextWindow;
        if (contextWindow !== undefined)
            resolved.context = { contextWindow };
        // 输入模态取候选链**交集**：任一候选取不到信息就不报。换候选后的能力只会更弱，
        // 报一个交集之外的能力等于承诺一件做不到的事（比如图片输入）。
        const headModalities = routes[0].inputModalities;
        if (headModalities !== undefined) {
            const common = headModalities.filter((modality) => (routes.every((route) => route.inputModalities?.includes(modality) === true)));
            if (common.length > 0)
                resolved.inputModalities = common;
        }
        // 档位取**并集**，但不声明 `defaultEffort`：默认档该由平台按它自己选中的模型决定，
        // 这里声明一个等于替用户的候选做主。
        const efforts = [];
        const seenEffort = new Set();
        for (const route of routes) {
            for (const effort of route.efforts ?? []) {
                if (seenEffort.has(effort.id))
                    continue;
                seenEffort.add(effort.id);
                efforts.push(effort);
            }
        }
        if (efforts.length > 0)
            resolved.reasoning = { efforts };
        return resolved;
    }
    catch (err) {
        context.logger.warn?.(`[agent-studio] 解析中转模型失败，退回最小形状：${model} ${String(err)}`);
        return minimal;
    }
}
/**
 * 把这次调用转发给当前候选。
 *
 * `state.candidateIndex` 是唯一的真相：平台重试会重新走 `prepareCall` → `stream`，每次
 * 现读状态就能换到下一个候选，不需要在本函数里记住任何东西。
 *
 * @param context - adapter 上下文。
 * @param options - 平台这次给的请求（已冻结，只读）。
 * @returns 内层请求的分片流（原样透传）。
 */
async function* relayStream(context, options) {
    const request = options;
    const agentId = typeof request.model === 'string' ? request.model : '';
    const chain = chainOfAgent(context, agentId);
    if (chain === undefined) {
        // 走不到这里：选择器只列有链的代理。真走到就是平台侧路由与配置脱节了——按 adapter
        // 抛错的协议交出去，llm 层会把它转成终止 error 块。
        throw new Error(`中转层收到未知代理 "${agentId}"：配置里没有它的候选链`);
    }
    // 没有会话 id 时用临时状态：这次请求仍然能拿主候选，但没地方记「已经换到第几个」。
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId : undefined;
    const state = sessionId === undefined ? createRelayState() : relayStateOf(context, sessionId);
    const route = routeAt(chain, state.candidateIndex);
    // 思考强度：候选自配的 > 平台这次给的 > 不带。元数据只在**明确声明**了档位表时才有
    // 否决权：取不到元数据（空对象）不等于「不支持」，那种情况原样带下去，让内层 adapter 自己
    // 判断（它才是权威）；否则「平台没给元信息」会被误判成不支持，还每个请求刷一条日志。
    let reasoningEffort = route.reasoningEffort;
    if (reasoningEffort === undefined && typeof request.reasoningEffort === 'string') {
        // 配置可能在会话中途被改短（面板保存即生效），下标按当前链长钳一下。
        const routes = await routeMetadataOf(context, chain, request.signal);
        const candidate = routes[Math.min(state.candidateIndex, routes.length - 1)];
        const efforts = candidate.efforts;
        // `efforts === undefined` = 这个候选不声明档位表（含元数据取不到）：没有否决权，原样带。
        if (efforts === undefined || efforts.some((effort) => effort.id === request.reasoningEffort)) {
            reasoningEffort = request.reasoningEffort;
        }
        else {
            context.logger.warn?.(`[agent-studio] 候选 ${routeLabelOf(route)} 不认思考强度 "${request.reasoningEffort}"，本次不带`);
        }
    }
    // 请求对象是冻结的，一律换新对象；`sessionId` 与其余请求事实原样带下去。
    const { reasoningEffort: _inherited, ...rest } = request;
    yield* context.llm.stream({
        ...rest,
        provider: route.provider,
        model: route.model,
        ...reasoningEffort === undefined ? {} : { reasoningEffort },
    });
}
/**
 * `agent/request-error` 监听：可重试码就在当前候选上重试，否则换下一个候选。
 *
 * 让位（`yield`）时只调 `next()`、不写事件也不换候选：上下文超限交给平台的压缩自愈，
 * 链尾交给 `dsh-harden`，与本层无关的失败（额度耗尽、凭据失效）也该按平台原样收尾。
 *
 * @param context - 本层挂载期上下文。
 * @param payload - 失败现场。
 * @param next - 瀑布的下一个处理者（平台的重试在其中）。
 * @returns `{ kind: 'retry' }` 让 agent-loop 重跑本 step；否则是下游的返回值。
 */
async function relayRequestError(context, payload, next) {
    const passThrough = next;
    const fields = payload;
    if (fields === undefined)
        return await passThrough();
    const session = fields.agent?.session;
    if (session === undefined)
        return await passThrough();
    // 请求头记着这次请求究竟走了谁：不是中转层 ⇒ 用户在对话里把模型换走了（或平台换了
    // 路由），这条会话的中转状态就地作废，后续失败一律不接管。
    const header = session.requestHeader?.()?.config;
    if (header?.provider !== RELAY_PROVIDER) {
        context.states.delete(session.id);
        return await passThrough();
    }
    const chain = chainOfAgent(context, header.model);
    if (chain === undefined)
        return await passThrough();
    const state = relayStateOf(context, session.id);
    // v4 会话把重试链的身份定义成 `(turn, step, provider, policyKey)`，校验器要求：
    // 同一条链的 `retry` 必须逐条 +1、同链沿用同一个 `retryId`，而**新链的 `retry` 必须从 1 起
    // 且 `retryId` 不得复用**（`dsh-session-persistence-jsonl/lib/worker.cjs:12446-12462`）。
    // 换一步就是换一条链，所以步进时把重试计数与链身份一起换掉——漏了这一步，第二步起就会
    // 写出「新链 retry=3」「复用旧 retryId」这种记录，整份会话从此读不回来。
    const stepKey = `${String(fields.turn)}/${String(fields.step)}`;
    if (state.stepKey !== stepKey) {
        state.stepKey = stepKey;
        state.retryCount = 0;
        state.retryId = randomUUID();
    }
    const code = typeof fields.failure?.code === 'string' ? fields.failure.code : '';
    const decision = decideFailure({ code, state, chain, retryableCodes: retryableCodesOf(fields.retryPolicy) });
    if (decision.kind === 'yield')
        return await passThrough();
    // 已经中止的请求不用再排一次注定失败的重试：直接交回平台按中止收尾，也不留一条不会发生的 retry 事件。
    if (fields.signal?.aborted === true)
        return await passThrough();
    // 写事件与退避等待都可能抛（会话已关、事件被拒、状态被冻结…）。宁可不接管，也不能
    // 让异常冒到 agent-loop 把这一步彻底掐死。
    try {
        if (decision.kind === 'retry') {
            const turn = fields.turn;
            const step = fields.step;
            if (typeof turn !== 'number' || typeof step !== 'number') {
                // 没有轮次/步号就落不了 `llm/retry`（会话格式要求它们是数字）。仍然把重试
                // 计数推进一格并让 loop 重跑，行为与平台自己的重试一致，只是界面上不显示。
                context.logger.warn?.('[agent-studio] 失败现场缺 turn/step，推进状态但不写重试事件');
                state.retryCount = decision.retry;
                return { kind: 'retry' };
            }
            const delayMs = backoffDelayOf(decision.retry);
            session.append('llm/retry', retryEventData({
                retryId: state.retryId,
                turn,
                step,
                route: decision.route,
                retry: decision.retry,
                maxRetries: retryLimitOf(chain),
                delayMs,
                failure: fields.failure,
            }));
            // 退避期间被取消（用户点了停止 / 会话关了）⇒ 交回平台，让这一步按中止收尾。
            if (await waitFor(delayMs, fields.signal) === false)
                return await passThrough();
            session.append('llm/retry-started', retryStartedData({
                retryId: state.retryId,
                turn,
                step,
                retry: decision.retry,
            }));
            state.retryCount = decision.retry;
            return { kind: 'retry' };
        }
        state.candidateIndex += 1;
        state.retryCount = 0;
        // 换候选 = 换一条重试链（链身份 `(turn, step, provider, policyKey)` 里的 policyKey 跟着
        // 候选真身走）。链身份必须换新，沿用旧 retryId 会让 v4 会话把两条不同的链记成一条，
        // 整份会话读不回来（`dsh-session-persistence-jsonl/lib/worker.cjs:12446-12462`）。
        state.retryId = randomUUID();
        // 换候选**不写** `llm/retry`：那是「同一条链上第 N 次重试」的记录，新链该从 1 起算。
        // 这里只留一条用户可见的通知（surface 事件必须带 `surfaceOp`，缺了会话层直接抛，
        // `dsh-session/src/surface.ts:316-318`），让模型知道上面的回答是旧模型产出的。
        session.append('user/message', switchNoticeOf(decision.from, decision.route, code), { surfaceOp: 'append' });
        return { kind: 'retry' };
    }
    catch (err) {
        context.logger.warn?.(`[agent-studio] 中转层接管失败，交回平台：${String(err)}`);
        return await passThrough();
    }
}
/** 取这个代理的候选链；代理不存在、或没配出第二条候选时 undefined（= 本层不管它）。 */
function chainOfAgent(context, agentId) {
    const agent = agentById(context.getConfig(), agentId);
    if (agent === undefined)
        return undefined;
    return chainOf(agent);
}
/** 候选链的摘要（模型选择器的副标题）：`自动降级 / Auto-fallback：A → B → C`。 */
function descriptionOfChain(chain) {
    return `自动降级 / Auto-fallback：${chain.routes.map((route) => routeLabelOf(route)).join(' → ')}`;
}
/**
 * 一条链上每个候选的元数据，与 `chain.routes` 按下标对齐。
 *
 * 缓存键 = **链签名**（`JSON.stringify(chain.routes)`）：配置一改签名就变，旧条目自然失效，
 * 不必监听配置变更。取单个候选时失败只跳过该条——某家 provider 没实现 `resolveModel`
 * 不该让整个代理在选择器里消失。
 *
 * @param context - adapter 上下文（缓存挂在它上面）。
 * @param chain - 候选链。
 * @param signal - 取消信号；转发给平台的解析调用。
 * @returns 与 `chain.routes` 等长的元数据数组（读不到的项是空对象）。
 */
async function routeMetadataOf(context, chain, signal) {
    const key = JSON.stringify(chain.routes);
    const cached = context.metadata.get(key);
    if (cached !== undefined)
        return cached;
    const routes = [];
    for (const route of chain.routes) {
        try {
            const info = await context.llm.resolveModelInfo(route.provider, route.model, signal);
            routes.push(routeMetadataFrom(info));
        }
        catch (err) {
            context.logger.warn?.(`[agent-studio] 取候选元数据失败，按「不声明」处理：${routeLabelOf(route)} ${String(err)}`);
            routes.push({});
        }
    }
    if (context.metadata.size >= METADATA_LIMIT)
        context.metadata.clear();
    context.metadata.set(key, routes);
    return routes;
}
/**
 * 从 `llm.resolveModelInfo()` 的返回里挑出本层要的三项。
 *
 * 平台交回来的已经是校验过的 `LlmResolvedModelInfo`（`dsh-llm` 的 `normalizeModelInfo`
 * 保证 `context.contextWindow` 是正整数、`reasoning.efforts` 是 `{ id, name }[]`），
 * 所以这里只做形状搬运，不重复校验；字段缺席就是「这个候选不声明它」。
 *
 * @param info - `resolveModelInfo` 的返回。
 * @returns 本层要的元数据。
 */
function routeMetadataFrom(info) {
    const resolved = info;
    const metadata = {};
    const contextWindow = resolved?.context?.contextWindow;
    if (typeof contextWindow === 'number' && contextWindow > 0)
        metadata.contextWindow = contextWindow;
    const inputModalities = resolved?.inputModalities;
    if (Array.isArray(inputModalities)) {
        const collected = [];
        for (const modality of inputModalities) {
            if (typeof modality === 'string')
                collected.push(modality);
        }
        if (collected.length > 0)
            metadata.inputModalities = collected;
    }
    const efforts = resolved?.reasoning?.efforts;
    if (Array.isArray(efforts)) {
        const collected = [];
        for (const effort of efforts) {
            const row = effort;
            if (typeof row?.id !== 'string' || row.id === '')
                continue;
            collected.push({ id: row.id, name: typeof row.name === 'string' && row.name !== '' ? row.name : row.id });
        }
        if (collected.length > 0)
            metadata.efforts = collected;
    }
    return metadata;
}
/** 一条新会话的中转状态：从主候选起、没重试过、重试链身份是新的。 */
function createRelayState() {
    return { candidateIndex: 0, retryCount: 0, retryId: randomUUID() };
}
/**
 * 取（或建）一条会话的中转状态。
 *
 * 只留最近 `STATE_LIMIT` 条：`Map` 按插入顺序迭代，超出就从最早插入的那条删（FIFO）。
 *
 * @param context - 本层挂载期上下文（状态表挂在它上面）。
 * @param sessionId - 会话 id。
 * @returns 该会话的状态。
 */
function relayStateOf(context, sessionId) {
    const known = context.states.get(sessionId);
    if (known !== undefined)
        return known;
    if (context.states.size >= STATE_LIMIT) {
        const oldest = context.states.keys().next();
        if (oldest.done !== true)
            context.states.delete(oldest.value);
    }
    const created = createRelayState();
    context.states.set(sessionId, created);
    return created;
}
/**
 * 可取消的退避等待：到时返回 true，中途被中止返回 false。
 *
 * 不用 `node:timers/promises` 的 `setTimeout`：它的 `signal` 选项在部分 Node 版本里中止后
 * 抛 `AbortError` 而不是安静返回，会把「用户点了停止」变成一条异常日志。
 *
 * @param delayMs - 等待时长。
 * @param signal - 平台的取消信号。
 * @returns 是否等到了时候。
 */
async function waitFor(delayMs, signal) {
    if (signal?.aborted === true)
        return false;
    return await new Promise((resolve) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve(true);
        }, delayMs);
        function onAbort() {
            clearTimeout(timer);
            resolve(false);
        }
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
