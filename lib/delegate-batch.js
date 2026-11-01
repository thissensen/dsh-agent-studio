/**
 * 派活层的共享形状与正文构造器：平台结果类型、派活/启动回执项、两份正文。
 *
 * **为什么单独一个模块。** 派活结果正文有两条使用路径：阻塞批当场返回（`delegate.ts` 的
 * `render`）与不阻塞批的启动回执。同一套排版在两处各拼一遍就会漂移——这里收口成唯一一份
 * 构造器；激活与结果项的类型跟着结果走，免得两处各声明一套同形类型。
 *
 * 两份正文落在两处、内容是同一批：**在线那份**（`inlineBatchText`：首行声明总行数与字符数并
 * 给出文件路径、中间是 `batchResultText` 全文、末行写「全文完」）与**文件那份**
 * （`spillFileText`：只放成功项的正文，节标题按原始序号）。阻塞批两份都产出——文件一律写、
 * 全文一律内联。
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
    const subagentId = item.subagentId === undefined ? '' : ` · 子代理 ${item.subagentId}`;
    return `${who}${description} · ${state}${subagentId}`;
}
/**
 * 阻塞批的结果正文：一行统计 + 逐项序号、成败与失败原因（成功项带完整输出）。
 * @param items - 按输入顺序排好的结果项。
 * @param config - 插件配置（取代理显示名用）。
 */
export function batchResultText(items, config) {
    const succeeded = items.filter((item) => item.ok).length;
    const lines = [`批量派活结果：共 ${items.length} 项（${succeeded} 成功 · ${items.length - succeeded} 失败）`];
    for (const [index, item] of items.entries()) {
        const state = item.ok ? '成功' : '失败';
        lines.push('', `【${index + 1}】${itemBody(item, state, config)}`);
        if (!item.ok)
            lines.push(`失败原因：${item.error}`);
        if (item.output !== undefined)
            lines.push(outputText(item.output));
    }
    return lines.join('\n').trimEnd();
}
/**
 * 阻塞批的在线正文：**首行声明 + 整批正文 + 末行「全文完」**。
 *
 * 为什么要首末两行：正文一律内联之后，模型得能一眼看出「手上这份是完整的」——首行报总行数与
 * 字符数并指出同一份落在哪个文件，末行再收一次口。行数按 `batchResultText` 的换行切分
 * （空行也算一行），字符数取它自己的 `length`：两个数只在这里算一次，文件与在线才对得上。
 *
 * 写文件失败时首行换成「文件没写成（原因）」：正文照旧全文在线，末行不改。
 * @param items - 按输入顺序排好的结果项。
 * @param config - 插件配置（取代理显示名用）。
 * @param write - 写文件的结局：`filePath` = 写成了；`fileError` = 没写成的原因（两者只有一个有值）。
 */
export function inlineBatchText(items, config, write) {
    const 正文 = batchResultText(items, config);
    const 总行数 = 正文.split('\n').length;
    const 首行 = write.filePath === undefined
        ? `文件没写成（${write.fileError}）`
        : `以下为本批完整正文（共 ${总行数} 行 · ${正文.length} 字符）；同一份已整份写进 ${write.filePath}`;
    return [首行, 正文, `（全文完，共 ${总行数} 行）`].join('\n');
}
/**
 * 整批正文写进文件的那一份：只有成功项的正文，节标题按**原始序号**与在线锚点对齐。
 *
 * 只放成功且有正文的项（`ok && output !== undefined`）：失败项与没有输出块的项都没有正文，
 * 它们那一句原因/锚点已经在对话里的索引行上写过了。序号留空档（跳过
 * 失败项也不重排）：模型按节标题的编号就能把文件里的正文对回对话里的那一项。
 * @param items - 按输入顺序排好的结果项。
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
        lines.push('', `【${index + 1}】${itemBody(item, state, config)}`);
        if (item.error !== undefined)
            lines.push(`失败原因：${item.error}`);
    }
    return lines.join('\n').trimEnd();
}
// ── 项构造器（阻塞批归并 / 启动回执共用）───────────────────────────────────
/**
 * 结算结局 → 结果项。失败文案与「有值才写键」只有一份。
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
