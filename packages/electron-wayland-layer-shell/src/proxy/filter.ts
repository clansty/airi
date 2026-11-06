import type { ProxyCommand } from '../protocol'
import type { LayerShellEvent, LayerShellGeometry, LayerShellWindowOptions } from '../types'
import type { WaylandMessage } from '../wire'

import { Buffer } from 'node:buffer'

import { normalizeGeometry } from '../options'
import { parseWindowTitle } from '../protocol'
import { ArgumentReader, buildMessage, parseMessages } from '../wire'

/**
 * 把一个 Electron 的 Wayland 连接变成「可以创建层表面」的连接。
 *
 * 客户端的 role 是 xdg_toplevel，代理在 `xdg_surface.get_toplevel` 处改成 `get_layer_surface`，
 * 之后替它翻译两边的消息：合成器看到层表面，Chromium 继续用 toplevel 那套 API。
 *
 * 三条硬约束决定了下面的写法：
 * 1. `wl_surface` 的 role 只能定一次，所以每个 surface 的决定要缓存下来，重新显示时照抄。
 * 2. 合成器的对象号必须稠密，所以被吃掉的构造函数要用 `wl_display.sync` 占住同一个号。
 * 3. 层表面的位置和尺寸由应用说了算，拖动只能把指针位移翻译成 margin。
 */

const WL_DISPLAY = { sync: 0, getRegistry: 1, deleteId: 1 } as const
const WL_REGISTRY = { bind: 0, global: 0 } as const
const WL_COMPOSITOR = { createSurface: 0, createRegion: 1 } as const
const WL_SURFACE = { destroy: 0, frame: 3, commit: 6 } as const
const WL_CALLBACK = { done: 0, destroy: 1 } as const
const WL_POINTER = { enter: 0, leave: 1, motion: 2, button: 3 } as const
const WL_SEAT = { getPointer: 0, getKeyboard: 1, getTouch: 2 } as const
const WL_OUTPUT = { geometry: 0, mode: 1, scale: 3, name: 4 } as const
const XDG_WM_BASE = { createPositioner: 1, getXdgSurface: 2 } as const
const XDG_SURFACE = { destroy: 0, getToplevel: 1, getPopup: 2, setWindowGeometry: 3, ackConfigure: 4 } as const
const XDG_SURFACE_EVENT = { configure: 0 } as const
const XDG_TOPLEVEL = {
  destroy: 0,
  setParent: 1,
  setTitle: 2,
  setAppId: 3,
  showWindowMenu: 4,
  move: 5,
  resize: 6,
  setMaxSize: 7,
  setMinSize: 8,
  setMaximized: 9,
  unsetMaximized: 10,
  setFullscreen: 11,
  unsetFullscreen: 12,
  setMinimized: 13,
} as const
const XDG_TOPLEVEL_EVENT = { configure: 0, close: 1 } as const
const DECORATION_MANAGER = { getToplevelDecoration: 1 } as const
const DECORATION_EVENT = { configure: 0 } as const
const DECORATION_MODE_CLIENT_SIDE = 1
const ICON_MANAGER = { setIcon: 1 } as const
const ACTIVATION = { activate: 2 } as const
const LAYER_SHELL = { getLayerSurface: 0 } as const
const LAYER_SURFACE = {
  setSize: 0,
  setAnchor: 1,
  setExclusiveZone: 2,
  setMargin: 3,
  setKeyboardInteractivity: 4,
  ackConfigure: 6,
  destroy: 7,
} as const
const LAYER_SURFACE_EVENT = { configure: 0, closed: 1 } as const
const LAYER = { background: 0, bottom: 1, top: 2, overlay: 3 } as const
// 注意 1 是 exclusive、2 才是 on_demand，按协议 XML 的顺序来。
const KEYBOARD = { 'none': 0, 'exclusive': 1, 'on-demand': 2 } as const
const ANCHOR = { top: 1, bottom: 2, left: 4, right: 8 } as const
const POINTER_BUTTON_RELEASED = 0

/** 一次角色的判定过程。判定之前，属于它的请求先压着不发。 */
interface PendingRole {
  surfaceId: number
  xdgSurfaceId: number
  toplevelId?: number
  held: Buffer[]
  /** 压着的 toplevel 装饰对象，转换时要换成占号和客户端装饰。 */
  decorations: number[]
}

interface ClientObject {
  iface: string
  /** 已转换窗口的对象带着窗口 id，后续请求按它分流。 */
  windowId?: string
}

interface SurfaceState {
  /** role 只能定一次，所以决定要留着给重新显示的 role 对象复用。 */
  decision?: { layer: boolean, windowId?: string }
  pending?: PendingRole
}

interface LayerWindow {
  windowId: string
  surfaceId: number
  xdgSurfaceId: number
  layerSurfaceId: number
  options: LayerShellWindowOptions
  geometry: LayerShellGeometry
  outputId: number
  outputName?: string
  gesture?: Gesture
}

