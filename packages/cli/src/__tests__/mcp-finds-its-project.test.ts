// agent-qa mcp finds the nearest project config at or above the folder it was started in.

import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/client'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { afterEach, describe, expect, it } from 'vitest'

import { resolveMcpConfigPath } from '../commands/mcp-project.js'
import { defaultProjectIo } from '../commands/project-host.js'
import { payloadOf } from './mcp-tool-payload.js'
import { cleanupTempProjects, tempProject } from './project-fixtures.js'

const CLI_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/cli.js')
const CONFIG = 'agent-qa.config.yaml'

afterEach(() => {
  cleanupTempProjects()
})

function folder(...parts: string[]): string {
  const path = join(...parts)
  mkdirSync(path, { recursive: true })
  return path
}

function writeConfig(dir: string): string {
  const path = join(dir, CONFIG)
  writeFileSync(
    path,
    `${JSON.stringify({
      workspace: {
        testMatch: ['tests/**/*.yaml'],
        testPathIgnore: [],
        suiteMatch: ['suites/**/*.suite.yaml'],
        hooksFile: 'hooks.yaml',
        envFile: '.env',
        secretsFile: '.env.secrets.local',
      },
    }, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(join(dir, '.env.secrets.local'), '')
  return path
}

function resolveFrom(input: { cwd: string; home: string; env?: NodeJS.ProcessEnv; config?: string }) {
  return resolveMcpConfigPath({
    config: input.config ?? CONFIG,
    env: input.env ?? {},
    cwd: input.cwd,
    host: { homedir: input.home, io: defaultProjectIo },
  })
}

describe('resolveMcpConfigPath', () => {
  it('finds the config in the working folder', async () => {
    const { root, home } = tempProject('mcp-here')
    writeConfig(root)
    const real = realpathSync(root)
    expect(await resolveFrom({ cwd: root, home })).toEqual({
      configPath: join(real, CONFIG),
      projectDir: real,
      found: true,
    })
  })

  it('finds the project config from a folder below it', async () => {
    const { root, home } = tempProject('mcp-below')
    writeConfig(root)
    const real = realpathSync(root)
    expect(await resolveFrom({ cwd: folder(root, 'tests', 'deep'), home })).toEqual({
      configPath: join(real, CONFIG),
      projectDir: real,
      found: true,
    })
  })

  it('starts from INIT_CWD when npx started it and moved the working folder up', async () => {
    const { root, home } = tempProject('mcp-npx')
    const app = folder(root, 'packages', 'app')
    writeConfig(app)
    const real = realpathSync(app)
    const result = await resolveFrom({
      cwd: root,
      home,
      env: { npm_command: 'exec', INIT_CWD: folder(app, 'tests') },
    })
    expect(result).toEqual({ configPath: join(real, CONFIG), projectDir: real, found: true })
  })

  it('ignores an INIT_CWD outside the working folder, inherited from another npm process', async () => {
    const { root, home } = tempProject('mcp-npx-stale')
    writeConfig(root)
    const elsewhere = tempProject('mcp-npx-stale-elsewhere').root
    const result = await resolveFrom({
      cwd: elsewhere,
      home,
      env: { npm_command: 'exec', INIT_CWD: folder(root, 'tests') },
    })
    expect(result.found).toBe(false)
    expect(result.configPath).toBe(join(realpathSync(elsewhere), CONFIG))
  })

  it('ignores INIT_CWD when npx did not start it', async () => {
    const { root, home } = tempProject('mcp-script')
    writeConfig(root)
    const elsewhere = tempProject('mcp-script-elsewhere').root
    const tests = folder(root, 'tests')
    for (const env of [{ INIT_CWD: tests }, { npm_command: 'run-script', INIT_CWD: tests }]) {
      const result = await resolveFrom({ cwd: elsewhere, home, env })
      expect(result.found).toBe(false)
      expect(result.configPath).toBe(join(realpathSync(elsewhere), CONFIG))
    }
  })

  it('takes the nearest project when projects are nested', async () => {
    const { root: outer, home } = tempProject('mcp-nested')
    writeConfig(outer)
    const inner = folder(outer, 'inner')
    writeConfig(inner)
    const real = realpathSync(inner)
    expect(await resolveFrom({ cwd: folder(inner, 'x'), home })).toEqual({
      configPath: join(real, CONFIG),
      projectDir: real,
      found: true,
    })
  })

  it('stops at the folder holding .git and names the config at the start folder', async () => {
    const { root, home } = tempProject('mcp-git-bound')
    writeConfig(root)
    const repo = folder(root, 'repo')
    mkdirSync(join(repo, '.git'))
    const sub = folder(repo, 'sub')
    const real = realpathSync(sub)
    expect(await resolveFrom({ cwd: sub, home })).toEqual({
      configPath: join(real, CONFIG),
      projectDir: real,
      found: false,
    })
  })

  it('never reaches the home folder', async () => {
    const { home } = tempProject('mcp-home-bound')
    writeConfig(home)
    const result = await resolveFrom({ cwd: folder(home, 'a', 'b'), home })
    expect(result.found).toBe(false)
    expect(result.configPath).toBe(join(realpathSync(home), 'a', 'b', CONFIG))
  })

  it('uses an absolute config as given', async () => {
    const { root, home } = tempProject('mcp-absolute')
    const present = writeConfig(folder(root, 'project'))
    const absent = join(root, 'missing', CONFIG)
    const cwd = folder(root, 'elsewhere')
    expect(await resolveFrom({ cwd, home, config: present })).toEqual({
      configPath: present,
      projectDir: dirname(present),
      found: true,
    })
    expect(await resolveFrom({ cwd, home, config: absent })).toEqual({
      configPath: absent,
      projectDir: dirname(absent),
      found: false,
    })
  })
})

describe('agent-qa mcp started below its project', () => {
  it('serves the project and leaves the start folder untouched', async () => {
    expect(
      existsSync(CLI_ENTRY),
      `the built CLI entry is missing at ${CLI_ENTRY}; run \`pnpm build\` first`,
    ).toBe(true)
    const { root, home } = tempProject('mcp-spawned')
    writeConfig(root)
    mkdirSync(join(root, '.agent-qa'))
    const deep = folder(root, 'tests', 'deep')

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_ENTRY, 'mcp'],
      cwd: deep,
      env: { ...getDefaultEnvironment(), HOME: home, USERPROFILE: home },
      stderr: 'pipe',
    })
    let stderr = ''
    transport.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    })
    const client = new Client({ name: 'agent-qa-finds-its-project', version: '0.0.0' })
    try {
      await client.connect(transport)
      const names = (await client.listTools()).tools.map((tool) => tool.name)
      expect(names).toContain('agent_qa_list_runs')
      const result = await client.callTool({ name: 'agent_qa_list_runs', arguments: {} })
      const payload = payloadOf(result.structuredContent)
      expect(payload.status, stderr).not.toBe('not_initialized')
      expect(payload.status, stderr).not.toBe('config_invalid')
      expect(result.isError, stderr).toBeFalsy()
    } finally {
      await client.close().catch(() => {})
      await transport.close().catch(() => {})
    }
    expect(existsSync(join(deep, '.agent-qa'))).toBe(false)
  }, 60_000)
})
