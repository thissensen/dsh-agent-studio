/**
 * 预设管理：列出平台上的预设、从一份已有预设新建、删除本插件建的。
 *
 * 全部走官方服务（`ctx.get('agentPresets')`）——**插件不自己写预设文件**。
 *
 * **0.1.7 换了模型**（2026-09-24 核实平台源码）：预设不再是「目录里的文件」，而是
 * **插件声明**——创作入口只剩 `register(definition)`，读入口是 `readDocument(id)`
 * （返回构成声明的 **entry-list YAML 文本**）。所以「新建」的落地方式变成：
 * 读来源预设的构成文本 → 自己解析成结构化 row 列表 → `register()` 一份新 id 的定义
 * → 把定义**原文**存进插件配置（平台不落盘，见 `preset-registry.ts`）。描述与显示名
 * 因此不用再往预设目录里补文件（旧模型的 `preset.yml` 那一段已整段删掉）。
 *
 * 调用方**永远不提供构成文本**：plugins 一律取自另一份**已存在**的预设。一次新建因此
 * 不会授予来源预设尚未携带的能力。删除也由本插件判权限——只删定义在自己配置里的那些
 * （官方预设 id 撞不上：撞了的话 `register()` 当场抛 `Duplicate agent preset`）。
 *
 * 「来源」只剩两档：`shipped`（随部署提供，只读）· `plugin`（本插件建的）。旧模型的
 * 第三档 `user`（用户自己写的预设目录）**在新平台上不存在**。
 *
 * 会话记录里粘着预设 id，改名会让旧会话打不开，所以本插件**不提供重命名**。
 *
 * @module dsh-agent-studio/presets
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { json, readJsonBody, validateMutationRequest } from './http-guard.js'
import type { PresetRegistry } from './preset-registry.js'
import { parsePlugins, stringifyPlugins } from './preset-yaml.js'
import type { PresetBinding, PresetDefinitionConfig, PresetPluginRow, SettingsScope, StudioConfig } from './types.js'

/** 预设端点的依赖。 */
interface PresetDeps {
    getPresets(): unknown
    getScope(): SettingsScope
    /** 自建预设的注册表；服务未就绪时可能是 undefined（端点据此回 503）。 */
    getRegistry?(): PresetRegistry | undefined
    trustedHosts: unknown[]
}

/** `agentPresets` 服务的形状（只取本项目用到的成员）。 */
interface PresetService {
    list(): Promise<PresetListItem[]>
    /** 读一份预设的构成声明（entry-list YAML 文本，只读）。 */
    readDocument?(presetId: string): Promise<PresetDocument | undefined>
    /**
     * 为「按预设读某个作用域内的服务」取一个 revision 租约。
     * 语义是「解析**或建立**」（与官方 session-controller 渲染技能目录同路），
     * 用完必须释放——租约活着，那份 revision 就不会被回收。
     */
    acquireScope?(presetId?: string): Promise<({ key?: unknown } & AsyncDisposable) | undefined>
    /**
     * 创作入口：注册一份预设声明（**运行时**，不落盘）。用在后两步的是它返回的**注销器**
     * ——只有拿到注销器的那些预设删得掉，而重启后注销器全部作废、靠配置重放（见注册表模块）。
     */
    register?(definition: PresetDefinitionConfig): Promise<unknown>
}

/** `readDocument(id)` 的返回形状。 */
interface PresetDocument {
    agentPreset?: unknown
    content?: unknown
    name?: unknown
    description?: unknown
    order?: unknown
}

/**
 * `list()` 返回的一行。
 *
 * 0.1.7 起平台**不再给 `path` 与 `trust`**（预设从「目录里的文件」改成「row 声明」，
 * 见 `20-平台契约.md`）。来源与可写性因此不能照旧判：定义在插件配置 `createdPresets`
 * 里的就是本插件建的（也只有这些删得掉），其余一律当随部署提供。
 */
interface PresetListItem {
    id: string
    name?: string
    description?: string
    order?: unknown
    broken?: unknown
    [key: string]: unknown
}

/** 面板直接渲染的预设行。 */
interface PresetRow {
    id: string
    name: string | null
    description: string | null
    order: unknown
    broken: unknown
    source: 'shipped' | 'plugin'
    writable: boolean
    /** 提示词段是否被平台钉死（`complete: true`）——面板据此禁用「提示词集」卡片的装载区。 */
    promptFixed: boolean
    /** 运行时快照是否被预设自己关掉（`includeRuntimeContext: false`）——快照开关据此禁用。 */
    snapshotFixed: boolean
}

/**
 * 预设 id 的合法形状：不以分隔符开头结尾，中间允许小写字母 / 数字 / 点 / 下划线 / 连字符。
 */