/** 拖动中，位移一律从按下那一刻算起，避免把上一步累加进去。 */
interface Gesture {
  startPointer: { x: number, y: number }
  startGeometry: LayerShellGeometry
}

interface OutputState {
  name?: string
  width: number
  height: number
  scale: number
  transform: number
}

export interface FilterDeps {
  sendToServer: (bytes: Buffer, fds: readonly number[]) => void
  sendToClient: (bytes: Buffer, fds: readonly number[]) => void
  /** 窗口的策略和初始几何，来自控制通道。 */
  policy: (windowId: string) => { options: LayerShellWindowOptions, geometry: LayerShellGeometry } | undefined
  onEvent: (event: LayerShellEvent) => void
  log: (message: string) => void
}

const empty = Buffer.alloc(0)

/** 这些请求会分配新的对象号。事务压着的时候遇到它们，必须先把事务放行，否则合成器的对象表会留空洞。 */
function createsObject(iface: string, opcode: number): boolean {
  switch (iface) {
    case 'wl_display': return opcode === WL_DISPLAY.sync || opcode === WL_DISPLAY.getRegistry
    case 'wl_compositor': return opcode === WL_COMPOSITOR.createSurface || opcode === WL_COMPOSITOR.createRegion
    case 'wl_surface': return opcode === WL_SURFACE.frame
    case 'xdg_wm_base': return opcode === XDG_WM_BASE.getXdgSurface || opcode === XDG_WM_BASE.createPositioner
    case 'xdg_surface': return opcode === XDG_SURFACE.getToplevel || opcode === XDG_SURFACE.getPopup
    case 'zxdg_decoration_manager_v1': return opcode === DECORATION_MANAGER.getToplevelDecoration
    case 'xdg_toplevel_icon_manager_v1': return opcode === ICON_MANAGER.setIcon
    case 'xdg_activation_v1': return opcode === ACTIVATION.activate
    case 'zwlr_layer_shell_v1': return opcode === LAYER_SHELL.getLayerSurface
    default: return false
  }
}

export class ConnectionFilter {
  private readonly objects = new Map<number, ClientObject>()
  private readonly surfaces = new Map<number, SurfaceState>()
  private readonly windows = new Map<string, LayerWindow>()
  private readonly layerSurfaces = new Map<number, string>()
  /** 被吃掉的对象号：值是服务端是否已经回收它。 */
  private readonly plugs = new Map<number, { freed: boolean }>()
  private readonly outputs = new Map<number, OutputState>()
  private readonly outputIdsByName = new Map<string, number>()

  private pointer = { x: 0, y: 0, known: false }
  /** 客户端自己的 wl_registry 对象，代理绑全局要用它。 */
  private registryId: number | undefined
  private layerShellGlobalInfo: { name: number, version: number } | undefined
  private layerShellGlobal: number | undefined
  private pendingRoles: PendingRole[] = []
  private clientRest: Buffer = empty
  private serverRest: Buffer = empty
  private closed = false

  constructor(private readonly deps: FilterDeps) {}

  get isClosed(): boolean {
    return this.closed
  }

  /** 合成器是否提供层表面。 */
  get layerShellAvailable(): boolean {
    return this.layerShellGlobal !== undefined
  }

  // ── 客户端 → 合成器 ──────────────────────────────────────────────────

  handleClientData(data: Buffer, fds: readonly number[]): void {
    if (this.closed)
      return

    const joined = this.clientRest.length > 0 ? Buffer.concat([this.clientRest, data]) : data
    const { messages, rest } = parseMessages(joined)
    this.clientRest = rest

    // 带 fd 的块可能把角色构造请求和消费它的消息拆开，先让事务落定最简单。
    const out: Buffer[] = []
    if (fds.length > 0)
      out.push(...this.flushPendingRoles('a message carried a file descriptor'))

    for (const message of messages)
      out.push(...this.onClientMessage(message))

    if (out.length > 0) {
      this.deps.sendToServer(Buffer.concat(out), fds)
    }
    else if (fds.length > 0) {
      // 没有字节可发还带着 fd，说明这条块整个被吃掉了；丢了它比让内核把它当 EOF 好。
      this.deps.log(`${fds.length} file descriptor(s) arrived with no forwarded message`)
    }
  }

  private onClientMessage(message: WaylandMessage): Buffer[] {
    // 有事务挂着时，除了属于它的请求，其它请求先让事务按普通窗口落定。
    const object = this.objects.get(message.objectId)
    const owned = object
      ? Boolean(this.ownerOf(message) ?? this.pendingByToplevelArgument(object, message))
      : false
    const prefix = this.pendingRoles.length > 0 && !owned
      ? this.flushPendingRoles(`an unrelated request arrived (${object?.iface ?? 'unknown'}.${message.opcode})`)
      : []

    return [...prefix, ...this.dispatchClientMessage(message)]
  }

