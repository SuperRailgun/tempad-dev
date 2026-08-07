import type {
  DownloadAssetsParametersInput,
  DownloadAssetsResult,
  GetCodeParametersInput,
  GetCodeResult,
  GetScreenshotParametersInput,
  GetScreenshotResult,
  GetStructureParametersInput,
  GetStructureResult,
  GetTokenDefsParametersInput,
  GetTokenDefsResult
} from '@tempad-dev/shared'

import {
  MCP_DOWNLOAD_ASSETS_MAX_NODES,
  TEMPAD_MCP_ERROR_CODES,
  resolveOfficialToolAlias
} from '@tempad-dev/shared'

import { selection } from '@/ui/state'

import type { GetCodeRuntimeOptions } from './tools/code'

import { createCodedError } from './errors'
import { handleApplyCanvas } from './tools/canvas'
import { handleGetCode as runGetCode } from './tools/code'
import { handleGetDesignSystem } from './tools/design-system'
import { handleDownloadAssets as runDownloadAssets } from './tools/download-assets'
import { handleGetScreenshot as runGetScreenshot } from './tools/screenshot'
import {
  handleGetDocumentPages as runGetDocumentPages,
  handleGetStructure as runGetStructure
} from './tools/structure'
import {
  handleGetTokenDefs as runGetTokenDefs,
  handleGetTokenDefsForNodes as runGetTokenDefsForNodes
} from './tools/token'

function isSceneNode(node: BaseNode | null): node is SceneNode {
  return !!node && 'visible' in node && 'type' in node
}

function resolveSingleNode(nodeId?: string): SceneNode {
  if (nodeId) {
    const node = figma.getNodeById(nodeId)
    if (!node) {
      throw createCodedError(
        TEMPAD_MCP_ERROR_CODES.NODE_NOT_VISIBLE,
        `Node "${nodeId}" does not exist in the current document.`
      )
    }
    if (!isSceneNode(node)) {
      throw createCodedError(
        TEMPAD_MCP_ERROR_CODES.NODE_NOT_VISIBLE,
        `Node "${nodeId}" exists but is not a supported scene node.`
      )
    }
    if (!node.visible) {
      throw createCodedError(
        TEMPAD_MCP_ERROR_CODES.NODE_NOT_VISIBLE,
        `Node "${nodeId}" exists but is hidden.`
      )
    }
    return node
  }

  const [selectedNode] = selection.value
  if (selection.value.length !== 1 || !selectedNode?.visible) {
    throw createCodedError(
      TEMPAD_MCP_ERROR_CODES.INVALID_SELECTION,
      'Select exactly one visible node (or provide nodeId) to proceed.'
    )
  }

  return selectedNode
}

function resolveNodes(nodeIds?: string[]): SceneNode[] {
  if (!nodeIds?.length) {
    return [resolveSingleNode()]
  }

  if (nodeIds.length > MCP_DOWNLOAD_ASSETS_MAX_NODES) {
    throw new Error(
      `Too many nodeIds requested (${nodeIds.length}). Limit is ${MCP_DOWNLOAD_ASSETS_MAX_NODES}.`
    )
  }

  const unique = Array.from(new Set(nodeIds))
  return unique.map((nodeId) => resolveSingleNode(nodeId))
}

export type WindowGetCodeParametersInput = GetCodeParametersInput & {
  _unbounded?: boolean
}

async function handleGetCode(
  args?: GetCodeParametersInput,
  runtimeOptions?: GetCodeRuntimeOptions
): Promise<GetCodeResult> {
  const node = resolveSingleNode(args?.nodeId)
  const { preferredLang, resolveTokens, vectorMode } = args ?? {}
  return runGetCode([node], preferredLang, resolveTokens, vectorMode, runtimeOptions)
}

async function handleWindowGetCode(args?: WindowGetCodeParametersInput): Promise<GetCodeResult> {
  const { _unbounded, ...rest } = args ?? {}
  return handleGetCode(rest, {
    unbounded: _unbounded
  })
}

