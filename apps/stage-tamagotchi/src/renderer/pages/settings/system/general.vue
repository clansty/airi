<script setup lang="ts">
import type { LayerShellDisplayState } from '../../../../shared/eventa'

import SettingsGeneralFields from '@proj-airi/stage-pages/components/settings-general-fields.vue'

import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { Button, FieldCheckbox, Select } from '@proj-airi/ui'
import { computed, onMounted, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'

import { electron, electronAppIconGet, electronAppIconSet, electronAppRelaunch, electronLayerShellDisplayGet, electronLayerShellDisplaySet } from '../../../../shared/eventa'

const { t } = useI18n()
const getHidden = useElectronEventaInvoke(electronAppIconGet)
const setHidden = useElectronEventaInvoke(electronAppIconSet)
const isLinux = useElectronEventaInvoke(electron.app.isLinux)
const getLayerShell = useElectronEventaInvoke(electronLayerShellDisplayGet)
const setLayerShell = useElectronEventaInvoke(electronLayerShellDisplaySet)
const relaunch = useElectronEventaInvoke(electronAppRelaunch)
const layerShell = shallowRef<LayerShellDisplayState>()
const restartNeeded = shallowRef(false)
// The value stays undefined on Linux, and the field does not show there.
const hideAppIcon = shallowRef<boolean>()

onMounted(async () => {
  try {
    if (!await isLinux())
      hideAppIcon.value = await getHidden()
  }
  catch {
    toast.error(t('tamagotchi.settings.pages.system.general.hide-app-icon.load-error'))
  }

  // 层表面的屏幕设置；不在层表面会话里时它自己会说 active: false，这一节就不出现。
  try {
    layerShell.value = await getLayerShell()
  }
  catch (error) {
    console.warn('[Settings] Failed to read the layer shell screen:', error)
  }
})

const screenOptions = computed(() => (layerShell.value?.displays ?? []).map(display => ({
  label: display.label,
  value: display.label,
  description: `${display.width}×${display.height}`,
})))

async function updateScreen(label: string) {
  try {
    layerShell.value = await setLayerShell({ label })
    // 层表面的输出在创建时就固定，所以换屏幕要重开才生效。
    restartNeeded.value = true
  }
  catch {
    toast.error(t('tamagotchi.settings.pages.system.general.screen.failed'))
  }
}

async function updateHidden(hidden: boolean) {
  try {
    hideAppIcon.value = await setHidden(hidden)
  }
  catch {
    toast.error(t('tamagotchi.settings.pages.system.general.hide-app-icon.save-error'))
  }
}
</script>

<template>
  <SettingsGeneralFields>
    <template #additional-fields>
      <FieldCheckbox
        v-if="hideAppIcon !== undefined"
        :model-value="hideAppIcon"
        :label="t('tamagotchi.settings.pages.system.general.hide-app-icon.title')"
        :description="t('tamagotchi.settings.pages.system.general.hide-app-icon.description')"
        @update:model-value="updateHidden"
      />
      <div
        v-if="layerShell?.active"
        :class="['flex flex-col gap-2']"
      >
        <div :class="['text-sm font-medium']">
          {{ t('tamagotchi.settings.pages.system.general.screen.title') }}
        </div>
        <div :class="['text-xs text-neutral-500', 'dark:text-neutral-400']">
          {{ t('tamagotchi.settings.pages.system.general.screen.description') }}
        </div>

        <Select
          :model-value="layerShell.selected"
          :options="screenOptions"
          @update:model-value="updateScreen($event as string)"
        />

        <div
          v-if="restartNeeded"
          :class="['flex flex-col gap-2 rounded-xl bg-amber-50 p-3', 'dark:bg-amber-950/40']"
        >
          <div :class="['text-xs text-amber-700', 'dark:text-amber-300']">
            {{ t('tamagotchi.settings.pages.system.general.screen.restart-hint') }}
          </div>
          <Button @click="relaunch()">
            {{ t('tamagotchi.settings.pages.system.general.screen.restart') }}
          </Button>
        </div>
      </div>
    </template>
  </SettingsGeneralFields>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.system.general.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
