import { createHash } from 'node:crypto'

export function hashStep(instruction: string): string {
  return createHash('sha256').update(instruction).digest('hex').slice(0, 16)
}
