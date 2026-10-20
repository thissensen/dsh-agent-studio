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
 *   3. 挂三条槽位（`settings.section` / `main` / `sidebar.panellist`），把同一份
 *      面板摆到设置页、主区整页与左栏一行三处（见下文「注册三条槽位」）；后两条
 *      （`main` / `sidebar.panellist`）跟着「注册到主页面」开关增减；
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
 * **注册三条槽位。** ① `settings.section`：目标 DSH 在渲染 section 列表时，
 * 第二个 `settings.section` 注册会抛错并让整页空白（`dsh-config-manager/src/
 * client/index.ts` 第 108-110 行的原注释）——所以设置页里那一份**只此一个**、
 * **始终注册**（开关关掉后它是唯一的回来路径），面板内部的顶栏 / 左栏 / 主区
 * 仍是它**内部**的切换；② `main` 的一页：主区整页铺开；③ `sidebar.panellist`
 * 的一行：左栏入口。②③ 是**同一份面板的两个落点**（组件见 `ShellPage` 与
 * `StudioRowIcon`），且**同进同退**：开关关掉时两条一起注销（左栏行消失、主区
 * 退回会话页），打开时一起重新注册；只注销 `main`、把行留着的话，点行会走
 * `layout.selectPanel` 的 `hasMainPanel` 检查当场抛错（坑册坑 54）。
 *
 * **key 与 id 必须同值**：`main` 的 `key` 与 `sidebar.panellist` 的 `id` 都取
 * `PANEL_ID`——平台上点左栏那行时按这个值切主区面板。
 *
 * **老宿主上自动降级**：两条槽位都没声明的老宿主上，`slots.inject` 直接跳过、
 * 不报错 ⇒ 主页面那一页与左栏行都不出现（壳只挂 `settings.section`）。
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

/** 注销回调：平台的各种 register 都返回它，声明塌缩时调用一次。 */
type Disposer = () => void

/** `sidebar.panellist` 一行的登记描述符（kind=list：左栏全局面板行）。 */
interface PanelRowDescriptor {
    name: string
    /** 行 id：与主区那页的 `key` **同值**——平台按它切面板。 */
    id: string
    order: number
    locale: string
    /** 行标题与可访问名：语言切换时平台重算它，所以写成 `() => t(...)`。 */
    label: () => string
}

/** `main` 一页的登记描述符（kind=keyed：主区按 `key` 挂载）。 */
interface PanelPageDescriptor {
    name: string
    /** 主区页的 key：与左栏那行的 `id` **同值**。 */
    key: string
    locale: string
    inject?: () => Record<string, unknown>
}

/** 三种槽位的登记描述符联合：平台按 `name` 认领各自的字段。 */
type SlotDescriptor = SectionDescriptor | PanelRowDescriptor | PanelPageDescriptor

/** 一条跟着「注册到主页面」开关增减的槽位（`main` / `sidebar.panellist`）。 */
interface MountSlot {
    /** 槽位名：`inject` 用它等声明。 */
    name: string
    /** 平台的声明当前在不在（`inject` 回调跑过、且没被清理）。 */
    declared: boolean
    /** 当前那次注册的注销器；`null` = 没注册（同时防重复注册与重复注销）。 */
    disposer: Disposer | null
    /** 真去登记一次：描述符要用 `apply` 里拿到的 `t`，所以是闭包不是常量。 */
    register: () => Disposer | void
}

/** 左栏那行的图标组件：平台只投递尺寸与选中态。 */
type RowIconComponent = (props: { size: number; active: boolean }) => ReactElement

/** 槽位组件：页面组件吃 `{t}`、左栏图标吃 `{size}`，平台按槽位各自投递。 */
type SlotComponent = PanelComponent | RowIconComponent

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
        /** 声明感知注册：回调的返回值就是声明塌缩时要执行的注销器，原样交回平台。 */
        inject(name: string, register: () => Disposer | void): Disposer | undefined
        register(descriptor: SlotDescriptor, component: SlotComponent): Disposer | undefined
    }
    locale: LocaleService
}

/** 面板部件在 host 上的位置（`lib/api.js` 的 `client-parts` 路由读盘伺服）。 */
const PANEL_PART_URL = '/api/dsh-agent-studio/client-parts/panel.js'

/** 面板部件注册的模块 id（部件 bundle 的包装层自己声明）。 */
const PANEL_MODULE_ID = 'dsh-agent-studio-panel'

/** 左栏行的 id 与主区页的 key：平台要求同值——点行时它自己切到同名面板。 */
const PANEL_ID = 'agent-studio'

