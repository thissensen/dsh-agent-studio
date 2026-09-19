/**
 * dsh-agent-studio —— client 半边：注册进 DSH 设置页的 React 面板（v2「Agent 中心」）。
 *
 * **壳与部件（第十五轮拆分）。** 这个文件是「壳」，只做四件事：
 *
 *   1. 向外导出 `inject` / `apply`——平台加载 client bundle 时按 cordis 插件形态取；
 *      bundle 的 `window.__ModuleLoader__.load({ id, factory })` 外壳由构建层
 *      （`vite.shared.ts` 的 renderChunk）统一包好，源文件里**不再手写**注册代码；
 *   2. 把 zh / en 两份字典注册进平台的 locale 服务，给 section 的 descriptor 写上
 *      命名空间——平台据此把绑好命名空间的 `t` 注入本组件的 props（语言切换时
 *      outlet 自动重渲染、`t` 引用换新）；
 *   3. 挂一个 `settings.section`（`ShellSection`），先在设置页里占住位置；
 *   4. 挂载时**运行时加载**真正的面板实现 `client/parts/panel.js`——host 的
 *      `/api/dsh-agent-studio/client-parts/panel.js` 路由**每次读盘**伺服，所以
 *      **改部件只需要刷新页面**，不必重启 DSH（改这个壳本身仍要重启：它受 DSH
 *      启动快照的约束）。
 *
 * **面板拿不到 cordis ctx**（它由 ModuleLoader 在运行时物化，seed 表里只有 react /
 * primitives 这类基础模块），所以 `t` 必须**由这里经 props 传进去**；面板内部再用
 * React context 往下发。天然优雅降级：旧壳 + 新部件 ⇒ 面板拿不到 `t` ⇒ 显示中文。
 *
 * **加载失败不拖垮设置页。** 部件加载不出来（路由没挂、文件缺失、脚本报错）时，
 * 这里画出「加载失败 + 重试」的卡片——壳永远渲染得出来。
 *
 * **只注册一个 `settings.section`。** 目标 DSH 在渲染 section 列表时，
 * 第二个注册会抛错并让整页空白（`dsh-config-manager/src/client/index.ts`
 * 第 108-110 行的原注释）。面板内部的顶栏、左栏、主区都是那一个 section
 * **内部**的切换——部件里做的事不改变这条约束。
 *
 * @module dsh-agent-studio/client
 */

