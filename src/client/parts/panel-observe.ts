/**
 * 观察结果整理（纯函数）：把「平台实际投递了什么」讲成界面要的行。
 *
 * @module dsh-agent-studio/client-parts/panel-observe
 */
import type {
    SectionObservation,
    ToolObservation,
    ObservationUnit,
    ObservationView,
    SkillRow,
    PlatformSection,
    ToolRow,
    SkillRowOut,
} from './panel-types'

// ── 事实整理（纯函数，界面用它把观察结果讲成人话） ───────────────────────

/**
 * 某个预设的观察事实——「平台实际投递了什么」的全部来源。
 *
 * 优先**这次进程**采到的（同一预设可能有好几个会话，取最新的那个），没有就退回
 * host 从盘上带来的那份。工具候选的权威来源是 `/tools` 实时端点（见 `loadTools`），
 * 这两份是它读不到时的回退（观察层只留副本，见 `lib/cache.js`）。
 * 两份形状一样，界面不用分情况。
 *
 * @param viewState - 面板状态（`sessions` 与 `cached`）。
 * @param presetId - 预设 id。
 */
export function observationFor(viewState: ObservationView, presetId: string): ObservationUnit | undefined {
    const matched = viewState.sessions.filter((session) => session.presetId === presetId)
    if (matched.length === 0) return viewState.cached?.[presetId]

    return matched.slice().sort((left, right) => right.observedAt - left.observedAt)[0]
}

/**
 * 平台全量段（进本插件改写之前的那份）：`[{ name, text }]`。
 *
 * `text` 是平台当次求值的正文（观察层新留的字段），「+ 平台预设」弹窗的预览靠它；
 * 更早一次观察记录里没这个字段，取不到就退化成没有预览（绝不因此报错）。
 */
export function platformSectionsOf(observation: ObservationUnit | undefined): PlatformSection[] {
    return (observation?.sections ?? [])
        .filter((section): section is SectionObservation & { name: string } => section?.name !== undefined)
        .map((section) => ({
            name: section.name,
            text: typeof section.text === 'string' ? section.text : undefined,
        }))
}

/** 平台已注册的插值变量（名字 → 值）；观察层没采过时是空对象。 */
export function promptVariablesOf(observation: ObservationUnit | undefined): Record<string, unknown> {
    return observation?.variables ?? {}
}

/**
 * 工具清单的每一行。
 *
 * v2 全显示、全可勾：候选 = 观察到的全部名字（平台已知 ∪ 可见 ∪ 可收窄 ∪ 上层已放行）
 * ∪ 配置里点过名的，不再有「不可勾」的档位——判「能不能生效」是宿主翻译时的事
 * （见 `apply.js`），界面不替它下结论，也不做隐藏/变灰分支。
 *
 * @param tools - 观察结果里的 `tools` 各集合（可能没有：从没装配过就没有）。
 * @param checkedNames - 当前勾选的名字集合。
 */
export function toolRowsFor(tools: ToolObservation | undefined, checkedNames: Set<string>): ToolRow[] {
    const names = new Set([
        ...(tools?.known ?? []),
        ...(tools?.visible ?? []),
        ...(tools?.restrictable ?? []),
        ...(tools?.reachable ?? []),
        ...checkedNames,
    ])

    return [...names].sort().map((name) => ({ name, checked: checkedNames.has(name) }))
}

/**
 * 两份工具候选取并集：实时读数 ∪ 观察缓存。
 *
 * 合并成**并集**而不是覆盖：实时端点给的是平台此刻的面，观察缓存里却有装配期才知道的
 * 名字与归属——两边都可能多出对方没有的。已勾却两边都没有的名字由 `toolRowsFor` 兜，
 * 所以这里只管这两份。
 *
 * `owners` 以前一份为准：实时读数比落盘的旧缓存新。
 *
 * @param live - 优先的一份（实时读数）；它的 `owners` 说了算。
 * @param cached - 其次的一份（按预设的观察缓存）。
 * @returns 合并后的观察；两份都没有时 undefined。
 */
export function mergeToolObservations(
    live: ToolObservation | undefined,
    cached: ToolObservation | undefined,
): ToolObservation | undefined {
    if (live === undefined) return cached
    if (cached === undefined) return live

    return {
        visible: unionNames(live.visible, cached.visible),
        known: unionNames(live.known, cached.known),
        restrictable: unionNames(live.restrictable, cached.restrictable),
        reachable: unionNames(live.reachable, cached.reachable),
        owners: { ...cached.owners, ...live.owners },
    }
}

/**
 * 两个名字数组取并集：保序去重（先出现的先留）。
 * @param left - 前一份。
 * @param right - 后一份。
 */
function unionNames(left: string[] | undefined, right: string[] | undefined): string[] {
    return [...new Set([...(left ?? []), ...(right ?? [])])]
}

/**
 * 技能清单的每一行：候选 = host 主动读到的 skill 名字 ∪ 已勾的（配置里点过名的）。
 *
 * 与工具清单同一套原则：全显示、全可勾，不做灰行与隐藏分支。
 * 候选来自 `/skills` 端点（官方技能服务的主动读取，失败时 host 已回退缓存），
 * **不依赖任何对话**——打开面板就能列出。
 *
 * `source` 是技能来源（面板按它分组，见 `SKILL_SOURCE_KEYS`）；已勾却没在
 * 候选里的名字没有它——归「（无来源信息）」组，与旧缓存的退化路径同一条。
 *
 * @param skills - `/skills` 端点给的行（可能为空数组：服务没读到）。
 * @param checkedNames - 当前勾选的名字集合。
 */
export function skillRowsFor(skills: SkillRow[] | undefined, checkedNames: Set<string>): SkillRowOut[] {
    const facts = new Map(
        (skills ?? [])
            .filter((skill): skill is SkillRow & { name: string } => skill?.name !== undefined)
            .map((skill) => [skill.name, skill]),
    )
    const names = new Set([...facts.keys(), ...checkedNames])

    return [...names].sort().map((name) => ({
        name,
        description: facts.get(name)?.description ?? '',
        source: facts.get(name)?.source ?? '',
        checked: checkedNames.has(name),
    }))
}
