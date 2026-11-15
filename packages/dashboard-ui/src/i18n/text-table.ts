export function textTable<T extends Record<string, () => unknown>>(
  members: T,
): { readonly [K in keyof T]: ReturnType<T[K]> } {
  const table = {}
  for (const [name, read] of Object.entries(members)) {
    Object.defineProperty(table, name, { enumerable: true, get: read })
  }
  return table as { readonly [K in keyof T]: ReturnType<T[K]> }
}
