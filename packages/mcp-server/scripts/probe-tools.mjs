#!/usr/bin/env node

// Dev helper: start the built Hub over stdio, list the registered tools, and
// optionally invoke one. Useful to confirm tool registration without an MCP client.
//
//   node scripts/probe-tools.mjs
//   node scripts/probe-tools.mjs --call get_screenshot --args '{"nodeId":"1:2"}'

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLI_PATH = join(ROOT, 'dist/cli.mjs')
const READY_TIMEOUT_MS = 5000
const CALL_TIMEOUT_MS = 20000

const EXPECTED_TOOLS = [
  'get_code',
  'get_design_context',
  'get_token_defs',
  'get_variable_defs',
  'get_screenshot',
  'get_structure',
  'get_metadata',
  'download_assets',
  'get_assets'
]

function readFlag(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const toolToCall = readFlag('call')
const rawArgs = readFlag('args')

if (!existsSync(CLI_PATH)) {
  console.error(`Missing ${CLI_PATH}. Run "pnpm build:mcp" first.`)
  process.exit(1)
}

const child = spawn(process.execPath, [CLI_PATH], { stdio: ['pipe', 'pipe', 'inherit'] })
const pending = new Map()
let nextId = 1
let buffer = ''

child.stdout.on('data', (chunk) => {
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

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
}

function request(method, params, timeoutMs) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Timed out waiting for ${method}.`))
    }, timeoutMs)
    pending.set(id, { resolve, timer })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

function shutdown(code) {
  child.kill('SIGTERM')
  setTimeout(() => process.exit(code), 200)
}

try {
  await request(
    'initialize',
    {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'tempad-probe', version: '0.0.0' }
    },
    READY_TIMEOUT_MS
  )
  notify('notifications/initialized', {})

  const listed = await request('tools/list', {}, READY_TIMEOUT_MS)
  const names = (listed.result?.tools ?? []).map((tool) => tool.name)
  console.log(`Registered tools (${names.length}):`)
  names.forEach((name) => console.log(`  - ${name}`))

  const missing = EXPECTED_TOOLS.filter((name) => !names.includes(name))
  if (missing.length) {
    console.error(`\nMissing expected tools: ${missing.join(', ')}`)
    shutdown(1)
  }

  if (toolToCall) {
    const args = rawArgs ? JSON.parse(rawArgs) : {}
    console.log(`\nCalling ${toolToCall} with ${JSON.stringify(args)}...`)
    const called = await request(
      'tools/call',
      { name: toolToCall, arguments: args },
      CALL_TIMEOUT_MS
    )
    console.log(JSON.stringify(called.result ?? called.error, null, 2))
  }

  shutdown(0)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  shutdown(1)
}
