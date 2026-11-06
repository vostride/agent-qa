// Only a remote's name and plugin matter to the loaders, and a raw config's remotes may be anything.
export function pluginRemotesOfRawConfig(raw: unknown): { name: string; plugin?: string }[] {
  const remotes = (raw as { registry?: { remotes?: unknown } } | null)?.registry?.remotes
  if (!Array.isArray(remotes)) return []
  return remotes.flatMap((remote: unknown) => {
    if (typeof remote !== 'object' || remote === null) return []
    const { name, plugin } = remote as { name?: unknown; plugin?: unknown }
    if (typeof name !== 'string') return []
    return [typeof plugin === 'string' ? { name, plugin } : { name }]
  })
}
