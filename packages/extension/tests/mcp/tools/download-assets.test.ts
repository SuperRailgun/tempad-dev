import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ensureAssetUploaded } from '@/mcp/assets'
import { handleDownloadAssets } from '@/mcp/tools/download-assets'

vi.mock('@/mcp/assets', () => ({
  ensureAssetUploaded: vi.fn()
}))

vi.mock('@/utils/log', () => ({
  logger: {
    warn: vi.fn(),
    debug: vi.fn()
  }
}))

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00])
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0x00])

type NodeOverrides = {
  id?: string
  name?: string
  width?: number
  height?: number
  exportSettings?: ExportSettings[]
  fills?: Paint[]
  children?: SceneNode[]
  visible?: boolean
  exportAsync?: (settings?: ExportSettings) => Promise<Uint8Array>
}

function createNode(overrides: NodeOverrides = {}): SceneNode {
  const {
    id = 'node-1',
    name = 'Node',
    width = 100,
    height = 50,
    exportAsync = vi.fn(async () => png),
    ...rest
  } = overrides

  return {
    id,
    name,
    width,
    height,
    visible: true,
    exportAsync,
    ...rest
  } as unknown as SceneNode
}

function imagePaint(imageHash: string, visible = true): Paint {
  return { type: 'IMAGE', visible, imageHash } as unknown as Paint
}

function setFigmaImages(
  images: Record<string, { getBytesAsync: () => Promise<Uint8Array> } | null>
) {
  ;(globalThis as { figma?: PluginAPI }).figma = {
    getImageByHash: vi.fn((hash: string) => images[hash] ?? null)
  } as unknown as PluginAPI
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(ensureAssetUploaded).mockImplementation(async (bytes, mimeType, metadata) => ({
    hash: `hash-${mimeType.replace(/\W/g, '')}`,
    url: `https://assets.local/${mimeType.replace(/\W/g, '')}`,
    mimeType,
    size: bytes.byteLength,
    ...metadata
  }))
})

afterEach(() => {
  delete (globalThis as { figma?: PluginAPI }).figma
})

