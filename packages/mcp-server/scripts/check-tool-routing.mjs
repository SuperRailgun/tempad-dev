#!/usr/bin/env node

// Verifies tool registration and routing end to end without Figma: starts the built
// Hub with a real MCP consumer on one side and a fake extension WebSocket client on
// the other, then asserts that every exposed tool reaches the extension under its
// canonical TemPad name (official aliases must forward, not leak their alias name).

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLI_PATH = join(ROOT, 'dist/cli.mjs')
const FAKE_EXTENSION_ORIGIN = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
// Run fully isolated: a Hub started by an MCP client owns the default socket and
// ports, and attaching to it would hijack the extension session in use.
const ISOLATED_WS_PORT = 61220
const ISOLATED_RUNTIME_DIR = mkdtempSync(join(tmpdir(), 'tempad-tool-routing-'))
const REQUEST_TIMEOUT_MS = 15000
// The Hub auto-activates a sole extension only after its grace period.
const ACTIVATION_WAIT_MS = 2500

const ASSET_BASE = 'http://127.0.0.1:1234/cap/assets'

const EXTENSION_RESULTS = {
  get_code: {
    code: '<div class="p-4">Hello</div>',
    lang: 'jsx',
    codegen: { plugin: 'builtin', config: { cssUnit: 'px', rootFontSize: 16, scale: 1 } }
  },
  get_structure: {
    roots: [{ id: '1:2', name: 'Card', type: 'FRAME', x: 0, y: 0, width: 320, height: 180 }]
  },
  // What the extension returns for get_structure when nothing is selected.
  get_structure_document: {
    roots: [],
    documentName: 'Design File',
    pages: [
      { id: '0:1', name: 'Cover' },
      { id: '0:2', name: 'Components', isCurrent: true }
    ]
  },
  get_token_defs: { '--color-primary': { kind: 'color', value: '#6699CC' } },
  get_screenshot: {
    format: 'png',
    width: 320,
    height: 180,
    scale: 1,
    bytes: 2048,
    asset: {
      hash: 'a1b2c3d4',
      url: `${ASSET_BASE}/a1b2c3d4.png`,
      mimeType: 'image/png',
      size: 2048
    }
  },
  download_assets: {
    exports: [
      {
        hash: 'deadbeef',
        url: `${ASSET_BASE}/deadbeef.svg`,
        mimeType: 'image/svg+xml',
        size: 512,
        nodeId: '1:2',
        nodeName: 'Card',
        kind: 'export',
        format: 'svg',
        fromExportSettings: true
      }
    ],
    rawImages: [
      {
        hash: 'beefcafe',
        url: `${ASSET_BASE}/beefcafe.jpg`,
        mimeType: 'image/jpeg',
        size: 4096,
        figmaImageHash: 'figma-image-hash',
        nodeIds: ['1:3'],
        source: 'raw'
      }
    ],
    rawImagesTruncated: true
  }
}

const CALLS = [
  { called: 'get_code', forwarded: 'get_code', args: { nodeId: '1:2' } },
  { called: 'get_design_context', forwarded: 'get_code', args: { nodeId: '1:2' } },
  { called: 'get_structure', forwarded: 'get_structure', args: { nodeId: '1:2' } },
  { called: 'get_metadata', forwarded: 'get_structure', args: { nodeId: '1:2' } },
  { called: 'get_token_defs', forwarded: 'get_token_defs', args: { nodeId: '1:2' } },
  { called: 'get_variable_defs', forwarded: 'get_token_defs', args: { nodeId: '1:2' } },
  { called: 'get_screenshot', forwarded: 'get_screenshot', args: { nodeId: '1:2' } },
  {
    called: 'download_assets',
    forwarded: 'download_assets',
    args: { nodeIds: ['1:2'], defaultFormat: 'svg' }
  },
  {
    called: 'get_metadata',
    forwarded: 'get_structure',
    args: {},
    expectSummary: 'page list'
  }
]

if (!existsSync(CLI_PATH)) {
  console.error(`Missing ${CLI_PATH}. Run "pnpm build:mcp" first.`)
  process.exit(1)
}