const PRESET_ID = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/

/**
 * 读一个预设的构成声明，看它的 persona 声明了哪两个开关。
 *
 * **为什么要读它**（2026-09-18 查证）：平台不给这个信息。`compositionInventory()`
 * 的行只有 `entryId / moduleName / enabled / condition`（**不含 config**），预设行本身
 * 只有 name / description / order；而 4 个官方预设（`cordis` / `minimal` / `ptc` /
 * `standard`）**全都**用 `dsh-persona`，拿模块名当判据必然 4/4 误报。
 * 0.1.7 起读法是 `readDocument(id)` 返回的 entry-list YAML 文本（只读，不再需要
 * 自己去猜预设目录路径——那条路连同 `list()` 的 `path` 一起被平台收回了）。
 *
 * **只做检测、不做完整解析**：定位 `dsh-persona` 的 `name:` 行，往下扫到下一个缩进不深
 * 于它的 `name:` 行为止（嵌套 group 里的 `name:` 缩得更深，不会误截），看这一段里有没有
 * 那两个键。判错只影响界面灰不灰，不影响装配，够用即可。
 *
 * 读不到就都当 `false`（= 不禁用界面）：宁可少灰一层，也不能让面板报错。
 *
 * @param service - 预设服务。
 * @param presetId - 预设 id。
 * @returns 两个开关；读不到文本或找不到 `dsh-persona` 时都是 `false`。
 */
async function readPersonaFlags(
    service: PresetService,
    presetId: string,
): Promise<{ promptFixed: boolean; snapshotFixed: boolean }> {
    const off = { promptFixed: false, snapshotFixed: false }
    if (service.readDocument === undefined) return off

    let content: unknown
    try {
        content = (await service.readDocument(presetId))?.content

    } catch {
        // 读不出来（预设破损、权限）只影响界面灰不灰，不能让它冒到清单端点上。
        return off
    }

    if (typeof content !== 'string') return off

    const lines = content.split('\n')
    const NAME_LINE = /^(\s*)name:\s*(.+?)\s*$/

    for (let i = 0; i < lines.length; i += 1) {
        const hit = NAME_LINE.exec(lines[i])
        if (hit === null || hit[2].includes('dsh-persona') !== true) continue

        const indent = hit[1].length
        const flags = { ...off }

        for (let j = i + 1; j < lines.length; j += 1) {
            const sibling = NAME_LINE.exec(lines[j])
            if (sibling !== null && sibling[1].length <= indent) break

            if (/^\s*complete:\s*true\s*$/.test(lines[j]) === true) flags.promptFixed = true
            if (/^\s*includeRuntimeContext:\s*false\s*$/.test(lines[j]) === true) flags.snapshotFixed = true
        }

        return flags
    }

    return off
}

/**
 * 列出平台预设，附上来源与可写性。
 * @param service - `agentPresets` 服务；缺席时返回空清单。
 * @param created - 本插件建出来的预设定义（判来源与可写性用）。
 * @returns 供面板直接渲染的行数组。
 */
export async function listPresets(service: PresetService | undefined, created: PresetDefinitionConfig[]): Promise<PresetRow[]> {
    if (service?.list === undefined) return []

    const presets = await service.list()
    const mine = new Set(created.map((定义) => 定义?.id))
    const rows: PresetRow[] = []

    for (const preset of presets) {
        const ours = mine.has(preset.id)
        const flags = await readPersonaFlags(service, preset.id)

        rows.push({
            id: preset.id,
            name: preset.name ?? null,
            description: preset.description ?? null,
            order: preset.order ?? null,
            broken: preset.broken ?? null,
            source: ours ? 'plugin' : 'shipped',
            writable: ours,
            promptFixed: flags.promptFixed,
            snapshotFixed: flags.snapshotFixed,
        })
    }

    return rows
}

/**
 * 读端点：列出预设。
 * @param res - Node 的响应对象。
 * @param deps - `{ getPresets, getScope }`。
 */
export async function handleListPresets(res: ServerResponse, deps: PresetDeps): Promise<void> {
    const service = deps.getPresets() as PresetService | undefined
    const created = deps.getScope()?.get()?.createdPresets ?? []

    let presets: PresetRow[] = []

    if (service?.list !== undefined) {
        // HTTP handler 就是这条链的最外层边界。不在这里接住，异常会冒进宿主的 async handler，
        // 而响应永远不回——面板就卡在「正在读取平台预设与观察结果…」上，用户看不到任何原因。
        try {
            presets = await listPresets(service, created)

        } catch (err) {
            json(res, 500, { ok: false, error: `读取预设清单失败：${reasonOf(err)}` })
            return
        }
    }

    json(res, 200, {
        ok: true,
        // 服务缺席（纯 CLI 组合）、或平台还没有 `register` 这一创作入口时判为不可写，
        // 界面据此禁用新建与删除，而不是让按钮点了报错。
        authorable: service?.register !== undefined,
        presets,
    })
}

