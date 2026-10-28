import type { IncomingMessage } from 'node:http'

const DEFAULT_MAX_BYTES = 1024 * 1024 // 1MB

export function carriesNonJsonBody(req: IncomingMessage): boolean {
  const hasBody = req.headers['transfer-encoding'] !== undefined
    || Number(req.headers['content-length'] ?? '0') > 0
  if (!hasBody) return false
  const type = req.headers['content-type']
  return type === undefined || type.split(';', 1)[0]!.trim().toLowerCase() !== 'application/json'
}

export function readJsonBody<T>(req: IncomingMessage, maxBytes = DEFAULT_MAX_BYTES): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalBytes = 0

    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length
      if (totalBytes > maxBytes) {
        req.destroy()
        reject(new Error(`Body exceeds maximum size of ${maxBytes} bytes`))
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8')
      if (!body) {
        reject(new Error('Empty request body'))
        return
      }
      try {
        resolve(JSON.parse(body) as T)
      } catch {
        reject(new Error('Invalid JSON in request body'))
      }
    })

    req.on('error', (err) => {
      reject(err)
    })
  })
}
