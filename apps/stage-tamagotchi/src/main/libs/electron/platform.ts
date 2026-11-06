import { env } from 'node:process'

import { app } from 'electron'

import { resolveIsWayland } from '../../app/ozone'

/**
 * 这个会话是不是跑在 Wayland 的 Ozone 后端上。
 *
 * 命令行开关优先，其次才是会话环境变量：XWayland 下 `WAYLAND_DISPLAY` 还在，但 Chromium 用的是 X11。
 */
export function isWaylandSession(): boolean {
  return resolveIsWayland({
    explicitOzonePlatform: app.commandLine.getSwitchValue('ozone-platform'),
    ozonePlatformHint: app.commandLine.getSwitchValue('ozone-platform-hint'),
    env,
  })
}
