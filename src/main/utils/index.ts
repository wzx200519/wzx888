import { encodePath, isUrl, throttle, isMac } from '@common/utils'
import migrateSetting from '@common/utils/migrateSetting'
import getStore from '@main/utils/store'
import { STORE_NAMES, URL_SCHEME_RXP } from '@common/constants'
import defaultSetting, { getHolidayOverrides, holidayRules } from '@common/defaultSetting'
import defaultHotKey from '@common/defaultHotKey'
import { migrateDataJson, migrateHotKey, migrateUserApi, parseDataFile } from './migrate'
import { nativeTheme, powerSaveBlocker } from 'electron'
import { joinPath } from '@common/utils/nodejs'
import themes from '@common/theme/index.json'

export const parseEnvParams = (argv = process.argv): { cmdParams: LX.CmdParams, deeplink: string | null } => {
  const cmdParams: LX.CmdParams = {}
  let deeplink = null
  const rx = /^-\w+/
  for (let param of argv) {
    if (URL_SCHEME_RXP.test(param)) {
      deeplink = param
    }

    if (!rx.test(param)) continue
    param = param.substring(1)
    let index = param.indexOf('=')
    if (index < 0) {
      cmdParams[param] = true
    } else {
      cmdParams[param.substring(0, index)] = param.substring(index + 1)
    }
  }
  return {
    cmdParams,
    deeplink,
  }
}

const primitiveType = ['string', 'boolean', 'number']
const checkPrimitiveType = (val: any): boolean => val === null || primitiveType.includes(typeof val)

export const mergeSetting = (originSetting: LX.AppSetting, targetSetting?: Partial<LX.AppSetting> | null): {
  setting: LX.AppSetting
  updatedSettingKeys: Array<keyof LX.AppSetting>
  updatedSetting: Partial<LX.AppSetting>
} => {
  let originSettingCopy: LX.AppSetting = { ...originSetting }
  const updatedSettingKeys: Array<keyof LX.AppSetting> = []
  const updatedSetting: Partial<LX.AppSetting> = {}

  if (targetSetting) {
    const originSettingKeys = Object.keys(originSettingCopy)
    const targetSettingKeys = Object.keys(targetSetting)

    if (originSettingKeys.length > targetSettingKeys.length) {
      for (const key of targetSettingKeys as Array<keyof LX.AppSetting>) {
        const targetValue: any = targetSetting[key]
        const isPrimitive = checkPrimitiveType(targetValue)
        if (!isPrimitive || targetValue == originSettingCopy[key] || originSettingCopy[key] === undefined) continue
        updatedSettingKeys.push(key)
        updatedSetting[key] = targetValue
        // @ts-expect-error
        originSettingCopy[key] = targetValue
      }
    } else {
      for (const key of originSettingKeys as Array<keyof LX.AppSetting>) {
        const targetValue: any = targetSetting[key]
        const isPrimitive = checkPrimitiveType(targetValue)
        if (!isPrimitive || targetValue == originSettingCopy[key]) continue
        updatedSettingKeys.push(key)
        updatedSetting[key] = targetValue
        // @ts-expect-error
        originSettingCopy[key] = targetValue
      }
    }
  }

  return {
    setting: originSettingCopy,
    updatedSettingKeys,
    updatedSetting,
  }
}

const mergeSettingPatch = (originSetting: Partial<LX.AppSetting>, targetSetting?: Partial<LX.AppSetting> | null): Partial<LX.AppSetting> => {
  if (!targetSetting) return { ...originSetting }

  let originSettingCopy: Partial<LX.AppSetting> = { ...originSetting }
  for (const key of Object.keys(targetSetting) as Array<keyof LX.AppSetting>) {
    const targetValue: any = targetSetting[key]
    if (!checkPrimitiveType(targetValue) || targetValue === undefined) continue
    originSettingCopy[key] = targetValue
  }

  return originSettingCopy
}

