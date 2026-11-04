export const REMOTE_CREDENTIAL_TERMS = [
  'authorization',
  'cookie',
  'token',
  'secret',
  'key',
  'password',
] as const

export const SECRET_REFERENCE_PATTERN = /\{\{secret:(\w+)\}\}/g

export const PLAYWRIGHT_VERSION_TOKEN = '{{playwright:version}}'

export interface RemoteEntryLike {
  name: string
  protocol: string
  url: string
  query?: Record<string, unknown>
  headers?: Record<string, string>
  basicAuth?: { user: string; password: string }
  context?: string
}

export interface RemoteOrigin {
  scheme: string
  host: string
  port: number
}

export interface RemoteEntryIssue {
  path: (string | number)[]
  message: string
}

type KeyPath = (string | number)[]

const DEFAULT_PORTS: Partial<Record<string, number>> = { ws: 80, http: 80, wss: 443, https: 443 }
const PROTECTED_SCHEMES: Partial<Record<string, string>> = { ws: 'wss', http: 'https' }
const PROTOCOL_SCHEMES: Partial<Record<string, readonly string[]>> = {
  playwright: ['ws', 'wss'],
  cdp: ['ws', 'wss', 'http', 'https'],
}
const PROTOCOL_SCHEME_SENTENCES: Partial<Record<string, string>> = {
  playwright: 'a playwright url starts with ws:// or wss://.',
  cdp: 'a cdp url starts with ws://, wss://, http:// or https://.',
}
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

export function secretReferenceNames(text: string): string[] {
  // A fresh copy, so a caller's use of the exported global pattern cannot shift lastIndex here.
  const pattern = new RegExp(SECRET_REFERENCE_PATTERN.source, 'g')
  return [...text.matchAll(pattern)].map((match) => match[1] as string)
}

function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url)
  } catch {
    return undefined
  }
}

function unbracket(host: string): string {
  return host.replace(/^\[(.*)\]$/, '$1')
}

export function remoteOrigin(url: string): RemoteOrigin | undefined {
  const parsed = parseUrl(url)
  if (!parsed) return undefined
  const scheme = parsed.protocol.replace(/:$/, '')
  const port = parsed.port === '' ? DEFAULT_PORTS[scheme] : Number(parsed.port)
  const host = unbracket(parsed.hostname)
  if (port === undefined || host === '') return undefined
  return { scheme, host, port }
}

function formatHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host
}

export function formatRemoteOrigin(origin: RemoteOrigin): string {
  return `${origin.scheme}://${formatHost(origin.host)}:${origin.port}`
}

export interface RemoteDisplay {
  name: string
  protocol: string
  url: string
}

function displayOrigin(url: unknown): string {
  const origin = typeof url === 'string' ? remoteOrigin(url) : undefined
  return origin ? formatRemoteOrigin(origin) : 'invalid url'
}

// A served config shows a remote by name, protocol and origin; its path, query, headers and
// basicAuth stay in the file.
export function projectRemotesForDisplay(
  remotes: readonly Pick<RemoteEntryLike, 'name' | 'protocol' | 'url'>[],
): RemoteDisplay[] {
  return remotes.map(({ name, protocol, url }) => ({ name, protocol, url: displayOrigin(url) }))
}

export function remoteLabel(entry: Pick<RemoteEntryLike, 'name' | 'protocol' | 'url'>): string {
  const origin = remoteOrigin(entry.url)
  return origin
    ? `${entry.name} (${entry.protocol} ${formatRemoteOrigin(origin)})`
    : `${entry.name} (${entry.protocol})`
}

