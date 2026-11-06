import { computed, onScopeDispose, ref } from 'vue'

export interface UsePointerNearWindowBorderOptions {
  /** 距窗口边缘多少像素之内算「靠近」，与 `useElectronMouseAroundWindowBorder` 同一个含义。 */
  threshold?: number
}

/**
 * 用页面自己的指针事件判断指针是否贴着窗口边缘。
 *
 * 主进程那条指针坐标流在原生 Wayland 上会卡住不动，层表面里窗口位置又变了，
 * 算出来的相对坐标是错的，于是窗口一出现就「贴着边」。页面收到的 pointer 事件没有这个问题：
 * 它本来就只在指针真的压在这个窗口上时才有，正好是边框该亮的时候。
 */
export function usePointerNearWindowBorder(options: UsePointerNearWindowBorderOptions = {}) {
  const threshold = options.threshold ?? 8
  const x = ref(0)
  const y = ref(0)
  const inside = ref(false)

  const onMove = (event: PointerEvent) => {
    x.value = event.clientX
    y.value = event.clientY
    inside.value = true
  }
  const onLeave = () => {
    inside.value = false
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pointermove', onMove, { passive: true })
    document.addEventListener('mouseleave', onLeave)
    onScopeDispose(() => {
      window.removeEventListener('pointermove', onMove)
      document.removeEventListener('mouseleave', onLeave)
    })
  }

  const nearLeft = computed(() => inside.value && x.value <= threshold)
  const nearRight = computed(() => inside.value && window.innerWidth - x.value <= threshold)
  const nearTop = computed(() => inside.value && y.value <= threshold)
  const nearBottom = computed(() => inside.value && window.innerHeight - y.value <= threshold)

  return {
    x,
    y,
    nearLeft,
    nearRight,
    nearTop,
    nearBottom,
    isNearAnyBorder: computed(() => nearLeft.value || nearRight.value || nearTop.value || nearBottom.value),
  }
}
