import { describe, expect, it } from 'vitest'

import { inputRegionRectsOf, paintedBoundsOf } from './use-stage-input-region'

/** 一个 rows × columns 的采样网格，`painted` 里的格子按 alpha 255 填充。 */
function grid(columns: number, rows: number, painted: [column: number, row: number][] = []) {
  const alpha = new Uint8ClampedArray(columns * rows)
  for (const [column, row] of painted)
    alpha[row * columns + column] = 255
  return alpha
}

describe('paintedBoundsOf', () => {
  it('bounds what the renderer painted', () => {
    const alpha = grid(4, 3, [[1, 0], [2, 0], [1, 2]])

    expect(paintedBoundsOf(alpha, 4, 3)).toEqual({ column: 1, row: 0, columns: 2, rows: 3 })
  })

  it('reports nothing when the canvas reads back empty', () => {
    expect(paintedBoundsOf(grid(4, 3), 4, 3)).toBeUndefined()
  })

  // 角色边缘会淡到接近透明，那是轮廓以外的像素。
  it('ignores the soft edge under the alpha floor', () => {
    const alpha = grid(4, 3, [[0, 0]])
    alpha[2] = 4

    expect(paintedBoundsOf(alpha, 4, 3, 8)).toEqual({ column: 0, row: 0, columns: 1, rows: 1 })
  })
})

describe('inputRegionRectsOf', () => {
  // 一个格子盖十个像素，取格子的外边沿才能把画出来的内容整个包进去。
  const source = { left: 10, top: 20, width: 120, height: 240 }

  it('turns the grid bounds into window pixels', () => {
    const rects = inputRegionRectsOf({
      bounds: { column: 2, row: 3, columns: 4, rows: 5 },
      columns: 12,
      rows: 24,
      source,
      overlays: [],
    })

    expect(rects).toEqual([{ x: 30, y: 50, width: 40, height: 50 }])
  })

  it('keeps the overlays, which take the pointer on their own', () => {
    const rects = inputRegionRectsOf({
      bounds: { column: 0, row: 0, columns: 1, rows: 1 },
      columns: 12,
      rows: 24,
      source,
      overlays: [{ x: 5.4, y: 6.6, width: 20.2, height: 10.1 }],
    })

    expect(rects).toEqual([
      { x: 10, y: 20, width: 10, height: 10 },
      { x: 5, y: 6, width: 21, height: 11 },
    ])
  })

  it('reports the overlays alone when the character paints nothing', () => {
    const rects = inputRegionRectsOf({
      columns: 12,
      rows: 24,
      source,
      overlays: [{ x: 0, y: 0, width: 10, height: 10 }],
    })

    expect(rects).toEqual([{ x: 0, y: 0, width: 10, height: 10 }])
  })
})
