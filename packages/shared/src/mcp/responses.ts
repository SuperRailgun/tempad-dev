import type {
  DownloadAssetsResult,
  ApplyCanvasResult,
  GetAssetsResult,
  GetCodeResult,
  GetDesignSystemResult,
  GetScreenshotResult,
  GetStructureResult,
  GetTokenDefsResult
} from './tools'

import { MCP_SUMMARY_INLINE_BUDGET_BYTES } from './constants'

const ENCODER = new TextEncoder()

export type ToolResponseContentBlock = {
  type: string
  text?: string
  uri?: string
  name?: string
  description?: string
  mimeType?: string
  size?: number
}

export type ToolResponseLike = {
  content?: ToolResponseContentBlock[]
  structuredContent?: unknown
  isError?: boolean
  _meta?: Record<string, unknown>
}

export function utf8Bytes(value: unknown): number {
  const serialized =
    typeof value === 'string' ? value : (JSON.stringify(value, null, 0) ?? 'undefined')
  return ENCODER.encode(serialized).length
}

export function measureCallToolResultBytes(result: ToolResponseLike): number {
  return utf8Bytes(result)
}

export function buildGetCodeToolResult(payload: GetCodeResult): ToolResponseLike {
  const summary: string[] = []
  const codeSize = utf8Bytes(payload.code)
  summary.push(`Generated \`${payload.lang}\` snippet (${formatBytes(codeSize)}).`)

  if (payload.warnings?.length) {
    summary.push(...payload.warnings.map((warning) => warning.message))
  }

  summary.push(
    payload.assets?.length
      ? `Assets attached: ${payload.assets.length}. Download bytes from each asset.url.`
      : 'No binary assets were attached to this response.'
  )

  const tokenCount = payload.tokens ? Object.keys(payload.tokens).length : 0
  if (tokenCount) {
    summary.push(`Token references included: ${tokenCount}.`)
  }

  // Prefer inlining a usable code/token preview for clients that drop structuredContent.
  if (payload.code) {
    const previewBudget = Math.min(MCP_SUMMARY_INLINE_BUDGET_BYTES, 6 * 1024)
    if (utf8Bytes(payload.code) <= previewBudget) {
      summary.push('Code:')
      summary.push(payload.code)
    } else {
      summary.push(
        `Code preview omitted (${formatBytes(codeSize)} > ${formatBytes(previewBudget)}); read structuredContent.code when available, or call get_code on a smaller nodeId.`
      )
    }
  }

  if (payload.tokens && tokenCount) {
    const tokenEntries = Object.entries(payload.tokens)
    summary.push('Tokens:')
    summary.push(
      ...describeInlineList(
        tokenEntries,
        ([name, entry]) => `- ${name} (${entry.kind}): ${formatTokenEntryValue(entry.value)}`,
        'token'
      )
    )
  }

  return buildTextToolResult(summary.join('\n'), payload)
}

export function buildGetDesignSystemToolResult(payload: GetDesignSystemResult): ToolResponseLike {
  if (payload.details) {
    return buildTextToolResult(
      `Returned bounded ${payload.details.kind} definition ${payload.details.ref} from catalog ${payload.catalogId}.`,
      payload
    )
  }
  const summary = `Returned ${formatCount(payload.components.length, 'component')}, ${formatCount(payload.variables.length, 'variable')}, ${formatCount(payload.styles.length, 'style')}, ${formatCount(payload.collections.length, 'collection')}, and ${formatCount(payload.shaders?.length ?? 0, 'shader')} from catalog ${payload.catalogId}.`
  const warnings = payload.warnings?.length ? `\n${payload.warnings.join('\n')}` : ''
  const continuation =
    payload.nextCursor === undefined
      ? ''
      : ` Continue this catalog with cursor ${payload.nextCursor} to inspect omitted resources.`
  return buildTextToolResult(
    `${summary}${warnings}\nRead structuredContent for deterministic short refs and component tags.${continuation} Read one bounded definition with this catalogId and a returned ref.`,
    payload
  )
}

