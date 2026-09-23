/**
 * 子代理派活与**身份登记**。
 *
 * **为什么自建派活工具，而不是沿用官方的 `subagent`。** 官方工具的参数里没有代理
 * 标识（只有 description / prompt / 模型三者），子代理的会话头也没有角色字段。沿用它，
 * 「这个正在跑的子代理属于哪个代理」永远判不出来——而本插件要给每个子代理单独配
 * 提示词面、工具面、模型与后台模式，判定不出身份就无从生效。
 *
 * 于是代理 id 成为**调用参数**，身份从此确定：
 *
 *   - `studio_list_subagents` 列出**调用者名下**的子代理，模型据此选人；
 *   - `studio_delegate` 按代理 id 派活，配置在这里翻译成官方 `ctx.subagents` 的启动参数。
 *
 * 名字带 `studio_` 前缀只有一个原因：工具名在 host 平面全局唯一，重名会让 `tools.register`
 * 直接抛错。裸名 `list_subagents` / `delegate` 与用户自己装的插件撞了个正着，而那次抛错
 * 发生在 `settings.register` 之后，把配置写入通道一起带走了（见 `index.js` 里那段注释）。
 * 前缀本身没有语义，纯粹是不跟别人抢名字。
 *
 * ## 身份登记（认领）
 *
 * 「子代理会话 → 代理」的映射要**早于子代理的第一次装配**建好，否则装配期的段拼接
 * 查不到身份、退回默认面（2026-09-16 实测的「配了没用」根因：那次登记在 `run` 返回时，
 * 而 one-shot 的 `run` 要等整个 turn 跑完才返回）。
 *
 * 三条登记路径，从早到晚：
 *
 *  1. **预生成会话 id**（可续子代理）：`startContinuable` 接受调用方指定的 `childId`，
 *     所以映射在 `start()` **调用前**就写好了——零竞态。
 *  2. **创建窗口认领**（one-shot，以及上一条没兑现时）：入队在 `start()` 调用**前**同步
 *     完成，`agent/created` 必然早于第一次装配（创建 → 挂 composition → 提交首个 prompt），
 *     在那里按父会话配对。同父并发派活时用队列顺序（FIFO）配对。
 *  3. **装配期兜底认领**：装配时若映射仍缺失，按父会话从队列再认一次（见 `apply.js`）。
 *     `run` 返回后的直接登记只是最后一道保险，对第一次装配已经来不及。
 *
 * @module dsh-agent-studio/delegate
 */
import { randomUUID } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { agentById, boundAgentId } from './config.js';
import { resolvePresetId } from './preset.js';
/**
 * 子代理会话 → 代理 id 的映射。
 *
 * 装配期与创建窗口都靠它判「我是谁」；`apply.js` 通过 `agentOfChildSession()` 读。
 */
const agentByChildSession = new Map();
/**
 * 待认领队列：`{ parentSessionId, agentId }`。
 *
 * 在 `start()` 调用**前**同步入队——这个顺序是硬要求：它保证第一次装配时一定有可
 * 认领的项。创建窗口与装配期都按父会话从这里取；取走的项从队列移除。
 */
const pendingClaims = [];
/** 映射表上限。continuable 子代理可以长期活着，不设上限会一路涨上去。 */
const MAX_TRACKED_CHILDREN = 200;
/** 待认领队列上限：正常路径下每项都会在一两次装配内被取走，这是异常兜底。 */
const MAX_PENDING_CLAIMS = 50;
/** 官方子代理传输层的注册名。`spawn` 每次新建独立上下文，与代理语义相符。 */
const SPAWN_PROVIDER = 'spawn';
/**
 * 取某个子代理会话所属的代理 id。
 * @param sessionId - 子代理的会话 id。
 * @returns 代理 id；没登记过时返回 undefined（装配期据此退回默认面）。
 */
export function agentOfChildSession(sessionId) {
    return agentByChildSession.get(sessionId);
}
/**
 * 记下「这个子代理属于哪个代理」。同一会话重复登记时以最新一次为准。
 *
 * 除内部路径外也导出给自检用：可续子代理的"精确登记"就是这条路（见派活代码），
 * 自检需要它来造出「映射已建立」的状态。
 *
 * @param sessionId - 子代理的会话 id。
 * @param agentId - 代理 id。
 */
