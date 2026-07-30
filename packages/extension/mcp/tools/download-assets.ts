import type {
  DownloadAssetExport,
  DownloadAssetFormat,
  DownloadAssetRawImage,
  DownloadAssetsResult
} from '@tempad-dev/shared'

import {
  MCP_DOWNLOAD_ASSETS_DEFAULT_SCALE,
  MCP_DOWNLOAD_ASSETS_MAX_RAW_IMAGES
} from '@tempad-dev/shared'

import { ensureAssetUploaded } from '@/mcp/assets'
import { logger } from '@/utils/log'

import { detectImageMime, loadImageBytes } from './image-bytes'

export type DownloadAssetsOptions = {
  defaultFormat?: DownloadAssetFormat
  defaultScale?: number
}

type ExportPlan = {
  format: DownloadAssetFormat
  settings: ExportSettings
  scale?: number
  fromExportSettings: boolean
}

// Guard against pathological subtrees while scanning for raw image fills.
const MAX_SCANNED_NODES = 5000

const EXPORT_MIME_TYPES: Record<DownloadAssetFormat, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  svg: 'image/svg+xml',
  pdf: 'application/pdf'
}

const EXPORT_FORMATS_BY_SETTING: Record<ExportSettings['format'], DownloadAssetFormat> = {
  PNG: 'png',
  JPG: 'jpg',
  SVG: 'svg',
  PDF: 'pdf'
}

const RASTER_FORMATS = new Set<DownloadAssetFormat>(['png', 'jpg'])

export async function handleDownloadAssets(
  nodes: SceneNode[],
  options: DownloadAssetsOptions = {}
): Promise<DownloadAssetsResult> {
  const warnings: string[] = []
  const exports = await exportNodes(nodes, options, warnings)
  const { rawImages, truncated } = await collectRawImages(nodes, warnings)

  return {
    exports,
    rawImages,
    ...(truncated ? { rawImagesTruncated: true } : {}),
    ...(warnings.length ? { warnings } : {})
  }
}

async function exportNodes(
  nodes: SceneNode[],
  options: DownloadAssetsOptions,
  warnings: string[]
): Promise<DownloadAssetExport[]> {
  const exports: DownloadAssetExport[] = []

  for (const node of nodes) {
    for (const plan of planNodeExports(node, options)) {
      const entry = await exportNode(node, plan, warnings)
      if (entry) exports.push(entry)
    }
  }

  return exports
}

async function exportNode(
  node: SceneNode,
  plan: ExportPlan,
  warnings: string[]
): Promise<DownloadAssetExport | null> {
  try {
    const bytes = await node.exportAsync(plan.settings)
    const dimensions = getExportDimensions(node, plan)
    const asset = await ensureAssetUploaded(bytes, EXPORT_MIME_TYPES[plan.format], dimensions)

    return {
      ...asset,
      nodeId: node.id,
      nodeName: node.name,
      kind: 'export',
      format: plan.format,
      ...(plan.scale === undefined ? {} : { scale: plan.scale }),
      fromExportSettings: plan.fromExportSettings
    }
  } catch (error) {
    logger.warn(`Failed to export node ${node.id} as ${plan.format}.`, error)
    warnings.push(`Failed to export node ${node.id} as ${plan.format}: ${describeError(error)}.`)
    return null
  }
}

function planNodeExports(node: SceneNode, options: DownloadAssetsOptions): ExportPlan[] {
  const configured = 'exportSettings' in node ? node.exportSettings : undefined
  if (configured?.length) {
    return configured.map((settings) => planFromExportSettings(settings))
  }

  return [planFromDefaults(options)]
}

function planFromExportSettings(settings: ExportSettings): ExportPlan {
  const format = EXPORT_FORMATS_BY_SETTING[settings.format]
  const constraint = 'constraint' in settings ? settings.constraint : undefined
  const scale =
    RASTER_FORMATS.has(format) && constraint?.type === 'SCALE' ? constraint.value : undefined

  return {
    format,
    settings,
    ...(scale === undefined ? {} : { scale }),
    fromExportSettings: true
  }
}

function planFromDefaults({ defaultFormat, defaultScale }: DownloadAssetsOptions): ExportPlan {
  const format = defaultFormat ?? 'png'

  if (!RASTER_FORMATS.has(format)) {
    return {
      format,
      settings: { format: format === 'pdf' ? 'PDF' : 'SVG' },
      fromExportSettings: false
    }
  }

  const scale = defaultScale ?? MCP_DOWNLOAD_ASSETS_DEFAULT_SCALE
  return {
    format,
    settings: {
      format: format === 'jpg' ? 'JPG' : 'PNG',
      constraint: { type: 'SCALE', value: scale }
    },
    scale,
    fromExportSettings: false
  }
}

function getExportDimensions(
  node: SceneNode,
  plan: ExportPlan
): { width: number; height: number } | undefined {
  if (plan.scale === undefined) return undefined
  if (typeof node.width !== 'number' || typeof node.height !== 'number') return undefined

  const width = Math.round(node.width * plan.scale)
  const height = Math.round(node.height * plan.scale)
  if (width <= 0 || height <= 0) return undefined

  return { width, height }
}

async function collectRawImages(
  nodes: SceneNode[],
  warnings: string[]
): Promise<{ rawImages: DownloadAssetRawImage[]; truncated: boolean }> {
  const hashes = collectImageFillHashes(nodes)
  const truncated = hashes.size > MCP_DOWNLOAD_ASSETS_MAX_RAW_IMAGES
  const entries = Array.from(hashes.entries()).slice(0, MCP_DOWNLOAD_ASSETS_MAX_RAW_IMAGES)
  const rawImages: DownloadAssetRawImage[] = []

  for (const [figmaImageHash, nodeIds] of entries) {
    try {
      const bytes = await loadImageBytes(figmaImageHash)
      const asset = await ensureAssetUploaded(bytes, detectImageMime(bytes))
      rawImages.push({
        ...asset,
        figmaImageHash,
        nodeIds,
        source: 'raw'
      })
    } catch (error) {
      logger.warn(`Failed to resolve raw image bytes for hash ${figmaImageHash}.`, error)
      warnings.push(
        `Failed to resolve raw source image ${figmaImageHash}: ${describeError(error)}. Use the export render for this node instead.`
      )
    }
  }

  return { rawImages, truncated }
}

function collectImageFillHashes(nodes: SceneNode[]): Map<string, string[]> {
  const hashes = new Map<string, string[]>()
  const stack = [...nodes]
  let scanned = 0

  while (stack.length) {
    const node = stack.pop()
    if (!node) continue
    if (scanned >= MAX_SCANNED_NODES) break
    scanned += 1

    for (const hash of getImageFillHashes(node)) {
      const nodeIds = hashes.get(hash)
      if (nodeIds) {
        if (!nodeIds.includes(node.id)) nodeIds.push(node.id)
      } else {
        hashes.set(hash, [node.id])
      }
    }

    if ('children' in node) {
      for (const child of node.children) {
        if (child.visible !== false) stack.push(child)
      }
    }
  }

  return hashes
}

function getImageFillHashes(node: SceneNode): string[] {
  if (!('fills' in node) || !Array.isArray(node.fills)) return []

  return (node.fills as Paint[])
    .filter((fill): fill is ImagePaint => fill.type === 'IMAGE' && fill.visible !== false)
    .map((fill) => fill.imageHash)
    .filter((hash): hash is string => !!hash)
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return message.trim().replace(/\.+$/, '') || 'unknown error'
}