let failures = 0

function check(label, actual, expected) {
  if (actual === expected) {
    console.log(`  ok  ${label}`)
    return
  }
  failures += 1
  console.error(
    `  FAIL  ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  )
}

const consumer = spawn(process.execPath, [CLI_PATH], {
  stdio: ['pipe', 'pipe', 'ignore'],
  env: {
    ...process.env,
    TEMPAD_MCP_RUNTIME_DIR: ISOLATED_RUNTIME_DIR,
    TEMPAD_MCP_WS_PORTS: String(ISOLATED_WS_PORT),
    TEMPAD_MCP_ASSET_DIR: join(ISOLATED_RUNTIME_DIR, 'assets'),
    TEMPAD_MCP_LOG_DIR: join(ISOLATED_RUNTIME_DIR, 'log')
  }
})
const pending = new Map()
let nextId = 1
let buffer = ''

consumer.stdout.on('data', (chunk) => {
  buffer += chunk.toString()
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    const entry = pending.get(message.id)
    if (!entry) continue
    pending.delete(message.id)
    clearTimeout(entry.timer)
    entry.resolve(message)
  }
})

function request(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Timed out waiting for ${method}.`))
    }, REQUEST_TIMEOUT_MS)
    pending.set(id, { resolve, timer })
    consumer.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

function notify(method, params) {
  consumer.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
}

// Only ever connect to the isolated Hub this script started.
function connectFakeExtension() {
  return new Promise((resolve, reject) => {
    let attempts = 0
    const tryConnect = () => {
      attempts += 1
      const socket = new WebSocket(`ws://127.0.0.1:${ISOLATED_WS_PORT}`, {
        origin: FAKE_EXTENSION_ORIGIN
      })
      socket.once('open', () => resolve(socket))
      socket.once('error', () => {
        if (attempts >= 25) {
          reject(
            new Error(
              `The isolated Hub never listened on port ${ISOLATED_WS_PORT}. Set TEMPAD_MCP_WS_PORTS to a free port and retry.`
            )
          )
          return
        }
        setTimeout(tryConnect, 200)
      })
    }
    tryConnect()
  })
}

function finish(code) {
  consumer.kill('SIGTERM')
  setTimeout(() => {
    rmSync(ISOLATED_RUNTIME_DIR, { force: true, recursive: true })
    process.exit(code)
  }, 300)
}

try {
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'tempad-tool-routing-check', version: '0.0.0' }
  })
  notify('notifications/initialized', {})

  const socket = await connectFakeExtension()
  const forwarded = []

  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    if (message.type === 'registered') {
      socket.send(JSON.stringify({ type: 'activate' }))
      return
    }
    if (message.type !== 'toolCall') return
    const { name, args } = message.payload
    forwarded.push(name)
    const key = name === 'get_structure' && !args?.nodeId ? 'get_structure_document' : name
    socket.send(
      JSON.stringify({
        type: 'toolResult',
        id: message.id,
        payload: EXTENSION_RESULTS[key] ?? {}
      })
    )
  })

  await new Promise((resolve) => setTimeout(resolve, ACTIVATION_WAIT_MS))

  for (const { called, forwarded: expectedName, args, expectSummary } of CALLS) {
    console.log(`${called}:`)
    const response = await request('tools/call', { name: called, arguments: args })
    const result = response.result
    check(`forwards to ${expectedName}`, forwarded.at(-1), expectedName)
    check('succeeds', result?.isError ?? false, false)
    check('returns structuredContent', result?.structuredContent !== undefined, true)
    if (expectSummary) {
      const summary = result?.content?.[0]?.text ?? ''
      check(`summary mentions "${expectSummary}"`, summary.includes(expectSummary), true)
    }
  }

  socket.close()
  console.log(
    failures === 0
      ? '\n[tool-routing] All checks passed.'
      : `\n[tool-routing] ${failures} check(s) failed.`
  )
  finish(failures === 0 ? 0 : 1)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  finish(1)
}
