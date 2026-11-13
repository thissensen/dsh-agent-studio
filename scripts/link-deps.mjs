/**
 * 把宿主包链接进插件自己的 node_modules。
 *
 * 为什么必须做（规格 2.7 记录的坑，本机已实测复现）：
 *
 *   插件以 `link:` 方式装进 profile 后，`node_modules/dsh-agent-studio` 是指向
 *   项目目录的符号链接。Node 默认把符号链接解析成**真实路径**，于是模块解析
 *   从项目目录向上找 `node_modules` —— 而宿主包在
 *   `$DSH_HOME/profiles/node_modules/@deepseek-ai/` 下，与项目目录毫无父子关系。
 *   结果就是 `import '@deepseek-ai/schemastery'` 报 ERR_MODULE_NOT_FOUND。
 *
 *   注意：这个问题只在插件 `import` 宿主包时出现；不 import 宿主包时，
 *   插件照样能被加载（Phase 2 第一版已验证）。
 *
 * 做法：读 package.json 的 peerDependencies，加上 EXTRA_LINKED_PACKAGES 里那几个
 * 非 peer、但本机也要解析的包，为每个包在本项目的 `node_modules/@deepseek-ai/`
 * 下建一个目录链接，指向宿主机上那份。
 *
 * 用法：node scripts/link-deps.mjs [profile 名，默认 desktop]
 *
 * 宿主包目录的来源优先级（**逐包**按序找第一个有它的）：`DSH_HOST_DIR`（显式指定
 * 某个 dsh 安装目录的 node_modules）→ 各 home 的 `profiles/node_modules/@deepseek-ai/`
 * → 从 profile 层符号链接反推出来的安装目录 → `DSH_APP_DIR`（桌面版兜底）。
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PROFILE_NAME = process.argv[2] ?? 'desktop'
const HOST_SCOPE = '@deepseek-ai/'
// 目录名本身（不带尾斜杠）：反推安装目录时按路径段比对，见 detectInstallScopeDir。
const HOST_SCOPE_NAME = HOST_SCOPE.slice(0, -1)
const LOCAL_SCOPE_DIR = join(PROJECT_ROOT, 'node_modules', '@deepseek-ai')

/**
 * peerDependencies 之外还要链的包。
 *
 * `dsh-client-ui-primitives`（平台组件库）**不能进 peerDependencies**：运行期它由平台的
 * 前端 bundle（模块 seed 表）供给，插件声明 peer 等于要求「平台必须在我自己的依赖里给这个包」，
 * 与平台的实际供给方式不符。但本机 **tsc 与 vitest 是按 node_modules 解析的**：pnpm 按
 * devDependencies 建的 registry 副本缺传递依赖 `@deepseek-ai/dsh-util-workspace-path`
 * ⇒ 类型检查与 13 个测试文件直接挂。所以本机链接清单里额外带上它，指到宿主机上那份完整副本。
 */
const EXTRA_LINKED_PACKAGES = ['@deepseek-ai/dsh-client-ui-primitives']

/**
 * 候选宿主包目录：按优先级返回所有**真的存在**的 `@deepseek-ai/` 目录（去重）。
 *
 * 为什么不能只探一个：profile 层与安装目录的包集合不一样。`dsh-agent-preset-registry`
 * **不在** profile 层（`~/.dsh/profiles/node_modules/@deepseek-ai/` 里没有它），只随
 * DSH 安装目录一起发 ⇒ 只探 profile 层就会把它判成「宿主没有」而跳过，项目里留下 pnpm
 * 按 devDependencies 建的 registry 副本；那份副本 import `@deepseek-ai/cordis` 解析不到
 * （registry 副本不带宿主的传递依赖），`verify-host` 当场红。2026-11 实测：`pnpm install`
 * 之后裸跑本脚本必然踩这一条，所以候选排成列表、**逐包**按序找第一个有它的目录。
 *
 * @returns 候选 `@deepseek-ai` 目录的绝对路径数组，顺序即取包优先级。
 */
