import type { createContext } from '@moeru/eventa/adapters/electron/main'
import type { BrowserWindow } from 'electron'

import type { LayerShellDisplayState } from '../../../shared/eventa'

import { env } from 'node:process'

import { defineInvokeHandler } from '@moeru/eventa'
import { app } from 'electron'

import { electronAppRelaunch, electronLayerShellDisplayGet, electronLayerShellDisplaySet, electronLayerShellInputRegion } from '../../../shared/eventa'
import { listDisplays, readAppConfig, resolveLayerShellDisplay, setLayerShellDisplay } from '../../libs/electron/app-config'
import { layerShellBindingFor } from '../../libs/electron/layer-shell-window'

/** 这个会话的窗口会不会变成层表面：启动器只在 Linux + Wayland + 合成器跟手时才拉起代理。 */
function layerShellActive(): boolean {
  return Boolean(env.AIRI_LAYER_SHELL_CONTROL)
}

function currentState(): LayerShellDisplayState {
  const displays = listDisplays()
  const stored = readAppConfig().layerShellDisplay
  return {
    active: layerShellActive(),
    displays,
    // 下拉菜单总要有个值：没选过就报当下真正会用的那块屏。
    selected: stored && displays.some(display => display.label === stored)
      ? stored
      : resolveLayerShellDisplay().label,
  }
}

/**
 * 设置里「显示在哪块屏幕」的读写。
 *
 * 层表面窗口的输出在创建时就固定，所以改了之后下次开窗口才生效；这里只负责存下来。
 */
export function createLayerShellDisplayService(params: {
  context: ReturnType<typeof createContext>['context']
  window: BrowserWindow
}) {
  defineInvokeHandler(params.context, electronLayerShellDisplayGet, () => currentState())
  defineInvokeHandler(params.context, electronLayerShellDisplaySet, (payload) => {
    setLayerShellDisplay(payload?.label || undefined)
    return currentState()
  })

  // 层表面的输出在窗口创建时就固定，换屏幕只能在重开之后生效。
  defineInvokeHandler(params.context, electronAppRelaunch, () => {
    app.relaunch()
    app.quit()
  })

  // 页面说哪些地方要接收鼠标，其余地方穿透。只有这个窗口自己是层表面时才有效。
  defineInvokeHandler(params.context, electronLayerShellInputRegion, (payload) => {
    layerShellBindingFor(params.window)?.setInputRegion(payload?.rects ?? null)
  })
}
