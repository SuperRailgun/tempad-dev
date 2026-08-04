# Local verification runbook: official Figma MCP tool names

Step-by-step check that this branch's MCP surface works end to end on a local machine. It covers the official Figma MCP tool names (`get_design_context`, `get_metadata`, `get_variable_defs`, `get_screenshot`, `download_assets`) that TemPad Dev exposes alongside its own names. For what each name maps to and why, see [official Figma MCP tool compatibility](./figma-tool-compatibility.md).

Steps marked **[human]** need a browser and a Figma file and cannot be automated by a coding agent. Everything else is a shell command with a stated expected result.

## 0. Prerequisites

- Node **22.18+** (or 24+). `tsdown` loads its TypeScript config through Node's native type stripping; on older releases `pnpm install` fails while building `packages/shared`. The published MCP server only needs Node 18.20+, but building this repo does not.
- `pnpm` (the repo pins a version through `packageManager`; Corepack picks it up).
- Chrome or a Chromium-based browser, and a Figma file you can open.

```bash
node -v    # must be >= 22.18
pnpm -v
```

Stop here and switch Node versions if the check fails. Nothing below will work otherwise.

## 1. Get the branch

Adjust the remote name and URL if the branch lives in a different fork.

```bash
git fetch <remote> cursor/align-official-figma-mcp-tool-names-bc25
git checkout -b mcp-official-names <remote>/cursor/align-official-figma-mcp-tool-names-bc25
```

Do not merge older local work that introduced a `get_raw_images` tool. That name was replaced by the official `download_assets`; keeping both would ship two names for one capability.

## 2. Install and build

```bash
pnpm install          # also builds packages/shared through its prepare script
pnpm -C packages/shared build
pnpm build:mcp        # produces packages/mcp-server/dist/cli.mjs
```

Expected: all three finish without errors and `packages/mcp-server/dist/cli.mjs` exists.

The explicit `packages/shared` build matters when you are updating an existing checkout. `pnpm install` prints `Already up to date` and skips the `prepare` script, so `packages/shared/dist` keeps the previous build and the Hub runs against stale response builders. Rebuild shared and the MCP server after every `git pull`.

## 3. Checks that need no Figma

These prove the tools are registered and routed correctly before any browser work.

```bash
pnpm -C packages/mcp-server probe:tools
```

Expected: exactly these nine names.

```
get_code, get_design_context, get_token_defs, get_variable_defs,
get_screenshot, get_structure, get_metadata, download_assets, get_assets
```

```bash
pnpm -C packages/mcp-server check:tool-routing
```

Expected: `[tool-routing] All checks passed.` and exit code 0. This starts the Hub with a real MCP consumer plus a fake extension WebSocket client and asserts each exposed tool reaches the extension under its canonical TemPad name — `get_design_context` must arrive as `get_code`, `get_metadata` as `get_structure`, `get_variable_defs` as `get_token_defs`.

The check runs in its own runtime directory on port 61220, so it is safe to run while an MCP client holds the usual Hub and your browser extension is connected. It will neither attach to that Hub nor steal the active extension session. Override the port with `TEMPAD_MCP_WS_PORTS` if 61220 is taken.

Repository checks, if you want the full suite:

```bash
pnpm typecheck && pnpm lint && pnpm test:run
```

## 4. Load the extension **[human]**

```bash
pnpm dev              # leave running; rebuilds on change
```

1. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `packages/extension/.output/chrome-mv3-dev`.
2. Open a Figma design file. The TemPad Dev panel should appear.
3. Enable **Preferences → Agent integration → MCP access** and allow the loopback connection to `127.0.0.1` when prompted.
4. Confirm the badge in the panel title bar reads **Active**. **Inactive** means another Figma tab holds the session — click the badge in the tab you want inspected. **Unavailable** means the Hub is not running or not reachable.

## 5. Point the MCP client at this build **[human]**

Use the local entry point, not `npx @tempad-dev/mcp@latest`, or you will test the published version instead of this branch.

```json
{
  "mcpServers": {
    "tempad-dev": {
      "command": "node",
      "args": ["<absolute-path-to-repo>/packages/mcp-server/dist/cli.mjs"]
    }
  }
}
```

Restart the MCP client and confirm its tool list shows the nine names from step 3.

The client owns the Hub process, so it does not pick up a rebuild on its own. After every change to `packages/shared` or `packages/mcp-server`: rebuild both, then restart the server entry in the client (in Cursor, **Settings → MCP**, toggle `tempad-dev` off and on). A stale Hub is the usual reason a fix appears to have no effect. Extension-side changes are different — `pnpm dev` reloads those, and you only need to refresh the extension in `chrome://extensions` and confirm the badge is still **Active**.

## 6. End-to-end acceptance **[human]** to select, agent to call

