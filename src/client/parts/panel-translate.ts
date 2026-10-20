/**
 * 翻译上下文：壳把平台注入的 `t` 经 props 传下来，这里分发给面板的每个组件。
 *
 * @module dsh-agent-studio/client-parts/panel-translate
 */
import * as React from 'react'
import type { Translate } from '../locales'
import { translateZh } from '../locales'

/**
 * 翻译上下文：壳把平台注入的 `t` 经 props 传进来，这里往下发给每个组件。
 *
 * 面板部件是运行时从 host 加载的，**拿不到 cordis ctx**（seed 表里只有 react /
 * primitives 这类基础模块），所以 `t` 只能靠传；默认值是中文兜底——旧壳 + 新部件
 * （用户还没重启）时面板依旧完整可用，只是没有英文。
 */
export const TranslateContext = React.createContext<Translate>(translateZh)

/** 取当前翻译器。 */
export function useT(): Translate {
    return React.useContext(TranslateContext)
}
