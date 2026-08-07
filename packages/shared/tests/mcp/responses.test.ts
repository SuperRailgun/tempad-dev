import { describe, expect, it } from 'vitest'

import type { ToolResponseLike } from '../../src/mcp/responses'
import type { ToolResultMap } from '../../src/mcp/tools'

import { MCP_SUMMARY_INLINE_BUDGET_BYTES } from '../../src/mcp/constants'
import {
  buildApplyCanvasToolResult,
  buildDownloadAssetsToolResult,
  buildGetCodeToolResult,
  buildGetDesignSystemToolResult,
  buildGetScreenshotToolResult,
  buildGetStructureToolResult,
  buildGetTokenDefsToolResult,
  measureCallToolResultBytes,
  utf8Bytes
} from '../../src/mcp/responses'

const ASSET_HASH = 'd'.repeat(64)

describe('mcp/responses helpers', () => {
  it('counts UTF-8 bytes for multibyte characters', () => {
    expect(utf8Bytes('abc')).toBe(3)
    expect(utf8Bytes('你好')).toBe(6)
    expect(utf8Bytes('🙂')).toBe(4)
  })

  it('measures CallToolResult bytes beyond the bare text payload', () => {
    const result: ToolResponseLike = {
      content: [{ type: 'text', text: 'hello' }],
      structuredContent: { code: 'hello' }
    }

    expect(measureCallToolResultBytes(result)).toBeGreaterThan(utf8Bytes('hello'))
  })

  it('builds code tool summaries from warning messages', () => {
    const payload: ToolResultMap['get_code'] = {
      code: '<div>Hello</div>',
      lang: 'jsx',
      codegen: {
        plugin: 'builtin',
        config: {
          cssUnit: 'px',
          rootFontSize: 16,
          scale: 1
        }
      },
      warnings: [
        {
          type: 'shell',
          message: 'Shell response: omitted direct child ids are listed in the inline comment.'
        }
      ]
    }

    const result = buildGetCodeToolResult(payload)
    expect(result.structuredContent).toEqual(payload)
    expect(result.content?.[0]?.text).toContain('Shell response')
    expect(result.content?.[0]?.text).toContain('Code:')
    expect(result.content?.[0]?.text).toContain('<div>Hello</div>')
    expect(result.content?.[0]?.text).not.toContain('Next: call get_code with')
    expect(result.content?.[0]?.text).not.toContain('Read structuredContent')
  })

  it('builds structure and token tool summaries with structured content', () => {
    const structure = buildGetStructureToolResult({
      roots: [
        {
          id: '1',
          name: 'Button 按钮',
          type: 'COMPONENT_SET',
          x: 0,
          y: 0,
          width: 570,
          height: 314,
          children: [
            {
              id: '2',
              name: 'variant=base, theme=primary, size=large, shape=rect',
              type: 'COMPONENT',
              x: 42,
              y: 34,
              width: 85,
              height: 32,
              variantProperties: { theme: 'primary', size: 'large', shape: 'rect' }
            }
          ]
        }
      ]
    })
    expect(structure.structuredContent).toEqual({
      roots: [
        {
          id: '1',
          name: 'Button 按钮',
          type: 'COMPONENT_SET',
          x: 0,
          y: 0,
          width: 570,
          height: 314,
          children: [
            {
              id: '2',
              name: 'variant=base, theme=primary, size=large, shape=rect',
              type: 'COMPONENT',
              x: 42,
              y: 34,
              width: 85,
              height: 32,
              variantProperties: { theme: 'primary', size: 'large', shape: 'rect' }
            }
          ]
        }
      ]
    })
    const structureText = structure.content?.[0]?.text ?? ''
    expect(structureText).toContain('Returned structure outline')
    expect(structureText).toContain('Outline:')
    expect(structureText).toContain('- Button 按钮 [COMPONENT_SET] (1) 570x314')
    expect(structureText).toContain(
      'variant=base, theme=primary, size=large, shape=rect [COMPONENT] (2) 85x32 {theme=primary, size=large, shape=rect}'
    )
    expect(structureText).not.toContain('Read structuredContent')

    const tokens = buildGetTokenDefsToolResult({
      '--color-primary': {
        kind: 'color',
        value: '#fff'
      },
      '--size-m': {
        kind: 'number',
        value: {
          'basic 基础:light': '32px',
          'basic 基础:dark': '32px'
        }
      }
    })
    const tokenText = tokens.content?.[0]?.text ?? ''
    expect(tokenText).toContain('Resolved 2 token definitions')
    expect(tokenText).toContain('Tokens:')
    expect(tokenText).toContain('- --color-primary (color): #fff')
    expect(tokenText).toContain('- --size-m (number): basic 基础:light=32px; basic 基础:dark=32px')
    expect(tokenText).not.toContain('Read structuredContent')
  })

  it('summarizes download_assets exports, raw images and truncation', () => {
    const payload: ToolResultMap['download_assets'] = {
      exports: [
        {
          hash: 'deadbeef',
          url: 'https://assets.local/deadbeef.png',
          mimeType: 'image/png',
          size: 512,
          nodeId: '1:2',
          nodeName: 'Hero',
          kind: 'export',
          format: 'png',
          scale: 2,
          fromExportSettings: false
        }
      ],
      rawImages: [
        {
          hash: 'beefcafe',
          url: 'https://assets.local/beefcafe.jpg',
          mimeType: 'image/jpeg',
          size: 1024,
          figmaImageHash: 'figma-hash',
          nodeIds: ['1:3'],
          source: 'raw'
        }
      ],
      rawImagesTruncated: true,
      warnings: ['Failed to export node 1:9 as pdf: boom']
    }

    const result = buildDownloadAssetsToolResult(payload)
    const text = result.content?.[0]?.text ?? ''

    expect(result.structuredContent).toEqual(payload)
    expect(text).toContain('Export renders: 1 asset.')
    expect(text).toContain('Raw source images: 1 asset.')
    expect(text).toContain('Raw source images were truncated.')
    expect(text).toContain('Failed to export node 1:9 as pdf: boom')
    expect(text).toContain('Download bytes from each URL above.')
    expect(text).not.toContain('Read structuredContent')
  })

  it('inlines download_assets URLs so clients that hide structuredContent stay usable', () => {
    const result = buildDownloadAssetsToolResult({
      exports: [
        {
          hash: 'deadbeef',
          url: 'https://assets.local/deadbeef.svg',
          mimeType: 'image/svg+xml',
          size: 512,
          nodeId: '1:2',
          nodeName: 'Icon',
          kind: 'export',
          format: 'svg',
          fromExportSettings: true
        }
      ],
      rawImages: [
        {
          hash: 'beefcafe',
          url: 'https://assets.local/beefcafe.jpg',
          mimeType: 'image/jpeg',
          size: 1024,
          figmaImageHash: 'figma-hash',
          nodeIds: ['1:3'],
          source: 'raw'
        }
      ]
    })
    const text = result.content?.[0]?.text ?? ''

    expect(text).toContain('- Icon [svg] https://assets.local/deadbeef.svg')
    expect(text).toContain('- image/jpeg https://assets.local/beefcafe.jpg')
  })

  it('summarizes the document page list and points at the next call', () => {
    const payload: ToolResultMap['get_structure'] = {
      roots: [],
      documentName: 'Design File',
      pages: [
        { id: '0:1', name: 'Cover' },
        { id: '0:2', name: 'Components', isCurrent: true }
      ]
    }

    const result = buildGetStructureToolResult(payload)
    const text = result.content?.[0]?.text ?? ''

    expect(result.structuredContent).toEqual(payload)
    expect(text).toContain('page list of "Design File": 2 pages')
    expect(text).toContain('Open page: "Components" (0:2).')
    expect(text).toContain('- Cover (0:1)')
    expect(text).toContain('- Components (0:2) [current]')
    expect(text).toContain('Call this tool again with a page id as nodeId')
    expect(text).not.toContain('structuredContent')
  })

  it('inlines top-level node ids in structure summaries', () => {
    const result = buildGetStructureToolResult({
      roots: [
        { id: '1:2', name: 'Card', type: 'FRAME', x: 0, y: 0, width: 320, height: 180 },
        { id: '1:5', name: '', type: 'TEXT', x: 0, y: 0, width: 100, height: 20 }
      ]
    })
    const text = result.content?.[0]?.text ?? ''

    expect(text).toContain('- Card [FRAME] (1:2)')
    expect(text).toContain('- Unnamed [TEXT] (1:5)')
  })

  it('caps an inlined list at the summary budget and says how many were dropped', () => {
    const pages = Array.from({ length: 400 }, (_, index) => ({
      id: `0:${index}`,
      name: `Page ${index} ${'padded name '.repeat(4)}`
    }))

    const result = buildGetStructureToolResult({ roots: [], pages })
    const text = result.content?.[0]?.text ?? ''

    expect(text).toContain('- Page 0')
    expect(text).toMatch(/- \.\.\.and \d+ more pages; read structuredContent for the rest\./)
    expect(utf8Bytes(text)).toBeLessThan(MCP_SUMMARY_INLINE_BUDGET_BYTES + 512)
  })

  it('flags a truncated page list and an unreadable document', () => {
    const truncated = buildGetStructureToolResult({
      roots: [],
      pages: [{ id: '0:1', name: 'Cover' }],
      pagesTruncated: true
    })
    expect(truncated.content?.[0]?.text).toContain('page list was truncated')
    expect(truncated.content?.[0]?.text).toContain('- Cover (0:1)')

    const empty = buildGetStructureToolResult({ roots: [], pages: [] })
    expect(empty.content?.[0]?.text).toContain('no pages were readable')
    expect(empty.content?.[0]?.text).not.toContain('page id as nodeId')
    expect(empty.content?.[0]?.text).not.toContain('Pages:')
  })

  it('summarizes empty download_assets responses', () => {
    const result = buildDownloadAssetsToolResult({ exports: [], rawImages: [] })
    const text = result.content?.[0]?.text ?? ''

    expect(text).toContain('No export renders were produced.')
    expect(text).toContain('No raw source images were found')
    expect(text).not.toContain('truncated')
  })

  it('builds design-system and canvas-apply summaries', () => {
    const designSystem = buildGetDesignSystemToolResult({
      catalogId: 'ds_1',
      components: [
        {
          ref: 'c1',
          tag: 'Button',
          name: 'Button',
          props: {}
        }
      ],
      variables: [],
      collections: [],
      styles: [],
      shaders: [],
      nextCursor: 12,
      warnings: ['No variables were found.']
    })
    expect(designSystem.content?.[0]?.text).toContain(
      'Returned 1 component, 0 variables, 0 styles, 0 collections, and 0 shaders from catalog ds_1.'
    )
    expect(designSystem.content?.[0]?.text).toContain('Continue this catalog with cursor 12')
    expect(designSystem.content?.[0]?.text).toContain(
      'Read one bounded definition with this catalogId and a returned ref.'
    )
    expect(designSystem.content?.[0]?.text).toContain('No variables were found.')

    const applied = buildApplyCanvasToolResult({
      rootNodeId: '2:1',
      nodeIdsByKey: { root: '2:1' },
      createdNodeIds: ['2:1'],
      updatedNodeIds: [],
      removedNodeIds: ['2:2'],
      mutationCount: 2,
      verification: {
        status: 'warning',
        nodesChecked: 1,
        referencesChecked: 0,
        warnings: [
          {
            code: 'optional-property',
            key: 'root',
            message: 'One optional property was skipped.'
          }
        ]
      }
    })
    expect(applied.content?.[0]?.text).toContain('Applied 2 canvas mutations')
    expect(applied.content?.[0]?.text).toContain(
      '1 node created, 0 nodes updated, and 1 node removed'
    )
    expect(applied.content?.[0]?.text).toContain('One optional property was skipped.')
    expect(applied.content?.[0]?.text).toContain('Root node: 2:1')
    expect(applied.content?.[0]?.text).toContain('structuredContent.nodeIdsByKey')
    expect(applied.structuredContent).toEqual({
      rootNodeId: '2:1',
      nodeIdsByKey: { root: '2:1' },
      mutationCount: 2,
      nodeChanges: { created: 1, updated: 0, removed: 1 },
      verification: {
        status: 'warning',
        nodesChecked: 1,
        referencesChecked: 0,
        warnings: [
          {
            code: 'optional-property',
            key: 'root',
            message: 'One optional property was skipped.'
          }
        ]
      }
    })

    const removed = buildApplyCanvasToolResult({
      rootNodeId: '2:1',
      rootRemoved: true,
      nodeIdsByKey: {},
      createdNodeIds: [],
      updatedNodeIds: [],
      removedNodeIds: [],
      mutationCount: 0,
      verification: {
        status: 'passed',
        nodesChecked: 0,
        referencesChecked: 0,
        warnings: []
      }
    })
    expect(removed.content?.[0]?.text).toContain('Root node is absent: 2:1')
    expect(removed.content?.[0]?.text).not.toContain('Reuse nodeIdsByKey')
  })

  it('summarizes an exact design-system definition without discovery guidance', () => {
    const result = buildGetDesignSystemToolResult({
      catalogId: 'ds_1',
      components: [],
      variables: [],
      collections: [],
      styles: [],
      details: {
        ref: 's1',
        kind: 'style',
        definition: { type: 'PAINT' }
      }
    })

    expect(result.content?.[0]?.text).toBe(
      'Returned bounded style definition s1 from catalog ds_1.'
    )
  })

  it('links screenshot bytes without embedding them in structured content', () => {
    const payload: ToolResultMap['get_screenshot'] = {
      format: 'png',
      width: 320,
      height: 200,
      scale: 1,
      bytes: 1024,
      asset: {
        hash: ASSET_HASH,
        url: 'https://example.com/assets/deadbeef',
        mimeType: 'image/png',
        size: 1024
      }
    }

    const result = buildGetScreenshotToolResult(payload)

    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'Screenshot 320x200 @1x (1.0 KB). Inspect the linked PNG for visual verification.'
      },
      {
        type: 'resource_link',
        uri: payload.asset.url,
        name: `Figma screenshot ${ASSET_HASH}.png`,
        description: '320x200 rendered Figma node',
        mimeType: 'image/png',
        size: 1024
      }
    ])
    expect(result.structuredContent).toEqual(payload)
  })
})
