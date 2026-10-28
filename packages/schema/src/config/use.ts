// Every concurrent member owns a browser or device session, so the default ceiling stays small;
// a config owner who wants more sets `workers`.
export const DEFAULT_PARALLEL_WORKERS = 3

export interface EffectiveWorkersInput {
  readonly parallel?: boolean | undefined
  readonly workers?: number | undefined
  readonly memberCount: number
}

// `min(memberCount, workers ?? DEFAULT_PARALLEL_WORKERS)` when `parallel` is true, else 1, never
// below 1. A workers value that is not a positive count (zero, negative, below one or non-finite)
// resolves to the default ceiling rather than to unbounded concurrency.
export function resolveEffectiveWorkers(input: EffectiveWorkersInput): number {
  if (input.parallel !== true) return 1
  const requested = input.workers === undefined ? DEFAULT_PARALLEL_WORKERS : Math.floor(input.workers)
  const ceiling = Number.isFinite(requested) && requested >= 1 ? requested : DEFAULT_PARALLEL_WORKERS
  return Math.max(1, Math.min(input.memberCount, ceiling))
}
