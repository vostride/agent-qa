import { Command } from 'commander'
import pc from 'picocolors'
import { parseDocument, Document } from 'yaml'
import { readFile, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { loadConfigFile, loadEnvOverrides, formatConfigDebug } from '../config.js'

const SENSITIVE_KEYS = new Set([
  'apikey',
  'authtoken',
  'token',
  'key',
  'accesskey',
  'secret',
  'password',
  'bearertoken',
  'accesstoken',
  'refreshtoken',
])

function isSensitiveKey(key: string): boolean {
  const lastSegment = key.split('.').pop() ?? ''
  return SENSITIVE_KEYS.has(lastSegment.toLowerCase().replace(/[^a-z0-9]/g, ''))
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf-8').trim()
}

function plainPrompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

async function getValue(key: string, providedValue: string | undefined): Promise<string | null> {
  if (providedValue !== undefined) return providedValue

  if (process.stdin.isTTY) {
    return plainPrompt(`Enter value for ${key}: `)
  }
  return readStdin()
}

async function setAction(key: string, value: string | undefined): Promise<void> {
  if (isSensitiveKey(key)) {
    console.error(pc.red('Credential values are not written by config set.'))
    console.error('Use agent-qa auth set --config <name> --type api-key|bearer-token for compatible or Gemini configs.')
    console.error('Use plugins.auth plus the dashboard auth flow for subscription configs.')
    return
  }

  const resolved = await getValue(key, value)
  if (!resolved) {
    console.error(pc.red('No value provided.'))
    return
  }

  const configPath = 'agent-qa.config.yaml'
  let doc: Document
  try {
    const content = await readFile(configPath, 'utf-8')
    doc = parseDocument(content)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      doc = new Document({})
    } else {
      throw err
    }
  }

  doc.setIn(key.split('.'), resolved)
  await writeFile(configPath, doc.toString())
  console.log(pc.green(`\u2713 ${key} = ${resolved} saved to agent-qa.config.yaml`))
}

async function showAction(): Promise<void> {
  const fileConfig = await loadConfigFile('agent-qa.config.yaml')
  const envOverrides = loadEnvOverrides()
  // Merge env into file config (3-layer: file+env is the global config)
  const { mergeConfigs } = await import('../config.js')
  const globalConfig = mergeConfigs(fileConfig, envOverrides, {})
  const table = formatConfigDebug(globalConfig, {}, {})
  console.log(pc.bold('\nResolved Configuration:\n'))
  console.log(table)
  console.log()
}

export function createConfigCommand(): Command {
  const cmd = new Command('config').description('Manage configuration')

  cmd
    .command('set <key> [value]')
    .description('Set a config value')
    .action(setAction)

  cmd
    .command('show')
    .description('Show resolved config with source attribution')
    .action(showAction)

  return cmd
}