export function noteChildAgent(sessionId, agentId) {
    if (agentByChildSession.has(sessionId))
        agentByChildSession.delete(sessionId);
    agentByChildSession.set(sessionId, agentId);
    while (agentByChildSession.size > MAX_TRACKED_CHILDREN) {
        const oldest = agentByChildSession.keys().next().value;
        agentByChildSession.delete(oldest);
    }
}
/**
 * 按父会话从待认领队列里认领一个刚创建的子代理，并记进映射表。
 *
 * @param claim - `{ childId, parentSessionId }`。
 * @returns 认领到的代理 id；队列里没有该父会话的项时 undefined。
 */
export function claimChildAgent({ childId, parentSessionId }) {
    const index = pendingClaims.findIndex((claim) => claim.parentSessionId === parentSessionId);
    if (index === -1)
        return undefined;
    const [claim] = pendingClaims.splice(index, 1);
    noteChildAgent(childId, claim.agentId);
    return claim.agentId;
}
/**
 * 把一次即将发生的创建放进待认领队列。
 * @param parentSessionId - 派活方的会话 id。
 * @param agentId - 要派出去的代理 id。
 * @returns 队列项，供失败时移除。
 */
function enqueueClaim(parentSessionId, agentId) {
    const claim = { parentSessionId, agentId };
    pendingClaims.push(claim);
    while (pendingClaims.length > MAX_PENDING_CLAIMS)
        pendingClaims.shift();
    return claim;
}
/** 移除一个队列项（start 失败、或精确路径已用不上的时候）。 */
function dropClaim(claim) {
    const index = pendingClaims.indexOf(claim);
    if (index !== -1)
        pendingClaims.splice(index, 1);
}
/**
 * 取一个调用者 agent 名下的子代理配置清单。
 * @param config - 插件配置。
 * @param agentId - 调用者所属的代理 id；undefined 时返回空数组。
 * @returns 代理配置数组（悬空引用已滤掉）。
 */
function subagentsOf(config, agentId) {
    const owner = agentById(config, agentId);
    if (owner === undefined)
        return [];
    const children = [];
    for (const childId of owner.children ?? []) {
        const child = agentById(config, childId);
        if (child !== undefined)
            children.push(child);
    }
    return children;
}
/**
 * 解析调用者 agent 所属的代理 id——判「谁的名册可以派」。
 *
 * 子代理优先（映射表 / 兜底认领），主代理走预设绑定。
 *
 * @param ctx - 插件所在的 context。
 * @param settingsScope - 本插件设置命名空间的 scope。
 * @param agent - 调用方的 agent。
 * @returns 代理 id；子代理未登记且预设未绑定时 undefined。
 */
function ownerAgentIdFor(ctx, settingsScope, agent) {
    const a = agent;
    const session = a?.session;
    const sessionId = typeof session?.id === 'string' ? session.id : undefined;
    const parentSessionId = session?.header?.parentSession;
    if (sessionId !== undefined) {
        const known = agentOfChildSession(sessionId);
        if (known !== undefined)
            return known;
        if (typeof parentSessionId === 'string') {
            const claimed = claimChildAgent({ childId: sessionId, parentSessionId });
            if (claimed !== undefined)
                return claimed;
        }
    }
    return boundAgentId(settingsScope.get(), resolvePresetId(ctx, a?.ctx));
}
/**
 * 一行描述一个子代理，供 `studio_list_subagents` 渲染给模型。
 * @param agentConfig - 子代理的配置。
 */
function describeSubagent(agentConfig) {
    const model = agentConfig?.model ?? {};
    const route = model.provider === undefined || model.model === undefined
        ? '继承本会话'
        : `${model.provider}/${model.model}`;
    const name = agentConfig?.name !== '' ? agentConfig.name : agentConfig?.id;
    const note = agentConfig?.note !== '' ? `：${agentConfig.note}` : '';
    const background = agentConfig?.background ?? 'model-decides';
    return `- ${agentConfig?.id} — ${name}${note}（模型 ${route} · 后台 ${background}）`;
}
/**
 * 把代理配置翻译成官方启动参数。
 *
 * 只翻译**启动时能定下来的**那些：模型路由在这里定；提示词面留给装配期；工具面在
 * 创建窗口挂（`agent/created`，见 `apply.js`）——那两样要改的是子代理的段与视图，
 * 不是启动参数。
 *
 * @param agentConfig - 子代理的配置。
 * @param label - 给这次的显示名。
 * @param parent - 派活的父 agent。
 * @param signal - 取消信号。
 * @returns 可直接交给 `ctx.subagents.start()` 的请求对象。
 */