async function handleGetTokenDefs(args?: GetTokenDefsParametersInput): Promise<GetTokenDefsResult> {
  const { names, nodeId, includeAllModes } = args ?? {}
  if (!names?.length) {
    const node = resolveSingleNode(nodeId)
    return runGetTokenDefsForNodes([node], includeAllModes)
  }
  return runGetTokenDefs(names, includeAllModes)
}

async function handleGetScreenshot(
  args?: GetScreenshotParametersInput
): Promise<GetScreenshotResult> {
  const node = resolveSingleNode(args?.nodeId)
  return runGetScreenshot(node)
}

async function handleGetStructure(args?: GetStructureParametersInput): Promise<GetStructureResult> {
  const { nodeId, options } = args ?? {}
  const roots = await resolveStructureRoots(nodeId)
  if (!roots) {
    return runGetDocumentPages()
  }
  return runGetStructure(roots, options?.depth)
}

function isPageNode(node: BaseNode | null): node is PageNode {
  return !!node && node.type === 'PAGE'
}

async function readPageChildren(page: PageNode): Promise<SceneNode[]> {
  // Pages other than the open one may not be loaded yet.
  if (typeof page.loadAsync === 'function') {
    await page.loadAsync()
  }
  return page.children.filter((child) => child.visible)
}

/** Returns the roots to outline, or null when the document overview should be returned instead. */
async function resolveStructureRoots(nodeId?: string): Promise<SceneNode[] | null> {
  if (nodeId) {
    const node = figma.getNodeById(nodeId)
    if (isPageNode(node)) {
      return readPageChildren(node)
    }
    return [resolveSingleNode(nodeId)]
  }

  const [selected] = selection.value
  if (selection.value.length === 1 && selected?.visible) {
    return [selected]
  }

  return null
}

async function handleDownloadAssets(
  args?: DownloadAssetsParametersInput
): Promise<DownloadAssetsResult> {
  const { nodeIds, defaultFormat, defaultScale } = args ?? {}
  const nodes = resolveNodes(nodeIds)
  return runDownloadAssets(nodes, { defaultFormat, defaultScale })
}

export const MCP_TOOL_HANDLERS = {
  apply_canvas: handleApplyCanvas,
  get_code: handleGetCode,
  get_design_system: handleGetDesignSystem,
  get_token_defs: handleGetTokenDefs,
  get_screenshot: handleGetScreenshot,
  get_structure: handleGetStructure,
  download_assets: handleDownloadAssets
}

export type MCPHandlers = typeof MCP_TOOL_HANDLERS

export type TempadWindowHandlers = Omit<MCPHandlers, 'get_code'> & {
  get_code: (args?: WindowGetCodeParametersInput) => Promise<GetCodeResult>
}

declare global {
  interface Window {
    tempadTools?: Partial<TempadWindowHandlers>
  }
}

export const WINDOW_TEMPAD_TOOL_HANDLERS: TempadWindowHandlers = {
  ...MCP_TOOL_HANDLERS,
  get_code: handleWindowGetCode
}

function isMcpToolName(name: string): name is keyof MCPHandlers {
  return Object.hasOwn(MCP_TOOL_HANDLERS, name)
}

export async function runMcpTool(name: string, args: unknown): Promise<unknown> {
  const resolved = resolveOfficialToolAlias(name)
  if (!isMcpToolName(resolved)) {
    throw new Error(`No handler registered for tool "${name}".`)
  }
  const handler = MCP_TOOL_HANDLERS[resolved] as (args?: unknown) => Promise<unknown>
  return handler(args)
}

function exposeToolsOnWindow(): void {
  if (typeof window === 'undefined') {
    return
  }
  window.tempadTools = {
    ...(window.tempadTools ?? {}),
    ...WINDOW_TEMPAD_TOOL_HANDLERS
  }
}

exposeToolsOnWindow()
