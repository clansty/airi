import { afterEach, describe, expect, it } from 'vitest'

import { paintedOverlayRects } from './use-stage-input-region'
import { stageOpaqueAttribute } from './use-stage-painted-mask'

const mounted: HTMLElement[] = []

afterEach(() => {
  mounted.splice(0).forEach(element => element.remove())
})

function mountOverlay(styles: Partial<CSSStyleDeclaration>, attribute = stageOpaqueAttribute) {
  const element = document.createElement('div')
  element.setAttribute(attribute, attribute === stageOpaqueAttribute ? 'true' : '')
  Object.assign(element.style, styles)
  document.body.append(element)
  mounted.push(element)
  return element
}

describe('paintedOverlayRects', () => {
  // 控制岛是 position: fixed，它的 offsetParent 永远是 null，按 offsetParent 判断可见性就会把它整个丢掉。
  it('takes a fixed overlay, which reports no offset parent', () => {
    const island = mountOverlay({ position: 'fixed', left: '10px', top: '20px', width: '40px', height: '30px' })
    expect(island.offsetParent).toBeNull()

    expect(paintedOverlayRects()).toContainEqual({ x: 10, y: 20, width: 40, height: 30 })
  })

  // `v-show` 收起的东西不画，也不该留着吃点击。
  it('leaves out an overlay that paints nothing', () => {
    mountOverlay({ position: 'fixed', left: '0px', top: '0px', width: '40px', height: '30px', display: 'none' })

    expect(paintedOverlayRects()).not.toContainEqual({ x: 0, y: 0, width: 40, height: 30 })
  })

  // 弹层被 portal 到 body，标记够不着，按 reka-ui 盖的那个属性认。
  it('takes portaled floating content', () => {
    mountOverlay({ position: 'fixed', left: '60px', top: '70px', width: '20px', height: '10px' }, 'data-reka-popper-content-wrapper')

    expect(paintedOverlayRects()).toContainEqual({ x: 60, y: 70, width: 20, height: 10 })
  })
})