export function buildApplyCanvasToolResult(payload: ApplyCanvasResult): ToolResponseLike {
  const nodeChanges = {
    created: payload.createdNodeIds.length,
    updated: payload.updatedNodeIds.length,
    removed: payload.removedNodeIds.length
  }
  const summary = `Applied ${formatCount(payload.mutationCount, 'canvas mutation')}: ${formatCount(nodeChanges.created, 'node')} created, ${formatCount(nodeChanges.updated, 'node')} updated, and ${formatCount(nodeChanges.removed, 'node')} removed.`
  const verification = `Structural verification ${payload.verification.status}: ${formatCount(payload.verification.nodesChecked, 'node')} and ${formatCount(payload.verification.referencesChecked, 'native reference')} checked.`
  const warnings = payload.verification.warnings.length
    ? `\n${payload.verification.warnings.map(({ key, message }) => `${key ? `${key}: ` : ''}${message}`).join('\n')}`
    : ''
  const root = payload.rootRemoved
    ? `Root node is absent: ${payload.rootNodeId}. Repeating the same assertion is safe.`
    : `Root node: ${payload.rootNodeId}.`
  const identities = payload.rootRemoved
    ? ''
    : '\nRead structuredContent.nodeIdsByKey before a follow-up update or component instance call.'
  return buildTextToolResult(`${summary}\n${verification}${warnings}\n${root}${identities}`, {
    rootNodeId: payload.rootNodeId,
    ...(payload.rootRemoved ? { rootRemoved: true } : {}),
    nodeIdsByKey: payload.nodeIdsByKey,
    mutationCount: payload.mutationCount,
    nodeChanges,
    verification: payload.verification
  })
}

export function buildGetStructureToolResult(payload: GetStructureResult): ToolResponseLike {
  if (payload.pages) {
    return buildTextToolResult(describeDocumentPages(payload), payload)
  }

  return buildTextToolResult(describeStructureOutline(payload), payload)
}

function describeDocumentPages(payload: GetStructureResult): string {
  const pages = payload.pages ?? []
  const lines: string[] = []
  const fileLabel = payload.documentName ? ` of "${payload.documentName}"` : ''

  lines.push(
    pages.length
      ? `Nothing is selected, so this is the page list${fileLabel}: ${formatCount(pages.length, 'page')}.`
      : `Nothing is selected and no pages were readable${fileLabel}.`
  )

  const current = pages.find((page) => page.isCurrent)
  if (current) {
    lines.push(`Open page: "${current.name}" (${current.id}).`)
  }
  if (payload.pagesTruncated) {
    lines.push('The page list was truncated to fit the response budget.')
  }

  if (pages.length) {
    // Clients such as Cursor often surface only the text block to the agent, so the
    // usable page ids must live here — not only in structuredContent.
    lines.push('Pages:')
    lines.push(
      ...describeInlineList(
        pages,
        (page) => `- ${page.name || 'Unnamed'} (${page.id})${page.isCurrent ? ' [current]' : ''}`,
        'page'
      )
    )
    lines.push('Call this tool again with a page id as nodeId to outline that page.')
  }

  return lines.join('\n')
}

function describeStructureOutline(payload: GetStructureResult): string {
  const roots = payload.roots
  if (!roots.length) return 'No structure nodes were returned.'

  const nodeCount = countOutlineNodes(roots)
  const lines: string[] = [
    `Returned structure outline with ${formatCount(roots.length, 'root')} and ${formatCount(nodeCount, 'node')}.`,
    // Clients such as Cursor often surface only the text block, so the usable tree
    // (ids, full variant names, variantProperties) must live here — not only in
    // structuredContent.
    'Outline:'
  ]

  lines.push(...describeInlineOutlineTree(roots))
  lines.push(
    'Call this tool again with a child id as nodeId for more depth, or use get_screenshot / get_token_defs for visual and token evidence.'
  )

  return lines.join('\n')
}

/**
 * Depth-first outline lines for the text summary. Stops when the shared inline
 * budget is exhausted so large trees still leave actionable head nodes visible.
 */
function describeInlineOutlineTree(roots: GetStructureResult['roots']): string[] {
  type FlatLine = { depth: number; node: GetStructureResult['roots'][number] }
  const flat: FlatLine[] = []

  const walk = (nodes: GetStructureResult['roots'], depth: number) => {
    for (const node of nodes) {
      flat.push({ depth, node })
      if (node.children?.length) walk(node.children, depth + 1)
    }
  }
  walk(roots, 0)

  return describeInlineList(
    flat,
    ({ depth, node }) => {
      const indent = '  '.repeat(depth)
      const size =
        Number.isFinite(node.width) && Number.isFinite(node.height)
          ? ` ${node.width}x${node.height}`
          : ''
      const variants = formatVariantProperties(node.variantProperties)
      return `${indent}- ${node.name || 'Unnamed'} [${node.type}] (${node.id})${size}${variants}`
    },
    'node'
  )
}

function formatVariantProperties(variants: Record<string, string> | undefined): string {
  if (!variants) return ''
  const entries = Object.entries(variants)
  if (!entries.length) return ''
  return ` {${entries.map(([key, value]) => `${key}=${value}`).join(', ')}}`
}

