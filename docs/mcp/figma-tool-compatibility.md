# Official Figma MCP tool compatibility

TemPad Dev exposes its MCP tools under the [official Figma MCP tool names](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/) in addition to its own names. Agents and skills written against the official server can call TemPad Dev without changing tool names or parameters, while the read-only browser-extension pipeline stays unchanged (no Figma account, token, or write access required).

## Tool mapping

| Official name        | TemPad Dev tool   | Notes                                                                                                    |
| -------------------- | ----------------- | -------------------------------------------------------------------------------------------------------- |
| `get_design_context` | `get_code`        | Alias. Same parameters and result as `get_code`.                                                         |
| `get_metadata`       | `get_structure`   | Alias. Structural outline (ids, names, types, geometry) as JSON rather than the official sparse XML.     |
| `get_variable_defs`  | `get_token_defs`  | Alias. Without `names`, resolves every token used by `nodeId`/the current selection; `names` narrows it. |
| `get_screenshot`     | `get_screenshot`  | Same name. Returns a PNG asset URL; inline base64 (`enableBase64Response`) is not supported.             |
| `download_assets`    | `download_assets` | Same name. Returns `exports` plus `rawImages` for up to 20 nodes.                                        |
| —                    | `get_assets`      | TemPad-specific: resolve asset hashes from earlier responses back to download URLs.                      |

Both names are registered with the MCP server, so `tools/list` shows the official name and the TemPad name. Aliases forward the canonical tool name to the extension, so behavior and payloads are identical.

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

Build the packages and load the development extension:

```bash
pnpm install
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

To confirm tool registration without an MCP client, run the probe against the built Hub:

```bash
pnpm -C packages/mcp-server probe:tools
pnpm -C packages/mcp-server probe:tools --call get_design_context --args '{"nodeId":"1:2"}'
```

It lists the registered tools, fails when an expected name is missing, and can invoke one tool. Without a connected extension every call fails with `NO_ACTIVE_EXTENSION`, which still proves the tool is registered and routed. Hub logs are written to `tempad-dev/log` under the system temp directory (override with `TEMPAD_MCP_LOG_DIR`).

## Reading results

Every tool result carries a short text summary plus the full payload in `structuredContent`. Some clients (Cursor among them) surface only the text summary in the transcript, so agents should read `structuredContent` — or fall back to a script that reads it — rather than treating the summary as the response.

Assets are always delivered as `asset.url` download links served by the local asset HTTP server; bytes are never inlined as base64 in tool results.
