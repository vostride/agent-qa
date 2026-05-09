export interface CircuitBreakerConfig {
  windowSize: number
  baselineSize: number
  threshold: number
}

interface Outcome {
  withMemory: boolean
  passed: boolean
}

export class CircuitBreaker {
  private config: CircuitBreakerConfig
  private window: Outcome[] = []
  private _tripped = false

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = {
      windowSize: config?.windowSize ?? 20,
      baselineSize: config?.baselineSize ?? 3,
      threshold: config?.threshold ?? 0.15,
    }
  }

  record(outcome: { withMemory: boolean; passed: boolean }): void {
    this.window.push(outcome)
    if (this.window.length > this.config.windowSize) {
      this.window.shift()
    }
    this.evaluate()
  }

  isTripped(): boolean {
    return this._tripped
  }

  private evaluate(): void {
    if (this._tripped) return

    const baseline = this.window.filter(o => !o.withMemory)
    const memory = this.window.filter(o => o.withMemory)

    if (baseline.length < this.config.baselineSize || memory.length < this.config.baselineSize) return

    const baselineFailRate = baseline.filter(o => !o.passed).length / baseline.length
    const memoryFailRate = memory.filter(o => !o.passed).length / memory.length

    if ((memoryFailRate - baselineFailRate) > this.config.threshold) {
      this._tripped = true
    }
  }
}
