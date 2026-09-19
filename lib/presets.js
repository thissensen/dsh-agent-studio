/**
 * 预设管理：列出平台上的预设、复制一份、删除一份。
 *
 * 全部走官方服务（`ctx.get('agentPresets')`）——**插件不自己写预设文件**。复制是平台
 * 提供的唯一写入口，调用方只能传「源 id + 新 id + 可选显示名」，永远不提供 composition
 * 文本：一次复制因此不会授予被复制预设尚未携带的能力。删除也由平台判权限，随部署提供的
 * 预设一律拒绝（`agent-preset/read-only`），只有用户预设可删。
 *
 * **一处例外（2026-09-18 用户点名）**：平台的复制 API 只收显示名，描述只能从源预设
 * 原样继承，用户在「新建预设」时写不了自己的描述。为此 `writePresetMetadata()` 会在
 * 复制成功后往**刚落盘的新预设目录**里补一份 `preset.yml`（只写 name/description
 * 两个给人看的标量，不碰 `agent.cordis.yml`，也不碰任何既有预设）——边界与理由
 * 见那个函数的注释。
 *
 * 「来源」分三档：`shipped`（部署自带，只读）· `plugin`（本插件复制出来的）· `user`
 * （用户自己写的）。平台只给 `trust: 'system' | 'user'` 两档，第三档由插件记在自己配置的
 * `createdPresets` 里补出来——界面靠它提醒用户哪些是这里建出来的。
 *
 * 会话记录里粘着预设 id（目录名），改名会让旧会话打不开，所以本插件**不提供重命名**。
 *
 * @module dsh-agent-studio/presets
 */
import { readFileSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { SETTINGS_NAMESPACE } from './config.js';
import { json, readJsonBody, validateMutationRequest } from './http-guard.js';
/**
 * 读一个预设的 composition，看它的 persona 声明了哪两个开关。
 *
 * **为什么要读文件**（2026-09-18 查证）：平台不给这个信息。`compositionInventory()`
 * 的行只有 `entryId / moduleName / enabled / condition`（**不含 config**），`preset.yml`
 * 只有 name / description / order；而 4 个官方预设（`cordis` / `minimal` / `ptc` /
 * `standard`）**全都**用 `dsh-persona`，拿模块名当判据必然 4/4 误报。所以只能读
 * composition 本体（`list()` 原始行上的 `path`）。
 *
 * **不引 YAML 依赖**：只做**检测**，不解析——定位 `dsh-persona` 的 `name:` 行，往下扫到
 * 下一个缩进不深于它的 `name:` 行为止（嵌套 group 里的 `name:` 缩得更深，不会误截），
 * 看这一段里有没有那两个键。判错只影响界面灰不灰，不影响装配，够用即可。
 *
 * 读不到就都当 `false`（= 不禁用界面）：宁可少灰一层，也不能让面板报错。
 *
 * @param path - `list()` 原始行上的 `path`（composition 文件的绝对路径）。
 * @returns 两个开关；找不到 `dsh-persona` 时都是 `false`。
 */
function readPersonaFlags(path) {
    const off = { promptFixed: false, snapshotFixed: false };
    if (typeof path !== 'string')
        return off;
    let text;
    try {
        text = readFileSync(path, 'utf8');
    }
    catch {
        return off;
    }
    const lines = text.split('\n');
    const NAME_LINE = /^(\s*)name:\s*(.+?)\s*$/;
    for (let i = 0; i < lines.length; i += 1) {
        const hit = NAME_LINE.exec(lines[i]);
        if (hit === null || hit[2].includes('dsh-persona') !== true)
            continue;
        const indent = hit[1].length;
        const flags = { ...off };
        for (let j = i + 1; j < lines.length; j += 1) {
            const sibling = NAME_LINE.exec(lines[j]);
            if (sibling !== null && sibling[1].length <= indent)
                break;
            if (/^\s*complete:\s*true\s*$/.test(lines[j]) === true)
                flags.promptFixed = true;
            if (/^\s*includeRuntimeContext:\s*false\s*$/.test(lines[j]) === true)
                flags.snapshotFixed = true;
        }
        return flags;
    }
    return off;
}
/**
 * 列出平台预设，附上来源与可写性。
 * @param service - `agentPresets` 服务；缺席时返回空清单。
 * @param createdIds - 本插件复制出来的预设 id。
 * @returns 供面板直接渲染的行数组。
 */
export async function listPresets(service, createdIds) {
    if (service?.list === undefined)
        return [];
    const presets = await service.list();
    const created = new Set(createdIds);
    return presets.map((preset) => {
        const isShipped = preset.trust === 'system';
        const flags = readPersonaFlags(preset.path);
        return {
            id: preset.id,
            name: preset.name ?? null,
            description: preset.description ?? null,
            order: preset.order ?? null,
            broken: preset.broken ?? null,
            source: isShipped ? 'shipped' : created.has(preset.id) ? 'plugin' : 'user',
            writable: !isShipped,
            promptFixed: flags.promptFixed,
            snapshotFixed: flags.snapshotFixed,
        };
    });
}
/**
 * 读端点：列出预设。
 * @param res - Node 的响应对象。
 * @param deps - `{ getPresets, getScope }`。
 */
export async function handleListPresets(res, deps) {
    const service = deps.getPresets();
    const createdIds = deps.getScope()?.get()?.createdPresets ?? [];
    let presets = [];
    if (service?.list !== undefined) {
        // HTTP handler 就是这条链的最外层边界。不在这里接住，异常会冒进宿主的 async handler，
        // 而响应永远不回——面板就卡在「正在读取平台预设与观察结果…」上，用户看不到任何原因。
        try {
            presets = await listPresets(service, createdIds);
        }
        catch (err) {
            json(res, 500, { ok: false, error: `读取预设清单失败：${err?.message ?? String(err)}` });
            return;
        }
    }
    json(res, 200, {
        ok: true,
        // 服务缺席（纯 CLI 组合）时判为不可写，界面据此禁用新建/删除，而不是让按钮点了报错
        authorable: service?.authorable === true,
        presets,
    });
}
/**
 * 把新建预设的显示名与描述写进它的 `preset.yml`——**本文件唯一一处直接写预设文件**。
 *
 * 为什么需要它：平台的 `copy()` 只收「显示名」，描述只能从源预设原样继承；用户在
 * 「新建预设」时想写一段自己的描述，绕不过这一手。平台 authoring 的边界（只允许整目录
 * 复制、不让调用方提供 composition 文本）防的是 `agent.cordis.yml` 那类**能力文本**；
 * 这里写的是「给人看的两个单行标量」，且只落在**刚落盘的新预设目录**上——路径从
 * `list()` 的原始行里取、并校验 id 命中，既不扩大写入口，也不碰任何既有预设。
 *
 * 格式与平台 `renderPresetMetadata` 同源（name/description 两个标量、缺省省略；
 * 空文件时删掉），但不引 yaml 依赖：单引号标量里只有 `'` 需要翻倍，中文、冒号、
 * 井号都安全；含换行的描述走双引号标量 + `\n` 转义（见 `yamlScalar`）。
 *
 * @param service - 预设服务（要它的 `list()` 原始行来定位目录）。
 * @param presetId - 刚落盘的新预设 id。
 * @param name - 用户填的显示名；空 = 不写这个键（与平台 copy 的行为一致）。
 * @param description - 用户填的描述；空 = 不写这个键。
 */
async function writePresetMetadata(service, presetId, name, description) {
    const rows = await service.list();
    const dir = rows.find((row) => row?.id === presetId)?.path;
    if (typeof dir !== 'string' || dir === '')
        throw new Error('在预设清单里找不到刚建好的目录');
    const file = join(dir, 'preset.yml');
    const lines = [];
    if (name !== undefined && name !== '')
        lines.push(`name: ${yamlScalar(name)}`);
    if (description !== undefined && description !== '')
        lines.push(`description: ${yamlScalar(description)}`);
    if (lines.length === 0) {
        rmSync(file, { force: true });
        return;
    }
    // 先写临时文件再改名：平台随时可能重扫预设目录，读者不该看到半截文件。
    const temp = `${file}.studio-tmp`;
    writeFileSync(temp, `${lines.join('\n')}\n`, { mode: 0o600 });
    renameSync(temp, file);
}
/**
 * 文本 → YAML 标量。
 *
 * 单行 ⇒ 单引号标量（唯一要转义的是单引号本身；中文、冒号、井号都安全）；
 * 含换行 ⇒ 双引号标量 + `\n` 转义——描述是**多行输入**（2026-09-18 用户点名
 * 改成 textarea），而 YAML 单引号标量跨行会把换行折叠成空格，留不住用户
 * 敲的断行，所以多行走双引号形态（`\n` 是 YAML 双引号风格的合法转义）。
 */
function yamlScalar(text) {
    if (!/[\r\n]/.test(text))
        return `'${text.replace(/'/g, "''")}'`;
    const escaped = text
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r\n?/g, '\n')
        .replace(/\n/g, '\\n');
    return `"${escaped}"`;
}
/**
 * 写端点：复制一个已有预设来新建。
 *
 * 入参是「源 id + 新 id + 可选显示名 + 可选描述」——平台复制 API 只接受前三项，
 * 描述由 `writePresetMetadata()` 在复制成功后补写（见它的注释；写不上只报 warning，
 * 预设已经建好，不能反过来把它报成失败）。
 *
 * @param req - Node 的请求对象。
 * @param res - Node 的响应对象。
 * @param deps - `{ getPresets, getScope, trustedHosts }`。
 */
