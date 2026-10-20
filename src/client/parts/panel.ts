/**
 * dsh-agent-studio 的「面板部件」：真正的面板实现。壳在 `src/client/index.ts`。
 *
 * **谁加载它。** 壳挂在设置页里的 `ShellSection` 用 <script> 标签加载这个文件的
 * 构建产物（host 的 `/api/dsh-agent-studio/client-parts/panel.js` 路由**每次读盘**
 * 伺服），加载完成后壳 `require('dsh-agent-studio-panel')` 拿到的就是这里的
 * `AgentStudioSection`。**改这个文件只需要刷新页面**——它不在 DSH 的启动快照里；
 * 但改壳（以及 lib/、client/ 下的其它文件）仍要重启 DSH。
 *
 * **注册形态。** bundle 的包装层（`vite.shared.ts` 的 renderChunk）把整个模块包进
 * `window.__ModuleLoader__.load({ id, factory })` 外壳，所以这个文件自己**不写**
 * 注册代码，只导出 `AgentStudioSection`。
 *
 * **面板形态（v2）。** Agent 中心 = 顶栏（预设 / 主代理绑定 / 保存区三排）＋
 * 左栏（二级菜单：Agent 池 / 提示词集 / 工具集 / 技能集，各自的项在池名下）＋
 * 主区（选中项的编辑器，顶部一排「新建 / 复制 / 删除」）。四个池互相独立、多对多引用：
 *
 *   - **绑定即接管**（覆盖语义）：绑了代理的预设，提示词、工具面与技能面完全按该代理
 *     装载的集来——一个都没装 = 空（不是"不干预"）；没绑定的预设完全不干预。
 *   - 工具面：装了工具集 = 收窄到它们的并集（空集 = 全排除，含平台装在 agent 本层的
 *     工具）；一个都不装 = 不干预（全给）。
 *   - 技能面同理；「注入运行时环境快照」开关**按代理**（runtimeContextOff）。
 *
 * **数据从哪来。** 全经 `/api/dsh-agent-studio/*`（见 host 侧 `src/host/api.ts`）：
 * 观察结果、插件配置、平台预设列表、模型目录、技能清单，以及写配置与管预设的端点。
 * 面板不自己拼配置、不缓存拷贝，每次打开或点刷新都重新问 host；改动先进草稿
 * （全量四件套），点「保存改动」才写回。
 *
 * **模块地图（部件内部怎么分）。** 这个文件只是入口，实现按职责拆在 `src/client/parts/`：
 *
 * - `panel-core.ts` —— 面板本体：`AgentStudioSection` 与 `PanelBody`（取数 / 草稿 / 交互都在这里）
 * - `panel-chrome.ts` —— 面板外框四件套：顶栏、保存行、导入确认弹窗、左栏
 * - `panel-main.ts` —— 主区卡片：Agent 详情与集库
 * - `panel-sections.ts` —— 提示词集编辑器（段清单）
 * - `panel-pickers.ts` —— 工具清单 / 技能清单两个选择器（共用折叠组头）
 * - `panel-routes.ts` —— 模型选择与自动降级
 * - `panel-widgets.ts` —— 通用小件与各组件共用的 `h`
 * - `panel-draft.ts` —— 草稿层：克隆 / 归一 / 自愈 / 冲突校验 / 导入合并
 * - `panel-api.ts` —— `/api/dsh-agent-studio/*` 的取数与写回
 * - `panel-observe.ts` —— 观察事实整理（平台投递了什么 → 界面要的形状）
 * - `panel-types.ts` —— 部件各模块共用的类型
 * - `panel-constants.ts` —— 跨模块共用的常量表
 * - `panel-translate.ts` —— 翻译上下文 `TranslateContext` / `useT`（**全仓只能有一份实例**）
 *
 * @module dsh-agent-studio/client-parts/panel
 */

export { AgentStudioSection } from './panel-core'
