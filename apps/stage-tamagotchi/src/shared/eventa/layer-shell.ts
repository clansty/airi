import { defineInvokeEventa } from '@moeru/eventa'

/** 一块可以放层表面窗口的屏幕。`label` 是 Electron 的屏幕名，也是设置里存的值。 */
export interface LayerShellDisplayOption {
  label: string
  width: number
  height: number
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

/**
 * 这个窗口只在这些矩形里接收指针，其余地方穿透到下面的应用。空数组就是整窗穿透。
 *
 * 坐标是渲染进程的视图坐标；Electron 的 `setIgnoreMouseEvents` 在 Wayland 上没有实现，所以走代理。
 */
export const electronLayerShellInputRegion = defineInvokeEventa<void, { rects: { x: number, y: number, width: number, height: number }[] }>('eventa:invoke:electron:layer-shell:input-region')

/** 重启应用。层表面的输出在窗口创建时就固定，换屏幕只能重开。 */
export const electronAppRelaunch = defineInvokeEventa<void>('eventa:invoke:electron:app:relaunch')

/** 换一块屏幕。窗口下次创建时生效：层表面的输出在创建时就固定了。 */
export const electronLayerShellDisplaySet = defineInvokeEventa<LayerShellDisplayState, { label: string | undefined }>('eventa:invoke:electron:layer-shell:display:set')
