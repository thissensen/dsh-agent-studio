/**
 * dsh-agent-studio —— host 半边。
 *
 * 装配期的两条通道都在这里接上：只读观察层（observe）与生效层（apply）。
 *
 * **配置面归平台**：插件只导出 schema（`Config`），平台把 profile 里这条 row 的 `config`
 * 校验后从 `apply(ctx, config)` 交进来；写入交回平台的 `settings` 服务。插件自己不落任何
 * 配置文件——这是立身之本。面板靠 HTTP 路由取数、写配置，所以路由挂在 `webServer` 注入
 * 回调里，并从外面取当前配置作用域。
 *
 * **改配置不重启插件**：平台把 `Config` 里每个字段包成 volatile 引用（见 `config.ts`），
 * 所以我们读的是「现取现解包」，引用被平台就地更新，值就跟着变。三层与 HTTP 端点因此在
 * 配置改动后**照旧有效**，不必重挂。
 *
 * 关于 `name`：`cordis.patch.yml` 里那个 row 的 `id` 必须与它一致。
 *
 * 关于 `ctx.inject([...], …)`：用注入回调而不是 `inject: [...]` 顶层声明，
 * 是为了让本插件在缺服务的组合里也能挂载——`ctx.settings` 缺席时三层不挂，
 * `ctx.webServer` 缺席时（纯 CLI 组合）路由不挂，观察层照常工作，
 * 与「缺省不干预」原则一致。
 *
 * @module dsh-agent-studio
 */
import { SETTINGS_NAMESPACE, readConfig } from './config.js';
import { mountAttribution } from './attribution.js';
import { mountObservation } from './observe.js';
import { mountApply } from './apply.js';
import { mountDelegation } from './delegate.js';
import { mountFallback } from './fallback.js';
import { mountApi } from './api.js';
import { createPresetRegistry } from './preset-registry.js';
export const name = 'agent-studio';
/** 平台按这个名字认配置 schema（`Config = { … }` 是平台侧的约定名）。 */
export { Config } from './config.js';
export function apply(ctx, config) {
    const logger = ctx.logger ?? console;
    logger.info?.('[agent-studio] host 半边已挂载');
    // 归因先挂：它要在工具注册**发生的那一刻**记录归属，观察层只是来读表。
    // 挂载失败只影响面板的来源分组（退化成「其他来源」），不能殃及后面的两层。
    let ownerOf;
    try {
        ownerOf = mountAttribution(ctx, logger).ownerOf;
    }
    catch (err) {
        logger.error?.('[agent-studio] 工具来源归因未挂上；面板分组退化为「其他来源」', err);
    }
    mountObservation(ctx, logger, { ownerOf });
    // 配置作用域在另一个注入回调里就绪，而两个回调的先后顺序不作保证；
    // 所以路由拿的是「现问现取」的取值函数，而不是注册方推送过来的对象。
    let settingsScope = null;
    // 自建预设的运行时注册表。它读配置、写注册，两半也都在别的注入回调里就绪，
    // 所以同样是「现问现取」；读不到配置时它就当作清单为空（什么都不注册）。
    const registry = createPresetRegistry(() => ctx.get?.('agentPresets'), { getConfig: () => (settingsScope === null ? undefined : settingsScope.get()), logger });
    ctx.inject(['webServer', 'webRuntime'], (webCtx) => {
        mountApi(webCtx, logger, {
            getScope: () => settingsScope ?? undefined,
            getPresets: () => ctx.get?.('agentPresets'),
            getRegistry: () => registry,
            getLlm: () => ctx.get?.('llm'),
            getSkills: () => ctx.get?.('skills'),
            getAgents: () => ctx.get?.('agents'),
        });
    });
    // 平台把预设从「目录里的文件」改成「运行时注册」之后，**插件每次启动都得把自建预设
    // 重新注册一遍**（平台不落盘，见 preset-registry.ts）。挂在 agentPresets 的注入回调里
    // 是唯一能确保服务已经在的时机；配置还没就绪时 `sync()` 自然什么都不做。
    ctx.inject(['agentPresets'], () => {
        void registry.sync().catch((err) => logger.error?.('[agent-studio] 自建预设重放失败', err));
    });
    ctx.inject(['settings'], (settingsCtx) => {
        const settings = settingsCtx.settings;
        const scope = {
            get: () => readConfig(config),
            update: (patch) => settings.update(SETTINGS_NAMESPACE, patch),
        };
        settingsScope = scope;
        const agentCount = scope.get().agents?.length ?? 0;
        logger.info?.(`[agent-studio] 配置已就绪 · 已配置代理数=${agentCount}`);
        // 平台在配置落盘后发这个事件，参数是 profile entry id（也就是我们的命名空间）。
        // 除了留痕，还要把自建预设的内存注册拉回与配置一致——面板保存、手改配置文件
        // 都会走到这里；`sync()` 是增量的、幂等的。
        ctx.on('settings/document-updated', (ns) => {
            if (ns !== SETTINGS_NAMESPACE)
                return;
            logger.info?.(`[agent-studio] 配置已变更 · 已配置代理数=${scope.get().agents?.length ?? 0}`);
            void registry.sync().catch((err) => logger.error?.('[agent-studio] 自建预设同步失败', err));
        });
        // 这三段的异常必须就地接住，不能让它们冒到这一层回调外——路由与观察层已经挂上，
        // 挂载失败的影响面只该是「那一层不生效」。
        //
        // 2026-09-16 连续撞了两次这个形状：先是 `ctx.tools` 的属性访问抛错，接着是与用户
        // 已装插件重名时 `tools.register` 抛错；当时登记挂在 effect 上，抛错会把登记一起
        // 回滚，配置就变成「读得到、写不了」。现在配置登记归平台，但「一层坏了别拖垮别处」
        // 这条防线照旧。
        try {
            mountApply(ctx, logger, scope);
        }
        catch (err) {
            logger.error?.('[agent-studio] 生效层挂载失败；配置写入不受影响', err);
        }
        try {
            mountDelegation(ctx, logger, scope);
        }
        catch (err) {
            logger.error?.('[agent-studio] 派活工具未挂上；配置写入不受影响', err);
        }
        try {
            mountFallback(ctx, logger, scope);
        }
        catch (err) {
            logger.error?.('[agent-studio] 模型自动降级未挂上；配置写入不受影响', err);
        }
    });
}
