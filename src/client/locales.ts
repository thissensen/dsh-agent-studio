/**
 * 「Agent 中心」的文案字典（zh / en）＋ 面板侧的翻译装配。
 *
 * **谁用这份字典。**
 *  - 壳（`src/client/index.ts`）：把 `zh` / `en` 注册进平台的 locale 服务
 *    （`ctx.locale.register('agentStudio', { zh, en })`），并给 setting section 的
 *    descriptor 写上 `locale: 'agentStudio'`——平台据此把绑好命名空间的 `t`
 *    注入壳组件 props，语言切换时 outlet 自动重渲染、`t` 引用随之换新。
 *  - 面板部件（`src/client/parts/panel.ts`）：壳把 `t` 经 props 往里传。面板在运行时
 *    **只拿得到 ModuleLoader 的 require**（拿不到 cordis ctx），所以 `t` 只能靠传。
 *
 * **中文是源语言。** `zh` 的 key 集合就是权威集合；`en` 声明成 `Record<CopyKey, string>`，
 * 漏一条就编译不过（`pnpm typecheck` 直接红）。字面值两边都必须是纯文本，
 * `{name}` 形式的占位符由 `t` 的第二参数插值。
 *
 * **兜底两条路。** ① 拿不到平台 `t`（vitest 环境 / 用户还没重启、跑的是旧壳）⇒
 * 面板用 `translateZh`（本文件）直出中文，界面照常可用；② 平台 `t` 查不到 key
 * （理论上不会：en 与 zh 的 key 集合由类型系统钉死）⇒ 同样回落到中文。
 */

