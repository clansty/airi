import type { LayerShellWindowOptions } from './types'

/**
 * 跟手拖动实测可用的合成器。
 *
 * 拖动是代理把指针位移翻译成 margin，能不能跟手取决于合成器会不会在承载新 margin 的那次 commit 上
 * 就把 surface 摆过去。协议里没有任何回报能判断这件事，所以只能按实测列名单。
 * `niri`、`sway`、`river` 跟手；Hyprland 追不上指针，labwc、Wayfire 会抖，KWin 根本不重排。
 */
const COMPOSITORS_THAT_FOLLOW_A_DRAG = ['niri', 'sway', 'river']

/**
 * 决定用层表面还是普通窗口的环境变量。
 *
 * `1` 强制用，`0` 强制不用；其它值（包括没设）交给合成器名单判断。
 */
export const LAYER_SHELL_CHOICE_ENV = 'AIRI_LAYER_SHELL'

export interface LayerShellDecision {
  use: boolean
  /** 不用时的原因，写日志用。 */
  why: string
}

/**
 * 判断这个会话要不要走层表面。
 *
 * `desktopName` 是多值时用冒号分隔（`KDE:Plasma`），任一项命中名单即可。
 */
export function decideLayerShell(params: {
  desktopName: string | undefined
  choice: string | undefined
}): LayerShellDecision {
  const choice = params.choice?.trim().toLowerCase()
  if (choice === '1' || choice === 'true') {
    return { use: true, why: `${LAYER_SHELL_CHOICE_ENV} asks for it` }
  }
  if (choice === '0' || choice === 'false') {
    return { use: false, why: `${LAYER_SHELL_CHOICE_ENV} asks not to` }
  }

  const desktopName = params.desktopName?.trim() ?? ''
  const followed = desktopName
    .split(':')
    .some(name => COMPOSITORS_THAT_FOLLOW_A_DRAG.includes(name.trim().toLowerCase()))

  if (followed) {
    return { use: true, why: `${desktopName} follows a drag` }
  }

  return { use: false, why: `${desktopName || 'this desktop'} does not follow a drag` }
}

const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/

/**
 * 把窗口选项补成代理能直接用的样子，顺便拒绝发不出去的组合。
 *
 * 名字有长度上限是因为它会进合成器的日志和规则；不合法的名字会被合成器当成协议错误断开连接。
 */
export function normalizeWindowOptions(options: LayerShellWindowOptions): LayerShellWindowOptions {
  if (!NAMESPACE_PATTERN.test(options.namespace)) {
    throw new Error(`layer shell namespace must match ${NAMESPACE_PATTERN}: ${options.namespace}`)
  }

  const layer = options.layer ?? 'overlay'
  const keyboard = options.keyboard ?? 'none'
  const size = options.outputSize

  return {
    namespace: options.namespace,
    layer,
    keyboard,
    output: options.output,
    outputSize: size && size.width > 0 && size.height > 0
      ? { width: Math.round(size.width), height: Math.round(size.height) }
      : undefined,
  }
}

/** 层表面尺寸的上限，`uint32` 的两边都放得下。 */
export function normalizeGeometry(geometry: { x: number, y: number, width: number, height: number }) {
  return {
    x: Math.round(geometry.x),
    y: Math.round(geometry.y),
    // 尺寸为 0 会被合成器理解成「由客户端决定」，那会让层表面跟着缓冲区大小变，位置就不再由 margin 说话。
    width: Math.max(1, Math.round(geometry.width)),
    height: Math.max(1, Math.round(geometry.height)),
  }
}
