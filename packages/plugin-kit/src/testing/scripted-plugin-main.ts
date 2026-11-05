import { appendFileSync, realpathSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import { definePlugin, PluginError, type PluginCallContext } from '../define-plugin.js'
import { findPackageRoot, readPackageJson } from '../package-root.js'
import { PLUGIN_MANIFEST_FIELD, PluginManifestSchema } from '../protocol/manifest.js'
import {
  CheckResultSchema,
  PLUGIN_FAILURE_KINDS,
  PLUGIN_SERVES,
  StartedResultSchema,
  UploadAppResultSchema,
  type OptionalPluginMethod,
  type PluginMethod,
} from '../protocol/messages.js'
import { runPlugin } from '../run-plugin.js'
import type { ScriptedPluginTiming } from './scripted-plugin.js'

const ScriptStepSchema = z.union([
  z.enum(['ok', 'hold', 'crash', 'noise', 'consoleLog', 'ignoreCancel']),
  z.object({
    error: z.object({
      kind: z.enum(PLUGIN_FAILURE_KINDS),
      message: z.string(),
      path: z.string().optional(),
    }),
  }),
  z.object({
    delayMs: z.number().int().nonnegative(),
    ignoreCancel: z.boolean().optional(),
  }),
  z.object({
    errorAfterCreate: z.object({ kind: z.enum(PLUGIN_FAILURE_KINDS), message: z.string() }),
  }),
])

// A list gives each call its own step in order; the last step repeats.
const ScriptSchema = z.union([ScriptStepSchema, z.array(ScriptStepSchema).min(1)])
type ScriptStep = z.output<typeof ScriptStepSchema>

const AnswerSchema = z.object({
  protocol: z.enum(PLUGIN_SERVES),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  mask: z.array(z.string()).optional(),
  link: z.string().optional(),
})

const ProgressSchema = z.object({
  message: z.string(),
  queued: z.number().int().nonnegative().optional(),
  percent: z.number().min(0).max(100).optional(),
})

const ScriptedOptionsSchema = z.looseObject({
  ledgerFile: z.string().optional(),
  recordProcess: z.boolean().optional(),
  recordParams: z.boolean().optional(),
  answer: AnswerSchema.optional(),
  script: z.record(z.string(), ScriptSchema).optional(),
  stderr: z.record(z.string(), z.string()).optional(),
  progress: z.array(ProgressSchema).optional(),
  started: StartedResultSchema.optional(),
  upload: UploadAppResultSchema.optional(),
  check: CheckResultSchema.optional(),
})
type ScriptedOptions = z.output<typeof ScriptedOptionsSchema>
type Handle = z.core.util.JSONType

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

function cancelled(method: PluginMethod, handle: Handle | undefined): PluginError {
  return new PluginError(`${method} was cancelled`, {
    kind: 'timeout',
    ...(handle === undefined ? {} : { handle }),
  })
}

const callsSoFar = new Map<string, number>()

function stepFor(options: ScriptedOptions, method: PluginMethod): ScriptStep {
  const planned = options.script?.[method] ?? 'ok'
  if (!Array.isArray(planned)) return planned
  const call = callsSoFar.get(method) ?? 0
  callsSoFar.set(method, call + 1)
  return planned[Math.min(call, planned.length - 1)] ?? 'ok'
}

async function follow(
  options: ScriptedOptions,
  method: PluginMethod,
  ctx: PluginCallContext,
  handle?: Handle,
): Promise<void> {
  const logged = options.stderr?.[method]
  if (logged !== undefined) writeSync(2, `${logged}\n`)
  const step = stepFor(options, method)
  switch (step) {
    case 'ok':
      return
    case 'hold':
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      throw cancelled(method, handle)
    case 'ignoreCancel':
      await new Promise<never>(() => {})
      return
    case 'crash':
      process.exit(1)
    case 'noise':
      writeSync(1, 'noise\n')
      return
    case 'consoleLog':
      console.log(`${method} logged to the console`)
      return
  }
  if ('delayMs' in step) {
    try {
      await sleep(step.delayMs, undefined, step.ignoreCancel ? {} : { signal: ctx.signal })
    } catch {
      throw cancelled(method, handle)
    }
    return
  }
  if ('errorAfterCreate' in step) {
    throw new PluginError(step.errorAfterCreate.message, {
      kind: step.errorAfterCreate.kind,
      ...(handle === undefined ? {} : { handle }),
    })
  }
  throw new PluginError(step.error.message, {
    kind: step.error.kind,
    ...(step.error.path === undefined ? {} : { path: step.error.path }),
  })
}

export function startScriptedPlugin(timing: ScriptedPluginTiming = {}): void {
  const manifest = readOwnManifest()
  const declares = (method: OptionalPluginMethod) => manifest.methods.includes(method)
  let issued = 0

  const definition = definePlugin({
    options: ScriptedOptionsSchema,
    settings: z.looseObject({}),
    serves: manifest.serves,
    ...(manifest.runFacts === undefined ? {} : { runFacts: manifest.runFacts }),
    async initialize({ options, host, runFacts }, ctx) {
      ledger(options, {
        method: 'initialize',
        ...(options.recordProcess === true
          ? {
              execPath: process.execPath,
              pid: process.pid,
              envKeys: Object.keys(process.env),
              options,
              host,
              ...(runFacts === undefined ? {} : { runFacts }),
            }
          : {}),
      })
      await follow(options, 'initialize', ctx)
    },
    async acquire({ options, remote, session, run }, ctx) {
      issued += 1
      const handle = { n: issued }
      ledger(options, {
        method: 'acquire',
        handle,
        remote,
        ...(options.recordParams === true ? { session, ...(run === undefined ? {} : { run }) } : {}),
      })
      for (const update of options.progress ?? []) ctx.progress(update)
      await follow(options, 'acquire', ctx, handle)
      if (options.answer === undefined) {
        throw new PluginError('the scripted plugin has no answer option', {
          kind: 'refused',
          path: 'answer',
        })
      }
      return { handle, ...options.answer }
    },
    async release({ options, handle }, ctx) {
      ledger(options, { method: 'release', handle })
      await follow(options, 'release', ctx)
    },
    async shutdown({ options }, ctx) {
      ledger(options, { method: 'shutdown' })
      await follow(options, 'shutdown', ctx)
    },
    ...(declares('check')
      ? {
          async check({ options }: { options: ScriptedOptions }, ctx: PluginCallContext) {
            ledger(options, { method: 'check' })
            await follow(options, 'check', ctx)
            return options.check ?? { state: 'ok' as const, lines: [] }
          },
        }
      : {}),
    ...(declares('uploadApp')
      ? {
          async uploadApp(
            { options, remote }: { options: ScriptedOptions; remote: string },
            ctx: PluginCallContext,
          ) {
            ledger(options, { method: 'uploadApp', remote })
            await follow(options, 'uploadApp', ctx)
            return options.upload ?? { ref: 'scripted-app' }
          },
        }
      : {}),
    ...(declares('started')
      ? {
          async started(
            {
              options,
              handle,
              sessionId,
            }: { options: ScriptedOptions; handle: unknown; sessionId?: string },
            ctx: PluginCallContext,
          ) {
            ledger(options, {
              method: 'started',
              handle,
              ...(options.recordParams === true && sessionId !== undefined ? { sessionId } : {}),
            })
            await follow(options, 'started', ctx)
            return options.started ?? {}
          },
        }
      : {}),
    ...(declares('end')
      ? {
          async end(
            {
              options,
              handle,
              outcome,
              reason,
            }: { options: ScriptedOptions; handle: unknown; outcome: string; reason?: string },
            ctx: PluginCallContext,
          ) {
            ledger(options, {
              method: 'end',
              handle,
              ...(options.recordParams === true
                ? { outcome, ...(reason === undefined ? {} : { reason }) }
                : {}),
            })
            await follow(options, 'end', ctx)
          },
        }
      : {}),
  })

  runPlugin(definition, timing)
}
