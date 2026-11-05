export function encodeMessage(message: unknown): string {
  return `${JSON.stringify(message)}\n`
}

export interface LineDecoderOptions {
  maxLineBytes: number
  onLine: (line: string) => void
  onOverflow: () => void
}

export interface LineDecoder {
  push(chunk: Uint8Array | string): void
  end(): void
}

const NEWLINE = 0x0a

export function createLineDecoder({
  maxLineBytes,
  onLine,
  onOverflow,
}: LineDecoderOptions): LineDecoder {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  let parts: Uint8Array[] = []
  let size = 0
  let discarding = false

  const append = (segment: Uint8Array) => {
    if (discarding || segment.length === 0) return
    if (size + segment.length > maxLineBytes) {
      discarding = true
      parts = []
      size = 0
      onOverflow()
      return
    }
    parts.push(new Uint8Array(segment))
    size += segment.length
  }

  const finishLine = () => {
    const wasDiscarding = discarding
    const lineParts = parts
    const lineSize = size
    parts = []
    size = 0
    discarding = false
    if (wasDiscarding || lineSize === 0) return
    const bytes = new Uint8Array(lineSize)
    let offset = 0
    for (const part of lineParts) {
      bytes.set(part, offset)
      offset += part.length
    }
    const line = decoder.decode(bytes).replace(/\r$/, '')
    if (line.trim() !== '') onLine(line)
  }

  return {
    push(chunk) {
      const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk
      let start = 0
      while (start <= bytes.length) {
        const newline = bytes.indexOf(NEWLINE, start)
        if (newline === -1) {
          append(bytes.subarray(start))
          return
        }
        append(bytes.subarray(start, newline))
        finishLine()
        start = newline + 1
      }
    },
    end() {
      finishLine()
    },
  }
}
