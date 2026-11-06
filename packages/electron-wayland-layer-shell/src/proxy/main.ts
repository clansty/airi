/**
 * 代理进程的入口。
 *
 * 它必须比 Electron 先起来：Chromium 在脚本执行之前就按 `WAYLAND_DISPLAY` 选好后端并连上合成器，
 * 所以启动顺序是「启动器拉起代理 → 启动器带着新的 `WAYLAND_DISPLAY` 重新拉起自己」。
 *
 * 这里的循环是阻塞的（poll + recvmsg），因为整个进程只做转发，不需要事件循环。
 */
import type { ProxyCommand, ProxyMessage } from '../protocol'
import type { LayerShellEvent, LayerShellGeometry, LayerShellWindowOptions } from '../types'

import process, { env } from 'node:process'

import { Buffer } from 'node:buffer'
import { existsSync } from 'node:fs'

import { ConnectionFilter } from './filter'
import { acceptFd, closeFd, connectUnix, createListener, poll, POLLIN, POLLOUT, recvWithFds, sendWithFds, unlinkPath } from './unix'

interface Policy {
  options: LayerShellWindowOptions
  geometry: LayerShellGeometry
}

interface QueueItem {
  data: Buffer
  fds: number[]
}

function log(message: string): void {
  process.stderr.write(`[layer-shell] ${message}\n`)
}

/** `WAYLAND_DISPLAY` 可能是绝对路径，也可能是 `$XDG_RUNTIME_DIR` 里的名字。 */
function resolveDisplayPath(display: string): string {
  if (display.startsWith('/'))
    return display
  const runtimeDir = env.XDG_RUNTIME_DIR
  if (!runtimeDir)
    throw new Error('XDG_RUNTIME_DIR is not set, so the Wayland socket cannot be found')
  return `${runtimeDir}/${display}`
}

/** 一条被代理的 Wayland 连接：客户端、合成器、以及中间的过滤器。 */
class Relay {
  readonly toServer: QueueItem[] = []
  readonly toClient: QueueItem[] = []
  closed = false
  readonly filter: ConnectionFilter

  constructor(
    readonly clientFd: number,
    readonly serverFd: number,
    policy: (windowId: string) => Policy | undefined,
    onEvent: (event: LayerShellEvent) => void,
  ) {
    this.filter = new ConnectionFilter({
      sendToServer: (bytes, fds) => this.enqueue(this.serverFd, this.toServer, bytes, fds),
      sendToClient: (bytes, fds) => this.enqueue(this.clientFd, this.toClient, bytes, fds),
      policy,
      onEvent,
      log,
    })
  }

  private enqueue(fd: number, queue: QueueItem[], data: Buffer, fds: readonly number[]): void {
    if (data.length === 0)
      return
    queue.push({ data, fds: [...fds] })
    this.flush(fd, queue)
  }

  private flush(fd: number, queue: QueueItem[]): void {
    while (queue.length > 0) {
      const item = queue[0]
      const written = sendWithFds(fd, item.data, item.fds)
      if (written < 0)
        return
      // fd 跟着第一次写就出去了，剩下的字节不再带 fd。
      item.fds = []
      if (written < item.data.length) {
        item.data = item.data.subarray(written)
        return
      }
      queue.shift()
    }
  }

  flushPending(): void {
    this.flush(this.serverFd, this.toServer)
    this.flush(this.clientFd, this.toClient)
  }

  get wantsWrite(): boolean {
    return this.toServer.length > 0 || this.toClient.length > 0
  }

  readClient(): void {
    for (;;) {
      const chunk = recvWithFds(this.clientFd)
      if (chunk.bytes === 0) {
        this.close()
        return
      }
      if (chunk.bytes < 0)
        return
      this.filter.handleClientData(chunk.data, chunk.fds)
      if (this.closed)
        return
    }
  }

  readServer(): void {
    for (;;) {
      const chunk = recvWithFds(this.serverFd)
      if (chunk.bytes === 0) {
        this.close()
        return
      }
      if (chunk.bytes < 0)
        return
      this.filter.handleServerData(chunk.data, chunk.fds)
      if (this.closed)
        return
    }
  }

  close(): void {
    if (this.closed)
      return
    this.closed = true
    this.filter.markClosed()
    closeFd(this.clientFd)
    closeFd(this.serverFd)
  }
}

