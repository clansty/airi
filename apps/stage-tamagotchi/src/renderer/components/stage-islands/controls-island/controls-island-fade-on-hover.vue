<script setup lang="ts">
import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { useAnalytics } from '@proj-airi/stage-ui/composables/use-analytics'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import ControlButtonTooltip from './control-button-tooltip.vue'
import ControlButton from './control-button.vue'

import { noticeWindowEventa } from '../../../../shared/eventa'
import { useAppIsWayland } from '../../../composables/use-app-is-wayland'
import { useControlsIslandStore } from '../../../stores/controls-island'

interface Props {
  iconClass?: string
  buttonStyle?: string
}

const props = withDefaults(defineProps<Props>(), {
  iconClass: 'size-5',
})

const uiStore = useControlsIslandStore()
const enabled = computed(() => uiStore.fadeOnHoverEnabled)
// NOTICE:
// Wayland 上这个开关做不到它承诺的事：Electron 的 `setIgnoreMouseEvents` 在那里没有实现，让不开就只能淡出，
// 而淡了却照旧吃点击，用户会以为穿透了。先藏起来，等能拿到全局光标位置（合成器的 cursor capture）再放出来。
// Source: https://github.com/niri-wm/niri/pull/4554、`resolveFadeOnHoverInteraction` 里 `clickThroughAvailable`。
// Removal: 淡出之后窗口真的能不再接收指针（层表面按输入区域让开）。
const isWayland = useAppIsWayland()
const { t } = useI18n()
const { trackControlsIslandAction } = useAnalytics()

const requestNotice = useElectronEventaInvoke(noticeWindowEventa.openWindow)
const NOTICE_WINDOW_ID = 'fade-on-hover'

function setFadeOnHoverEnabled(value: boolean) {
  if (value)
    uiStore.enableFadeOnHover()
  else
    uiStore.disableFadeOnHover()

  trackControlsIslandAction({
    action: value ? 'enable_fade_on_hover' : 'disable_fade_on_hover',
  })
}

async function handleToggle() {
  if (enabled.value) {
    setFadeOnHoverEnabled(false)
    return
  }

  if (uiStore.dontShowItAgainNoticeFadeOnHover) {
    setFadeOnHoverEnabled(true)
    return
  }

  try {
    const acknowledged = await requestNotice({
      id: NOTICE_WINDOW_ID,
      route: '/notice/fade-on-hover',
      type: 'fade-on-hover',
    })
    if (acknowledged) {
      setFadeOnHoverEnabled(true)
    }
  }
  catch (error) {
    console.error('Failed to open fade-on-hover notice:', error)
  }
}
</script>

<template>
  <ControlButtonTooltip v-if="!isWayland">
    <ControlButton
      :button-style="props.buttonStyle"
      :aria-label="enabled ? t('tamagotchi.stage.controls-island.fade-on-hover.disable') : t('tamagotchi.stage.controls-island.fade-on-hover.enable')"
      :class="{ 'border-primary-300/70 shadow-[0_10px_24px_rgba(0,0,0,0.22)]': enabled }"
      @click="handleToggle"
    >
      <Transition name="fade" mode="out-in">
        <div v-if="enabled" i-ph:eye :class="props.iconClass" text="primary-700 dark:primary-300" />
        <div v-else i-ph:eye-slash :class="props.iconClass" text="neutral-800 dark:neutral-300" />
      </Transition>
    </ControlButton>

    <template #tooltip>
      {{ enabled ? t('tamagotchi.stage.controls-island.fade-on-hover.disable') : t('tamagotchi.stage.controls-island.fade-on-hover.enable') }}
    </template>
  </ControlButtonTooltip>
</template>
