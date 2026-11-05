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
 * ## 批量是唯一入口，等不等看目标的后台档
 *
 * 一次调用永远是一批 `tasks`（派一个也写成一项数组），**等不等由目标代理自己的后台档
 * 决定**，不由参数决定：
 *
 *   - 整批一项「阻塞」档都没有 ⇒ 逐项以 `delivery: 'parent'` 启动，立刻返回
 *     `{ kind: 'started', items }`；每个子代理跑完由平台**逐条**发结算通知，调用方接着干别的。
 *   - 至少有一项是「阻塞」档（`background === 'foreground'`）⇒ 整批以 `delivery: 'caller'`
 *     启动，全部起来之后 `Promise.allSettled` 一起等，再返回
 *     `{ kind: 'foreground-batch', results }`——按输入顺序，每项写明成功/失败与原因。
 *
 * 判定是 **OR**：一项阻塞就整批阻塞。一批里混着两种档位时，若只等阻塞那几项，不阻塞那几项
 * 的结果就没人接收了。`undefined` 与 `'always-background'` 都不阻塞。
 *
 * ## 一律转存：文件一份，对话里只留落点
 *
 * 一批阻塞派活的正文能长到进不了对话：平台对单条工具结果有内联上限，超了模型拿到的是被
 * 自己 `JSON.stringify(...).slice(0, 20000)` 切过的半截，而它并不知道少了后半截。
 *
 * 口径（v2.1，用户定）：**每个阻塞批都写一个文件**（不管多短；文件只收成功项的正文），对话里
 * 只留落点行、子代理会话 id 行与失败项清单，**正文一个字都不进对话**。返回值里的结果项同样
 * 不带正文：写盘前就把 `output` 摘掉，正文只活在盘上那份文件里。不再判「超没超
 * 平台上限」，也不再读那个上限：读法会随平台升版静默失效，而失效后的行为（每批都写）与
 * 一律写没有区别，留一条分支只是多一个无声的岔路。写不进去时落点行换成
 * 「文件没写成（原因）」，**也不回填正文**（不兜底：这一批的正文就是没写下来）。
 *
 * 为什么不写在 `render` 里：`render` 是同步的，写盘只能在 `execute` 里做。
 *
 * **取消不做 partial**：PTC 超时会取消整批阻塞等待，那时返回物根本到不了模型手里，所以把
 * 第一个 rejection 包一层中文指路上抛，不拼半批结果。不阻塞批不受影响：它们的子代理已经
 * 脱离这次调用，在平台上自己跑。
 *
 * **dispose 只在阻塞批做**：阻塞批的激活由这次调用自己持有，`finally` 里逐项释放（子代理
 * 自然结算时平台已幂等关过）；不阻塞批一个都不释放——释放等于把还在跑的子代理掐掉，交给
 * 平台自然收尾。
 *
 * **启动失败逐项报**：一项没起来只让它落成失败项（阻塞批 `ok: false`、不阻塞批带 `error`
 * 的启动项），其余照常；一项都没起来才整次抛第一个启动错误。
 *
 * @module dsh-agent-studio/delegate
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { agentById, boundAgentId } from './config.js';
import { batchResultText, errorText, settledItem, spillFileText, startFailureItem, startedItem, startedText, } from './delegate-batch.js';
import { resolvePresetId } from './preset.js';
/**
 * 子代理会话 → 代理 id 的映射。
 *
 * 装配期与创建窗口都靠它判「我是谁」；`apply.js` 通过 `agentOfChildSession()` 读。
 */
const agentByChildSession = new Map();
/** 映射表上限。可续接子代理可以长期活着，不设上限会一路涨上去。 */
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
 * 代理的显示名：有名字用名字，没名字退回 id。
 * @param agentConfig - 代理的配置。
 * @returns 显示名；连代理都没有时是空串（调用方自己决定怎么补）。
 */
