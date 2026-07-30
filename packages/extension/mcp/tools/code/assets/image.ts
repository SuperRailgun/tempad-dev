import type { AssetDescriptor } from '@tempad-dev/shared'

import type { CodegenConfig } from '@/utils/codegen'

import { ensureAssetUploaded } from '@/mcp/assets'
import { cacheImageBytes, detectImageMime, loadImageBytes } from '@/mcp/tools/image-bytes'
import { BG_URL_RE } from '@/utils/css'
import { logger } from '@/utils/log'
import { toDecimalPlace } from '@/utils/number'

import type { GetCodeCacheContext } from '../cache'

import { getNodeSemanticsCached } from '../cache'

export function hasImageFills(node: SceneNode, ctx?: GetCodeCacheContext): boolean {
  if (ctx) {
    return getNodeSemanticsCached(node, ctx).paint.hasImageFill
  }
  return (
    'fills' in node &&
    Array.isArray(node.fills) &&
    node.fills.some((f) => f.type === 'IMAGE' && f.visible !== false)
  )
}

export async function replaceImageUrlsWithAssets(
  style: Record<string, string>,
  node: SceneNode,
  config: CodegenConfig,
  assetRegistry: Map<string, AssetDescriptor>
): Promise<Record<string, string>> {
  if (!style['background-color'] && !style['background-image'] && !style.background) return style

  const fills = await collectImageFillAssets(node, assetRegistry)
  if (!fills.length) {
    return replaceImageUrlsWithPlaceholder(style, node, config)
  }

  const result = { ...style }
  const regex = new RegExp(BG_URL_RE.source, 'gi')

  for (const key of ['background', 'background-image']) {
    if (!result[key]) continue
    let index = 0
    result[key] = result[key].replace(regex, () => {
      const asset = fills[Math.min(index, fills.length - 1)]
      index++
      return `url('${asset.url}')`
    })
  }

  return result
}

function replaceImageUrlsWithPlaceholder(
  style: Record<string, string>,
  node: SceneNode,
  config: CodegenConfig
): Record<string, string> {
  const { scale = 1 } = config
  let w = 100
  let h = 100

  if ('width' in node && typeof node.width === 'number') {
    w = Math.round(toDecimalPlace(node.width) * scale)
  }
  if ('height' in node && typeof node.height === 'number') {
    h = Math.round(toDecimalPlace(node.height) * scale)
  }

  const placeholderUrl = `https://placehold.co/${w}x${h}`
  const result = { ...style }
  const regex = new RegExp(BG_URL_RE.source, 'gi')

  for (const key of ['background', 'background-image']) {
    if (result[key]) {
      result[key] = result[key].replace(regex, `url('${placeholderUrl}')`)
    }
  }

  return result
}

async function collectImageFillAssets(
  node: SceneNode,
  assetRegistry: Map<string, AssetDescriptor>
): Promise<AssetDescriptor[]> {
  if (!('fills' in node)) return []
  const fills = Array.isArray(node.fills) ? (node.fills as Paint[]) : null
  if (!fills?.length) return []

  const assets: AssetDescriptor[] = []
  for (const fill of fills) {
    if (!isRenderableImagePaint(fill)) continue
    const hash = fill.imageHash
    if (!hash) continue

    try {
      const bytes = await loadImageBytes(hash)
      const mimeType = detectImageMime(bytes)
      const asset = await ensureAssetUploaded(bytes, mimeType)
      assetRegistry.set(asset.hash, asset)
      assets.push(asset)
    } catch (error) {
      logger.warn('Failed to process image fill asset, falling back to node export.')
      try {
        logger.warn(`Image bytes unavailable for hash ${hash}, falling back to node export.`, error)
        const bytes = await node.exportAsync({ format: 'PNG' })
        cacheImageBytes(hash, bytes)
        const mimeType = detectImageMime(bytes)
        const asset = await ensureAssetUploaded(bytes, mimeType)
        assetRegistry.set(asset.hash, asset)
        assets.push(asset)
        continue
      } catch (fallbackError) {
        logger.warn('Failed to export node for image fill fallback:', fallbackError)
      }
    }
  }

  return assets
}

function isRenderableImagePaint(paint: Paint): paint is ImagePaint {
  return paint.type === 'IMAGE' && paint.visible !== false
}