  /** 这条请求属于哪个正在判定的角色；不属于任何角色时返回 `undefined`。 */
  private ownerOf(message: WaylandMessage): PendingRole | undefined {
    const object = this.objects.get(message.objectId)
    if (!object)
      return undefined

    const pending = this.pendingRoles.find(role =>
      role.xdgSurfaceId === message.objectId
      || role.toplevelId === message.objectId
      || role.surfaceId === message.objectId,
    )
    if (!pending)
      return undefined

    // 事务自己的对象上又分配新对象（例如 frame）说明顺序已经和事务对不上，先落定再走，
    // 否则新对象的号会出现在被压着的构造函数之前，合成器的对象表就出洞了。
    if (object.iface === 'wl_surface' && createsObject(object.iface, message.opcode))
      return undefined
    if (object.iface === 'xdg_surface' && message.opcode === XDG_SURFACE.getPopup)
      return undefined

    return pending
  }

  /** 装饰和图标请求点名了一个还没定角色的 toplevel，它们属于那个事务。 */
  private pendingByToplevelArgument(object: ClientObject, message: WaylandMessage): PendingRole | undefined {
    if (this.pendingRoles.length === 0)
      return undefined

    const reader = new ArgumentReader(message.payload)
    let toplevelId: number | undefined

    if (object.iface === 'zxdg_decoration_manager_v1' && message.opcode === DECORATION_MANAGER.getToplevelDecoration) {
      reader.object() // 新建的装饰对象
      toplevelId = reader.object()
    }
    else if (object.iface === 'xdg_toplevel_icon_manager_v1' && message.opcode === ICON_MANAGER.setIcon) {
      toplevelId = reader.object()
    }

    if (toplevelId === undefined)
      return undefined

    return this.pendingRoles.find(role => role.toplevelId === toplevelId)
  }

  private dispatchClientMessage(message: WaylandMessage): Buffer[] {
    if (message.objectId === 1)
      return this.onDisplayRequest(message)

    const object = this.objects.get(message.objectId)
    if (!object)
      return [message.raw]

    switch (object.iface) {
      case 'wl_registry': return this.onRegistryRequest(message)
      case 'wl_compositor': return this.onCompositorRequest(message)
      case 'wl_seat': return this.onSeatRequest(message)
      case 'wl_surface': return this.onSurfaceRequest(message)
      case 'xdg_wm_base': return this.onXdgWmBaseRequest(message)
      case 'xdg_surface': return this.onXdgSurfaceRequest(message, object)
      case 'xdg_toplevel': return this.onXdgToplevelRequest(message, object)
      case 'zxdg_decoration_manager_v1': return this.onDecorationManagerRequest(message)
      case 'zxdg_toplevel_decoration_v1': return this.onDecorationRequest(message, object)
      case 'xdg_toplevel_icon_manager_v1': return this.onIconManagerRequest(message)
      case 'xdg_activation_v1': return this.onActivationRequest(message)
      // 层表面在客户端眼里是 toplevel，这类对象不会有请求走到这里。
      case 'zwlr_layer_surface_v1': return []
      default: return [message.raw]
    }
  }

  private onDisplayRequest(message: WaylandMessage): Buffer[] {
    const reader = new ArgumentReader(message.payload)
    if (message.opcode === WL_DISPLAY.getRegistry) {
      const registryId = reader.object()
      this.objects.set(registryId, { iface: 'wl_registry' })
      // 客户端只有一个 registry；代理绑定层表面全局时复用它。
      this.registryId = registryId
    }
    else if (message.opcode === WL_DISPLAY.sync) {
      this.objects.set(reader.object(), { iface: 'wl_callback' })
    }
    return [message.raw]
  }

  private onRegistryRequest(message: WaylandMessage): Buffer[] {
    if (message.opcode !== WL_REGISTRY.bind)
      return [message.raw]

    const reader = new ArgumentReader(message.payload)
    reader.uint() // global 名字
    const iface = reader.string()
    reader.uint() // 版本
    const id = reader.object()

    this.objects.set(id, { iface })
    return [message.raw]
  }

  private onCompositorRequest(message: WaylandMessage): Buffer[] {
    const id = new ArgumentReader(message.payload).object()

    if (message.opcode === WL_COMPOSITOR.createSurface) {
      this.objects.set(id, { iface: 'wl_surface' })
      this.surfaces.set(id, {})
    }
    else if (message.opcode === WL_COMPOSITOR.createRegion) {
      this.objects.set(id, { iface: 'wl_region' })
    }

    return [message.raw]
  }

