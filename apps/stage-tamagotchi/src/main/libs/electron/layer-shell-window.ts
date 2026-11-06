import type { LayerShellGeometry, LayerShellManager, LayerShellWindowOptions } from '@proj-airi/electron-wayland-layer-shell'
import type { BrowserWindow, Display, Rectangle } from 'electron'

import { useLogg } from '@guiiai/logg'
import { decorateWindowTitle } from '@proj-airi/electron-wayland-layer-shell'
import { screen } from 'electron'

const log = useLogg('layer-shell-window').useGlobalConfig()

/**
 * 一个窗口的层表面视角。
 *
 * 层表面没有窗管帮忙摆位置：位置是 margin、尺寸是 set_size，两者都由应用给。
 * 所以层表面模式下窗口几何必须经过这里，不能只调 `window.setBounds`（Wayland 上移动 toplevel 本来就不生效）。
 */
/** 按窗口的 webContents id 找它的层表面绑定，IPC 那头只有一个 `BrowserWindow`。 */
const bindings = new Map<number, LayerShellWindowBinding>()

export function layerShellBindingFor(window: BrowserWindow): LayerShellWindowBinding | undefined {
  return bindings.get(window.webContents.id)
}

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
  /**
   * 只有这些矩形接收指针，其余地方穿透到下面的应用。传 `null` 恢复整个窗口。
   *
   * Electron 的 `setIgnoreMouseEvents` 在 Wayland 上没有实现，所以走代理的 `set_input_region`。
   */
  setInputRegion: (rects: { x: number, y: number, width: number, height: number }[] | null) => void
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

/** 几何整个落在屏幕里就照旧，否则保持尺寸挪到屏幕中间。 */
function projectOntoDisplay(display: Display, bounds: Rectangle): Rectangle {
  const inside = bounds.x >= display.bounds.x
    && bounds.y >= display.bounds.y
    && bounds.x + bounds.width <= display.bounds.x + display.bounds.width
    && bounds.y + bounds.height <= display.bounds.y + display.bounds.height
  if (inside)
    return bounds

  return {
    x: Math.round(display.bounds.x + (display.bounds.width - bounds.width) / 2),
    y: Math.round(display.bounds.y + (display.bounds.height - bounds.height) / 2),
    width: bounds.width,
    height: bounds.height,
  }
}

/** 边的位值和代理那边一致。 */
const EDGE = { top: 1, bottom: 2, left: 4, right: 8 } as const

function spansOver(a: Display, b: Display, axis: 'x' | 'y'): boolean {
  const start = axis === 'x' ? 'x' : 'y'
  const size = axis === 'x' ? 'width' : 'height'
  return a.bounds[start] < b.bounds[start] + b.bounds[size] && b.bounds[start] < a.bounds[start] + a.bounds[size]
}

/** 接在 `from` 这条边外头的那块屏。 */
function displayAcrossEdge(from: Display, edges: number): Display | undefined {
  const others = screen.getAllDisplays().filter(display => display.id !== from.id)
  const right = from.bounds.x + from.bounds.width
  const bottom = from.bounds.y + from.bounds.height

  if (edges & EDGE.right)
    return others.find(display => display.bounds.x === right && spansOver(display, from, 'y'))
  if (edges & EDGE.left)
    return others.find(display => display.bounds.x + display.bounds.width === from.bounds.x && spansOver(display, from, 'y'))
  if (edges & EDGE.bottom)
    return others.find(display => display.bounds.y === bottom && spansOver(display, from, 'x'))
  if (edges & EDGE.top)
    return others.find(display => display.bounds.y + display.bounds.height === from.bounds.y && spansOver(display, from, 'x'))

  return undefined
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
    setInputRegion() {},
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
  /**
   * 层表面窗口只能待在指定的屏幕上：层表面的输出在创建时固定，之后换不了。
   * 传了就按它算，几何落在它外面时挪到它中间。
   */
  display?: Display
}): Promise<LayerShellWindowBinding> {
  const { manager } = params
  if (!manager)
    return createPlainBinding(params.title)

  const display = params.display ?? screen.getDisplayMatching(params.bounds)
  const bounds = projectOntoDisplay(display, params.bounds)
  const options: LayerShellWindowOptions = {
    ...params.options,
    output: params.options.output ?? display.label,
    // 屏幕多大只有应用量得准：分数缩放下 `wl_output` 的 mode/scale 算不出真实逻辑尺寸，
    // 而拖动要靠它保证整个窗口留在屏幕里。
    outputSize: params.options.outputSize ?? { width: display.bounds.width, height: display.bounds.height },
  }

  const attached = await manager.attach(params.windowId, options, toGeometry(display, bounds))
  if (!attached)
    return createPlainBinding(params.title)

  let window: BrowserWindow | undefined
  let current: LayerShellGeometry = toGeometry(display, bounds)
  // 先按「会变成层表面」处理；合成器拒绝后由事件推翻，并把最后一次几何写回普通窗口。
  let layer = true
  const listeners = new Set<(bounds: Rectangle) => void>()

  const notify = (bounds: Rectangle) => {
    for (const listener of listeners)
      listener(bounds)
  }

  /**
   * 用户把窗口顶到屏幕边上还继续推。
   *
   * 层表面的输出在创建时就固定，协议里没有换输出的请求，所以只能把这个窗口整个重建到那块屏上，
   * 也就是重开窗口、重新加载页面。这一步只有应用能做，而且要做对（关旧的、按新输出重新 attach、
   * 再建新的），现在还没做，先留日志。
   */
  function reportPushed(edges: number) {
    const from = screen.getDisplayMatching(toBounds(display, current))
    const target = displayAcrossEdge(from, edges)
    log.log(target
      ? `${params.windowId} was pushed against ${from.label}: moving it needs a new window on ${target.label}`
      : `${params.windowId} was pushed against the edge of ${from.label}, and nothing is beyond it`)
  }

  const stopListening = manager.onEvent((event) => {
    // 整个会话都不可用的事件没有窗口 id，交给调用方在日志里看。
    if (event.type === 'unavailable' || event.windowId !== params.windowId)
      return

    if (event.type === 'pushed') {
      reportPushed(event.edges)
      return
    }

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

  const binding: LayerShellWindowBinding = {
    title: decorateWindowTitle(params.windowId, params.title),
    get active() {
      return layer
    },
    bindWindow(value) {
      window = value
      bindings.set(value.webContents.id, binding)
      value.once('closed', () => bindings.delete(value.webContents.id))
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
    setInputRegion(rects) {
      if (!layer)
        return
      void manager.setInputRegion(params.windowId, rects)
    },
    dispose() {
      stopListening()
      listeners.clear()
      void manager.detach(params.windowId)
    },
  }

  return binding
}
