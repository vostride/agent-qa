const PROXY_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY'] as const

export const PLUGIN_ENVIRONMENT_NAMES = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'TZ',
  ...PROXY_NAMES,
  ...PROXY_NAMES.map((name) => name.toLowerCase()),
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
] as const

export const PLUGIN_WINDOWS_ENVIRONMENT_NAMES = [
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
] as const

// Secrets reach a plugin only in initialize, so nothing else from the host's environment passes.
export function pluginEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  platform: string,
): Record<string, string> {
  const windows = platform === 'win32'
  const names = new Set<string>(PLUGIN_ENVIRONMENT_NAMES)
  if (windows) {
    for (const name of PLUGIN_WINDOWS_ENVIRONMENT_NAMES) names.add(name.toUpperCase())
  }
  const passes = (key: string): boolean => {
    if (key.startsWith('LC_')) return true
    if (names.has(key)) return true
    // Windows names are case-insensitive: Path is PATH there.
    return windows && names.has(key.toUpperCase())
  }
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || key.toUpperCase() === 'NODE_OPTIONS') continue
    if (passes(key)) out[key] = value
  }
  return out
}
