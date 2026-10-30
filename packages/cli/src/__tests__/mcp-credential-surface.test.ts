// Absence is checked on recorded response bodies over every 8-character window, with controls.

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { buildAgentQaMcpServer } from '@vostride/agent-qa-mcp'
import { runSafetyScope } from '@vostride/agent-qa-safety-local'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { composeMcpMasking, MCP_FUNCTION_CALLER } from '../commands/mcp.js'
import { composeCliLocalAgent } from '../composition/local-agent-host.js'

// ── THE PLANTS ────────────────────────────────────────────────────────────────────────────────
//
// Each one exercises a DIFFERENT arm, and the file says which. Two share no arm with each other,
// which is what stops a single mechanism from carrying every cell.

// The masker reads only the secrets file, where the plants below are declared.
const ENV_PLANT = 'qeb4t7zmv1x8s3d0g5j2n9'

const TOKEN_PLANT = 'wnk9j2p6r4y7c1f8h3l5b0'

/**
 * A credential whose value happens to be a VALID PROPOSAL ID, so it survives the SDK's input
 * validation and reaches an op that ECHOES it in a SUCCESS payload (`proposals.show` answers
 * `{kind:'not-found', proposalId}`). Declared in the secrets file.
 *
 * It exists because the mutation harness measured that no other cell in this file exercised the
 * generic handler's SUCCESS-path masking at all: every echoing channel here is a refusal, so
 * severing the success-path `maskText` left the whole suite green. A corpus whose absence cells all
 * live on one channel is a corpus that has measured one channel.
 */
const ECHO_PLANT = 'prop_qxr7t2mv9s4d1g8j5n3b6'

/** Declared to nothing and shaped like nothing: the hostile control's value. */
const UNSEEDED_PLANT = 'hzp5r8u2i7o4a9e6k3m1v8'

/** Opaque, under a credential-named key the shipped census does not enumerate: the bound. */
const OPAQUE_HEADER_PLANT = 'tealwood7412delta5510sierra'

/**
 * Fingerprints computed with `node:crypto`, OUTSIDE this repository's own hashing.
 *
 * The product publishes a `redactedFingerprint` for every scan finding precisely so a value can be
 * discussed without being repeated. Matching it against a hash this file computes for itself is the
 * integrity half of every absence claim below: the pipeline held these exact bytes.
 */
function fingerprintOutsideTheCodebase(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16)
}

const CONFIG_FILE = 'agent-qa.config.yaml'
const SECRETS_FILE = '.env.secrets.local'
const DECLARED_PLANTS: Readonly<Record<string, string>> = {
  PLANT_ENV_396: ENV_PLANT,
  PLANT_TOKEN_396: TOKEN_PLANT,
  PLANT_ECHO_396: ECHO_PLANT,
}

function seededConfig(extraLlmLines = ''): string {
  return `# agent-qa Configuration

workspace:
  testMatch:
    - tests/**/*.yaml
  suiteMatch:
    - suites/**/*.suite.yaml
  hooksFile: hooks.yaml
  envFile: .env
  secretsFile: .env.secrets.local

registry:
  llms:
    - name: judge
      provider: openai-subscription
      model: gpt-5.6-terra
${extraLlmLines}  targets:
    local-form:
      platform: web
      url: http://127.0.0.1:8931/form.html

use:
  llm: judge
  timeout:
    step: 30s
    test: 90m
    navigation: 2m
  mobile:
    appState: reset
  parallel: false
`
}

/** The same file with a second entry whose header carries an opaque value under a credential name. */
function configWithOpaqueHeaderCredential(): string {
  return seededConfig(
    `    - name: headers
      provider: anthropic-compatible
      model: claude-4.7-sonnet
      baseURL: https://api.example.com
      providerHeaders:
        X-Client-Auth: ${OPAQUE_HEADER_PLANT}
`,
  )
}

