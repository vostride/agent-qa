// A skipped tap's block, keyed `idempotentNoop`; `inputSent: false` marks the current shape.
export interface IdempotentNoopMeta {
  currentState: string
  inputSent?: false
}

// Also reads the older `{ currentState }` block.
export function readIdempotentNoopMeta(
  result?: { metadata?: Record<string, unknown> },
): IdempotentNoopMeta | undefined {
  const raw = result?.metadata?.['idempotentNoop']
  if (raw && typeof raw === 'object' && 'currentState' in raw) {
    const { currentState, inputSent } = raw as Record<string, unknown>
    if (typeof currentState !== 'string') return undefined
    if (inputSent === undefined) return { currentState }
    if (inputSent === false) return { currentState, inputSent }
  }
  return undefined
}

// A skipped tap sent no input and did not fail, whichever shape recorded it.
export function actionDidNotFail(result?: {
  success?: boolean
  metadata?: Record<string, unknown>
}): boolean {
  return result?.success === true || readIdempotentNoopMeta(result)?.inputSent === false
}