  private onSeatRequest(message: WaylandMessage): Buffer[] {
    const iface = message.opcode === WL_SEAT.getPointer
      ? 'wl_pointer'
      : message.opcode === WL_SEAT.getKeyboard
        ? 'wl_keyboard'
        : message.opcode === WL_SEAT.getTouch ? 'wl_touch' : undefined

    if (iface)
      this.objects.set(new ArgumentReader(message.payload).object(), { iface })

    return [message.raw]
  }

  private onSurfaceRequest(message: WaylandMessage): Buffer[] {
    const pending = this.pendingRoles.find(role => role.surfaceId === message.objectId)

    // 角色在 commit 之前还没定，说明没有标题认领这个窗口，按普通窗口处置。
    if (pending && message.opcode === WL_SURFACE.commit)
      return [...this.flushPendingRoles('the surface committed before a title named it'), message.raw]

    if (message.opcode === WL_SURFACE.frame)
      this.objects.set(new ArgumentReader(message.payload).object(), { iface: 'wl_callback' })
    else if (message.opcode === WL_SURFACE.destroy)
      this.forgetSurface(message.objectId)

    return [message.raw]
  }

  private onXdgWmBaseRequest(message: WaylandMessage): Buffer[] {
    if (message.opcode !== XDG_WM_BASE.getXdgSurface)
      return [message.raw]

    const reader = new ArgumentReader(message.payload)
    const xdgSurfaceId = reader.object()
    const surfaceId = reader.object()

    this.objects.set(xdgSurfaceId, { iface: 'xdg_surface' })

    const surface = this.surfaces.get(surfaceId) ?? {}
    this.surfaces.set(surfaceId, surface)

    const pending: PendingRole = { surfaceId, xdgSurfaceId, held: [message.raw], decorations: [] }
    surface.pending = pending
    this.pendingRoles.push(pending)

    return []
  }

  private onXdgSurfaceRequest(message: WaylandMessage, object: ClientObject): Buffer[] {
    if (object.windowId) {
      const window = this.windows.get(object.windowId)
      if (!window)
        return []

      if (message.opcode === XDG_SURFACE.ackConfigure) {
        // 合成器只认层表面的 ack。
        const serial = new ArgumentReader(message.payload).uint()
        return [buildMessage(window.layerSurfaceId, LAYER_SURFACE.ackConfigure, [serial])]
      }

      if (message.opcode === XDG_SURFACE.destroy) {
        this.closeWindow(window.windowId)
        return []
      }

      // 层表面没有窗口几何，也没有子弹出；这些都是只有 toplevel 才有的请求。
      return []
    }

    const pending = this.pendingRoles.find(role => role.xdgSurfaceId === message.objectId)
    if (!pending)
      return [message.raw]

    if (message.opcode === XDG_SURFACE.getToplevel) {
      const toplevelId = new ArgumentReader(message.payload).object()
      this.objects.set(toplevelId, { iface: 'xdg_toplevel' })
      pending.toplevelId = toplevelId
      pending.held.push(message.raw)

      // 这个 surface 之前已经定过角色（窗口隐藏后再显示），直接沿用。
      const decision = this.surfaces.get(pending.surfaceId)?.decision
      if (decision?.layer && decision.windowId)
        return this.convert(pending, decision.windowId)
      if (decision)
        return this.flushPendingRoles('this surface is an ordinary toplevel')

      return []
    }

    pending.held.push(message.raw)
    return this.guardPendingSize(pending)
  }

  private onXdgToplevelRequest(message: WaylandMessage, object: ClientObject): Buffer[] {
    if (object.windowId) {
      const window = this.windows.get(object.windowId)
      if (!window)
        return []

      switch (message.opcode) {
        case XDG_TOPLEVEL.move:
          this.beginGesture(window)
          return []
        // 层表面的尺寸由应用设置，跟着合成器拖动改尺寸会让缓冲区和层表面尺寸对不上。
        case XDG_TOPLEVEL.resize:
          this.deps.log(`ignoring a compositor resize for ${window.windowId}: the app sets the size`)
          return []
        case XDG_TOPLEVEL.destroy:
          this.destroyLayerSurface(window)
          return []
        // set_title / set_app_id / set_parent / set_*size / set_fullscreen 之类对层表面都没有意义。
        default:
          return []
      }
    }

    const pending = this.pendingRoles.find(role => role.toplevelId === message.objectId)
    if (!pending)
      return [message.raw]

    if (message.opcode === XDG_TOPLEVEL.setTitle) {
      const parsed = parseWindowTitle(new ArgumentReader(message.payload).string())
      const policy = parsed ? this.deps.policy(parsed.windowId) : undefined

      if (!parsed || !policy)
        return [...this.flushPendingRoles('the title names no managed window'), message.raw]

      return this.convert(pending, parsed.windowId)
    }

    // 角色还没定，构造阶段的属性先压着。
    pending.held.push(message.raw)
    return this.guardPendingSize(pending)
  }

