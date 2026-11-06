import type { LayerShellManager } from '@proj-airi/electron-wayland-layer-shell'

import { env } from 'node:process'

import { LayerShellManager as Manager } from '@proj-airi/electron-wayland-layer-shell'

/**
 * 连上启动器拉起的层表面代理。
 *
 * 启动器只有在「Linux + Wayland + 合成器跟手 + 用户没关掉」时才会拉起代理并重新启动自己，
 * 所以这里只看环境变量：没有控制通道就说明这个会话不该用层表面，返回 `undefined` 让窗口照旧。
 */
export async function setupLayerShellManager(): Promise<LayerShellManager | undefined> {
  const controlSocket = env.AIRI_LAYER_SHELL_CONTROL
  if (!controlSocket)
    return undefined

  return Manager.connect(controlSocket)
}
