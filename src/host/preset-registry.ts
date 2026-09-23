/**
 * 自建预设的**运行时注册表**：谁注册了、注销器在哪、什么时候该重新注册。
 *
 * **为什么需要这么一层**（2026-09-24 核实平台源码）：0.1.7 起平台把预设从「目录里的
 * 文件」改成「插件声明」——创作入口只剩 `agentPresets.register(definition)`，它**不落盘**，
 * 返回一个注销器（`AsyncDisposable`）由注册方自己持有。于是有两个后果：
 *
 *   1. 注册活在**本进程内存**里。插件下次启动只是被重新装配一次，注册全没了 ⇒ 定义
 *      必须存在别处（本插件存进自己的配置，借平台的 settings 通道落盘），启动时照它重放。
 *   2. 「这个预设能不能删」的判据变成**「它的定义在不在插件配置里」**，而不是「本进程
 *      有没有注册过它」——重启之后注销器还没建出来，但那个预设照样是这里建的、照样该能删。
 *
 * 同 id 重复注册平台会直接抛 `Duplicate agent preset`（官方预设因此覆盖不了），所以
 * `sync()` 只注册配置里有、内存里没有的那些；id 冲突时记一条日志并跳过，其余预设照常。
 *
 * @module dsh-agent-studio/preset-registry
 */

import { parsePlugins } from './preset-yaml.js'
import type { Logger, PresetDefinitionConfig, PresetPluginRow, StudioConfig } from './types.js'

/** 平台 `agentPresets` 服务里本项目用到的成员。 */
interface PresetAuthoringService {
    /**
     * 注册一份预设声明并**立即加载**它。
     *
     * 注意平台的错误语义：id 空、id 重复会**抛**；而构成本身挂不起来（引用了没装的包、
     * 行校验不过）时**不抛**——它把失败记在内部、由 `list()` 的 `broken` 报出来。
     */
    register?(definition: { id: string; name?: string; description?: string; plugins: PresetPluginRow[] }): Promise<PresetDeregister>
}

/** 平台的注销器：源码里是 `AsyncDisposable`（`[Symbol.asyncDispose]`），按鸭子类型两形状都接。 */
type PresetDeregister = (() => Promise<void>) | { [Symbol.asyncDispose]?: () => Promise<void> } | undefined

/** 注册表要的取值函数（配置与日志都「现问现取」，与三层同纪律）。 */
interface PresetRegistryDeps {
    getConfig(): StudioConfig | undefined
    logger: Logger
}

/** 注册一份预设最多等多久（毫秒）。注册会真的把整棵预设树挂起来，卡住不能拖着端点不回。 */
const REGISTER_TIMEOUT_MS = 4000

/**
 * 一套预设注册表。
 *
 * 生命周期：`sync()` 在服务与配置都就绪时调一次（启动重放），此后每次配置变更再调一次
 * ——增量的，已注册的不动。
 */
export interface PresetRegistry {
    /** 配置里有、内存里没有的都补注册；内存里有、配置里已没有的都注销。 */
    sync(): Promise<void>
    /** 把一份定义登记进配置并注册（新建）。办不成时抛，由端点回 4xx。 */
    create(definition: PresetDefinitionConfig, update: (patch: unknown) => Promise<void>): Promise<void>
    /** 注销一份自建预设并把它从配置里摘掉（删除）。办不成时抛，由端点回 4xx。 */
    remove(presetId: string, update: (patch: unknown) => Promise<void>): Promise<void>
}

/** 取注销器的调用形态；不认识的形状返回 undefined。 */
function toDeregister(deregister: PresetDeregister): (() => Promise<void>) | undefined {
    if (typeof deregister === 'function') return deregister

    const release = deregister?.[Symbol.asyncDispose]

    return typeof release === 'function' ? () => release.call(deregister) : undefined
}

/** 一份定义是不是能拿去注册（形状守卫；构成本身合法与否由 `parsePlugins` 与平台判）。 */
function isRegisterable(id: unknown, definition: PresetDefinitionConfig | undefined): boolean {
    return typeof id === 'string' && id !== '' && typeof definition?.presetYaml === 'string' && definition.presetYaml.trim() !== ''
}

/** 异常 → 一行说明。 */
function reasonOf(err: unknown): string {
    return (err as { message?: string } | undefined)?.message ?? String(err)
}

/**
 * 建一套注册表。
 * @param service - 取 `agentPresets` 服务的函数（现问现取：平台可能换实例）。
 * @param deps - `{ getConfig, logger }`。
 * @returns 注册表。
 */
