/**
 * 派活层的共享形状与正文构造器：平台结果类型、派活/启动回执项、两种正文。
 *
 * **为什么单独一个模块。** 派活结果正文有两条使用路径：阻塞批当场返回（`delegate.ts` 的
 * `render`）与不阻塞批的启动回执。同一套排版在两处各拼一遍就会漂移——这里收口成唯一一份
 * 构造器；激活与结果项的类型跟着结果走，免得两处各声明一套同形类型。
 *
 * 两份正文分工不同：**对话那份**（`batchResultText`：一行落点写明文件路径与「几成功几失败」，
 * 一行子代理列出本批每个可续聊的子代理会话，失败项各占一行并带原因，成功项的正文一个字都不进
 * 对话）与**文件那份**（`spillFileText`：只放成功项的正文，节标题按原始序号）。阻塞批两份都
 * 产出——文件一律写、对话只留落点与子代理行。返回值里同样没有正文：`execute` 写盘前就把
 * `output` 摘掉，正文只活在盘上那份 `.md` 里（写盘失败也不回填）。
 *
 * 本模块不注册工具，也不持有任何跨调用的状态：批次的生灭全在平台上——不阻塞批的子代理跑完
 * 由平台逐条发结算通知，插件这边没有需要登记、唤醒或兜底落盘的东西。
 *
 * 依赖方向单向：`delegate.ts` → 本模块。
 *
 * @module dsh-agent-studio/delegate-batch
 */
import { agentById } from './config.js';
// ── 文本构造器（阻塞批正文 / 启动回执共用）──────────────────────────────────
/** 把异常压成一行给人看的文本（子代理失败的原因通常只活在 message 里）。 */
export function errorText(err) {
    return err instanceof Error ? err.message : String(err);
}
/** 子代理没有正常结束时的错误文案。结果项与正文共用同一口径。 */
export function subagentFailureText(result) {
    const detail = result.diagnostic === undefined ? '' : `（${result.diagnostic}）`;
    return `子代理没有正常结束：${result.stopReason}${detail}`;
}
/** 从内容块数组里拼出纯文本，用于把子代理的输出回给主模型。 */
export function outputText(blocks) {
    if (!Array.isArray(blocks))
        return '（子代理没有返回内容）';
    const texts = blocks
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text);
    return texts.length === 0 ? '（子代理没有返回文本）' : texts.join('');
}
/**
 * 一项在人话里的主体：`child-1（翻译） — 译一段 · 成功 · 子代理 <id>`。
 * 结果正文与启动回执共用同一套排版，改一处两处都跟着变。
 */
function itemBody(item, state, config) {
    const displayName = agentById(config, item.agent)?.name;
    const who = displayName === undefined || displayName === '' ? item.agent : `${item.agent}（${displayName}）`;
    const description = item.description === undefined ? '' : ` — ${item.description}`;
    return `${who}${description} · ${state}`;
}
/**
 * 阻塞批在对话里留下的那一段：一行落点（文件路径 + 几成功几失败）+ 一行子代理（本批每个可续聊
 * 的子代理会话，按原始序号）+ 失败项逐行（带原因）。
 *
 * 只剩一套排版：**正文不进对话**。文件那份（`spillFileText`）才是整批正文的容身处，
 * 它按原始序号分节，所以失败项那一行的序号能把模型对回文件里的空档。
 * 成功项连行都不列——它跑成了，正文只在文件里（返回值也不带），对话里再抄一份只会多一套
 * 会漂移的排版。**但它的会话 id 要列**：原生模式下模型没有别的路子
 * 拿到那个 id，拿不到就 `send_message` 续不上这个子代理（启动就没起来的项没有 id，不列）。
 *
 * 写失败时落点行换成「文件没写成（原因）（共 N 项：M 成功 · K 失败）」：原因与统计都留着，
 * 正文照旧不进对话，也不回填到返回值里（不兜底：这一批的正文就是没写下来）。
 * @param items - 按输入顺序排好的结果项。
 * @param config - 插件配置（取代理显示名用）。
 * @param write - 写文件的结局：`filePath` = 写成了；`fileError` = 没写成的原因（两者只有一个有值）。
 */
