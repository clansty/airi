/** 层表面所在的层，越靠后越靠上。 */
export type LayerShellLayer = 'background' | 'bottom' | 'top' | 'overlay'

/**
 * 键盘交互方式。
 *
 * `none`：只接收指针，键盘焦点留在别的窗口上（浮层应该这样）。
 * `on-demand`：点击时合成器可以给键盘焦点，窗口里能输入文字。
 */
export type LayerShellKeyboard = 'none' | 'on-demand'

/** 一个窗口要变成层表面时，与它自身几何无关的那部分选项。 */
export interface LayerShellWindowOptions {
  /** 层的用途名，合成器调试和规则匹配都用它，例如 `airi-pet`。 */
  namespace: string
  /** 默认 `overlay`，因为桌宠必须盖住全屏窗口。 */
  layer?: LayerShellLayer
  /** 默认 `none`。 */
  keyboard?: LayerShellKeyboard
  /**
   * 层表面创建在哪块屏幕上，用合成器给的名字（例如 `DP-3`）。
   *
   * 层表面的输出在创建时就固定，协议里没有换输出的请求，所以这是唯一能把窗口放到指定屏幕的办法。
   */
  output?: string
  /**
   * 这块屏幕在逻辑坐标下的尺寸，应用自己量到的那一份。
   *
   * 拖动要保证整个窗口留在屏幕里，而 `wl_output` 的 `mode` 除以 `scale` 在分数缩放时会算错
   * （`scale` 是整数，`niri` 那样的 2.56 倍只能算出个错的长宽比），所以应用给了就以它为准。
   */
  outputSize?: { width: number, height: number }
}

/** 层表面的几何，坐标相对它所在输出的左上角。 */
export interface LayerShellGeometry {
  x: number
  y: number
  width: number
  height: number
}

/** 代理向应用报告的事件。 */
export type LayerShellEvent
  = | { type: 'attached', windowId: string }
    | { type: 'detached', windowId: string }
    | { type: 'geometry', windowId: string, geometry: LayerShellGeometry }
    | { type: 'output', windowId: string, output: string }
    /** 合成器拒绝了层表面角色，这个窗口只能重建才能改用层表面。 */
    | { type: 'refused', windowId: string, reason: string }
    /** 合成器没有 `zwlr_layer_shell_v1`，所有窗口都退回普通窗口。 */
    | { type: 'unavailable', reason: string }