Select a single visible node in Figma before each call, or pass its `nodeId`. The two document-level rows are the exception: deselect everything first.

| Call                                           | Expected                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `get_design_context`                           | Same payload shape as `get_code`: `code`, `lang`, `codegen`, plus `assets`/`tokens` when present.                                     |
| `get_code` on the same node                    | Result equivalent to the previous call, proving the alias is a forward and not a second implementation.                               |
| `get_metadata`                                 | Outline in `roots` with ids, names, types, and geometry.                                                                              |
| `get_metadata` with nothing selected           | The open document instead of an error: `documentName` plus a `pages` list, with `isCurrent: true` on the open page.                   |
| `get_metadata` with a page id as `nodeId`      | That page's visible top-level frames in `roots`. Try a page other than the open one; it should load on demand.                        |
| `get_variable_defs` with no `names`            | Every token used by the selected subtree, keyed by canonical `--name`. Empty object is valid for a node that references no variables. |
| `get_screenshot`                               | `format: "png"` plus `asset.url`; fetching that URL returns PNG bytes.                                                                |
| `download_assets` on a node with an image fill | Both `exports` (at least one entry, `kind: "export"`) and `rawImages` (at least one entry, `source: "raw"`); every `url` downloads.   |
| `download_assets` with `defaultFormat: "svg"`  | `exports[].format === "svg"` for nodes without export settings.                                                                       |

Two things worth confirming while you are here:

- Prefer `structuredContent` when the client exposes it. Page ids, top-level node ids, and asset URLs are also inlined in the text summary, so an agent can keep drilling down even when only the summary is visible. Everything else (code, geometry, token values) is only in `structuredContent`.
- Assets are URL-first. Tool results never inline base64 bytes; `asset.url` points at the local asset HTTP server and is only valid while the Hub runs.

## 7. Troubleshooting

| Symptom                                                                                                  | Cause and fix                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install` fails with `Failed to import module "unrun"`                                              | Node is older than 22.18. Switch versions and reinstall.                                                                                                                                                                                                                                        |
| Tool call returns `[NO_ACTIVE_EXTENSION]`                                                                | No extension is connected or active. Keep the Figma tab open and foregrounded, enable MCP access, and click the badge until it reads **Active**.                                                                                                                                                |
| Tool call returns `[INVALID_SELECTION]` or `[NODE_NOT_VISIBLE]`                                          | Select exactly one visible node, or pass a `nodeId` that resolves in the active file.                                                                                                                                                                                                           |
| Tool call returns `[ASSET_SERVER_NOT_CONFIGURED]`                                                        | The extension has no asset server URL yet, usually because the tab is not the active MCP session. Re-activate through the badge.                                                                                                                                                                |
| Response says the 64 KiB inline budget was exceeded                                                      | Expected for large selections. Retry with a narrower `nodeId`, a smaller `depth`, or fewer `nodeIds`.                                                                                                                                                                                           |
| `download_assets` returns `rawImagesTruncated: true`                                                     | More than 20 distinct source images in the subtree. Request a more specific child node.                                                                                                                                                                                                         |
| `download_assets` returns entries in `warnings`                                                          | Individual exports or raw images failed while the rest succeeded; the message names the node or image hash. Oversized assets fail here rather than failing the whole call.                                                                                                                      |
| MCP client lists old tool names                                                                          | It is still running the published package. Fix the `command`/`args` to the local `dist/cli.mjs` and restart the client.                                                                                                                                                                         |
| A fix has no effect, or a summary matches the previous build                                             | Stale Hub. Run `pnpm -C packages/shared build && pnpm build:mcp`, then restart the MCP server entry. The CLI compares `hub.mjs` to `hub.build.json` and replaces an older Hub automatically; if a pre-feature Hub is still running with no marker, the same restart path kills and respawns it. |
| `get_code` times out with `EXTENSION_TIMEOUT`, or calls report `Unable to establish connection to Figma` | The extension is not really serving. Confirm the badge reads **Active**, restart `pnpm dev` if a hot reload wedged it, then refresh the extension in `chrome://extensions`. Larger nodes surface this first because they take longest.                                                          |
| Nothing explains the failure                                                                             | Hub logs are under `tempad-dev/log` in the system temp directory; override with `TEMPAD_MCP_LOG_DIR`. The Hub listens for the extension on ports 6220, 7431, or 8127.                                                                                                                           |

## 8. What is out of scope

These official tools are not implemented here because they need a Figma account, write access, or Figma-hosted services: `use_figma`, `upload_assets`, `create_new_file`, `generate_diagram`, `generate_figma_design`, `whoami`, `search_design_system`, `get_libraries`, `get_motion_context`, `get_figjam`, the Code Connect tools, and the shader tools. `get_screenshot` also has no `enableBase64Response`; it stays URL-first. A missing-tool error for any of these is expected, not a regression.
