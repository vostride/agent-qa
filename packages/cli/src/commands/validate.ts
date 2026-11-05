import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { Command } from 'commander'
import {
  discoverWorkspaceFiles,
  formatDiagnostics,
  getAgentQaVersion,
  isPathInsideDir,
  isPluginRemoteEntry,
  parseSuiteFile,
  parseTestFile,
  pluginRemoteRefusals,
  resolvePluginEntries,
  resolveWorkspacePaths,
  selectSuitePlace,
  selectWebPlace,
  validateProject,
} from '@vostride/agent-qa-core'
import type {
  AgentQaConfig,
  BrowserEngine,
  PluginRemoteUse,
  ResolvedWorkspacePaths,
  SelectWebPlaceResult,
  TestDefinition,
  ValidationDiagnostic,
  ValidationResult,
} from '@vostride/agent-qa-core'
import { printRunText } from '@vostride/agent-qa-core/run-text-output'
import { resolveConfig } from '../config.js'
import { readDeclaredSecrets } from '../composition/declared-secrets.js'

function browserEngine(name: unknown): BrowserEngine | undefined {
  return name === 'chromium' || name === 'firefox' || name === 'webkit' ? name : undefined
}

async function testsIn(filePath: string): Promise<TestDefinition[]> {
  try {
    const parsed = parseTestFile(await readFile(filePath, 'utf-8'), filePath)
    return parsed.errors.length > 0 ? [] : parsed.tests
  } catch {
    return []
  }
}

// The plugin remotes a run of this workspace would use, picked as `agent-qa run` picks them.
async function pluginRemoteUses(
  config: AgentQaConfig,
  workspace: ResolvedWorkspacePaths,
): Promise<PluginRemoteUse[]> {
  const remotes = config.registry?.remotes ?? []
  const pluginRemotes = new Set(remotes.filter(isPluginRemoteEntry).map(({ name }) => name))
  if (pluginRemotes.size === 0) return []
  const configDir = workspace.configDir
  const configBrowser = config.use?.browser
  const uses: PluginRemoteUse[] = []
  const useWeb = (selected: SelectWebPlaceResult): void => {
    if (!('place' in selected) || selected.place.kind !== 'remote') return
    const name = selected.place.remote.name
    if (pluginRemotes.has(name)) uses.push({ remote: name, place: 'web' })
  }
  const runsInBrowser = (target: string | undefined): boolean =>
    target !== undefined && config.registry?.targets?.[target]?.platform === 'web'

  if (configBrowser?.remote !== undefined && pluginRemotes.has(configBrowser.remote)) {
    uses.push({ remote: configBrowser.remote, place: 'web' })
  }
  for (const profile of Object.values(config.registry?.devices ?? {})) {
    if (profile.remote !== undefined && pluginRemotes.has(profile.remote)) {
      uses.push({ remote: profile.remote, place: 'device' })
    }
  }

  for (const file of await discoverWorkspaceFiles({ workspace, kind: 'test' })) {
    for (const test of await testsIn(file.absolutePath)) {
      if (!runsInBrowser(test.target)) continue
      useWeb(
        selectWebPlace({
          remotes,
          test: test.use?.browser?.remote,
          config: configBrowser?.remote,
          engine: browserEngine(test.use?.browser?.name ?? configBrowser?.name),
        }),
      )
    }
  }
  for (const file of await discoverWorkspaceFiles({ workspace, kind: 'suite' })) {
    let suite
    try {
      suite = await parseSuiteFile(file.absolutePath)
    } catch {
      continue
    }
    const members: { file: string; pick?: string; target?: string }[] = []
    for (const entry of suite.tests) {
      if (!isPathInsideDir(entry.test, configDir)) continue
      const [member] = await testsIn(path.resolve(configDir, entry.test))
      if (member === undefined) continue
      members.push({ file: entry.test, pick: member.use?.browser?.remote, target: member.target })
    }
    if (!runsInBrowser(suite.target ?? members[0]?.target)) continue
    useWeb(
      selectSuitePlace({
        remotes,
        suiteName: suite.name,
        suiteFile: file.absolutePath,
        suite: suite.use?.browser?.remote,
        config: configBrowser?.remote,
        members: members.map(({ file: memberFile, pick }) => ({ file: memberFile, pick })),
        engine: browserEngine(suite.use?.browser?.name ?? configBrowser?.name),
      }),
    )
  }
  return uses
}

