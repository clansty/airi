import { defineInvokeHandler } from '@moeru/eventa'
import { cursorScreenPoint, electron, startLoopGetCursorScreenPoint } from '@proj-airi/electron-eventa'
import { useElectronMouse } from '@proj-airi/electron-vueuse'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { effectScope } from 'vue'

import { connectMain } from '../test/eventa-main-renderer-ipc'

describe('useElectronMouse', () => {
  it('gives a consumer that mounts while the cursor stays still the last position', async () => {
    const main = connectMain()
    defineInvokeHandler(main, electron.app.isWayland, () => false)
    defineInvokeHandler(main, startLoopGetCursorScreenPoint, () => {})
    const scope = effectScope()
    onTestFinished(() => scope.stop())
    const first = scope.run(() => useElectronMouse())!

    // The main process sends a position only when it changes, so no message follows while the cursor stays still.
    main.emit(cursorScreenPoint, { x: 10, y: 20 })
    await vi.waitFor(() => expect(first.x.value).toBe(10))

    const late = scope.run(() => useElectronMouse())!
    expect(late.x.value).toBe(10)
    expect(late.y.value).toBe(20)
  })
})
