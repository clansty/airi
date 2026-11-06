import type { LayerShellControlClient } from './control'
import type { LayerShellEvent, LayerShellGeometry, LayerShellWindowOptions } from './types'

import process from 'node:process'

import { spawn } from 'node:child_process'
import { mkdirSync, openSync, writeSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { connectLayerShellControl } from './control'
import { decideLayerShell, LAYER_SHELL_CHOICE_ENV } from './options'

export type { LayerShellControlClient } from './control'
export { decideLayerShell, LAYER_SHELL_CHOICE_ENV, normalizeWindowOptions } from './options'
export { decorateWindowTitle, parseWindowTitle } from './protocol'
export type { LayerShellEvent, LayerShellGeometry, LayerShellLayer, LayerShellWindowOptions } from './types'

/** 代理和它自己的两个 socket。名字带父进程号，避免多个实例互相踩。 */
export interface LayerShellProxyPaths {
  /** 应用要连的 Wayland 名字，直接写进 `WAYLAND_DISPLAY`。 */
  waylandDisplay: string
  waylandSocket: string
  controlSocket: string
}

export function resolveProxyPaths(runtimeDir: string, pid: number): LayerShellProxyPaths {
  const waylandDisplay = `airi-wayland-${pid}`
  return {
    waylandDisplay,
    waylandSocket: `${runtimeDir}/${waylandDisplay}`,
    controlSocket: `${runtimeDir}/airi-layer-shell-control-${pid}`,
  }
}

/** 代理的入口文件。打包后它和这个文件同在 `dist/` 下。 */
function proxyEntry(): string {
  return fileURLToPath(new URL('./proxy/main.mjs', import.meta.url))
}

export interface EnsureLayerShellProxyOptions {
  execPath: string
  argv: string[]
  env: NodeJS.ProcessEnv
  /** 日志目录，代理和主进程的诊断信息都写在这里。 */
  logDirectory: string
  platform?: NodeJS.Platform
  desktopName?: string
  runtimeDir?: string
}

/**
 * 让应用「带着层表面代理」重新启动。
 *
 * Chromium 在跑 JS 之前就按 `WAYLAND_DISPLAY` 连上了合成器，所以只能在进程外面改这个变量：
 * 这里先拉起代理，再用新的 `WAYLAND_DISPLAY` 重新拉起自己，然后退出。
 * 已经是重新拉起的那一份，或者这个会话不该用层表面时，直接返回。
 */
export async function ensureLayerShellProxy(options: EnsureLayerShellProxyOptions): Promise<void> {
  const platform = options.platform ?? process.platform
  const env = options.env

  if (platform !== 'linux')
    return
  // 已经在代理后面跑着，这是重新拉起的那个进程。
  if (env.AIRI_LAYER_SHELL_PROXY === '1')
    return

  const display = env.WAYLAND_DISPLAY
  const runtimeDir = options.runtimeDir ?? env.XDG_RUNTIME_DIR
  if (!display || !runtimeDir)
    return

  const decision = decideLayerShell({
    desktopName: options.desktopName ?? env.XDG_CURRENT_DESKTOP,
    choice: env[LAYER_SHELL_CHOICE_ENV],
  })
  if (!decision.use)
    return

  const paths = resolveProxyPaths(runtimeDir, process.pid)
  const logFile = `${options.logDirectory}/wayland-layer-shell.log`
  mkdirSync(dirname(logFile), { recursive: true })

  // spawn 的 stdio 要一个已经打开的 fd，WriteStream 在下一拍才拿到 fd。
  const logFd = openSync(logFile, 'a')
  writeSync(logFd, `\n[layer-shell] starting for ${display}: ${decision.why}\n`)

  const proxy = spawn(options.execPath, [proxyEntry()], {
    env: {
      ...env,
      ELECTRON_RUN_AS_NODE: '1',
      AIRI_LAYER_SHELL_WAYLAND_SOCKET: paths.waylandSocket,
      AIRI_LAYER_SHELL_CONTROL: paths.controlSocket,
      AIRI_LAYER_SHELL_WAYLAND_DISPLAY: display,
    },
    // 父进程马上就会退出，代理必须自己活着。
    detached: true,
    stdio: ['ignore', logFd, logFd],
  })
  proxy.unref()

  await waitForControlSocket(paths.controlSocket, 10000)

  const child = spawn(options.execPath, options.argv.slice(1), {
    env: {
      ...env,
      WAYLAND_DISPLAY: paths.waylandDisplay,
      AIRI_LAYER_SHELL_PROXY: '1',
      AIRI_LAYER_SHELL_CONTROL: paths.controlSocket,
      AIRI_LAYER_SHELL_LOG: logFile,
    },
    stdio: 'inherit',
  })

  await new Promise<never>((_resolve, reject) => {
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (signal)
        process.kill(process.pid, signal)
      else
        process.exit(code ?? 0)
    })
  })
}

