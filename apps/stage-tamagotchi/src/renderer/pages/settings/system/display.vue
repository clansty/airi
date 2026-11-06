<route lang="yaml">
meta:
  layout: settings
</route>

<script setup lang="ts">
import type { LayerShellDisplayState } from '../../../../shared/eventa'

import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { Button } from '@proj-airi/ui'
import { computed, onMounted, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'

import { electronLayerShellDisplayGet, electronLayerShellDisplaySet } from '../../../../shared/eventa'

const { t } = useI18n()
const tt = (key: string) => t(`tamagotchi.settings.pages.system.display.${key}`)

const getState = useElectronEventaInvoke(electronLayerShellDisplayGet)
const setState = useElectronEventaInvoke(electronLayerShellDisplaySet)

const state = shallowRef<LayerShellDisplayState>()
const busy = shallowRef(false)

const displays = computed(() => state.value?.displays ?? [])

onMounted(async () => {
  state.value = await getState()
})

async function choose(label: string | undefined) {
  busy.value = true
  try {
    state.value = await setState({ label })
    toast.success(tt('saved'))
  }
  catch (error) {
    console.error('[Layer Shell Display] Failed to save the screen:', error)
    toast.error(tt('failed'))
  }
  finally {
    busy.value = false
  }
}

function describe(label: string, width: number, height: number) {
  return `${label} · ${width}×${height}`
}
</script>

<template>
  <div :class="['flex flex-col gap-4', 'font-normal']">
    <div :class="['text-sm text-neutral-500', 'dark:text-neutral-400']">
      {{ tt('description') }}
    </div>

    <div
      v-if="state && !state.active"
      :class="['rounded-xl bg-amber-50 p-4', 'text-sm text-amber-700', 'dark:bg-amber-950/40 dark:text-amber-300']"
    >
      {{ tt('inactive') }}
    </div>

    <div v-else :class="['flex flex-col gap-2']">
      <Button
        :disabled="busy"
        :class="['w-full justify-start', { 'ring-2 ring-primary-400': !state?.selected }]"
        @click="choose(undefined)"
      >
        {{ tt('follow-window') }}
      </Button>
      <Button
        v-for="display in displays"
        :key="display.label"
        :disabled="busy"
        :class="['w-full justify-between', { 'ring-2 ring-primary-400': state?.selected === display.label }]"
        @click="choose(display.label)"
      >
        <span>{{ describe(display.label, display.width, display.height) }}</span>
        <span v-if="display.primary" :class="['text-xs opacity-70']">{{ tt('primary') }}</span>
      </Button>
    </div>

    <div :class="['text-xs text-neutral-400', 'dark:text-neutral-500']">
      {{ tt('hint') }}
    </div>
  </div>
</template>
