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
 * 所以取法只有一个：读 `agentPresets` 服务沿 scope 链定位该 agent 加入的预设修订。
 * 主路 `composedPreset` 直出 id，同源的 `inspectCompositions` 作兜底；观察层与生效层都走这里，
 * 免得两处各自实现、各自取错。
 *
 * @module dsh-agent-studio/preset
 */
import { scopeOf, scopeParentOf } from '@deepseek-ai/dsh-scope';
/**
 * 取当前 agent 真正跑在哪个预设上。
 *
 * ① 两条路**同源**：平台侧 `composedPreset(ctx)` 与 `inspectCompositions(ctx)` 内部走的是
 * 同一个查找（沿 scope 链定位该 agent 加入的预设修订），后者只是顺带把该修订的模块引用与
 * 「泄漏服务」一并算出来。留第二个入口不是为了多一份数据，而是不把取数押在单个方法名上。
 *
 * ② 兜底**只在主路取不到时才调用**：`inspectCompositions` 要算模块引用与「泄漏服务」，
 * 比一次查找重，所以不能把它提成无条件调用。
 *
 * ③ 服务缺席时两个入口都没有 ⇒ 返回 undefined，即退化为「不干预」
 * （观察层记空、生效层跳过）。
 *
 * @param ctx - 插件所在的 context。
 * @param agentCtx - 该 agent 的 scope context，即 `agent.ctx`。
 * @returns 预设 id（目录名）；两个入口都取不到时返回 undefined。
 */
export function resolvePresetId(ctx, agentCtx) {
    if (agentCtx === undefined)
        return undefined;
    const service = ctx.get?.('agentPresets');
    const fromService = service?.composedPreset?.(agentCtx);
    if (fromService !== undefined)
        return fromService;
    return service?.inspectCompositions?.(agentCtx)?.[0]?.id;
}
/**
 * 预设解析链上各环节的现场，用于定位卡在哪一环。
 *
 * @param ctx - 插件所在的 context。
 * @param agentCtx - 该 agent 的 scope context。
 * @returns 每一项都是「名字=状态」形式的短句。
 */
export function describePresetResolution(ctx, agentCtx) {
    const service = ctx.get?.('agentPresets');
    const scopeKey = agentCtx === undefined ? undefined : scopeOf(agentCtx);
    const standingKey = scopeKey === undefined ? undefined : scopeParentOf(scopeKey);
    let scopeState = '未绑定';
    if (standingKey !== undefined)
        scopeState = '已绑预设';
    else if (scopeKey !== undefined)
        scopeState = '无父节点';
    // 不传参 = 列全部保留修订；传 agent ctx 只会回该 agent 那一条，而这份排障输出要看的
    // 正是「进程里保留了哪些」。
    const mounted = service?.inspectCompositions?.().map((c) => c.id) ?? [];
    return [
        `agent.ctx=${agentCtx === undefined ? '无' : '有'}`,
        `scope=${scopeState}`,
        `agentPresets 服务=${service === undefined ? '缺席' : `就绪(composedPreset=${typeof service.composedPreset})`}`,
        `挂载中=${mounted.join(',') || '（无）'}`,
    ];
}
