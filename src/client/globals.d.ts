/**
 * client 半边的全局类型增强：平台在宿主页面里预置的 `window.__ModuleLoader__`。
 *
 * 平台客户端模块系统只认一个约定：bundle 执行时调用 `load({ id, factory })`
 * 登记自己，之后别人用 `require(id)` 取导出。`react` 就在外壳播种的静态表里
 * （所以不需要在 `dsh.client` 里声明 external）。
 */

interface Window {
    __ModuleLoader__: {
        load(registration: {
            id: string
            factory: (require: (spec: string) => unknown) => unknown
        }): void
    }
}

/**
 * bundle 外壳（构建层注入的 `factory`）提供的同步 require。
 *
 * 它只在 factory 内部有效——运行时由平台模块表解析（`react` 等共享模块
 * 就在里面）。返回 `unknown` 是有意的：调用处自己断言需要的形状。
 */
declare const require: (spec: string) => unknown
