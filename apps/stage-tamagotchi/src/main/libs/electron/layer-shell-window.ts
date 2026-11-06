import type { LayerShellGeometry, LayerShellManager, LayerShellWindowOptions } from '@proj-airi/electron-wayland-layer-shell'
import type { BrowserWindow, Display, Rectangle } from 'electron'

import { decorateWindowTitle } from '@proj-airi/electron-wayland-layer-shell'
import { screen } from 'electron'

/**
 * 一个窗口的层表面视角。
 *
 * 层表面没有窗管帮忙摆位置：位置是 margin、尺寸是 set_size，两者都由应用给。
 * 所以层表面模式下窗口几何必须经过这里，不能只调 `window.setBounds`（Wayland 上移动 toplevel 本来就不生效）。
 */
export interface LayerShellWindowBinding {
  /** 建窗口时用的标题。没有层表面时就是原标题。 */
  title: string
  /** 这个窗口当前是不是层表面。合成器拒绝时会变回 `false`，之后就照普通窗口处理。 */
  readonly active: boolean
  /** 绑定 Electron 窗口，之后 `setBounds`、拖动回调和退化才生效。 */
  bindWindow: (window: BrowserWindow) => void
  /** 应用改几何：层表面走代理，其它情况走 `window.setBounds`。 */
  setBounds: (bounds: Rectangle) => void
  /** 当前几何（全局坐标）。用户拖动过之后这里是最新的。 */
  getBounds: () => Rectangle | undefined
  /** 用户拖动结束、或者窗口退化成普通窗口时回调，参数是全局坐标。 */
  onBoundsChanged: (listener: (bounds: Rectangle) => void) => () => void
  dispose: () => void
}

function toGeometry(display: Display, bounds: Rectangle): LayerShellGeometry {
  return {
    // margin 相对窗口所在输出的左上角，Electron 的 bounds 是全局坐标。
    x: bounds.x - display.bounds.x,
    y: bounds.y - display.bounds.y,
    width: bounds.width,
    height: bounds.height,
  }
}

function toBounds(display: Display, geometry: LayerShellGeometry): Rectangle {
  return {
    x: display.bounds.x + geometry.x,
    y: display.bounds.y + geometry.y,
    width: geometry.width,
    height: geometry.height,
  }
}

/** 没有层表面时的退化实现：一切交给 Electron。 */
function createPlainBinding(title: string): LayerShellWindowBinding {
  let window: BrowserWindow | undefined
  return {
    title,
    active: false,
    bindWindow(value) {
      window = value
    },
    setBounds(bounds) {
      if (window && !window.isDestroyed())
        window.setBounds(bounds)
    },
    getBounds: () => (window && !window.isDestroyed() ? window.getBounds() : undefined),
    onBoundsChanged: () => () => {},
    dispose() {},
  }
}

export async function prepareLayerShellWindow(params: {
  manager: LayerShellManager | undefined
  windowId: string
  title: string
  options: LayerShellWindowOptions
  /** 窗口将要出现的几何，全局坐标。 */
  bounds: Rectangle
}): Promise<LayerShellWindowBinding> {
  const { manager } = params
  if (!manager)
    return createPlainBinding(params.title)

  const display = screen.getDisplayMatching(params.bounds)
  const options: LayerShellWindowOptions = { ...params.options, output: params.options.output ?? display.label }

  const attached = await manager.attach(params.windowId, options, toGeometry(display, params.bounds))
  if (!attached)
    return createPlainBinding(params.title)

  let window: BrowserWindow | undefined
  let current: LayerShellGeometry = toGeometry(display, params.bounds)
  // 先按「会变成层表面」处理；合成器拒绝后由事件推翻，并把最后一次几何写回普通窗口。
  let layer = true
  const listeners = new Set<(bounds: Rectangle) => void>()

  const notify = (bounds: Rectangle) => {
    for (const listener of listeners)
      listener(bounds)
  }

  const stopListening = manager.onEvent((event) => {
    // 整个会话都不可用的事件没有窗口 id，交给调用方在日志里看。
    if (event.type === 'unavailable' || event.windowId !== params.windowId)
      return

    if (event.type === 'refused') {
      // 这个 surface 的 role 已经定了，只能重建窗口才能再试一次。
      layer = false
      if (window && !window.isDestroyed())
        window.setBounds(toBounds(display, current))
      notify(toBounds(display, current))
      return
    }

    if (event.type !== 'geometry')
      return

    current = event.geometry
    notify(toBounds(display, current))
  })

  return {
    title: decorateWindowTitle(params.windowId, params.title),
    get active() {
      return layer
    },
    bindWindow(value) {
      window = value
    },
    setBounds(bounds) {
      const geometry = toGeometry(display, bounds)
      if (window && !window.isDestroyed())
        window.setBounds(bounds)

      if (!layer)
        return

      current = geometry
      // 缓冲区大小只能由 Chromium 自己改，位置在 Wayland 上本来就不生效；两样都要写，层表面才和内容对齐。
      void manager.setGeometry(params.windowId, geometry)
    },
    getBounds: () => (layer ? toBounds(display, current) : window && !window.isDestroyed() ? window.getBounds() : undefined),
    onBoundsChanged: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      stopListening()
      listeners.clear()
      void manager.detach(params.windowId)
    },
  }
}
