import type { createContext } from '@moeru/eventa/adapters/electron/main'

import type { LayerShellDisplayState } from '../../../shared/eventa'

import { env } from 'node:process'

import { defineInvokeHandler } from '@moeru/eventa'

import { electronLayerShellDisplayGet, electronLayerShellDisplaySet } from '../../../shared/eventa'
import { listDisplays, readAppConfig, setLayerShellDisplay } from '../../libs/electron/app-config'

/** 这个会话的窗口会不会变成层表面：启动器只在 Linux + Wayland + 合成器跟手时才拉起代理。 */
function layerShellActive(): boolean {
  return Boolean(env.AIRI_LAYER_SHELL_CONTROL)
}

function currentState(): LayerShellDisplayState {
  return {
    active: layerShellActive(),
    displays: listDisplays(),
    selected: readAppConfig().layerShellDisplay,
  }
}

/**
 * 设置里「显示在哪块屏幕」的读写。
 *
 * 层表面窗口的输出在创建时就固定，所以改了之后下次开窗口才生效；这里只负责存下来。
 */
export function createLayerShellDisplayService(params: { context: ReturnType<typeof createContext>['context'] }) {
  defineInvokeHandler(params.context, electronLayerShellDisplayGet, () => currentState())
  defineInvokeHandler(params.context, electronLayerShellDisplaySet, (payload) => {
    setLayerShellDisplay(payload?.label || undefined)
    return currentState()
  })
}
