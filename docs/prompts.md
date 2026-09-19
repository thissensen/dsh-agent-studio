# 官方提示词清单

DSH 每轮给模型的**系统提示词不是一个整块**，而是**按段拼装**的：平台在装配期把各插件注册的段按顺序摊成一份清单，再拼成系统提示词。**本插件的「提示词集」就是按这些段名收窄的**——清单里没点名的段不会进上下文。

读之前先记住三件事：

- **段名不等于工具名**，但两者咬得很紧：绝大多数 `tool:*` 段就是「这个工具怎么用」的说明，由**工具包自己**注册。工具不在这一轮的工具面里，那一段就根本不存在。
- **实际有哪些段取决于组合与预设**。同一个段名在不同预设下有没有、正文是什么都可能不同（正文里还会带 <code v-pre>{{变量}}</code>，每次装配现场求值）。下面列的是「官方注册过什么」，不是「你现在一定有」——**以面板里「+ 平台预设」弹窗的实际候选为准**。
- **段的顺序就是投递顺序**，由装配时的数组顺序决定；提示词集里可以自己调序。

段名用「命名空间前缀」分组，前缀既标归属也标用途。

## 平台变量插值

段正文里写 <code v-pre>{{name}}</code>，装配时会被替换成**当次的真实值**。要是写了平台没注册的名字，**这一轮请求会直接失败**——不是静默跳过，所以别拿它当模板变量试着玩。

平台核心注册、本机实测到的三个：

| 变量 | 展开成 | 来自 |
| --- | --- | --- |
| <code v-pre>{{provider}}</code> | 当前供应商 id（如 `command-code`） | `dsh-agent-loop` |
| <code v-pre>{{model}}</code> | 当前模型 id（如 `deepseek/deepseek-v4.1-flash`） | `dsh-agent-loop` |
| <code v-pre>{{cwd}}</code> | 会话工作目录（如 `D:\WorkSpace`） | `dsh-agent-loop` |

- **不止这三个**：变量是注册制的（`ctx.systemPrompt.variable(name, provider)`，任何插件都能加），所以**以面板段编辑器里那行「可用变量」为准**——它列的就是这次装配真的注册了哪些。
- **值随会话走**：同一个段在不同会话、不同模型下展开出来的正文不一样。
- 段可以声明 `interpolate: false` 关掉插值，正文就原样投递。
- 本插件的段编辑器**保存**时会校验变量名（写了没注册的名字由写入端点拦下并报错），不用靠发请求去撞；平台变量清单还没被观察到时（冷启动）只给一句提醒，不拦。

## 身份与人设

| 段名 | 来自 | 内容 |
| --- | --- | --- |
| `harness:identity` | `dsh-system-prompt` | 「你是由 DeepSeek Harness 驱动的 AI agent」——身份声明 |
| `deployment:persona-prefix` | `dsh-system-prompt` | 人设前缀（正文带 <code v-pre>{{model}}</code> 插值）；子代理通道也能覆盖这一段 |
| `deployment:persona-suffix` | `dsh-system-prompt` | 人设收尾（工作目录 <code v-pre>{{cwd}}</code> 等） |
| `harness:source` | `dsh-app-boot` | 宿主实现检出的位置——把「平台源码在哪」告诉模型 |
| `app:web-surface` | `dsh-web-app` | 「你在 Web GUI 里和用户交互」+ 当前地址 |

- 这五段是**唯一一组跟工具无关的**：任何预设下默认都在。
- 写自定义人设时一般只动 `deployment:persona-prefix` / `-suffix`，身份那句留着。

## 工具用法指导（`tool:*`）

一个在场的工具一段，名字就是 `tool:<工具名>`，由工具包自己注册（例：`dsh-tool-subagent/lib/index.js` 里 `name: \`tool:${toolName}\``）。

