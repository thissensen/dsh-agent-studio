/**
 * dsh-agent-studio —— host 半边。
 *
 * 装配期的两条通道都在这里接上：只读观察层（observe）与生效层（apply）。
 * 生效层依赖设置服务，所以挂在 `settings` 注入回调里；面板靠 HTTP 路由取数、
 * 写配置，所以路由挂在 `webServer` 注入回调里，并从外面取当前设置作用域。
 *
 * 关于 `name`：`cordis.patch.yml` 里那个 row 的 `id` 必须与它一致。
 *
 * 关于 `ctx.inject([...], …)`：用注入回调而不是 `inject: [...]` 顶层声明，
 * 是为了让本插件在缺服务的组合里也能挂载——`ctx.settings` 缺席时生效层不挂，
 * `ctx.webServer` 缺席时（纯 CLI 组合）路由不挂，观察层照常工作，
 * 与「缺省不干预」原则一致。
 *
 * @module dsh-agent-studio
 */

import type { Ctx, Logger, SettingsScope, StudioConfig, SettingsService } from './types.js'
import { ConfigSchema, SETTINGS_NAMESPACE } from './config.js'
import { mountAttribution } from './attribution.js'
import { mountObservation } from './observe.js'
import { mountApply } from './apply.js'
import { mountDelegation } from './delegate.js'
import { mountFallback } from './fallback.js'
import { mountApi } from './api.js'

export const name = 'agent-studio'

export function apply(ctx: Ctx, config: unknown) {
    const logger: Logger = ctx.logger ?? console
    logger.info?.('[agent-studio] host 半边已挂载')

    // 归因先挂：它要在工具注册**发生的那一刻**记录归属，观察层只是来读表。
    // 挂载失败只影响面板的来源分组（退化成「其他来源」），不能殃及后面的两层。
    let ownerOf: ((name: string) => string | undefined) | undefined
    try {
        ownerOf = mountAttribution(ctx, logger).ownerOf

    } catch (err) {
        logger.error?.('[agent-studio] 工具来源归因未挂上；面板分组退化为「其他来源」', err)
    }

    mountObservation(ctx, logger, { ownerOf })

    // 设置作用域在另一个注入回调里就绪，而两个回调的先后顺序不作保证；
    // 所以路由拿的是「现问现取」的取值函数，而不是注册方推送过来的对象。
    let settingsScope: SettingsScope | null = null
    // 服务本体另存一份：删除预设时要按路径清单（`mutate` 的 unset）清掉该预设的
    // 配置分区——scope 上没有这个能力，而合并写删不掉对象键（见 `presets.js`）。
    let settingsService: SettingsService | null = null

    ctx.inject(['webServer', 'webRuntime'], (webCtx: Ctx) => {
        mountApi(webCtx, logger, {
            getScope: () => settingsScope ?? undefined,
            getSettings: () => settingsService ?? undefined,
            getPresets: () => ctx.get?.('agentPresets'),
            getLlm: () => ctx.get?.('llm'),
            getSkills: () => ctx.get?.('skills'),
            getAgents: () => ctx.get?.('agents'),
        })
    })

    ctx.inject(['settings'], (settingsCtx: Ctx) => {
        settingsService = settingsCtx.settings as SettingsService
        const scope = (settingsCtx.settings as SettingsService).register(SETTINGS_NAMESPACE, ConfigSchema, {
            base: config,
        })

        settingsScope = scope

        const agentCount = scope.get()?.agents?.length ?? 0
        logger.info?.(`[agent-studio] 配置命名空间已注册 · 已配置代理数=${agentCount}`)

        const watch = scope.watch as ((cb: (next: StudioConfig | undefined) => void) => void) | undefined
        watch?.((
            next: StudioConfig | undefined,
        ) => {
            const count = next?.agents?.length ?? 0
            logger.info?.(`[agent-studio] 配置已变更 · 已配置代理数=${count}`)
        })

        // 这两段的异常必须就地接住，不能让它们冒到这一层回调外。
        //
        // 注册的登记挂在一个 effect 上，**注册之后再抛错会把登记一起回滚**：scope 的
        // `get()` 读的是闭包里的 resolved（所以读永远正常），`update()` 要查服务实例的
        // 注册表（查不到就报 `settings namespace "agent-studio" is not registered`）——
        // 于是配置变成「读得到、写不了」，而报错现场在写入端，离真凶很远。
        // 2026-09-16 连续撞了两次这个坑：先是 `ctx.tools` 的属性访问抛错，接着是与用户
        // 已装插件重名时 `tools.register` 抛错。挂载失败的影响面只该是「那一层不生效」，
        // 绝不该殃及写入通道。
        try {
            mountApply(ctx, logger, scope)

        } catch (err) {
            logger.error?.('[agent-studio] 生效层挂载失败；配置写入不受影响', err)
        }

        try {
            mountDelegation(ctx, logger, scope)

        } catch (err) {
            logger.error?.('[agent-studio] 派活工具未挂上；配置写入不受影响', err)
        }

        try {
            mountFallback(ctx, logger, scope)

        } catch (err) {
            logger.error?.('[agent-studio] 模型自动降级未挂上；配置写入不受影响', err)
        }
    })
}
