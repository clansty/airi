import type { Position, UseMouseOptions } from '@vueuse/core'

import { defineInvoke } from '@moeru/eventa'
import { cursorScreenPoint, electron, startLoopGetCursorScreenPoint } from '@proj-airi/electron-eventa'
import { useEventListener, useMouse } from '@vueuse/core'
import { ref } from 'vue'

import { getElectronEventaContext } from './use-electron-eventa-context'
import { useElectronWindowBounds } from './use-electron-window-bounds'

type EventaContext = ReturnType<typeof getElectronEventaContext>

let sharedEventTarget: EventTarget | undefined
// The main process sends a position only when it changes. A consumer that mounts while the cursor stays still starts
// from this position, because no later message brings it one.
let lastPosition: Position | undefined
let startedTracking = false
/**
 * 光标位置还作不作数。
 *
 * Wayland 下窗口外读不到任何坐标，位置会停在最后落在窗口里的那一点。拿这个位置算「指针贴着哪个边」会一直
 * 算中，窗口的边框就一直闪。别的平台的位置是全局轮询来的，指针在哪都作数。
 */
const cursorPositionLive = ref(false)

function publishPosition(position: Position | undefined) {
  if (position)
    lastPosition = { x: position.x, y: position.y }

  sharedEventTarget?.dispatchEvent(new MouseEvent('mousemove', { screenX: position?.x, screenY: position?.y }))
}

/**
 * Feeds the cursor position from this window's own pointer events.
 *
 * NOTICE:
 * Chromium's Ozone/Wayland backend does not know where a window sits, because a Wayland client is never told. On a
 * layer shell surface the app places the window itself, so `screen.getCursorScreenPoint()` returns the position of the
 * last pointer event added to an origin that is not where the surface is. The result sticks at a wrong point, and the
 * character that looks at it looks at nothing.
 * Root cause: a Wayland client gets pointer events only for its own surfaces. No client can read the global cursor
 * position unless the compositor hands it out, and the protocol that does so without taking the pointer
 * (`ext-image-copy-capture` pointer cursor session) is missing from niri today.
 * Source: https://github.com/moeru-ai/airi/issues/2521, https://github.com/niri-wm/niri/issues/1558
 * Removal: once the compositor reports the cursor position while the pointer stays usable by other windows.
 */
function trackFromPointerEvents() {
  const { x: windowX, y: windowY } = useElectronWindowBounds()
  let pending: Position | undefined
  let frame = 0

  useEventListener(window, 'pointermove', (event: PointerEvent) => {
    cursorPositionLive.value = true
    pending = { x: event.clientX + windowX.value, y: event.clientY + windowY.value }
    // Pointer events arrive faster than frames. One send per frame is what the main process loop did, and it keeps
    // consumers that sample pixels per position from running on every event.
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0
        const position = pending
        pending = undefined
        publishPosition(position)
      })
    }
  }, { passive: true })

  // 指针一出这个窗口就没有坐标可读了。`pointerout` 带着空的相关目标，说明它去了窗口外面，而不是换了个元素。
  useEventListener(window, 'pointerout', (event: PointerEvent) => {
    if (!event.relatedTarget)
      cursorPositionLive.value = false
  }, { passive: true })
}

function startTracking(context: EventaContext) {
  // A failed probe keeps the IPC loop, which every platform but Wayland needs.
  void defineInvoke(context, electron.app.isWayland)()
    .catch(() => false)
    .then((wayland) => {
      if (wayland) {
        trackFromPointerEvents()
        return
      }

      void defineInvoke(context, startLoopGetCursorScreenPoint)()
      // 这个循环一直报，指针在窗口外面也是真的位置。
      cursorPositionLive.value = true
    })
}

export function useElectronMouseEventTarget() {
  const context = getElectronEventaContext()

  if (!sharedEventTarget) {
    sharedEventTarget = new EventTarget()
    context.on(cursorScreenPoint, event => publishPosition(event.body))
  }

  if (!startedTracking) {
    startedTracking = true
    startTracking(context)
  }

  return ref(sharedEventTarget)
}

export function useElectronMouse(options?: UseMouseOptions) {
  const eventTarget = useElectronMouseEventTarget()
  return useMouse({ ...options, initialValue: lastPosition ?? options?.initialValue, target: eventTarget, type: 'screen' })
}

/**
 * 光标位置还作不作数，见 `cursorPositionLive`。
 *
 * 位置一过时，指针就已经不在这个窗口上了，只是最后一个位置还留在里面。
 */
export function useElectronCursorPositionLive() {
  useElectronMouseEventTarget()
  return cursorPositionLive
}