function startRequestFor(agentConfig, label, parent, signal) {
    const model = agentConfig?.model ?? {};
    const request = {
        label,
        prompt: [],
        parent,
        signal,
    };
    // provider 与 model 必须成对给：只配一半是配置错误，让平台的校验把它报出来，
    // 不在这里猜另一半（猜错等于悄悄用了别的模型）。
    if (model.provider !== undefined && model.model !== undefined) {
        request.agentOptions = {
            provider: model.provider,
            model: model.model,
            ...model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort },
        };
    }
    return request;
}
/**
 * 挂上两个派活工具。
 *
 * 由调用方在 `settings` 服务就绪后调用；`tools` 或 `subagents` 缺席时（纯 CLI 组合）
 * 只是不挂工具，观察层与生效层照常工作。
 *
 * **取 tools 必须走 `ctx.get('tools')`，不能写 `ctx.tools`。** cordis 只允许访问
 * 在 `inject` 里声明过的服务，而本插件只声明了 `settings`，于是 `ctx.tools` 一读就抛
 * `cannot get property "tools" without inject`。这个抛错的代价远不止派活工具不挂：
 * 调用它的注入回调在 `settings.register` **之后**才抛，而注册的登记挂在一个 effect 上，
 * 回调抛错会连登记一起回滚——表现成**读配置正常、写配置报「settings namespace not
 * registered」**（2026-09-16 在 web profile 上撞到，回查日志才发现从 2026-09-15 起
 * 每次启动都在报）。
 *
 * @param ctx - 插件所在的 context。
 * @param logger - 用于报错与诊断的 logger。
 * @param settingsScope - 本插件设置命名空间的 scope。
 */
