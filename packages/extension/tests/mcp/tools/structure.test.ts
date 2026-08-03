import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildSemanticTree, semanticTreeToOutline } from '@/mcp/semantic-tree'
import { handleGetDocumentPages, handleGetStructure } from '@/mcp/tools/structure'

vi.mock('@/mcp/semantic-tree', () => ({
  buildSemanticTree: vi.fn(),
  semanticTreeToOutline: vi.fn()
}))

function setFigmaDocument(
  pages: Array<{ id: string; name: string; type?: string }>,
  currentPageId?: string,
  documentName = 'Design File'
): void {
  ;(globalThis as { figma?: PluginAPI }).figma = {
    root: { name: documentName, children: pages.map((page) => ({ type: 'PAGE', ...page })) },
    currentPage: currentPageId ? { id: currentPageId } : undefined
  } as unknown as PluginAPI
}

afterEach(() => {
  delete (globalThis as { figma?: PluginAPI }).figma
})

describe('mcp/tools/structure', () => {
  it('uses undefined depth when input depth is falsy and returns outline payload', () => {
    vi.mocked(buildSemanticTree).mockReturnValue({
      roots: [{ id: 'root-1' }]
    } as unknown as ReturnType<typeof buildSemanticTree>)
    vi.mocked(semanticTreeToOutline).mockReturnValue([{ id: 'outline-1' }] as never)

    const result = handleGetStructure([{ id: 'node-1', visible: true } as unknown as SceneNode], 0)

    expect(buildSemanticTree).toHaveBeenCalledWith([{ id: 'node-1', visible: true }], {
      depthLimit: undefined
    })
    expect(result).toEqual({
      roots: [
        {
          id: 'outline-1',
          name: '',
          type: 'UNKNOWN',
          x: 0,
          y: 0,
          width: 0,
          height: 0
        }
      ]
    })
  })

  it('passes explicit depth limit through to semantic tree builder', () => {
    vi.mocked(buildSemanticTree).mockReturnValue({ roots: [] } as unknown as ReturnType<
      typeof buildSemanticTree
    >)
    vi.mocked(semanticTreeToOutline).mockReturnValue([])

    handleGetStructure([], 3)

    expect(buildSemanticTree).toHaveBeenCalledWith([], { depthLimit: 3 })
  })

  it('compacts large outlines to keep structure output small', () => {
    vi.mocked(buildSemanticTree).mockReturnValue({ roots: [] } as unknown as ReturnType<
      typeof buildSemanticTree
    >)
    vi.mocked(semanticTreeToOutline).mockReturnValue(
      Array.from({ length: 400 }, (_, i) => ({
        id: `node-${i}`,
        name: 'Very long layer name '.repeat(20),
        type: 'FRAME',
        x: i + 0.1234,
        y: i + 0.5678,
        width: 100,
        height: 200
      })) as never
    )

    const result = handleGetStructure([])
    expect(countNodes(result.roots)).toBeLessThanOrEqual(240)
    expect(result.roots[0]?.name.length).toBeLessThanOrEqual(48)
    expect(result.roots[0]?.x).toBe(0.1)
  })
})

describe('mcp/tools/structure document pages', () => {
  it('lists the open document name and pages, flagging the open page', () => {
    setFigmaDocument(
      [
        { id: '0:1', name: 'Cover' },
        { id: '0:2', name: '  Components  ' },
        { id: '0:3', name: 'Specs' }
      ],
      '0:2'
    )

    const result = handleGetDocumentPages()

    expect(result.roots).toEqual([])
    expect(result.documentName).toBe('Design File')
    expect(result.pages).toEqual([
      { id: '0:1', name: 'Cover' },
      { id: '0:2', name: 'Components', isCurrent: true },
      { id: '0:3', name: 'Specs' }
    ])
    expect(result.pagesTruncated).toBeUndefined()
  })

  it('ignores non-page children and a missing document name', () => {
    ;(globalThis as { figma?: PluginAPI }).figma = {
      root: {
        name: '   ',
        children: [
          { id: '0:1', name: 'Page', type: 'PAGE' },
          { id: '0:9', name: 'Stray', type: 'FRAME' }
        ]
      },
      currentPage: { id: '0:1' }
    } as unknown as PluginAPI

    const result = handleGetDocumentPages()

    expect(result.documentName).toBeUndefined()
    expect(result.pages).toEqual([{ id: '0:1', name: 'Page', isCurrent: true }])
  })

  it('returns an empty page list when the document is unreadable', () => {
    ;(globalThis as { figma?: PluginAPI }).figma = {} as unknown as PluginAPI

    expect(handleGetDocumentPages()).toEqual({ roots: [], pages: [] })
  })

  it('truncates huge page lists but keeps the open page reachable', () => {
    const pages = Array.from({ length: 1500 }, (_, index) => ({
      id: `0:${index}`,
      name: `Page ${index} ${'name padding '.repeat(12)}`
    }))
    setFigmaDocument(pages, '0:1499')

    const result = handleGetDocumentPages()

    expect(result.pagesTruncated).toBe(true)
    expect(result.pages?.length).toBeLessThan(1500)
    expect(result.pages?.some((page) => page.isCurrent && page.id === '0:1499')).toBe(true)
  })
})

function countNodes(nodes: Array<{ children?: unknown[] }>): number {
  let count = 0
  const walk = (list: Array<{ children?: unknown[] }>) => {
    for (const node of list) {
      count += 1
      if (node.children?.length) {
        walk(node.children as Array<{ children?: unknown[] }>)
      }
    }
  }
  walk(nodes)
  return count
}
