import { createPinia, disposePinia } from 'pinia'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { render } from 'vitest-browser-vue'
import { nextTick } from 'vue'
import { createI18n } from 'vue-i18n'

import ControlsIslandFadeOnHover from './controls-island-fade-on-hover.vue'

const { probe } = vi.hoisted(() => ({ probe: { wayland: false, calls: 0 } }))

vi.mock('@proj-airi/electron-vueuse', async () => {
  const { electronAppIsWayland } = await import('../../../../shared/eventa')
  return {
    useElectronEventaInvoke: (event: unknown) => event === electronAppIsWayland
      ? vi.fn(async () => {
          probe.calls += 1
          return probe.wayland
        })
      : vi.fn(async () => undefined),
  }
})

vi.mock('@proj-airi/stage-ui/composables/use-analytics', () => ({
  useAnalytics: () => ({ trackControlsIslandAction: vi.fn() }),
}))

// 这条开关平时挂在控制岛里，取方向的那个注入只在岛里面才有。
vi.mock('./use-controls-island-placement', async () => {
  const { ref } = await import('vue')
  return { useControlsIslandPlacement: () => ({ isLeft: ref(false), isTop: ref(false) }) }
})

afterEach(() => {
  probe.wayland = false
  probe.calls = 0
})

function renderSwitch() {
  const pinia = createPinia()
  onTestFinished(() => disposePinia(pinia))
  return render(ControlsIslandFadeOnHover, {
    global: { plugins: [pinia, createI18n({ legacy: false, locale: 'en' })] },
  })
}

describe('controls island fade on hover', () => {
  // Wayland 上没有 setIgnoreMouseEvents，淡出之后窗口照旧吃点击，这个开关做不到它承诺的事。
  it('stays hidden on Wayland', async () => {
    probe.wayland = true
    const view = renderSwitch()

    await vi.waitFor(() => expect(probe.calls).toBe(1))
    await nextTick()

    expect(view.container.querySelector('button')).toBeNull()
  })

  it('offers the switch elsewhere', async () => {
    const view = renderSwitch()

    await vi.waitFor(() => expect(view.container.querySelector('button')).not.toBeNull())
    // 提示语是这条开关唯一的可见文案，图标是纯装饰。
    expect(view.container.innerHTML).toContain('tamagotchi.stage.controls-island.fade-on-hover.enable')
  })
})
