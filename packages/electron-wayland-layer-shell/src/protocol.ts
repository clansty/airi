import type { LayerShellEvent, LayerShellGeometry, LayerShellWindowOptions } from './types'

/** 代理和控制通道之间的约定。单一文件，避免两边各自定义走散。 */
export type ProxyCommand
  = | { type: 'attach', id: number, windowId: string, options: LayerShellWindowOptions, geometry: LayerShellGeometry }
    | { type: 'geometry', id: number, windowId: string, geometry: LayerShellGeometry }
    | { type: 'input-region', id: number, windowId: string, rects: { x: number, y: number, width: number, height: number }[] | null }
    | { type: 'detach', id: number, windowId: string }
    | { type: 'status', id: number }
    | { type: 'shutdown' }

export type ProxyMessage
  = | { type: 'ready' }
    | { type: 'event', event: LayerShellEvent }
    | { type: 'response', id: number, ok: boolean, error?: string, result?: unknown }

/** 窗口 id 写在标题里的分隔符。用不可见字符，用户看不到，合成器也拿不到。 */
export const WINDOW_ID_MARK = '⁣'

/** 标题在代理手里的样子：`标记 + 窗口 id + 标记 + 真标题`。 */
export function decorateWindowTitle(windowId: string, title: string): string {
  return `${WINDOW_ID_MARK}${windowId}${WINDOW_ID_MARK}${title}`
}

/** 从标题里取出窗口 id 和真标题；不是代理写的标题就返回 `undefined`。 */
export function parseWindowTitle(title: string): { windowId: string, title: string } | undefined {
  const parts = title.split(WINDOW_ID_MARK)
  if (parts.length < 3 || parts[0] !== '')
    return undefined

  const [, windowId, ...rest] = parts
  if (!windowId)
    return undefined

  const realTitle = rest.join(WINDOW_ID_MARK)
  return { windowId, title: realTitle }
}