export function isLoopbackHost(host: string): boolean {
  const normalized = unbracket(host.toLowerCase())
  if (normalized === 'localhost' || normalized === '::1') return true
  const octets = IPV4_RE.exec(normalized)
  return octets !== null && octets[1] === '127' && octets.slice(1).every((o) => Number(o) <= 255)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function children(value: unknown): [string | number, unknown][] {
  if (Array.isArray(value)) return value.map((child, index) => [index, child])
  if (isRecord(value)) return Object.entries(value)
  return []
}

function leaves(value: unknown): unknown[] {
  return Array.isArray(value) || isRecord(value)
    ? children(value).flatMap(([, child]) => leaves(child))
    : [value]
}

function texts(value: unknown): string[] {
  return children(value).flatMap(([key, child]) => [
    ...(typeof key === 'string' ? [key] : []),
    ...(typeof child === 'string' ? [child] : texts(child)),
  ])
}

function namesCredential(key: string | number): boolean {
  if (typeof key !== 'string') return false
  const lower = key.toLowerCase()
  return REMOTE_CREDENTIAL_TERMS.some((term) => lower.includes(term))
}

function carriesReference(value: unknown): boolean {
  return typeof value === 'string' && secretReferenceNames(value).length > 0
}

function credentialKeys(value: unknown, path: KeyPath = []): { path: KeyPath; literal: boolean }[] {
  return children(value).flatMap(([key, child]) => {
    const childPath = [...path, key]
    if (namesCredential(key)) {
      return [{ path: childPath, literal: leaves(child).some((leaf) => !carriesReference(leaf)) }]
    }
    return credentialKeys(child, childPath)
  })
}

function tokenKeys(value: unknown, path: KeyPath = []): KeyPath[] {
  return children(value).flatMap(([key, child]) => {
    const childPath = [...path, key]
    const own = typeof key === 'string' && key.includes('{{') ? [childPath] : []
    return [...own, ...tokenKeys(child, childPath)]
  })
}

function entryTexts(entry: RemoteEntryLike): string[] {
  return [entry.url, ...texts(entry.query), ...texts(entry.headers), ...texts(entry.basicAuth)]
}

export function connectionSecretNames(remotes: readonly RemoteEntryLike[]): string[] {
  const names = new Set<string>()
  for (const remote of remotes) {
    for (const text of entryTexts(remote)) {
      for (const name of secretReferenceNames(text)) names.add(name)
    }
  }
  return [...names]
}

// The text between :// and the first /, ? or #, split at the last @ into userinfo and host:port.
function urlHead(url: string): { scheme: string; userinfo: boolean; hostPort: string } | undefined {
  const separator = url.indexOf('://')
  if (separator < 0) return undefined
  const rest = url.slice(separator + 3)
  const end = rest.search(/[/?#]/)
  const authority = end < 0 ? rest : rest.slice(0, end)
  const at = authority.lastIndexOf('@')
  return { scheme: url.slice(0, separator), userinfo: at >= 0, hostPort: authority.slice(at + 1) }
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '))
  } catch {
    return text
  }
}

// The parameters written in the url, read from its raw text so a reference stays as written.
function urlQuery(url: string): Record<string, string> {
  const start = url.indexOf('?')
  if (start < 0) return {}
  const hashAt = url.indexOf('#', start)
  const search = url.slice(start + 1, hashAt < 0 ? undefined : hashAt)
  const params: Record<string, string> = {}
  for (const pair of search.split('&')) {
    if (pair === '') continue
    const equals = pair.indexOf('=')
    const name = decoded(equals < 0 ? pair : pair.slice(0, equals))
    const value = equals < 0 ? '' : pair.slice(equals + 1)
    params[name] = carriesReference(value) ? value : decoded(value)
  }
  return params
}

export function remoteEntryIssues(entry: RemoteEntryLike): RemoteEntryIssue[] {
  const issues: RemoteEntryIssue[] = []
  const report = (path: KeyPath, sentence: string) => {
    issues.push({ path, message: `Remote ${entry.name}: ${sentence}` })
  }

  const head = urlHead(entry.url)
  const parsed = head ? parseUrl(entry.url) : undefined
  let origin: RemoteOrigin | undefined
  if (head && `${head.scheme}${head.hostPort}`.includes('{{')) {
    report(
      ['url'],
      "write the url's scheme, host and port out; references belong in its path, query or headers.",
    )
  } else if (!head || !parsed) {
    report(['url'], 'the url is not a valid url.')
  } else {
    const scheme = parsed.protocol.replace(/:$/, '')
    const allowed = PROTOCOL_SCHEMES[entry.protocol]
    const sentence = PROTOCOL_SCHEME_SENTENCES[entry.protocol]
    if (allowed && sentence && !allowed.includes(scheme)) report(['url'], sentence)
    origin = remoteOrigin(entry.url)
  }
  if (head?.userinfo) {
    report(
      ['url'],
      'the url carries a user name or password. Move them to basicAuth with {{secret:NAME}} references.',
    )
  }

  const headerCredentials = credentialKeys(entry.headers)
  const queryCredentials = credentialKeys(entry.query)
  const urlCredentials = credentialKeys(urlQuery(entry.url))
  for (const credential of urlCredentials.filter((c) => c.literal)) {
    report(
      ['url'],
      `url query "${credential.path.join('.')}" names a credential, so its value must be a {{secret:NAME}} reference.`,
    )
  }
  for (const [section, found] of [
    ['headers', headerCredentials],
    ['query', queryCredentials],
  ] as const) {
    for (const credential of found.filter((c) => c.literal)) {
      report(
        [section, ...credential.path],
        `${section} "${credential.path.join('.')}" names a credential, so its value must be a {{secret:NAME}} reference.`,
      )
    }
  }
  if (entry.basicAuth && !carriesReference(entry.basicAuth.password)) {
    report(
      ['basicAuth', 'password'],
      'basicAuth "password" names a credential, so its value must be a {{secret:NAME}} reference.',
    )
  }

  const carriesCredential =
    entry.basicAuth !== undefined ||
    headerCredentials.length > 0 ||
    queryCredentials.length > 0 ||
    urlCredentials.length > 0 ||
    entryTexts(entry).some(carriesReference)
  const protectedScheme = origin ? PROTECTED_SCHEMES[origin.scheme] : undefined
  if (origin && protectedScheme && carriesCredential && !isLoopbackHost(origin.host)) {
    report(
      ['url'],
      `credentials go over ${origin.scheme}:// only to this machine. Use ${protectedScheme}:// for ${formatHost(origin.host)}.`,
    )
  }

  if (entry.protocol === 'playwright' && entry.context !== undefined) {
    report(['context'], 'context applies to cdp remotes only.')
  }

  if (entry.basicAuth) {
    const headerNames = Object.keys(entry.headers ?? {})
    if (headerNames.some((name) => name.trim().toLowerCase() === 'authorization')) {
      report(['basicAuth'], 'set basicAuth or an Authorization header, not both.')
    }
    for (const field of ['user', 'password'] as const) {
      if (entry.basicAuth[field].includes(PLAYWRIGHT_VERSION_TOKEN)) {
        report(
          ['basicAuth', field],
          `${PLAYWRIGHT_VERSION_TOKEN} belongs in the url, query or header values.`,
        )
      }
    }
  }

  for (const [section, value] of [
    ['headers', entry.headers],
    ['query', entry.query],
  ] as const) {
    for (const path of tokenKeys(value)) {
      report(
        [section, ...path],
        `${section} key "${path.join('.')}" carries a {{…}} token; tokens belong in values only.`,
      )
    }
  }

  return issues
}

export const SUBSCRIPTION_AUTH_PACKAGE = '@vostride/agent-qa-subscription-auth'

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => structurallyEqual(item, right[index]))
    )
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false
    const keys = Object.keys(left)
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => Object.hasOwn(right, key) && structurallyEqual(left[key], right[key]))
    )
  }
  return Object.is(left, right)
}

