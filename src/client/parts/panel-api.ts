/**
 * 和 host 说话的唯一出口：端点表、写围栏头，以及取数与写回函数。
 *
 * @module dsh-agent-studio/client-parts/panel-api
 */
import type {
    ObservationUnit,
    ToolObservation,
    SkillRow,
    ProviderModel,
    EffortInfo,
    Preset,
} from './panel-types'
import type { StudioConfig } from '../../host/types'

/** host 侧的全部端点。写端点另需自定义头，见 `postJson`。 */
export const ENDPOINTS = {
    observation: '/api/dsh-agent-studio/observation',
    config: '/api/dsh-agent-studio/config',
    skills: '/api/dsh-agent-studio/skills',
    tools: '/api/dsh-agent-studio/tools',
    presets: '/api/dsh-agent-studio/presets',
    models: '/api/dsh-agent-studio/models',
    efforts: '/api/dsh-agent-studio/models/efforts',
    createPreset: '/api/dsh-agent-studio/presets/create',
    deletePreset: '/api/dsh-agent-studio/presets/delete',
    ui: '/api/dsh-agent-studio/ui',
}

/** 写围栏要求的自定义头：它让请求变成非简单请求，跨站页面伪造不出来。 */
export const MUTATION_HEADER = { 'x-dsh-agent-studio': '1' }

// ── 取数与写回 ──────────────────────────────────────────────────────────

/**
 * 取一份 JSON，`ok` 不为 true 就当失败抛出。
 * @param url - 端点。
 * @param options - fetch 选项。
 */
export async function fetchJson(url: string, options?: RequestInit): Promise<Record<string, unknown>> {
    const rep = await fetch(url, options)
    const data = await rep.json()

    if (data?.ok !== true) {
        throw Error(data?.error ?? `HTTP ${rep.status}`)
    }

    return data
}

/**
 * 打一个写请求。写围栏要求自定义头与 JSON content-type，两者都在这里给齐。
 * @param url - 端点。
 * @param body - 请求体对象。
 */
export async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
    return fetchJson(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...MUTATION_HEADER },
        body: JSON.stringify(body),
    })
}

/**
 * 读观察结果。
 *
 * `sessions` 是 host 进程这次采到的，`cached` 是上次留下的（按预设索引）。
 * 工具候选的权威来源是 `/tools` 实时端点（见 `loadTools`），这两份是它读不到时的回退——
 * 见 `observationFor`。
 */
export async function loadObservation(): Promise<{ sessions: ObservationUnit[]; cached: Record<string, ObservationUnit> }> {
    const data = await fetchJson(ENDPOINTS.observation)
    return {
        sessions: Array.isArray(data.sessions) ? data.sessions : [],
        cached: (data.cached ?? {}) as Record<string, ObservationUnit>,
    }
}

/**
 * 读技能清单（host 侧**主动**问官方技能服务，不等任何对话）。
 *
 * 失败不抛给调用方：技能候选为空只是「这次没读到」，不该让整个面板打不开；
 * 读不到时退回空数组（技能集编辑器会显示对应的提示文案）。
 */
export async function loadSkills(): Promise<SkillRow[]> {
    try {
        const data = await fetchJson(ENDPOINTS.skills)
        return Array.isArray(data.skills) ? data.skills : []

    } catch {
        return []
    }
}

/**
 * 读某个预设的工具候选（host 侧**实时**读平台工具面，不等任何对话）。
 *
 * 失败不抛给调用方：读不到只是「这次没读到」，界面继续用观察缓存（见
 * `mergeToolObservations`）；下次切回这个预设时会再试一次。
 *
 * @param presetId - 预设 id。
 */
export async function loadTools(presetId: string): Promise<ToolObservation | undefined> {
    try {
        const data = await fetchJson(`${ENDPOINTS.tools}?preset=${encodeURIComponent(presetId)}`)
        return data.tools as ToolObservation | undefined

    } catch {
        return undefined
    }
}

/** 读插件配置（可能是 null：设置服务未就绪）。 */
export async function loadConfig(): Promise<StudioConfig | null> {
    const data = await fetchJson(ENDPOINTS.config)
    return (data.config as StudioConfig | null | undefined) ?? null
}

/** 读平台预设列表（id、显示名、描述、可写性、能否创作）。 */
export async function loadPresets(): Promise<{ presets: Preset[]; authorable: boolean }> {
    const data = await fetchJson(ENDPOINTS.presets)

    return {
        presets: Array.isArray(data.presets) ? data.presets : [],
        // 平台没有创作入口（没有 `register`）时，新建与删除都办不成——按钮据此置灰。
        authorable: data.authorable === true,
    }
}

/**
 * 读模型目录（provider + 模型清单）。
 *
 * `warnings` 记的是「某个 provider 的模型清单没读出来」——host 侧遇到这种情况会跳过
 * 那一个（而不是让整份清单空掉），但用户在面板上得看见少的是谁，
 * 否则只会以为那个 provider 根本不存在。
 */
export async function loadModels(): Promise<{ providers: ProviderModel[]; warnings: string[] }> {
    const data = await fetchJson(ENDPOINTS.models)

    return {
        providers: Array.isArray(data.providers) ? data.providers : [],
        warnings: Array.isArray(data.warnings) ? data.warnings : [],
    }
}

/**
 * 读某个模型支持的推理档位。档位集合随模型变，所以只能在选中后现问。
 * @param provider - provider id。
 * @param model - model id。
 */
export async function loadEfforts(provider: string, model: string): Promise<EffortInfo[]> {
    const query = `?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`
    const data = await fetchJson(`${ENDPOINTS.efforts}${query}`)
    return Array.isArray(data.efforts) ? data.efforts : []
}