describe('mcp/tools/download-assets', () => {
  it('exports at the default png scale when a node has no export settings', async () => {
    const exportAsync = vi.fn(async () => png)
    const node = createNode({ exportAsync })
    setFigmaImages({})

    const result = await handleDownloadAssets([node])

    expect(exportAsync).toHaveBeenCalledWith({
      format: 'PNG',
      constraint: { type: 'SCALE', value: 1 }
    })
    expect(ensureAssetUploaded).toHaveBeenCalledWith(png, 'image/png', { width: 100, height: 50 })
    expect(result.exports).toEqual([
      {
        hash: 'hash-imagepng',
        url: 'https://assets.local/imagepng',
        mimeType: 'image/png',
        size: png.byteLength,
        width: 100,
        height: 50,
        nodeId: 'node-1',
        nodeName: 'Node',
        kind: 'export',
        format: 'png',
        scale: 1,
        fromExportSettings: false
      }
    ])
    expect(result.rawImages).toEqual([])
    expect(result.rawImagesTruncated).toBeUndefined()
  })

  it('honors requested default format and scale for raster and vector formats', async () => {
    const rasterNode = createNode({ id: 'raster' })
    const vectorNode = createNode({ id: 'vector' })
    setFigmaImages({})

    const raster = await handleDownloadAssets([rasterNode], {
      defaultFormat: 'jpg',
      defaultScale: 2
    })
    expect(rasterNode.exportAsync).toHaveBeenCalledWith({
      format: 'JPG',
      constraint: { type: 'SCALE', value: 2 }
    })
    expect(raster.exports[0]).toMatchObject({ format: 'jpg', scale: 2, width: 200, height: 100 })

    const vector = await handleDownloadAssets([vectorNode], { defaultFormat: 'svg' })
    expect(vectorNode.exportAsync).toHaveBeenCalledWith({ format: 'SVG' })
    expect(vector.exports[0]).toMatchObject({ format: 'svg' })
    expect(vector.exports[0].scale).toBeUndefined()

    const pdf = await handleDownloadAssets([createNode({ id: 'pdf' })], { defaultFormat: 'pdf' })
    expect(pdf.exports[0]).toMatchObject({ format: 'pdf' })
  })

  it('uses configured Figma export settings when present', async () => {
    const exportSettings = [
      { format: 'PNG', constraint: { type: 'SCALE', value: 3 } },
      { format: 'SVG' }
    ] as unknown as ExportSettings[]
    const node = createNode({ exportSettings })
    setFigmaImages({})

    const result = await handleDownloadAssets([node], { defaultFormat: 'jpg', defaultScale: 4 })

    expect(node.exportAsync).toHaveBeenNthCalledWith(1, exportSettings[0])
    expect(node.exportAsync).toHaveBeenNthCalledWith(2, exportSettings[1])
    expect(result.exports.map((entry) => [entry.format, entry.scale])).toEqual([
      ['png', 3],
      ['svg', undefined]
    ])
    expect(result.exports.every((entry) => entry.fromExportSettings)).toBe(true)
  })

  it('collects deduplicated raw source images from the subtree', async () => {
    const child = createNode({
      id: 'child',
      fills: [imagePaint('image-a'), imagePaint('image-hidden', false)]
    })
    const root = createNode({
      id: 'root',
      fills: [imagePaint('image-a'), imagePaint('image-b')],
      children: [child]
    })
    setFigmaImages({
      'image-a': { getBytesAsync: async () => png },
      'image-b': { getBytesAsync: async () => jpeg }
    })

    const result = await handleDownloadAssets([root])

    expect(result.rawImages).toHaveLength(2)
    const byHash = new Map(result.rawImages.map((entry) => [entry.figmaImageHash, entry]))
    expect(byHash.get('image-a')).toMatchObject({ mimeType: 'image/png', source: 'raw' })
    expect(byHash.get('image-a')?.nodeIds.sort()).toEqual(['child', 'root'])
    expect(byHash.get('image-b')).toMatchObject({ mimeType: 'image/jpeg', nodeIds: ['root'] })
  })

  it('skips invisible children when scanning for raw images', async () => {
    const hiddenChild = createNode({
      id: 'hidden',
      visible: false,
      fills: [imagePaint('image-hidden-node')]
    })
    const root = createNode({ id: 'root', children: [hiddenChild] })
    setFigmaImages({ 'image-hidden-node': { getBytesAsync: async () => png } })

    const result = await handleDownloadAssets([root])

    expect(result.rawImages).toEqual([])
  })

  it('flags truncation when the subtree exceeds the raw image cap', async () => {
    const hashes = Array.from({ length: 21 }, (_, index) => `image-${index}`)
    const root = createNode({ id: 'root', fills: hashes.map((hash) => imagePaint(hash)) })
    setFigmaImages(
      Object.fromEntries(hashes.map((hash) => [hash, { getBytesAsync: async () => png }]))
    )

    const result = await handleDownloadAssets([root])

    expect(result.rawImages).toHaveLength(20)
    expect(result.rawImagesTruncated).toBe(true)
  })

  it('reports warnings for failed exports and unresolved raw images', async () => {
    const node = createNode({
      id: 'broken',
      fills: [imagePaint('missing-image')],
      exportAsync: vi.fn(async () => {
        throw new Error('export failed')
      })
    })
    setFigmaImages({ 'missing-image': null })

    const result = await handleDownloadAssets([node])

    expect(result.exports).toEqual([])
    expect(result.rawImages).toEqual([])
    expect(result.warnings).toEqual([
      'Failed to export node broken as png: export failed.',
      'Failed to resolve raw source image missing-image: Unable to resolve image for hash missing-image. Use the export render for this node instead.'
    ])
  })
})
