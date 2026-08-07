import { TEMPAD_MCP_ERROR_CODES } from '@tempad-dev/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  selection: {
    value: [] as Array<{ visible: boolean }>
  },
  runApplyCanvas: vi.fn(),
  runDownloadAssets: vi.fn(),
  runGetCode: vi.fn(),
  runGetDocumentPages: vi.fn(),
  runGetDesignSystem: vi.fn(),
  runGetScreenshot: vi.fn(),
  runGetStructure: vi.fn(),
  runGetTokenDefs: vi.fn(),
  runGetTokenDefsForNodes: vi.fn()
}))

vi.mock('@/ui/state', () => ({
  selection: mocks.selection
}))

vi.mock('@/mcp/tools/code', () => ({
  handleGetCode: mocks.runGetCode
}))

vi.mock('@/mcp/tools/canvas', () => ({
  handleApplyCanvas: mocks.runApplyCanvas
}))

vi.mock('@/mcp/tools/design-system', () => ({
  handleGetDesignSystem: mocks.runGetDesignSystem
}))

vi.mock('@/mcp/tools/screenshot', () => ({
  handleGetScreenshot: mocks.runGetScreenshot
}))

vi.mock('@/mcp/tools/structure', () => ({
  handleGetDocumentPages: mocks.runGetDocumentPages,
  handleGetStructure: mocks.runGetStructure
}))

vi.mock('@/mcp/tools/token', () => ({
  handleGetTokenDefs: mocks.runGetTokenDefs,
  handleGetTokenDefsForNodes: mocks.runGetTokenDefsForNodes
}))

vi.mock('@/mcp/tools/download-assets', () => ({
  handleDownloadAssets: mocks.runDownloadAssets
}))

function createSceneNode(id: string, visible = true): SceneNode {
  return {
    id,
    name: id,
    type: 'FRAME',
    visible
  } as unknown as SceneNode
}

function setFigmaGetNodeById(returnValue: BaseNode | null) {
  vi.stubGlobal('figma', {
    getNodeById: vi.fn().mockReturnValue(returnValue)
  } as unknown as PluginAPI)
}

async function importRuntime() {
  vi.resetModules()
  return import('@/mcp/runtime')
}

