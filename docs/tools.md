# 自带工具清单

DSH 官方提供的工具包（`dsh-tool-*`、实验组 `dsh-experimental-*` 与若干服务包）与它们面向模型的工具名。**本插件的工具集就是按这些名字收窄的**——这份清单可以直接当作挑选成员的参考。

读之前先记住两件事：

- **实际能看到哪些工具取决于组合**。同一个工具包可能根本没装，也可能只在某些预设上挂载——下面列的是「官方提供过什么」，不是「你现在一定有」。个别条目较新（含实验包），**以面板里实际出现的候选为准**。
- **工具名是 host 平面的全局键**，重名会直接冲突。所以第三方插件（包括本插件）都带自己的前缀，本插件的两个工具是 `studio_list_subagents` 与 `studio_delegate`。

下表的包名省略 `@deepseek-ai/` 前缀。

## 文件与搜索

| 工具 | 来自 | 做什么 |
| --- | --- | --- |
| `read` `write` `edit` `read_image` | `dsh-tool-fs` | 带行号读 UTF-8 文本、原子写入、字面量编辑、读取图片 |
| `glob` `grep` | `dsh-tool-fs-search` | 文件发现与内容搜索 |
| `str_replace_editor` | `dsh-tool-str-replace-editor` | Claude Code 风格的查看 / 创建 / 替换 / 插入 |
| `lsp` | `dsh-tool-lsp` | 查询语言服务器，精确导航代码（定义 / 引用 / 实现 / 悬停） |

- `read` 只处理 UTF-8 文本；`write` 是完整替换，`edit` 是字面量替换（默认要求唯一匹配）。
- `read_image` 需要宿主挂了持久附件服务，**而且只对声明支持图像输入的模型有效**——文本模型上调用会被拒。图像一旦进历史，之后每轮请求都会计费，直到被压缩。
- `glob` / `grep` 自带实现，**不要求宿主安装 `rg`**；结果相对工作目录，排除 VCS 元数据，超出内联上限的部分可经 spill 完整恢复。
- `str_replace_editor` 与 `read` / `write` / `edit` 是**两套编辑风格**，选一套即可。

## 命令与后台任务

| 工具 | 来自 | 做什么 |
| --- | --- | --- |
| `bash` | `dsh-tool-bash`（一次性） / `dsh-tool-bash-persistent`（跨调用保留） | 执行命令 |
| `pwsh` | `dsh-tool-pwsh` / `dsh-tool-pwsh-persistent` | 同上，Windows 方言对应物 |
| `job_output` `job_list` `job_kill` | `dsh-tool-jobs` | 查看与控制后台任务 |
| `terminal_open` `terminal_send` `terminal_read` `terminal_close` `terminal_list` `terminal_signal` | `dsh-tool-terminal` | 按 owner 隔离的持久终端（保留 shell / REPL 状态） |

- **一次性版**每次都是全新 shell，cwd、变量、函数不会留；**持久版**为每个 agent 保留一份隔离的 shell，命令串行执行。
- `run_in_background` 是 `bash` / `pwsh` 这类**平台 job 工具**的参数（不是本插件的）：把长时间命令变成后台任务，之后用 `job_*` 查看或终止；归属明确的任务完成时，agent 会在会话内收到通知。本插件的 `studio_delegate` 不收这个参数——它等不等看目标代理的后台模式。
- 命令被沙箱拒绝时，可以带更宽的 `sandbox_permissions` 与一句理由重试一次（需用户批准）。
- `terminal_*` 是另一条路：需要在多次调用之间留住 shell 或 REPL 状态时用它；`terminal_send` 也能把长跑命令扔进后台，拿 `job_*` 管。

## 委派与编排

| 工具 | 来自 | 做什么 |
| --- | --- | --- |
| `subagent` | `dsh-tool-subagent` | 把工作委派给子代理 |
| `subagent_fork` | 同上（fork 变体） | 不暴露模型选择、继承父级上下文的委派 |
| `send_message` `interrupt_agent` `list_agents` | `dsh-tool-subagent-control` | 对可续接子代理的中途引导、打断与清点 |
| `workflow` | `dsh-tool-workflow` | 运行一段 JavaScript 编排脚本，把活儿扇出给多个子代理 |
| `ralph` | `dsh-tool-ralph` | 围绕不可变目标的前台全新 agent 迭代（出厂关闭） |
| `spawn_teammate` `team_task_create` `team_task_get` `team_task_list` `team_task_update` `wait_agent` `interrupt_agent` `list_agents` `send_message` | `dsh-experimental-tool-agent-team`（实验） | 具名 teammate + 共享任务板 + 持久消息的团队协作（九个工具） |

