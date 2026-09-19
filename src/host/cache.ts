/**
 * 观察结果的磁盘缓存。
 *
 * **为什么需要它。** 工具名的权威来源只有一个：某个 agent 装配时它那个 scope 的
 * `tools.view()`。而 scope 层是随会话（预设的 standing mount）才建起来的——没有会话时，
 * 宿主进程里那些工具**根本还没注册**，问谁都问不出来。于是「面板打开就能列全工具」
 * 这件事，只能靠把上次采到的那份留下来。
 *
 * 缓存是**按预设**存的（不是按会话）：面板要回答的正是「这个预设的工具面是什么」，
 * 而同一个预设的每次装配得到的面是一样的。
 *
 * **它只喂候选清单**，不参与「配置是否生效」的判断，所以过期的那点风险（上次采完又改了
 * 配置）最多是多列几个候选名，不会误导成「已经生效」。
 *
 * 存的位置跟随平台的用户缓存目录，**不碰 `~/.dsh`**（那是宿主的账，本项目不写它）。
 *
 * @module dsh-agent-studio/cache
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from './types.js'

/** 一个预设的观察事实（按 `presetId` 索引；`sections` / `tools` 的具体形态由调用方约定）。 */
interface CachedObservation {
    sections?: unknown
    tools?: unknown
    observedAt?: number
    [key: string]: unknown
}

/** `rememberPresetObservation` 接受的观察快照：与内存观察结果同形状。 */
interface ObservationSnapshot {
    sections?: unknown
    tools?: unknown
    [key: string]: unknown
}

/** 缓存格式版本：v2 起 `sections` 记的是平台全量段清单（v1 是投递后的）。 */
const CACHE_VERSION = 2

/** 进程内的缓存副本。读一次盘就够，写回时同步更新它。 */
let loaded: Record<string, CachedObservation> | null = null

/**
 * 缓存目录：Windows 用 `%LOCALAPPDATA%`，其余平台退回 `~/.cache`。
 *
 * 路径**现算**而不是在模块顶层算：`DSH_AGENT_STUDIO_CACHE` 是给自检用的覆盖点，
 * 自检必须在第一次读盘之前把它设好（见 `scripts/verify-host.mjs`），
 * 自检绝不能往用户的真实缓存目录里写东西。
 */
function cacheDir(): string {
    return process.env.DSH_AGENT_STUDIO_CACHE
        ?? join(process.env.LOCALAPPDATA ?? join(homedir(), '.cache'), 'dsh-agent-studio')
}

/**
 * 读上次留下的观察事实，按预设 id 索引。
 *
 * 读盘只做一次（懒加载）。文件不存在、读坏、形状不对，一律当作「没有缓存」——
 * 这份数据只影响候选清单的完整度，绝不能因为它让面板或装配报错。
 *
 * @returns `{ [presetId]: { sections, tools, observedAt } }`
 */
export function cachedObservations(): Record<string, CachedObservation> {
    if (loaded !== null) return loaded

    try {
        const parsed = JSON.parse(readFileSync(join(cacheDir(), 'observations.json'), 'utf8')) as { presets?: Record<string, CachedObservation> }

        // **不校验版本**：v1 的 `sections` 是「投递后」的清单（少了被排除的段），拿它当
        // 平台全量用只会让位次退化成「平台预设」四个字，而工具清单完全不受影响——一次装配
        // 之后自愈。为了这点退化把整份缓存丢掉，代价是用户重启后连工具清单都空着，不值。
        loaded = parsed?.presets ?? {}

    } catch {
        loaded = {}
    }

    return loaded
}

/**
 * 记下一个预设的观察事实；内容没变就不写盘。
 *
 * 调用点在装配期（每个请求都可能走到），所以签名比较是必需的：只在工具面或段清单
 * 真的变了时才落一次盘。写失败只记一笔，不影响请求本身。
 *
 * @param presetId - 预设 id。
 * @param snapshot - `{ sections, tools }`，与内存里那份观察结果**同形状**，
 *   于是面板读缓存与读实时观察可以走同一段代码。
 * @param logger - 用于报错的 logger。
 */
export function rememberPresetObservation(presetId: string, snapshot: ObservationSnapshot, logger: Logger): void {
    if (presetId === undefined) return

    const cached = cachedObservations()
    const previous = cached[presetId]
    const next = { presetId, ...snapshot }

    if (previous !== undefined && isSameSurface(previous, next)) return

    cached[presetId] = { ...next, observedAt: Date.now() }

    try {
        mkdirSync(cacheDir(), { recursive: true })
        writeFileSync(join(cacheDir(), 'observations.json'), JSON.stringify({ version: CACHE_VERSION, presets: cached }, null, 2))

    } catch (err) {
        logger?.warn?.(`[agent-studio] 观察缓存没写进去（不影响本次装配）：${(err as { message?: string } | undefined)?.message ?? String(err)}`)
    }
}

/**
 * 两份快照说的是不是同一件事。比字符串就够——数据量很小，要的正是「一模一样」。
 * @param left - 旧快照。
 * @param right - 新快照。
 */
function isSameSurface(left: CachedObservation, right: CachedObservation): boolean {
    const leftCopy = { ...left }
    const rightCopy = { ...right }
    delete leftCopy.observedAt
    delete rightCopy.observedAt

    return JSON.stringify(leftCopy) === JSON.stringify(rightCopy)
}
