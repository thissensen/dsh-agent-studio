/**
 * 「当前 agent 跑在哪个预设上」的唯一取法。
 *
 * 这件事必须只有一个出口，因为这个模块存在的全部理由就是它**极易取错**：
 *
 *  - `session.header.agentPreset` 是**出生预设**，不是当前预设。真机实测过
 *    该字段写着 `custom-standard` 而 agent 实际跑在 `dsh-studio-lab` 上
 *    （源码 + 真机双重确认）。
 *  - 连预设自己打的日志都不可信：实验台是从另一个预设复制来的，
 *    它的 guard 里硬编码着原来的预设名，日志里照旧打那个名字。
 *
 * 所以取法只有一个：`composedPreset` 读 live scope chain。观察层与生效层都用它，
 * 免得两处各自实现、各自取错。
 *
 * @module dsh-agent-studio/preset
 */

import { livePresetMounts, standingMountFor } from '@deepseek-ai/dsh-agent-preset-registry'
import { scopeOf, scopeParentOf } from '@deepseek-ai/dsh-scope'
import type { Ctx } from './types.js'

/** `agentPresets` 服务的形状（只取 `composedPreset`）。 */
interface AgentPresetsService {
    composedPreset?(scope: unknown): string | undefined
}

/**
 * 宿主 context 的类型。
 *
 * 本插件不依赖 `@deepseek-ai/cordis` 的类型包，而模块导出的 `standingMountFor`
 * 要的是 cordis 的 `Context` ⇒ 用它的签名反推，既拿到准确类型又不新增依赖。
 * 调用方传进来的本来就是 `agent.ctx`，断言成立。
 */
type HostContext = Parameters<typeof standingMountFor>[0]

/**
 * 取当前 agent 真正跑在哪个预设上。
 *
 * 两条路都试：服务实例上的 `composedPreset` 是公开 API，模块导出的
 * `standingMountFor` 是它的实现本体。服务那条路返回空时走模块那条——
 * 后者要求插件与宿主解析到**同一个模块实例**（`link:` 装法下由 Node 的
 * 真实路径解析保证，见 docs/environment-notes.md）。
 *
 * @param ctx - 插件所在的 context。
 * @param agentCtx - 该 agent 的 scope context，即 `agent.ctx`。
 * @returns 预设 id（目录名）；两条路都取不到时返回 undefined。
 */
export function resolvePresetId(ctx: Ctx, agentCtx: unknown): string | undefined {
    if (agentCtx === undefined) return undefined

    const fromService = (ctx.get?.('agentPresets') as AgentPresetsService | undefined)?.composedPreset?.(agentCtx)
    if (fromService !== undefined) return fromService

    return standingMountFor(agentCtx as HostContext)?.presetId
}

/**
 * 预设解析链上各环节的现场，用于定位卡在哪一环。
 *
 * @param ctx - 插件所在的 context。
 * @param agentCtx - 该 agent 的 scope context。
 * @returns 每一项都是「名字=状态」形式的短句。
 */
export function describePresetResolution(ctx: Ctx, agentCtx: unknown): string[] {
    const service = ctx.get?.('agentPresets') as AgentPresetsService | undefined
    const scopeKey = agentCtx === undefined ? undefined : scopeOf(agentCtx as HostContext)
    const standingKey = scopeKey === undefined ? undefined : scopeParentOf(scopeKey)

    let scopeState = '未绑定'
    if (standingKey !== undefined) scopeState = '已绑预设'
    else if (scopeKey !== undefined) scopeState = '无父节点'

    // 不传 `within`：这个函数只用于排障输出，而「进程里挂了哪些预设」正是要看的东西。
    // （`within` 是给「一个进程里跑多个 runtime」的读者用的——那种场景下才需要传自己的
    // root fiber 把别人的挂载排除掉；本插件的排障输出不需要这层过滤。）
    const mounted = livePresetMounts().map((mount) => mount.presetId)

    return [
        `agent.ctx=${agentCtx === undefined ? '无' : '有'}`,
        `scope=${scopeState}`,
        `agentPresets 服务=${service === undefined ? '缺席' : `就绪(composedPreset=${typeof service.composedPreset})`}`,
        `挂载中=${mounted.join(',') || '（无）'}`,
    ]
}