- `subagent` 只有一种启动语义：每次委派都**立即返回子代理 id**，结果由运行时投递给父模型，不阻塞当前轮次；能不能中途引导或事后追问，取决于后端能力（能续接的用 `send_message`，不能的只在完成通知里给最终答复）。
- `workflow` 用在**用户明确要求工作流或大型多 agent 编排**时；父轮次会等所有委派结束，取消或异常返回错误，而不是部分成功。
- 三者的分工：普通长期工作用 `goal`，有界委派用 `subagent` 或 `workflow`，Ralph 式迭代只在用户明确要求时用。
- 本插件提供替代路径：`studio_list_subagents` 列出该 agent 名下的子代理，`studio_delegate` 按代理 id 派活——**只有走它，子代理那套独立配置（提示词 / 工具 / 技能 / 模型）才认得出身份、才生效**。官方 `subagent` 没有特殊待遇（工具集里留着它就在），但它派出的子代理没有角色登记，只能按该预设绑定的主代理那套面走。
- **`studio_delegate` 只有一种入口：`tasks` 数组。** 每项 `{ agent, prompt, description? }`，派一个也写成一项数组（插件不设条数上限）。`agent` / `prompt` 这两个单发参数与 `run_in_background` 参数**都已删除**——要不要等不看参数，只看目标代理自己的**后台模式**档。
- **整批阻不阻塞是 OR 判定**：一项「阻塞」就整批阻塞。不阻塞的那几项会被同批连坐——这是有意的取舍：一次工具调用只能交回一次结果。
- **返回形状只剩两种，看 `kind`**：
  - `started`：这一批**一项「阻塞」档都没有**时立刻返回。`items` 每项 `{ agent, subagentId?, description?, error? }`；每个子代理跑完由**平台逐条发结算消息**（带它的完整收尾文本）。启动失败的项没有 `subagentId`、带 `error`。
  - `foreground-batch`：这一批**至少一项是「阻塞」档**时，整批一起启动、一起等，全部结算后返回。`results` 按输入顺序逐项 `{ agent, ok, subagentId?, description?, error? }`；顶层另有 `filePath`（写成了）或 `fileError`（没写成）。
  - 旧形状 `continuable` / `foreground` / `background-batch` **已不存在**，连同 `batchId`、汇总消息、以及「超限才转存」的兜底一起删除。
  - **阻塞批整批一律落盘，对话里只留一行落点**：先写成一个 `.md`（系统临时目录、按会话 id 短哈希分目录、文件名取 UTC 时间戳），工具结果在对话里显示的那份文本就只有这几行：`本批结果已写入：<路径>（共 N 项：M 成功 · K 失败）`（写盘失败时改报 `文件没写成（<原因>）（共 N 项：M 成功 · K 失败）`），失败项另各占一行（`【序号】代理（名字） — 描述 · 失败 · 原因`）；落点行下面还有一行 `子代理：【序号】<id>、…`，列出本批每个可续聊的子代理会话（启动就没起来的项没有 id，不列）；**正文不进对话**、只在文件里；`results` 不含正文（写盘失败也不回填）。文件里只有成功项的正文，按原序号分节。这些文件不会被插件清理。
- **启动失败逐项报**：一项没起来只让它落成失败项（`started` 里带 `error`、`foreground-batch` 里 `ok: false`），其余照常。平台活跃子代理名额到顶（`ACTIVATION_LIMIT_REACHED`）时，那一项的错误会提示把它**拆成单独一次重派**。
- **一项都没起来**（整批都是启动失败）⇒ 整次调用直接抛第一个启动错误，不返回一张空回执。
- **取消不做 partial**：阻塞批被取消或 PTC 超时 ⇒ 整次调用失败、**不返回部分结果**，错误文案会指你去打开面板上的「突破 PTC 120 秒限制」。不阻塞批不受影响——那些子代理已经在平台上自己跑。
- **并行写法**：多个任务放进**一次** `tasks`。连写两行 `await` 是**串行**——那是 JavaScript 语义，不是插件限制。
- `agent-team` 是**实验组**的团队玩法：teammate 持久存在、成员之间互相发持久消息、共享一块任务板（`team_task_*` 用 revision 做 compare-and-set）。它的 `send_message` / `interrupt_agent` / `list_agents` **取代**旧版 `dsh-tool-subagent-control` 的同名工具——两者同用时要禁用旧定义。