// The run-start refusals and the unused entries, read from manifests and schemas only.
async function pluginDiagnostics(
  config: AgentQaConfig,
  workspace: ResolvedWorkspacePaths,
): Promise<ValidationDiagnostic[]> {
  const plugins = config.plugins ?? []
  if (plugins.length === 0) return []
  const remotes = config.registry?.remotes ?? []
  const options = { configDir: workspace.configDir, agentQaVersion: getAgentQaVersion() }
  let declaredSecrets: { has(name: string): boolean } | undefined
  try {
    declaredSecrets = readDeclaredSecrets(workspace.secretsFile.absolutePath)
  } catch {
    // validateProject reports a missing secrets file itself.
    declaredSecrets = undefined
  }
  const diagnostic = (
    message: string,
    severity: ValidationDiagnostic['severity'],
  ): ValidationDiagnostic => ({ file: workspace.configPath, line: 1, column: 1, message, severity })

  const refusals = pluginRemoteRefusals({
    ...options,
    plugins,
    remotes,
    uses: await pluginRemoteUses(config, workspace),
    ...(declaredSecrets === undefined ? {} : { declaredSecrets }),
  })
  const unused = resolvePluginEntries({ plugins, remotes }, options).filter(
    (entry) => entry.state === 'unused',
  )
  return [
    ...refusals.map(({ message }) => diagnostic(message, 'error')),
    ...unused.map(({ reason }) => diagnostic(reason ?? '', 'warning')),
  ]
}

function appendDiagnostics(result: ValidationResult, diagnostics: ValidationDiagnostic[]): void {
  for (const found of diagnostics) {
    result.diagnostics.push(found)
    if (found.severity === 'error') result.errorCount++
    else result.warningCount++
  }
}

export function createValidateCommand(): Command {
  const cmd = new Command('validate')
    .description('Validate config, test files, and suite references')
    .argument('[files...]', 'specific files to validate (default: auto-discover all)')
    .action(async (files: string[], _options: unknown, command: Command) => {
      // Commander passes `(files, options, command)`, so the root `--config` comes off the third.
      const configPath = command.parent?.opts<{ config?: string }>().config ?? 'agent-qa.config.yaml'
      let config: AgentQaConfig | undefined
      let workspace
      let resolutionFailure: string | undefined

      try {
        // No auth plugins: validation reads config values, and a missing plugin would fail it.
        config = await resolveConfig({ configPath, loadAuthPlugins: false })
        workspace = resolveWorkspacePaths({ config, configPath })
      } catch (err) {
        // Every thrown value becomes a message string, so a primitive throw cannot pass as success.
        resolutionFailure = err instanceof Error ? err.message : String(err)
      }

      const result = await validateProject({
        configPath,
        files: files.length > 0 ? files : undefined,
        workspace,
      })
      if (config !== undefined && workspace !== undefined) {
        appendDiagnostics(result, await pluginDiagnostics(config, workspace))
      }

      // THE SUCCESS SENTENCE IS STRUCTURALLY UNREACHABLE FROM A FAILED RESOLUTION.
      // `formatDiagnostics` returns `✔ All files valid (N file(s) checked)` on exactly one
      // condition — an empty diagnostics list — so skipping the write in exactly that case is what
      // makes the attestation impossible rather than merely unlikely. Findings are still printed
      // when there are any, because a person whose config will not resolve still wants to read what
      // the validator did manage to see.
      if (resolutionFailure === undefined || result.diagnostics.length > 0) {
        printRunText(formatDiagnostics(result), (text) => {
          process.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
        })
      }

      if (resolutionFailure !== undefined) {
        printRunText(`\nConfig resolution failed: ${resolutionFailure}`, (text) => {
          process.stderr.write(`${text}\n`)
        })
        process.exitCode = 1
        return
      }

      if (result.errorCount > 0) {
        process.exitCode = 1
      }
    })

  return cmd
}