export function buildGetTokenDefsToolResult(payload: GetTokenDefsResult): ToolResponseLike {
  const entries = Object.entries(payload)
  const lines: string[] = [
    entries.length === 0
      ? 'No token definitions were resolved.'
      : `Resolved ${formatCount(entries.length, 'token definition')}.`
  ]

  if (entries.length) {
    // Inline values so Cursor (and other clients that drop structuredContent) can
    // still read literal colors/sizes without a fallback script.
    lines.push('Tokens:')
    lines.push(
      ...describeInlineList(
        entries,
        ([name, entry]) => `- ${name} (${entry.kind}): ${formatTokenEntryValue(entry.value)}`,
        'token'
      )
    )
  }

  return buildTextToolResult(lines.join('\n'), payload)
}

function formatTokenEntryValue(value: string | Record<string, string>): string {
  if (typeof value === 'string') return value
  return Object.entries(value)
    .map(([mode, literal]) => `${mode}=${literal}`)
    .join('; ')
}

export function buildGetScreenshotToolResult(payload: GetScreenshotResult): ToolResponseLike {
  return {
    content: [
      {
        type: 'text',
        text: `${describeScreenshot(payload)}. Inspect the linked PNG for visual verification.`
      },
      {
        type: 'resource_link',
        uri: payload.asset.url,
        name: `Figma screenshot ${payload.asset.hash}.png`,
        description: `${payload.width}x${payload.height} rendered Figma node`,
        mimeType: payload.asset.mimeType,
        size: payload.asset.size
      }
    ],
    structuredContent: payload
  }
}

export function buildDownloadAssetsToolResult(payload: DownloadAssetsResult): ToolResponseLike {
  const summary: string[] = []

  summary.push(
    payload.exports.length
      ? `Export renders: ${formatCount(payload.exports.length, 'asset')}.`
      : 'No export renders were produced.'
  )
  if (payload.exports.length) {
    summary.push(
      ...describeInlineList(
        payload.exports,
        (entry) => `- ${entry.nodeName || entry.nodeId} [${entry.format}] ${entry.url}`,
        'export'
      )
    )
  }

  summary.push(
    payload.rawImages.length
      ? `Raw source images: ${formatCount(payload.rawImages.length, 'asset')}.`
      : 'No raw source images were found in the requested subtrees.'
  )
  if (payload.rawImages.length) {
    summary.push(
      ...describeInlineList(
        payload.rawImages,
        (entry) => `- ${entry.mimeType} ${entry.url}`,
        'raw image'
      )
    )
  }

  if (payload.rawImagesTruncated) {
    summary.push(
      'Raw source images were truncated. Pass a more specific child node to reach the rest.'
    )
  }
  if (payload.warnings?.length) {
    summary.push(...payload.warnings)
  }

  summary.push('Download bytes from each URL above.')

  return buildTextToolResult(summary.join('\n'), payload)
}

export function buildGetAssetsToolResult(payload: GetAssetsResult): ToolResponseLike {
  const summary: string[] = []
  summary.push(
    payload.assets.length
      ? `Resolved ${formatCount(payload.assets.length, 'asset')}.`
      : 'No assets were resolved for the requested hashes.'
  )
  if (payload.missing.length) {
    summary.push(`Missing: ${payload.missing.join(', ')}`)
  }
  summary.push('Download bytes from each asset.url.')

  return buildTextToolResult(summary.join('\n'), payload)
}

/**
 * Renders one line per item, stopping at a byte budget so a long list cannot crowd
 * out the response. Inlining matters because several MCP clients hand the agent only
 * the text block, leaving ids and URLs in structuredContent unreachable.
 */
function describeInlineList<T>(items: T[], format: (item: T) => string, label: string): string[] {
  const lines: string[] = []
  let used = 0

  for (const [index, item] of items.entries()) {
    const line = format(item)
    used += utf8Bytes(line) + 1
    if (used > MCP_SUMMARY_INLINE_BUDGET_BYTES) {
      const remaining = items.length - index
      lines.push(
        `- ...and ${formatCount(remaining, `more ${label}`)}; read structuredContent for the rest.`
      )
      break
    }
    lines.push(line)
  }

  return lines
}

function buildTextToolResult(text: string, structuredContent: unknown): ToolResponseLike {
  return {
    content: [
      {
        type: 'text',
        text
      }
    ],
    structuredContent
  }
}

function countOutlineNodes(nodes: GetStructureResult['roots']): number {
  let count = 0
  const stack = [...nodes]
  while (stack.length) {
    const current = stack.pop()
    if (!current) continue
    count += 1
    if (current.children?.length) {
      stack.push(...current.children)
    }
  }
  return count
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatCount(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`
}

function describeScreenshot(result: GetScreenshotResult): string {
  return `Screenshot ${result.width}x${result.height} @${result.scale}x (${formatBytes(result.bytes)})`
}
