import type { DocumentPage, GetStructureResult } from '@tempad-dev/shared'

import {
  MCP_TOOL_INLINE_BUDGET_BYTES,
  buildGetStructureToolResult,
  measureCallToolResultBytes
} from '@tempad-dev/shared'

import { buildSemanticTree, semanticTreeToOutline } from '@/mcp/semantic-tree'

import { CANVAS_NODE_KEY_NAME, readAuthoringKey } from './canvas/identity'

const STRUCTURE_NODE_LIMIT_STEPS = [240, 180, 140, 100, 70, 50] as const
/** Default cap for ordinary layer names (keeps large outlines compact). */
const STRUCTURE_MAX_NAME_CHARS = 48
/**
 * COMPONENT / INSTANCE / COMPONENT_SET names encode variant axes
 * (`theme=primary, size=large, shape=rect, ...`). Truncating them to 48 chars
 * collapses distinct variants into identical `shap...` labels — keep them whole.
 */
const STRUCTURE_VARIANT_NAME_MAX_CHARS = 256
const STRUCTURE_COORD_PRECISION = 10

const VARIANT_BEARING_TYPES = new Set(['COMPONENT', 'INSTANCE', 'COMPONENT_SET'])

type StructureNode = GetStructureResult['roots'][number]

export function handleGetStructure(roots: SceneNode[], depthLimit?: number): GetStructureResult {
  const tree = buildSemanticTree(roots, { depthLimit: depthLimit || undefined })
  const outline = semanticTreeToOutline(tree.roots)
  const authoringKeys = collectAuthoringKeys(roots, outline, STRUCTURE_NODE_LIMIT_STEPS[0])
  const compactRoots = compactStructure(outline, authoringKeys)
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

function compactStructure(
  roots: StructureNode[],
  authoringKeys: ReadonlyMap<string, string>
): StructureNode[] {
  if (!roots.length) return roots

  const initial = compactByNodeLimit(roots, STRUCTURE_NODE_LIMIT_STEPS[0], authoringKeys)
  if (estimateToolResultBytes(initial) <= MCP_TOOL_INLINE_BUDGET_BYTES) {
    return initial
  }

  for (const nodeLimit of STRUCTURE_NODE_LIMIT_STEPS.slice(1)) {
    const candidate = compactByNodeLimit(roots, nodeLimit, authoringKeys)
    if (estimateToolResultBytes(candidate) <= MCP_TOOL_INLINE_BUDGET_BYTES) {
      return candidate
    }
  }

  return []
}

function compactByNodeLimit(
  roots: StructureNode[],
  nodeLimit: number,
  authoringKeys: ReadonlyMap<string, string>
): StructureNode[] {
  let seen = 0

  const visit = (node: StructureNode): StructureNode | undefined => {
    if (seen >= nodeLimit) return undefined
    seen += 1
    const authoringKey = authoringKeys.get(node.id)

    const compact: StructureNode = {
      id: sanitizeId(node.id, `node-${seen}`),
      name: sanitizeName(node.name, node.type),
      type: sanitizeType(node.type),
      x: sanitizeNumber(node.x),
      y: sanitizeNumber(node.y),
      width: sanitizeNumber(node.width),
      height: sanitizeNumber(node.height),
      ...(authoringKey ? { authoringKey } : {})
    }

    const variantProperties = sanitizeVariantProperties(node.variantProperties)
    if (variantProperties) {
      compact.variantProperties = variantProperties
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

function collectAuthoringKeys(
  roots: SceneNode[],
  outline: StructureNode[],
  nodeLimit: number
): Map<string, string> {
  const keys = new Map<string, string>()
  const remaining = new Set<string>()

  const addIds = (nodes: StructureNode[]): boolean => {
    for (const node of nodes) {
      remaining.add(node.id)
      if (remaining.size >= nodeLimit || (node.children && addIds(node.children))) return true
    }
    return false
  }
  addIds(outline)
  if (!remaining.size) return keys

  const visit = (node: SceneNode): boolean => {
    if (remaining.delete(node.id)) {
      const key = readAuthoringKey(node, CANVAS_NODE_KEY_NAME)
      if (key) keys.set(node.id, key)
      if (!remaining.size) return true
    }
    if ('children' in node) {
      for (const child of node.children) {
        if (child.visible && visit(child)) return true
      }
    }
    return false
  }

  for (const root of roots) {
    if (visit(root)) break
  }
  return keys
}

function sanitizeName(value: unknown, type?: string): string {
  if (typeof value !== 'string') return ''
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  const maxChars =
    type && VARIANT_BEARING_TYPES.has(type)
      ? STRUCTURE_VARIANT_NAME_MAX_CHARS
      : STRUCTURE_MAX_NAME_CHARS
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`
}

function sanitizeVariantProperties(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const entries: Array<[string, string]> = []
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const key = typeof rawKey === 'string' ? rawKey.trim() : ''
    if (!key || typeof rawValue !== 'string') continue
    const trimmed = rawValue.trim()
    if (!trimmed) continue
    entries.push([key.slice(0, 64), trimmed.slice(0, 128)])
  }
  return entries.length ? Object.fromEntries(entries) : undefined
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
