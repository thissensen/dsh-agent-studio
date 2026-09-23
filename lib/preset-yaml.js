/**
 * 预设构成声明的 YAML 方言：读一份、写一份，两处口径必须完全一致。
 *
 * 平台的预设声明是 **entry-list YAML**，`cordis-plugin-loader` 在激活每条 row 时会对
 * `disabled` 求值——而 `!!js` 标量就是「这里是一段表达式，别当字符串」的标记。插件要在
 * 两个方向上搬运这份声明（读来源预设 → 存进自己的配置 → 重启时读回来注册），
 * 所以方言只在这里定义一次。
 *
 * 方言与平台 `cordis-plugin-include` 里那份**同形**（2026-09-24 读源码核对，并在 4 个
 * 官方预设上实测两者解析结果逐字节一致）：`JSON_SCHEMA.extend(!!js)`，标量构造成
 * `{ __jsExpr: 源码 }`——平台的 `isJsExpr()` 判据就是 `'__jsExpr' in value`。
 * 基准 schema 也照平台用 `JSON_SCHEMA`（严格 JSON 风格：`yes` / `on` 是字符串，不是布尔）。
 *
 * **为什么要以「文本」形态存进插件配置**（2026-09-24 真机实测）：平台的 `settings`
 * 写入通道重建 volatile 配置时，会把表达式节点**求值成普通值**——解析好的 `plugins`
 * 数组一进配置，`disabled` 就固化成写那一刻的布尔，跨平台的适配语义随即丢失。
 * 文本是惰性的：存文本、用时再解析，表达式原样还在。
 *
 * @module dsh-agent-studio/preset-yaml
 */
import { dump, load, JSON_SCHEMA, Type } from 'js-yaml';
/** entry-list 方言里的 `!!js` 类型（与平台那份同形）。 */
const JsExpr = new Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: (数据) => typeof 数据 === 'string',
    construct: (数据) => ({ __jsExpr: 数据 }),
    predicate: (值) => 值 !== null && typeof 值 === 'object' && '__jsExpr' in 值,
    represent: (值) => 值.__jsExpr,
});
/** 本插件读写成构成声明用的方言（与平台的 `entryListSchema` 等价）。 */
export const ENTRY_LIST_SCHEMA = JSON_SCHEMA.extend(JsExpr);
/**
 * 解析一份构成声明文本。
 * @param 文本 - entry-list YAML 文本。
 * @param 说明 - 出错时放进消息里的来源说明（哪份预设）。
 * @returns row 数组。
 */
export function parsePlugins(文本, 说明) {
    if (文本.trim() === '')
        throw new Error(`${说明}的构成声明是空的`);
    let 数据;
    try {
        数据 = load(文本, { schema: ENTRY_LIST_SCHEMA });
    }
    catch (err) {
        throw new Error(`解析${说明}的构成声明失败：${err.message ?? String(err)}`);
    }
    if (!Array.isArray(数据))
        throw new Error(`${说明}的构成声明不是一份 row 列表`);
    return 数据;
}
/**
 * 把一份 row 数组序列化成构成声明文本。
 * @param 行组 - row 数组。
 * @returns entry-list YAML 文本（`!!js` 表达式按方言写回）。
 */
export function stringifyPlugins(行组) {
    return dump(行组, { schema: ENTRY_LIST_SCHEMA, noRefs: true, lineWidth: -1 });
}