const normalizeSettingPatch = (setting: Partial<LX.AppSetting>, currentSetting?: LX.AppSetting): Partial<LX.AppSetting> => {
  let normalizedSetting = { ...setting }

  if (
    normalizedSetting['theme.id'] != null &&
    normalizedSetting['theme.autoHolidayTheme'] == null &&
    normalizedSetting['theme.id'] != currentSetting?.['theme.id']
  ) {
    normalizedSetting['theme.autoHolidayTheme'] = false
  }

  return normalizedSetting
}

const cleanupLegacyHolidaySetting = (setting: Partial<LX.AppSetting>): Partial<LX.AppSetting> => {
  if (setting['theme.autoHolidayTheme'] != null) return setting

  let normalizedSetting = { ...setting }
  for (const rule of holidayRules) {
    let matched = true
    for (const [key, value] of Object.entries(rule.overrides) as Array<[keyof LX.AppSetting, LX.AppSetting[keyof LX.AppSetting]]>) {
      if (normalizedSetting[key] !== value) {
        matched = false
        break
      }
    }
    if (!matched) continue

    for (const key of Object.keys(rule.overrides) as Array<keyof LX.AppSetting>) {
      delete normalizedSetting[key]
    }
    break
  }

  return normalizedSetting
}

const resolveSetting = (setting?: Partial<LX.AppSetting> | null): LX.AppSetting => {
  let mergedSetting = mergeSetting(defaultSetting, setting).setting
  if (!mergedSetting['theme.autoHolidayTheme']) return mergedSetting
  return mergeSetting(mergedSetting, getHolidayOverrides()).setting
}

const applyInitSetting = (setting: Partial<LX.AppSetting>) => {
  if (global.envParams.cmdParams.hidden && !setting['tray.enable']) {
    setting['tray.enable'] = true
  }
}

export const updateSetting = (setting?: Partial<LX.AppSetting>, isInit: boolean = false) => {
  const electronStore_config = getStore(STORE_NAMES.APP_SETTINGS)

  const originSetting = isInit ? resolveSetting() : global.lx.appSetting
  let userSetting: Partial<LX.AppSetting>

  if (isInit) {
    userSetting = setting ? cleanupLegacyHolidaySetting(migrateSetting(setting)) : {}
    applyInitSetting(userSetting)
  } else {
    let currentUserSetting = electronStore_config.get('setting') as Partial<LX.AppSetting> | undefined
    userSetting = mergeSettingPatch(currentUserSetting ?? {}, normalizeSettingPatch(setting ?? {}, originSetting))
  }

  userSetting.version = defaultSetting.version

  const result = mergeSetting(originSetting, resolveSetting(userSetting))
  result.setting.version = defaultSetting.version

  electronStore_config.override({ version: result.setting.version, setting: userSetting })
  return result
}

/**
 * 初始化设置
 */
export const initSetting = async() => {
  const electronStore_config = getStore(STORE_NAMES.APP_SETTINGS)

  let setting = electronStore_config.get('setting') as LX.AppSetting | undefined

  if (!setting) {
    const config = await parseDataFile<{ setting?: any }>('config.json')
    if (config?.setting) setting = config.setting as LX.AppSetting
    await migrateUserApi()
    await migrateDataJson()
  }

  return updateSetting(setting, true)
}

/**
 * 初始化快捷键设置
 */
export const initHotKey = async() => {
  const electronStore_hotKey = getStore(STORE_NAMES.HOTKEY)

  let localConfig = electronStore_hotKey.get('local') as LX.HotKeyConfig | null
  let globalConfig = electronStore_hotKey.get('global') as LX.HotKeyConfig | null

  if (globalConfig) {
    if (globalConfig.keys.MediaPlayPause) {
      delete globalConfig.keys.MediaPlayPause
      delete globalConfig.keys.MediaNextTrack
      delete globalConfig.keys.MediaPreviousTrack
      electronStore_hotKey.set('global', globalConfig)
    }
  } else {
    const config = await migrateHotKey()
    if (config) {
      localConfig = config.local
      globalConfig = config.global
    } else {
      localConfig = JSON.parse(JSON.stringify(defaultHotKey.local))
      globalConfig = JSON.parse(JSON.stringify(defaultHotKey.global))
    }

    electronStore_hotKey.set('local', localConfig)
    electronStore_hotKey.set('global', globalConfig)
  }

  return {
    local: localConfig!,
    global: globalConfig!,
  }
}

