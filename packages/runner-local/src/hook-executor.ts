// DockerHookExecutor (Phase 363 D-06) — the runner-local storageImplementation of
// the runner `HookExecutorPort`. The sandbox-runner body moved VERBATIM from
// core/src/hooks/sandbox-runner.ts: image pull policy, tmpdir workdir copy of
// file + deps + packageFile, authState mount, env + secret injection, container
// limits (512m / 1cpu / pids256 / read-only), network-none unless hook.network,
// /tmp/agent-qa.env variable extraction, secret-valued output-variable filtering,
// stdout/stderr redaction, and timeout→exit-124. This is the ONLY home for
// node:child_process / node:fs on the hook path — the runner stays storageNeutral
// (Pitfall 3: ALL sandbox-side redaction/filtering preserved; the sink mask is
// additive, never a replacement).

import { execFile, type ChildProcess } from 'node:child_process'
import { readFile, mkdtemp, mkdir, rm, cp } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import type {
  HookDefinition,
  HookResult,
  HookRuntime,
  HookExecutorPort,
  HookExecuteOptions,
  RuntimeAuthStateConfig,
} from '@vostride/agent-qa-runner'
import {
  hookRunnerImage,
  parseEnvFile,
  AUTH_STATE_HOOK_CONTAINER_STORAGE_STATE_PATH,
  AUTH_STATE_HOOK_STORAGE_STATE_FILENAME,
  AUTH_STATE_HOOK_WORKSPACE_DIR,
  buildAuthStateHookEnv,
  stripReservedAuthStateHookEnv,
  redactSecretValue,
} from '@vostride/agent-qa-runner'

const DEFAULT_DOCKER_BIN = 'docker'

export interface DockerHookExecutorConfig {
  version: string
  dockerBin?: string
  pullPolicy?: 'always' | 'if-not-present' | 'never'
}

// One executor per host composition root. A per-hook timeout resolves a failed result,
// never a throw.
export class DockerHookExecutor implements HookExecutorPort {
  private readonly version: string
  private readonly dockerBin: string
  private readonly pullPolicy: 'always' | 'if-not-present' | 'never'

  constructor(config: DockerHookExecutorConfig) {
    this.version = config.version
    this.dockerBin = config.dockerBin ?? DEFAULT_DOCKER_BIN
    this.pullPolicy = config.pullPolicy ?? 'if-not-present'
  }

  async execute(hook: HookDefinition, opts: HookExecuteOptions): Promise<HookResult> {
    const dockerBin = this.dockerBin
    const pullPolicy = this.pullPolicy
    const start = Date.now()

    const image = hookRunnerImage(hook.runtime, this.version)

    if (pullPolicy === 'always' || pullPolicy === 'if-not-present') {
      const needsPull = pullPolicy === 'always' || !(await imageExists(dockerBin, image))
      if (needsPull) {
        await pullImage(dockerBin, image)
      }
    }

    let workDir: string | undefined
    try {
      workDir = await mkdtemp(join(tmpdir(), 'agent-qa-hook-'))
      await mkdir(join(workDir, 'tmp'), { recursive: true })

      await cp(hook.file, join(workDir, basename(hook.file)))

      for (const dep of hook.deps) {
        await cp(dep, join(workDir, basename(dep)))
      }

      if (hook.packageFile) {
        await cp(hook.packageFile, join(workDir, basename(hook.packageFile)))
      }

      if (opts.authState) {
        const authStateDir = join(workDir, AUTH_STATE_HOOK_WORKSPACE_DIR)
        await mkdir(authStateDir, { recursive: true })
        await cp(opts.authState.storageStatePath, join(authStateDir, AUTH_STATE_HOOK_STORAGE_STATE_FILENAME))
      }

      const args = buildDockerArgs({
        image,
        workDir,
        hook,
        env: opts.env,
        secretEnv: opts.secretEnv,
        authState: opts.authState,
      })

      const cmd = getHookCommand(hook.runtime, basename(hook.file))
      args.push(...cmd)

      const { stdout, stderr, exitCode } = await execDocker(dockerBin, args, hook.timeout)

      let variables: Record<string, string> = {}
      try {
        const envContent = await readFile(join(workDir, 'tmp', 'agent-qa.env'), 'utf-8')
        variables = parseEnvFile(envContent)
      } catch {
        // Hook did not write .env file -- no variables to extract
      }
      variables = stripReservedAuthStateHookEnv(filterSecretVariables(variables, opts.secretEnv))
      const redactedStdout = redactSecretValue(stdout, opts.secretRedactor)
      const redactedStderr = redactSecretValue(stderr, opts.secretRedactor)
      const output = redactedStdout.trim()

      return {
        success: exitCode === 0,
        variables,
        output: output || redactedStderr,
        stdout: redactedStdout,
        stderr: redactedStderr,
        duration: Date.now() - start,
        error: exitCode !== 0
          ? redactSecretValue(`Hook exited with code ${exitCode}: ${stderr}`, opts.secretRedactor)
          : undefined,
      }
    } catch (err) {
      return {
        success: false,
        variables: {},
        output: '',
        stdout: '',
        stderr: '',
        duration: Date.now() - start,
        error: redactSecretValue((err as Error).message, opts.secretRedactor),
      }
    } finally {
      if (workDir) {
        await rm(workDir, { recursive: true, force: true }).catch(() => {})
      }
    }
  }
}