/** 异常 → 一行说明。 */
function reasonOf(err: unknown): string {
    return (err as { message?: string } | undefined)?.message ?? String(err)
}

/**
 * 校验预设 id 的形状与占用。
 *
 * 为什么拦：id 会被平台当成 YAML 锚点与日志标识，而这个值来自用户输入。让平台抛也行，
 * 但那时新建已经做了一半；在这里拦一句，面板能马上显示「哪儿不对」。
 *
 * 「被占用」要同时看两处：**平台现有的预设**（官方那份，撞了平台会抛 `Duplicate`）与
 * **本插件自建的**（配置里的定义——本进程可能还没重放过它们，只看平台清单会漏）。
 *
 * @param presetId - 用户填的新 id。
 * @param taken - 已经占用的 id 集合。
 * @returns 中文说明；形状合法且没被占用时 undefined。
 */
function presetIdProblem(presetId: string, taken: Set<string>): string | undefined {
    if (!PRESET_ID.test(presetId)) {
        return '新 id 只能用小写字母、数字、点、下划线或连字符，且不能以分隔符开头结尾'
    }

    if (taken.has(presetId)) return `已经有一个叫「${presetId}」的预设了`

    return undefined
}

/**
 * 把 `readDocument()` 给的构成文本读成一份可搬运的 row 数组。
 *
 * 失败时抛（含 YAML 自己的定位信息）——调用方把它当成「这次新建办不成」的原因回 4xx。
 *
 * @param service - 预设服务。
 * @param sourceId - 来源预设 id。
 * @returns row 数组。
 */
async function readSourcePlugins(service: PresetService, sourceId: string): Promise<PresetPluginRow[]> {
    if (service.readDocument === undefined) throw new Error('平台的预设服务没有读构成声明的入口')

    const content = (await service.readDocument(sourceId))?.content
    if (typeof content !== 'string') throw new Error(`来源预设「${sourceId}」的构成声明读不出来`)

    return parsePlugins(content, `来源预设「${sourceId}」`)
}

/**
 * 写端点：从一份已有预设新建。
 *
 * 入参是「源 id + 新 id + 可选显示名 + 可选描述」。plugins 全部取自来源预设的构成声明
 * ——调用方给不了构成文本，所以新建不会凭空多出能力。
 *
 * @param req - Node 的请求对象。
 * @param res - Node 的响应对象。
 * @param deps - `{ getPresets, getScope, getRegistry, trustedHosts }`。
 */
export async function handleCreatePreset(req: IncomingMessage, res: ServerResponse, deps: PresetDeps): Promise<void> {
    const requestError = validateMutationRequest(req, deps.trustedHosts)
    if (requestError !== null) {
        json(res, requestError.statusCode, { ok: false, error: requestError.error })
        return
    }

    const service = deps.getPresets() as PresetService | undefined
    const registry = deps.getRegistry?.()

    if (service?.readDocument === undefined || service.register === undefined || registry === undefined) {
        json(res, 503, { ok: false, error: '预设服务未就绪，暂时不能新建预设' })
        return
    }

    const body = await readJsonBody(req)
    const sourceId = typeof body?.from === 'string' ? body.from : ''
    const newId = typeof body?.id === 'string' ? body.id : ''
    const displayName = typeof body?.name === 'string' && body.name !== '' ? body.name : undefined
    const description = typeof body?.description === 'string' && body.description.trim() !== '' ? body.description.trim() : undefined

    if (sourceId === '' || newId === '') {
        json(res, 400, { ok: false, error: '缺少 from（源预设 id）或 id（新预设 id）' })
        return
    }

    const rows = await service.list()
    const source = rows.find((row) => row?.id === sourceId)
    if (source === undefined) {
        json(res, 400, { ok: false, error: `找不到来源预设「${sourceId}」` })
        return
    }

    const taken = new Set<string>()
    for (const row of rows) {
        if (typeof row?.id === 'string') taken.add(row.id)
    }
    for (const definition of deps.getScope()?.get()?.createdPresets ?? []) {
        if (typeof definition?.id === 'string') taken.add(definition.id)
    }

    const problem = presetIdProblem(newId, taken)
    if (problem !== undefined) {
        json(res, 400, { ok: false, error: problem })
        return
    }

    let plugins: PresetPluginRow[]
    try {
        plugins = await readSourcePlugins(service, sourceId)

    } catch (err) {
        json(res, 400, { ok: false, error: `读取来源预设的构成声明失败：${reasonOf(err)}` })
        return
    }

    // order 从来源预设继承；name / description 分三层定：调用方给了就用给的（面板从内置预设
    // 新建时就是这么把字典里的中文名发过来的），没给再看来源能不能借，都拿不到才不发这个键
    // ——平台的注册侧按「键在不在」判显示，凭空造空串等于自报一个空名字。
    const 显示名 = displayName ?? (typeof source.name === 'string' ? source.name : undefined)
    const 描述 = description ?? (typeof source.description === 'string' ? source.description : undefined)

    // 构成声明存成**文本**（见 `PresetDefinitionConfig` 的注释：解析好的对象过一遍平台的
    // settings 写入通道，`!!js` 表达式会被求值成普通值，条件语义就没了）。
    const definition: PresetDefinitionConfig = {
        id: newId,
        presetYaml: stringifyPlugins(plugins),
        ...显示名 === undefined || 显示名 === '' ? {} : { name: 显示名 },
        ...描述 === undefined || 描述 === '' ? {} : { description: 描述 },
    }

    try {
        await registry.create(definition, (patch) => deps.getScope().update(patch))

    } catch (err) {
        json(res, 400, { ok: false, error: `新建预设失败：${reasonOf(err)}` })
        return
    }

    json(res, 200, { ok: true, id: newId })
}