export function batchResultText(items, config, write) {
    const succeeded = items.filter((item) => item.ok).length;
    const 统计 = `（共 ${items.length} 项：${succeeded} 成功 · ${items.length - succeeded} 失败）`;
    const 落点行 = write.filePath === undefined
        ? `文件没写成（${write.fileError}）${统计}`
        : `本批结果已写入：${write.filePath}${统计}`;
    const 子代理组 = [];
    for (const [index, item] of items.entries()) {
        if (item.subagentId === undefined)
            continue;
        子代理组.push(`【${index + 1}】${item.subagentId}`);
    }
    const 行组 = [落点行];
    if (子代理组.length > 0)
        行组.push(`子代理：${子代理组.join('、')}`);
    for (const [index, item] of items.entries()) {
        if (item.ok)
            continue;
        行组.push(`【${index + 1}】${itemBody(item, `失败 · ${item.error}`, config)}`);
    }
    return 行组.join('\n');
}
/**
 * 整批正文写进文件的那一份：只有成功项的正文，节标题按**原始序号**与对话里的失败行对齐。
 *
 * 只放成功且有正文的项（`ok && output !== undefined`）：失败项与没有输出块的项都没有正文，
 * 它们那一句原因已经在对话的失败行上写过了。序号留空档（跳过失败项也不重排）：模型按节标题
 * 的编号就能把文件里的正文对回对话里点名的那一项。
 * @param items - 按输入顺序排好的内部结果项（带正文）。
 * @param config - 插件配置（取代理显示名用）。
 */
export function spillFileText(items, config) {
    const sections = [];
    for (const [index, item] of items.entries()) {
        if (!item.ok || item.output === undefined)
            continue;
        const body = outputText(item.output);
        const head = itemBody({ agent: item.agent, description: item.description }, `成功 · ${body.length} 字符`, config);
        sections.push(`## 【${index + 1}】${head}\n\n${body}`);
    }
    return `${sections.join('\n\n')}\n`;
}
/**
 * 不阻塞批的启动回执正文：写明**已经在跑**、每项跑完会各自发一条结算消息、别重复派同一批。
 * @param items - 启动回执项（按输入顺序，含启动就失败的那些）。
 * @param config - 插件配置（取代理显示名用）。
 */
export function startedText(items, config) {
    const started = items.filter((item) => item.subagentId !== undefined).length;
    const failed = items.length - started;
    const headline = failed === 0
        ? `已启动 ${started} 个`
        : `已启动 ${started} 个（${failed} 项启动失败）`;
    const lines = [
        `${headline}：每个子代理跑完会各自发一条结算消息给你，带着它的完整输出；这期间可以接着做别的事，不要重复派同一批活。`,
    ];
    for (const [index, item] of items.entries()) {
        const state = item.error === undefined ? '已启动' : '启动失败';
        const 状态 = item.subagentId === undefined ? state : `${state} · 子代理 ${item.subagentId}`;
        lines.push('', `【${index + 1}】${itemBody(item, 状态, config)}`);
        if (item.error !== undefined)
            lines.push(`失败原因：${item.error}`);
    }
    return lines.join('\n').trimEnd();
}
// ── 项构造器（阻塞批归并 / 启动回执共用）───────────────────────────────────
/**
 * 结算结局 → 结果项。失败文案与「有值才写键」只有一份。
 *
 * 返回的是**内部项**（`DelegateBatchEntry`）：正文留在 `output` 上给写文件用，对外返回前由
 * `execute` 摘掉。
 * @param note - 这一项的素材。
 * @param outcome - 这一项激活的结算结局。
 */
export function settledItem(note, outcome) {
    if (outcome.status === 'rejected') {
        return {
            agent: note.agent,
            ...note.subagentId === undefined ? {} : { subagentId: note.subagentId },
            ok: false,
            ...note.description === undefined ? {} : { description: note.description },
            error: `子代理运行中断：${errorText(outcome.reason)}`,
        };
    }
    const result = outcome.value;
    const ok = result.stopReason === 'completed';
    return {
        agent: note.agent,
        ...note.subagentId === undefined ? {} : { subagentId: note.subagentId },
        ok,
        ...note.description === undefined ? {} : { description: note.description },
        ...result.output === undefined ? {} : { output: result.output },
        ...ok ? {} : { error: subagentFailureText(result) },
    };
}
/**
 * 启动就没起来的一项：**没有** `subagentId` 键（不给模型一个能 send_message 的死目标）。
 * @param note - 这一项的素材。
 * @param reason - 启动失败的原因（调用方从同一份账里取，恒有值）。
 */
export function startFailureItem(note, reason) {
    return {
        agent: note.agent,
        ok: false,
        ...note.description === undefined ? {} : { description: note.description },
        error: reason,
    };
}
/**
 * 不阻塞批的启动回执项：`startError` 在 ⇒ 只有 `error`；否则带 `subagentId`。
 * @param note - 这一项的素材。
 */
export function startedItem(note) {
    if (note.startError !== undefined) {
        return {
            agent: note.agent,
            ...note.description === undefined ? {} : { description: note.description },
            error: note.startError,
        };
    }
    return {
        agent: note.agent,
        ...note.subagentId === undefined ? {} : { subagentId: note.subagentId },
        ...note.description === undefined ? {} : { description: note.description },
    };
}