export function mountDelegation(ctx, logger, settingsScope) {
    const tools = ctx.get?.('tools');
    if (tools?.register === undefined) {
        logger.info?.('[agent-studio] 工具服务缺席，派活工具不挂');
        return;
    }
    tools.register(defineTool({
        name: 'studio_list_subagents',
        description: 'List the subagents this agent can hand work out to.'
            + ' Each line gives an agent id, what it is for, and its model/background policy.'
            + ' Pass one of those ids as `agent` to `studio_delegate` to hand work out.'
            + ' The roster is per-agent: the main agent of a preset lists its own subagents,'
            + ' and a subagent lists its own children.',
        parameters: {},
        output: {
            schema: { type: 'string' },
            render: (_args, result) => [{ type: 'text', text: result }],
        },
        async execute(_args, exec) {
            const ownerId = ownerAgentIdFor(ctx, settingsScope, exec.agent);
            if (ownerId === undefined) {
                return '当前会话没有可用的代理配置（预设未绑定主代理，或子代理未登记）。';
            }
            const roster = subagentsOf(settingsScope.get(), ownerId);
            const lines = roster.map((child) => describeSubagent(child));
            if (lines.length === 0)
                return `代理「${ownerId}」名下还没有可派的子代理。`;
            return `代理「${ownerId}」名下的子代理：\n${lines.join('\n')}`;
        },
    }));
    tools.register(defineTool({
        name: 'studio_delegate',
        description: 'Hand a self-contained task to one of this agent\'s named subagents.'
            + ' Call `studio_list_subagents` first and pass one of its ids as `agent`.'
            + ' The subagent runs with that agent\'s prompt surface, tool surface and model.'
            + ' When it runs in the background this returns a subagentId: wait for its settlement notice, or'
            + ' steer it with `send_message` — do NOT pass a subagentId to `job_output`, they are different id spaces.',
        parameters: {
            agent: {
                type: 'string',
                required: true,
                description: 'Subagent id from `studio_list_subagents`.',
            },
            prompt: {
                type: 'string',
                required: true,
                description: 'The task for the subagent, written as a self-contained brief: it does not see this conversation.',
            },
            description: {
                type: 'string',
                description: 'A short (3-5 word) label for this delegation, for display.',
            },
            run_in_background: {
                type: 'boolean',
                description: 'Whether to run in the background and return a subagentId immediately. Subagents configured to always run in the background ignore this flag.',
            },
        },
        output: {
            schema: { oneOf: [
                    {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            kind: { type: 'string', required: true, const: 'continuable' },
                            subagentId: { type: 'string', required: true },
                        },
                    },
                    {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            kind: { type: 'string', required: true, const: 'foreground' },
                            runId: { type: 'string', required: true },
                            output: { type: 'array', items: { type: 'json' } },
                        },
                    },
                ] },
            render: (_args, value) => [{
                    type: 'text',
                    text: value.kind === 'continuable'
                        ? `已启动子代理 ${value.subagentId}（后台可续聊，等它结算或用 send_message 追问）`
                        : outputText(value.output),
                }],
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const a = args;
            const callAgent = exec.agent;
            if (callAgent === undefined)
                throw Error('派活需要一个调用者 agent，但 exec.agent 是空的。');
            const config = settingsScope.get();
            const ownerId = ownerAgentIdFor(ctx, settingsScope, callAgent);
            const targetId = typeof a.agent === 'string' ? a.agent : '';
            const targetConfig = subagentsOf(config, ownerId).find((child) => child.id === targetId);
            if (targetConfig === undefined) {
                throw Error(`本代理名下没有子代理「${targetId}」。先调 studio_list_subagents 看看有哪些可用。`);
            }
            const subagents = ctx.get?.('subagents');
            if (subagents?.start === undefined)
                throw Error('子代理服务未就绪，暂时不能派活。');
            if (subagents.getProvider?.(SPAWN_PROVIDER) === undefined) {
                throw Error(`子代理传输层「${SPAWN_PROVIDER}」没有注册，派活无处可去。`);
            }
            const label = typeof a.description === 'string' && a.description !== ''
                ? a.description
                : targetConfig.name !== '' ? targetConfig.name : targetId;
            const request = startRequestFor(targetConfig, label, callAgent, exec.signal);
            request.prompt = [{ type: 'text', text: String(a.prompt ?? '') }];
            // 「始终后台」不看模型的开关；「交给 AI 决定」才看；「前台等待」一律当场等结果
            const backgroundMode = targetConfig.background ?? 'model-decides';
            const runInBackground = backgroundMode === 'always-background'
                || (backgroundMode === 'model-decides' && a.run_in_background === true);
            const sessionId = callAgent.session?.id;
            if (runInBackground) {
                // 可续子代理支持调用方指定会话 id ⇒ 映射在创建**之前**就写好，零竞态。
                // 队列项是保险（万一这个版本没采纳指定的 id）：返回后清掉。
                const childId = randomUUID();
                const claim = enqueueClaim(sessionId, targetConfig.id);
                noteChildAgent(childId, targetConfig.id);
                try {
                    const started = await subagents.startContinuable({
                        provider: SPAWN_PROVIDER,
                        label,
                        request,
                        signal: exec.signal,
                        childId,
                    });
                    dropClaim(claim);
                    return { kind: 'continuable', subagentId: started.childId };
                }
                catch (err) {
                    dropClaim(claim);
                    throw err;
                }
            }
            const claim = enqueueClaim(sessionId, targetConfig.id);
            let run;
            try {
                run = await subagents.start(SPAWN_PROVIDER, request);
            }
            catch (err) {
                dropClaim(claim);
                throw err;
            }
            // 创建窗口的认领本应已经发生；这里再记一次是最后保险（对第一次装配来不及，
            // 对第二次起有效），顺带清掉可能还没被取走的队列项。
            noteChildAgent(run.id, targetConfig.id);
            dropClaim(claim);
            try {
                const result = await run.result;
                if (result.stopReason !== 'completed') {
                    const detail = result.diagnostic === undefined ? '' : `（${result.diagnostic}）`;
                    throw Error(`子代理没有正常结束：${result.stopReason}${detail}`);
                }
                return { kind: 'foreground', runId: run.id, output: result.output };
            }
            finally {
                // 无论结果如何都要释放这次运行。释放本身极罕见地抛错时它会盖掉上面的异常，
                // 这个取舍是有意的：泄漏一次运行比报错串味更糟。
                await run.dispose();
            }
        },
    }));
    logger.info?.('[agent-studio] 派活工具已挂上 · studio_list_subagents / studio_delegate');
}
/** 从内容块数组里拼出纯文本，用于把子代理的输出回给主模型。 */
function outputText(blocks) {
    if (!Array.isArray(blocks))
        return '（子代理没有返回内容）';
    const texts = blocks
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text);
    return texts.length === 0 ? '（子代理没有返回文本）' : texts.join('');
}
