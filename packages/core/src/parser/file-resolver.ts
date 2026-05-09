import { readFile, access } from 'node:fs/promises'
import { dirname, resolve, extname } from 'node:path'

export interface FileAttachment {
  name: string
  path: string
  content: Buffer
  mimeType: string
}

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
}

function detectMimeType(filename: string): string {
  const ext = extname(filename).toLowerCase()
  return MIME_TYPES[ext] ?? 'application/octet-stream'
}

const FILE_REF_PATTERN = /\$\{file:([^}]+)\}/g

export async function resolveFileReferences(
  stepText: string,
  testFilePath: string,
): Promise<{ resolvedText: string; attachments: FileAttachment[] }> {
  const matches = [...stepText.matchAll(FILE_REF_PATTERN)]

  if (matches.length === 0) {
    return { resolvedText: stepText, attachments: [] }
  }

  const testDir = dirname(testFilePath)
  const attachments: FileAttachment[] = []
  let resolvedText = stepText

  for (const match of matches) {
    const filename = match[1]
    const absolutePath = resolve(testDir, filename)

    try {
      await access(absolutePath)
    } catch {
      throw new Error(
        `File attachment not found: "${filename}" (resolved to "${absolutePath}", referenced in test "${testFilePath}")`,
      )
    }

    const content = await readFile(absolutePath) as Buffer

    attachments.push({
      name: filename,
      path: absolutePath,
      content,
      mimeType: detectMimeType(filename),
    })

    resolvedText = resolvedText.replace(match[0], absolutePath)
  }

  return { resolvedText, attachments }
}
