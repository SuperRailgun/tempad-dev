# Official Figma MCP tool compatibility

TemPad Dev exposes its MCP tools under the [official Figma MCP tool names](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/) in addition to its own names. Agents and skills written against the official server can call TemPad Dev without changing tool names or parameters, while the read-only browser-extension pipeline stays unchanged (no Figma account, token, or write access required).

## Tool mapping

| Official name                | TemPad Dev tool   | Notes                                                                                                    |
| ---------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------- |
| `get_design_context`         | `get_code`        | Alias. Same parameters and result as `get_code`.                                                         |
| `get_metadata`               | `get_structure`   | Alias. Structural outline (ids, names, types, geometry) as JSON rather than the official sparse XML.     |
| `get_metadata` (no `nodeId`) | `get_structure`   | Returns the open document's page list, matching the official recovery path. See below.                   |
| `get_variable_defs`          | `get_token_defs`  | Alias. Without `names`, resolves every token used by `nodeId`/the current selection; `names` narrows it. |
| `get_screenshot`             | `get_screenshot`  | Same name. Returns a PNG asset URL; inline base64 (`enableBase64Response`) is not supported.             |
| `download_assets`            | `download_assets` | Same name. Returns `exports` plus `rawImages` for up to 20 nodes.                                        |
| —                            | `get_assets`      | TemPad-specific: resolve asset hashes from earlier responses back to download URLs.                      |

Both names are registered with the MCP server, so `tools/list` shows the official name and the TemPad name. Aliases forward the canonical tool name to the extension, so behavior and payloads are identical.

## Exploring a whole file

A whole Figma file never fits one tool response, so `get_structure` (`get_metadata`) walks it in layers, the same way the official server does:

1. Call it with no `nodeId` and nothing selected. Instead of a selection error you get the open document: `documentName` plus `pages`, where the open page carries `isCurrent: true`. `roots` is empty in this shape. The text summary lists every page as `- name (id)` so agents can pick an id even when the client hides `structuredContent`.
2. Call it again with a page id as `nodeId` to outline that page's visible top-level frames. Pages other than the open one are loaded on demand. The text summary lists top-level nodes the same way.
3. Drill into any returned frame id with `get_structure` for more depth, or `get_code` for its implementation.

The page list is capped by the same 64 KiB inline budget as everything else; when a document has more pages than fit, `pagesTruncated` is `true` and the open page is kept in the list so there is always a usable entry point.

Unlike the official server, a `nodeId` that fails to resolve returns a plain error rather than an error carrying the page list. Call with no `nodeId` to recover.

## `download_assets`

Every call returns both kinds of output for the requested nodes:

- `exports`: each node rendered with the export settings configured in Figma. Nodes without export settings use `defaultFormat` (`png` by default) and, for raster formats, `defaultScale` (`1` by default, range `0.01`–`4`). `fromExportSettings` records which path was used.
- `rawImages`: the original uploaded JPEG/PNG/GIF/WebP files placed as fills anywhere in the requested subtrees, returned without re-rendering. Entries are deduplicated by Figma image hash and carry the `nodeIds` that reference them.

At most 20 nodes are accepted per call and at most 20 distinct raw source images are returned; when more exist, `rawImagesTruncated` is `true` and a more specific child node should be requested. Individual export or raw-image failures are reported in `warnings` instead of failing the call.

Choose `get_screenshot` to see what a design looks like, and `download_assets` to deliver files, control the export format, or recover original source images.

## Not implemented

These official tools need a Figma account, write access, or Figma-hosted services that are out of scope for a local read-only pipeline:

`use_figma`, `upload_assets`, `create_new_file`, `generate_diagram`, `generate_figma_design`, `whoami`, `search_design_system`, `get_libraries`, `get_motion_context`, `get_figjam`, the Code Connect tools (`add_code_connect_map`, `get_code_connect_map`, `get_code_connect_suggestions`, `get_context_for_code_connect`, `send_code_connect_mappings`), and the shader tools (`get_shader_effect`, `get_shader_fill`, `list_shader_effects`, `list_shader_fills`).

## Running and verifying locally

For a step-by-step local check with expected results and troubleshooting, see the [local verification runbook](./local-verification-runbook.md).

Building this repo needs Node 22.18+ (or 24+), even though the published MCP server only needs Node 18.20+. `tsdown` loads its TypeScript config through Node's native type stripping, which older releases lack; on those, `pnpm install` already fails while building `packages/shared`.

Build the packages and load the development extension:

```bash
pnpm install          # also builds packages/shared via its prepare script
pnpm build:mcp        # builds packages/mcp-server/dist/cli.mjs
pnpm dev              # WXT dev server for the extension
```

Load `packages/extension/.output/chrome-mv3-dev` through `chrome://extensions` → **Load unpacked**, open a Figma file, then enable **Preferences → Agent integration → MCP access** in the TemPad Dev panel and allow the loopback connection. The MCP badge in the panel title bar must read **Active**; with several Figma tabs open, click the badge in the tab the agent should inspect.

Point the MCP client at the local build instead of the published package, for example in `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "tempad-dev": {
      "command": "node",
      "args": ["<repo>/packages/mcp-server/dist/cli.mjs"]
    }
  }
}
```

Two checks run against the built Hub without needing Figma:

```bash
pnpm -C packages/mcp-server probe:tools
pnpm -C packages/mcp-server probe:tools --call get_design_context --args '{"nodeId":"1:2"}'
pnpm -C packages/mcp-server check:tool-routing
```

`probe:tools` lists the registered tools, fails when an expected name is missing, and can invoke one tool. Without a connected extension every call fails with `NO_ACTIVE_EXTENSION`, which still proves the tool is registered and routed.

`check:tool-routing` connects a fake extension WebSocket client alongside a real MCP consumer and asserts that each exposed tool reaches the extension under its canonical TemPad name, so an alias that leaked its own name or lost its formatter fails the check.

With the extension connected, confirm the design path in Figma: select a node, then call `get_design_context` (should match `get_code`), `get_screenshot` (returns a PNG `asset.url`), and `download_assets` on a node containing an image fill (should return both `exports` and `rawImages`). Hub logs are written to `tempad-dev/log` under the system temp directory (override with `TEMPAD_MCP_LOG_DIR`).

## Reading results

Every tool result carries a text summary plus the full payload in `structuredContent`. Prefer `structuredContent` when the client exposes it (geometry, nested children, token objects, asset metadata). Some clients (Cursor among them) surface only the text block to the agent, so the values needed to make the next call are inlined in the summary too: page and top-level node ids from `get_structure` / `get_metadata`, and asset URLs from `download_assets`. That keeps an agent able to walk a file even when `structuredContent` never reaches it.

Inlined lists are capped at an 8 KiB share of the response; past that the summary reports how many entries were dropped, and they remain available in `structuredContent`.

Assets are always delivered as `asset.url` download links served by the local asset HTTP server; bytes are never inlined as base64 in tool results.
