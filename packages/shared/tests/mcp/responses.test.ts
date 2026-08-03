import { describe, expect, it } from 'vitest'

import type { ToolResponseLike } from '../../src/mcp/responses'
import type { ToolResultMap } from '../../src/mcp/tools'

import {
  buildDownloadAssetsToolResult,
  buildGetCodeToolResult,
  buildGetStructureToolResult,
  buildGetTokenDefsToolResult,
  measureCallToolResultBytes,
  utf8Bytes
} from '../../src/mcp/responses'

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
    expect(result.content?.[0]?.text).not.toContain('Next: call get_code with')
  })

  it('builds structure and token tool summaries with structured content', () => {
    const structure = buildGetStructureToolResult({
      roots: [{ id: '1', name: 'Root', type: 'FRAME', x: 0, y: 0, width: 10, height: 10 }]
    })
    expect(structure.structuredContent).toEqual({
      roots: [{ id: '1', name: 'Root', type: 'FRAME', x: 0, y: 0, width: 10, height: 10 }]
    })
    expect(structure.content?.[0]?.text).toContain('Returned structure outline')

    const tokens = buildGetTokenDefsToolResult({
      '--color-primary': {
        kind: 'color',
        value: '#fff'
      }
    })
    expect(tokens.content?.[0]?.text).toContain('Resolved 1 token definition')
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
    expect(text).toContain('Download bytes from each asset.url.')
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
    expect(text).toContain('Call this tool again with a page id as nodeId')
    expect(text).not.toContain('truncated')
  })

  it('flags a truncated page list and an unreadable document', () => {
    const truncated = buildGetStructureToolResult({
      roots: [],
      pages: [{ id: '0:1', name: 'Cover' }],
      pagesTruncated: true
    })
    expect(truncated.content?.[0]?.text).toContain('page list was truncated')

    const empty = buildGetStructureToolResult({ roots: [], pages: [] })
    expect(empty.content?.[0]?.text).toContain('no pages were readable')
    expect(empty.content?.[0]?.text).not.toContain('page id as nodeId')
  })

  it('summarizes empty download_assets responses', () => {
    const result = buildDownloadAssetsToolResult({ exports: [], rawImages: [] })
    const text = result.content?.[0]?.text ?? ''

    expect(text).toContain('No export renders were produced.')
    expect(text).toContain('No raw source images were found')
    expect(text).not.toContain('truncated')
  })
})
