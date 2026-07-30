import { describe, expect, it } from 'vitest'

import {
  AssetDescriptorSchema,
  DownloadAssetsParametersSchema,
  GetAssetsParametersSchema,
  GetAssetsResultSchema,
  GetCodeParametersSchema,
  GetScreenshotParametersSchema,
  GetStructureParametersSchema,
  GetTokenDefsParametersSchema,
  isOfficialToolAlias,
  OFFICIAL_TOOL_ALIASES,
  resolveOfficialToolAlias
} from '../../src/mcp/tools'

describe('mcp/tools AssetDescriptorSchema', () => {
  it('accepts a valid asset descriptor', () => {
    const parsed = AssetDescriptorSchema.safeParse({
      hash: 'deadbeef',
      url: 'https://example.com/a.png',
      mimeType: 'image/png',
      size: 1024,
      width: 300,
      height: 200,
      themeable: true
    })

    expect(parsed.success).toBe(true)
  })

  it('rejects negative size and non-protocol hashes', () => {
    const invalidSize = AssetDescriptorSchema.safeParse({
      hash: 'deadbeef',
      url: 'https://example.com/a.png',
      mimeType: 'image/png',
      size: -1
    })
    expect(invalidSize.success).toBe(false)
    expect(
      AssetDescriptorSchema.safeParse({
        hash: 'not-a-hash',
        url: 'https://example.com/a.png',
        mimeType: 'image/png',
        size: 1
      }).success
    ).toBe(false)
  })
})

describe('mcp/tools parameter schemas', () => {
  it('accepts optional get_code params and validates preferred language enum', () => {
    expect(GetCodeParametersSchema.safeParse({}).success).toBe(true)
    expect(
      GetCodeParametersSchema.safeParse({
        nodeId: '123:456',
        preferredLang: 'vue',
        resolveTokens: true,
        vectorMode: 'snapshot'
      }).success
    ).toBe(true)
    expect(
      GetCodeParametersSchema.safeParse({
        preferredLang: 'svelte'
      }).success
    ).toBe(false)
    expect(
      GetCodeParametersSchema.safeParse({
        vectorMode: 'fidelity'
      }).success
    ).toBe(false)
  })

  it('enforces token name canonical format and non-empty names list', () => {
    expect(
      GetTokenDefsParametersSchema.safeParse({
        names: ['--color-primary', '--spacing-2'],
        includeAllModes: false
      }).success
    ).toBe(true)

    expect(
      GetTokenDefsParametersSchema.safeParse({
        names: [],
        includeAllModes: true
      }).success
    ).toBe(false)

    expect(
      GetTokenDefsParametersSchema.safeParse({
        names: ['color-primary']
      }).success
    ).toBe(false)
  })

  it('accepts node-scoped token defs requests without names', () => {
    expect(GetTokenDefsParametersSchema.safeParse({}).success).toBe(true)
    expect(
      GetTokenDefsParametersSchema.safeParse({ nodeId: '1:2', includeAllModes: true }).success
    ).toBe(true)
  })

  it('validates download_assets node limits, formats and scale bounds', () => {
    expect(DownloadAssetsParametersSchema.safeParse({}).success).toBe(true)
    expect(
      DownloadAssetsParametersSchema.safeParse({
        nodeIds: ['1:2', '3:4'],
        defaultFormat: 'svg',
        defaultScale: 2
      }).success
    ).toBe(true)

    expect(DownloadAssetsParametersSchema.safeParse({ nodeIds: [] }).success).toBe(false)
    expect(
      DownloadAssetsParametersSchema.safeParse({
        nodeIds: Array.from({ length: 21 }, (_, index) => `1:${index}`)
      }).success
    ).toBe(false)
    expect(DownloadAssetsParametersSchema.safeParse({ defaultFormat: 'webp' }).success).toBe(false)
    expect(DownloadAssetsParametersSchema.safeParse({ defaultScale: 0 }).success).toBe(false)
    expect(DownloadAssetsParametersSchema.safeParse({ defaultScale: 5 }).success).toBe(false)
  })

  it('accepts empty screenshot params and optional structure depth', () => {
    expect(GetScreenshotParametersSchema.safeParse({}).success).toBe(true)
    expect(GetScreenshotParametersSchema.safeParse({ nodeId: '9:99' }).success).toBe(true)

    expect(
      GetStructureParametersSchema.safeParse({
        nodeId: '1:2',
        options: { depth: 2 }
      }).success
    ).toBe(true)

    expect(
      GetStructureParametersSchema.safeParse({
        options: { depth: 0 }
      }).success
    ).toBe(false)
  })

  it('validates get_assets hash inputs and get_assets result shape', () => {
    expect(
      GetAssetsParametersSchema.safeParse({
        hashes: ['deadbeef', '0123abcd']
      }).success
    ).toBe(true)

    expect(
      GetAssetsParametersSchema.safeParse({
        hashes: ['bad-hash']
      }).success
    ).toBe(false)

    expect(
      GetAssetsResultSchema.safeParse({
        assets: [
          {
            hash: 'deadbeef',
            url: 'https://example.com/a.png',
            mimeType: 'image/png',
            size: 10
          }
        ],
        missing: ['beefcafe']
      }).success
    ).toBe(true)
    expect(GetAssetsResultSchema.safeParse({ assets: [], missing: ['not-a-hash'] }).success).toBe(
      false
    )
  })
})

describe('mcp/tools official aliases', () => {
  it('maps official Figma MCP names onto TemPad tools', () => {
    expect(OFFICIAL_TOOL_ALIASES).toEqual({
      get_design_context: 'get_code',
      get_metadata: 'get_structure',
      get_variable_defs: 'get_token_defs'
    })
  })

  it('recognizes and resolves aliases, passing other names through', () => {
    expect(isOfficialToolAlias('get_design_context')).toBe(true)
    expect(isOfficialToolAlias('get_code')).toBe(false)
    expect(isOfficialToolAlias('toString')).toBe(false)

    expect(resolveOfficialToolAlias('get_metadata')).toBe('get_structure')
    expect(resolveOfficialToolAlias('get_variable_defs')).toBe('get_token_defs')
    expect(resolveOfficialToolAlias('get_code')).toBe('get_code')
    expect(resolveOfficialToolAlias('download_assets')).toBe('download_assets')
  })
})
