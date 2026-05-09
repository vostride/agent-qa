import { readdir, readFile, writeFile, unlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { parseDocument, stringify } from 'yaml'
import { AutomationSchema, type AutomationDefinition } from './schema.js'

export class AutomationLoader {
  private dir: string

  constructor(dir = '.agent-qa/automations') {
    this.dir = dir
  }

  async loadAll(): Promise<{ automations: AutomationDefinition[]; files: Map<string, string> }> {
    await mkdir(this.dir, { recursive: true })
    const entries = await readdir(this.dir)
    const yamlFiles = entries.filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))

    const automations: AutomationDefinition[] = []
    const files = new Map<string, string>()

    for (const file of yamlFiles) {
      const filePath = join(this.dir, file)
      const content = await readFile(filePath, 'utf-8')
      const doc = parseDocument(content)
      const data = doc.toJSON()
      const result = AutomationSchema.safeParse(data)
      if (result.success) {
        automations.push(result.data)
        files.set(result.data.name, filePath)
      }
    }

    return { automations, files }
  }

  async load(name: string): Promise<AutomationDefinition | undefined> {
    const { automations } = await this.loadAll()
    return automations.find(a => a.name === name)
  }

  async save(automation: AutomationDefinition, existingPath?: string): Promise<string> {
    await mkdir(this.dir, { recursive: true })
    const filePath = existingPath ?? join(this.dir, `${this.slugify(automation.name)}.yaml`)

    let content: string
    try {
      const existing = await readFile(filePath, 'utf-8')
      const doc = parseDocument(existing)
      for (const [key, value] of Object.entries(automation)) {
        doc.set(key, value)
      }
      content = doc.toString()
    } catch {
      content = stringify(automation)
    }

    await writeFile(filePath, content, 'utf-8')
    return filePath
  }

  async delete(name: string): Promise<boolean> {
    const { files } = await this.loadAll()
    const filePath = files.get(name)
    if (!filePath) return false
    await unlink(filePath)
    return true
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  }
}