/** 平铺的点分层 key，值为中文原文（源语言）。 */
export const zh = {
    // ── 壳（settings.section 那一页自身的文案）────────────────────────────
    'shell.sectionLabel': 'Agent 中心',
    'shell.failedTitle': 'Agent 中心的面板模块没加载出来',
    'shell.failedHint': '多半是插件刚更新、或 host 的静态路由还没就绪。点下面重试一次；仍不行就重启一次 DSH。',
    'shell.retry': '重试',
    'shell.loadingTitle': '正在读取面板模块…',
    'shell.loadingHint': '面板代码是运行时从 host 加载的，首次打开会有一瞬。',
    'shell.scriptFailed': '脚本没加载上：{src}',

    // ── 通用词 ────────────────────────────────────────────────────────────
    'common.ok': '确定',
    'common.cancel': '取消',
    'common.rename': '修改',
    'common.name': '名称',
    'common.note': '备注',
    'common.close': '关闭',
    'common.delete': '删除',
    'common.edit': '编辑',
    'common.remove': '移除',
    'common.moveUp': '上移',
    'common.moveDown': '下移',
    'common.copy': '复制',
    'common.selectAll': '全选',
    'common.selectNone': '全不选',
    'common.add': '添加',
    'common.added': '已添加',
    'common.unnamed': '（无名）',
    'common.empty': '（空）',
    'common.copySuffix': '{name} 副本',
    'common.listSep': '、',
    'common.clauseSep': '；',
    'common.commaSep': '，',

    // ── 池与成员的名词（英文用单数：它们大多出现在「一个 X」的语境里）──────
    'noun.agent': '代理',
    'noun.promptSets': '提示词集',
    'noun.toolSets': '工具集',
    'noun.skillSets': '技能集',
    'member.promptSets': '段',
    'member.toolSets': '工具',
    'member.skillSets': '技能',

    // ── 新建 / 复制时的默认名 ─────────────────────────────────────────────
    'defaultName.agents': '未命名代理',
    'defaultName.promptSets': '未命名提示词集',
    'defaultName.toolSets': '未命名工具集',
    'defaultName.skillSets': '未命名技能集',
    'defaultName.sections': '未命名段',

    // ── 三档枚举 ──────────────────────────────────────────────────────────
    'background.always': '可续接',
    'background.foreground': '一次性',
    'background.modelDecides': 'AI 自行决定',
    'presentation.follow': '跟随预设',
    'presentation.native': '原生',
    'presentation.ptc': '强制 PTC',

    // ── 校验与冲突（保存 / 装载 / 导入时的即时反馈）───────────────────────
    'validate.poolIdEmpty': '有{noun}的 id 是空的。',
    'validate.poolNameEmpty': '有{noun}的名称是空的——名称必填。',
    'validate.poolIdDup': '{noun} id 重复：「{id}」出现了两次。',
    'validate.sectionNameEmpty': '提示词集「{set}」里有一个段的名称是空的——名称必填。',
    'validate.loadedOverlap': '代理「{agent}」装载的{noun}之间有重叠：{detail}',
    'validate.loadedContains': '「{a}」与「{b}」都含{member}「{name}」',
    'validate.loadConflict': '{noun}「{loaded}」与「{incoming}」都含{member}「{name}」——同一个代理装载的集之间不允许重叠。',
    'validate.idEmpty': 'id 不能为空。',
    'validate.idCharset': 'id 只能用字母、数字、下划线（_）和连字符（-）。',
    'validate.idTaken': 'id「{id}」已经被同池的另一个项占了。',
    'validate.importSetRef': '{noun}「{id}」',
    'validate.importAgentRefs': '代理「{agent}」引用的 {missing} 不存在——导入失败。',
    'validate.importIdEmpty': '{noun}里有一项的 id 是空的，导入失败。',
    'validate.importIdClash': '[{id}:{label}] 与现有的 [{beforeId}:{beforeLabel}] 撞 id，导入失败。',
    'validate.importNoItems': '文件里没有可导入的项。',
    'validate.importFailed': '导入失败：{message}',
    'validate.importPoolDone': '已导入 {count} 个{noun}（还没保存）。',
    'validate.importConfigDone': '已并入草稿：提示词集 {promptSets} 个、工具集 {toolSets} 个、技能集 {skillSets} 个、代理 {agents} 个。还没保存。',
    'validate.removeAgentRefs': '「{agent}」{parts}——先解除这些引用再删除。',
    'validate.removeSetInUse': '「{set}」还被 {agents} 装载着——先在那些代理里把它卸载，再删除。',

    // ── id 编辑行的引用提示 ───────────────────────────────────────────────
    'ref.setNone': '没有代理引用它，可放心改。',
    'ref.setUsers': '{agents} 正在装载它（{count} 个代理）——改 id 会同步更新这些引用。',
    'ref.agentNone': '没有被任何预设或名册引用，可放心改。',
    'ref.agentParts': '{parts}——改 id 会同步更新这些引用。',
    'ref.boundByPreset': '被预设 {presets} 绑定为主代理',
    'ref.usedAsChild': '被 {agents} 挂在子代理名册里',

    // ── 段编辑器 ──────────────────────────────────────────────────────────
    'section.customTag': '自定义',
    'section.unnamed': '（未命名段）',
    'section.collapse': '收起',
    'section.expand': '展开',
    'section.namePlaceholder': '自定义名称',
    'section.textPlaceholder': '提示词内容',
    'section.customNote': '正文照发；平台注册的 {{变量}} 会被替换成当前值（见上方「可用变量」）。写平台没注册的变量名会让这一次请求直接失败。',
    'section.platformNote': '这一段引用平台正文（平台升级即更新），这里只读。',
    'section.ghostNote': '平台清单里没有这个段名——可能名字写错了，或平台改版后删过它。这一段不会投递任何内容。',
    'section.noTextNote': '平台这次没给这段正文——触发一次装配后，这里会显示它的完整内容。',
    'section.lead': '选择待拼接的提示词',
    'section.variables': '正文支持平台插值（已注册的变量）：{list}',
    'section.variableAssign': '＝',
    'section.addCustom': '+ 自定义',
    'section.addPlatform': '+ 平台预设',
    'section.coldHint': '还没采到平台预设清单——对任意会话发一条消息触发装配后再回来，这里就能列出来。',
    'section.notCollected': '平台这次没采到它的正文。对任意会话发一条消息触发一次装配，再回来打开这个弹窗就能看到。',
    'section.emptyBody': '（平台当前给的是空段——它在这个预设下本来就没有正文。）',
    'section.notCollectedShort': '（未采到正文——触发一次装配后可见）',
    'section.emptyShort': '（平台当前给的是空段）',
    'section.pickerTitle': '添加平台预设工具',
    'section.searchPlaceholder': '搜索段名…',
    'section.noMatch': '没有匹配的平台预设。',
    'section.pickerNoBody': '（平台当前没给这段正文——它可能在这个预设下本来就是空的）',

    // 平台预设分组（弹窗里按「关键度」排序的组头）
    'section.group.persona': '① 身份与人设（强烈建议保留）',
    'section.group.toolGuide': '② 工具用法指导（保留你启用的工具的段，模型才会用）',
    'section.group.toolMode': '③ 工具调用方式',
    'section.group.runtime': '④ 运行时与界面',
    'section.group.other': '⑤ 其他',
    'section.ptcRequired': 'PTC 模式必备工具，仅 PTC 模式下生效',
    'section.ptcRequiredShort': 'PTC 专属',
    'section.ptcOnlyNote': 'PTC 专用：声明「只能用 run_code 调工具」——排除它，模型会直接点名工具（得到未知工具错）。',
    'section.sdkNote': 'PTC 专用：当前工具目录生成的 run_code SDK 声明——排除它，模型看不到任何工具。',

    // ── 工具清单 ──────────────────────────────────────────────────────────
    'tool.searchPlaceholder': '搜索工具名…',
    'tool.noMatch': '没有匹配的工具名。',
    'tool.mcpPrefix': 'MCP：',
    'tool.unknownServer': '未知服务器',
    'tool.otherSource': '其他来源',
    'tool.mcpHint': '这个预设下还没检测到 MCP 工具——接入 MCP 服务器后，它们会按「MCP：服务器名」分组出现在这里，组头可一键整组勾选。',
    'tool.requiredTag': '必备',
    'tool.requiredTitle': '必备工具：每个工具集都常驻、不能取消——它在，平台才会把技能清单下发给模型。',
    'tool.requiredHint': '「skill」是必备工具：每个工具集都常驻、不能取消——它在，平台才会把技能清单下发给模型（技能集里选的技能才用得上）。',
    'count.kept': '保留 {checked} / 共 {total}',
    'count.filtered': '匹配 {visible} / 共 {total}；已保留 {checked}',

    // ── 技能清单 ──────────────────────────────────────────────────────────
    'skill.searchPlaceholder': '搜索技能名…',
    'skill.noMatch': '没有匹配的技能名。',
    'skill.coldHint': '没读到技能清单。打开面板时会直接问官方技能服务（不需要先发消息）；若这里一直为空，说明这个部署里没发现任何 skill。',
    'skill.unknownSource': '（无来源信息）',
    'skill.source.projectDsh': '<项目>/.dsh/skills',
    'skill.source.projectAgents': '<项目>/.agents/skills',
    'skill.source.custom': '自定义技能目录',
    'skill.source.userDsh': '~/.dsh/skills',
    'skill.source.userAgents': '~/.agents/skills',
    'skill.source.bundled': '内置技能',
    'skill.source.ccswitch': 'CC Switch',
    'skill.rankHint': [
        '同名 skill 以平台优先级为准：',
        '1、<项目>/.dsh/skills（100）',
        '2、<项目>/.agents/skills（200）',
        '3、自定义技能目录（300）',
        '4、~/.dsh/skills（400）',
        '5、~/.agents/skills（500）',
        '6、内置技能（600）',
        '数字小者赢；被遮蔽的候选平台不报，这里看不到。',
    ].join('\n'),

    // ── 模型选择 ──────────────────────────────────────────────────────────
    'model.provider': '供应商',
    'model.model': '模型',
    'model.effort': '思考强度',
    'model.inherit': '（继承本会话）',
    'model.effortDefault': '（用模型默认）',
    'model.pickModelFirst': '（先选模型）',
    'model.loadingEfforts': '（正在读档位…）',
    'model.effortsFailed': '（读档位失败）',
    'model.noEfforts': '（这个模型没有可选档位）',
    'model.effortsError': '读取思考强度失败：{message}',
    'model.warnings': '这些 provider 的模型清单没读出来，所以下拉里看不到它们：{list}',
    'model.maxRetries': '重试次数',
    'model.primaryHelp': '设为主代理时以对话界面选择的为准。\n到达重试次数上限时，会尝试使用备用模型，直到全部失败。',
    'model.fallbacks': '备用模型',
    'model.addFallback': '添加备用模型',
    'model.fallbackIndex': '备用 {index}',
    'model.fallbacksEmpty': '还没有备用模型——加一条，主选失败后会自动顶上。',

    // ── 顶栏（预设管理条）────────────────────────────────────────────────
    'bar.createPreset': '新建预设',
    'bar.deletePreset': '删除预设',
    'bar.deleteEnabledTitle': '删除这个预设',
    'bar.deleteDisabledTitle': '随部署提供的预设不可删除',
    'bar.notAuthorableTitle': '这个平台版本没有预设创作入口（预设由部署声明），新建与删除都用不了',
    'bar.bindLabel': '{preset}绑定的主代理',
    'bar.unbound': '未绑定',
    'bar.import': '导入',
    'bar.export': '导出',
    'bar.importTitle': '导入全部配置（并入当前草稿，再点「保存改动」才落盘）',
    'bar.exportTitle': '导出全部数据：Agent 池、提示词集、工具集、技能集、预设绑定与全部开关',
    'bar.bindHint': '给预设绑定后，将会覆盖 Agent 的所有提示词、工具、skill',
    'bar.unsaved': '有未保存的改动。',
    'bar.saved': '已保存。下一次装配起生效。',
    'bar.save': '保存改动',
    'bar.poolImport': '{pool} 导入',
    'bar.poolExport': '{pool} 导出',
    'bar.poolImportTitle': '导入 {pool}（并进当前草稿的这个池）',
    'bar.poolExportTitle': '导出 {pool} 池的全部项（当前草稿，含未保存的改动）',

    // ── 导入确认弹窗（全量导入与池级导入共用）────────────────────────────
    'import.title': '导入全部配置',
    'import.poolTitle': '导入{pool}',
    'import.pickFile': '选择文件',
    'import.overwrite': '是否覆盖',
    'import.overwriteOn': '开启：同名 id 被覆盖',
    'import.overwriteOff': '关闭：同名 id 会报错',

    // ── 预设弹窗（新建 / 删除）────────────────────────────────────────────
    'preset.createTitle': '新建预设',
    'preset.createOk': '创建',
    'preset.from': '来源',
    'preset.newId': '新 id',
    'preset.newIdPlaceholder': '必填，例如 my-preset',
    'preset.displayName': '显示名',
    'preset.optional': '可留空',
    'preset.description': '描述',
    'preset.descriptionPlaceholder': '可留空；会话里选预设时显示',
    'preset.createNote': '「新建」= 拿来源预设的构成声明（提示词组合、技能、资源都带上）注册一份新预设，源预设不动；描述留空 = 继承来源预设的。',
    'preset.deleteTitle': '删除预设',
    'preset.deleteConfirm': '删除预设「{name}」？它的注册会被撤销、配置里的定义一并删掉，不可撤销。',
    'preset.created': '预设「{id}」已创建。',
    'preset.deleted': '预设已删除。',

    // ── 平台内置预设的显示名与说明────────────────────────────────────────
    // 平台不发布这 4 个预设的 name / description（判据见 `panel.ts` 的 `presetText()`），
    // 文案照平台字典抄（`dsh-client-ui-agent-preset` 的 presetStandardName 那一组）。
    'preset.builtIn.standard': '标准模式',
    'preset.builtIn.standardHint': '处理代码、文件和资料，适合大多数任务。Agent 会按需使用检索、编辑和终端等工具。',
    'preset.builtIn.ptc': 'PTC 模式',
    'preset.builtIn.ptcHint': '包含标准模式的所有能力，更适合批量调用工具，并对结果进行筛选、整理、去重、统计或汇总的任务。',
    'preset.builtIn.minimal': '极简模式',
    'preset.builtIn.minimalHint': 'Agent 仅使用终端工具完成任务，适合测试和对比其基础表现。',
    'preset.builtIn.cordis': '创造模式',
    'preset.builtIn.cordisHint': '用对话定制 DSH：让 Agent 编写插件，添加新功能或界面；也能组合工具和提示词，创建自己的模式。',

    // ── 左栏 ──────────────────────────────────────────────────────────────
    'nav.agentPool': 'Agent 池',
    'nav.promptSets': '提示词集',
    'nav.toolSets': '工具集',
    'nav.skillSets': '技能集',
    'nav.itemTitle': '{label}（{id}）',

    // ── Agent 详情 ────────────────────────────────────────────────────────
    'agent.identity': '身份',
    'agent.notePlaceholder': '描述 Agent 用途，被当做子代理时，AI 通过这个决定调用',
    'agent.promptSets': '提示词集',
    'agent.promptSetsHint': '按顺序拼接最终提示词，不填则为空',
    'agent.promptSetsFixed': 'complete: 为 true 的预设无法设定提示词',
    'agent.snapshot': '注入运行时环境快照',
    'agent.snapshotFixed': '该预设已固定关闭运行时快照',
    'agent.snapshotHelp': [
        '每个回合开始时，平台以一条 user 消息注入当前运行时状态（含沙箱与审批、工作目录、各插件上报的动态提示）。',
        '取消勾选 = 这个代理不再收到它（系统提示词与工具面不受影响）。',
    ].join('\n'),
    'agent.toolSets': '工具集',
    'agent.toolSetsHint': '给 Agent 配备的工具',
    'agent.presentation': 'Agent 模式',
    'agent.presentationHint': [
        '「跟随预设」：预设是什么就是什么',
        '「原生」：强制标准模式，不使用 PTC',
        '「强制 PTC」：强制使用 PTC 模式',
    ].join('\n'),
    'agent.skillSets': '技能集',
    'agent.skillSetsHint': '给 Agent 配备的 skill',
    'agent.modelCard': '模型与后台模式',
    'agent.background': '后台模式',
    'agent.backgroundHint': [
        '「可续接」：后台跑不阻塞，主代理可用 send_message 追问',
        '「一次性」：阻塞主代理，直到子代理跑完，后续无法追问',
        '「AI 自行决定」：模型自己选「可续接」/「一次性」',
    ].join('\n'),
    'agent.children': '子代理',
    'agent.childrenHint': '给当前代理分配的子代理',

    // ── 集装载区 ──────────────────────────────────────────────────────────
    'load.canLoad': '可装载：',
    'load.loadTitle': '把「{set}」装载进来',
    'load.deletedSet': '（已删除的集：{id}）',
    'load.count.sections': '{count} 个段',
    'load.count.sectionOne': '{count} 个段',
    'load.count.tools': '{count} 个工具',
    'load.count.toolOne': '{count} 个工具',
    'load.count.skills': '{count} 个技能',
    'load.count.skillOne': '{count} 个技能',
    'load.emptyPool': '还没有{noun}——去左边「集库」新建一个。',
    'load.emptyLoaded': '还没装载任何{noun}——点下面未装的集装载。装载多个集时，集之间不允许有重叠。',

    // ── 子代理名册 ────────────────────────────────────────────────────────
    'child.canAttach': '可挂上：',
    'child.deletedAgent': '（已删除的代理：{id}）',
    'child.empty': '还没有挂任何子代理。',

    // ── 集库 ──────────────────────────────────────────────────────────────
    'set.add': '+ 新建{noun}',
    'set.copyTitle': '复制选中的{noun}',
    'set.removeTitle': '删除选中的{noun}',
    'set.editorTitle': '编辑「{set}」',
    'set.skillHint': '给 Skill 分组管理，仅用于让 AI 识别调用的部分',
    'set.toolHint': '给工具分组管理，都不勾选则一个工具也没有\n初始化/刷新方式：使用标准模式对话一次再回来',
    'set.notePlaceholder': '给自己看的备注（可选）',

    // ── 面板整体的加载 / 空态 ─────────────────────────────────────────────
    'view.loading': '正在读取平台预设与观察结果…',
    'view.failed': '读取失败',
    'view.failedHint': '宿主可能还没就绪，或这个页面不是从本机打开的。',
    'view.noPresets': '没有读到任何 Agent 预设',
    'view.noPresetsHint': '平台的预设服务可能还没就绪，点下面的按钮再试一次。',
    'view.retry': '重试一次',
    'view.preparing': '正在准备编辑草稿…',
    'view.emptyAgentPool': 'Agent 池是空的。点「+ 新建代理」建一个。',
    'view.emptyPool': '{noun}池是空的。点「+ 新建{noun}」建一个。',
} as const

