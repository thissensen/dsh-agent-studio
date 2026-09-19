/**
 * 对外三处的同步自检：README.md、README.en.md、docs/（文档站）。
 *
 * 同一件事（安装命令、仓库地址、文档站地址）会写在三个地方，改一处漏两处迟早
 * 发生——而它们全都对外可见。这套检查把「三处都有、且指向同一事实」变成机器可查：
 * 任何一处的字面量漂了，这里当场红。
 *
 * 跑法：node scripts/verify-docs.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// 这三个字面量是三处同步的核心；改任何一处，三处一起改（本脚本就是防漏的）。
const INSTALL_COMMAND = 'dsh plugin --profile web add dsh-agent-studio'
const REPO_URL = 'https://github.com/thissensen/dsh-agent-studio'
const DOCS_URL = 'https://thissensen.github.io/dsh-agent-studio/'

let passed = 0
let failed = 0

/**
 * 断言。
 * @param label - 用例名。
 * @param condition - 是否通过。
 * @param detail - 失败时补充的信息。
 */
function check(label, condition, detail) {
    if (condition) {
        passed += 1
        console.log(`  ✓ ${label}`)
        return
    }

    failed += 1
    console.log(`  ✗ ${label}${detail === undefined ? '' : ` —— ${detail}`}`)
}

function read(relativePath) {
    return readFileSync(join(ROOT, relativePath), 'utf8')
}

const readmeZh = read('README.md')
const readmeEn = read('README.en.md')
const packageJson = JSON.parse(read('package.json'))
const docsConfig = read('docs/.vitepress/config.ts')
const docsIndex = read('docs/index.md')
const docsInstall = read('docs/install.md')

// Release 安装包（离线装法）：文件名里的版本号跟着 package.json 走——发新版时这里会红，
// 提醒把两个 README 与文档站里的文件名一起改掉。
const RELEASE_TARBALL = `dsh-agent-studio-${packageJson.version}.tgz`
const RELEASE_COMMAND = `dsh plugin --profile web add "./${RELEASE_TARBALL}"`

// 安装命令：两个 README 与文档站安装页三处一致
check('README.md 含安装命令', readmeZh.includes(INSTALL_COMMAND))
check('README.en.md 含安装命令', readmeEn.includes(INSTALL_COMMAND))
check('docs/install.md 含安装命令', docsInstall.includes(INSTALL_COMMAND))
check('安装命令里的包名与 package.json 一致', INSTALL_COMMAND.endsWith(packageJson.name), packageJson.name)

// 仓库地址：两个 README、文档站首页、文档站导航
check('README.md 含仓库地址', readmeZh.includes(REPO_URL))
check('README.en.md 含仓库地址', readmeEn.includes(REPO_URL))
check('docs/index.md 含仓库地址', docsIndex.includes(REPO_URL))
check('docs 导航含仓库地址', docsConfig.includes(REPO_URL))

// 文档站地址：两个 README 都要指向它（README → 文档站的对接）
check('README.md 含文档站地址', readmeZh.includes(DOCS_URL))
check('README.en.md 含文档站地址', readmeEn.includes(DOCS_URL))

// Release 安装命令：同样三处一致，且与 package.json 的版本号对得上
check('README.md 含 Release 安装命令', readmeZh.includes(RELEASE_COMMAND))
check('README.en.md 含 Release 安装命令', readmeEn.includes(RELEASE_COMMAND))
check('docs/install.md 含 Release 安装命令', docsInstall.includes(RELEASE_COMMAND))

console.log(`\n结果：${passed} 项通过${failed > 0 ? `，${failed} 项失败` : ''}。`)
process.exit(failed > 0 ? 1 : 0)