afterEach(() => {
  mocks.selection.value = []
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('mcp/runtime', () => {
  it('loads in node runtime without window global', async () => {
    setFigmaGetNodeById(null)
    const runtime = await importRuntime()

    expect(new Set(Object.keys(runtime.MCP_TOOL_HANDLERS))).toEqual(
      new Set([
        'apply_canvas',
        'get_code',
        'get_design_system',
        'get_token_defs',
        'get_screenshot',
        'get_structure',
        'download_assets'
      ])
    )
    expect(typeof (globalThis as { window?: unknown }).window).toBe('undefined')
  }, 15000)

  it('merges tool handlers onto existing window.tempadTools when window exists', async () => {
    const existing = vi.fn()
    vi.stubGlobal('window', { tempadTools: { existing } } as unknown as Window)
    setFigmaGetNodeById(null)

    const runtime = await importRuntime()
    const tools = (window as Window & { tempadTools: Record<string, unknown> }).tempadTools

    expect(tools).toEqual({ existing, ...runtime.WINDOW_TEMPAD_TOOL_HANDLERS })
  }, 15000)

  it('initializes window.tempadTools when window exists without existing tools', async () => {
    vi.stubGlobal('window', {} as Window)
    setFigmaGetNodeById(null)

    const runtime = await importRuntime()
    const tools = (window as Window & { tempadTools: Record<string, unknown> }).tempadTools

    expect(tools).toEqual(runtime.WINDOW_TEMPAD_TOOL_HANDLERS)
  })

  it('routes get_code to tool implementation with resolved node and options', async () => {
    const node = createSceneNode('node-1')
    setFigmaGetNodeById(node)
    mocks.runGetCode.mockResolvedValue({ blocks: [] })

    const runtime = await importRuntime()
    const result = await runtime.MCP_TOOL_HANDLERS.get_code({
      nodeId: 'node-1',
      preferredLang: 'jsx',
      resolveTokens: true,
      vectorMode: 'snapshot'
    })

    expect(mocks.runGetCode).toHaveBeenCalledWith([node], 'jsx', true, 'snapshot', undefined)
    expect(result).toEqual({ blocks: [] })
  })

  it('routes browser bridge calls through the runtime dispatcher', async () => {
    const node = createSceneNode('node-1')
    setFigmaGetNodeById(node)
    mocks.runGetCode.mockResolvedValue({ blocks: [] })

    const runtime = await importRuntime()
    const result = await runtime.runMcpTool('get_code', {
      nodeId: 'node-1',
      preferredLang: 'jsx'
    })

    expect(mocks.runGetCode).toHaveBeenCalledWith([node], 'jsx', undefined, undefined, undefined)
    expect(result).toEqual({ blocks: [] })
  })

  it.each(['missing', 'toString'])(
    'rejects unknown bridge tool name "%s" at the runtime boundary',
    async (name) => {
      setFigmaGetNodeById(null)
      const runtime = await importRuntime()

      await expect(runtime.runMcpTool(name, {})).rejects.toThrow(
        `No handler registered for tool "${name}".`
      )
    }
  )

  it('routes window get_code debug overrides only through tempadTools exposure', async () => {
    const node = createSceneNode('node-1')
    vi.stubGlobal('window', {} as Window)
    setFigmaGetNodeById(node)
    mocks.runGetCode.mockResolvedValue({ blocks: [] })

    await importRuntime()
    const tools = (
      window as Window & {
        tempadTools: Record<string, (args?: unknown) => Promise<unknown>>
      }
    ).tempadTools

    expect(tools.get_code).toBeDefined()
    await tools.get_code?.({
      nodeId: 'node-1',
      preferredLang: 'jsx',
      _unbounded: true
    })

    expect(mocks.runGetCode).toHaveBeenCalledWith([node], 'jsx', undefined, undefined, {
      unbounded: true
    })
  })

  it('distinguishes missing, unsupported, and hidden node ids', async () => {
    setFigmaGetNodeById(null)
    const runtime = await importRuntime()

    await expect(runtime.MCP_TOOL_HANDLERS.get_code({ nodeId: 'missing' })).rejects.toMatchObject({
      code: TEMPAD_MCP_ERROR_CODES.NODE_NOT_VISIBLE,
      message: expect.stringContaining('does not exist')
    })

    setFigmaGetNodeById({ id: 'document', type: 'DOCUMENT' } as unknown as BaseNode)
    await expect(runtime.MCP_TOOL_HANDLERS.get_code({ nodeId: 'document' })).rejects.toMatchObject({
      code: TEMPAD_MCP_ERROR_CODES.NODE_NOT_VISIBLE,
      message: expect.stringContaining('not a supported scene node')
    })

    setFigmaGetNodeById(createSceneNode('hidden', false))
    await expect(runtime.MCP_TOOL_HANDLERS.get_code({ nodeId: 'hidden' })).rejects.toMatchObject({
      code: TEMPAD_MCP_ERROR_CODES.NODE_NOT_VISIBLE,
      message: expect.stringContaining('is hidden')
    })
  })

  it('throws coded error for invalid current selection (empty or invisible)', async () => {
    setFigmaGetNodeById(null)
    const runtime = await importRuntime()

    mocks.selection.value = []
    await expect(runtime.MCP_TOOL_HANDLERS.get_code()).rejects.toMatchObject({
      code: TEMPAD_MCP_ERROR_CODES.INVALID_SELECTION
    })

    mocks.selection.value = [createSceneNode('hidden', false)]
    await expect(runtime.MCP_TOOL_HANDLERS.get_code()).rejects.toMatchObject({
      code: TEMPAD_MCP_ERROR_CODES.INVALID_SELECTION
    })
  })

  it('uses current visible selection when nodeId is omitted', async () => {
    const selected = createSceneNode('selected')
    mocks.selection.value = [selected]
    setFigmaGetNodeById(null)
    mocks.runGetCode.mockResolvedValue({ blocks: [{ lang: 'jsx', code: '<div />' }] })

    const runtime = await importRuntime()
    await runtime.MCP_TOOL_HANDLERS.get_code({ preferredLang: 'jsx' })
    await runtime.MCP_TOOL_HANDLERS.get_code()

    expect(mocks.runGetCode).toHaveBeenCalledWith(
      [selected],
      'jsx',
      undefined,
      undefined,
      undefined
    )
    expect(mocks.runGetCode).toHaveBeenLastCalledWith(
      [selected],
      undefined,
      undefined,
      undefined,
      undefined
    )
  })

  it('validates get_token_defs input and forwards includeAllModes', async () => {
    setFigmaGetNodeById(null)
    mocks.runGetTokenDefs.mockResolvedValue({ defs: [] })
    const runtime = await importRuntime()

    await runtime.MCP_TOOL_HANDLERS.get_token_defs({
      names: ['color-primary'],
      includeAllModes: true
    })
    expect(mocks.runGetTokenDefs).toHaveBeenCalledWith(['color-primary'], true)
  })

  it('resolves node-scoped token defs when names are omitted', async () => {
    const node = createSceneNode('node-3')
    setFigmaGetNodeById(node)
    mocks.selection.value = [node]
    mocks.runGetTokenDefsForNodes.mockResolvedValue({})

    const runtime = await importRuntime()

    await runtime.MCP_TOOL_HANDLERS.get_token_defs()
    expect(mocks.runGetTokenDefsForNodes).toHaveBeenCalledWith([node], undefined)

    await runtime.MCP_TOOL_HANDLERS.get_token_defs({ nodeId: 'node-3', includeAllModes: true })
    expect(mocks.runGetTokenDefsForNodes).toHaveBeenLastCalledWith([node], true)
    expect(mocks.runGetTokenDefs).not.toHaveBeenCalled()
  })

  it('routes official Figma MCP tool names to their TemPad implementations', async () => {
    const node = createSceneNode('node-alias')
    setFigmaGetNodeById(node)
    mocks.runGetCode.mockResolvedValue({ blocks: [] })
    mocks.runGetStructure.mockResolvedValue({ roots: [] })
    mocks.runGetTokenDefsForNodes.mockResolvedValue({})

    const runtime = await importRuntime()

    await runtime.runMcpTool('get_design_context', { nodeId: 'node-alias' })
    expect(mocks.runGetCode).toHaveBeenCalledWith(
      [node],
      undefined,
      undefined,
      undefined,
      undefined
    )

    await runtime.runMcpTool('get_metadata', { nodeId: 'node-alias' })
    expect(mocks.runGetStructure).toHaveBeenCalledWith([node], undefined)

    await runtime.runMcpTool('get_variable_defs', { nodeId: 'node-alias' })
    expect(mocks.runGetTokenDefsForNodes).toHaveBeenCalledWith([node], undefined)
  })

  it('routes download_assets with resolved nodes and export defaults', async () => {
    const node = createSceneNode('node-4')
    setFigmaGetNodeById(node)
    mocks.selection.value = [node]
    mocks.runDownloadAssets.mockResolvedValue({ exports: [], rawImages: [] })

    const runtime = await importRuntime()

    await runtime.MCP_TOOL_HANDLERS.download_assets({
      nodeIds: ['node-4', 'node-4'],
      defaultFormat: 'svg',
      defaultScale: 2
    })
    expect(mocks.runDownloadAssets).toHaveBeenCalledWith([node], {
      defaultFormat: 'svg',
      defaultScale: 2
    })

    await runtime.MCP_TOOL_HANDLERS.download_assets()
    expect(mocks.runDownloadAssets).toHaveBeenLastCalledWith([node], {
      defaultFormat: undefined,
      defaultScale: undefined
    })
  })

  it('rejects download_assets requests above the node limit', async () => {
    setFigmaGetNodeById(null)
    const runtime = await importRuntime()

    await expect(
      runtime.MCP_TOOL_HANDLERS.download_assets({
        nodeIds: Array.from({ length: 21 }, (_, index) => `node-${index}`)
      })
    ).rejects.toThrow('Too many nodeIds requested (21). Limit is 20.')
  })

  it('outlines a whole page when nodeId resolves to a page', async () => {
    const visibleChild = createSceneNode('child-visible')
    const hiddenChild = createSceneNode('child-hidden', false)
    const loadAsync = vi.fn().mockResolvedValue(undefined)
    setFigmaGetNodeById({
      id: '0:2',
      type: 'PAGE',
      loadAsync,
      children: [visibleChild, hiddenChild]
    } as unknown as BaseNode)
    mocks.runGetStructure.mockReturnValue({ roots: [] })

    const runtime = await importRuntime()
    await runtime.MCP_TOOL_HANDLERS.get_structure({ nodeId: '0:2', options: { depth: 2 } })

    expect(loadAsync).toHaveBeenCalledTimes(1)
    expect(mocks.runGetStructure).toHaveBeenCalledWith([visibleChild], 2)
    expect(mocks.runGetDocumentPages).not.toHaveBeenCalled()
  })

  it('returns the document page list when nothing is selected and no nodeId is given', async () => {
    setFigmaGetNodeById(null)
    mocks.selection.value = []
    mocks.runGetDocumentPages.mockReturnValue({ roots: [], pages: [{ id: '0:1', name: 'Cover' }] })

    const runtime = await importRuntime()
    const result = await runtime.MCP_TOOL_HANDLERS.get_structure()

    expect(mocks.runGetDocumentPages).toHaveBeenCalledTimes(1)
    expect(mocks.runGetStructure).not.toHaveBeenCalled()
    expect(result).toEqual({ roots: [], pages: [{ id: '0:1', name: 'Cover' }] })
  })

  it('returns the document page list through the official get_metadata name', async () => {
    setFigmaGetNodeById(null)
    mocks.selection.value = []
    mocks.runGetDocumentPages.mockReturnValue({ roots: [], pages: [] })

    const runtime = await importRuntime()
    await runtime.runMcpTool('get_metadata', {})

    expect(mocks.runGetDocumentPages).toHaveBeenCalledTimes(1)
  })

  it('routes screenshot and structure calls with node resolution and depth options', async () => {
    const node = createSceneNode('node-2')
    setFigmaGetNodeById(node)
    mocks.selection.value = [node]
    mocks.runGetScreenshot.mockResolvedValue({ imageData: 'data:image/png;base64,AA==' })
    mocks.runGetStructure.mockResolvedValue({ nodes: [] })

    const runtime = await importRuntime()

    await runtime.MCP_TOOL_HANDLERS.get_screenshot({ nodeId: 'node-2' })
    expect(mocks.runGetScreenshot).toHaveBeenCalledWith(node)

    await runtime.MCP_TOOL_HANDLERS.get_structure({ nodeId: 'node-2', options: { depth: 3 } })
    expect(mocks.runGetStructure).toHaveBeenCalledWith([node], 3)

    await runtime.MCP_TOOL_HANDLERS.get_structure()
    expect(mocks.runGetStructure).toHaveBeenLastCalledWith([node], undefined)
  })
})