let root: string
let configPath: string
let agentQaRoot: string
let host: ReturnType<typeof composeCliLocalAgent> | undefined
let masking: ReturnType<typeof composeMcpMasking> | undefined
let frames: string[]
let client: Client | undefined
let handler: ReturnType<typeof createMcpHandler> | undefined

function git(...args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} exited ${String(result.status)}: ${result.stderr}`)
  }
  return result.stdout
}

// Windowed, so a partial disclosure fails; the hostile control proves this helper finds a value.
function leakedWindow(haystack: string, plant: string, size = 8): string | undefined {
  for (let at = 0; at + size <= plant.length; at += 1) {
    const window = plant.slice(at, at + size)
    if (haystack.includes(window)) return window
  }
  return undefined
}

/** Every byte this session's transport received, in order — the only honest haystack. */
function wire(): string {
  return frames.join('\n')
}

interface ToolResult {
  readonly content?: readonly { readonly type: string; readonly text?: string }[]
  readonly structuredContent?: Record<string, unknown>
  readonly isError?: boolean
}

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client!.callTool({ name, arguments: args })) as ToolResult
}

function rendered(result: ToolResult): string {
  return (result.content ?? []).map((block) => block.text ?? '').join('\n')
}

/** Build the fixture project, the shipped composition, and a connected client over it. */
async function openWorkspace(configBody: string): Promise<void> {
  root = mkdtempSync(join(tmpdir(), 'agent-qa-396-06-cred-'))
  configPath = join(root, CONFIG_FILE)
  agentQaRoot = join(root, '.agent-qa')
  mkdirSync(agentQaRoot, { recursive: true })
  writeFileSync(configPath, configBody)
  writeFileSync(
    join(root, SECRETS_FILE),
    Object.entries(DECLARED_PLANTS).map(([name, value]) => `${name}=${value}\n`).join(''),
  )

  git('init', '--quiet')
  git('config', 'user.name', 'agent-qa 396-06 credential surface')
  git('config', 'user.email', 'credential-surface@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(root, '.gitignore'), '.agent-qa/\nagent-qa-knowledge/\n')
  git('add', '--', '.gitignore', CONFIG_FILE)
  git('commit', '--quiet', '-m', 'seed')

  // THE PRODUCTION MASKER — the function the `mcp` command itself calls, shared with the host as the
  // command shares it. A suite that built its own masker here would be asserting that ITS masker
  // works, which is true and worthless.
  masking = composeMcpMasking({ configPath })
  host = composeCliLocalAgent({ agentQaRoot, configPath, declaredSecrets: masking })

  frames = []
  handler = createMcpHandler(() =>
    buildAgentQaMcpServer({
      registry: host!.registry,
      // The one tokenless caller; no stdio grant exists to resolve.
      caller: MCP_FUNCTION_CALLER,
      maskText: masking!.mask,
    }),
  )
  const recordingFetch = (async (url: URL | string, init?: RequestInit) => {
    const res = await handler!.fetch(new Request(url as string, init))
    frames.push(await res.clone().text())
    return res
  }) as typeof fetch

  client = new Client({ name: 'agent-qa-396-06-credential', version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://cred.local/mcp'), { fetch: recordingFetch }),
  )
}

beforeEach(async () => {
  await openWorkspace(seededConfig())
})

afterEach(async () => {
  await client?.close().catch(() => {})
  await handler?.close().catch(() => {})
  await host?.close().catch(() => {})
  client = undefined
  handler = undefined
  host = undefined
  masking = undefined
  rmSync(root, { recursive: true, force: true })
})

function headless<T>(fn: () => Promise<T>): Promise<T> {
  return runSafetyScope({ executionContext: 'local-headless' }, fn)
}

// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('A · the plants are what the ledger says they are (the non-vacuity gate)', () => {
  it('every plant is really where the fixture put it, and the bytes are the pinned bytes',
    () => {
      const declared = readFileSync(join(root, SECRETS_FILE), 'utf8')
      for (const [name, value] of Object.entries(DECLARED_PLANTS)) {
        expect(declared, `${name} was not declared`).toContain(`${name}=${value}\n`)
      }

      // The fingerprints are computed here with `node:crypto` and pinned as literals. A plant edited
      // without its fingerprint being re-derived fails HERE, before any absence cell can pass for
      // the wrong reason.
      expect(fingerprintOutsideTheCodebase(ENV_PLANT)).toBe('db3186baa5885bf6')

      // And the plants are pairwise distinct in every eight-character window, so no cell below can
      // pass or fail on another plant's bytes.
      const plants = [ENV_PLANT, TOKEN_PLANT, UNSEEDED_PLANT, OPAQUE_HEADER_PLANT]
      for (const [at, plant] of plants.entries()) {
        for (const [other, second] of plants.entries()) {
          if (at === other) continue
          expect(leakedWindow(second, plant), `${plant} shares a window with ${second}`)
            .toBeUndefined()
        }
      }
    })

  it('the masker recognises exactly the two DECLARED plants, and nothing else', () => {
    for (const [name, value] of Object.entries(DECLARED_PLANTS)) {
      expect(masking!.mask(value), `${name} was not masked`).toBe(`[secret:${name}]`)
    }

    // A value only the environment holds is not a declared secret, so it is not hidden.
    process.env['AGENT_QA_ENV_ONLY_TOKEN'] = UNSEEDED_PLANT
    try {
      expect(masking!.mask(UNSEEDED_PLANT), 'an environment-only value was masked')
        .toBe(UNSEEDED_PLANT)
    } finally {
      delete process.env['AGENT_QA_ENV_ONLY_TOKEN']
    }

    // The discrimination that makes F1 a control rather than a coincidence: this value is NOT
    // masked, so a channel that returns it verbatim is returning what it was given.
    expect(masking!.mask(UNSEEDED_PLANT)).toBe(UNSEEDED_PLANT)
    expect(masking!.mask(OPAQUE_HEADER_PLANT)).toBe(OPAQUE_HEADER_PLANT)
  })
})

describe('B · no declared credential reaches the wire through a read tool', () => {
  it('the echoing read path masks both declared plants, in the result AND in the frames',
    async () => {
      await headless(async () => {
        for (const plant of [ENV_PLANT, TOKEN_PLANT]) {
          const answer = await call('agent_qa_get_run_digest', { runId: plant })

          // THE INTEGRITY HALF FIRST. `runs.digest` composes its refusal from the caller's own
          // string, so this cell only means something if the echo really happened; a path that
          // stopped echoing would satisfy the absence assertion for free.
          expect(rendered(answer), 'the echo path stopped echoing — the cell measures nothing')
            .toContain('No completed run recorded for id')

          expect(leakedWindow(rendered(answer), plant), `the tool result carried ${plant}`)
            .toBeUndefined()
          expect(leakedWindow(wire(), plant), `a recorded frame carried ${plant}`).toBeUndefined()
        }
      })
    })

  it('the SUCCESS payload of a read tool that echoes the caller\'s own string is masked on '
    + 'BOTH channels — text and structuredContent', async () => {
    await headless(async () => {
      // The record read's not-found arm echoes the caller's own id on its success channel.
      const answer = await call('agent_qa_show_knowledge_record', { recordId: ECHO_PLANT })

      // The integrity half: this really is the echoing SUCCESS arm, not a refusal.
      expect(answer.isError ?? false, rendered(answer)).toBe(false)
      expect((answer.structuredContent as { kind?: string }).kind).toBe('not-found')

      expect(leakedWindow(rendered(answer), ECHO_PLANT), 'the text channel carried the plant')
        .toBeUndefined()
      expect(
        leakedWindow(JSON.stringify(answer.structuredContent), ECHO_PLANT),
        'structuredContent carried the plant — the machine channel a person never reads',
      ).toBeUndefined()
      expect(leakedWindow(wire(), ECHO_PLANT), 'a recorded frame carried the plant').toBeUndefined()
    })
  })

  it('the other read doors carry no window of either declared plant either', async () => {
    await headless(async () => {
      for (const plant of [ENV_PLANT, TOKEN_PLANT]) {
        await call('agent_qa_get_entity', { ref: plant })
        await call('agent_qa_list_knowledge_bundles', {})
        await call('agent_qa_list_runs', {})
      }
      for (const plant of [ENV_PLANT, TOKEN_PLANT]) {
        expect(leakedWindow(wire(), plant), `a read door leaked ${plant}`).toBeUndefined()
      }
    })
  })
})

describe('C · the error channels', () => {
  it('an op-side refusal composed from the caller\'s own string is masked', async () => {
    await headless(async () => {
      const answer = await call('agent_qa_get_run_digest', { runId: ENV_PLANT })
      expect(answer.isError, 'this cell needs the refusal path, not the success path').toBe(true)
      expect(leakedWindow(wire(), ENV_PLANT)).toBeUndefined()
    })
  })

  it('the SDK-composed input-validation error is a channel this host does NOT mask, and it '
    + 'is measured empty', async () => {
    await headless(async () => {
      // The SDK refuses schema-invalid input before any handler, naming the field, not the value.
      const answer = await call('agent_qa_change_knowledge', {
        action: 'knowledge.forget',
        target: { grain: 'bundle', shortId: ENV_PLANT },
      })

      expect(answer.isError).toBe(true)
      expect(rendered(answer), 'the SDK stopped naming the tool — re-read this channel')
        .toContain('Input validation error')
      expect(leakedWindow(wire(), ENV_PLANT), 'the SDK now quotes rejected arguments, and this '
        + 'host does not mask that channel').toBeUndefined()
    })
  })
})

describe('D · the direct change answer renders the caller\'s target, and masks it', () => {
  // A typed absence echoes the target it is asked about, through the one masked serialization.
  it('neither the prose nor the structured answer carries a window of a declared plant',
    async () => {
      await headless(async () => {
        for (const plant of [ENV_PLANT, TOKEN_PLANT]) {
          const answer = await call('agent_qa_change_knowledge', {
            action: 'knowledge.accept',
            target: { grain: 'record', recordId: plant },
          })

          // The integrity half: this really is the typed absence, composed from the caller's id.
          const structured = answer.structuredContent as Record<string, unknown>
          expect(answer.isError ?? false, rendered(answer)).toBe(false)
          expect(structured['outcome']).toBe('target-not-found')

          expect(leakedWindow(rendered(answer), plant)).toBeUndefined()
          expect(leakedWindow(JSON.stringify(structured), plant)).toBeUndefined()
          expect(leakedWindow(wire(), plant), `the change answer leaked ${plant}`).toBeUndefined()
        }
      })
    })
})

// A config change is not scanned; a declared value in its diff reaches the wire as its marker.

describe('F · the controls, and the bound they measure', () => {
  it('HOSTILE CONTROL: an UNSEEDED value travels the same channel verbatim, and the helper '
    + 'finds it', async () => {
    await headless(async () => {
      const answer = await call('agent_qa_get_run_digest', { runId: UNSEEDED_PLANT })

      // If this control did not find the value, every absence above would be over a dead channel.
      expect(leakedWindow(rendered(answer), UNSEEDED_PLANT), 'the echo channel is DEAD: the '
        + 'absence cells above prove nothing').toBeDefined()
      expect(leakedWindow(wire(), UNSEEDED_PLANT)).toBeDefined()
      expect(rendered(answer)).toContain(UNSEEDED_PLANT)
    })
  })

  it('THE BOUND, MEASURED: an opaque value under a credential-NAMED key the census does not '
    + 'enumerate reaches the wire inside a proposal diff', async () => {
    await client?.close().catch(() => {})
    await handler?.close().catch(() => {})
    await host?.close().catch(() => {})
    rmSync(root, { recursive: true, force: true })
    await openWorkspace(configWithOpaqueHeaderCredential())

    await headless(async () => {
      const answer = await call('agent_qa_change_config', {
        action: 'config.field.set',
        // THE SECOND ENTRY, which is the one carrying the header. A change three lines away would
        // put the credential outside the diff's context window and the cell would then be about
        // hunk arithmetic rather than about the census.
        path: 'registry.llms.1.model',
        value: 'claude-4.8-sonnet',
      })
      const outcome = answer.structuredContent as { outcome?: string; shownDiff?: string }

      // The change is written, and its diff carries an undeclared neighbouring header value as is.
      expect(outcome.outcome, rendered(answer)).toBe('applied')
      expect(leakedWindow(outcome.shownDiff ?? '', OPAQUE_HEADER_PLANT), 'the bound closed — '
        + 'update this cell and the ledger, and tell 397').toBeDefined()

      // A declared value reaches the wire as its marker; this one is undeclared.
      expect(masking!.mask(OPAQUE_HEADER_PLANT)).toBe(OPAQUE_HEADER_PLANT)
    })
  })
})

describe('config-change diffs over MCP', () => {
  it('a declared secret in a config-change diff reaches MCP as its named marker', async () => {
    await client?.close().catch(() => {})
    await handler?.close().catch(() => {})
    await host?.close().catch(() => {})
    rmSync(root, { recursive: true, force: true })
    await openWorkspace(configWithOpaqueHeaderCredential())
    // The plant needs no YAML quoting; masking applies to raw values only.
    appendFileSync(join(root, '.env.secrets.local'), `X_CLIENT_AUTH_441=${OPAQUE_HEADER_PLANT}\n`)

    await headless(async () => {
      const answer = await call('agent_qa_change_config', {
        action: 'config.field.set',
        path: 'registry.llms.1.model',
        value: 'claude-4.8-sonnet',
      })
      const outcome = answer.structuredContent as { outcome?: string; shownDiff?: string }
      expect(outcome.outcome, rendered(answer)).toBe('applied')
      expect(outcome.shownDiff).toContain('[secret:X_CLIENT_AUTH_441]')
      const diff = outcome.shownDiff ?? ''
      expect(leakedWindow(diff, OPAQUE_HEADER_PLANT), 'the diff carried the plant').toBeUndefined()
      expect(leakedWindow(wire(), OPAQUE_HEADER_PLANT), 'a recorded frame carried the plant')
        .toBeUndefined()
    })
  })
})

describe('credential-shaped config values', () => {
  it('a credential-shaped value written through the composed host is applied and '
    + 'the file holds it', async () => {
    const probe = 'sk-PROBE-1234567890'
    await headless(async () => {
      const answer = await call('agent_qa_change_config', {
        action: 'config.field.set',
        path: 'use.buildTag',
        value: probe,
      })
      const outcome = answer.structuredContent as { outcome?: string; shownDiff?: string }
      expect(outcome.outcome, rendered(answer)).toBe('applied')
      expect(outcome.shownDiff).toContain(probe)
      expect(readFileSync(configPath, 'utf8')).toContain(`buildTag: ${probe}`)
    })
  })
})

describe('G · redaction lands on credentials, not on the config', () => {
  it('the credential-free members of the same payloads survive verbatim', async () => {
    await headless(async () => {
      const listed = await client!.listTools()
      // The catalogue is readable: a masker that blackened everything would take from the model the
      // very surface it was asked to use. Over-redaction is a real cost, not a safe default.
      expect(listed.tools.map((tool) => tool.name)).toContain('agent_qa_change_config')

      const answer = await call('agent_qa_change_config', {
        action: 'config.field.set',
        path: 'use.timeout.step',
        value: '45s',
      })
      const outcome = answer.structuredContent as { outcome?: string; shownDiff?: string }
      expect(outcome.outcome, rendered(answer)).toBe('applied')

      // An ordinary config change renders its ordinary bytes: the diff is a diff, not a marker.
      expect(outcome.shownDiff).toContain('step: 30s')
      expect(outcome.shownDiff).toContain('step: 45s')
      expect(outcome.shownDiff).toContain(CONFIG_FILE)

      // And the response is not wholesale opaque.
      expect(JSON.stringify(outcome).length).toBeGreaterThan(200)
    })
  })
})
