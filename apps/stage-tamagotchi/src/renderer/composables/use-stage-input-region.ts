import { onScopeDispose } from 'vue'

import { paintedOverlaySelector } from './use-stage-painted-mask'

/**
 * 层表面模式下，窗口接收指针的范围。
 *
 * Wayland 上 `setIgnoreMouseEvents` 没有实现（Linux 也没有 `forward`），穿透只能靠 `wl_surface.set_input_region`：
 * 报出去的矩形接收指针，其余地方直接落到底下的应用。所以这里做的是「只让真正画了东西的地方吃点击」。
 */

/** 采样网格的粒度：窗口横竖各缩小这么多倍。 */
const sampleDivisor = 12
/** alpha 高于这个值才算画了东西，把角色边缘的淡出排除在外。 */
const paintedAlphaFloor = 8
const defaultIntervalMs = 400
/**
 * 窗口四边留给缩放的一圈宽度。
 *
 * Chromium 的边缘命中测试要用指针事件的坐标，一圈都不给的话窗口就再也缩放不了，
 * 靠边显示的那圈缩放边框也不会亮。10 和 `usePointerNearWindowBorder` 的阈值一致。
 */
const resizeBandPx = 10

export interface InputRegionRect {
  x: number
  y: number
  width: number
  height: number
}

export interface PaintedBounds {
  column: number
  row: number
  columns: number
  rows: number
}

/** 在采样网格里找画了东西的外接矩形，一个像素都没画时返回 `undefined`。 */
export function paintedBoundsOf(
  alpha: ArrayLike<number>,
  columns: number,
  rows: number,
  alphaFloor = paintedAlphaFloor,
): PaintedBounds | undefined {
  let minColumn = columns
  let minRow = rows
  let maxColumn = -1
  let maxRow = -1

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if (alpha[row * columns + column] <= alphaFloor)
        continue

      if (column < minColumn)
        minColumn = column
      if (column > maxColumn)
        maxColumn = column
      if (row < minRow)
        minRow = row
      if (row > maxRow)
        maxRow = row
    }
  }

  if (maxColumn < 0)
    return undefined

  return {
    column: minColumn,
    row: minRow,
    columns: maxColumn - minColumn + 1,
    rows: maxRow - minRow + 1,
  }
}

/**
 * 把网格里的外接矩形换算成窗口坐标，并且按网格粒度往外取整。
 *
 * 一个网格格子覆盖好几个像素，取格子的外边沿才能保证画出来的内容整个落在矩形里。
 */
export function inputRegionRectsOf(params: {
  bounds?: PaintedBounds
  /** 采样网格对应的元素在窗口里的位置，CSS 像素。 */
  source: { left: number, top: number, width: number, height: number }
  columns: number
  rows: number
  /** 除角色以外还要接收指针的矩形，比如控制岛上的按钮。 */
  overlays: InputRegionRect[]
}): InputRegionRect[] {
  const { bounds, source, columns, rows, overlays } = params
  const rects = overlays.map(rect => ({
    x: Math.floor(rect.x),
    y: Math.floor(rect.y),
    width: Math.max(1, Math.ceil(rect.width)),
    height: Math.max(1, Math.ceil(rect.height)),
  }))

  if (bounds) {
    const cellWidth = source.width / columns
    const cellHeight = source.height / rows
    const left = Math.floor(source.left + bounds.column * cellWidth)
    const top = Math.floor(source.top + bounds.row * cellHeight)
    const right = Math.ceil(source.left + (bounds.column + bounds.columns) * cellWidth)
    const bottom = Math.ceil(source.top + (bounds.row + bounds.rows) * cellHeight)
    rects.unshift({ x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) })
  }

  return rects
}

/**
 * 窗口四边那一圈，用于缩放。
 *
 * 窗口比两圈还窄时整窗都给，否则这个窗口没有能缩放的边。
 */
export function resizeBandRectsOf(width: number, height: number, band = resizeBandPx): InputRegionRect[] {
  if (width <= band * 2 || height <= band * 2)
    return [{ x: 0, y: 0, width, height }]

  return [
    { x: 0, y: 0, width, height: band },
    { x: 0, y: height - band, width, height: band },
    { x: 0, y: band, width: band, height: height - band * 2 },
    { x: width - band, y: band, width: band, height: height - band * 2 },
  ]
}

/**
 * 页面上另外画了东西、自己要接收指针的元素：控制岛、弹层、对话框。
 *
 * 这些是 DOM，自带矩形，不用读画布。
 */
