import type { Display } from 'electron'
import type { InferOutput } from 'valibot'

import { useLogg } from '@guiiai/logg'
import { screen } from 'electron'
import { array, number, object, optional, string } from 'valibot'

import { createConfig } from './persistence'

const log = useLogg('app-config').useGlobalConfig()

export const appConfigSchema = object({
  windows: optional(array(object({
    title: optional(string()),
    tag: string(),
    x: optional(number()),
    y: optional(number()),
    width: optional(number()),
    height: optional(number()),
  }))),
  /**
   * 层表面窗口显示在哪块屏幕上，值是 Electron 的屏幕名。
   *
   * 层表面的输出在创建时就固定，拖动也换不了屏，所以「显示在哪」只能事先说好。
   */
  layerShellDisplay: optional(string()),
})

export type AppConfig = InferOutput<typeof appConfigSchema>

let instance: ReturnType<typeof createConfig<typeof appConfigSchema>> | undefined

/** 应用配置文件：窗口几何和层表面选中的屏幕都在这里。 */
export function appConfig() {
  if (!instance) {
    instance = createConfig('app', 'config.json', appConfigSchema, {
      default: { windows: [] },
      autoHeal: true,
    })
    instance.setup()
  }
  return instance
}

export function readAppConfig(): AppConfig {
  return appConfig().get() ?? { windows: [] }
}

export function updateAppConfig(patch: Partial<AppConfig>) {
  // 不用 `defu` 合并：它会把 `undefined` 当成「没给」，而清掉设置正是要给 `undefined`。
  // 写到文件时 `JSON.stringify` 会把这个键去掉。
  appConfig().update({ ...readAppConfig(), ...patch })
}

/** 现在能选的所有屏幕，屏幕上显示的就是它的名字。 */
export function listDisplays() {
  return screen.getAllDisplays().map(display => ({
    label: display.label,
    width: display.bounds.width,
    height: display.bounds.height,
  }))
}

/**
 * 没选屏幕、或者选的那块没了的时候用哪块。
 *
 * Wayland 上没有「主屏」这个概念（合成器不告诉客户端），Chromium 报的那个只是它自己挑的，
 * 所以直接用主窗口保存的位置落在哪块屏上，没有保存过就用第一块。
 */
function fallbackDisplay(): Display {
  const main = readAppConfig().windows?.find(window => window.tag === 'main')
  if (main?.x !== undefined && main?.y !== undefined) {
    return screen.getDisplayMatching({
      x: main.x,
      y: main.y,
      width: main.width ?? 1,
      height: main.height ?? 1,
    })
  }

  return screen.getAllDisplays()[0] ?? screen.getPrimaryDisplay()
}

/**
 * 层表面窗口该出现在哪块屏幕上。
 *
 * 用户选过就用选的那块；那块屏拔了、改名了，就自动退回主屏并把选择清掉，不然窗口会跑到不存在的屏幕上。
 */
export function resolveLayerShellDisplay(): Display {
  const selected = readAppConfig().layerShellDisplay
  const match = selected ? screen.getAllDisplays().find(display => display.label === selected) : undefined
  if (match)
    return match

  if (selected) {
    log.log(`the chosen screen "${selected}" is gone, going back to the primary one`)
    updateAppConfig({ layerShellDisplay: undefined })
  }

  return fallbackDisplay()
}

export function setLayerShellDisplay(label: string | undefined): void {
  updateAppConfig({ layerShellDisplay: label })
}

/** 屏幕插拔之后看一眼：选中的那块没了就把设置清掉，下次开窗口就回主屏。 */
export function watchLayerShellDisplay(): void {
  // 出问题时最先要看的就是「有哪几块屏、叫什么名字」。
  log.log(`screens: ${listDisplays().map(display => display.label).join(' | ')}`)

  const settle = () => {
    const selected = readAppConfig().layerShellDisplay
    if (!selected)
      return

    if (!screen.getAllDisplays().some(display => display.label === selected)) {
      log.log(`the chosen screen "${selected}" went away, going back to the primary one`)
      updateAppConfig({ layerShellDisplay: undefined })
    }
  }

  screen.on('display-added', settle)
  screen.on('display-removed', settle)
}
