import type { ZodType } from 'zod'

import { z } from 'zod'

import {
  MCP_DOWNLOAD_ASSETS_MAX_NODES,
  MCP_DOWNLOAD_ASSETS_MAX_SCALE,
  MCP_DOWNLOAD_ASSETS_MIN_SCALE,
  MCP_HASH_PATTERN
} from './constants'

export const AssetDescriptorSchema = z.object({
  hash: z.string().regex(MCP_HASH_PATTERN),
  url: z.string().url(),
  mimeType: z.string().min(1),
  size: z.number().int().nonnegative(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  themeable: z.boolean().optional()
})

// get_code
export const GetCodeParametersSchema = z.object({
  nodeId: z
    .string()
    .describe(
      'Optional target node id; omit to use the current single selection when pulling the baseline snapshot.'
    )
    .optional(),
  preferredLang: z
    .enum(['jsx', 'vue'])
    .describe(
      'Preferred output language to bias the snapshot; otherwise uses the design’s hint/detected language, then falls back to JSX.'
    )
    .optional(),
  resolveTokens: z
    .boolean()
    .describe(
      'Inline token values instead of references for quick renders; default false returns token metadata so you can map into your theming system. When true, values are resolved per-node (mode-aware).'
    )
    .optional(),
  vectorMode: z
    .enum(['smart', 'snapshot'])
    .describe(
      'Vector output mode. `smart` (default) emits `<svg data-src="...">` placeholders in code and preserves themeable instance color on the emitted SVG root markup for downstream adaptation; if asset upload fails after export, the tool may inline the SVG as a fallback to preserve source of truth. `snapshot` preserves vector assets for fidelity. Final vector delivery may still be adapted to the Host app’s SVG policy.'
    )
    .optional()
})

export type GetCodeParametersInput = z.input<typeof GetCodeParametersSchema>
export type GetCodeWarning = {
  type: 'auto-layout' | 'shell' | 'depth-cap'
  message: string
}
export type GetCodeResult = {
  code: string
  lang: 'vue' | 'jsx'
  assets?: AssetDescriptor[]
  tokens?: GetTokenDefsResult
  codegen: {
    plugin: string
    config: {
      cssUnit: 'px' | 'rem'
      rootFontSize: number
      scale: number
    }
  }
  warnings?: GetCodeWarning[]
}

// get_token_defs
export const GetTokenDefsParametersSchema = z.object({
  names: z
    .array(z.string().regex(/^--[a-zA-Z0-9-_]+$/))
    .min(1)
    .describe(
      'Canonical token names (CSS variable form) from Object.keys(get_code.tokens) or your own list to resolve, e.g., --color-primary. Omit to resolve every token used by nodeId/the current single selection.'
    )
    .optional(),
  nodeId: z
    .string()
    .describe(
      'Optional node id whose subtree tokens should be resolved when names is omitted; defaults to the current single selection.'
    )
    .optional(),
  includeAllModes: z
    .boolean()
    .describe(
      'Include all token modes (light/dark/etc.) instead of just the active one to mirror responsive tokens; default false.'
    )
    .optional()
})

export type GetTokenDefsParametersInput = z.input<typeof GetTokenDefsParametersSchema>
export type TokenEntry = {
  kind: 'color' | 'number' | 'string' | 'boolean'
  value: string | Record<string, string> // single mode -> string; multi-mode -> map (mode name -> literal or alias)
}

export type GetTokenDefsResult = {
  [canonicalName: string]: TokenEntry
}

// get_screenshot
export const GetScreenshotParametersSchema = z.object({
  nodeId: z
    .string()
    .describe(
      'Optional node id to screenshot; defaults to the current single selection. Useful when layout/overlap is uncertain (auto-layout none/inferred).'
    )
    .optional()
})

export type GetScreenshotParametersInput = z.input<typeof GetScreenshotParametersSchema>
export type GetScreenshotResult = {
  format: 'png'
  width: number
  height: number
  scale: number
  bytes: number
  asset: AssetDescriptor
}

// get_structure
export const GetStructureParametersSchema = z.object({
  nodeId: z
    .string()
    .describe(
      'Optional node id to outline; defaults to the current single selection. Useful when auto-layout hints are none/inferred or you need explicit geometry for refactors.'
    )
    .optional(),
  options: z
    .object({
      depth: z
        .number()
        .int()
        .positive()
        .describe('Limit traversal depth; defaults to full tree (subject to safety caps).')
        .optional()
    })
    .optional()
})

export type GetStructureParametersInput = z.input<typeof GetStructureParametersSchema>
export type OutlineNode = {
  id: string
  name: string
  type: string
  x: number
  y: number
  width: number
  height: number
  children?: OutlineNode[]
}
export type GetStructureResult = {
  roots: OutlineNode[]
}

// download_assets
export const DOWNLOAD_ASSET_FORMATS = ['png', 'jpg', 'svg', 'pdf'] as const

export const DownloadAssetsParametersSchema = z.object({
  nodeIds: z
    .array(z.string().min(1))
    .min(1)
    .max(MCP_DOWNLOAD_ASSETS_MAX_NODES)
    .describe(
      `Node ids to download assets for (max ${MCP_DOWNLOAD_ASSETS_MAX_NODES}); omit to use the current single selection.`
    )
    .optional(),
  defaultFormat: z
    .enum(DOWNLOAD_ASSET_FORMATS)
    .describe('Export format used for nodes without Figma export settings; defaults to png.')
    .optional(),
  defaultScale: z
    .number()
    .min(MCP_DOWNLOAD_ASSETS_MIN_SCALE)
    .max(MCP_DOWNLOAD_ASSETS_MAX_SCALE)
    .describe(
      `Export scale used for raster formats when a node has no export settings (${MCP_DOWNLOAD_ASSETS_MIN_SCALE}–${MCP_DOWNLOAD_ASSETS_MAX_SCALE}); defaults to 1.`
    )
    .optional()
})

export type DownloadAssetsParametersInput = z.input<typeof DownloadAssetsParametersSchema>
export type DownloadAssetFormat = (typeof DOWNLOAD_ASSET_FORMATS)[number]
export type DownloadAssetExport = AssetDescriptor & {
  nodeId: string
  nodeName: string
  kind: 'export'
  format: DownloadAssetFormat
  scale?: number
  fromExportSettings: boolean
}
export type DownloadAssetRawImage = AssetDescriptor & {
  figmaImageHash: string
  nodeIds: string[]
  source: 'raw'
}
export type DownloadAssetsResult = {
  exports: DownloadAssetExport[]
  rawImages: DownloadAssetRawImage[]
  rawImagesTruncated?: boolean
  warnings?: string[]
}

// get_assets (hub only)
export const GetAssetsParametersSchema = z.object({
  hashes: z
    .array(z.string().regex(MCP_HASH_PATTERN))
    .min(1)
    .describe(
      'Asset hashes returned from get_code (or other tools) to download/resolve exact bytes for rasterized images or SVGs before routing through your asset pipeline.'
    )
})

export const GetAssetsResultSchema = z.object({
  assets: z.array(AssetDescriptorSchema),
  missing: z.array(z.string().regex(MCP_HASH_PATTERN))
})

export type GetAssetsParametersInput = z.input<typeof GetAssetsParametersSchema>
export type GetAssetsResult = z.infer<typeof GetAssetsResultSchema>

export type AssetDescriptor = z.infer<typeof AssetDescriptorSchema>

export type ToolResultMap = {
  get_code: GetCodeResult
  get_token_defs: GetTokenDefsResult
  get_screenshot: GetScreenshotResult
  get_structure: GetStructureResult
  download_assets: DownloadAssetsResult
  get_assets: GetAssetsResult
}

export type ToolName = keyof ToolResultMap

export type ToolSchema<Name extends ToolName> = {
  name: Name
  description: string
  parameters: ZodType
  target: 'extension' | 'hub'
  outputSchema?: ZodType
  exposed?: boolean
}

/**
 * Official Figma MCP tool names that map onto TemPad tools with equivalent semantics.
 * Aliases are exposed alongside the TemPad names so community skills and agents can
 * keep calling the official names against this read-only pipeline.
 */
export const OFFICIAL_TOOL_ALIASES = {
  get_design_context: 'get_code',
  get_metadata: 'get_structure',
  get_variable_defs: 'get_token_defs'
} as const satisfies Record<string, ToolName>

export type OfficialToolAlias = keyof typeof OFFICIAL_TOOL_ALIASES

export function isOfficialToolAlias(name: string): name is OfficialToolAlias {
  return Object.hasOwn(OFFICIAL_TOOL_ALIASES, name)
}

/** Resolve an official alias to the TemPad tool that implements it; passthrough otherwise. */
export function resolveOfficialToolAlias(name: string): string {
  return isOfficialToolAlias(name) ? OFFICIAL_TOOL_ALIASES[name] : name
}
