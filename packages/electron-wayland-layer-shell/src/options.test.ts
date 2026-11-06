import { describe, expect, it } from 'vitest'

import { decideLayerShell, normalizeGeometry, normalizeWindowOptions } from './options'

describe('decideLayerShell', () => {
  it('follows the compositor list by default', () => {
    expect(decideLayerShell({ desktopName: 'niri', choice: undefined }).use).toBe(true)
    expect(decideLayerShell({ desktopName: 'sway', choice: undefined }).use).toBe(true)
    expect(decideLayerShell({ desktopName: 'KDE:Plasma', choice: undefined }).use).toBe(false)
  })

  it('lets the environment settle it both ways', () => {
    expect(decideLayerShell({ desktopName: 'KDE', choice: '1' }).use).toBe(true)
    expect(decideLayerShell({ desktopName: 'niri', choice: '0' }).use).toBe(false)
  })

  it('treats an unknown session as off', () => {
    expect(decideLayerShell({ desktopName: undefined, choice: undefined }).use).toBe(false)
  })
})

describe('normalizeWindowOptions', () => {
  it('fills the defaults', () => {
    expect(normalizeWindowOptions({ namespace: 'airi-pet' })).toEqual({
      namespace: 'airi-pet',
      layer: 'overlay',
      keyboard: 'none',
      output: undefined,
    })
  })

  it('refuses a namespace the compositor would reject', () => {
    expect(() => normalizeWindowOptions({ namespace: 'AIRI pet' })).toThrow()
  })
})

describe('normalizeGeometry', () => {
  it('never asks for a zero size', () => {
    expect(normalizeGeometry({ x: 10.4, y: -2.6, width: 0, height: -5 })).toEqual({
      x: 10,
      y: -3,
      width: 1,
      height: 1,
    })
  })
})
