/**
 * 部件产物的构建配置：`client/parts/panel.js`。
 *
 * 这个文件由 host 的 `/api/dsh-agent-studio/client-parts/<name>` 路由**每次读盘**
 * 伺服，所以路径不能改，改了壳就加载不到；相对的，「改部件刷新页面即生效」
 * 这条开发便利也建立在它身上。
 */

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { dshModuleLoaderWrap, EXTERNAL_MODULES } from './vite.shared'

export default defineConfig({
    plugins: [react(), dshModuleLoaderWrap('dsh-agent-studio-panel')],

    build: {
        emptyOutDir: false,
        outDir: 'client/parts',
        lib: {
            entry: 'src/client/parts/panel.ts',
            formats: ['cjs'],
            fileName: () => 'panel.js',
        },
        rollupOptions: {
            external: EXTERNAL_MODULES,
            output: { exports: 'named' },
        },
    },
})
