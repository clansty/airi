import type { LayerShellEvent, LayerShellGeometry, LayerShellWindowOptions } from '../types'
import type { WaylandMessage } from '../wire'

import { Buffer } from 'node:buffer'

import { describe, expect, it } from 'vitest'

import { decorateWindowTitle } from '../protocol'
import { ArgumentReader, buildMessage, parseMessages } from '../wire'
import { ConnectionFilter } from './filter'

const DISPLAY = 1
const REGISTRY = 2
const COMPOSITOR = 3
const WM_BASE = 6
const SURFACE = 10
const XDG_SURFACE = 11
const TOPLEVEL = 12
const SEAT = 14
const POINTER = 15
const OUTPUT = 16

const LAYER = { setSize: 0, setAnchor: 1, setExclusiveZone: 2, setMargin: 3, setKeyboardInteractivity: 4, ackConfigure: 6, destroy: 7 }

interface Harness {
  filter: ConnectionFilter
  toServer: WaylandMessage[]
  toClient: WaylandMessage[]
  events: LayerShellEvent[]
  client: (buffer: Buffer) => void
  server: (buffer: Buffer) => void
  lastToServer: () => number
}

function createHarness(policies = new Map<string, { options: LayerShellWindowOptions, geometry: LayerShellGeometry }>()): Harness {
  const toServer: WaylandMessage[] = []
  const toClient: WaylandMessage[] = []
  const events: LayerShellEvent[] = []
  const drain = (target: WaylandMessage[]) => (buffer: Buffer) => {
    target.push(...parseMessages(buffer).messages)
  }
  const filter = new ConnectionFilter({
    sendToServer: drain(toServer),
    sendToClient: drain(toClient),
    policy: windowId => policies.get(windowId),
    onEvent: event => events.push(event),
    log: () => {},
  })

  return {
    filter,
    toServer,
    toClient,
    events,
    client: buffer => filter.handleClientData(buffer, []),
    server: buffer => filter.handleServerData(buffer, []),
    lastToServer: () => toServer.length,
  }
}

/** 一个已经绑定好全局对象的连接。 */
function bootstrap(harness: Harness) {
  harness.client(buildMessage(DISPLAY, 1, [REGISTRY]))
  // Chromium 不认识层表面，全局只出现在 registry 事件里，绑定由代理自己发。
  harness.server(buildMessage(REGISTRY, 0, [3, 'zwlr_layer_shell_v1', 4]))
  harness.client(buildMessage(REGISTRY, 0, [1, 'wl_compositor', 6, COMPOSITOR]))
  harness.client(buildMessage(REGISTRY, 0, [2, 'xdg_wm_base', 6, WM_BASE]))
  harness.client(buildMessage(REGISTRY, 0, [4, 'wl_output', 4, OUTPUT]))
  harness.client(buildMessage(REGISTRY, 0, [5, 'wl_seat', 8, SEAT]))

  harness.server(buildMessage(OUTPUT, 4, ['DP-3']))
  harness.server(buildMessage(OUTPUT, 1, [1, 2560, 1600, 60000]))
  harness.server(buildMessage(OUTPUT, 3, [1]))

  harness.client(buildMessage(COMPOSITOR, 0, [SURFACE]))
  harness.client(buildMessage(SEAT, 0, [POINTER]))
  harness.toServer.length = 0
}

const geometry: LayerShellGeometry = { x: 200, y: 100, width: 400, height: 600 }
const options: LayerShellWindowOptions = { namespace: 'airi-pet', layer: 'overlay', keyboard: 'on-demand' }

function policyMap() {
  return new Map([['pet', { options, geometry }]])
}

function createWindow(harness: Harness, title: string) {
  harness.client(buildMessage(WM_BASE, 2, [XDG_SURFACE, SURFACE]))
  harness.client(buildMessage(XDG_SURFACE, 1, [TOPLEVEL]))
  harness.client(buildMessage(TOPLEVEL, 2, [title]))
}

/** 角色还没定的时候，客户端发来的请求不能被转发。 */
function expectHeld(harness: Harness) {
  expect(harness.toServer).toHaveLength(0)
}