type HotKeyType = 'local' | 'global'

const saveHotKeyConfig = throttle<[LX.HotKeyConfigAll]>((config: LX.HotKeyConfigAll) => {
  for (const key of Object.keys(config) as HotKeyType[]) {
    global.lx.hotKey.config[key] = config[key]
    getStore(STORE_NAMES.HOTKEY).set(key, config[key])
  }
})
export const saveAppHotKeyConfig = (config: LX.HotKeyConfigAll) => {
  saveHotKeyConfig(config)
}

export const openDevTools = (webContents: Electron.WebContents) => {
  webContents.openDevTools({
    mode: 'undocked',
  })
}


let userThemes: LX.Theme[]
export const getAllThemes = () => {
  userThemes ??= getStore(STORE_NAMES.THEME).get('themes') as (LX.Theme[] | null) ?? []
  return {
    themes,
    userThemes,
    dataPath: joinPath(global.lxDataPath, 'theme_images'),
  }
}

export const saveTheme = (theme: LX.Theme) => {
  const targetTheme = userThemes.find(t => t.id === theme.id)
  if (targetTheme) Object.assign(targetTheme, theme)
  else userThemes.push(theme)
  getStore(STORE_NAMES.THEME).set('themes', userThemes)
}

export const removeTheme = (id: string) => {
  const index = userThemes.findIndex(t => t.id === id)
  if (index < 0) return
  userThemes.splice(index, 1)
  getStore(STORE_NAMES.THEME).set('themes', userThemes)
}

const copyTheme = (theme: LX.Theme): LX.Theme => {
  return {
    ...theme,
    config: {
      ...theme.config,
      extInfo: { ...theme.config.extInfo },
      themeColors: { ...theme.config.themeColors },
    },
  }
}
export const getTheme = () => {
  const shouldUseDarkColors = nativeTheme.shouldUseDarkColors
  let themeId = global.lx.appSetting['theme.id'] == 'auto'
    ? shouldUseDarkColors
      ? global.lx.appSetting['theme.darkId']
      : global.lx.appSetting['theme.lightId']
    : global.lx.appSetting['theme.id']
  let theme = themes.find(theme => theme.id == themeId)
  if (!theme) {
    userThemes = getStore(STORE_NAMES.THEME).get('themes') as LX.Theme[] | null ?? []
    theme = userThemes.find(theme => theme.id == themeId)
    if (theme) {
      theme = copyTheme(theme)
      theme.isCustom = true
    } else {
      theme = themes[0]
      themeId = theme.id
      powerSaveBlocker.isStarted(1) && powerSaveBlocker.stop(1)
    }
  }
  return {
    id: themeId,
    name: theme.name,
    isCustom: theme.isCustom,
    colors: theme.config.themeColors,
    extInfo: theme.config.extInfo,
  }
}

export const getProxy = () => {
  return global.lx.appSetting['network.proxy.enable'] && global.lx.appSetting['network.proxy.host'] && global.lx.appSetting['network.proxy.port']
    ? `http://${global.lx.appSetting['network.proxy.host']}:${global.lx.appSetting['network.proxy.port']}`
    : ''
}

export const encodeFilePath = (filepath: string) => {
  return encodePath(filepath).replace(/\[/g, '%5B').replace(/\]/g, '%5D')
}

export const handleUrl = (url: string) => {
  if (isUrl(url)) return url
  return `file://${encodeFilePath(url)}`
}
