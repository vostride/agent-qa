import { execFile, type ChildProcess } from 'node:child_process'
import { readFile, mkdtemp, mkdir, rm, writeFile, cp } from 'node:fs/promises'
import { join, basename, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import type { HookDefinition, HookResult, HookRuntime } from './types.js'
import { RUNTIME_IMAGE_MAP } from './types.js'
import { parseEnvFile } from '../agent/variables.js'
import { redactSecretValue, type SecretRedactor, type SecretStore } from '../agent/secrets.js'

export interface SandboxRunnerOptions {
  dockerBin?: string
  pullPolicy?: 'always' | 'if-not-present' | 'never'
  envVars?: Record<string, string>
  secretStore?: SecretStore
  secretRedactor?: SecretRedactor
}

const DEFAULT_DOCKER_BIN = 'docker'

function getHookCommand(runtime: HookRuntime, entryFile: string): string[] {
  switch (runtime) {
    case 'node': return ['node', entryFile]
    case 'bun': return ['bun', entryFile]
    case 'python': return ['python3', entryFile]
    case 'bash': return ['bash', entryFile]
  }
}

export async function checkDockerAvailable(dockerBin = DEFAULT_DOCKER_BIN): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(dockerBin, ['info', '--format', '{{.ID}}'], { timeout: 5000 }, (err) => {
      resolve(!err)
    })
  })
}

export async function runHookInSandbox(
  hook: HookDefinition,
  options: SandboxRunnerOptions = {},
): Promise<HookResult> {
  const dockerBin = options.dockerBin ?? DEFAULT_DOCKER_BIN
  const pullPolicy = options.pullPolicy ?? 'if-not-present'
  const start = Date.now()

  const image = RUNTIME_IMAGE_MAP[hook.runtime]

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

    const args = buildDockerArgs({
      image,
      workDir,
      hook,
      envVars: options.envVars,
      secretStore: options.secretStore,
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
    variables = filterSecretVariables(variables, options.secretStore)
    const redactedStdout = redactSecretValue(stdout, options.secretRedactor)
    const redactedStderr = redactSecretValue(stderr, options.secretRedactor)
    const output = redactedStdout.trim()

    return {
      success: exitCode === 0,
      variables,
      output: output || redactedStderr,
      stdout: redactedStdout,
      stderr: redactedStderr,
      duration: Date.now() - start,
      error: exitCode !== 0
        ? redactSecretValue(`Hook exited with code ${exitCode}: ${stderr}`, options.secretRedactor)
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
      error: redactSecretValue((err as Error).message, options.secretRedactor),
    }
  } finally {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

interface DockerArgsInput {
  image: string
  workDir: string
  hook: HookDefinition
  envVars?: Record<string, string>
  secretStore?: SecretStore
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

  const envVars: Record<string, string> = { ...(input.envVars ?? {}) }
  input.secretStore?.forEachSecret((name, value) => {
    envVars[name] = value
  })

  for (const [k, v] of Object.entries(envVars)) {
    args.push('-e', `${k}=${v}`)
  }

  args.push(input.image)
  return args
}

function filterSecretVariables(variables: Record<string, string>, secretStore?: SecretStore): Record<string, string> {
  if (!secretStore) return variables
  const secretValues = new Set<string>()
  secretStore.forEachSecret((_name, value) => secretValues.add(value))
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
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let resolved = false

    const proc: ChildProcess = execFile(dockerBin, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, out, errOut) => {
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
  })
}