## 目标与计划

| 工具 | 来自 | 做什么 |
| --- | --- | --- |
| `todo_write` | `dsh-tool-todo` | 维护一份可见的任务清单 |
| `get_goal` `create_goal` `update_goal` | `dsh-tool-goal` | 读取、创建与更新持久目标 |
| `schedule_create` `schedule_delete` `schedule_list` | `dsh-schedule` | 会话内的提醒（创建 / 删除 / 列出） |
| `exit_plan_mode` | `dsh-plan-mode` | 规划模式专用：提交计划供评审，获批后退出规划模式 |

- `todo_write` **每次整表替换**；列表归属创建它的那一个 agent 会话，子代理各有各的，无法共享。
- goal 的创建、编辑、暂停、恢复都要求顶层轮次里存在**人类直接请求**；`complete` 与 `blocked` 可以在自主轮里执行，声明阻塞要连续达到阈值才被接受。
- 提醒（`schedule_*`）挂在**当前会话**上：到期由该会话交付，不是系统级闹钟。

## 交互与呈现

| 工具 | 来自 | 做什么 |
| --- | --- | --- |
| `ask_user_question` | `dsh-tool-ask-user` | 暂停下来向用户确认、选择或索取信息 |
| `present` | `dsh-tool-present` | 声明交付文件，用户可用默认应用打开 |
| `skill` | `dsh-tool-skill` | 技能目录与加载 |

- `ask_user_question` 只负责提问，界面由调用方提供；没有回答处理器时模型会收到错误。
- `present` 只记录路径与说明，不复制文件内容。
- **`skill` 是技能面的开关**：工具不可见时模型拿不到技能目录。所以本插件的工具集把它列为必配项。

## Web

| 工具 | 来自 | 做什么 |
| --- | --- | --- |
| `web_search` `web_fetch` | `dsh-tool-web` | 搜索与抓取页面 |

- 提供方缺失或不可用时，工具仍然可见，但会返回模型可以据以行动的结构化错误。
- 抓取结果会把提供方控制的文本标记为外部不可信数据，并排除活动与隐藏内容。

## 浏览器操作（实验）

让模型检查与操作网页。「能力组 + 提供方」结构：一次只挂一个提供方，提供方各自拥有工具与浏览器会话。

| 工具 | 来自 | 做什么 |
| --- | --- | --- |
| `stagehand_navigate` `stagehand_screenshot` `stagehand_tabs` `stagehand_act` `stagehand_observe` `stagehand_extract` | `dsh-experimental-browser-use-stagehand-native`（实验，原生） | 导航 / 截图 / 标签页管理，以及 Stagehand 的 AI 辅助操作、观察与提取 |
| `mcp__playwright-mcp__…` | `dsh-experimental-browser-use-playwright-mcp`（实验，MCP） | 上游 Playwright MCP 的全套浏览器工具 |
| `mcp__chrome-devtools-mcp__…` | `dsh-experimental-browser-use-chrome-devtools-mcp`（实验，MCP） | Chromium 的检查与控制 |

- 启用方式：在 profile 组合里挂 `dsh-browser-use`（注册服务）+ 一个提供方。`mode: launch` 起独立浏览器；`mode: attach` 接上已有浏览器，沿用它的标签页与登录态。
- 三个提供方都是**实验状态**、默认不启用；Stagehand 那条还要单独配原生模型（只认其固定目录里的 OpenAI / Anthropic / Google / Groq / Cerebras 模型，不支持 DeepSeek 端点）。
- MCP 提供方的工具名跟随上游服务器，统一以 `mcp__<服务器名>__<工具>` 呈现；截图要进历史需要附件存储 + 支持图像输入的模型路由。三个都只支持 Chromium。

## 电脑操作（实验）

让模型观察并操作桌面。「能力组 + 提供方」结构，当前提供方是 Cua Driver——先在你机器上装好驱动（安装与平台权限由上游负责），DSH 侧只是把它接进来。

| 工具 | 来自 | 做什么 |
| --- | --- | --- |
| `mcp__cua-driver-mcp__…` | `dsh-experimental-computer-use-cua-driver-mcp`（实验，MCP） | 经 MCP 使用已安装的 Cua Driver（工具集由驱动自己声明） |
| （工具随驱动声明） | `dsh-experimental-computer-use-cua-driver-native`（实验） | 嵌入 Cua Driver 原生 npm 运行时的变体 |