  private onDecorationManagerRequest(message: WaylandMessage): Buffer[] {
    if (message.opcode !== DECORATION_MANAGER.getToplevelDecoration)
      return [message.raw]

    const reader = new ArgumentReader(message.payload)
    const decorationId = reader.object()
    const toplevelId = reader.object()

    // 构造阶段的装饰请求要跟着角色一起判定，先压着。
    const pending = this.pendingRoles.find(role => role.toplevelId === toplevelId)
    if (pending) {
      pending.held.push(message.raw)
      pending.decorations.push(decorationId)
      return []
    }

    const windowId = this.objects.get(toplevelId)?.windowId
    if (!windowId)
      return [message.raw]

    // 合成器那边没有这个 toplevel，装饰对象建不出来：用 sync 占住号，再自己回一条客户端装饰。
    this.objects.set(decorationId, { iface: 'zxdg_toplevel_decoration_v1', windowId })
    return [
      this.plugId(decorationId),
      buildMessage(decorationId, DECORATION_EVENT.configure, [DECORATION_MODE_CLIENT_SIDE]),
    ]
  }

  private onDecorationRequest(_message: WaylandMessage, _object: ClientObject): Buffer[] {
    // set_mode / destroy 对着一个只有客户端知道的对象，吃掉。
    return []
  }

  private onIconManagerRequest(message: WaylandMessage): Buffer[] {
    const toplevelId = new ArgumentReader(message.payload).object()

    const pending = this.pendingRoles.find(role => role.toplevelId === toplevelId)
    if (pending) {
      pending.held.push(message.raw)
      return []
    }

    // 图标只能挂到合成器知道的 toplevel 上，转换过的窗口没有。
    return this.objects.get(toplevelId)?.windowId ? [] : [message.raw]
  }

  private onActivationRequest(message: WaylandMessage): Buffer[] {
    if (message.opcode !== ACTIVATION.activate)
      return [message.raw]

    const reader = new ArgumentReader(message.payload)
    reader.string()
    const surfaceId = reader.object()

    // activate 会点名一个 xdg_surface，转换过的窗口在合成器那边没有这个对象，点名就是协议错误。
    return this.surfaces.get(surfaceId)?.decision?.layer ? [] : [message.raw]
  }

  // ── 角色转换 ────────────────────────────────────────────────────────

  private convert(pending: PendingRole, windowId: string): Buffer[] {
    const policy = this.deps.policy(windowId)
    if (!policy)
      return this.flushPendingRoles('no policy for this window')

    // 第一次转换时把层表面全局绑到 xdg_surface 的号上：这个号是客户端刚分配的下一个号，
    // 合成器的对象表正好在这里长一格；而客户端以为它是 xdg_surface，销毁请求会被吃掉，号不会再被用第二次。
    const bindMessages: Buffer[] = []
    if (this.layerShellGlobal === undefined) {
      const info = this.layerShellGlobalInfo
      if (!info || this.registryId === undefined) {
        this.deps.onEvent({ type: 'refused', windowId, reason: 'the compositor has no zwlr_layer_shell_v1' })
        return this.flushPendingRoles('the compositor has no layer shell')
      }

      const shellId = pending.xdgSurfaceId
      this.layerShellGlobal = shellId
      this.objects.set(shellId, { iface: 'zwlr_layer_shell_v1' })
      bindMessages.push(buildMessage(this.registryId, WL_REGISTRY.bind, [
        info.name,
        'zwlr_layer_shell_v1',
        Math.min(info.version, 4),
        shellId,
      ]))
    }

    const layerShellGlobal = this.layerShellGlobal

    const { options } = policy
    const geometry = normalizeGeometry(policy.geometry)
    const { x, y, width, height } = geometry
    const layerSurfaceId = pending.toplevelId
    if (layerSurfaceId === undefined)
      return this.flushPendingRoles('no toplevel id to reuse')

    const outputId = options.output ? this.outputIdsByName.get(options.output) ?? 0 : 0

    // 客户端的 toplevel 号直接拿来当层表面的号：合成器的对象表要稠密，只有这样才不留洞。
    this.objects.set(layerSurfaceId, { iface: 'xdg_toplevel', windowId })
    this.objects.set(pending.xdgSurfaceId, { iface: 'xdg_surface', windowId })
    this.layerSurfaces.set(layerSurfaceId, windowId)

    const surface = this.surfaces.get(pending.surfaceId) ?? {}
    surface.decision = { layer: true, windowId }
    surface.pending = undefined
    this.surfaces.set(pending.surfaceId, surface)

    this.windows.set(windowId, {
      windowId,
      surfaceId: pending.surfaceId,
      xdgSurfaceId: pending.xdgSurfaceId,
      layerSurfaceId,
      options,
      geometry,
      outputId,
      outputName: options.output,
    })

    this.pendingRoles = this.pendingRoles.filter(role => role !== pending)
    this.deps.onEvent({ type: 'attached', windowId })

    // 顺序要紧：合成器的对象表只接受「下一个」号，所以代理注入的对象必须按号从小到大创建，
    // 否则中间那个洞会让服务端拒绝后面那个 new_id（表现为 sync 的 invalid arguments）。
    const out: Buffer[] = [...bindMessages]

    if (pending.xdgSurfaceId !== layerShellGlobal)
      out.push(this.plugId(pending.xdgSurfaceId))

    out.push(
      buildMessage(layerShellGlobal, LAYER_SHELL.getLayerSurface, [
        layerSurfaceId,
        pending.surfaceId,
        outputId,
        LAYER[options.layer ?? 'overlay'],
        options.namespace,
      ]),
      buildMessage(layerSurfaceId, LAYER_SURFACE.setAnchor, [ANCHOR.top | ANCHOR.left]),
      // -1：不占工作区，浮层不该影响别的窗口的布局。
      buildMessage(layerSurfaceId, LAYER_SURFACE.setExclusiveZone, [-1 >>> 0]),
      buildMessage(layerSurfaceId, LAYER_SURFACE.setMargin, [y, 0, 0, x]),
      buildMessage(layerSurfaceId, LAYER_SURFACE.setSize, [width, height]),
      buildMessage(layerSurfaceId, LAYER_SURFACE.setKeyboardInteractivity, [KEYBOARD[options.keyboard ?? 'none']]),
    )

    // 装饰对象一般是客户端最后分配的号，占号的 sync 排在层表面之后。
    // 客户端装饰的 configure 要发给客户端，不能和上面那些发往合成器的消息混在一起。
    const toClient: Buffer[] = []
    for (const decorationId of [...pending.decorations].sort((left, right) => left - right)) {
      this.objects.set(decorationId, { iface: 'zxdg_toplevel_decoration_v1', windowId })
      out.push(this.plugId(decorationId))
      toClient.push(buildMessage(decorationId, DECORATION_EVENT.configure, [DECORATION_MODE_CLIENT_SIDE]))
    }

    if (toClient.length > 0)
      this.deps.sendToClient(Buffer.concat(toClient), [])

    return out
  }