import { createElement, useEffect, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { createTranslate, en, LOCALE_NS, zh } from './locales'
import type { PlatformTranslate, Translate } from './locales'

/** 部件模块（`client/parts/panel.js`）导出的面板组件：`t` 由壳传进去。 */
type PanelComponent = (props: { t?: PlatformTranslate }) => ReactElement

/** 面板部件的加载状态机。 */
type PanelState =
    | { status: 'loading' }
    | { status: 'ready'; Component: PanelComponent }
    | { status: 'failed'; message: string }

/** `settings.section` 的登记描述符（本壳用到的字段）。 */
interface SectionDescriptor {
    name: string
    id: string
    order: number
    /** 文案命名空间：平台据此把绑好的 `t` 注入本组件 props。 */
    locale: string
    label: () => string
    inject: () => Record<string, unknown>
}

/** 平台 locale 服务里本壳用到的部分（`dsh-client-locale` 提供）。 */
interface LocaleService {
    register(ns: string, dicts: Record<string, Record<string, string>>): () => void
    bind(ns: string): PlatformTranslate
}

/** client 根上下文里本壳用到的部分。 */
interface ClientContext {
    /** 登记随插件生命周期回收的副作用（locale 字典register 的 disposer 挂这里）。 */
    effect(callback: () => void | (() => void), label?: string): void
    slots: {
        inject(name: string, register: () => void): void
        register(descriptor: SectionDescriptor, component: PanelComponent): void
    }
    locale: LocaleService
}

/** 面板部件在 host 上的位置（`lib/api.js` 的 `client-parts` 路由读盘伺服）。 */
const PANEL_PART_URL = '/api/dsh-agent-studio/client-parts/panel.js'

/** 面板部件注册的模块 id（部件 bundle 的包装层自己声明）。 */
const PANEL_MODULE_ID = 'dsh-agent-studio-panel'

/** 部件加载的共享 promise：并发/重复调用只加载一次；失败后清空允许重试。 */
let panelPromise: Promise<PanelComponent> | null = null

/**
 * 用 <script> 标签加载一个同源脚本（经典脚本；它执行时向
 * `__ModuleLoader__.load` 注册自己——boot 前后的两种形态都安全）。
 *
 * 带 `?t=` 时间戳：部件是运行时读盘的，别让浏览器缓存挡住「改完刷新」。
 *
 * @param src - 脚本地址。
 * @param t - 失败消息用的翻译器。
 */
function loadScript(src: string, t: Translate): Promise<void> {
    return new Promise((resolve, reject) => {
        const el = document.createElement('script')
        el.async = true
        el.src = src
        el.onload = () => resolve()
        el.onerror = () => reject(Error(t('shell.scriptFailed', { src })))
        document.head.appendChild(el)
    })
}

/** 取部件导出：模块已注册就直接拿（HMR 重新物化壳时不再重复载脚本）。 */
function takePanelExport(): PanelComponent {
    const panelModule = require(PANEL_MODULE_ID) as { AgentStudioSection: PanelComponent }
    return panelModule.AgentStudioSection
}

/** 先直接取；还没注册就加载脚本，加载完再取。 */
async function grabPanel(t: Translate): Promise<PanelComponent> {
    try {
        return takePanelExport()

    } catch {
        await loadScript(`${PANEL_PART_URL}?t=${Date.now()}`, t)
        return takePanelExport()
    }
}

/**
 * 取面板部件。并发调用共享同一次尝试；失败清空共享 promise，允许「重试」再试。
 */
async function loadPanel(t: Translate): Promise<PanelComponent> {
    if (panelPromise !== null) return panelPromise

    const attempt = grabPanel(t)
    panelPromise = attempt

    try {
        return await attempt

    } catch (err) {
        panelPromise = null
        throw err
    }
}

/**
 * 壳自己的最小样式：部件加载不出来时也得画得出东西。
 *
 * 自绘按钮必须带 `appearance: none`——不关掉原生绘制，被点/悬停过一次后
 * UA 会重画边框且不还原（面板里的老坑）。
 */
const NOTE_BUTTON: CSSProperties = {
    appearance: 'none',
    WebkitAppearance: 'none',
    outline: 'none',
    alignSelf: 'flex-start',
    padding: '4px 10px',
    border: '1px solid rgba(127,127,127,0.45)',
    borderRadius: '6px',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    cursor: 'pointer',
}

const NOTE_WRAP: CSSProperties = {
    padding: '16px',
    fontSize: '13px',
    lineHeight: '1.6',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
}

/**
 * 设置页里占位的壳：部件就绪后把渲染整个交给它。
 *
 * `t` 由平台注入（descriptor 声明了 `locale` 命名空间）；缺了就用中文兜底。
 * 语言切换时平台会换一个新的 `t` 引用传进来，面板据此重渲染——不用重启。
 *
 * @param props - 平台合成的 slot props。
 */
function ShellSection(props: { t?: PlatformTranslate }): ReactElement {
    const [panel, setPanel] = useState<PanelState>({ status: 'loading' })
    const [attempt, setAttempt] = useState(0)

    const t = createTranslate(props.t)

    useEffect(() => {
        let alive = true

        // 效果不能是 async 函数（返回值要留给清理），所以内部起具名任务；
        // 卸载后靠 alive 标志丢弃迟到的结果。
        async function load(): Promise<void> {
            try {
                const Component = await loadPanel(t)
                if (alive) setPanel({ status: 'ready', Component })

            } catch (err) {
                if (alive) {
                    const message = err instanceof Error ? err.message : String(err)
                    setPanel({ status: 'failed', message })
                }
            }
        }

        load()

        return () => { alive = false }
    }, [attempt])

    if (panel.status === 'ready') return createElement(panel.Component, { t: props.t })

    if (panel.status === 'failed') {
        return createElement('div', { style: NOTE_WRAP }, [
            createElement('div', { key: 'title', style: { fontWeight: '600' } }, t('shell.failedTitle')),
            createElement('div', { key: 'message', style: { opacity: 0.75 } }, panel.message),
            createElement('div', { key: 'hint', style: { opacity: 0.75 } }, t('shell.failedHint')),
            createElement('button', {
                key: 'retry',
                type: 'button',
                onClick: () => {
                    setPanel({ status: 'loading' })
                    setAttempt(attempt + 1)
                },
                style: NOTE_BUTTON,
            }, t('shell.retry')),
        ])
    }

    return createElement('div', { style: NOTE_WRAP }, [
        createElement('div', { key: 'title', style: { fontWeight: '600' } }, t('shell.loadingTitle')),
        createElement('div', { key: 'hint', style: { opacity: 0.75 } }, t('shell.loadingHint')),
    ])
}

/** 必需服务：fiber 会等它们就绪。`settings.section` 由 slots 提供，字典要 locale。 */
export const inject = ['slots', 'locale']

/**
 * 把壳挂进设置页。
 * @param ctx - client root context。
 */
export function apply(ctx: ClientContext): void {
    // 登记挂 effect 上：插件重载（HMR）时先把旧字典摘掉，再注册新的——
    // 平台的 register 对「同一命名空间的同一语言」是**重复即抛错**。
    ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'agent-studio: locale dictionaries')

    const t = createTranslate(ctx.locale.bind(LOCALE_NS))

    // `ctx.slots.inject` 是声明感知注册：目标 slot 的声明还没到 ledger 前不注册，
    // 声明塌缩时自动移除、重声明后自动重挂。直接 register 在声明未到时会失败。
    ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'agent-studio',
        // 官方「Agent 预设」那一页是 order 20，这里紧挨在它下面
        order: 21,
        locale: LOCALE_NS,
        label: () => t('shell.sectionLabel'),
        inject: () => ({}),
    }, ShellSection))
}
