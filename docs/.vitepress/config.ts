import { defineConfig } from 'vitepress'
import { groupIconMdPlugin, groupIconVitePlugin } from 'vitepress-plugin-group-icons'

// base 由环境变量控制：本地开发不设（始终为 /），部署到 GitHub Pages 项目站时
// 在构建命令里设 DOCS_BASE=/dsh-agent-studio/。这样本地访问地址不用为部署改配置。
export default defineConfig({
    lang: 'zh-CN',
    title: 'dsh-agent-studio',
    description: '把 Agent 的提示词、工具、可见技能变成可视化配置的 DSH 插件',
    cleanUrls: true,
    base: process.env.DOCS_BASE ?? '/',

    markdown: {
        // group-icons 的 markdown 插件：给 ::: code-group 的代码块标题补图标
        config(md) {
            md.use(groupIconMdPlugin)
        },
    },

    vite: {
        plugins: [groupIconVitePlugin()],
    },

    themeConfig: {
        nav: [
            { text: '指南', link: '/install' },
            {
                text: 'GitHub',
                link: 'https://github.com/thissensen/dsh-agent-studio',
            },
        ],

        socialLinks: [{ icon: 'github', link: 'https://github.com/thissensen/dsh-agent-studio' }],

        sidebar: [
            {
                text: '指南',
                items: [
                    { text: '安装', link: '/install' },
                    { text: '核心概念', link: '/concepts' },
                    { text: '功能详解', link: '/features' },
                    { text: '自带工具清单', link: '/tools' },
                    { text: '常见问题', link: '/faq' },
                ],
            },
        ],

        outline: { label: '本页目录', level: [2, 3] },
        docFooter: { prev: '上一页', next: '下一页' },
        darkModeSwitchLabel: '深浅色',
        returnToTopLabel: '回到顶部',
        sidebarMenuLabel: '目录',
        search: { provider: 'local' },
    },
})