  /** 用 `wl_display.sync` 占住一个被吃掉的对象号，并接管它的 done / delete_id。 */
  private plugId(id: number): Buffer {
    this.plugs.set(id, { freed: false })
    return buildMessage(1, WL_DISPLAY.sync, [id])
  }

  private guardPendingSize(pending: PendingRole): Buffer[] {
    // 压太多说明这个 surface 一直等不到标题，落定成普通窗口，别把连接憋死。
    if (pending.held.length > 32)
      return this.flushPendingRoles('too many requests without a title')
    return []
  }

  /** 把挂起的事务按普通 toplevel 放行，返回要写回服务端的字节。 */
  private flushPendingRoles(reason: string): Buffer[] {
    if (this.pendingRoles.length === 0)
      return []

    const out: Buffer[] = []
    for (const pending of this.pendingRoles) {
      const surface = this.surfaces.get(pending.surfaceId)
      if (surface) {
        surface.decision ??= { layer: false }
        surface.pending = undefined
      }
      out.push(...pending.held)
    }

    this.pendingRoles = []
    this.deps.log(`role kept as an ordinary toplevel: ${reason}`)
    return out
  }

  // ── 合成器 → 客户端 ─────────────────────────────────────────────────

  handleServerData(data: Buffer, fds: readonly number[]): void {
    if (this.closed)
      return

    const joined = this.serverRest.length > 0 ? Buffer.concat([this.serverRest, data]) : data
    const { messages, rest } = parseMessages(joined)
    this.serverRest = rest

    const out: Buffer[] = []
    for (const message of messages)
      out.push(...this.onServerMessage(message))

    if (out.length > 0 || fds.length > 0)
      this.deps.sendToClient(Buffer.concat(out), fds)
  }

  private onServerMessage(message: WaylandMessage): Buffer[] {
    if (message.objectId === 1)
      return this.onDisplayEvent(message)

    // 代理自己绑的层表面全局：客户端不知道它存在，它的事件也不能露出去。
    if (message.objectId === this.layerShellGlobal)
      return []

    // 占号用的 callback：合成器发完 done 就自己把它销毁了，客户端也不用知道它存在。
    // 这里只吃掉 done，随后的 delete_id 同样吃掉，客户端的号就永远拿不回去。
    if (this.plugs.has(message.objectId) && message.opcode === WL_CALLBACK.done)
      return []

    const object = this.objects.get(message.objectId)

    switch (object?.iface) {
      case 'wl_registry': return this.onRegistryEvent(message)
      case 'wl_output': return this.onOutputEvent(message)
      case 'wl_pointer': return this.onPointerEvent(message)
      default:
        break
    }

    const windowId = this.layerSurfaces.get(message.objectId)
    if (windowId)
      return this.onLayerSurfaceEvent(message, windowId)

    return [message.raw]
  }

