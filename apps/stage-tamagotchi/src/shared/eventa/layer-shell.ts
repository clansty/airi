import { defineInvokeEventa } from '@moeru/eventa'

/** 一块可以放层表面窗口的屏幕。`label` 是 Electron 的屏幕名，也是设置里存的值。 */
export interface LayerShellDisplayOption {
  label: string
  width: number
  height: number
  primary: boolean
}

/**
 * 层表面窗口的位置设置。
 *
 * `active` 为 false 时窗口是普通窗口，选屏幕没有意义，设置里也不该显示这一项。
 */
export interface LayerShellDisplayState {
  active: boolean
  displays: LayerShellDisplayOption[]
  /** 用户选的屏幕名；没有选就是窗口自己保存的位置说了算。 */
  selected?: string
}

export const electronLayerShellDisplayGet = defineInvokeEventa<LayerShellDisplayState>('eventa:invoke:electron:layer-shell:display:get')

/** 换一块屏幕。窗口下次创建时生效：层表面的输出在创建时就固定了。 */
export const electronLayerShellDisplaySet = defineInvokeEventa<LayerShellDisplayState, { label: string | undefined }>('eventa:invoke:electron:layer-shell:display:set')
