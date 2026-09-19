/**
 * 两个 client 产物的公共构建片段。
 *
 * 壳（`vite.config.ts`）与部件（`vite.panel.config.ts`）是两次独立构建：
 * 它们的产物落在不同目录、注册的模块 id 也不同，而 Vite 的配置文件
 * 不支持导出配置数组，所以共用这一份 external 清单与包装插件。
 */

import type { Plugin } from 'vite'

/**
 * 交给平台在运行时解析的共享模块。
 *
 * `react` 与 `react/jsx-runtime` 必须 external——漏了会把 react 打进 bundle，
 * 与平台 seed 的那份打架（两个 React 实例会让 hooks 直接报错）；
 * primitives 的 CSS 由平台模块体自己注入，require 即得，同样不能打进来。
 *
 * `react-dom` 也在平台 seed 表里（primitives 的 Modal/HoverCard 用它做 portal），
 * 自绘浮层要 portal 到 body，走同一个运行时实例。
 */
export const EXTERNAL_MODULES = [
    'react',
    'react/jsx-runtime',
    'react-dom',
    '@deepseek-ai/dsh-client-ui-primitives',
]

/**
 * 把整个 CJS chunk 包进 `window.__ModuleLoader__.load({ id, factory })` 外壳。
 *
 * 平台的客户端模块系统只认这个注册形态：脚本执行时登记 factory，
 * 之后 `require(id)` 才执行模块体。官方前端壳的产物就是这个形状
 * （见 `dsh-client-ui-agent-preset/lib/client.js` 的前 40 行）。
 *
 * @param id - 注册的模块 id（壳是包名，部件是 `dsh-agent-studio-panel`）。
 */
export function dshModuleLoaderWrap(id: string): Plugin {
    return {
        name: 'dsh-module-loader-wrap',
        apply: 'build',

        renderChunk(code, chunk) {
            if (!chunk.isEntry) return null

            return {
                code: `window.__ModuleLoader__.load({
  id: ${JSON.stringify(id)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${code}
    return module.exports;
  },
});
`,
                map: null,
            }
        },
    }
}