async function waitForControlSocket(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs

  for (;;) {
    const reachable = await new Promise<boolean>((resolve) => {
      const socket = connect(path)
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => {
        socket.destroy()
        resolve(false)
      })
    })

    if (reachable)
      return
    if (Date.now() > deadline)
      throw new Error(`the layer shell proxy did not open ${path} in ${timeoutMs}ms`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

/**
 * 主进程用的句柄。
 *
 * 一个窗口要在创建之前登记：代理靠标题里的窗口 id 认领 role，登记晚于第一个 role 就只能继续当普通窗口。
 */
export class LayerShellManager {
  private readonly listeners = new Set<(event: LayerShellEvent) => void>()

  private constructor(private readonly control: LayerShellControlClient) {
    this.control.onEvent((event) => {
      for (const listener of this.listeners)
        listener(event)
    })
  }

  /** 连不上代理（例如没有重新拉起）时返回 `undefined`，调用方照常开普通窗口。 */
  static async connect(controlSocket: string): Promise<LayerShellManager | undefined> {
    try {
      return new LayerShellManager(await connectLayerShellControl(controlSocket))
    }
    catch {
      return undefined
    }
  }

  onEvent(listener: (event: LayerShellEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 登记一个窗口和它的初始几何。返回值表示代理是否接受。 */
  async attach(windowId: string, options: LayerShellWindowOptions, geometry: LayerShellGeometry): Promise<boolean> {
    try {
      await this.control.request({ type: 'attach', windowId, options, geometry })
      return true
    }
    catch {
      return false
    }
  }

  /** 应用自己移动或缩放窗口时调用，位置走 margin，尺寸走 set_size。 */
  async setGeometry(windowId: string, geometry: LayerShellGeometry): Promise<boolean> {
    try {
      return await this.control.request<boolean>({ type: 'geometry', windowId, geometry })
    }
    catch {
      return false
    }
  }

  /**
   * 把窗口挪到另一块屏幕上。
   *
   * 层表面的输出在创建时就固定，所以代理要销毁 role 对象再在目标输出上重建；
   * 客户端那边什么都不会变，页面也不用重新加载。
   */
  async relocate(
    windowId: string,
    output: string | undefined,
    outputSize: { width: number, height: number } | undefined,
    geometry: LayerShellGeometry,
  ): Promise<boolean> {
    try {
      return await this.control.request<boolean>({ type: 'relocate', windowId, output, outputSize, geometry })
    }
    catch {
      return false
    }
  }

  async detach(windowId: string): Promise<void> {
    try {
      await this.control.request({ type: 'detach', windowId })
    }
    catch {
      // 代理已经走了，这里没有什么可收拾的。
    }
  }

  /** 是否有连接见过 `zwlr_layer_shell_v1`。 */
  async isSupported(): Promise<boolean> {
    try {
      const status = await this.control.request<{ layerShellAvailable: boolean }>({ type: 'status' })
      return status.layerShellAvailable
    }
    catch {
      return false
    }
  }

  close(): void {
    this.control.close()
  }
}