describe('connection filter', () => {
  it('turns a managed window into a layer surface', () => {
    const harness = createHarness(policyMap())
    bootstrap(harness)

    createWindow(harness, decorateWindowTitle('pet', 'AIRI'))
    harness.client(buildMessage(SURFACE, 6, []))

    // 第一次转换先把层表面全局绑到 xdg_surface 的号上，然后才是层表面本身。
    expect(harness.toServer[0]).toMatchObject({ objectId: REGISTRY, opcode: 0 })
    const bindReader = new ArgumentReader(harness.toServer[0].payload)
    expect(bindReader.uint()).toBe(3)
    expect(bindReader.string()).toBe('zwlr_layer_shell_v1')
    expect(bindReader.uint()).toBe(4)
    expect(bindReader.object()).toBe(XDG_SURFACE)

    // 层表面全局就绑在 xdg_surface 的号上，get_layer_surface 也发向它。
    const layer = harness.toServer[1]
    expect(layer.objectId).toBe(XDG_SURFACE)
    expect(layer.opcode).toBe(0)
    const reader = new ArgumentReader(layer.payload)
    expect(reader.object()).toBe(TOPLEVEL)
    expect(reader.object()).toBe(SURFACE)
    expect(reader.object()).toBe(0)
    expect(reader.uint()).toBe(3)
    expect(reader.string()).toBe('airi-pet')

    const margins = harness.toServer.find(message => message.objectId === TOPLEVEL && message.opcode === LAYER.setMargin)
    expect(margins).toBeDefined()
    const marginReader = new ArgumentReader(margins!.payload)
    expect([marginReader.int(), marginReader.int(), marginReader.int(), marginReader.int()]).toEqual([100, 0, 0, 200])

    const size = harness.toServer.find(message => message.objectId === TOPLEVEL && message.opcode === LAYER.setSize)
    const sizeReader = new ArgumentReader(size!.payload)
    expect([sizeReader.uint(), sizeReader.uint()]).toEqual([400, 600])

    // 客户端自己的 commit 照常发出去。
    expect(harness.toServer.at(-1)).toMatchObject({ objectId: SURFACE, opcode: 6 })
    expect(harness.events).toEqual([{ type: 'attached', windowId: 'pet' }])
  })

  it('keeps a window whose title names nothing an ordinary toplevel', () => {
    const harness = createHarness(policyMap())
    bootstrap(harness)

    createWindow(harness, 'Just a window')
    harness.client(buildMessage(SURFACE, 6, []))

    const forwarded = harness.toServer.map(message => [message.objectId, message.opcode])
    expect(forwarded).toEqual([
      [WM_BASE, 2],
      [XDG_SURFACE, 1],
      [TOPLEVEL, 2],
      [SURFACE, 6],
    ])
  })

  it('gives up when the surface commits before a title', () => {
    const harness = createHarness(policyMap())
    bootstrap(harness)

    harness.client(buildMessage(WM_BASE, 2, [XDG_SURFACE, SURFACE]))
    harness.client(buildMessage(XDG_SURFACE, 1, [TOPLEVEL]))
    harness.client(buildMessage(SURFACE, 6, []))

    expect(harness.toServer.map(message => message.objectId)).toEqual([WM_BASE, XDG_SURFACE, SURFACE])
    expect(harness.events).toHaveLength(0)
  })

  it('holds the role while the client keeps setting properties', () => {
    const harness = createHarness(policyMap())
    bootstrap(harness)

    harness.client(buildMessage(WM_BASE, 2, [XDG_SURFACE, SURFACE]))
    harness.client(buildMessage(XDG_SURFACE, 1, [TOPLEVEL]))
    harness.client(buildMessage(TOPLEVEL, 3, ['airi']))
    expectHeld(harness)

    harness.client(buildMessage(TOPLEVEL, 2, [decorateWindowTitle('pet', 'AIRI')]))
    expect(harness.toServer.some(message => message.objectId === XDG_SURFACE && message.opcode === 0)).toBe(true)
  })

  it('holds the decoration request that names the pending toplevel', () => {
    const harness = createHarness(policyMap())
    bootstrap(harness)

    const decorationManager = 20
    harness.client(buildMessage(REGISTRY, 0, [6, 'zxdg_decoration_manager_v1', 1, decorationManager]))
    harness.client(buildMessage(WM_BASE, 2, [XDG_SURFACE, SURFACE]))
    harness.client(buildMessage(XDG_SURFACE, 1, [TOPLEVEL]))
    harness.toServer.length = 0
    harness.client(buildMessage(decorationManager, 1, [30, TOPLEVEL]))
    expectHeld(harness)

    harness.client(buildMessage(TOPLEVEL, 2, [decorateWindowTitle('pet', 'AIRI')]))

    // 装饰对象在合成器那边建不出来，用 sync 占号后自己回一条客户端装饰。
    const sync = harness.toServer.find(message => message.objectId === DISPLAY && message.opcode === 0)
    expect(sync).toBeDefined()
    expect(new ArgumentReader(sync!.payload).object()).toBe(30)

    // 客户端装饰的 configure 属于客户端那一侧。
    const configure = harness.toClient.find(message => message.objectId === 30)
    expect(configure).toBeDefined()
    expect(new ArgumentReader(configure!.payload).uint()).toBe(1)
  })

  it('translates the configure and the ack', () => {
    const harness = createHarness(policyMap())
    bootstrap(harness)
    createWindow(harness, decorateWindowTitle('pet', 'AIRI'))
    harness.client(buildMessage(SURFACE, 6, []))
    harness.toClient.length = 0
    harness.toServer.length = 0

    harness.server(buildMessage(TOPLEVEL, 0, [7, 400, 600]))

    expect(harness.toClient.map(message => [message.objectId, message.opcode])).toEqual([
      [XDG_SURFACE, 0],
      [TOPLEVEL, 0],
    ])
    expect(new ArgumentReader(harness.toClient[0].payload).uint()).toBe(7)

    harness.client(buildMessage(XDG_SURFACE, 4, [7]))
    expect(harness.toServer).toHaveLength(1)
    expect(harness.toServer[0]).toMatchObject({ objectId: TOPLEVEL, opcode: LAYER.ackConfigure })
    expect(new ArgumentReader(harness.toServer[0].payload).uint()).toBe(7)
  })

  it('moves the surface with the pointer during a drag', () => {
    const harness = createHarness(policyMap())
    bootstrap(harness)
    createWindow(harness, decorateWindowTitle('pet', 'AIRI'))
    harness.client(buildMessage(SURFACE, 6, []))

    // 指针在窗口里的位置，按下时是 (10, 10)。
    harness.server(Buffer.concat([
      buildMessage(POINTER, 0, [1, SURFACE, 10 * 256, 10 * 256]),
      buildMessage(POINTER, 3, [2, 0, 0x110, 1]),
    ]))
    // 按下之后、客户端请求移动之前指针已经走了一点，这段位移也要算进去。
    // motion 是「时间戳 + 坐标」，时间戳不是坐标，算进来就会把窗口甩到屏幕边上。
    harness.server(buildMessage(POINTER, 2, [114211, 20 * 256, 20 * 256]))
    harness.client(buildMessage(TOPLEVEL, 5, [SEAT, 2]))

    harness.toServer.length = 0
    harness.server(buildMessage(POINTER, 2, [114233, 130 * 256, 60 * 256]))

    const margins = harness.toServer.find(message => message.opcode === LAYER.setMargin)
    expect(margins).toBeDefined()
    const reader = new ArgumentReader(margins!.payload)
    expect([reader.int(), reader.int(), reader.int(), reader.int()]).toEqual([150, 0, 0, 320])

    // 松手时把最终几何报给应用，应用的窗口位置只有它自己知道。
    harness.server(buildMessage(POINTER, 3, [3, 0, 0x110, 0]))
    expect(harness.events).toEqual([
      { type: 'attached', windowId: 'pet' },
      { type: 'geometry', windowId: 'pet', geometry: { x: 320, y: 150, width: 400, height: 600 } },
    ])
  })

  it('keeps the surface inside its output', () => {
    const harness = createHarness(policyMap())
    bootstrap(harness)
    createWindow(harness, decorateWindowTitle('pet', 'AIRI'))
    harness.client(buildMessage(SURFACE, 6, []))

    harness.server(buildMessage(POINTER, 0, [1, SURFACE, 0, 0]))
    harness.client(buildMessage(TOPLEVEL, 5, [SEAT, 2]))
    harness.toServer.length = 0

    // 输出是 2560x1600，窗口 400x600，所以位置最多到 (2160, 1000)。
    harness.server(buildMessage(POINTER, 2, [0, 5000 * 256, 5000 * 256]))

    const margins = harness.toServer.find(message => message.opcode === LAYER.setMargin)
    const reader = new ArgumentReader(margins!.payload)
    expect([reader.int(), reader.int(), reader.int(), reader.int()]).toEqual([1000, 0, 0, 2160])
  })

  it('finds the output from the display label Electron reports', () => {
    // Electron 的屏幕名字长这样：「厂商 - 型号 - 连接器」，连接器就是 wl_output 的名字。
    const labelled = new Map([['pet', { options: { ...options, output: 'Example Vendor - Example Model - DP-3' }, geometry }]])
    const harness = createHarness(labelled)
    bootstrap(harness)

    createWindow(harness, decorateWindowTitle('pet', 'AIRI'))
    harness.client(buildMessage(SURFACE, 6, []))

    const layer = harness.toServer[1]
    const reader = new ArgumentReader(layer.payload)
    reader.object() // 层表面自己的号
    reader.object() // wl_surface
    // 输出的对象号：认不出名字时这里是 0，窗口就跑到别的屏幕上去了。
    expect(reader.object()).toBe(OUTPUT)
  })

  it('resizes the surface when the client asks the compositor to resize it', () => {
    const harness = createHarness(policyMap())
    bootstrap(harness)
    createWindow(harness, decorateWindowTitle('pet', 'AIRI'))
    harness.client(buildMessage(SURFACE, 6, []))

    harness.server(buildMessage(POINTER, 0, [1, SURFACE, 10 * 256, 10 * 256]))
    // 右下角（bottom 2 | right 8）开始拉，指针往右下走 30x20。
    harness.client(buildMessage(TOPLEVEL, 6, [SEAT, 2, 10]))
    harness.toServer.length = 0
    harness.server(buildMessage(POINTER, 2, [0, 40 * 256, 30 * 256]))

    const sizes = harness.toServer.find(message => message.opcode === LAYER.setSize)
    const reader = new ArgumentReader(sizes!.payload)
    expect([reader.int(), reader.int()]).toEqual([430, 620])
  })

  it('shows a popup of a managed window as a layer surface', () => {
    const popupSurface = 20
    const popupXdgSurface = 21
    const positioner = 22
    const popup = 23

    const harness = createHarness(policyMap())
    bootstrap(harness)
    createWindow(harness, decorateWindowTitle('pet', 'AIRI'))
    harness.client(buildMessage(SURFACE, 6, []))
    harness.toServer.length = 0

    // 弹窗挂在这个窗口上：父窗口是层表面，合成器不认，只能把弹窗也变成层表面。
    harness.client(buildMessage(COMPOSITOR, 0, [popupSurface]))
    harness.client(buildMessage(WM_BASE, 2, [popupXdgSurface, popupSurface]))
    harness.client(buildMessage(WM_BASE, 1, [positioner]))
    harness.client(buildMessage(positioner, 1, [163, 28]))
    harness.client(buildMessage(positioner, 2, [21, 176, 10, 15]))
    // 锚点和 gravity 都是右下角，也就是菜单和气泡最常见的摆法。
    harness.client(buildMessage(positioner, 3, [10]))
    harness.client(buildMessage(positioner, 4, [10]))
    harness.client(buildMessage(popupXdgSurface, 2, [popup, XDG_SURFACE, positioner]))

    // get_popup 不能转发给合成器，父窗口在那边不存在。
    expect(harness.toServer.some(message => message.objectId === popupXdgSurface)).toBe(false)

    const layer = harness.toServer.find(message => message.objectId === XDG_SURFACE && message.opcode === 0
      && new ArgumentReader(message.payload).object() === popup)
    expect(layer).toBeDefined()

    const margins = harness.toServer.find(message => message.objectId === popup && message.opcode === LAYER.setMargin)
    const reader = new ArgumentReader(margins!.payload)
    // 窗口在 (200, 100)，锚点相对窗口是 (21, 176)，两边都是右下角对齐，弹窗 163x28。
    expect([reader.int(), reader.int(), reader.int(), reader.int()]).toEqual([263, 0, 0, 68])
  })

  it('clamps with the screen size the app measured', () => {
    // 分数缩放下 wl_output 的 mode/scale 算不出真实逻辑尺寸，应用报的才算。
    const sized = new Map([['pet', { options: { ...options, outputSize: { width: 1000, height: 1600 } }, geometry }]])
    const harness = createHarness(sized)
    bootstrap(harness)
    createWindow(harness, decorateWindowTitle('pet', 'AIRI'))
    harness.client(buildMessage(SURFACE, 6, []))

    harness.server(Buffer.concat([
      buildMessage(POINTER, 0, [1, SURFACE, 0, 0]),
      buildMessage(POINTER, 3, [2, 0, 0x110, 1]),
    ]))
    harness.client(buildMessage(TOPLEVEL, 5, [SEAT, 2]))
    harness.toServer.length = 0

    harness.server(buildMessage(POINTER, 2, [0, 5000 * 256, 5000 * 256]))

    const margins = harness.toServer.find(message => message.opcode === LAYER.setMargin)
    const reader = new ArgumentReader(margins!.payload)
    expect([reader.int(), reader.int(), reader.int(), reader.int()]).toEqual([1000, 0, 0, 600])
  })

  it('applies geometry from the app', () => {
    const harness = createHarness(policyMap())
    bootstrap(harness)
    createWindow(harness, decorateWindowTitle('pet', 'AIRI'))
    harness.client(buildMessage(SURFACE, 6, []))
    harness.toServer.length = 0

    expect(harness.filter.applyGeometry('pet', { x: 10, y: 20, width: 300, height: 500 })).toBe(true)

    const margins = harness.toServer.find(message => message.opcode === LAYER.setMargin)
    const reader = new ArgumentReader(margins!.payload)
    expect([reader.int(), reader.int(), reader.int(), reader.int()]).toEqual([20, 0, 0, 10])
    expect(harness.toServer.at(-1)).toMatchObject({ objectId: SURFACE, opcode: 6 })
  })
})