class Proxy {
  private readonly policies = new Map<string, Policy>()
  private readonly relays = new Map<number, Relay>()
  private readonly controlClients = new Map<number, { buffer: Buffer, used: boolean }>()
  private readonly listenFd: number
  private readonly controlFd: number
  private stopping = false

  constructor(
    private readonly listenPath: string,
    private readonly controlPath: string,
    private readonly targetPath: string,
  ) {
    this.listenFd = createListener(listenPath)
    this.controlFd = createListener(controlPath)
    log(`listening on ${listenPath}, control on ${controlPath}, target ${targetPath}`)
  }

  run(): void {
    while (!this.stopping) {
      const pollFds: { fd: number, events: number }[] = [
        { fd: this.listenFd, events: POLLIN },
        { fd: this.controlFd, events: POLLIN },
      ]

      for (const fd of this.controlClients.keys())
        pollFds.push({ fd, events: POLLIN })

      for (const relay of this.relays.values()) {
        pollFds.push({ fd: relay.clientFd, events: POLLIN | (relay.toClient.length > 0 ? POLLOUT : 0) })
        pollFds.push({ fd: relay.serverFd, events: POLLIN | (relay.toServer.length > 0 ? POLLOUT : 0) })
      }

      for (const ready of poll(pollFds, 200)) {
        // 一个 socket 上出的错不该带走整条连接：代理崩了，Chromium 的 Wayland 连接就跟着断，
        // 应用那头看到的是「莫名其妙退出」，而真正的原因在这里。
        try {
          this.handleReady(ready.fd, ready.revents)
        }
        catch (error) {
          log(`a ready socket failed, dropping it: ${String(error)}`)
          this.dropFd(ready.fd)
        }
      }
    }

    this.shutdown()
  }

  private handleReady(fd: number, revents: number): void {
    if (fd === this.listenFd) {
      if (revents & POLLIN)
        this.acceptRelay()
      return
    }

    if (fd === this.controlFd) {
      if (revents & POLLIN)
        this.acceptControlClient()
      return
    }

    if (this.controlClients.has(fd)) {
      this.readControl(fd)
      return
    }

    for (const relay of this.relays.values()) {
      if (relay.closed)
        continue
      if (fd === relay.clientFd) {
        if (revents & POLLIN)
          relay.readClient()
        if (revents & POLLOUT)
          relay.flushPending()
      }
      else if (fd === relay.serverFd) {
        if (revents & POLLIN)
          relay.readServer()
        if (revents & POLLOUT)
          relay.flushPending()
      }
    }

    for (const [clientFd, relay] of this.relays) {
      if (relay.closed)
        this.relays.delete(clientFd)
    }
  }

  /** 一个 fd 出错之后连它一起丢掉，否则下一次 poll 还会读到同一个坏 socket。 */
  private dropFd(fd: number): void {
    for (const [clientFd, relay] of this.relays) {
      if (relay.clientFd !== fd && relay.serverFd !== fd)
        continue

      relay.close()
      this.relays.delete(clientFd)
      return
    }

    if (this.controlClients.has(fd)) {
      this.controlClients.delete(fd)
      closeFd(fd)
    }
  }

  private acceptRelay(): void {
    const clientFd = acceptFd(this.listenFd)
    if (clientFd < 0)
      return

    try {
      const serverFd = connectUnix(this.targetPath)
      const relay = new Relay(clientFd, serverFd, windowId => this.policies.get(windowId), event => this.onEvent(event))
      this.relays.set(clientFd, relay)
      log('a Wayland client connected')
    }
    catch (error) {
      log(`could not reach the compositor: ${String(error)}`)
      closeFd(clientFd)
    }
  }

  private acceptControlClient(): void {
    const fd = acceptFd(this.controlFd)
    if (fd >= 0)
      this.controlClients.set(fd, { buffer: Buffer.alloc(0), used: false })
  }

