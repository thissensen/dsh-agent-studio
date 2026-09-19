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
- `run_in_background` 把长时间命令变成后台任务，之后用 `job_*` 查看或终止；归属明确的任务完成时，agent 会在会话内收到通知。
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

- `subagent` 有两种模式：`one-shot` 默认等结果；`continuable` 默认在后台启动并返回 id，供后续追问。
- `workflow` 用在**用户明确要求工作流或大型多 agent 编排**时；父轮次会等所有委派结束，取消或异常返回错误，而不是部分成功。
- 三者的分工：普通长期工作用 `goal`，有界委派用 `subagent` 或 `workflow`，Ralph 式迭代只在用户明确要求时用。
- 本插件提供替代路径：配了子代理名册的预设里，官方 `subagent` 会被停用，改用 `studio_delegate`。
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
| `run_code` | `dsh-tools` | 针对可用工具执行 TypeScript 程序（PTC 的入口工具） |

定义只存在于进程内存中，DSH 重启即消失；这个过程不写仓库文件、不安装依赖，也不改 `cordis.yml`。

- `run_code` 正是 PTC 模式的入口：给 agent 选「跟随预设 / 原生 / 强制 PTC」三档呈现时，PTC 档模型拿到的就是它。

## 会话与平台管理

| 工具 | 来自 | 做什么 |
| --- | --- | --- |
| `session_search` `session_trace` `session_event_read` `session_event_search` `session_event_trace` | `dsh-tool-session-query` | 检索历史会话与事件，追溯会话谱系与事件替换关系 |
| `list_mcp_resources` `list_mcp_resource_templates` `read_mcp_resource` | `dsh-mcp-resources` | 列出 / 读取 MCP 服务器提供的资源 |
| `plugin_manager` | `dsh-plugin-manager` | 列出当前 profile 的插件与组合包，启用 / 禁用 / 安装 / 移除 |

- 会话检索类工具只对**已授权**的会话生效；搜当前会话时会排除执行此次调用的步骤本身。
- `plugin_manager` 直接改当前 profile 的插件组合（等于替你在界面上点插件管理）——用它装卸插件时心里有数。

## 策略：不注册工具，但决定工具怎么表现

| 包 | 作用 |
| --- | --- |
| `dsh-tool-call-timeout-policy` | 给配合取消的工具调用设协作式时间上限，超时映射成清晰的模型错误 |
| `dsh-compaction-tool-result-pruner` | 工具结果过大时先裁进预算，再交给会话压缩器 |
| `dsh-compaction-image-offload` | 图像超出路由预算时，用占位符替换最旧的图片并重试 |

## 配工具集时怎么用这份清单

- 本插件的工具集**按名字收窄**：上面每个工具名都可以是成员；清单之外的工具（其它插件、MCP 的 `mcp__…` 工具）同样能进工具集。
- 一个工具集都不装 = 一个工具都不给；装了就只看勾的。
- **`bash` / `pwsh` 是个例外**：只要 shell 可见，命令里跑什么就由模型决定，工具面收窄管不到它内部。要让收窄真正成立，就得在「给不给 shell」这一层做决定。
