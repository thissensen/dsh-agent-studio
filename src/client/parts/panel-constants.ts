/**
 * 草稿层的硬口径常量：每个提示词集必备的段、每个工具集必备的工具、重试默认值与技能来源键。
 *
 * @module dsh-agent-studio/client-parts/panel-constants
 */
import type { CopyKey } from '../locales'

/**
 * PTC 模式必备的两个段（2026-09-18 用户拍板）：**每个提示词集都常驻**（草稿层补位，
 * 见 `ensurePtcSections`），勾选框与「移除」锁死，**顺序仍可调**。
 *
 * 为什么常驻无害：这两个段只在 PTC 模式下由平台注册，原生模式下 `buildSections`
 * 找不到同名平台段是**静默跳过**（不报错、不留空行）；反过来，PTC 模式缺了它们，
 * 模型既不知道要写 `run_code`、也看不到任何工具。
 */
export const PTC_REQUIRED_SECTIONS = ['tools:sdk', 'tools:ptc-only']

/**
 * 每个工具集都常驻的工具（2026-09-18 用户拍板：与必备段同一套「必勾」待遇）。
 *
 * `skill` 是技能清单下发的开关——平台 `dsh-tool-skill` 在 pre-step 里先看这个工具在不在
 * 该 agent 的工具面里，不在就当作「这份清单用不了」，整条技能目录都不注入；而工具集是
 * 收窄语义，不在集里的工具连调用都会被 guard 排除 ⇒ 漏勾它，技能等于废掉。
 *
 * 所以每个工具集都带上它：清单里那一行勾选框与「全不选」都动不了它，顺序照旧
 * （工具清单是数组，勾选顺序就是投递顺序）。名字与 host `config.ts` 的 `REQUIRED_TOOLS`
 * 是同一套——那边靠它豁免装载重叠校验。
 */
export const REQUIRED_TOOLS = ['skill']

/**
 * 自动降级的默认重试上限：与 host 侧 `config.js` 的 `DEFAULT_MAX_RETRIES`
 * （schema 默认值、也是平台的 `maxRetries` 默认）同一个数。
 * 面板只负责显示与编辑坏值兜底，真值以 host 的 schema 为准。
 */
export const DEFAULT_RETRIES = 5

/**
 * 技能来源 → 组头的显示名。来源是平台文件系统扫描根的标识（`dsh-skill-filesystem`
 * 的 `roots()` 里那个 `source`），六个平台值 + 两个 agent 源别名（`agent-*`——
 * skills-manager 那类「按 agent 注册」的 provider 标的，`agent-agents` 就是
 * `user-agents` 的同一目录）；认不出的（runtime 注册、将来的其它 provider）
 * **原样显示**——不编造出处。
 *
 * 不用 `resourceBase.path` 分组：真机实测它是**技能自己的子目录**
 * （`…\.agents\skills\code-style`），拿它分组等于一技能一组。
 */
export const SKILL_SOURCE_KEYS: Record<string, CopyKey> = {
    'project-dsh': 'skill.source.projectDsh',
    'project-agents': 'skill.source.projectAgents',
    custom: 'skill.source.custom',
    'user-dsh': 'skill.source.userDsh',
    'user-agents': 'skill.source.userAgents',
    bundled: 'skill.source.bundled',
    'agent-agents': 'skill.source.userAgents',
    'agent-ccswitch': 'skill.source.ccswitch',
}
