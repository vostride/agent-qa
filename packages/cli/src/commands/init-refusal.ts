// No imports, so a test's module mock of the init writers cannot take these away from init.

export class InitRefusal extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'InitRefusal'
  }
}

// Matched by name, so init imports nothing from the modules the unit tests mock.
const INIT_REFUSAL_NAMES = new Set([
  'InitRefusal',
  'ManagedBlockRefusal',
  'ManagedBlockLockRefusal',
])

export function isInitRefusal(error: unknown): error is Error {
  return error instanceof Error && INIT_REFUSAL_NAMES.has(error.name)
}
