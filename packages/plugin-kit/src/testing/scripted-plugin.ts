import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findPackageRoot } from '../package-root.js'
import { PLUGIN_MANIFEST_FIELD, PluginManifestSchema } from '../protocol/manifest.js'
import {
  OPTIONAL_PLUGIN_METHODS,
  PLUGIN_PROTOCOL_VERSION,
  PLUGIN_SERVES,
  type OptionalPluginMethod,
  type PluginRunFact,
  type PluginServe,
} from '../protocol/messages.js'

export interface ScriptedPluginInput {
  packageName?: string
  version?: string
  serves?: readonly PluginServe[]
  methods?: readonly OptionalPluginMethod[]
  runFacts?: readonly PluginRunFact[]
  timing?: ScriptedPluginTiming
}

export interface ScriptedPluginTiming {
  cancelAnswerGraceMs?: number
  hostPidPollMs?: number
}

export interface ScriptedPlugin {
  dir: string
  entry: string
}

const OPEN_OBJECT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
}

const SKILL = `---
name: scripted
description: A scripted agent-qa plugin that answers each call as its options say.
---

# Scripted plugin

Each call follows \`options.script[method]\`: \`ok\`, \`hold\`, \`ignoreCancel\`, \`crash\`,
\`noise\`, \`consoleLog\`, \`{ delayMs }\`, \`{ error }\` or \`{ errorAfterCreate }\`. A list of
steps gives each call the next one, and the last repeats. \`options.stderr[method]\` is written
to stderr before the step.
With \`options.recordProcess\`, the initialize ledger line also records the process, its
environment's names, its options, the host and the run facts. With \`options.recordParams\`, the
acquire line also records the session and run, the started line the session id, and the end line
the outcome and reason.
`

function scriptedMainFile(): string {
  const kitRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url)))
  const file = kitRoot === undefined ? undefined : join(kitRoot, 'dist', 'scripted-plugin.js')
  if (file === undefined || !existsSync(file)) {
    throw new Error('the scripted plugin needs the kit built: run pnpm build in the plugin kit')
  }
  return file
}

export function writeScriptedPlugin(dir: string, input: ScriptedPluginInput = {}): ScriptedPlugin {
  const manifest = PluginManifestSchema.parse({
    kind: 'remote',
    runs: 'process',
    protocol: PLUGIN_PROTOCOL_VERSION,
    entry: './main.mjs',
    serves: [...(input.serves ?? PLUGIN_SERVES)],
    methods: [...(input.methods ?? OPTIONAL_PLUGIN_METHODS)],
    options: './options.schema.json',
    settings: './settings.schema.json',
    ...(input.runFacts === undefined ? {} : { runFacts: [...input.runFacts] }),
    skill: './skill',
  })
  const packageJson = {
    name: input.packageName ?? '@acme/agent-qa-plugin-scripted',
    version: input.version ?? '1.0.0',
    private: true,
    type: 'module',
    keywords: ['agent-qa-plugin'],
    exports: { './package.json': './package.json' },
    [PLUGIN_MANIFEST_FIELD]: { plugin: manifest },
  }
  const mainUrl = pathToFileURL(scriptedMainFile()).href

  mkdirSync(join(dir, 'skill'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`)
  const openSchema = `${JSON.stringify(OPEN_OBJECT_SCHEMA, null, 2)}\n`
  writeFileSync(join(dir, 'options.schema.json'), openSchema)
  writeFileSync(join(dir, 'settings.schema.json'), openSchema)
  writeFileSync(join(dir, 'skill', 'SKILL.md'), SKILL)
  const timing = {
    ...(input.timing?.cancelAnswerGraceMs === undefined
      ? {}
      : { cancelAnswerGraceMs: input.timing.cancelAnswerGraceMs }),
    ...(input.timing?.hostPidPollMs === undefined
      ? {}
      : { hostPidPollMs: input.timing.hostPidPollMs }),
  }
  writeFileSync(
    join(dir, 'main.mjs'),
    `import { startScriptedPlugin } from ${JSON.stringify(mainUrl)}\n\nstartScriptedPlugin(${JSON.stringify(timing)})\n`,
  )
  return { dir, entry: join(dir, 'main.mjs') }
}