export function paintedOverlayRects(): InputRegionRect[] {
  const rects: InputRegionRect[] = []

  for (const element of document.querySelectorAll(paintedOverlaySelector)) {
    if (!(element instanceof HTMLElement))
      continue

    // 不能用 offsetParent 判断可见性：`position: fixed` 的元素 offsetParent 永远是 null，而控制岛就是 fixed。
    // `v-show` 收起的东西是 display: none，没有 client rect。
    if (element.getClientRects().length === 0)
      continue

    const bounds = element.getBoundingClientRect()
    if (bounds.width === 0 || bounds.height === 0)
      continue

    rects.push({ x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height })
  }

  return rects
}

/**
 * 每帧都算，只有变了才上报。
 *
 * 读画布是这整件事里唯一有成本的一步，所以采样比事件慢得多：角色的轮廓本来就变得很慢。
 */
export function useStageInputRegion(options: {
  /** 只在层表面模式下有意义，普通窗口走 `setIgnoreMouseEvents` 那一套。 */
  enabled: () => boolean
  /** 设置、全屏这些盖住整个窗口的东西打开时，整个窗口都要能点。 */
  suspended: () => boolean
  canvas: () => HTMLCanvasElement | undefined
  apply: (rects: InputRegionRect[] | null) => void
  intervalMs?: number
}) {
  const surface = document.createElement('canvas')
  const context = surface.getContext('2d', { willReadFrequently: true })
  let sent: InputRegionRect[] | null | undefined

  function publish(rects: InputRegionRect[] | null) {
    if (sameRects(sent, rects))
      return

    sent = rects
    options.apply(rects)
  }

  function sample() {
    if (!options.enabled()) {
      // 关掉时把窗口还原成整个都能点，别把上一次的区域留着。
      publish(null)
      return
    }

    if (options.suspended()) {
      publish(null)
      return
    }

    const stageCanvas = options.canvas()
    if (!context || !stageCanvas) {
      publish(null)
      return
    }

    const source = stageCanvas.getBoundingClientRect()
    if (source.width < 1 || source.height < 1) {
      publish(null)
      return
    }

    const columns = Math.max(8, Math.round(source.width / sampleDivisor))
    const rows = Math.max(8, Math.round(source.height / sampleDivisor))
    if (surface.width !== columns || surface.height !== rows) {
      surface.width = columns
      surface.height = rows
    }

    context.clearRect(0, 0, columns, rows)
    context.drawImage(stageCanvas, 0, 0, columns, rows)

    const painted = context.getImageData(0, 0, columns, rows).data
    const alpha = new Uint8ClampedArray(columns * rows)
    for (let index = 0; index < alpha.length; index += 1)
      alpha[index] = painted[index * 4 + 3]

    const bounds = paintedBoundsOf(alpha, columns, rows)
    // NOTICE:
    // 画布读回空白有两种情况：真的没画东西，和 VRM（TresCanvas 关着 preserveDrawingBuffer）。分不出来，
    // 而把角色排除在输入区域外会让它再也点不到，所以空白一律当「整个窗口都能点」。
    // 只有 VRM 需要这个退化，Live2D 和其它渲染器都能读回自己上一帧。
    // Removal: VRM 也能给出角色的屏幕范围时（比如场景暴露外接矩形）。
    if (!bounds) {
      publish(null)
      return
    }

    publish(inputRegionRectsOf({
      bounds,
      source,
      columns,
      rows,
      overlays: [...resizeBandRectsOf(window.innerWidth, window.innerHeight), ...paintedOverlayRects()],
    }))
  }

  // 画布要在这个帧被合成之前读，否则读到的是上一帧或者空的。
  function sampleOnNextFrame() {
    requestAnimationFrame(() => sample())
  }

  sampleOnNextFrame()
  const timer = setInterval(sampleOnNextFrame, options.intervalMs ?? defaultIntervalMs)

  onScopeDispose(() => {
    clearInterval(timer)
    // 页面走了就还原，否则关掉的窗口会留着上一条输入区域。
    if (sent !== undefined)
      options.apply(null)
  })
}

function sameRects(a: InputRegionRect[] | null | undefined, b: InputRegionRect[] | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined)
    return a === b

  if (a.length !== b.length)
    return false

  return a.every((rect, index) => {
    const other = b[index]
    return Math.abs(rect.x - other.x) <= 1
      && Math.abs(rect.y - other.y) <= 1
      && Math.abs(rect.width - other.width) <= 1
      && Math.abs(rect.height - other.height) <= 1
  })
}
