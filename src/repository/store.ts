/**
 * 本地 Skin Repository 的目录布局。
 * 根 = $DSH_HOME/skins/：installed（正式安装）、staging（安装中转）、cache（缓存/丢弃区）。
 * 所有安装必须 staging → 校验 → atomic rename 进 installed，禁止直接写 installed。
 * @module dsh-skin/src/repository/store
 */

import { join } from 'node:path'

export const SKINS_DIR_NAME = 'skins'
export const REGISTRY_FILENAME = 'registry.json'
export const MANIFEST_FILENAME = 'manifest.json'
export const INTEGRITY_FILENAME = 'integrity.json'
export const THEME_DIR = 'theme'
export const STYLES_DIR = 'styles'
export const CLIENT_DIR = 'client'
export const ASSETS_DIR = 'assets'
export const PREVIEW_DIR = 'preview'

export interface SkinRoots {
  /** $DSH_HOME/skins */
  root: string
  installed: string
  generated: string
  downloaded: string
  staging: string
  cache: string
}

export function resolveSkinRoots(home: string): SkinRoots {
  const root = join(home, SKINS_DIR_NAME)
  return {
    root,
    installed: join(root, 'installed'),
    generated: join(root, 'generated'),
    downloaded: join(root, 'downloaded'),
    staging: join(root, 'staging'),
    cache: join(root, 'cache'),
  }
}