  private readControl(fd: number): void {
    const client = this.controlClients.get(fd)
    if (!client)
      return

    for (;;) {
      const chunk = recvWithFds(fd)
      if (chunk.bytes === 0) {
        this.controlClients.delete(fd)
        closeFd(fd)
        // 只有发过命令的客户端才算「应用」，它走了代理就没有存在的理由。
        if (client.used && ![...this.controlClients.values()].some(other => other.used))
          this.stopping = true
        return
      }
      if (chunk.bytes < 0)
        return

      const joined = Buffer.concat([client.buffer, chunk.data])
      let start = 0
      for (let index = 0; index < joined.length; index++) {
        if (joined[index] !== 0x0A)
          continue
        client.used = true
        this.handleCommand(joined.toString('utf8', start, index))
        start = index + 1
      }
      client.buffer = joined.subarray(start)
    }
  }

  private handleCommand(line: string): void {
    let command: ProxyCommand
    try {
      command = JSON.parse(line) as ProxyCommand
    }
    catch {
      log('a control client sent a line that is not JSON')
      return
    }

    // 一条命令出错只该丢这一条：这个进程是 Chromium 唯一的 Wayland 连接，它崩了应用会跟着掉线，
    // 而且在应用那头看起来就是「不知道发生了什么就退出了」。
    try {
      this.dispatchCommand(command)
    }
    catch (error) {
      const reason = String(error)
      log(`a control command failed: ${command.type}: ${reason}`)
      if ('id' in command)
        this.reply(command.id, false, undefined, reason)
    }
  }

  private dispatchCommand(command: ProxyCommand): void {
    switch (command.type) {
      case 'attach':
        this.policies.set(command.windowId, { options: command.options, geometry: command.geometry })
        this.reply(command.id, true)
        return

      case 'detach':
        this.policies.delete(command.windowId)
        this.reply(command.id, true)
        return

      case 'geometry': {
        let applied = false
        for (const relay of this.relays.values()) {
          if (relay.filter.hasWindow(command.windowId))
            applied = relay.filter.applyGeometry(command.windowId, command.geometry)
        }
        this.reply(command.id, applied)
        return
      }

      case 'input-region': {
        let applied = false
        for (const relay of this.relays.values()) {
          if (relay.filter.hasWindow(command.windowId))
            applied = relay.filter.applyInputRegion(command.windowId, command.rects)
        }
        this.reply(command.id, applied)
        return
      }

      case 'status':
        this.reply(command.id, true, {
          layerShellAvailable: [...this.relays.values()].some(relay => relay.filter.layerShellAvailable),
          connections: this.relays.size,
        })
        return

      case 'shutdown':
        this.stopping = true
        return

      default:
        log('a control client sent a command this proxy does not know')
    }
  }

  private reply(id: number, ok: boolean, result?: unknown, error?: string): void {
    this.broadcast({ type: 'response', id, ok, result, error })
  }

  private onEvent(event: LayerShellEvent): void {
    if (event.type === 'attached' || event.type === 'refused')
      log(`${event.type}: ${event.windowId}${event.type === 'refused' ? ` (${event.reason})` : ''}`)
    this.broadcast({ type: 'event', event })
  }

  private broadcast(message: ProxyMessage): void {
    const line = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8')
    for (const fd of this.controlClients.keys()) {
      if (sendWithFds(fd, line) < 0)
        log('a control client would not take a write')
    }
  }

  private shutdown(): void {
    for (const relay of this.relays.values())
      relay.close()
    this.relays.clear()

    for (const fd of this.controlClients.keys())
      closeFd(fd)
    this.controlClients.clear()

    closeFd(this.listenFd)
    closeFd(this.controlFd)
    unlinkPath(this.listenPath)
    unlinkPath(this.controlPath)
  }
}

function main(): void {
  const listenPath = env.AIRI_LAYER_SHELL_WAYLAND_SOCKET
  const controlPath = env.AIRI_LAYER_SHELL_CONTROL
  const display = env.AIRI_LAYER_SHELL_WAYLAND_DISPLAY
  if (!listenPath || !controlPath || !display)
    throw new Error('AIRI_LAYER_SHELL_WAYLAND_SOCKET, AIRI_LAYER_SHELL_CONTROL and AIRI_LAYER_SHELL_WAYLAND_DISPLAY must be set')

  const targetPath = resolveDisplayPath(display)
  if (!existsSync(targetPath))
    throw new Error(`the compositor socket ${targetPath} does not exist`)

  new Proxy(listenPath, controlPath, targetPath).run()
}

main()