/** 中文 key 的联合类型——也是 `en` 与所有 `t(...)` 调用点的取值域。 */
export type CopyKey = keyof typeof zh

/** 翻译函数：`{name}` 占位符用第二参数插值。 */
export type Translate = (key: CopyKey, params?: Record<string, string | number>) => string

/** 平台注入的 `t`（命名空间已绑好，key 是运行期字符串）。 */
export type PlatformTranslate = (key: string, params?: Record<string, string | number>) => string

/** 英文字典，key 集合由 `CopyKey` 钉死（漏一条或写错一条都编译不过）。 */
export const en: Record<CopyKey, string> = {
    // ── Shell ─────────────────────────────────────────────────────────────
    'shell.sectionLabel': 'Agent Studio',
    'shell.failedTitle': 'The Agent Studio panel module failed to load',
    'shell.failedHint': 'Most likely the plugin was just updated, or the host\'s static route is not ready yet. Retry below; if it still fails, restart DSH once.',
    'shell.retry': 'Retry',
    'shell.loadingTitle': 'Loading the panel module…',
    'shell.loadingHint': 'The panel code is loaded from the host at runtime, so the first open takes a moment.',
    'shell.scriptFailed': 'Script failed to load: {src}',

    // ── Common ────────────────────────────────────────────────────────────
    'common.ok': 'OK',
    'common.cancel': 'Cancel',
    'common.rename': 'Rename',
    'common.name': 'Name',
    'common.note': 'Note',
    'common.close': 'Close',
    'common.delete': 'Delete',
    'common.edit': 'Edit',
    'common.remove': 'Remove',
    'common.moveUp': 'Move up',
    'common.moveDown': 'Move down',
    'common.copy': 'Copy',
    'common.selectAll': 'Select all',
    'common.selectNone': 'Select none',
    'common.add': 'Add',
    'common.added': 'Added',
    'common.unnamed': '(unnamed)',
    'common.empty': '(empty)',
    'common.copySuffix': '{name} copy',
    'common.listSep': ', ',
    'common.clauseSep': '; ',
    'common.commaSep': ', ',

    // ── Pool and member nouns (singular: they mostly read as "one X") ─────
    'noun.agent': 'agent',
    'noun.promptSets': 'prompt set',
    'noun.toolSets': 'tool set',
    'noun.skillSets': 'skill set',
    'member.promptSets': 'section',
    'member.toolSets': 'tool',
    'member.skillSets': 'skill',

    // ── Default names for new / copied items ──────────────────────────────
    'defaultName.agents': 'Untitled agent',
    'defaultName.promptSets': 'Untitled prompt set',
    'defaultName.toolSets': 'Untitled tool set',
    'defaultName.skillSets': 'Untitled skill set',
    'defaultName.sections': 'Untitled section',

    // ── Two enum rows ─────────────────────────────────────────────────────
    'background.always': 'Resumable',
    'background.foreground': 'One-shot',
    'background.modelDecides': 'AI decides',
    'presentation.follow': 'Follow preset',
    'presentation.native': 'Native',
    'presentation.ptc': 'Force PTC',

    // ── Validation and conflicts ──────────────────────────────────────────
    'validate.poolIdEmpty': 'A {noun} has an empty id.',
    'validate.poolNameEmpty': 'A {noun} has an empty name — a name is required.',
    'validate.poolIdDup': 'Duplicate {noun} id: "{id}" appears twice.',
    'validate.sectionNameEmpty': 'A section in the prompt set "{set}" has an empty name — a name is required.',
    'validate.loadedOverlap': 'Agent "{agent}" has overlapping loads: {detail}',
    'validate.loadedContains': '"{a}" and "{b}" both contain the {member} "{name}"',
    'validate.loadConflict': 'Both "{loaded}" and "{incoming}" contain the {member} "{name}" — sets loaded by the same agent must not overlap.',
    'validate.idEmpty': 'The id cannot be empty.',
    'validate.idCharset': 'An id may only use letters, digits, underscores (_) and hyphens (-).',
    'validate.idTaken': 'The id "{id}" is already taken by another item in this pool.',
    'validate.importSetRef': '{noun} "{id}"',
    'validate.importAgentRefs': 'Agent "{agent}" references {missing}, which does not exist — import failed.',
    'validate.importIdEmpty': 'One of the {noun} has an empty id — import failed.',
    'validate.importIdClash': '[{id}:{label}] clashes with the existing [{beforeId}:{beforeLabel}] — import failed.',
    'validate.importNoItems': 'The file has no importable items.',
    'validate.importFailed': 'Import failed: {message}',
    'validate.importPoolDone': 'Imported {count} {noun} (not saved yet).',
    'validate.importConfigDone': 'Merged into the draft: {promptSets} prompt sets, {toolSets} tool sets, {skillSets} skill sets, {agents} agents. Not saved yet.',
    'validate.removeAgentRefs': '"{agent}" is {parts} — release those references before deleting it.',
    'validate.removeSetInUse': '"{set}" is still loaded by {agents} — unload it from those agents first, then delete it.',

    // ── Reference hints on the id row ─────────────────────────────────────
    'ref.setNone': 'No agent references it; safe to rename.',
    'ref.setUsers': '{agents} currently load it ({count} agents) — renaming the id updates those references too.',
    'ref.agentNone': 'Not referenced by any preset or roster; safe to rename.',
    'ref.agentParts': '{parts} — renaming the id updates those references too.',
    'ref.boundByPreset': 'bound as the main agent by preset {presets}',
    'ref.usedAsChild': 'listed on the subagent roster of {agents}',

    // ── Section editor ────────────────────────────────────────────────────
    'section.customTag': 'Custom',
    'section.unnamed': '(unnamed section)',
    'section.collapse': 'Collapse',
    'section.expand': 'Expand',
    'section.namePlaceholder': 'Custom name',
    'section.textPlaceholder': 'Prompt content',
    'section.customNote': 'The body is sent as-is; platform-registered {{变量}} placeholders are replaced with their current values (see "Available variables" above). Writing a variable the platform has not registered fails that request outright.',
    'section.platformNote': 'This section references the platform body (updated whenever the platform is), and is read-only here.',
    'section.ghostNote': 'The platform lists no section with this name — the name may be misspelled, or the platform may have dropped it. This section delivers no content.',
    'section.noTextNote': 'The platform gave no body for this section this time — trigger an assembly and its full content will show up here.',
    'section.lead': 'Choose the prompts to concatenate',
    'section.variables': 'Bodies support platform interpolation (registered variables): {list}',
    'section.variableAssign': ' = ',
    'section.addCustom': '+ Custom',
    'section.addPlatform': '+ Platform preset',
    'section.coldHint': 'No platform preset list collected yet — send a message in any session to trigger an assembly, then come back and they will be listed here.',
    'section.notCollected': 'The platform had no body for it this time. Send a message in any session to trigger an assembly, then reopen this dialog to see it.',
    'section.emptyBody': '(The platform currently supplies an empty section — it simply has no body under this preset.)',
    'section.notCollectedShort': '(body not collected — trigger an assembly to see it)',
    'section.emptyShort': '(the platform currently supplies an empty section)',
    'section.pickerTitle': 'Add platform preset',
    'section.searchPlaceholder': 'Search section names…',
    'section.noMatch': 'No matching platform preset.',
    'section.pickerNoBody': '(the platform currently supplies no body for this section — it may simply be empty under this preset)',

    'section.group.persona': '① Identity and persona (strongly recommended)',
    'section.group.toolGuide': '② Tool usage guidance (keep the sections of the tools you enabled so the model knows how to use them)',
    'section.group.toolMode': '③ Tool calling mode',
    'section.group.runtime': '④ Runtime and UI',
    'section.group.other': '⑤ Other',
    'section.ptcRequired': 'Required for PTC mode · takes effect only in PTC mode',
    'section.ptcRequiredShort': 'PTC only',
    'section.ptcOnlyNote': 'PTC only: declares "tools may only be called through run_code" — exclude it and the model calls tools by name directly (and gets an unknown-tool error).',
    'section.sdkNote': 'PTC only: the run_code SDK declaration generated from the current tool catalog — exclude it and the model sees no tools at all.',

    // ── Tool list ─────────────────────────────────────────────────────────
    'tool.searchPlaceholder': 'Search tool names…',
    'tool.noMatch': 'No matching tool name.',
    'tool.mcpPrefix': 'MCP: ',
    'tool.unknownServer': 'unknown server',
    'tool.otherSource': 'Other sources',
    'tool.mcpHint': 'No MCP tools detected under this preset yet — once an MCP server is connected they appear here grouped as "MCP: <server>", with a group header that selects the whole group at once.',
    'tool.requiredTag': 'Required',
    'tool.requiredTitle': 'Required tool: always kept in every tool set and cannot be unchecked — the platform only sends the skill catalog to the model when it is available.',
    'tool.requiredHint': '"skill" is a required tool: always kept in every tool set and not uncheckable — the platform only sends the skill catalog to the model when it is available (that is what makes the skills picked in the skill sets usable).',
    'count.kept': 'Kept {checked} / {total}',
    'count.filtered': 'Matching {visible} / {total}; kept {checked}',

    // ── Skill list ────────────────────────────────────────────────────────
    'skill.searchPlaceholder': 'Search skill names…',
    'skill.noMatch': 'No matching skill name.',
    'skill.coldHint': 'No skill list read. Opening the panel queries the official skill service directly (no message needed first); if this stays empty, this deployment has no skills.',
    'skill.unknownSource': '(no source info)',
    'skill.source.projectDsh': '<project>/.dsh/skills',
    'skill.source.projectAgents': '<project>/.agents/skills',
    'skill.source.custom': 'Custom skill directory',
    'skill.source.userDsh': '~/.dsh/skills',
    'skill.source.userAgents': '~/.agents/skills',
    'skill.source.bundled': 'Bundled skills',
    'skill.source.ccswitch': 'CC Switch',
    'skill.rankHint': [
        'For same-named skills the platform priority wins:',
        '1. <project>/.dsh/skills (100)',
        '2. <project>/.agents/skills (200)',
        '3. Custom skill directory (300)',
        '4. ~/.dsh/skills (400)',
        '5. ~/.agents/skills (500)',
        '6. Bundled skills (600)',
        'Lower number wins; the platform does not report shadowed candidates, so they are not visible here.',
    ].join('\n'),

    // ── Model selection ───────────────────────────────────────────────────
    'model.provider': 'Provider',
    'model.model': 'Model',
    'model.effort': 'Reasoning effort',
    'model.inherit': '(inherit this session)',
    'model.effortDefault': '(model default)',
    'model.pickModelFirst': '(pick a model first)',
    'model.loadingEfforts': '(loading efforts…)',
    'model.effortsFailed': '(failed to load efforts)',
    'model.noEfforts': '(this model has no selectable effort)',
    'model.effortsError': 'Failed to load reasoning efforts: {message}',
    'model.warnings': 'The model list could not be read for these providers, so they are missing from the dropdown: {list}',
    'model.maxRetries': 'Retries per candidate',
    'model.primaryHelp': 'As a main agent, the model chosen in the chat window takes precedence.\nOnce the retry limit is reached, the fallback models are tried until all of them fail.',
    'model.fallbacks': 'Fallback models',
    'model.addFallback': 'Add fallback model',
    'model.fallbackIndex': 'Fallback {index}',
    'model.fallbacksEmpty': 'No fallbacks yet — add one and it will take over when the primary keeps failing.',

    // ── Top bar (preset management) ───────────────────────────────────────
    'bar.createPreset': 'New preset',
    'bar.deletePreset': 'Delete preset',
    'bar.deleteEnabledTitle': 'Delete this preset',
    'bar.deleteDisabledTitle': 'Presets shipped with the deployment cannot be deleted',
    'bar.notAuthorableTitle': 'This platform version has no preset-authoring entry (presets are declared by the deployment); creating and deleting are unavailable',
    'bar.bindLabel': 'Main agent bound to {preset}',
    'bar.unbound': 'Unbound',
    'bar.import': 'Import',
    'bar.export': 'Export',
    'bar.importTitle': 'Import the whole configuration (merged into the current draft; click "Save changes" to persist)',
    'bar.exportTitle': 'Export everything: agents, prompt sets, tool sets, skill sets, preset bindings and every switch',
    'bar.bindHint': 'Binding a preset overrides all of the agent\'s prompts, tools and skills',
    'bar.unsaved': 'You have unsaved changes.',
    'bar.saved': 'Saved. Takes effect from the next assembly.',
    'bar.save': 'Save changes',
    'bar.poolImport': 'Import {pool}',
    'bar.poolExport': 'Export {pool}',
    'bar.poolImportTitle': 'Import {pool} (merged into this pool of the current draft)',
    'bar.poolExportTitle': 'Export every item of the {pool} pool (current draft, unsaved changes included)',

    // ── Import confirmation dialog (shared by whole-config and per-pool import)
    'import.title': 'Import the whole configuration',
    'import.poolTitle': 'Import {pool}',
    'import.pickFile': 'Choose file',
    'import.overwrite': 'Overwrite same ids',
    'import.overwriteOn': 'On: an item whose id already exists is overwritten',
    'import.overwriteOff': 'Off: an item whose id already exists fails the import',

    // ── Preset dialogs (create / delete) ──────────────────────────────────
    'preset.createTitle': 'New preset',
    'preset.createOk': 'Create',
    'preset.from': 'Source',
    'preset.newId': 'New id',
    'preset.newIdPlaceholder': 'Required, e.g. my-preset',
    'preset.displayName': 'Display name',
    'preset.optional': 'Optional',
    'preset.description': 'Description',
    'preset.descriptionPlaceholder': 'Optional; shown when picking the preset in a session',
    'preset.createNote': '"New" registers a fresh preset from the source preset\'s composition (prompt composition, skills, resources), leaving the source untouched; an empty description inherits the source preset\'s.',
    'preset.deleteTitle': 'Delete preset',
    'preset.deleteConfirm': 'Delete the preset "{name}"? Its registration is revoked and its definition is removed from the configuration; this cannot be undone.',
    'preset.created': 'Preset "{id}" created.',
    'preset.deleted': 'Preset deleted.',
    'preset.builtIn.standard': 'Standard mode',
    'preset.builtIn.standardHint': 'Work with code, files, and information. Suitable for most tasks, with search, editing, terminal commands, and other tools available as needed.',
    'preset.builtIn.ptc': 'PTC mode',
    'preset.builtIn.ptcHint': 'Includes all Standard mode capabilities. Better suited to tasks that call tools in batches and then filter, organize, deduplicate, count, or summarize the results.',
    'preset.builtIn.minimal': 'Minimal mode',
    'preset.builtIn.minimalHint': 'The agent works using only a terminal tool. Useful for testing and comparing its basic performance.',
    'preset.builtIn.cordis': 'Creator mode',
    'preset.builtIn.cordisHint': 'Customize DSH through conversation. Let the agent write plugins that add features or UI, or combine tools and prompts to create your own mode.',

    // ── Left column ───────────────────────────────────────────────────────
    'nav.agentPool': 'Agents',
    'nav.promptSets': 'Prompt sets',
    'nav.toolSets': 'Tool sets',
    'nav.skillSets': 'Skill sets',
    'nav.itemTitle': '{label} ({id})',

    // ── Agent detail ──────────────────────────────────────────────────────
    'agent.identity': 'Identity',
    'agent.notePlaceholder': 'Describe what this agent is for; when used as a subagent the AI decides by this',
    'agent.promptSets': 'Prompt sets',
    'agent.promptSetsHint': 'Concatenated in order into the final prompt; empty here means none',
    'agent.promptSetsFixed': 'complete: true — prompts cannot be configured here',
    'agent.snapshot': 'Inject the runtime environment snapshot',
    'agent.snapshotFixed': 'This preset fixes the runtime snapshot off',
    'agent.snapshotHelp': [
        'At the start of every turn the platform injects the current runtime state as a user message (sandbox and approvals, working directory, dynamic notes reported by plugins).',
        'Unchecking means this agent no longer receives it (the system prompt and tool surface are unaffected).',
    ].join('\n'),
    'agent.toolSets': 'Tool sets',
    'agent.toolSetsHint': 'Tools equipped for the agent',
    'agent.presentation': 'Agent mode',
    'agent.presentationHint': [
        '"Follow preset": whatever the preset says',
        '"Native": force the standard mode, no PTC',
        '"Force PTC": force PTC mode',
    ].join('\n'),
    'agent.skillSets': 'Skill sets',
    'agent.skillSetsHint': 'Skills equipped for the agent',
    'agent.modelCard': 'Model and background mode',
    'agent.background': 'Background mode',
    'agent.backgroundHint': [
        '"Resumable": runs in the background without blocking; the main agent can follow up with send_message',
        '"One-shot": blocks the main agent until the subagent finishes; no follow-up afterwards',
        '"AI decides": the model picks "Resumable" or "One-shot" itself',
    ].join('\n'),
    'agent.children': 'Subagents',
    'agent.childrenHint': 'The subagents assigned to this agent',

    // ── Set loading area ──────────────────────────────────────────────────
    'load.canLoad': 'Available:',
    'load.loadTitle': 'Load "{set}"',
    'load.deletedSet': '(deleted set: {id})',
    'load.count.sections': '{count} sections',
    'load.count.sectionOne': '{count} section',
    'load.count.tools': '{count} tools',
    'load.count.toolOne': '{count} tool',
    'load.count.skills': '{count} skills',
    'load.count.skillOne': '{count} skill',
    'load.emptyPool': 'No {noun} yet — create one in the pool on the left.',
    'load.emptyLoaded': 'No {noun} loaded yet — load one from the list below. Sets loaded together must not overlap.',

    // ── Subagent roster ───────────────────────────────────────────────────
    'child.canAttach': 'Attach:',
    'child.deletedAgent': '(deleted agent: {id})',
    'child.empty': 'No subagent attached yet.',

    // ── Set pool ──────────────────────────────────────────────────────────
    'set.add': '+ New {noun}',
    'set.copyTitle': 'Copy the selected {noun}',
    'set.removeTitle': 'Delete the selected {noun}',
    'set.editorTitle': 'Edit "{set}"',
    'set.skillHint': 'Groups skills; only the part the AI recognizes and calls is affected',
    'set.toolHint': 'Groups tools; with nothing checked there is no tool at all\nTo initialize / refresh: send one message in standard mode, then come back.',
    'set.notePlaceholder': 'A note for yourself (optional)',

    // ── Panel-level loading and empty states ──────────────────────────────
    'view.loading': 'Reading platform presets and observations…',
    'view.failed': 'Failed to load',
    'view.failedHint': 'The host may not be ready yet, or this page was not opened from this machine.',
    'view.noPresets': 'No agent preset was read',
    'view.noPresetsHint': 'The platform preset service may not be ready yet; click the button below to try again.',
    'view.retry': 'Retry',
    'view.preparing': 'Preparing the draft…',
    'view.emptyAgentPool': 'The agent pool is empty. Click "+ New agent" to create one.',
    'view.emptyPool': 'The {noun} pool is empty. Click "+ New {noun}" to create one.',
}

