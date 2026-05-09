import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseDocument, stringify, type Document } from 'yaml'

const SENSITIVE_KEYS = new Set(['apikey', 'token', 'key', 'accesskey'])

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase())
}

function maskValue(value: string): string {
  if (value.length >= 8) {
    return value.slice(0, 3) + '****...' + value.slice(-4)
  }
  return '****'
}

function deepMask(obj: unknown, parentKey = ''): unknown {
  if (typeof obj === 'string' && isSensitiveKey(parentKey)) {
    return maskValue(obj)
  }
  if (Array.isArray(obj)) {
    return obj.map((item, i) => deepMask(item, String(i)))
  }
  if (typeof obj === 'object' && obj !== null) {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = deepMask(value, key)
    }
    return result
  }
  return obj
}

export class ConfigManager {
  constructor(private configPath: string) {}

  async read(): Promise<Record<string, unknown>> {
    try {
      const content = await readFile(this.configPath, 'utf-8')
      const doc = parseDocument(content)
      return (doc.toJSON() as Record<string, unknown>) ?? {}
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw err
    }
  }

  async readMasked(): Promise<Record<string, unknown>> {
    const config = await this.read()
    return deepMask(config) as Record<string, unknown>
  }

  private sectionPath(section: string): string[] {
    return section.includes('.') ? section.split('.') : [section]
  }

  async updateSection(section: string, value: Record<string, unknown>): Promise<void> {
    const path = this.sectionPath(section)
    let content: string
    try {
      content = await readFile(this.configPath, 'utf-8')
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        await mkdir(dirname(this.configPath), { recursive: true })
        await writeFile(this.configPath, stringify({ [section]: value }))
        return
      }
      throw err
    }

    const doc = parseDocument(content)
    for (const [key, val] of Object.entries(value)) {
      doc.setIn([...path, key], val)
    }
    await writeFile(this.configPath, doc.toString())
  }

  async replaceSection(section: string, value: Record<string, unknown>): Promise<void> {
    const path = this.sectionPath(section)
    let content: string
    try {
      content = await readFile(this.configPath, 'utf-8')
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        await mkdir(dirname(this.configPath), { recursive: true })
        await writeFile(this.configPath, stringify({ [section]: value }))
        return
      }
      throw err
    }
    const doc = parseDocument(content)
    // Overwrite in-place to preserve key ordering in the YAML file
    doc.setIn(path, doc.createNode(value))
    await writeFile(this.configPath, doc.toString())
  }

  async replaceSectionRaw(section: string, value: unknown): Promise<void> {
    const path = this.sectionPath(section)
    let content: string
    try {
      content = await readFile(this.configPath, 'utf-8')
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        await mkdir(dirname(this.configPath), { recursive: true })
        await writeFile(this.configPath, stringify({ [section]: value }))
        return
      }
      throw err
    }
    const doc = parseDocument(content)
    // Overwrite in-place to preserve key ordering in the YAML file
    doc.setIn(path, doc.createNode(value))
    await writeFile(this.configPath, doc.toString())
  }

  async deleteSectionRaw(section: string): Promise<void> {
    const path = this.sectionPath(section)
    let content: string
    try {
      content = await readFile(this.configPath, 'utf-8')
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        await mkdir(dirname(this.configPath), { recursive: true })
        await writeFile(this.configPath, stringify({}))
        return
      }
      throw err
    }
    const doc = parseDocument(content)
    doc.deleteIn(path)
    await writeFile(this.configPath, doc.toString())
  }

  async readDocument(): Promise<Document> {
    const content = await readFile(this.configPath, 'utf-8')
    return parseDocument(content)
  }
}
