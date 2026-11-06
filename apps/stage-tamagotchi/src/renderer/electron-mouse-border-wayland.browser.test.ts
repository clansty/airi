import { defineInvokeHandler } from '@moeru/eventa'
import { bounds, electron, startLoopGetBounds } from '@proj-airi/electron-eventa'
import { useElectronMouseAroundWindowBorder } from '@proj-airi/electron-vueuse'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { effectScope } from 'vue'

import { connectMain } from '../test/eventa-main-renderer-ipc'

describe('useElectronMouseAroundWindowBorder on Wayland', () => {
  it('reports no edge once the pointer leaves, because its position stays where it left', async () => {
    // ROOT CAUSE:
    //
    // Wayland hands out no cursor position outside the window's own surfaces,
    // so the last one stays. A border that reads it stays on, and the window
    // flashes its resize edges forever.
    const main = connectMain()
    let probed = false
    defineInvokeHandler(main, electron.app.isWayland, () => {
      probed = true
      return true
    })
    defineInvokeHandler(main, startLoopGetBounds, () => {})

    const scope = effectScope()
    onTestFinished(() => scope.stop())
    const border = scope.run(() => useElectronMouseAroundWindowBorder({ threshold: 10 }))!
    // The listener follows the probe, and a pointer that moves before it exists is lost.
    await vi.waitFor(() => expect(probed).toBe(true))

    main.emit(bounds, { x: 0, y: 0, width: 400, height: 300 })
    await vi.waitFor(() => expect(border.width.value).toBe(400))

    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 3, clientY: 150 }))
    await vi.waitFor(() => expect(border.nearLeft.value).toBe(true))

    window.dispatchEvent(new PointerEvent('pointerout', { relatedTarget: null }))
    await vi.waitFor(() => expect(border.nearLeft.value).toBe(false))
  })
})
