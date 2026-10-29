import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readlinkSync } from 'node:fs'
import { hostname as osHostname } from 'node:os'

const PLATFORM_UUID_LINE = /"IOPlatformUUID" = "([^"]*)"/
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PID_NAMESPACE_LINK = /^pid:\[(\d+)\]$/

function readIoregPlatformUuid(): string | undefined {
  const result = spawnSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
    encoding: 'utf8',
    env: { LC_ALL: 'C', LANG: 'C' },
    timeout: 1_000,
    windowsHide: true,
  })
  if (result.status !== 0 || typeof result.stdout !== 'string') return undefined
  return PLATFORM_UUID_LINE.exec(result.stdout)?.[1]
}

function readUuidOrUndefined(read: () => string | undefined): string | undefined {
  try {
    const uuid = read()
    return uuid !== undefined && UUID_SHAPE.test(uuid) ? uuid : undefined
  } catch {
    return undefined
  }
}

function readProcPidNamespace(): string | undefined {
  return readlinkSync('/proc/self/ns/pid')
}

function readNamespaceInodeOrUndefined(read: () => string | undefined): string | undefined {
  try {
    const link = read()
    return link === undefined ? undefined : PID_NAMESPACE_LINK.exec(link)?.[1]
  } catch {
    return undefined
  }
}

// macOS keys on the hardware UUID, as names follow the network; an unread Linux pidns matches none.
export function createRunOwnerHostResolver({
  platform = process.platform,
  hostname = osHostname,
  readPlatformUuid = readIoregPlatformUuid,
  readPidNamespace = readProcPidNamespace,
}: {
  platform?: NodeJS.Platform
  hostname?: () => string
  readPlatformUuid?: () => string | undefined
  readPidNamespace?: () => string | undefined
} = {}): () => string {
  let identity: string | undefined
  let unreadNamespace: string | undefined
  return () => {
    if (platform === 'linux') {
      if (identity !== undefined) return identity
      const inode = readNamespaceInodeOrUndefined(readPidNamespace)
      if (inode === undefined) {
        unreadNamespace ??= `linux-pidns-unread:${randomUUID()}`
        return unreadNamespace
      }
      identity = `linux-pidns:${inode}:${hostname()}`
      return identity
    }
    if (platform !== 'darwin') return hostname()
    if (identity !== undefined) return identity
    const uuid = readUuidOrUndefined(readPlatformUuid)
    if (uuid === undefined) return `hostname:${hostname()}`
    identity = `macos-uuid-sha256:${createHash('sha256').update(uuid.toUpperCase()).digest('hex')}`
    return identity
  }
}

export const resolveRunOwnerHost = createRunOwnerHostResolver()