interface ClosedFields {
  remotes: unknown
  plugins: Record<string, unknown>
  auth: unknown
}

function closedFields(config: unknown): ClosedFields {
  const root = isRecord(config) ? config : {}
  const registry = isRecord(root.registry) ? root.registry : {}
  const { auth, ...plugins } = isRecord(root.plugins) ? root.plugins : {}
  return {
    remotes: registry.remotes ?? [],
    plugins,
    auth: auth ?? [],
  }
}

function appendsSubscriptionAuth(before: unknown, after: unknown): boolean {
  return (
    Array.isArray(before) &&
    Array.isArray(after) &&
    after.length === before.length + 1 &&
    structurallyEqual(after.slice(0, -1), before) &&
    structurallyEqual(after.at(-1), { package: SUBSCRIPTION_AUTH_PACKAGE })
  )
}

// Remotes and plugins carry credentials and code, so no write may change them, save the one
// subscription-auth declaration config.auth.set appends.
export function closedConfigFieldsChanged(before: unknown, after: unknown): boolean {
  const held = closedFields(before)
  const next = closedFields(after)
  if (!structurallyEqual(held.remotes, next.remotes)) return true
  if (!structurallyEqual(held.plugins, next.plugins)) return true
  return !structurallyEqual(held.auth, next.auth) && !appendsSubscriptionAuth(held.auth, next.auth)
}

