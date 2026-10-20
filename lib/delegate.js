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
 * ## 身份登记
 *
 * 「子代理会话 → 代理」的映射必须**早于子代理的第一次装配**建好，否则装配期的段拼接
 * 查不到身份、退回默认面（2026-09-16 实测的「配了没用」根因：那次登记发生在派活调用返回
 * 之后，而前台派活要等整个 turn 跑完才返回）。
 *
 * 唯一一条登记路径是**派活前预生成会话 id**：`startActivation` 接受调用方指定的
 * `childId`（只有 local 后端采纳，派活前用 `prepareContinuable` 守卫把不支持的传输层
 * 挡下），所以映射在调用**前**就写好了——零竞态。`agent/created`（挂工具面）与装配期
 * （拼段）都只查这张表，没有第二条补建路径。
 *
 * **已知边界**：映射只在内存里。DSH 重启后旧子会话的映射丢失 ⇒ 该子代理的装配退回
 * 默认面；续聊仍可用（会话 id 不变），但不再按原代理面收窄。
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
/** 映射表上限。continuable 子代理可以长期活着，不设上限会一路涨上去。 */
const MAX_TRACKED_CHILDREN = 200;
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
 * 除内部路径外也导出给自检用：派活前的「精确登记」就是这条路（见派活代码），
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
 * 子代理优先（查映射表），主代理走预设绑定。
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
    if (sessionId !== undefined) {
        const known = agentOfChildSession(sessionId);
        if (known !== undefined)
            return known;
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
 * 把代理配置翻译成官方启动规格。
 *
 * 只翻译**启动时能定下来的**那些：模型路由在这里定；提示词面留给装配期；工具面在
 * 创建窗口挂（`agent/created`，见 `apply.js`）——那两样要改的是子代理的段与视图，
 * 不是启动参数。`childId` / `delivery` / `request.prompt` 留给调用点补：它们的取值
 * 取决于这一档后台模式。
 *
 * @param agentConfig - 子代理的配置。
 * @param label - 给这次的显示名。
 * @param parent - 派活的父 agent。
 * @param signal - 取消信号。
 * @returns 可直接交给 `ctx.subagents.startActivation()` 的规格骨架。
 */
function activationSpecFor(agentConfig, label, parent, signal) {
    const model = agentConfig?.model ?? {};
    const spec = {
        provider: SPAWN_PROVIDER,
        label,
        childId: '',
        request: { prompt: [], parent },
        signal,
        delivery: 'caller',
    };
    // provider 与 model 必须成对给：只配一半是配置错误，让平台的校验把它报出来，
    // 不在这里猜另一半（猜错等于悄悄用了别的模型）。
    if (model.provider !== undefined && model.model !== undefined) {
        spec.request.agentOptions = {
            provider: model.provider,
            model: model.model,
            ...model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort },
        };
    }
    return spec;
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
            + ' Every subagent is a resumable child session, so the returned subagentId is always that session id:'
            + ' in the background, wait for its settlement notice or steer it with `send_message`;'
            + ' a foreground delegation hands back the same kind of id when it finishes.'
            + ' Do NOT pass a subagentId to `job_output` — session ids and job ids are different id spaces.',
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
                            subagentId: { type: 'string', required: true },
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
            if (subagents?.startActivation === undefined)
                throw Error('子代理服务未就绪，暂时不能派活。');
            // 预生成的会话 id 只有 local 后端认：没有 prepareContinuable 的传输层会直接抛
            // UNSUPPORTED_CAPABILITY ⇒ 在派活前挡下，给人话。
            if (subagents.getProvider?.(SPAWN_PROVIDER)?.prepareContinuable === undefined) {
                throw Error(`子代理传输层「${SPAWN_PROVIDER}」没注册或不支持可续接子代理，派活无处可去。`);
            }
            const agentName = typeof targetConfig.name === 'string' && targetConfig.name !== '' ? targetConfig.name : targetId;
            const label = typeof a.description === 'string' && a.description !== '' ? a.description : agentName;
            const spec = activationSpecFor(targetConfig, label, callAgent, exec.signal);
            spec.request.prompt = [{ type: 'text', text: String(a.prompt ?? '') }];
            // 「始终后台」不看模型的开关；「交给 AI 决定」才看；「前台等待」一律当场等结果
            const backgroundMode = targetConfig.background ?? 'model-decides';
            const runInBackground = backgroundMode === 'always-background'
                || (backgroundMode === 'model-decides' && a.run_in_background === true);
            // 后台档要平台把结算通知投给父模型，前台档只要结果还给这次调用
            spec.delivery = runInBackground ? 'parent' : 'caller';
            // 预生成会话 id ⇒ 映射在创建**之前**写好，零竞态：`startActivation` 采纳调用方
            // 指定的 `childId`（不支持的传输层已由上面那道守卫挡下）。
            const agentId = targetConfig.id;
            const childId = randomUUID();
            spec.childId = childId;
            noteChildAgent(childId, agentId);
            const activation = await subagents.startActivation(spec);
            if (runInBackground)
                return { kind: 'continuable', subagentId: activation.childId };
            try {
                const result = await activation.result;
                if (result.stopReason !== 'completed') {
                    const detail = result.diagnostic === undefined ? '' : `（${result.diagnostic}）`;
                    throw Error(`子代理没有正常结束：${result.stopReason}${detail}`);
                }
                return { kind: 'foreground', subagentId: activation.childId, output: result.output };
            }
            finally {
                // 释放这一次激活。子代理自然结算时平台已经自己关掉它（幂等），这里兜的是「结果
                // 已到、收尾还没走完」与异常路径——激活常驻会占住 maxActiveSubagents 的名额
                // （默认 8）。释放本身极罕见地抛错时它会盖掉上面的异常，这个取舍是有意的。
                await activation.dispose();
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