  private onDisplayEvent(message: WaylandMessage): Buffer[] {
    if (message.opcode === 0) {
      const reader = new ArgumentReader(message.payload)
      const object = reader.object()
      const code = reader.uint()
      // 合成器的协议错误会让客户端直接断开，日志里留一条现场。
      this.deps.log(`the compositor rejected us: object=${object} code=${code} ${reader.string()}`)
    }
    if (message.opcode === WL_DISPLAY.deleteId) {
      const id = new ArgumentReader(message.payload).uint()
      const plug = this.plugs.get(id)
      if (plug) {
        plug.freed = true
        return []
      }
    }

    return [message.raw]
  }

  private onRegistryEvent(message: WaylandMessage): Buffer[] {
    if (message.opcode === WL_REGISTRY.global) {
      const reader = new ArgumentReader(message.payload)
      const name = reader.uint()
      const iface = reader.string()
      const version = reader.uint()
      // Chromium 不认识层表面，不会自己绑它，所以代理替它记住全局。
      if (iface === 'zwlr_layer_shell_v1')
        this.layerShellGlobalInfo = { name, version }
    }

    return [message.raw]
  }

  private onOutputEvent(message: WaylandMessage): Buffer[] {
    const state = this.outputs.get(message.objectId) ?? { width: 0, height: 0, scale: 1, transform: 0 }
    const reader = new ArgumentReader(message.payload)

    if (message.opcode === WL_OUTPUT.geometry) {
      reader.int() // x
      reader.int() // y
      reader.int() // 物理宽
      reader.int() // 物理高
      reader.int() // 子像素
      reader.string() // 厂商
      reader.string() // 型号
      state.transform = reader.int()
    }
    else if (message.opcode === WL_OUTPUT.mode) {
      reader.uint() // flags
      state.width = reader.int()
      state.height = reader.int()
      reader.int() // refresh
    }
    else if (message.opcode === WL_OUTPUT.scale) {
      state.scale = Math.max(1, reader.int())
    }
    else if (message.opcode === WL_OUTPUT.name) {
      state.name = reader.string()
      this.outputIdsByName.set(state.name, message.objectId)
    }

    this.outputs.set(message.objectId, state)
    return [message.raw]
  }

  private onPointerEvent(message: WaylandMessage): Buffer[] {
    const window = this.gestureWindow()

    if (message.opcode === WL_POINTER.enter) {
      const reader = new ArgumentReader(message.payload)
      reader.uint() // serial
      reader.object() // surface
      this.pointer = { x: Math.round(reader.fixed()), y: Math.round(reader.fixed()), known: true }
    }
    else if (message.opcode === WL_POINTER.motion) {
      const reader = new ArgumentReader(message.payload)
      this.pointer = { x: Math.round(reader.fixed()), y: Math.round(reader.fixed()), known: true }

      if (window?.gesture)
        this.dragTo(window)
    }
    else if (message.opcode === WL_POINTER.button) {
      const reader = new ArgumentReader(message.payload)
      reader.uint() // serial
      reader.uint() // time
      reader.uint() // button
      const pressed = reader.uint() !== POINTER_BUTTON_RELEASED

      if (!pressed && window?.gesture)
        this.endGesture(window)
    }
    else if (message.opcode === WL_POINTER.leave) {
      if (window?.gesture)
        this.endGesture(window)
    }

    return [message.raw]
  }

  private onLayerSurfaceEvent(message: WaylandMessage, windowId: string): Buffer[] {
    const window = this.windows.get(windowId)
    if (!window)
      return []

    if (message.opcode === LAYER_SURFACE_EVENT.configure) {
      const reader = new ArgumentReader(message.payload)
      const serial = reader.uint()
      const width = reader.uint()
      const height = reader.uint()

      if (width > 0 && height > 0)
        window.geometry = { ...window.geometry, width, height }

      // Chromium 等的是 xdg_surface.configure，然后是 xdg_toplevel.configure；ack 还是走原来的号。
      return [
        buildMessage(window.xdgSurfaceId, XDG_SURFACE_EVENT.configure, [serial]),
        buildMessage(window.layerSurfaceId, XDG_TOPLEVEL_EVENT.configure, [width, height, Buffer.alloc(0)]),
      ]
    }

    if (message.opcode === LAYER_SURFACE_EVENT.closed) {
      // toplevel 的 close 是 opcode 1，客户端收到后会自己销毁窗口。
      return [buildMessage(window.layerSurfaceId, XDG_TOPLEVEL_EVENT.close, [])]
    }

    return []
  }

  // ── 拖动 ────────────────────────────────────────────────────────────

  private gestureWindow(): LayerWindow | undefined {
    for (const window of this.windows.values()) {
      if (window.gesture)
        return window
    }
    return undefined
  }