function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    isRecord(inner)
      ? Object.fromEntries(
          Object.entries(inner).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        )
      : inner,
  )
}

// A YAML anchor can copy a remote's entries, or a part of one, anywhere else in the config.
function remoteCopies(remotes: unknown, shown: RemoteDisplay[]): Map<string, unknown> {
  const copies = new Map<string, unknown>()
  const add = (value: unknown, replacement: unknown) => {
    if (typeof value !== 'string' && children(value).length === 0) return
    copies.set(fingerprint(value), replacement)
  }
  const addNested = (value: unknown) => {
    for (const [, child] of children(value)) {
      if (children(child).length === 0) continue
      add(child, null)
      addNested(child)
    }
  }
  add(remotes, shown)
  if (!Array.isArray(remotes)) {
    addNested(remotes)
    const addUrls = (value: unknown) => {
      for (const [key, child] of children(value)) {
        if (typeof child === 'string' && (key === 'url' || remoteOrigin(child) !== undefined)) {
          add(child, displayOrigin(child))
        }
        addUrls(child)
      }
    }
    addUrls(remotes)
    return copies
  }
  remotes.forEach((entry, index) => {
    const display = shown[index] as RemoteDisplay
    add(entry, display)
    addNested(entry)
    if (isRecord(entry) && typeof entry.url === 'string' && entry.url !== '') {
      add(entry.url, display.url)
    }
  })
  return copies
}

function withoutCopies(value: unknown, copies: Map<string, unknown>): unknown {
  if (typeof value === 'string' || children(value).length > 0) {
    const key = fingerprint(value)
    if (copies.has(key)) return copies.get(key)
  }
  if (Array.isArray(value)) return value.map((child) => withoutCopies(child, copies))
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, withoutCopies(child, copies)]),
    )
  }
  return value
}

export function projectConfigRemotes<T>(config: T): T {
  if (!isRecord(config) || !isRecord(config.registry)) return config
  const remotes = config.registry.remotes
  if (remotes === undefined || remotes === null) return config
  // A block that is not a list is invalid config, still served, and may hold an endpoint anywhere.
  const shown: RemoteDisplay[] = Array.isArray(remotes)
    ? remotes.map((entry) => {
        const record: Record<string, unknown> = isRecord(entry) ? entry : {}
        return {
          name: record.name as string,
          protocol: record.protocol as string,
          url: displayOrigin(record.url),
        }
      })
    : []
  const rest = withoutCopies(
    { ...config, registry: { ...config.registry, remotes: [] } },
    remoteCopies(remotes, shown),
  ) as Record<string, unknown>
  return {
    ...rest,
    registry: { ...(rest.registry as Record<string, unknown>), remotes: shown },
  } as T
}
