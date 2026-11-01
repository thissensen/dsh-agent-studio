/** 平台计时器上限（`@deepseek-ai/dsh-timeout@0.2.1-rc.2` 的 `MAX_TIMER_DELAY_MS`）。 */
export const PTC_BUDGET_MAX_MS = 2_147_483_647;
// 原值的挂载键。用 Symbol.for 挂在 runtime 实例上：插件 reload 后模块重新求值，只有挂在
// 实例上才认得出「这个实例的预算是我抬起来的」。
// 键里带本插件名：别的插件抄同一段逻辑时各有各的键，两个插件都开着就会互相拆台——各自记
// 一份原值，先关的那个把上限降回去、后关的那个又把上限留在进程里。本插件不为这种共存做引用
// 计数那一套，两个都要就只能留一个。
const ORIGINAL_BUDGET_KEY = Symbol.for('dsh-agent-studio.ptcBudgetOriginal');
/** 同一个 runtime 只警告一次，免得每次改配置都往日志里灌一遍。 */
const 已警告组 = new WeakSet();
// 这条 inject 独占、不能并进别处的依赖数组：可选服务并进共享依赖时，缺这个服务会让整条
// 回调永不执行（静默、无日志、不报错）。没装 PTC 的 profile 里这个服务本来就不存在，
// 本段逻辑跟着一起缺席才是对的。
export function mountPtcBudget(ctx, logger, isEnabled) {
    ctx.inject(['ptcRuntime'], (ptcCtx) => {
        const runtime = ptcCtx.ptcRuntime;
        const 同步预算 = () => applyPtcBudget(runtime, isEnabled(), logger);
        同步预算();
        // 不按命名空间过滤：读一个布尔的成本可忽略，过滤反而多一处静默失效点。
        ptcCtx.on('settings/document-updated', () => 同步预算());
        // 插件卸载 / reload 时还原，别把抬过的上限留给下一份插件实例。
        ptcCtx.effect?.(() => () => applyPtcBudget(runtime, false, logger), 'agent-studio: ptc budget');
    });
}
/** 按目标态收敛 runtime 的预算（幂等，不返回 disposer）。 */
export function applyPtcBudget(runtime, enabled, logger) {
    if (runtime === null || typeof runtime !== 'object')
        return;
    const config = runtime.config;
    if (config === null || typeof config !== 'object')
        return;
    // 静默返回：平台基类的 `timeout` 默认就是 undefined，允许 PTC 实现没有预算概念。
    if (typeof config.timeoutMs !== 'number' || typeof config.maxTimeoutMs !== 'number')
        return;
    const 挂载表 = runtime;
    const 已记录 = 挂载表[ORIGINAL_BUDGET_KEY];
    try {
        if (enabled) {
            // 已有原值就返回：重捕获会把抬高的值当原值，关了再也降不回来。
            if (已记录 !== undefined)
                return;
            const 原值 = { timeoutMs: config.timeoutMs, maxTimeoutMs: config.maxTimeoutMs };
            挂载表[ORIGINAL_BUDGET_KEY] = 原值;
            config.timeoutMs = PTC_BUDGET_MAX_MS;
            config.maxTimeoutMs = PTC_BUDGET_MAX_MS;
            // 日志必须打捕获到的原值：两个字段此刻已被改过，读 config 只会看到上限。
            logger.info?.(`[agent-studio] 程序预算已抬到 ${PTC_BUDGET_MAX_MS} ms（原值 timeoutMs=${原值.timeoutMs}, maxTimeoutMs=${原值.maxTimeoutMs}）`);
            return;
        }
        if (已记录 === undefined)
            return;
        config.timeoutMs = 已记录.timeoutMs;
        config.maxTimeoutMs = 已记录.maxTimeoutMs;
        delete 挂载表[ORIGINAL_BUDGET_KEY];
        logger.info?.(`[agent-studio] 程序预算已还原（timeoutMs=${已记录.timeoutMs}, maxTimeoutMs=${已记录.maxTimeoutMs}）`);
    }
    catch (err) {
        if (已警告组.has(runtime))
            return;
        已警告组.add(runtime);
        logger.warn?.('[agent-studio] 程序预算改不动（config 被冻结或字段只读），该开关不生效', err);
    }
}