/**
 * 用一份模板与参数做 `{name}` 插值。
 *
 * 认不出的占位符**原样保留**（与平台 `LocaleRuntime.translate` 同一套行为）——
 * 面板里那些写给用户看的 `{{变量}}` 字样正是靠这条活下来。
 */
function fillParams(template: string, params?: Record<string, string | number>): string {
    if (params === undefined) return template

    return template.replace(/\{(\w+)\}/g, (whole, name: string) => (
        name in params ? String(params[name]) : whole
    ))
}

/** 直出中文的翻译器：拿不到平台 `t`（vitest / 旧壳）时的兜底，也是默认值。 */
export function translateZh(key: CopyKey, params?: Record<string, string | number>): string {
    return fillParams(zh[key], params)
}

/**
 * 把平台注入的 `t` 包成面板用的翻译器。
 *
 * 平台 `t` 查不到 key 时返回 **key 本身**，这里据此判定「没查到」并回落到中文——
 * en 与 zh 的 key 集合虽由类型系统钉死，但运行期仍可能是另一份（更旧的）字典，
 * 兜底留在这里最省事。
 *
 * @param platformT - 平台注入的 `t`；没给就用纯中文兜底。
 */
export function createTranslate(platformT?: PlatformTranslate): Translate {
    if (platformT === undefined) return translateZh

    return (key, params) => {
        const text = platformT(key, params)
        if (text !== key) return text

        return translateZh(key, params)
    }
}

/** 面板给平台注册字典用的命名空间（壳的 descriptor 与它必须一致）。 */
export const LOCALE_NS = 'agentStudio'