export async function handleCreatePreset(req, res, deps) {
    const requestError = validateMutationRequest(req, deps.trustedHosts);
    if (requestError !== null) {
        json(res, requestError.statusCode, { ok: false, error: requestError.error });
        return;
    }
    const service = deps.getPresets();
    if (service?.copy === undefined) {
        json(res, 503, { ok: false, error: '预设服务未就绪，暂时不能新建预设' });
        return;
    }
    const body = await readJsonBody(req);
    const sourceId = typeof body?.from === 'string' ? body.from : '';
    const newId = typeof body?.id === 'string' ? body.id : '';
    const displayName = typeof body?.name === 'string' && body.name !== '' ? body.name : undefined;
    const description = typeof body?.description === 'string' && body.description.trim() !== '' ? body.description.trim() : undefined;
    if (sourceId === '' || newId === '') {
        json(res, 400, { ok: false, error: '缺少 from（源预设 id）或 id（新预设 id）' });
        return;
    }
    try {
        await service.copy(sourceId, newId, displayName);
    }
    catch (err) {
        json(res, 400, { ok: false, error: `新建预设失败：${err?.message ?? String(err)}` });
        return;
    }
    // 后面两步都是「附注」性质：办不上不该把一件已经办成的事报成失败，
    // 各自单独捕获，把原因原样带回面板。
    let warning;
    // 描述（用户填了才写）：平台复制只带显示名，描述靠这一手补。
    if (description !== undefined) {
        try {
            await writePresetMetadata(service, newId, displayName, description);
        }
        catch (err) {
            warning = `预设已创建，但描述没写上：${err?.message ?? String(err)}`;
        }
    }
    const scope = deps.getScope();
    if (scope?.update !== undefined) {
        const created = scope.get()?.createdPresets;
        const next = Array.isArray(created) ? [...created, newId] : [newId];
        try {
            await scope.update({ createdPresets: next });
        }
        catch (err) {
            warning ??= `预设已创建，但来源标记没记住：${err?.message ?? String(err)}`;
        }
    }
    json(res, 200, { ok: true, id: newId, warning });
}
/**
 * 清掉插件配置里对某个已删预设的三处痕迹：绑定引用、来源标记、配置分区。
 *
 * **为什么必须清**（2026-09-19 用户报的「删不掉 Agent」的根因）：预设删掉之后，
 * `bindings.presets` 里指向它的条目成了悬空引用——面板按「被引用」拦删除，
 * 而那个预设已经不存在、绑定也没有解除入口，于是绑到它的 Agent 被**永久锁死**。
 *
 * **清法不同、缺一不可**：`bindings.presets` 与 `createdPresets` 是数组，走
 * `scope.update()` 整体替换；`presets.<id>` 是对象键，合并写删不掉（`undefined`
 * 会被跳过），只能走设置服务的 `mutate` 按路径 `unset`。没有变化的那些不写，
 * 免得无谓地刷一次配置。
 *
 * 每一步都是「附注」性质：清不掉不该把一件已经办成的事报成失败，各自单独捕获、
 * 把原因并成一条 warning 带回面板。
 *
 * @param deps - `{ getScope, getSettings }`。
 * @param presetId - 刚被删掉的预设 id。
 * @returns 有哪一步没清掉时的说明；全清干净时 undefined。
 */