| 段名 | 来自 | 内容 |
| --- | --- | --- |
| `tool:read` `tool:write` `tool:edit` | `dsh-tool-fs` | 文件读 / 写 / 改的用法与忌讳（如「用 read，不要用 cat」） |
| `tool:glob` `tool:grep` | `dsh-tool-fs-search` | 按路径找文件、按内容搜索 |
| `tool:pwsh` / `tool:bash` | `dsh-tool-pwsh` / `dsh-tool-bash`（含持久版） | 退出码标记、失败先查再动 |
| `tool:jobs` | `dsh-tool-jobs` | 后台任务的查看与终止 |
| `tool:web_search` `tool:web_fetch` | `dsh-tool-web` | 搜索与抓取（抓回来的内容按外部不可信数据处理） |
| `tool:goal` | `dsh-tool-goal` | 长期目标的用法与轮次限制 |
| `tool:workflow` | `dsh-tool-workflow` | 什么时候才该写编排脚本 |
| `tool:subagent` `tool:subagent_fork` | `dsh-tool-subagent` | 委派：后台起、并行起、结果怎么收 |
| `tool:ralph` | `dsh-tool-ralph` | Ralph 式迭代（出厂关闭） |
| `tool:terminal` | `dsh-tool-terminal` | 持久终端（跨调用保留 shell / REPL 状态） |
| `tool:str_replace_editor` | `dsh-tool-str-replace-editor` | Claude Code 风格的查看 / 创建 / 替换 / 插入 |
| `tool:cordis` | `dsh-tool-cordis` | 运行时检查与动态包 |

- **工具不在场 = 段不在场**：收窄工具面时不用管这些段，它们跟着工具走。
- 反过来讲：**想让模型「会用」某个工具，光把它放进工具集是不够的**——对应的 `tool:*` 段也要留在提示词集里，否则模型拿得到工具、却不知道该怎么用。

## 工具调用方式（`tools:*`）

| 段名 | 来自 | 内容 |
| --- | --- | --- |
| `tools:ptc-only` | `dsh-tools` | 「你只能直接调 `run_code`，其它工具都得写在程序里」 |
| `tools:sdk` | `dsh-tools` | 把当前工具目录渲染成 `run_code` 的 TypeScript SDK 声明 |

- 这两段**只在 PTC 模式（`presentAs('ptc')`）下注册**，正文每次都现场生成。
- 原生模式下它们不存在；反过来，PTC 模式缺了它们，模型既不知道要写 `run_code`、也看不到任何工具 ⇒ **PTC 直接哑掉**。所以本插件的每个提示词集都把这两段列为常驻。
- 本插件还会把 `tools:sdk` 的正文按工具集再裁一道：声明里那些不在装载工具集里的工具（`restrict()` 收不动的本层工具就是这一类）会被摘掉，模型读到的 SDK 与它实际调得动的保持一致。

## 环境、界面与 MCP

| 段名 | 来自 | 内容 |
| --- | --- | --- |
| `context:file-reference` | `dsh-file-reference-local` | 用户用 `@` 引用的路径怎么解读 |
| `plan:policy` | `dsh-plan-mode` | 规划模式的行为约定 |
| `ui:deliverable-file-references` | `dsh-client-ui-deliverables` | 交付的产物要在回复里点名（界面会把它变成可点的文件） |
| `mcp-resource-servers` | `dsh-mcp-resources` | 可用的 MCP 资源服务器清单 |
| `mcp:<服务器名>` | `dsh-mcp-client` | 单个 MCP 服务器自己的说明 |

## 插件自己注册的段

段名带**插件名前缀**的，就是第三方插件贡献的——你装的插件不同，这里就不同。本机出现过这两个：

| 段名 | 来自 | 内容 |
| --- | --- | --- |
| `tool-normalizer:guidance` | `dsh-tool-normalizer` | 工具调用的可靠性建议（PTC 下怎么写完整可执行的程序） |
| `ui:file-review-references` | `dsh-file-review` | 文件审阅结果的引用格式（该插件与当前平台不兼容、已卸载，段名只作示例） |

- 判据很简单：**前缀不属于平台那几套**（`harness:` / `deployment:` / `app:` / `tool:` / `tools:` / `context:` / `plan:` / `ui:` / `mcp`）的，基本都是插件自带的。
- 面板认不出的段名会归进「其他」组，**不猜它的用途**——想知道它做什么，展开看正文。

## 配提示词集时怎么用这份清单

- **覆盖语义**：提示词集的段清单就是这一轮投递的**全部**内容——没列进来的平台段一律不投递。
- **工具得配两处**：工具集决定模型**能调什么**，提示词集里的 `tool:*` 段决定模型**知不知道怎么调**。只留一处，模型要么调不动、要么不会用。
- **常驻段**：本插件的每个提示词集都带着 `tools:ptc-only` 与 `tools:sdk`。它们在原生模式下由平台静默跳过（找不到同名平台段不报错、也不留空行），在 PTC 模式下缺了就是哑的。
- **平台改版会让段名消失**：段名跟着平台版本走。名字没了，配置里那一条就成了「幽灵段」——面板会标出来，投递时静默跳过。升级 DSH 之后回头核对一次这份清单。