/**
 * 清掉插件配置里对某个已删预设的**悬空绑定**。
 *
 * **为什么必须清**（2026-09-19 用户报的「删不掉 Agent」的根因）：预设删掉之后，
 * `bindings.presets` 里指向它的条目成了悬空引用——面板按「被引用」拦删除，
 * 而那个预设已经不存在、绑定也没有解除入口，于是绑到它的 Agent 被**永久锁死**。
 *
 * 没有变化的那些不写回去，免得无谓地刷一次配置。
 *
 * @param config - 当前配置。
 * @param presetId - 刚被删掉的预设 id。
 * @returns 清干净之后的绑定数组；没变化时 undefined。
 */
function bindingsWithout(config: StudioConfig | undefined, presetId: string): PresetBinding[] | undefined {
    const bindings = config?.bindings?.presets ?? []
    const kept = bindings.filter((binding) => binding?.presetId !== presetId)

    return kept.length === bindings.length ? undefined : kept
}

/**
 * 写端点：删除一个本插件建出来的预设。
 *
 * **只删自建的那些**：官方预设的注销器不在本插件手里，本插件也从不注册它们——判据就是
 * 「定义在本插件配置的 `createdPresets` 里」（见 `preset-registry.ts`，重启后注销器会由
 * 配置重放补出来）。
 *
 * 删完顺手清插件配置里指向它的悬空绑定：不清的话，那个绑定会把绑到它的 Agent 永远锁在
 * 「被引用」状态里——删不掉，界面上也没有解除入口。两处改动并成**一次** `scope.update()`，
 * 免得中间那一步失败留下半截状态。
 *
 * @param req - Node 的请求对象。
 * @param res - Node 的响应对象。
 * @param deps - `{ getPresets, getScope, getRegistry, trustedHosts }`。
 */
export async function handleDeletePreset(req: IncomingMessage, res: ServerResponse, deps: PresetDeps): Promise<void> {
    const requestError = validateMutationRequest(req, deps.trustedHosts)
    if (requestError !== null) {
        json(res, requestError.statusCode, { ok: false, error: requestError.error })
        return
    }

    const scope = deps.getScope()
    const registry = deps.getRegistry?.()

    if (registry === undefined) {
        json(res, 503, { ok: false, error: '预设服务未就绪，暂时不能删除预设' })
        return
    }

    const body = await readJsonBody(req)
    const presetId = typeof body?.id === 'string' ? body.id : ''
    if (presetId === '') {
        json(res, 400, { ok: false, error: '缺少 id' })
        return
    }

    const current = scope.get()
    const kept = (current?.createdPresets ?? []).filter((定义) => 定义?.id !== presetId)
    if (kept.length === (current?.createdPresets ?? []).length) {
        json(res, 400, { ok: false, error: `「${presetId}」不是本插件建的预设，删不了` })
        return
    }

    const bindings = bindingsWithout(current, presetId)
    const patch: Record<string, unknown> = { createdPresets: kept }
    if (bindings !== undefined) patch.bindings = { presets: bindings }

    try {
        // 配置先摘掉：注册表随后 sync，既注销了内存里的注册，也不会把这条定义重放回来。
        await scope.update(patch)
        await registry.sync()

    } catch (err) {
        json(res, 400, { ok: false, error: `删除预设失败：${reasonOf(err)}` })
        return
    }

    json(res, 200, { ok: true })
}