function resolveHostScopeDirs() {
    const candidates = []

    // ① 适配期显式覆盖：直接指向某个 dsh 安装目录的 node_modules（例：
    // <DSH 安装目录>/node_modules）。用途是把「项目开发用的宿主包来源」
    // 与「profile 运行时的 link 层」解耦——平台升版时可以先只切开发侧，
    // 不动正在跑的 GUI 所依赖的那一层。
    const explicit = process.env.DSH_HOST_DIR
    if (explicit !== undefined && explicit !== '') candidates.push(join(explicit, HOST_SCOPE))

    // ② 各 home 的 profile 层。home 目录名在历史上出现过两个（`~/.dsh` 与桌面端 beta
    // 通道的 `~/.dsh-beta`，后者 2026-09-18 曾启用、2026-09-19 已回切统一为 `~/.dsh`）。
    // 两份 home 的 `profiles/node_modules/@deepseek-ai/` 都只是一层 symlink 群
    // （随 app 升级自动指到新版宿主包），所以按「DSH_HOME 显式指定 → `~/.dsh`（现役）
    // → `~/.dsh-beta`（历史兜底）」全列出来，不去猜哪一个才对。
    const homes = []
    if (process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '') homes.push(process.env.DSH_HOME)
    homes.push(join(homedir(), '.dsh'), join(homedir(), '.dsh-beta'))
    const profileScopeDirs = homes.map((home) => join(home, 'profiles', 'node_modules', HOST_SCOPE))
    candidates.push(...profileScopeDirs)

    // ③ 从 ② 里任一条符号链接反推安装目录：profile 层拿不到的那几个包（preset-registry）
    // 只在安装目录里，反推出来才能不用配任何环境变量就找齐。
    const installScopeDir = detectInstallScopeDir(profileScopeDirs)
    if (installScopeDir !== undefined) candidates.push(installScopeDir)

    // ④ 桌面版把平台包留在 app 目录里，用 DSH_APP_DIR 显式指路——不猜任何盘符路径。
    if (process.env.DSH_APP_DIR !== undefined && process.env.DSH_APP_DIR !== '') {
        candidates.push(join(process.env.DSH_APP_DIR, 'node_modules', HOST_SCOPE))
    }

    // 同一个目录可能从多条路探到（`DSH_HOME` 就是 `~/.dsh` 时 ①② 给出同一个路径），
    // 不存在（另一个 home 没装、DSH_APP_DIR 没设）的候选直接丢掉。
    // Windows 路径大小写不敏感 ⇒ 统一小写再比。
    const dirs = []
    const seen = new Set()
    for (const dir of candidates) {
        if (!existsSync(dir)) continue

        const key = resolve(dir).toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        dirs.push(dir)
    }

    return dirs
}

/**
 * 从 profile 层的符号链接反推安装目录的 `@deepseek-ai/`。
 *
 * 为什么要反推：profile 层是随 app 升级自动重指的链接群，而安装目录里还有一批**不进
 * profile 层**的包（`dsh-agent-preset-registry` 只随安装目录走）。安装位置因机器而异
 * （盘符、Program Files / 用户目录都可能），不许在脚本里写死，也不该逼每台机器配
 * `DSH_HOST_DIR`；而 profile 层这一层链接全都指向它，是最好的就地凭据。
 *
 * 只读 profile scope 这一层目录项（几十条，**不遍历安装树**）；`realpathSync` 用 try/catch
 * 包住——home 改名 / 平台升版后遗留的悬空链接解析会抛，跳过即可。
 *
 * @param {string[]} profileScopeDirs 各 home 的 `profiles/node_modules/@deepseek-ai/`
 * @returns 安装目录里那份 `@deepseek-ai` 的绝对路径；反推不出来时返回 `undefined`。
 */