function agentDisplayName(agentConfig) {
    const name = agentConfig?.name;
    return name !== undefined && name !== '' ? name : agentConfig?.id ?? '';
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
    const name = agentDisplayName(agentConfig);
    const note = agentConfig?.note !== '' ? `：${agentConfig.note}` : '';
    const background = agentConfig?.background ?? 'always-background';
    return `- ${agentConfig?.id} — ${name}${note}（模型 ${route} · 后台 ${background}）`;
}
/**
 * 把调用账摊成共享的「一项派活素材」：结果项与启动回执项都从同一份走。
 * @param record - 这一次调用里某项的账。
 */
function noteOf(record) {
    return {
        agent: record.target.agentId,
        subagentId: record.activation?.childId,
        description: record.target.description,
        startError: record.startError,
    };
}
/**
 * 把代理配置翻译成官方启动规格。
 *
 * 只翻译**启动时能定下来的**那些：模型路由在这里定；提示词面留给装配期；工具面在
 * 创建窗口挂（`agent/created`，见 `apply.js`）——那两样要改的是子代理的段与视图，
 * 不是启动参数。`childId` / `delivery` / `request.prompt` 留给调用点补：`delivery` 取决于
 * 这一批整体阻不阻塞。
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
            const config = settingsScope.get();
            const roster = subagentsOf(config, ownerId);
            const lines = roster.map((child) => describeSubagent(child));
            if (lines.length === 0)
                return `代理「${ownerId}」名下还没有可派的子代理。`;
            return `代理「${ownerId}」名下的子代理：\n${lines.join('\n')}`;
        },
    }));
    tools.register(defineTool({
        name: 'studio_delegate',
        description: 'Hand a self-contained task to one of this agent\'s subagents.',
        parameters: {
            tasks: {
                type: 'array',
                required: true,
                description: 'One entry per subagent — a single dispatch is a one-entry array. Entries start together; whether this call waits depends on each target agent\'s own background mode. A waiting call writes the batch\'s successful bodies to a file under the system temp dir; the text you see carries only that path plus any failed entries. A non-waiting call writes no file.',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        agent: { type: 'string', required: true, description: 'Subagent id from `studio_list_subagents`.' },
                        prompt: { type: 'string', required: true, description: 'The task for this subagent, written as a self-contained brief: it does not see this conversation.' },
                        description: { type: 'string', description: 'A short (3-5 word) label for this entry, shown in the answer.' },
                    },
                },
            },
        },
        output: {
            schema: { oneOf: [
                    {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            kind: { type: 'string', required: true, const: 'started' },
                            items: {
                                type: 'array',
                                required: true,
                                items: {
                                    type: 'object',
                                    additionalProperties: false,
                                    properties: {
                                        agent: { type: 'string', required: true },
                                        subagentId: { type: 'string' },
                                        description: { type: 'string' },
                                        error: { type: 'string' },
                                    },
                                },
                            },
                        },
                    },
                    {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            kind: { type: 'string', required: true, const: 'foreground-batch' },
                            results: {
                                type: 'array',
                                required: true,
                                items: {
                                    type: 'object',
                                    additionalProperties: false,
                                    properties: {
                                        agent: { type: 'string', required: true },
                                        subagentId: { type: 'string' },
                                        ok: { type: 'boolean', required: true },
                                        description: { type: 'string' },
                                        error: { type: 'string' },
                                    },
                                },
                            },
                            filePath: { type: 'string' },
                            fileError: { type: 'string' },
                        },
                    },
                ] },
            render: (_args, value) => {
                const result = value;
                if (result.kind === 'started') {
                    return [{ type: 'text', text: startedText(result.items, settingsScope.get()) }];
                }
                // 写盘只能在 execute 里做（render 是同步的），这里只把「落点行 + 失败项」拼一次。
                const 对话正文 = batchResultText(result.results, settingsScope.get(), { filePath: result.filePath, fileError: result.fileError });
                return [{ type: 'text', text: 对话正文 }];
            },
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const a = args;
            const callAgent = exec.agent;
            if (callAgent === undefined)
                throw Error('派活需要一个调用者 agent，但 exec.agent 是空的。');
            const config = settingsScope.get();
            const ownerId = ownerAgentIdFor(ctx, settingsScope, callAgent);
            const roster = subagentsOf(config, ownerId);
            // 参数校验在任何副作用之前做完：下面每道守卫命中时，一个子代理都还没启动。
            if (!Array.isArray(a.tasks)) {
                throw Error('派活参数不对：现在只有 tasks 一种入口（数组），派一个也写成一项，每项是 agent + prompt。');
            }
            if (a.tasks.length === 0) {
                throw Error('tasks 是空的：至少要给一项，每项都是 agent + prompt。');
            }
            const targets = [];
            for (const [index, task] of a.tasks.entries()) {
                const agentId = typeof task?.agent === 'string' ? task.agent : '';
                if (agentId === '') {
                    throw Error(`tasks 第 ${index + 1} 项缺少 agent：每项都要给一个 studio_list_subagents 里的 id。`);
                }
                const agentConfig = roster.find((child) => child.id === agentId);
                if (agentConfig === undefined) {
                    throw Error(`本代理名下没有子代理「${agentId}」（tasks 第 ${index + 1} 项）。先调 studio_list_subagents 看看有哪些可用。`);
                }
                const prompt = typeof task?.prompt === 'string' ? task.prompt : '';
                if (prompt === '') {
                    throw Error(`tasks 第 ${index + 1} 项缺少 prompt：每项都要给一段完整任务说明（子代理看不到这段对话）。`);
                }
                const description = typeof task?.description === 'string' && task.description !== ''
                    ? task.description
                    : undefined;
                targets.push({
                    agentConfig,
                    agentId,
                    description,
                    prompt,
                });
            }
            const subagents = ctx.get?.('subagents');
            if (subagents?.startActivation === undefined)
                throw Error('子代理服务未就绪，暂时不能派活。');
            // 预生成的会话 id 只有 local 后端认：没有 prepareContinuable 的传输层会直接抛
            // UNSUPPORTED_CAPABILITY ⇒ 在派活前挡下，给人话。
            if (subagents.getProvider?.(SPAWN_PROVIDER)?.prepareContinuable === undefined) {
                throw Error(`子代理传输层「${SPAWN_PROVIDER}」没注册或不支持可续接子代理，派活无处可去。`);
            }
            // 整批阻塞判定是 OR：一项「前台等待」就足以让整批变成阻塞批。
            const isBlockingBatch = targets.some((item) => item.agentConfig.background === 'foreground');
            const signal = exec.signal;
            const records = [];
            let firstDisposeError = undefined;
            try {
                // 逐个启动：启动本身很快，子代理一起来就自己跑，总耗时由最慢的那一个决定。
                for (const [index, target] of targets.entries()) {
                    const label = target.description ?? agentDisplayName(target.agentConfig);
                    const spec = activationSpecFor(target.agentConfig, label, callAgent, signal);
                    // 阻塞批要结果还给这次调用（当场等）；不阻塞批要平台把结算通知逐条投给父模型。
                    spec.delivery = isBlockingBatch ? 'caller' : 'parent';
                    spec.request.prompt = [{ type: 'text', text: target.prompt }];
                    // 预生成会话 id ⇒ 映射在创建**之前**写好，零竞态：`startActivation` 采纳调用方
                    // 指定的 `childId`（不支持的传输层已由上面那道守卫挡下）。
                    const childId = randomUUID();
                    spec.childId = childId;
                    noteChildAgent(childId, target.agentId);
                    try {
                        records.push({ index, target, activation: await subagents.startActivation(spec) });
                    }
                    catch (err) {
                        const detail = errorText(err);
                        const hint = detail.includes('ACTIVATION_LIMIT_REACHED')
                            ? '（平台活跃子代理名额已满：把这一项拆成单独一次 studio_delegate 重派，或等前面的子代理结束后再派）'
                            : '';
                        records.push({ index, target, startError: `派活没起来：${detail}${hint}` });
                    }
                }
                const launched = records.filter((record) => record.activation !== undefined);
                // 一项都没起来 ⇒ 没有可等的对象：整次抛第一个启动错误，不返回一张空回执。
                if (launched.length === 0)
                    throw Error(records[0].startError);
                if (!isBlockingBatch) {
                    return { kind: 'started', items: records.map((record) => startedItem(noteOf(record))) };
                }
                // 全部起来之后一次性等结算：并发在平台侧（子代理各自跑），这里只等它们各自落地。
                const settled = await Promise.allSettled(launched.map((record) => record.activation.result));
                const results = new Map();
                let cancelReason = undefined;
                for (const [position, outcome] of settled.entries()) {
                    const record = launched[position];
                    if (outcome.status === 'rejected' && signal?.aborted === true) {
                        if (cancelReason === undefined)
                            cancelReason = outcome.reason;
                        continue;
                    }
                    results.set(record.index, settledItem(noteOf(record), outcome));
                }
                // 取消不做 partial：原始 rejection 包一层中文指路上抛，整次调用失败。
                if (cancelReason !== undefined) {
                    throw Error(`这一批被取消或超时了（${errorText(cancelReason)}）；想等更久，把「突破 PTC 120 秒限制」打开。`, { cause: cancelReason });
                }
                // 启动失败项在这里补。「每项都有结果」的校验必须在补完之后，否则一次正常的
                // 「名额已满」会让整批误报成内部错误。
                for (const record of records) {
                    if (record.startError === undefined)
                        continue;
                    results.set(record.index, startFailureItem(noteOf(record), record.startError));
                }
                if (results.size !== targets.length)
                    throw Error('批量派活内部错误：有任务没拿到结果。');
                const 结果组 = targets.map((_target, index) => results.get(index));
                // 对外项摘掉正文：正文只在盘上那份文件里，写盘失败也不回填（不兜底）。必须用解构
                // 删键，不能写 `output: undefined`——平台对返回值做 lossless JSON 快照，值为
                // undefined 的键会让整次输出判非法（坑册坑 55）。
                const 对外结果组 = 结果组.map(({ output: _正文, ...item }) => item);
                // 目录与平台 spill 同构（会话 id 短哈希），但不复用它那个私有根（那是它自己 mkdtemp 出来的）。
                // 文件名取 UTC 时间戳：纯 ASCII、字典序即时间序。不主动清理——文件是给模型读的。
                const 会话id = callAgent.session?.id ?? '';
                const 目录 = join(tmpdir(), 'dsh-agent-studio', createHash('sha256').update(会话id).digest('hex').slice(0, 12));
                const 时间戳 = new Date().toISOString().slice(0, 23).replace(/[-:]/g, '').replace('T', '-').replace('.', '-');
                const 文件路径 = join(目录, `delegate-${时间戳}.md`);
                try {
                    await mkdir(目录, { recursive: true });
                    await writeFile(文件路径, spillFileText(结果组, config), 'utf8');
                    return { kind: 'foreground-batch', results: 对外结果组, filePath: 文件路径 };
                }
                catch (err) {
                    // 写不进去就只改落点行：正文不回填进返回值（不兜底），这一批的正文就是没写下来。
                    return { kind: 'foreground-batch', results: 对外结果组, fileError: errorText(err) };
                }
            }
            finally {
                // 释放这一次激活。子代理自然结算时平台已经自己关掉它（幂等），这里兜的是「结果
                // 已到、收尾还没走完」与异常路径——激活常驻会占住 maxActiveSubagents 的名额
                // （默认 8）。释放本身极罕见地抛错时它会盖掉上面的异常，这个取舍是有意的。
                // 只有阻塞批释放：不阻塞批的激活一释放就等于把还在平台上跑的子代理掐掉。
                if (isBlockingBatch) {
                    for (const record of records) {
                        if (record.activation === undefined)
                            continue;
                        try {
                            await record.activation.dispose();
                        }
                        catch (err) {
                            if (firstDisposeError === undefined)
                                firstDisposeError = err;
                        }
                    }
                    if (firstDisposeError !== undefined)
                        throw firstDisposeError;
                }
            }
        },
    }));
    logger.info?.('[agent-studio] 派活工具已挂上 · studio_list_subagents / studio_delegate');
}
