/**
 * 预设的**工具呈现方式**：继承部署默认（`inherit`）/ 原生（`native`）/ PTC（`ptc`）。
 *
 * 预设级呈现方式只有一个机制：**预设 standing scope 里挂哪一条执行器行**。
 * 平台给每个 scope 只留一条执行器、选取时沿 scope 链就近赢、root 那份是部署默认
 * （`dsh-tools/lib/index.js:598-600` 的 `setExecutor` 与 `:624-634` 的 `selectExecutor`）
 * ⇒ 「读」= 看 `plugins` 里有什么，「写」= 增删那条行。
 *
 * 本模块是纯函数：不碰服务、不落盘、不读文件，端点在它之外做 IO 与注册。
 * 输入输出都是 `preset-yaml.ts` 方言解析出来的行数组（不是行文本）——行文本只在那一份
 * 方言里读写，这里再写一套扫描器就会与它分叉。
 *
 * 旧写法（`dsh-agent-tool-presentation` + `config.mode`）在 0.2.2 **依然生效**
 * （`dsh-agent-tool-presentation/lib/index.js:28-30` 直接 `ctx.plugin` 对应执行器），
 * 所以它同样是一条呈现行：读的时候认它，写的时候换成新写法（见 `writePresentation`）。
 *
 * @module dsh-agent-studio/preset-presentation
 */
import { parsePlugins, stringifyPlugins } from './preset-yaml.js';
/** 新式呈现行的包名：挂哪一条，就由哪个执行器呈现工具。 */
const 新式呈现名组 = {
    native: '@deepseek-ai/dsh-tool-executor-native',
    ptc: '@deepseek-ai/dsh-tool-executor-ptc',
};
/** 旧写法的包名：它自己按 `config.mode` 挂上对应执行器，效果与新写法同档。 */
const 旧式呈现名 = '@deepseek-ai/dsh-agent-tool-presentation';
/** 一条行是不是呈现行（顶层与分组内一视同仁）。 */
function isPresentationRow(行) {
    return 行.name === 新式呈现名组.native || 行.name === 新式呈现名组.ptc || 行.name === 旧式呈现名;
}
/**
 * 分组里有没有呈现行。
 *
 * `group: true` 建的是下一层 scope：往里增删行会改掉用户写的结构，插件宁可拒绝也不做
 * 递归手术，所以只判「有没有」，不判是哪一档。
 *
 * @param 行组 - 已解析的 row 数组（`parsePlugins` 已保证 `group` 行的 `config` 是 row 数组）。
 */
function hasNestedPresentation(行组) {
    for (const 行 of 行组) {
        if (行.group !== true)
            continue;
        const 子行组 = 行.config;
        if (子行组.some(isPresentationRow) || hasNestedPresentation(子行组))
            return true;
    }
    return false;
}
/**
 * 读一份构成声明的呈现方式。
 *
 * 判定顺序即优先级，第一条命中就返回：嵌套 ⇒ 畸形；多条 ⇒ 畸形；单条新式 ⇒ 新档；
 * 单条旧式 ⇒ 旧档 + `legacy`；零条 ⇒ 继承。
 *
 * @param 行组 - 一份预设的顶层 row 数组。
 * @returns 档位、是否旧写法、可不可改。
 */
