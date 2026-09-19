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
 * 做法：读 package.json 的 peerDependencies，为每个包在本项目的
 * `node_modules/@deepseek-ai/` 下建一个目录链接，指向 profile 里那份。
 *
 * 用法：node scripts/link-deps.mjs [profile 名，默认 desktop]
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PROFILE_NAME = process.argv[2] ?? 'desktop'
const HOST_SCOPE = '@deepseek-ai/'
const LOCAL_SCOPE_DIR = join(PROJECT_ROOT, 'node_modules', '@deepseek-ai')

/**
 * 宿主包目录在哪：逐级探测，返回第一个**真的存在**的 `@deepseek-ai/` 目录。
 *
 * 为什么要探测：home 目录名在历史上出现过两个（`~/.dsh` 与桌面端 beta 通道的
 * `~/.dsh-beta`，后者 2026-09-18 曾启用、2026-09-19 已回切统一为 `~/.dsh`）。
 * 两份 home 的 `profiles/node_modules/@deepseek-ai/` 都只是一层 symlink 群
 * （随 app 升级自动指到新版宿主包），但**先探到哪个用哪个**——写死一个，
 * 换 home 后就会静默指错，所以按「DSH_HOME 显式指定 → `~/.dsh`（现役）→
 * `~/.dsh-beta`（历史兜底）」逐个探。
 *
 * @returns 宿主 `@deepseek-ai` 目录的绝对路径；探不到时返回 `undefined`，由调用方报错。
 */
function resolveHostScopeDir() {
    const homes = []
    if (process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '') homes.push(process.env.DSH_HOME)
    homes.push(join(homedir(), '.dsh'), join(homedir(), '.dsh-beta'))

    for (const home of homes) {
        const dir = join(home, 'profiles', 'node_modules', HOST_SCOPE)
        if (existsSync(dir)) return dir
    }

    // 桌面版把平台包留在 app 目录里，用 DSH_APP_DIR 显式指路——不猜任何盘符路径。
    if (process.env.DSH_APP_DIR !== undefined && process.env.DSH_APP_DIR !== '') {
        return join(process.env.DSH_APP_DIR, 'node_modules', HOST_SCOPE)
    }

    return undefined
}

const HOST_SCOPE_DIR = resolveHostScopeDir()

const manifest = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'))
const wanted = Object.keys(manifest.peerDependencies ?? {})

if (wanted.length === 0) {
    console.log('package.json 里没有 peerDependencies，无需链接。')
    process.exit(0)
}

if (HOST_SCOPE_DIR === undefined || !existsSync(HOST_SCOPE_DIR)) {
    console.error('找不到宿主包目录（@deepseek-ai）。')
    console.error(`已探测 $DSH_HOME、~/.dsh、~/.dsh-beta 下的 profiles/node_modules（profile 名 "${PROFILE_NAME}"）。`)
    console.error('桌面版可以设 DSH_APP_DIR=<DSH 安装目录>/resources/app 直接指向平台包。')
    process.exit(1)
}

mkdirSync(LOCAL_SCOPE_DIR, { recursive: true })

let linked = 0
let missing = 0

for (const fullName of wanted) {
    // peerDependencies 的键是完整包名（含 scope），而目标目录已经是 scope 目录本身，
    // 所以要剥掉 '@deepseek-ai/' 前缀再拼接。
    const pkg = fullName.startsWith(HOST_SCOPE) ? fullName.slice(HOST_SCOPE.length) : fullName

    const source = join(HOST_SCOPE_DIR, pkg)
    const target = join(LOCAL_SCOPE_DIR, pkg)

    if (!existsSync(source)) {
        console.log(`  跳过 ${fullName} —— 宿主目录里没有这个包`)
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