  private beginGesture(window: LayerWindow): void {
    if (!this.pointer.known) {
      this.deps.log(`cannot drag ${window.windowId}: the pointer position is unknown`)
      return
    }

    window.gesture = {
      startPointer: { ...this.pointer },
      startGeometry: { ...window.geometry },
    }
  }

  private dragTo(window: LayerWindow): void {
    const gesture = window.gesture
    if (!gesture)
      return

    // 每个事件都从按下时算起：合成器在拖动期间给的坐标还是按下时那套几何下的，
    // 累加上一步会把一次拖动放大成事件个数倍。
    const next = this.clampToOutput(window, {
      x: gesture.startGeometry.x + Math.round(this.pointer.x - gesture.startPointer.x),
      y: gesture.startGeometry.y + Math.round(this.pointer.y - gesture.startPointer.y),
      width: gesture.startGeometry.width,
      height: gesture.startGeometry.height,
    })

    if (next.x === window.geometry.x && next.y === window.geometry.y)
      return

    window.geometry = next
    this.pushGeometry(window)
  }

  private endGesture(window: LayerWindow): void {
    window.gesture = undefined
    this.deps.onEvent({ type: 'geometry', windowId: window.windowId, geometry: window.geometry })
  }

  /** 位置限制在输出内。层表面换不了输出，拖到边上就停住。 */
  private clampToOutput(window: LayerWindow, geometry: LayerShellGeometry): LayerShellGeometry {
    // 应用没指定输出时合成器自己挑；只有一块屏幕时就用它，不然拖动没法知道边界在哪。
    const output = this.outputs.get(window.outputId)
      ?? (this.outputs.size === 1 ? [...this.outputs.values()][0] : undefined)
    if (!output || output.width <= 0)
      return geometry

    const scale = Math.max(1, output.scale)
    const rotated = output.transform === 1 || output.transform === 3
    const logicalWidth = Math.round((rotated ? output.height : output.width) / scale)
    const logicalHeight = Math.round((rotated ? output.width : output.height) / scale)

    return {
      ...geometry,
      x: Math.min(Math.max(0, geometry.x), Math.max(0, logicalWidth - geometry.width)),
      y: Math.min(Math.max(0, geometry.y), Math.max(0, logicalHeight - geometry.height)),
    }
  }

  private pushGeometry(window: LayerWindow): void {
    const { x, y, width, height } = window.geometry
    this.deps.sendToServer(Buffer.concat([
      buildMessage(window.layerSurfaceId, LAYER_SURFACE.setMargin, [y, 0, 0, x]),
      buildMessage(window.layerSurfaceId, LAYER_SURFACE.setSize, [width, height]),
      // 层表面的状态要客户端 commit 才生效；代理替它补一次 commit，空闲的窗口也能跟上拖动。
      buildMessage(window.surfaceId, WL_SURFACE.commit, []),
    ]), [])
  }

  // ── 控制通道 ────────────────────────────────────────────────────────

  /** 应用改窗口几何：位置走 margin，尺寸走 set_size。 */
  applyGeometry(windowId: string, geometry: LayerShellGeometry): boolean {
    const window = this.windows.get(windowId)
    if (!window)
      return false

    window.geometry = this.clampToOutput(window, normalizeGeometry(geometry))
    this.pushGeometry(window)
    this.deps.onEvent({ type: 'geometry', windowId, geometry: window.geometry })
    return true
  }

  applyCommand(command: ProxyCommand): void {
    if (command.type === 'geometry')
      this.applyGeometry(command.windowId, command.geometry)
  }

  hasWindow(windowId: string): boolean {
    return this.windows.has(windowId)
  }

  // ── 清理 ────────────────────────────────────────────────────────────

  private destroyLayerSurface(window: LayerWindow): void {
    this.deps.sendToServer(buildMessage(window.layerSurfaceId, LAYER_SURFACE.destroy, []), [])
    this.layerSurfaces.delete(window.layerSurfaceId)
  }

  private closeWindow(windowId: string): void {
    const window = this.windows.get(windowId)
    if (!window)
      return

    this.windows.delete(windowId)
    // 第一个窗口的 xdg_surface 号就是代理绑层表面全局用的号，映射要留着：
    // 删掉之后客户端若再来一个请求，就会被当成对全局对象的请求转发出去。
    if (window.xdgSurfaceId !== this.layerShellGlobal)
      this.objects.delete(window.xdgSurfaceId)
    this.deps.onEvent({ type: 'detached', windowId })
  }

  private forgetSurface(surfaceId: number): void {
    this.surfaces.delete(surfaceId)

    for (const window of [...this.windows.values()]) {
      if (window.surfaceId === surfaceId)
        this.closeWindow(window.windowId)
    }
  }

  markClosed(): void {
    this.closed = true
  }
}