export function readPresentation(行组) {
    if (hasNestedPresentation(行组)) {
        return { presentation: 'inherit', legacy: false, editable: false, problem: '呈现行嵌在分组里，插件不改这种构成' };
    }
    const 呈现行组 = 行组.filter(isPresentationRow);
    if (呈现行组.length === 0)
        return { presentation: 'inherit', legacy: false, editable: true, problem: null };
    if (呈现行组.length > 1) {
        return { presentation: 'inherit', legacy: false, editable: false, problem: `找到 ${呈现行组.length} 条呈现行（同一 scope 只能有一条）` };
    }
    const 行 = 呈现行组[0];
    // 停用判定对新旧两种写法一样：`disabled: true` 等于没声明（写任一档都会换掉它），
    // 而表达式（`!!js`）意味着「按环境开合」——插件算不出结果，就不去动它。
    if (行.disabled === true) {
        return { presentation: 'inherit', legacy: false, editable: true, problem: '这条呈现行被 disabled: true 停用' };
    }
    if (行.disabled !== undefined && typeof 行.disabled !== 'boolean') {
        return { presentation: 'inherit', legacy: false, editable: false, problem: '这条呈现行的 disabled 是表达式，插件不改' };
    }
    if (行.name === 旧式呈现名) {
        const 模式 = 行.config?.mode;
        if (模式 !== 'native' && 模式 !== 'ptc') {
            return { presentation: 'inherit', legacy: false, editable: false, problem: '旧呈现行没有可识别的 mode' };
        }
        return { presentation: 模式, legacy: true, editable: true, problem: null };
    }
    const 档位 = 行.name === 新式呈现名组.native ? 'native' : 'ptc';
    return { presentation: 档位, legacy: false, editable: true, problem: null };
}
/**
 * 把一份构成改成目标档位。
 *
 * 三条取舍都是为了「写下去的构成是平台认得的」：
 * 1. 行对象只写 `id` + `name`：native 没有 `Config`，ptc 的 `maxParallelSubCalls` 用平台
 *    默认的 10；`disabled` 更不写——用户显式定档就是无条件生效。
 * 2. 有原位就在原位替换（diff 最小，落点与平台自己的 `ptc` 预设一致），没有就追加到末尾
 *    （执行器行与工具注册之间没有顺序依赖）。
 * 3. 写完当场 `stringifyPlugins` → `parsePlugins` 回读：读不成目标档就当作写入失败，
 *    调用方因此拿不到未经校验的构成。
 *
 * @param 行组 - 当前的顶层 row 数组。
 * @param 目标档位 - 要改成哪一档。
 * @returns 改动后的 row 数组；`changed === false` 表示本来就是这一档，没有写盘的必要。
 */
export function writePresentation(行组, 目标档位) {
    const 当前事实 = readPresentation(行组);
    if (!当前事实.editable)
        throw new Error(当前事实.problem ?? '这份构成不让插件改呈现方式');
    const 顶层呈现行组 = 行组.filter(isPresentationRow);
    let 下一组;
    if (目标档位 === 'inherit') {
        // 显式选「继承」= 连旧式行一起删：旧写法在 0.2.2 依然生效，留着它「继承」就名不副实。
        if (顶层呈现行组.length === 0)
            return { 行组: [...行组], changed: false };
        下一组 = 行组.filter((行) => !isPresentationRow(行));
    }
    else {
        const 原行 = 顶层呈现行组[0];
        const 目标行 = { id: `tool-executor-${目标档位}`, name: 新式呈现名组[目标档位] };
        const 已是目标形态 = 原行 !== undefined
            && 原行.name === 目标行.name
            && 原行.disabled === undefined
            && 原行.config === undefined;
        if (已是目标形态)
            return { 行组: [...行组], changed: false };
        const 插入下标 = 原行 === undefined ? 行组.length : 行组.indexOf(原行);
        下一组 = 行组.filter((行) => !isPresentationRow(行));
        下一组.splice(插入下标, 0, 目标行);
    }
    // 写后自校验：方言或平台行校验只要有一处回归，这里当场抛——绝不把认不出的构成写进配置。
    const 回读事实 = readPresentation(parsePlugins(stringifyPlugins(下一组), '改档后的构成声明'));
    if (回读事实.presentation !== 目标档位 || !回读事实.editable) {
        throw new Error(`改档后的构成声明回读不成「${目标档位}」：读到「${回读事实.presentation}」，${回读事实.problem ?? '没有给出原因'}`);
    }
    return { 行组: 下一组, changed: true };
}
