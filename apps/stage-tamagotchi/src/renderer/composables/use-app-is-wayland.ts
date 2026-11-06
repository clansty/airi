import { errorMessageFrom } from '@moeru/std'
import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { ref } from 'vue'

import { electronAppIsWayland } from '../../shared/eventa'

/**
 * 这个窗口是不是跑在 Wayland 上。
 *
 * 探测失败按「不是」处理：那样最多多显示一个开关，而不是把本来能用的功能藏起来。
 */
export function useAppIsWayland() {
  const isWayland = ref(false)

  void useElectronEventaInvoke(electronAppIsWayland)()
    .then(isWaylandOn => isWayland.value = isWaylandOn)
    .catch(error => console.warn('[Wayland] the platform probe failed, the window is treated as a normal one:', errorMessageFrom(error) ?? 'unknown'))

  return isWayland
}
