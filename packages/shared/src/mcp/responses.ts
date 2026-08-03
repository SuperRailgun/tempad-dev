import type {
  DownloadAssetsResult,
  GetAssetsResult,
  GetCodeResult,
  GetScreenshotResult,
  GetStructureResult,
  GetTokenDefsResult
} from './tools'

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
    for (const page of pages) {
      lines.push(
        page.isCurrent ? `- ${page.name} (${page.id}) [current]` : `- ${page.name} (${page.id})`
      )
    }
    lines.push('Call this tool again with a page id as nodeId to outline that page.')
  }

  return lines.join('\n')
}

function describeStructureOutline(payload: GetStructureResult): string {
  const roots = payload.roots
  const nodeCount = countOutlineNodes(roots)
  const lines: string[] = []

  if (!roots.length) {
    lines.push('No structure nodes were returned.')
    return lines.join('\n')
  }

  lines.push(
    `Returned structure outline with ${formatCount(roots.length, 'root')} and ${formatCount(nodeCount, 'node')}.`
  )
  lines.push('Top-level nodes:')
  for (const root of roots) {
    lines.push(`- ${root.name} [${root.type}] (${root.id})`)
  }
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
  summary.push(
    payload.rawImages.length
      ? `Raw source images: ${formatCount(payload.rawImages.length, 'asset')}.`
      : 'No raw source images were found in the requested subtrees.'
  )

  if (payload.rawImagesTruncated) {
    summary.push(
      'Raw source images were truncated. Pass a more specific child node to reach the rest.'
    )
  }
  if (payload.warnings?.length) {
    summary.push(...payload.warnings)
  }

  summary.push('Download bytes from each asset.url. Read structuredContent for the full manifest.')

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
