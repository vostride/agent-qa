import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolveFileReferences } from '../file-resolver.js'

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  access: vi.fn(),
}))

describe('resolveFileReferences', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('resolves single ${file:screenshot.png} to absolute path alongside test file', async () => {
    const { readFile, access } = await import('node:fs/promises')
    const mockReadFile = vi.mocked(readFile)
    const mockAccess = vi.mocked(access)
    mockAccess.mockResolvedValue(undefined)
    mockReadFile.mockResolvedValue(Buffer.from('PNG data'))

    const result = await resolveFileReferences(
      'Upload ${file:screenshot.png}',
      '/tests/login.yaml',
    )

    expect(result.attachments).toHaveLength(1)
    expect(result.attachments[0].name).toBe('screenshot.png')
    expect(result.attachments[0].path).toBe('/tests/screenshot.png')
    expect(result.attachments[0].mimeType).toBe('image/png')
    expect(result.attachments[0].content).toBeInstanceOf(Buffer)
    expect(result.resolvedText).toBe('Upload /tests/screenshot.png')
  })

  it('resolves multiple file references in one step', async () => {
    const { readFile, access } = await import('node:fs/promises')
    const mockReadFile = vi.mocked(readFile)
    const mockAccess = vi.mocked(access)
    mockAccess.mockResolvedValue(undefined)
    mockReadFile.mockResolvedValue(Buffer.from('file data'))

    const result = await resolveFileReferences(
      'Upload ${file:doc.pdf} and ${file:photo.jpg}',
      '/tests/upload.yaml',
    )

    expect(result.attachments).toHaveLength(2)
    expect(result.attachments[0].name).toBe('doc.pdf')
    expect(result.attachments[1].name).toBe('photo.jpg')
    expect(result.resolvedText).toBe('Upload /tests/doc.pdf and /tests/photo.jpg')
  })

  it('step with no file references returns unchanged text and empty attachments', async () => {
    const result = await resolveFileReferences(
      'Click the Login button',
      '/tests/login.yaml',
    )

    expect(result.resolvedText).toBe('Click the Login button')
    expect(result.attachments).toHaveLength(0)
  })

  it('throws clear error when referenced file doesn\'t exist', async () => {
    const { access } = await import('node:fs/promises')
    const mockAccess = vi.mocked(access)
    mockAccess.mockRejectedValue(new Error('ENOENT'))

    await expect(
      resolveFileReferences('Upload ${file:missing.png}', '/tests/upload.yaml'),
    ).rejects.toThrow('File attachment not found')
  })

  it('detects correct MIME types for common extensions', async () => {
    const { readFile, access } = await import('node:fs/promises')
    const mockReadFile = vi.mocked(readFile)
    const mockAccess = vi.mocked(access)
    mockAccess.mockResolvedValue(undefined)
    mockReadFile.mockResolvedValue(Buffer.from('data'))

    const extensions: Record<string, string> = {
      'image.png': 'image/png',
      'photo.jpg': 'image/jpeg',
      'document.pdf': 'application/pdf',
      'readme.txt': 'text/plain',
      'data.json': 'application/json',
    }

    for (const [filename, expectedMime] of Object.entries(extensions)) {
      vi.clearAllMocks()
      mockAccess.mockResolvedValue(undefined)
      mockReadFile.mockResolvedValue(Buffer.from('data'))

      const result = await resolveFileReferences(
        `Upload \${file:${filename}}`,
        '/tests/test.yaml',
      )
      expect(result.attachments[0].mimeType).toBe(expectedMime)
    }
  })

  it('handles nested paths: ${file:assets/logo.png} resolves correctly', async () => {
    const { readFile, access } = await import('node:fs/promises')
    const mockReadFile = vi.mocked(readFile)
    const mockAccess = vi.mocked(access)
    mockAccess.mockResolvedValue(undefined)
    mockReadFile.mockResolvedValue(Buffer.from('logo data'))

    const result = await resolveFileReferences(
      'Upload ${file:assets/logo.png}',
      '/tests/upload.yaml',
    )

    expect(result.attachments[0].name).toBe('assets/logo.png')
    expect(result.attachments[0].path).toBe('/tests/assets/logo.png')
  })

  it('file content is read as Buffer', async () => {
    const { readFile, access } = await import('node:fs/promises')
    const mockReadFile = vi.mocked(readFile)
    const mockAccess = vi.mocked(access)
    mockAccess.mockResolvedValue(undefined)
    const content = Buffer.from('binary content here')
    mockReadFile.mockResolvedValue(content)

    const result = await resolveFileReferences(
      'Upload ${file:data.bin}',
      '/tests/test.yaml',
    )

    expect(result.attachments[0].content).toEqual(content)
  })
})
