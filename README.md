# dsh-agent-studio

[![在线文档](https://img.shields.io/badge/%E5%9C%A8%E7%BA%BF%E6%96%87%E6%A1%A3-thissensen.github.io%2Fdsh--agent--studio-blue)](https://thissensen.github.io/dsh-agent-studio/)
[![npm version](https://img.shields.io/npm/v/dsh-agent-studio?logo=npm&logoColor=white&color=cb3837)](https://www.npmjs.com/package/dsh-agent-studio)
[![CI](https://github.com/thissensen/dsh-agent-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/thissensen/dsh-agent-studio/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/thissensen/dsh-agent-studio?color=3da639)](./LICENSE)

**简体中文** · [English](README.en.md) · [在线文档](https://thissensen.github.io/dsh-agent-studio/)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 图形化插件：**可视化地精确配置 Agent 的提示词（prompt）、工具（tools）、可见技能（skills）、子代理、备用模型，轻松创建团队，根据不同任务分配不同模型**。

模型每一轮看到的东西就三份：**系统提示词**、**工具目录**、**技能目录**。随着插件、工具、MCP 越装越多，这三份只会越来越大，拖累模型表现。另外 DSH 目前给子代理的配置极其简陋，没法轻松配置它的提示词、工具、技能、模型和思考强度。

本插件**不写、不删、不改宿主的任何预设文件**，卸载即恢复原状。

它把 Agent 拆成可随意拼装的积木：提示词、工具、技能、模型拼成一个完整 Agent，**子代理也一样能高度定制**；预设可以随手新建；兼容官方 PTC 模式；支持设备备用模型。

可以搭配 [dsh-context](https://github.com/bowenliang123/dsh-context) 一起用，查看模型这一轮实际收到的提示词、工具和 skill 到底长什么样。

## 它解决什么

| 你可能遇到过的问题                      | 平台的默认行为                              | 装上之后                               |
| ------------------------------ | ------------------------------------ | ---------------------------------- |
| 系统提示词越堆越长，关不掉也用不上              | 预设里注册了哪些段就投递哪些段                      | 按 agent 编一份白名单，名单外的段不进上下文          |
| 工具越装越多，同类工具一大堆，模型挑不准           | 工具面按已装的插件全量下发                        | 挑出这个 agent 要用的，其余收起来               |
| 技能多了不好管                        | 所有 `modelInvocable` 的 skill 都进目录     | 勾哪些就给哪些，不勾的模型看不见                   |
| 每个 step 都塞一段运行时快照              | 官方按 step 动态注入，没有开关                   | 代理级开关，关掉就不用再收                      |
| 子代理只能整套继承主代理，占用大量上下文           | 官方 `subagent` 既没有条目标识，也没法按角色裁剪       | 每个子代理独立配：模型 / 提示词 / 工具 / 技能 / 后台模式 |
| PTC 模式下创建的子代理也是 PTC            | 官方默认继承主代理的模式                         | 子代理走原生还是 PTC，你说了算                |
| 干不同的活想用不同的提示词、工具、Skill，切来切去很麻烦 | 预设只管提示词组合，工具和 skill 是全局一套，换个预设照旧全量下发 | 给预设挂的 Agent 一切换即可                  |
| 本地部署模型上下文紧张，根本对话不了几轮           | 做不到提示词全清，只能创造模式自己建一个                 | 创建一个什么都不挂的Agent，给预设绑上就行，真 · 0提示词   |
| 主模型限流了 / 挂了，整轮直接失败             | 只在一个 provider 里重试到上限，然后放弃            | 配一条**备用候选链**（可跨供应商），失败按顺序顶上        |

## 安装

按你手头的条件挑一条：有网络就用 npm，内网或离线用 GitHub Release 的安装包，想改代码就走源码。

### 从 npm

```sh
dsh plugin --profile web add dsh-agent-studio
```

### 从 GitHub Release 下载

到 [Releases](https://github.com/thissensen/dsh-agent-studio/releases) 下载 `dsh-agent-studio-<版本>.tgz`，它就是 npm 上那份包，`lib/` 与 `client/` 的构建产物都在里面，不用自己构建：

```sh
dsh plugin --profile web add "./dsh-agent-studio-0.1.2.tgz"
```

包放在哪个目录都行，把路径写对即可（`./` 开头或绝对路径），文件名里的版本号换成你实际下载的那个。**离线、内网环境走这条。**

### 从源码

```sh
git clone https://github.com/thissensen/dsh-agent-studio.git dsh-agent-studio
cd dsh-agent-studio

pnpm install                      # 只装 devDependencies；peer 是宿主包，不走 registry
node scripts/link-deps.mjs web    # 把宿主的 @deepseek-ai/* 链进本项目的 node_modules
dsh plugin --profile web add "link:<本目录的绝对路径>"
```

也可以把 Release 页的源码压缩包（`Source code (zip)`）解压出来代替 `git clone`，后续步骤一样。

三条路装完都**重启一次 DSH**，在 **设置 → Agent 中心** 看到面板就成了。

- `link:` 装法下改 `lib/` 立即生效；**改面板（`client/parts/panel.js`）刷新页面**就行，不用重启。
- 改 `package.json` 的入口类字段（`main` / `exports` / `dsh.*`）后必须重启。
- `--profile` 填 `web`（纯 Web 版）或 `desktop`（桌面版）。桌面版就是 Web 版加一层 Electron 壳，host 半边一行不用改。

### 卸载

```sh
dsh plugin --profile web remove dsh-agent-studio
```

卸载后宿主配置里不留任何痕迹。预设从没被改过，其余配置都在插件自己的数据里。

## 面板预览

界面有浅色、深色两套：

<p align="center">
  <img src="assets/panel-overview-light.png" width="49%" alt="Agent 详情：预设绑定、Agent 身份与 Agent 模式">
  <img src="assets/panel-overview-dark.png" width="49%" alt="Agent 详情（深色）">
</p>

<img src="assets/agent-detail.png" width="520" alt="Agent 完整详情">

<img src="assets/prompt-set.png" width="620" alt="提示词集：段清单、PTC 专属标记、自定义与平台预设">

<img src="assets/tool-set.png" width="420" alt="工具集：按来源分组的工具候选">

<img src="assets/skill-set.png" width="480" alt="技能集：按来源分组的候选 skill">

| 区域          | 做什么                                                          |
| ----------- | ------------------------------------------------------------ |
| 左侧「Agent 池」 | 每个 agent 一条：绑哪个预设、装哪些集、Agent 模式、子代理名册                          |
| 左侧集库        | 提示词集 / 工具集 / 技能集三类列表：新建、复制、改名、删除                       |
| 右侧详情        | 选中集 → 编成员；选中 agent → 装载集、配模型与后台模式、挂子代理、切快照开关                   |
| 顶栏          | 预设 tab 与新建 / 删除预设、主代理绑定、全量导入 / 导出（导出的是草稿，含未保存的改动）             |
| 底栏          | 保存改动；池级导入 / 导出                                                |

导入会先弹一个确认框（全量导入与池级导入**共用一个**），里面的**「是否覆盖」**开关决定撞 id 时是覆盖还是报错；导入只并入草稿，点了保存才落盘。

改 id 之前会先列出谁在引用它，改的时候把所有引用一并同步，不留悬空引用。

## 四个池，互相独立

四类配置对象各管各的，可以多对多引用。集建好之后，能被多个 agent 装载。

| 池                     | 干什么用                                                              |
| --------------------- | ----------------------------------------------------------------- |
| **代理** `Agents`       | 指定绑给哪个预设；配 Agent 模式（跟随预设 / 原生 / 强制 PTC）、提示词、工具、skill、子代理名册，以及被当子代理时的模型与思考强度 |
| **提示词集** `promptSets` | 有序的提示词清单，顺序可调                                                     |
| **工具集** `toolSets`    | 工具名清单，插件的和 MCP 的都在里面                                              |
| **技能集** `skillSets`   | Skill 清单，决定哪些能被 AI 自主调用                                           |

- **装载**：把集挂到 Agent 上。同一个 Agent 装载的集之间不允许有重叠成员，界面和写入端点各拦一道。
- **绑定**：把某个预设绑到一个 Agent 上，这个预设就交给它管了。

## 语义边界

绑定之后，这个预设就归这个 Agent 管。三面一个规矩：**没装就是空的**。

| 概念   | 规则                                            |
| ---- | --------------------------------------------- |
| 绑定预设 | 被绑定的预设，提示词、工具、skill、子代理全部交给这个 Agent；解除绑定即恢复原样 |
| 提示词集 | 一个都不装 = 投递空提示词                                |
| 工具集  | 一个都不装 = 一个工具都不给                               |
| 技能集  | 一个都不装 = 一个 skill 都不暴露；装了就只看勾的                 |

## 模型自动降级（可选）

给代理配一条**备用候选链**，主选失败就按链依次顶上。**不配备用候选 = 完全不接管**，重试行为与平台默认一致。

- **重试次数**：每个候选**各自**的上限，默认 5（与平台默认对齐）。可重试的错误（空响应 / 限流 / 服务端错误 / 超时 / 传输错误）在当前候选上重试到上限，才换下一个候选；额度耗尽、凭据失效这类错误不重试，直接换。
- **链怎么排**：子代理 = 启动时给的路由（没配模型就是继承）→ 备用候选；主代理 = 对话界面选的模型 → 主模型配置 → 备用候选——**不抢你的选择**，一切正常时插件不碰它。
- **失败的样子**：全链走完 = 这次请求彻底失败（与平台一致）。换候选后**当次会话不自动切回**；你在对话界面手动换模型，插件让位。
- **看得见**：重试与切换写进会话（界面上的「正在重试模型请求（N/M）」就是它），换候选还会给模型留一条通知，让它知道上文的产出模型变了。

## 快速上手

1. **打开面板**：设置 → Agent 中心。左边是 Agent 池和提示词、工具、Skill 三个集库，右边是详情。
2. **建一个提示词集**，往里加提示词段。段有两种：
   - **平台预设**：引用平台自己注册的段，正文跟着平台升级走，面板里只读；
   - **自定义**：自己写正文，支持平台注册的 `{{变量}}` 插值。写了平台没注册的变量名，这次请求会直接失败。
3. **建一个工具集**，勾你要留下的工具。`skill` 是必配项，没有它 AI 没法自主调用 Skill。
4. **建一个技能集**，勾要暴露给模型的 skill。候选按来源分组，可折叠，也可以整组勾选；打开面板就直接问官方技能服务要候选，不用先发一条消息。
5. **建一个代理**：填名字与备注（被当子代理时，模型靠这行备注决定把活派给谁），装上前面那些集，选 Agent 模式（跟随预设 / 原生 / 强制 PTC）和后台模式（可续接 / 一次性 / AI 自行决定）。子代理名册也在这里挂。需要的话再配**备用候选模型**（见上节，可选）。
6. **绑定**：把这个代理绑到一个平台预设上。
7. **保存**。只有点了保存才落盘，**别忘**。

保存之后，用这个预设开个新对话就生效了。

## 配置与数据

配置存在插件自己的 settings 命名空间 `agent-studio` 下（在用户配置文件 `settings.yaml` 里）。模型是四个键加一份绑定：

```yaml
agent-studio:
  agents:        # 代理池
    - id: reviewer
      name: 代码评审
      note: 只读代码、给评审意见          # 被当子代理时，模型靠它决定把活派给谁
      model: { provider: deepseek, model: deepseek-v4.1-flash, reasoningEffort: medium }
      maxRetries: 5                   # 自动降级：每个候选各自重试的上限（默认 5）
      fallbacks:                      # 备用候选链（可跨供应商）；空 = 不接管
        - { provider: senseaudio, model: glm-5.3-flash }
      background: foreground          # always-background | foreground | model-decides
      toolPresentation: follow        # follow | native | ptc
      promptSets: [review-sections]   # 有序：集在这里的顺序就是段的投递顺序
      toolSets: [read-only]
      skillSets: [review-skills]
      children: [tester]              # 可以派出去的子代理名册
  promptSets:    # 提示词集：有序段清单；带 text = 自定义，不带 = 引用平台预设
  toolSets:      # 工具集：工具名清单
  skillSets:     # 技能集：skill 名清单
  runtimeContextOff: [reviewer]       # 名单里的代理不再收到官方的 runtime 快照
  bindings:
    presets: [{ presetId: standard, agentId: reviewer }]   # 预设 → 主代理
```

**这些列表全是数组，不是字典。** 设置服务的合并语义是「对象递归、数组整体替换」，用字典的话界面永远删不掉一个成员。代价是 id 唯一性得自己保证，由界面和写入端点把关。

## 兼容性

- **目标环境**：纯 Web 版 DSH（`dsh --profile web`），社区桌面版也支持。
- **依赖的宿主服务**（`peerDependencies`，全部 optional）：`dsh-agent-presets` / `dsh-scope` / `dsh-settings` / `dsh-system-prompt` / `dsh-tools` / `schemastery`。官方 DSH 升级导致某个服务缺席时，逐项降级，不抛错。
- **界面语言与主题**跟随平台，自带中文 / English 两套文案，深色浅色都能看。
- **client 半边零构建**：`client/index.js` 是壳（启动时加载），`client/parts/panel.js` 是面板（由 host 路由运行时按需伺服）。

### 已知边界

- **极简类预设（`minimal`）的段面改不动。** 这类预设的 persona 段带了 `complete: true` 标记，意思是「我就是完整的提示词，别再拼别的」。平台会在装配瀑布**跑完之后**把段清单强制换回那一段，插件在瀑布里算出来的白名单因此被盖掉——最终投递的永远是那一段。这是平台设计，不是插件的缺陷，而且它本来就只剩一段，损失有限。工具面、技能面没有这道后处理；`standard` / `code` / `cordis` 这类常规预设的段面也一切正常。
- **派活用插件自带的工具**：`studio_list_subagents` 现算子代理名册，`studio_delegate` 按代理 id 派活——**只有走它，子代理那套独立配置（提示词 / 工具 / 技能 / 模型）才认得出身份、才生效**。官方 `subagent` 工具不受特殊对待（工具集里有它就在），但它派出的子代理没有角色登记，只能按「这个预设绑定的主代理」那套面走。
- **同时派多个一次性子代理时，身份是按先后顺序配对的。** 平台在 `agent/created` 事件里不告诉插件「这次创建是哪一次派活触发的」，插件只能按队列顺序推定：先创建的配先调用的。实测中顺序一致，但平台没承诺过这一点。可续接（Resumable）子代理不受影响，它在启动前就拿到了预生成的 `childId`，配对是精确的。
- **工具候选有冷启动。** 没有会话时，宿主进程里根本没有那些工具注册，问谁都问不出来。所以观察结果会按预设落盘缓存，冷启动时面板拿它兜底。
- **自动降级只在配了备用候选时接管。** 候选链为空时插件完全不碰请求，重试就是平台默认的那套；接管之后重试上限以插件配置为准（每个候选各自算）。

## 目录结构

```
lib/                  host 半边产物（npm 包的实际入口，tsc 从 src/host/ 生成）
  index.js            入口：挂观察层 + 路由 + 生效层 + 派活工具
  config.js           四个池的 schema + 装载重叠校验（数据模型的唯一真源）
  preset.js           「当前 agent 跑在哪个预设上」的唯一出口
  observe.js          装配期只读观察层
  cache.js            观察结果的磁盘缓存（冷启动时面板的候选来源）
  apply.js            装配期生效层（主代理拼装 + 子代理创建窗口挂钩）
  delegate.js         派活工具 + 认领映射与待认领队列
  fallback.js         模型自动降级（候选链 / 每候选重试 / 换候选通知）
  presets.js          预设管理（列表 / 复制 / 删除，走官方服务）
  models.js           模型目录（provider / 模型 / 推理档位）
  attribution.js      工具来源归因（注册时刻记「谁注册的」，best-effort）
  sdk-strip.js        PTC 的 tools:sdk 声明正文裁剪
  api.js              host 侧路由分发
  http-guard.js       HTTP 请求围栏与响应工具
  types.js            共享类型（只出类型，无运行时代码）
client/               client 半边产物
  index.js            壳：注册模块 + 运行时加载面板 + 失败兜底卡片
  parts/panel.js      面板实现（host 运行时伺服；改它刷新页面即生效）
src/host/  src/client/   源码真源（tsc → lib/，vite → client/）
types/                宿主类型声明
assets/               README 用的截图
scripts/              依赖链接（从源码安装用）与一致性检查（CI 用）
```

## 文档

在线文档：**<https://thissensen.github.io/dsh-agent-studio/>**（源码在 `docs/`，VitePress 站着）。

平台侧的权威来源仍是
[DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)与官方文档站。

## License

[MIT](LICENSE)
