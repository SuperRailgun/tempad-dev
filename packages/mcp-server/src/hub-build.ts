import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'

import { HUB_BUILD_PATH, PACKAGE_VERSION, ensureDir, RUNTIME_DIR, log } from './shared'

const execFileAsync = promisify(execFile)

export type HubBuildMarker = {
  pid: number
  fingerprint: string
  version: string
  startedAt: string
  entryPath: string
}

/** Content hash of the Hub entry so local rebuilds invalidate a live Hub without bumping package version. */
export function fingerprintHubEntry(entryPath: string): string {
  const bytes = readFileSync(entryPath)
  const { size, mtimeMs } = statSync(entryPath)
  return createHash('sha256')
    .update(bytes)
    .update('\0')
    .update(String(size))
    .update('\0')
    .update(String(Math.trunc(mtimeMs)))
    .digest('hex')
}

export function readHubBuildMarker(path: string = HUB_BUILD_PATH): HubBuildMarker | null {
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<HubBuildMarker>
    if (
      typeof raw.pid !== 'number' ||
      typeof raw.fingerprint !== 'string' ||
      typeof raw.version !== 'string' ||
      typeof raw.startedAt !== 'string' ||
      typeof raw.entryPath !== 'string'
    ) {
      return null
    }
    return {
      pid: raw.pid,
      fingerprint: raw.fingerprint,
      version: raw.version,
      startedAt: raw.startedAt,
      entryPath: raw.entryPath
    }
  } catch {
    return null
  }
}

export function writeHubBuildMarker(entryPath: string, pid: number = process.pid): HubBuildMarker {
  ensureDir(RUNTIME_DIR)
  const marker: HubBuildMarker = {
    pid,
    fingerprint: fingerprintHubEntry(entryPath),
    version: PACKAGE_VERSION,
    startedAt: new Date().toISOString(),
    entryPath
  }
  writeFileSync(HUB_BUILD_PATH, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 })
  return marker
}

export function clearHubBuildMarker(): void {
  if (!existsSync(HUB_BUILD_PATH)) return
  try {
    rmSync(HUB_BUILD_PATH)
  } catch (err) {
    log.warn({ err }, 'Failed to clear Hub build marker.')
  }
}

/**
 * Returns true when the live Hub was started from the same on-disk entry the CLI is about to use.
 * Missing/invalid markers count as stale so pre-feature Hubs are replaced on the next client start.
 */
export function isHubBuildCurrent(entryPath: string, markerPath: string = HUB_BUILD_PATH): boolean {
  const marker = readHubBuildMarker(markerPath)
  if (!marker) return false
  if (!existsSync(entryPath)) return false
  try {
    return marker.fingerprint === fingerprintHubEntry(entryPath)
  } catch {
    return false
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Resolve PIDs listening on the Hub consumer socket (covers pre-marker Hubs). */
export async function findSockListenerPids(
  sockPath: string,
  platform: NodeJS.Platform = process.platform
): Promise<number[]> {
  if (platform === 'win32') return []
  try {
    const { stdout } = await execFileAsync('lsof', ['-t', sockPath], {
      encoding: 'utf8'
    })
    return [
      ...new Set(
        stdout
          .split(/\s+/)
          .map((value) => Number(value))
          .filter((pid) => Number.isInteger(pid) && pid > 0)
      )
    ]
  } catch {
    return []
  }
}

export function collectStaleHubPids(
  marker: HubBuildMarker | null,
  sockListenerPids: number[],
  selfPid: number = process.pid
): number[] {
  const pids = new Set<number>()
  if (marker?.pid) pids.add(marker.pid)
  for (const pid of sockListenerPids) pids.add(pid)
  pids.delete(selfPid)
  return [...pids].filter((pid) => isProcessAlive(pid))
}
