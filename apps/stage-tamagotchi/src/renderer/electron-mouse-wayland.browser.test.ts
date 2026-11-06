import { defineInvokeHandler } from '@moeru/eventa'
import { electron, startLoopGetBounds } from '@proj-airi/electron-eventa'
import { useElectronMouse } from '@proj-airi/electron-vueuse'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { effectScope } from 'vue'

import { connectMain } from '../test/eventa-main-renderer-ipc'

describe('useElectronMouse on Wayland', () => {
  it('reads the position from pointer events, because the main process cannot see the cursor', async () => {
    const main = connectMain()
    let probed = false
    defineInvokeHandler(main, electron.app.isWayland, () => {
      probed = true
      return true
    })
    // The window stays at the origin, so the position on screen equals the position in the window.
    defineInvokeHandler(main, startLoopGetBounds, () => {})

    const scope = effectScope()
    onTestFinished(() => scope.stop())
    const mouse = scope.run(() => useElectronMouse())!

    // The listener follows the probe, and a pointer that moves before it exists is lost.
    await vi.waitFor(() => expect(probed).toBe(true))

    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 30, clientY: 40 }))
    // One position per frame, as the main process loop sent one per frame.
    await vi.waitFor(() => expect(mouse.x.value).toBe(30))
    expect(mouse.y.value).toBe(40)
  })
})