/** 左栏行排序：官方插件页 0、dshmarket 插件市场 1、官方自动化任务 10；取 2 与插件类入口成一簇。 */
const ROW_ORDER = 2

/**
 * 「注册到主页面」的端点。壳与面板是两个 bundle（面板运行时才物化，互相 import 不了），
 * 所以常量各写一份。
 */
const MOUNT_ENDPOINT = '/api/dsh-agent-studio/ui'

/**
 * 两条跟着开关增减的槽位，`apply` 里重建。`settings.section` **不在这里**——
 * 它始终注册，是开关关掉之后唯一的回来路径。
 */
let mountSlots: MountSlot[] = []

/**
 * 两条槽位当前要不要注册。每次 `apply` 先重置成 true、并把 `mountSettled`
 * 清零——读到 host 的值之前先按「开」装好，读到 false 再一起摘。
 */
let mountMainPage = true
let mountSettled = false
const mountListeners = new Set<() => void>()

/**
 * 按当前开关把两条槽位改成「都注册」或「都注销」；重复调用安全（`disposer` 记账）。
 *
 * **两条必须同进同退**：只留左栏那行、`main` 没注册时，点行会走
 * `layout.selectPanel` 的 `hasMainPanel` 检查当场抛错（坑册坑 54）。所以声明没齐
 * 就整对不装；注销也从行开始（行在 ⇒ `main` 一定已在）。
 */
function applyMountSlots(): void {
    const declaredAll = mountSlots.every((slot) => slot.declared === true)
    if (mountMainPage === true && declaredAll === true) {
        for (const slot of mountSlots) {
            if (slot.disposer !== null) continue

            slot.disposer = slot.register() ?? null
        }

        return
    }

    for (const slot of [...mountSlots].reverse()) {
        const disposer = slot.disposer
        slot.disposer = null
        if (disposer !== null) disposer()
    }
}

/** 落地一次新状态：先把两条槽位真增删掉，再通知订阅者（面板只回显值）。 */
function setMountState(next: boolean): void {
    mountMainPage = next
    mountSettled = true

    applyMountSlots()

    for (const listener of [...mountListeners]) listener()
}

/** 订阅开关变化：返回退订函数，正好给 React effect 当清理用。 */
function subscribeMount(listener: () => void): () => void {
    mountListeners.add(listener)

    return () => { mountListeners.delete(listener) }
}

/**
 * 问一次 host：「注册到主页面」是开还是关，也就是那两条槽位要不要注册。
 *
 * 读不到就保持 true（保持注册）——读失败既不该让面板打不开，也不该把已经显示出来
 * 的面板拽下来。
 */
async function resolveMountPreference(): Promise<void> {
    let next = true

    try {
        const response = await fetch(MOUNT_ENDPOINT, { cache: 'no-store' })
        const data = await response.json()

        // 端点回的是 { ok, mountMainPage }：形状不对就按 true 走，别猜。
        if (data?.ok === true && typeof data.mountMainPage === 'boolean') next = data.mountMainPage

    } catch {
        // 读不到保持 true：按现状保持注册，不阻塞面板。
    }

    // 读的期间用户已经点过开关（桥上的 setMounted）⇒ 听用户的，这一份结果作废。
    if (mountSettled === true) return

    setMountState(next)
}

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

/**
 * 主区那一页的外框样式。
 *
 * 主区列自己的 CSS 是 `flex-direction: column` + `overflow: hidden`（平台给的），
 * 这条页面不自备滚动容器就会被**裁掉**（底部保存行这类吸顶件也一并失效）。
 */
const PAGE_WRAP: CSSProperties = { height: '100%', overflowY: 'auto' }

/**
 * 主区那一页：与设置页共用同一个 `ShellSection`，只是外面多一层可滚动框。
 *
 * 它只在开关打开时注册（见 `applyMountSlots`）：关掉时 `main` 与左栏那行**一起注销**，
 * 主区由平台自己退回会话页（`main` 条目消失时平台把 `activePanelId` 置空）。两处仍是
 * **两份独立实例**，各自的草稿互不串。
 *
 * @param props - 平台合成的 slot props（`t` 由 descriptor 的 `locale` 带来）。
 */
function ShellPage(props: { t?: PlatformTranslate }): ReactElement {
    return createElement('div', { style: PAGE_WRAP }, createElement(ShellSection, { t: props.t }))
}