function detectInstallScopeDir(profileScopeDirs) {
    for (const profileScopeDir of profileScopeDirs) {
        if (!existsSync(profileScopeDir)) continue

        for (const name of readdirSync(profileScopeDir)) {
            let resolved
            try {
                resolved = realpathSync(join(profileScopeDir, name))
            } catch {
                // 悬空链接：解析不了就跳过，换下一个条目。
                continue
            }

            // 目标形如 `…/node_modules/@deepseek-ai/<包名>`：按路径段找出那对父目录，
            // 截到 `@deepseek-ai` 为止就是安装目录的 scope 目录（按 sep 切，跨平台通用）。
            const parts = resolved.split(sep)
            const scopeParent = parts.indexOf('node_modules')
            if (scopeParent < 0 || parts[scopeParent + 1] !== HOST_SCOPE_NAME) continue

            return parts.slice(0, scopeParent + 2).join(sep)
        }
    }

    return undefined
}

const HOST_SCOPE_DIRS = resolveHostScopeDirs()

const manifest = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'))
const peerPackageNames = Object.keys(manifest.peerDependencies ?? {})
// 链接清单 = peer 键 + 白名单（去重，保持 peerDependencies 的原顺序、白名单排后）。
const wanted = [...new Set([...peerPackageNames, ...EXTRA_LINKED_PACKAGES])]

if (wanted.length === 0) {
    console.log('package.json 里没有 peerDependencies，无需链接。')
    process.exit(0)
}

if (HOST_SCOPE_DIRS.length === 0) {
    console.error('找不到宿主包目录（@deepseek-ai）。')
    console.error(`已探测 $DSH_HOST_DIR、$DSH_HOME、~/.dsh、~/.dsh-beta 下的 profiles/node_modules（profile 名 "${PROFILE_NAME}"），以及从 profile 层反推的安装目录。`)
    console.error('桌面版可以设 DSH_APP_DIR=<DSH 安装目录>/resources/app 直接指向平台包。')
    process.exit(1)
}

mkdirSync(LOCAL_SCOPE_DIR, { recursive: true })

let linked = 0
let missing = 0

for (const fullName of wanted) {
    // peerDependencies 的键是完整包名（含 scope），而候选目录已经是 scope 目录本身，
    // 所以要剥掉 '@deepseek-ai/' 前缀再拼接。
    const pkg = fullName.startsWith(HOST_SCOPE) ? fullName.slice(HOST_SCOPE.length) : fullName

    // 逐包在候选里找第一个有它的当源：profile 层与安装目录各有对方的缺口
    // （preset-registry 只在安装目录，个别只装了 profile 层的包反过来同理），
    // 全都没有才算宿主真没这个包。
    let source
    for (const hostScopeDir of HOST_SCOPE_DIRS) {
        const candidate = join(hostScopeDir, pkg)
        if (!existsSync(candidate)) continue
        source = candidate
        break
    }

    const target = join(LOCAL_SCOPE_DIR, pkg)

    if (source === undefined) {
        console.log(`  跳过 ${fullName} —— 所有候选宿主目录里都没有这个包`)
        missing += 1
        continue
    }

    // 先清掉旧链接，让本脚本可重复执行。
    // 只用 rmSync 删这一个已知路径，绝不做递归通配删除。
    // 判存在必须用 lstat（而非 existsSync）：home 改名后旧链接成为**悬空**链接，
    // 而 existsSync 跟随链接、对悬空链接返回 false ⇒ 清理被跳过、symlinkSync 撞 EEXIST
    // （2026-09-19 home 改名实测）。
    try {
        lstatSync(target)
        rmSync(target, { recursive: true, force: true })
    } catch {
        // 目标不存在：无需清理。
    }

    symlinkSync(source, target, 'junction')
    console.log(`  链接 ${pkg}`)
    linked += 1
}

console.log(`\n完成：链接 ${linked} 个${missing > 0 ? `，跳过 ${missing} 个` : ''}。`)
