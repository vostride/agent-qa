// Runner-owned run/test-scoped variable state. Moved 1:1 from
// core/src/agent/variables.ts — a flat Map keyed by name with seeding-order
// last-write-wins precedence across env/inline/suite/cli/hook seeds + step/capture
// writes; source-precedence semantics preserved exactly.
//
// Pitfall 10 (display neutrality): the capture-over-non-capture warning routes
// through an injected optional `onWarn` seam — runner-owned code makes ZERO console
// calls. Callers wire it to the bus runWarning leg or a CLI/logger warn path.
export type VariableSource = 'env' | 'inline' | 'suite' | 'cli' | 'capture' | 'hook' | 'step'

interface TrackedVariable {
  value: string
  source: VariableSource
}

export interface VariableStoreOptions {
  onWarn?: (message: string) => void
}

export class VariableStore {
  private storage = new Map<string, TrackedVariable>()
  private onWarn?: (message: string) => void

  constructor(options?: VariableStoreOptions) {
    this.onWarn = options?.onWarn
  }

  set(name: string, value: string, source: VariableSource = 'capture'): void {
    const existing = this.storage.get(name)
    if (source === 'capture' && existing && existing.source !== 'capture') {
      this.onWarn?.(`Warning: capture step overwrites variable "${name}" (was set by ${existing.source})`)
    }
    this.storage.set(name, { value, source })
  }

  get(name: string): string | undefined {
    return this.storage.get(name)?.value
  }

  has(name: string): boolean {
    return this.storage.has(name)
  }

  getSource(name: string): VariableSource | undefined {
    return this.storage.get(name)?.source
  }

  getAll(): Map<string, string> {
    const result = new Map<string, string>()
    for (const [key, tracked] of this.storage) {
      result.set(key, tracked.value)
    }
    return result
  }

  setAll(vars: Record<string, string>, source: VariableSource = 'capture'): void {
    for (const [key, value] of Object.entries(vars)) {
      this.set(key, value, source)
    }
  }

  snapshot(): Record<string, { value: string; source: VariableSource }> {
    // Captured names are data, including __proto__; never invoke an inherited setter.
    return Object.fromEntries(Array.from(this.storage, ([key, tracked]) => [
      key, { value: tracked.value, source: tracked.source },
    ]))
  }
}