/**
 * Docker availability probe (re-homed from core/src/hooks/sandbox-runner.ts). The CLI
 * `doctor` command consumes this to report whether the hook sandbox can run.
 */
export async function checkDockerAvailable(dockerBin = DEFAULT_DOCKER_BIN): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(dockerBin, ['info', '--format', '{{.ID}}'], { timeout: 5000 }, (err) => {
      resolve(!err)
    })
  })
}

function getHookCommand(runtime: HookRuntime, entryFile: string): string[] {
  switch (runtime) {
    case 'node': return ['node', entryFile]
    case 'bun': return ['bun', entryFile]
    case 'python': return ['python3', entryFile]
    case 'bash': return ['bash', entryFile]
  }
}

interface DockerArgsInput {
  image: string
  workDir: string
  hook: HookDefinition
  env: Record<string, string>
  secretEnv: Record<string, string>
  authState?: RuntimeAuthStateConfig
}

function buildDockerArgs(input: DockerArgsInput): string[] {
  const args = [
    'run',
    '--rm',
    '--init',
    '-v', `${input.workDir}:/workspace`,
    '-w', '/workspace',
    '--memory', '512m',
    '--cpus', '1',
    '--pids-limit', '256',
    '--read-only',
    '-v', `${input.workDir}/tmp:/tmp`,
  ]

  if (!input.hook.network) {
    args.push('--network', 'none')
  }

  const envVars: Record<string, string> = { ...input.env }
  // Secret values overlay normal env vars in the container (already-resolved by the
  // composition root; the runner-local impl never touches the SecretStore, D-06).
  Object.assign(envVars, input.secretEnv)
  Object.assign(envVars, buildAuthStateHookEnv(
    input.authState,
    AUTH_STATE_HOOK_CONTAINER_STORAGE_STATE_PATH,
  ))

  for (const [k, v] of Object.entries(envVars)) {
    args.push('-e', `${k}=${v}`)
  }

  args.push(input.image)
  return args
}

function filterSecretVariables(
  variables: Record<string, string>,
  secretEnv: Record<string, string>,
): Record<string, string> {
  const secretValues = new Set(Object.values(secretEnv))
  if (secretValues.size === 0) return variables
  return Object.fromEntries(
    Object.entries(variables).filter(([_key, value]) => !secretValues.has(value)),
  )
}

function imageExists(dockerBin: string, image: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(dockerBin, ['image', 'inspect', image], { timeout: 10000 }, (err) => {
      resolve(!err)
    })
  })
}

function pullImage(dockerBin: string, image: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(dockerBin, ['pull', image], { timeout: 120000 }, (err) => {
      if (err) reject(new Error(`Failed to pull image ${image}: ${err.message}`))
      else resolve()
    })
  })
}

interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

function execDocker(dockerBin: string, args: string[], timeout: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let resolved = false

    const _proc: ChildProcess = execFile(dockerBin, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, out, errOut) => {
      if (resolved) return
      resolved = true

      stdout = out ?? ''
      stderr = errOut ?? ''

      if (err && 'killed' in err && (err as { killed?: boolean }).killed) {
        resolve({ stdout, stderr: `Hook timed out after ${timeout}ms`, exitCode: 124 })
        return
      }

      const exitCode = (err as { code?: number } | null)?.code ?? 0
      resolve({ stdout, stderr, exitCode: typeof exitCode === 'number' ? exitCode : 1 })
    })
    void _proc
  })
}
