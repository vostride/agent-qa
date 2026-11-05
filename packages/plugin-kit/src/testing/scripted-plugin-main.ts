import { appendFileSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { definePlugin, PluginError } from '../define-plugin.js'
import { findPackageRoot, readPackageJson } from '../package-root.js'
import { PLUGIN_MANIFEST_FIELD, PluginManifestSchema } from '../protocol/manifest.js'
import {
  PLUGIN_FAILURE_KINDS,
  PLUGIN_SERVES,
  type OptionalPluginMethod,
  type PluginMethod,
} from '../protocol/messages.js'
import { runPlugin } from '../run-plugin.js'

const ScriptStepSchema = z.union([
  z.literal('ok'),
  z.literal('hold'),
  z.object({
    error: z.object({
      kind: z.enum(PLUGIN_FAILURE_KINDS),
      message: z.string(),
      path: z.string().optional(),
    }),
  }),
])

const AnswerSchema = z.object({
  protocol: z.enum(PLUGIN_SERVES),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  mask: z.array(z.string()).optional(),
  link: z.string().optional(),
})

const ScriptedOptionsSchema = z.looseObject({
  ledgerFile: z.string().optional(),
  answer: AnswerSchema.optional(),
  script: z.record(z.string(), ScriptStepSchema).optional(),
})
type ScriptedOptions = z.output<typeof ScriptedOptionsSchema>

function readOwnManifest() {
  const entryPath = process.argv[1]
  if (entryPath === undefined) throw new Error('the scripted plugin needs its entry path')
  const root = findPackageRoot(dirname(realpathSync(entryPath)))
  if (root === undefined) throw new Error(`no package.json above ${entryPath}`)
  const field = readPackageJson(root)[PLUGIN_MANIFEST_FIELD]
  const plugin =
    typeof field === 'object' && field !== null ? Reflect.get(field, 'plugin') : undefined
  const manifest = PluginManifestSchema.parse(plugin)
  if (manifest.kind !== 'remote') throw new Error('the scripted plugin is a remote plugin')
  return manifest
}

function ledger(options: ScriptedOptions, entry: Record<string, unknown>) {
  if (options.ledgerFile !== undefined) {
    appendFileSync(options.ledgerFile, `${JSON.stringify(entry)}\n`)
  }
}

async function follow(options: ScriptedOptions, method: PluginMethod): Promise<void> {
  const step = options.script?.[method] ?? 'ok'
  if (step === 'ok') return
  if (step === 'hold') {
    await new Promise<never>(() => {})
    return
  }
  throw new PluginError(step.error.message, {
    kind: step.error.kind,
    ...(step.error.path === undefined ? {} : { path: step.error.path }),
  })
}

export function startScriptedPlugin(): void {
  const manifest = readOwnManifest()
  const declares = (method: OptionalPluginMethod) => manifest.methods.includes(method)
  let issued = 0

  const definition = definePlugin({
    options: ScriptedOptionsSchema,
    settings: z.looseObject({}),
    serves: manifest.serves,
    ...(manifest.runFacts === undefined ? {} : { runFacts: manifest.runFacts }),
    async initialize({ options }) {
      ledger(options, { method: 'initialize' })
      await follow(options, 'initialize')
    },
    async acquire({ options, remote }) {
      issued += 1
      const handle = { n: issued }
      ledger(options, { method: 'acquire', handle, remote })
      await follow(options, 'acquire')
      if (options.answer === undefined) {
        throw new PluginError('the scripted plugin has no answer option', {
          kind: 'refused',
          path: 'answer',
        })
      }
      return { handle, ...options.answer }
    },
    async release({ options, handle }) {
      ledger(options, { method: 'release', handle })
      await follow(options, 'release')
    },
    async shutdown({ options }) {
      ledger(options, { method: 'shutdown' })
      await follow(options, 'shutdown')
    },
    ...(declares('check')
      ? {
          async check({ options }: { options: ScriptedOptions }) {
            ledger(options, { method: 'check' })
            await follow(options, 'check')
            return { state: 'ok' as const, lines: [] }
          },
        }
      : {}),
    ...(declares('uploadApp')
      ? {
          async uploadApp({ options, remote }: { options: ScriptedOptions; remote: string }) {
            ledger(options, { method: 'uploadApp', remote })
            await follow(options, 'uploadApp')
            return { ref: 'scripted-app' }
          },
        }
      : {}),
    ...(declares('started')
      ? {
          async started({ options, handle }: { options: ScriptedOptions; handle: unknown }) {
            ledger(options, { method: 'started', handle })
            await follow(options, 'started')
            return {}
          },
        }
      : {}),
    ...(declares('end')
      ? {
          async end({ options, handle }: { options: ScriptedOptions; handle: unknown }) {
            ledger(options, { method: 'end', handle })
            await follow(options, 'end')
          },
        }
      : {}),
  })

  runPlugin(definition)
}