- 启用方式：挂 `dsh-computer-use` + 一个提供方；工具名不固定，取决于你装的驱动版本。
- 同一个桌面会被多个会话看见，谁先谁后由你自己协调；桌面操作是否获批由驱动的平台权限决定。
- 同样需要附件存储与图像模型路由，截图才进得了历史。

## 运行时可编程

| 工具 | 来自 | 做什么 |
| --- | --- | --- |
| `cordis_inspect_list` `cordis_inspect_query` `cordis_inspect_self` | `dsh-tool-cordis` | 查看实时 Cordis 运行时 |
| `cordis_define` `cordis_run` `cordis_stop` `cordis_undefine` | 同上 | 创建、运行、停止、更新或移除临时动态包 |
| `run_code` | `dsh-tool-executor-ptc` | 针对可用工具执行 TypeScript 程序（PTC 的唯一入口工具；不注册进工具表，这个工具名由 PTC 执行器保留） |

定义只存在于进程内存中，DSH 重启即消失；这个过程不写仓库文件、不安装依赖，也不改 `cordis.yml`。

- `run_code` 是 PTC 档的唯一入口工具：预设挂了 PTC 执行器行时，模型能直接调的就只有它，其余工具都得写在程序里（声明见 `tools:sdk` 段）。

## 会话与平台管理

| 工具 | 来自 | 做什么 |
| --- | --- | --- |
| `session_search` `session_trace` `session_event_read` `session_event_search` `session_event_trace` | `dsh-tool-session-query` | 检索历史会话与事件，追溯会话谱系与事件替换关系 |
| `list_mcp_resources` `list_mcp_resource_templates` `read_mcp_resource` | `dsh-mcp-resources` | 列出 / 读取 MCP 服务器提供的资源 |
| `plugin_manager` | `dsh-plugin-manager` | 列出当前 profile 的插件与组合包，启用 / 禁用 / 安装 / 移除 |

- 会话检索类工具只对**已授权**的会话生效；搜当前会话时会排除执行此次调用的步骤本身。
- `plugin_manager` 直接改当前 profile 的插件组合（等于替你在界面上点插件管理）——用它装卸插件时心里有数。

## 策略：不注册工具，但决定工具怎么表现

这一组包决定「工具怎么呈现给模型」，呈现方式的落点是**预设里挂哪一条工具执行器行**：平台每个 scope 只许一条执行器（`Only one tool executor may be registered in each scope`），选取时沿 scope 链就近赢，root 那份就是部署默认。

| 包 | 作用 |
| --- | --- |
| `dsh-tool-executor-native` | 原生呈现：工具声明直接进 `request.tools` |
| `dsh-tool-executor-ptc` | PTC 呈现：注册 `run_code` 这一件入口工具，工具目录渲染成 `tools:sdk` 段的 TypeScript 声明 |
| `dsh-agent-tool-presentation` | 已弃用：按 `config.mode` 挂上面两个执行器之一，效果与新写法相同 |
| `dsh-tool-call-timeout-policy` | 给配合取消的工具调用设协作式时间上限，超时映射成清晰的模型错误 |
| `dsh-compaction-tool-result-pruner` | 工具结果过大时先裁进预算，再交给会话压缩器 |
| `dsh-compaction-image-offload` | 图像超出路由预算时，用占位符替换最旧的图片并重试 |

- **同一份工具集，两档看到的形状不一样**：PTC 下模型只直接调 `run_code`，其余工具的声明在 `tools:sdk` 段里；原生下声明直接进 `request.tools`，模型直接调。
- **本插件只在用户点档时改写这一行**：收集预设的呈现方式、写档位时读改它；两个执行器包不在 `peerDependencies` 里——插件从不 import 它们。

## 配工具集时怎么用这份清单

- 本插件的工具集**按名字收窄**：上面每个工具名都可以是成员；清单之外的工具（其它插件、MCP 的 `mcp__…` 工具）同样能进工具集。
- 一个工具集都不装 = 一个工具都不给；装了就只看勾的。
- **`bash` / `pwsh` 是个例外**：只要 shell 可见，命令里跑什么就由模型决定，工具面收窄管不到它内部。要让收窄真正成立，就得在「给不给 shell」这一层做决定。
