/**
 * 壳产物的构建配置：`client/index.js`（`package.json` 的 `exports["./client"]`）。
 *
 * 壳受 DSH 启动快照约束 ⇒ **首次构建必须在启动 DSH 之前完成**，之后改壳要重启；
 * 部件不受影响（刷新页面即生效）。
 */

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { dshModuleLoaderWrap, EXTERNAL_MODULES } from './vite.shared'

export default defineConfig({
    plugins: [react(), dshModuleLoaderWrap('dsh-agent-studio')],

    build: {
        emptyOutDir: false,
        outDir: 'client',
        lib: {
            entry: 'src/client/index.ts',
            formats: ['cjs'],
            fileName: () => 'index.js',
        },
        rollupOptions: {
            // 部件是运行时按模块 id 动态 require 的，不经过打包器；列在这里只是标明它不是内联物。
            external: [...EXTERNAL_MODULES, 'dsh-agent-studio-panel'],
            output: { exports: 'named' },
        },
    },
})