export function createPresetRegistry(service: () => unknown, deps: PresetRegistryDeps): PresetRegistry {
    /** 已注册的注销器，按预设 id 索引。 */
    const 注销器组 = new Map<string, () => Promise<void>>()

    /** 给注册调用套一层超时（平台卡住时不能把 HTTP 端点一起拖死）。 */
    async function 限时注册(定义: { id: string; plugins: PresetPluginRow[]; name?: string; description?: string }): Promise<PresetDeregister> {
        let 计时器: ReturnType<typeof setTimeout> | undefined
        const 超时 = new Promise<never>((_resolve, reject) => {
            计时器 = setTimeout(() => reject(new Error(`注册超过 ${REGISTER_TIMEOUT_MS}ms 没返回`)), REGISTER_TIMEOUT_MS)
        })

        try {
            return await Promise.race([Promise.resolve((service() as PresetAuthoringService | undefined)?.register?.(定义)), 超时])

        } finally {
            clearTimeout(计时器)
        }
    }

    /**
     * 注册一份定义并记下注销器。
     *
     * 没拿到注销器**不算办成**：那个预设会在内存里生效却删不掉，而配置里已记着它 ⇒
     * 下次启动重放时撞 `Duplicate`。所以这种情况按失败处理，让调用方把配置回滚。
     */
    async function 注册一份(定义: PresetDefinitionConfig, 预设id: string): Promise<void> {
        const 行组 = parsePlugins(定义.presetYaml ?? '', `自建预设「${预设id}」`)
        const 平台定义 = {
            id: 预设id,
            plugins: 行组,
            ...(定义.name === undefined || 定义.name === '' ? {} : { name: 定义.name }),
            ...(定义.description === undefined || 定义.description === '' ? {} : { description: 定义.description }),
        }

        const 注销 = toDeregister(await 限时注册(平台定义))
        if (注销 === undefined) throw new Error('平台没有返回注销器，这个预设会删不掉')

        注销器组.set(预设id, 注销)
    }

    async function sync(): Promise<void> {
        const 配置组 = deps.getConfig()?.createdPresets ?? []
        const 想要 = new Set(配置组.filter((定义) => isRegisterable(定义?.id, 定义)).map((定义) => 定义.id as string))

        // ① 配置里已经没有的：注销。
        for (const [预设id, 注销] of [...注销器组]) {
            if (想要.has(预设id)) continue

            注销器组.delete(预设id)

            try {
                await 注销()

            } catch (err) {
                deps.logger.warn?.(`[agent-studio] 预设「${预设id}」注销失败：${reasonOf(err)}`)
            }
        }

        // ② 配置里有、内存里没有的：注册。逐个来，一份失败不影响其余。
        for (const 定义 of 配置组) {
            const 预设id = 定义?.id
            if (typeof 预设id !== 'string' || 预设id === '' || 注销器组.has(预设id)) continue
            if (!isRegisterable(预设id, 定义)) {
                deps.logger.warn?.(`[agent-studio] 配置里的自建预设「${预设id}」没有构成声明，跳过注册`)
                continue
            }

            try {
                await 注册一份(定义, 预设id)

            } catch (err) {
                // 最常见的一种：这个 id 和官方（或别的插件）的预设撞了。跳过一个，其余照常。
                deps.logger.warn?.(`[agent-studio] 自建预设「${预设id}」注册失败：${reasonOf(err)}`)
            }
        }
    }

    return {
        sync,

        async create(定义, update) {
            const 预设id = 定义.id
            if (typeof 预设id !== 'string' || 预设id === '') throw new Error('预设 id 不能为空')
            if (注销器组.has(预设id)) throw new Error(`已经有一个叫「${预设id}」的自建预设了`)

            await 注册一份(定义, 预设id)

            // 注册成功之后才落配置。落不上就当场注销——不留「这次跑得起来、重启就没了」的注册。
            const 现有 = deps.getConfig()?.createdPresets ?? []

            try {
                await update({ createdPresets: [...现有, 定义] })

            } catch (err) {
                const 注销 = 注销器组.get(预设id)
                注销器组.delete(预设id)
                await 注销?.().catch(() => undefined)

                throw err
            }
        },

        async remove(预设id, update) {
            const 现有 = deps.getConfig()?.createdPresets ?? []

            if (现有.every((定义) => 定义?.id !== 预设id)) {
                throw new Error(`「${预设id}」不是本插件建的预设，删不了`)
            }

            const 注销 = 注销器组.get(预设id)
            注销器组.delete(预设id)

            if (注销 !== undefined) {
                try {
                    await 注销()

                } catch (err) {
                    deps.logger.warn?.(`[agent-studio] 预设「${预设id}」注销失败（配置照样摘掉）：${reasonOf(err)}`)
                }
            }

            await update({ createdPresets: 现有.filter((定义) => 定义?.id !== 预设id) })
        },
    }
}
