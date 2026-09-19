import type { EnhanceAppContext } from 'vitepress'
import { useRoute } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import imageViewer from 'vitepress-plugin-image-viewer'
import vImageViewer from 'vitepress-plugin-image-viewer/lib/vImageViewer.vue'
import vitepressNprogress from 'vitepress-plugin-nprogress'
import 'viewerjs/dist/viewer.min.css'
import 'vitepress-plugin-nprogress/lib/css/index.css'
import 'virtual:group-icons.css'
import './custom.css'

// 默认主题的 enhanceApp / Layout / 组件由 VitePress 的 extends 机制自动合并，
// 这里只写本主题自己的增强，不要再手动调 DefaultTheme.enhanceApp（会被调两次）。
export default {
    extends: DefaultTheme,

    enhanceApp(ctx: EnhanceAppContext) {
        vitepressNprogress(ctx)
        ctx.app.component('vImageViewer', vImageViewer)
    },

    setup() {
        const route = useRoute()
        imageViewer(route)
    },
}
