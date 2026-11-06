import process from 'node:process'

import { join } from 'node:path'

import config from 'virtual:ergosphere-it/config'

import { startLauncher } from '@ergosphere-it/electron/launcher'
import { errorMessageFrom } from '@moeru/std'
import { ensureLayerShellProxy } from '@proj-airi/electron-wayland-layer-shell'
import { app } from 'electron'
import { ensureSelfResponsible } from 'node-macos-disclaim'

/**
 * Makes AIRI its own TCC responsible process on macOS.
 *
 * When a terminal or Steam starts AIRI, macOS checks the privacy permissions of that launcher, not of AIRI. Screen and
 * system audio capture then gives silence, and permission prompts show the name of the launcher. The call re-execs
 * AIRI in place with the same PID. It does nothing when AIRI is already its own responsible process, for example after
 * a start from Finder or the Dock.
 *
 * Development runs keep the permissions of the terminal. The path of their Electron binary changes, so permissions
 * that macOS gave to it do not last.
 */
function becomeOwnResponsibleProcess() {
  if (!app.isPackaged)
    return

  try {
    ensureSelfResponsible()
  }
  catch (error) {
    // AIRI still works as a child of the launcher, only with the permissions of the launcher.
    console.warn(`[launcher] Cannot make AIRI its own TCC responsible process: ${errorMessageFrom(error) ?? 'unknown error'}`)
  }
}

/**
 * Flatpak and Nix installs use the build of the deb and rpm packages, so only the runtime can tell them. Their package
 * managers update the app, so the updater stays off. See `isExternallyUpdatedInstall` in
 * `src/main/services/electron/auto-updater.ts`.
 */
function isUpdatedByPackageManager() {
  return !!process.env.FLATPAK_ID || process.env.AIRI_DISTRIBUTION === 'nix'
}

// Re-exec before the launcher loads a bundle, so that no update work runs twice.
becomeOwnResponsibleProcess()

// 层表面要在 Chromium 连上合成器之前生效，而这一步在跑 JS 之前就发生了，
// 所以只能先拉起 Wayland 代理，再带着新的 WAYLAND_DISPLAY 重新启动自己。
// 这个会话不该用层表面时它什么都不做。
// eslint-disable-next-line antfu/no-top-level-await
await ensureLayerShellProxy({
  execPath: process.execPath,
  argv: process.argv,
  env: process.env,
  logDirectory: join(app.getPath('userData'), 'logs'),
})

// NOTICE: Electron emits `ready` only after the top-level await of its entry, so the bundle main starts before ready.
// See the custom launcher section of the @ergosphere-it/electron API reference.
// eslint-disable-next-line antfu/no-top-level-await
await startLauncher({
  ...config,
  disabled: config.disabled || isUpdatedByPackageManager(),
  launcherUrl: import.meta.url,
})