/**
 * 左栏那一行的图标：三横线 + 每行一个圆点（示意「配置台」）。
 *
 * `size` 由平台按栏宽给（宽栏 16 / 收起栏 18）——照它画才不会被裁；选中态的上色
 * 由行自身负责，这里只用 `currentColor` 描边 ⇒ 不读 `active`。
 *
 * @param props - 平台给图标组件的尺寸。
 */
function StudioRowIcon(props: { size: number }): ReactElement {
    return createElement('svg', {
        width: props.size,
        height: props.size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        // 图标只是装饰：可访问名在行按钮的 aria-label 上（= label），别让它被读第二遍
        'aria-hidden': true,
    }, [
        createElement('line', { key: 'line-8', x1: 4, y1: 8, x2: 14, y2: 8 }),
        createElement('circle', { key: 'dot-8', cx: 18, cy: 8, r: 1.3 }),
        createElement('line', { key: 'line-12', x1: 4, y1: 12, x2: 14, y2: 12 }),
        createElement('circle', { key: 'dot-12', cx: 18, cy: 12, r: 1.3 }),
        createElement('line', { key: 'line-16', x1: 4, y1: 16, x2: 14, y2: 16 }),
        createElement('circle', { key: 'dot-16', cx: 18, cy: 16, r: 1.3 }),
    ])
}

/** 必需服务：fiber 会等它们就绪。`settings.section` 由 slots 提供，字典要 locale。 */
export const inject = ['slots', 'locale']

/**
 * 把面板壳注册到三个槽位：设置页那一节恒在，主区那一页与左栏那一行跟着开关增减。
 * @param ctx - client root context。
 */
export function apply(ctx: ClientContext): void {
    // 每次重载都从「两条槽位都装上 + 还没读到 host」重来，免得 HMR 后留着上一次的旧账。
    mountSlots = []
    mountMainPage = true
    mountSettled = false

    // 面板（另一个 bundle）拿不到这里的模块状态 ⇒ 经 window 上的桥读写这个开关。
    // 桥只回显值；壳据此在运行期真增删那两条槽位。
    window.__dshAgentStudioMount = {
        ready: () => mountSettled,
        mounted: () => mountMainPage,
        setMounted: setMountState,
        subscribe: subscribeMount,
    }

    // 登记挂 effect 上：插件重载（HMR）时先把旧字典摘掉，再注册新的——
    // 平台的 register 对「同一命名空间的同一语言」是**重复即抛错**。
    ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'agent-studio: locale dictionaries')

    const t = createTranslate(ctx.locale.bind(LOCALE_NS))

    // ① 设置页那一节：**始终注册**——开关关掉后它是唯一的回来路径，绝不能摘。
    // `ctx.slots.inject` 是声明感知注册：声明没到不注册，声明塌缩时执行回调的返回值。
    ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: PANEL_ID,
        // 官方「Agent 预设」那一页是 order 20，这里紧挨在它下面
        order: 21,
        locale: LOCALE_NS,
        label: () => t('shell.sectionLabel'),
        inject: () => ({}),
    }, ShellSection))

    // ②③ 两条跟着开关增减的槽位。先把两条都记上账、再统一 inject：`inject` 的回调
    // 在声明已就绪时会**同步**跑，账不齐就会只看到一条声明就动手，装出半对。
    mountSlots = [
        {
            name: 'main',
            declared: false,
            disposer: null,
            // 主区一整页：keyed 槽位，key 与下面那条左栏行的 id 同值——点行时平台按它切面板。
            register: () => ctx.slots.register({
                name: 'main',
                key: PANEL_ID,
                locale: LOCALE_NS,
                inject: () => ({}),
            }, ShellPage),
        },
        {
            name: 'sidebar.panellist',
            declared: false,
            disposer: null,
            // 左栏一行：label 用 () => t(...)——平台在语言切换时自己重算。
            register: () => ctx.slots.register({
                name: 'sidebar.panellist',
                id: PANEL_ID,
                order: ROW_ORDER,
                locale: LOCALE_NS,
                label: () => t('shell.sectionLabel'),
            }, StudioRowIcon),
        },
    ]

    for (const slot of mountSlots) {
        ctx.slots.inject(slot.name, () => {
            slot.declared = true
            applyMountSlots()

            return () => {
                slot.declared = false
                // 平台不会连带撤掉 register（它是另一个 effect）⇒ 这里真注销；
                // 声明塌缩时整对一起退，别留「行在、main 没了」的半对（坑册坑 54）。
                applyMountSlots()
            }
        })
    }

    // 问 host 放最后：两条槽位先按「开」装好，读回来是 false 再一起摘（读到之前不闪空）。
    void resolveMountPreference()
}
