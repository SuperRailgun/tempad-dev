import type { DocumentPage, GetStructureResult } from '@tempad-dev/shared'

import {
  MCP_TOOL_INLINE_BUDGET_BYTES,
  buildGetStructureToolResult,
  measureCallToolResultBytes
} from '@tempad-dev/shared'

import { buildSemanticTree, semanticTreeToOutline } from '@/mcp/semantic-tree'

const STRUCTURE_NODE_LIMIT_STEPS = [240, 180, 140, 100, 70, 50]
const STRUCTURE_MAX_NAME_CHARS = 48
const STRUCTURE_COORD_PRECISION = 10

type StructureNode = GetStructureResult['roots'][number]

export function handleGetStructure(roots: SceneNode[], depthLimit?: number): GetStructureResult {
  // Prefer semantic-tree suggested cap when no explicit depth provided.
  const resolvedDepthLimit = depthLimit || undefined
  const tree = buildSemanticTree(roots, { depthLimit: resolvedDepthLimit })
  const outline = semanticTreeToOutline(tree.roots)
  const compactRoots = compactStructure(outline)
  if (!compactRoots.length && outline.length) {
    throw new Error(
      'Structure tool result exceeded the 64 KiB inline budget. Reduce selection or depth and retry.'
    )
  }

  return { roots: compactRoots }
}

/**
 * Overview of the open document: its name and every page, with the open one flagged.
 * Returned when there is nothing to outline yet, so an agent can pick a page id and
 * call back instead of hitting a selection error.
 */
export function handleGetDocumentPages(): GetStructureResult {
  const documentName = readDocumentName()
  const pages = readDocumentPages()
  const full: GetStructureResult = {
    roots: [],
    pages,
    ...(documentName ? { documentName } : {})
  }

  if (estimateResultBytes(full) <= MCP_TOOL_INLINE_BUDGET_BYTES) {
    return full
  }

  // Very large page lists still have to fit the inline budget; keep the head of the
  // list plus the open page so the agent always has a usable entry point.
  for (const limit of STRUCTURE_NODE_LIMIT_STEPS) {
    const candidate: GetStructureResult = {
      ...full,
      pages: trimPages(pages, limit),
      pagesTruncated: true
    }
    if (estimateResultBytes(candidate) <= MCP_TOOL_INLINE_BUDGET_BYTES) {
      return candidate
    }
  }

  throw new Error(
    'Document page list exceeded the 64 KiB inline budget. Select a node or pass a nodeId instead.'
  )
}

function readDocumentName(): string | undefined {
  const name = figma.root?.name
  return typeof name === 'string' && name.trim() ? name.trim() : undefined
}

function readDocumentPages(): DocumentPage[] {
  const children = figma.root?.children
  if (!Array.isArray(children)) return []

  const currentPageId = figma.currentPage?.id
  return children
    .filter((page): page is PageNode => page?.type === 'PAGE')
    .map((page) => ({
      id: page.id,
      name: sanitizeName(page.name),
      ...(page.id === currentPageId ? { isCurrent: true as const } : {})
    }))
}

function trimPages(pages: DocumentPage[], limit: number): DocumentPage[] {
  if (pages.length <= limit) return pages

  const head = pages.slice(0, limit)
  if (head.some((page) => page.isCurrent)) return head

  const current = pages.find((page) => page.isCurrent)
  return current ? [...head.slice(0, Math.max(0, limit - 1)), current] : head
}

function estimateResultBytes(payload: GetStructureResult): number {
  return measureCallToolResultBytes(buildGetStructureToolResult(payload))
}

function compactStructure(roots: StructureNode[]): StructureNode[] {
  if (!roots.length) return roots

  const initial = compactByNodeLimit(roots, STRUCTURE_NODE_LIMIT_STEPS[0])
  if (estimateToolResultBytes(initial) <= MCP_TOOL_INLINE_BUDGET_BYTES) {
    return initial
  }

  for (const nodeLimit of STRUCTURE_NODE_LIMIT_STEPS.slice(1)) {
    const candidate = compactByNodeLimit(roots, nodeLimit)
    if (estimateToolResultBytes(candidate) <= MCP_TOOL_INLINE_BUDGET_BYTES) {
      return candidate
    }
  }

  return []
}

function compactByNodeLimit(roots: StructureNode[], nodeLimit: number): StructureNode[] {
  let seen = 0

  const visit = (node: StructureNode): StructureNode | undefined => {
    if (seen >= nodeLimit) return undefined
    seen += 1

    const compact: StructureNode = {
      id: sanitizeId(node.id, `node-${seen}`),
      name: sanitizeName(node.name),
      type: sanitizeType(node.type),
      x: sanitizeNumber(node.x),
      y: sanitizeNumber(node.y),
      width: sanitizeNumber(node.width),
      height: sanitizeNumber(node.height)
    }

    if (Array.isArray(node.children) && node.children.length && seen < nodeLimit) {
      const children: StructureNode[] = []
      for (const child of node.children) {
        const compactChild = visit(child)
        if (!compactChild) break
        children.push(compactChild)
      }
      if (children.length) compact.children = children
    }

    return compact
  }

  const compactRoots: StructureNode[] = []
  for (const root of roots) {
    const compactRoot = visit(root)
    if (!compactRoot) break
    compactRoots.push(compactRoot)
  }
  return compactRoots
}

function sanitizeName(value: unknown): string {
  if (typeof value !== 'string') return ''
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  if (normalized.length <= STRUCTURE_MAX_NAME_CHARS) return normalized
  return `${normalized.slice(0, Math.max(0, STRUCTURE_MAX_NAME_CHARS - 3))}...`
}

function sanitizeId(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed || fallback
}

function sanitizeType(value: unknown): string {
  if (typeof value !== 'string') return 'UNKNOWN'
  const trimmed = value.trim()
  return trimmed || 'UNKNOWN'
}

function sanitizeNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.round(value * STRUCTURE_COORD_PRECISION) / STRUCTURE_COORD_PRECISION
}

function estimateToolResultBytes(roots: StructureNode[]): number {
  return estimateResultBytes({ roots })
}
