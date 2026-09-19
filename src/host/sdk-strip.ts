/**
 * PTC 的 `tools:sdk` 声明正文裁剪：把「收不动、又调不了」的工具从 TypeScript 声明里删掉。
 *
 * 为什么需要：SDK 正文由平台按当前视图生成，而 `restrict()` 按设计只收**继承面**
 * ——注册在 agent 本层的工具（`subagent` / `list_subagent_models` 就是这样装上去的）
 * 收不掉，于是它们留在声明里、调用却被 guard 拒（「能看不能调」）。声明是 PTC 下
 * 模型唯一的工具知识来源，投递什么由我们说了算，所以按同一判据在文本层再裁一道。
 *
 * 文本形态由平台的 `renderToolsSdk`（dsh-tools/lib/types/ts-types.js）唯一决定：
 *
 *   - `interface ToolArgsMap {` 与 `interface ToolOutputMap {` 两个块各含一份条目；
 *   - 一个条目 = [单行描述注释（以两个空格 + 斜杠星号开头）] + `  <键>: <类型>;`；
 *     键经 `renderKey`：合法标识符原样、否则是 JSON 引号形态（如 `"my-tool"`）；
 *   - 多行类型（对象 / 数组 / oneOf）的延续行只有两种合法形态——属性行（≥4 空格
 *     缩进）与收尾行（2 空格 + `}`，如 `  }`、`  } & Record<string, JsonValue>;`、
 *     `  })[];`、`  } | {`）。**收尾行也是 2 空格缩进**，所以条目边界不能靠
 *     「下一个 2 空格行」判断，只能靠认出「条目起点」。
 *
 * 失败姿势刻意保守：任何一行不符合上述形态（块不闭合、出现认不出的行）就整体
 * **原样返回**——宁可不裁，也不半删出一段坏声明；删完再做一次自校验兜底。
 *
 * @module dsh-agent-studio/sdk-strip
 */

/** 块头：`interface ToolArgsMap {` / `interface ToolOutputMap {`。单行空块（`… {}`）不在此列，按普通行透传。 */
const SDK_MAP_HEADER = /^interface (?:ToolArgsMap|ToolOutputMap) \{$/

/** 条目上方的描述注释（平台生成恒为单行；连续多行也一并吸收）。 */
const SDK_DOC_LINE = /^ {2}\/\*\*/

/** 条目起点：2 空格缩进 + 键（裸标识符或 JSON 字符串）+ `: `。 */
const SDK_ENTRY_START = /^ {2}("(?:[^"\\]|\\.)*"|[A-Za-z_$][A-Za-z0-9_$]*): /

/** 多行条目的延续行：属性行（≥4 空格缩进）或收尾行（2 空格 + `}`）。其余一律认不出。 */
const SDK_CONTINUATION_LINE = /^(?: {4}| {2}\})/

/** 一次裁剪的结果。 */
export interface SdkStripResult {
    /** 删过之后的文本；没命中时与输入值相等。 */
    text: string
    /** 实际删掉的条目键（同名工具在两个块各有一条，会各记一次）。 */
    removed: string[]
}

/** 一个条目单元：描述注释 + 条目行 + 多行类型的延续行。 */
interface SdkEntryUnit {
    key: string
    lines: string[]
    /** 单元结束后的下一行下标。 */
    end: number
}

/** 一趟扫描的结果：`output` 是删过之后的行；`removed` 是实际命中的条目键。 */
interface SdkScan {
    output: string[]
    removed: string[]
}

/**
 * 从一段 `tools:sdk` 正文里删掉点名工具的声明条目。
 *
 * @param text - 平台的 SDK 声明全文。
 * @param removeNames - 要删掉声明的工具名。
 * @returns 裁剪结果；没命中、或结构认不出时 `text` 与输入值相等、`removed` 为空。
 */
export function stripSdkEntries(text: string, removeNames: Set<string>): SdkStripResult {
    if (removeNames.size === 0) return { text, removed: [] }

    // 便宜的前置检查：名字一个都没在文本里出现（含被引号包裹的形态）就不必解析。
    let mentions = false
    for (const name of removeNames) {
        if (text.includes(name)) {
            mentions = true
            break
        }
    }
    if (!mentions) return { text, removed: [] }

    const first = scanSdkEntries(text.split('\n'), removeNames)
    if (first === undefined || first.removed.length === 0) return { text, removed: [] }

    // 自校验：删过的文本必须仍能解析、且点名条目一个不剩；不符就退回原文。
    const second = scanSdkEntries(first.output, removeNames)
    if (second === undefined || second.removed.length > 0) return { text, removed: [] }

    return { text: first.output.join('\n'), removed: first.removed }
}

/**
 * 逐行扫描两个声明块，把点名条目的整个单元（描述注释 + 条目 + 延续行）略去。
 *
 * @param lines - 已按行切开文本。
 * @param removeNames - 要删掉的条目键。
 * @returns 扫描结果；结构认不出（块不闭合、出现非条目/非延续的行）时 undefined。
 */
function scanSdkEntries(lines: string[], removeNames: Set<string>): SdkScan | undefined {
    const output: string[] = []
    const removed: string[] = []
    let index = 0

    while (index < lines.length) {
        const header = lines[index]
        output.push(header)
        index += 1

        if (!SDK_MAP_HEADER.test(header)) continue

        while (index < lines.length && lines[index] !== '}') {
            const unit = readEntryUnit(lines, index)
            if (unit === undefined) return undefined

            if (removeNames.has(unit.key)) removed.push(unit.key)
            else output.push(...unit.lines)

            index = unit.end
        }

        if (index >= lines.length) return undefined

        output.push(lines[index])
        index += 1
    }

    return { output, removed }
}

/**
 * 从 `start` 起读一个条目单元；线条形态不符合平台生成规则时返回 undefined。
 *
 * @param lines - 已按行切开的文本。
 * @param start - 单元的起始行下标。
 * @returns 单元（含结束下标）；认不出时 undefined。
 */
function readEntryUnit(lines: string[], start: number): SdkEntryUnit | undefined {
    const unitLines: string[] = []
    let index = start

    while (index < lines.length && SDK_DOC_LINE.test(lines[index])) {
        unitLines.push(lines[index])
        index += 1
    }

    const line = lines[index]
    if (line === undefined) return undefined

    const key = entryKeyOf(line)
    if (key === undefined) return undefined

    unitLines.push(line)
    index += 1

    // 延续行一直吸到「下一个条目 / 注释」或块尾；中间出现认不出的行就整体放弃。
    while (index < lines.length) {
        const next = lines[index]
        if (next === '}' || SDK_DOC_LINE.test(next) || SDK_ENTRY_START.test(next)) break

        if (!SDK_CONTINUATION_LINE.test(next)) return undefined

        unitLines.push(next)
        index += 1
    }

    return { key, lines: unitLines, end: index }
}

/**
 * 条目行 → 原始工具名；形态不符返回 undefined。
 *
 * @param line - 单行文本。
 * @returns 工具名（引号形态还原成原名）；不是条目行时 undefined。
 */
function entryKeyOf(line: string): string | undefined {
    const match = SDK_ENTRY_START.exec(line)
    if (match === null) return undefined

    const raw = match[1]
    if (!raw.startsWith('"')) return raw

    try {
        return JSON.parse(raw) as string

    } catch {
        return undefined
    }
}
