import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  collectStaleHubPids,
  fingerprintHubEntry,
  isHubBuildCurrent,
  isProcessAlive,
  readHubBuildMarker
} from '../src/hub-build'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('hub-build', () => {
  it('fingerprints hub entry content and changes when the file changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tempad-hub-build-'))
    tempDirs.push(dir)
    const entry = join(dir, 'hub.mjs')
    writeFileSync(entry, 'export const a = 1\n')
    const first = fingerprintHubEntry(entry)
    expect(first).toMatch(/^[a-f0-9]{64}$/)

    writeFileSync(entry, 'export const a = 2\n')
    expect(fingerprintHubEntry(entry)).not.toBe(first)
  })

  it('treats a missing marker as stale and accepts a matching marker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tempad-hub-build-'))
    tempDirs.push(dir)
    const entry = join(dir, 'hub.mjs')
    const markerPath = join(dir, 'hub.build.json')
    writeFileSync(entry, 'console.log("hub")\n')

    expect(isHubBuildCurrent(entry, markerPath)).toBe(false)

    writeFileSync(
      markerPath,
      JSON.stringify({
        pid: process.pid,
        fingerprint: fingerprintHubEntry(entry),
        version: '0.0.0',
        startedAt: new Date().toISOString(),
        entryPath: entry
      })
    )
    expect(isHubBuildCurrent(entry, markerPath)).toBe(true)

    writeFileSync(entry, 'console.log("hub-v2")\n')
    expect(isHubBuildCurrent(entry, markerPath)).toBe(false)
  })

  it('returns null for invalid marker payloads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tempad-hub-build-'))
    tempDirs.push(dir)
    const markerPath = join(dir, 'hub.build.json')
    writeFileSync(markerPath, '{"pid":"nope"}\n')
    expect(readHubBuildMarker(markerPath)).toBeNull()
  })

  it('reports whether a process id is alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
    expect(isProcessAlive(-1)).toBe(false)
    expect(isProcessAlive(0)).toBe(false)
  })

  it('collects stale hub pids from the marker and socket listeners', () => {
    expect(
      collectStaleHubPids(
        { pid: process.pid, fingerprint: 'a', version: '0', startedAt: '', entryPath: '' },
        [process.pid],
        process.pid
      )
    ).toEqual([])
    expect(collectStaleHubPids(null, [process.pid], process.pid + 999_999_999)).toEqual([
      process.pid
    ])
  })
})
