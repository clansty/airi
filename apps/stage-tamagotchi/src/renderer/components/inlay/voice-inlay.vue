<script setup lang="ts">
import type { VoicePresenceView } from '@proj-airi/stage-ui/components/scenarios/chat'

import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { VoicePresence } from '@proj-airi/stage-ui/components/scenarios/chat'
import { useEventListener, useResizeObserver, useTimeoutFn } from '@vueuse/core'
import { nextTick, onMounted, shallowRef, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { electronInlayReturnHome, electronLayerShellInputRegion } from '../../../shared/eventa'
import { useChatFloatingClickThrough } from '../../composables/use-chat-floating-click-through'
import { useGlobalEscape } from '../../composables/use-global-escape'

/**
 * Time without content before a dragged inlay returns to its home position.
 * The window paints nothing then, so the move is invisible, and the next capsule appears at home.
 */
const RETURN_HOME_DELAY_MS = 5000

const { t } = useI18n()
const presence = useTemplateRef<InstanceType<typeof VoicePresence>>('presence')
const returnHome = useElectronEventaInvoke(electronInlayReturnHome)
const setInputRegion = useElectronEventaInvoke(electronLayerShellInputRegion)
// The window stays above other apps, so only what the page paints takes the pointer.
const { hitTest } = useChatFloatingClickThrough({ pinned: true })

/** The view that `VoicePresence` paints. The window owns hit testing and its home position around it. */
const shown = shallowRef<VoicePresenceView>('hidden')

// Content that appears or moves under a still cursor changes what the cursor is over.
// The hit test treats zero opacity as unpainted, and a transition starts or ends at zero opacity.
// So `after-enter` runs it again once a card is visible, and `after-leave` once the card is gone.
watch(shown, () => nextTick(() => hitTest()), { flush: 'post' })

/**
 * 层表面模式下，穿透由窗口的输入区域说了算：报道弹窗实际画出来的那块矩形，其余地方让给下面的应用。
 *
 * Electron 的 `setIgnoreMouseEvents` 在 Wayland 上没有实现，`useChatFloatingClickThrough` 那套在那里是空操作。
 */
function reportInputRegion() {
  // The view mounts and unmounts its surface with a transition, so the element is null while it paints nothing.
  const element = presence.value?.surface
  if (shown.value === 'hidden' || !(element instanceof Element)) {
    void setInputRegion({ rects: [] })
    return
  }

  const rect = element.getBoundingClientRect()
  void setInputRegion({
    rects: [{ x: rect.x, y: rect.y, width: rect.width, height: rect.height }],
  })
}

onMounted(reportInputRegion)
watch(shown, () => nextTick(reportInputRegion), { flush: 'post' })
// The capsule grows into the card, and both animate their size. The region follows every step of the way, so a click
// lands on what the user sees.
useResizeObserver(() => presence.value?.surface, () => reportInputRegion())
useEventListener(window, 'resize', () => nextTick(reportInputRegion))

function onAfterEnter() {
  hitTest()
  // The enter animation scales the view, and a scaled rect is not the region to report. The rect settles when it ends.
  void nextTick(reportInputRegion)
}

// Speech or a draft keeps the inlay where the user dragged it. Only an idle inlay returns home.
const homeTimer = useTimeoutFn(() => void returnHome(), RETURN_HOME_DELAY_MS, { immediate: false })
watch(shown, (value) => {
  if (value === 'hidden')
    homeTimer.start()
  else
    homeTimer.stop()
}, { immediate: true })

// Speech often starts while another app has focus, so Escape works from any app while the inlay shows speech.
// The focused inlay also handles Escape in `VoicePresence`. The second call for one press finds nothing to dismiss.
useGlobalEscape('voice-inlay-dismiss', () => shown.value === 'capsule' || shown.value === 'card', () => presence.value?.dismiss())
</script>

<template>
  <!-- The page anchors the inlay to the bottom edge. The space above it is room for the send animation. -->
  <main :class="['h-full w-full flex flex-col items-center justify-end px-4 pb-4', 'bg-transparent text-neutral-900 dark:text-neutral-100']">
    <VoicePresence
      ref="presence"
      data-testid="voice-inlay"
      @shown-change="shown = $event"
      @after-enter="onAfterEnter()"
      @after-leave="hitTest({ removed: true })"
    >
      <template #hint>
        <kbd
          :class="[
            'min-w-6 rounded-md border px-1.5 py-0.5 text-center font-sans text-[11px] leading-none',
            'border-neutral-900/15 bg-neutral-900/5 text-neutral-600',
            'dark:border-white/15 dark:bg-white/8 dark:text-neutral-300',
          ]"
        >esc</kbd>
        <span>{{ t('tamagotchi.stage.inlay.dismiss') }}</span>
      </template>
    </VoicePresence>
  </main>
</template>
