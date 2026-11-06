import { defineInvokeEventa } from '@moeru/eventa'

const isMacOS = defineInvokeEventa<boolean>('eventa:invoke:electron:app:is-macos')
const isWindows = defineInvokeEventa<boolean>('eventa:invoke:electron:app:is-windows')
const isLinux = defineInvokeEventa<boolean>('eventa:invoke:electron:app:is-linux')
/** Whether the app runs on the Wayland Ozone backend, where Electron cannot read the cursor position. */
const isWayland = defineInvokeEventa<boolean>('eventa:invoke:electron:app:is-wayland')
const quit = defineInvokeEventa<void>('eventa:invoke:electron:app:quit')

export const app = {
  isMacOS,
  isWindows,
  isLinux,
  isWayland,
  quit,
}
