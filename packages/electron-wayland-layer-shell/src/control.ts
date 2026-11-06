import type { ProxyCommand, ProxyMessage } from './protocol'
import type { LayerShellEvent } from './types'

import { connect } from 'node:net'

/** `Omit` 会把联合类型压成公共字段，所以逐个成员去掉 id。 */
type WithoutId<T> = T extends { id: number } ? Omit<T, 'id'> : never
export type ProxyCommandBody = WithoutId<ProxyCommand>

/** 控制通道的客户端，跑在 Electron 主进程里。一行一条 JSON，请求和响应用 id 对上。 */
export interface LayerShellControlClient {
  request: <T = unknown>(command: ProxyCommandBody, timeoutMs?: number) => Promise<T>
  onEvent: (listener: (event: LayerShellEvent) => void) => () => void
  close: () => void
}

const DEFAULT_TIMEOUT_MS = 5000

export async function connectLayerShellControl(path: string): Promise<LayerShellControlClient> {
  const socket = connect(path)
  const pending = new Map<number, { resolve: (value: unknown) => void, reject: (error: Error) => void, timer: NodeJS.Timeout }>()
  const listeners = new Set<(event: LayerShellEvent) => void>()
  let buffer = ''
  let nextId = 1
  let closed = false

  const fail = (error: Error) => {
    closed = true
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
  }

  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
      if (!line.trim())
        continue

      const message = JSON.parse(line) as ProxyMessage
      if (message.type === 'event') {
        for (const listener of listeners)
          listener(message.event)
      }
      else if (message.type === 'response') {
        const entry = pending.get(message.id)
        if (!entry)
          continue
        pending.delete(message.id)
        clearTimeout(entry.timer)
        if (message.ok)
          entry.resolve(message.result)
        else
          entry.reject(new Error(message.error ?? 'the layer shell proxy refused the command'))
      }
    }
  })
  socket.on('error', error => fail(error))
  socket.on('close', () => fail(new Error('the layer shell proxy closed the control channel')))

  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('error', reject)
  })

  const request: LayerShellControlClient['request'] = (command, timeoutMs = DEFAULT_TIMEOUT_MS) => {
    if (closed)
      return Promise.reject(new Error('the layer shell proxy is not running'))

    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`the layer shell proxy did not answer ${command.type} in ${timeoutMs}ms`))
      }, timeoutMs)

      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      socket.write(`${JSON.stringify({ ...command, id })}\n`)
    })
  }

  return {
    request,
    onEvent: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close: () => {
      socket.destroy()
      fail(new Error('the layer shell control channel closed'))
    },
  }
}
