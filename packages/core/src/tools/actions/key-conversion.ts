/**
 * Converts "Meta" tokens in keyboard combo strings to "Control" on non-Mac platforms.
 *
 * Users write combos like "Meta+k" and we route them to Cmd+K on Mac, Ctrl+K on
 * Windows/Linux. Uses split/join (not regex) to avoid edge-case bugs with adjacent
 * tokens like "Shift+Meta+Meta+T".
 *
 * @param keys - Array of key/combo strings (e.g., ["Meta+k", "Enter"])
 * @param options.enabled - When false, keys are returned unchanged
 * @param options.isMac - When true, keys are returned unchanged (Meta is native)
 * @returns New array with Meta tokens replaced by Control (when applicable)
 */
export function convertKeysForPlatform(
  keys: string[],
  options: { enabled: boolean; isMac: boolean },
): string[] {
  if (!options.enabled || options.isMac) return keys
  return keys.map((k) =>
    k
      .split('+')
      .map((part) => (part === 'Meta' ? 'Control' : part))
      .join('+'),
  )
}

/**
 * Returns true when running on macOS. Reads process.platform at call time so
 * tests can override it via Object.defineProperty(process, 'platform', ...).
 */
export function isMacPlatform(): boolean {
  return process.platform === 'darwin'
}