async function clearPresetTraces(deps, presetId) {
    const scope = deps.getScope();
    const current = scope?.get();
    const bindings = current?.bindings?.presets ?? [];
    const created = current?.createdPresets ?? [];
    const nextBindings = bindings.filter((binding) => binding?.presetId !== presetId);
    const nextCreated = created.filter((id) => id !== presetId);
    let warning;
    if (nextBindings.length !== bindings.length || nextCreated.length !== created.length) {
        if (scope?.update === undefined) {
            warning = '这个预设的引用还留在配置里，但设置服务不可写，没能清掉';
        }
        else {
            try {
                await scope.update({ bindings: { presets: nextBindings }, createdPresets: nextCreated });
            }
            catch (err) {
                warning = `预设已删除，但配置里的引用没清掉：${err?.message ?? String(err)}`;
            }
        }
    }
    const settings = deps.getSettings?.();
    if (settings?.mutate !== undefined) {
        try {
            await settings.mutate(SETTINGS_NAMESPACE, [{ op: 'unset', path: ['presets', presetId] }]);
        }
        catch (err) {
            warning ??= `预设已删除，但它的配置分区没清掉：${err?.message ?? String(err)}`;
        }
    }
    return warning;
}
/**
 * 写端点：删除一个预设。
 *
 * 只删用户创作的预设——shipped 一律由平台拒绝，插件不自己判一遍（判据在平台手里，
 * 抄一份只会造成两套真相）。
 *
 * 删完顺手清插件配置里对它的三处痕迹（绑定引用、来源标记、配置分区）：不清的话，
 * 「指向已删预设」的悬空绑定会把绑到它的 Agent 永远锁在「被引用」状态里——删不掉，
 * 界面上也没有解除入口。清法与边界见 `clearPresetTraces()`。
 *
 * @param req - Node 的请求对象。
 * @param res - Node 的响应对象。
 * @param deps - `{ getPresets, getScope, getSettings, trustedHosts }`。
 */
export async function handleDeletePreset(req, res, deps) {
    const requestError = validateMutationRequest(req, deps.trustedHosts);
    if (requestError !== null) {
        json(res, requestError.statusCode, { ok: false, error: requestError.error });
        return;
    }
    const service = deps.getPresets();
    if (service?.remove === undefined) {
        json(res, 503, { ok: false, error: '预设服务未就绪，暂时不能删除预设' });
        return;
    }
    const body = await readJsonBody(req);
    const presetId = typeof body?.id === 'string' ? body.id : '';
    if (presetId === '') {
        json(res, 400, { ok: false, error: '缺少 id' });
        return;
    }
    try {
        await service.remove(presetId);
    }
    catch (err) {
        json(res, 400, { ok: false, error: `删除预设失败：${err?.message ?? String(err)}` });
        return;
    }
    const warning = await clearPresetTraces(deps, presetId);
    json(res, 200, { ok: true, warning });
}
