import type {
  DownloadAssetsResult,
  GetAssetsResult,
  GetCodeResult,
  GetScreenshotResult,
  GetStructureResult,
  GetTokenDefsResult
} from './tools'

import { MCP_SUMMARY_INLINE_BUDGET_BYTES } from './constants'

const ENCODER = new TextEncoder()

export type ToolResponseContentBlock = {
  type: string
  text?: string
}

export type ToolResponseLike = {
  content?: ToolResponseContentBlock[]
  structuredContent?: unknown
  isError?: boolean
  _meta?: Record<string, unknown>
}

export function utf8Bytes(value: unknown): number {
  return ENCODER.encode(serializeUtf8Value(value)).length
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

  summary.push('Read structuredContent for the full code string and metadata.')

  return buildTextToolResult(summary.join('\n'), payload)
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
    'Top-level nodes:'
  ]

  lines.push(
    ...describeInlineList(
      roots,
      (root) => `- ${root.name || 'Unnamed'} [${root.type}] (${root.id})`,
      'root'
    )
  )
  lines.push(
    'Call this tool again with a child id as nodeId for more depth, or get_code / get_design_context for implementation.'
  )

  return lines.join('\n')
}

export function buildGetTokenDefsToolResult(payload: GetTokenDefsResult): ToolResponseLike {
  const count = Object.keys(payload).length
  const summary =
    count === 0
      ? 'No token definitions were resolved.'
      : `Resolved ${formatCount(count, 'token definition')}.`

  return buildTextToolResult(
    `${summary}\nRead structuredContent for token values and aliases.`,
    payload
  )
}

export function buildGetScreenshotToolResult(payload: GetScreenshotResult): ToolResponseLike {
  return buildTextToolResult(
    `${describeScreenshot(payload)} - Download: ${payload.asset.url}`,
    payload
  )
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

function serializeUtf8Value(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  return JSON.stringify(value, null, 0) ?? 'undefined'
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
