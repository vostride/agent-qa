// THE CREDENTIAL SURFACE OF THE NEW MCP WIRE (396-06 · Pitfall 9 · T-395-R5-10's class).
//
// THE DEBT THIS PAYS. Phase 396 deleted the v1 MCP server and, with it, two suites that were the
// product's only pins on credential disclosure through an MCP channel:
// `agent-qa-server-masking.test.ts` and `credential-surface-parity.test.ts`. Both were written
// against `agent_qa_get_config`, a tool this surface no longer has. Deleting a test because the
// thing it tested was rewritten is how a closed defect reopens, so every assertion those two files
// made is accounted for below — re-derived against the new wire, or RETIRED WITH A REASON.
//
// ASSERTED ON THE SURFACE A CALLER READS. Every absence cell reads the RECORDED RESPONSE BODIES —
// the bytes the transport actually received — and not an internal object. 395 round 5 is the reason
// that sentence is in this header: ten cells passed while two shipped commands leaked a planted
// credential, because the corpus asserted on `error.message` while the live channel was the error's
// serialization. The frames are the only thing here that cannot lie about what left the process.
//
// ABSENCE IS WINDOWED AT EIGHT CHARACTERS. A cell that asks only whether the WHOLE credential is
// present is satisfied by a partial mask, which is a disclosure budget nobody set — v1's own suite
// had learned that and pinned a four-character tail sentinel. Windowing generalises it: no eight
// consecutive characters of any planted value may appear anywhere.
//
// AND EVERY ABSENCE IS PAIRED. An absence over a dead channel is the trap this project keeps
// recording, so each cell below travels with one of two companions:
//   · an INTEGRITY half — a fingerprint computed with `node:crypto`, OUTSIDE this codebase's own
//     hashing, matched against the fingerprint the pipeline itself published. The pipeline
//     demonstrably held those exact bytes and disclosed none of them.
//   · a HOSTILE CONTROL — the same channel, the same helper, an UNSEEDED value: it arrives
//     verbatim, and the helper finds it. That is what proves these cells can fail.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE RE-DERIVATION LEDGER — every assertion of the two deleted v1 suites, one row each.
// Recovered with:
//   git show $(git log --diff-filter=D --format=%H -1 -- <path>)^:<path>
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// FROM agent-qa-server-masking.test.ts (395-25):
//
// | v1 assertion                                          | here                                  |
// |-------------------------------------------------------|---------------------------------------|
// | (M1) a scalar `apiToken` never returned by             | RETIRED WITH THE DATA PATH. `config.  |
// |      `agent_qa_get_config`                             | get` is in `UNPROJECTED_OPS` — no     |
// |                                                        | whole-config render exists on this    |
// |                                                        | surface at all. The residual config-  |
// |                                                        | bytes channel is the change diff,     |
// |                                                        | masked by declaration (C441-MCP-DIFF).|
// | (M1) a URL-userinfo credential never returned          | RETIRED 2026-10-14 (441 D-15): config |
// |                                                        | changes are not scanned; a declared   |
// |                                                        | value in a diff is masked             |
// |                                                        | (C441-MCP-DIFF).                      |
// | (M1) a `providerHeaders` credential never returned     | RE-DERIVED as C441-MCP-DIFF for a     |
// |                                                        | declared value, and its BOUND         |
// |                                                        | measured in F2 for an undeclared      |
// |                                                        | one — see the bound note.             |
// | (M1) the partial-mask tail is gone, not shortened      | RE-DERIVED as the windowing rule      |
// |                                                        | itself: groups B, C, D.               |
// | (M1) `<redacted>` occurs three times — something WAS   | RE-DERIVED as A2 + B1's integrity     |
// |      redacted                                          | halves (the marker is present where   |
// |                                                        | the plant was).                       |
// | (M2) credential-free members of the same container     | RE-DERIVED as group G.                |
// |      survive verbatim                                  |                                       |
//
// FROM credential-surface-parity.test.ts (395-26):
//
// | v1 assertion                                          | here                                  |
// |-------------------------------------------------------|---------------------------------------|
// | (P0) every plant is really in the fixture              | RE-DERIVED as A1.                     |
// | (P0) the ancestor plants are NOT credential-shaped, so | RE-DERIVED IN A NEW VOCABULARY as A2: |
// |      the name arm is what carries the cell             | the new surface's one arm is the      |
// | (P0) the auth-mix plant IS credential-shaped           | masker's DECLARED set, and A2 pins    |
// | (P0) the auth redactor's early return really fires     | it. The v1 arms belong to             |
// |                                                        | `maskSensitive`, deleted with the v1  |
// |                                                        | server.                               |
// | (P1) every plant counts ZERO on BOTH shipped artefacts | HALF RE-DERIVED, HALF RETIRED, said   |
// |      (`config show` AND `agent_qa_get_config`)         | plainly: the MCP half is groups B-D;  |
// |                                                        | the CLI half lives in `packages/cli/  |
// |                                                        | src/composition/__tests__/masked-     |
// |                                                        | config.test.ts`. The cross-surface    |
// |                                                        | RELATION retires because the second   |
// |                                                        | channel does — a relation needs two   |
// |                                                        | renders of the same bytes and there   |
// |                                                        | is now one.                           |
// | (P1) the leak is measured at the exit code a person    | RETIRED WITH THE CLI ARM (this file   |
// |      actually gets                                     | drives no command).                   |
// | (P2) a sibling OUTSIDE the credential container, and   | RE-DERIVED as group G.                |
// |      the credential-free members, survive              |                                       |
// | (P2) the rows are MARKED, not dropped                  | RETIRED WITH `config show` (no row-   |
// |                                                        | oriented render on this surface).     |
// | (P2) the tool response is not wholesale opaque         | RE-DERIVED as G1.                     |
// | (P3) a non-credential sibling INSIDE a credential-     | RETIRED WITH THE RENDER. The new      |
// |      named container is redacted on both surfaces      | surface has no container-walking      |
// |                                                        | config render; the containment rule   |
// |                                                        | still governs `config show`, whose    |
// |                                                        | own suite owns it.                    |
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE BOUND, STATED BECAUSE IT IS MEASURED (F2). The masker knows the values declared in the secrets
// file and nothing else (441 D-01). A value that is not declared is not masked, and F2 drives exactly
// such a value all the way to the wire rather than describing it. A credential a person wants hidden
// is declared in the secrets file (B, D, C441-MCP-DIFF).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE FOUND — the defect RESEARCH Pitfall 9 named before anyone had driven the channel.
//
// Cell (B1b) was written because the mutation harness measured that no cell in this file exercised
// the generic handler's SUCCESS-path masking at all: every echoing channel here was a refusal, so
// severing the success-path `maskText` left the whole suite green. A corpus whose absence cells all
// live on one channel has measured one channel. The cell added to close that hole then failed, and
// what it failed on was the shipped implementation (2026-08-16, before the fix):
//
//   AssertionError: structuredContent carried the plant — the machine channel a person never
//   reads: expected 'prop_qxr' to be undefined
//
// `catalog.ts` masked `content` and set `structuredContent` from the RAW op output, so a credential
// this host had itself DECLARED reached the wire verbatim in the object a model reads while the text
// beside it read `<SECRET_0>`. Both handlers now answer both channels from ONE masked serialization
// (`packages/mcp/src/masked-result.ts`), which is also why they can no longer disagree.
//
// OBSERVED REDS — 2026-08-16, from the phase's credential mutation driver (since removed):
//
//   C1 (1) the success path stops masking       → (B1b) `the text channel carried the plant`
//   C2 (1) THE SHIPPED DEFECT restored — the    → (B1b) `structuredContent carried the plant — the
//          object channel parsed from the             machine channel a person never reads`
//          UNMASKED document
//   C3 (2) the error path stops masking         → (B1), (C1)
//   C4 (1) the apply refusal's teach unmasked   → (D1)
//   C5 (3) declared credentials stop reaching   → (A2) `the declared-token arm did not seed the
//          the masker; environment arm intact          masker`, (B1), (D1) — and the environment
//                                                      arm's cells GREEN in the same run
//
// C5's cross-arm green was measured while an environment seed arm still existed; 441-07 and 441-18
// deleted that arm and the config-write group it carried.
//
// That driver's neutered self-test (since removed) exited 1 with
// `C1: the suite stayed green under the mutation`, which is what proved the harness could fail.

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

// 2026-10-14 (441-07, D-01): the masker reads only the secrets file, where the three plants below
// are declared. 441-18 (D-15): the environment plants that fed the construction scan's seed arm,
// and the credential-shaped config plant its pattern arm caught, are deleted with the scan.
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

/** Declared to nothing and shaped like nothing. The hostile control's value (F1). */
const UNSEEDED_PLANT = 'hzp5r8u2i7o4a9e6k3m1v8'

/** Opaque, under a credential-NAMED key the shipped census does not enumerate. The bound (F2). */
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

/**
 * The first eight-character window of `plant` that occurs in `haystack`, or `undefined`.
 *
 * WINDOWED, not whole-string. A mask that disclosed a prefix, a suffix, or any run of eight
 * characters would satisfy a whole-string check and would still be a disclosure. This helper is
 * also the one the hostile control (F1) requires to FIND something, which is what proves the cells
 * that require `undefined` are capable of failing.
 */
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
      // 432-21 (D-12): the one tokenless caller; no stdio grant exists to resolve.
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

    // 2026-10-14 (441-07, D-01): a value only the environment holds, under a credential-named
    // variable, is not a declared secret and is not hidden.
    process.env['AGENT_QA_441_07_ENV_ONLY_TOKEN'] = UNSEEDED_PLANT
    try {
      expect(masking!.mask(UNSEEDED_PLANT), 'an environment-only value was masked')
        .toBe(UNSEEDED_PLANT)
    } finally {
      delete process.env['AGENT_QA_441_07_ENV_ONLY_TOKEN']
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
      // 432-12: `agent_qa_show_proposal` left with the proposal round. The record read's not-found
      // arm echoes the caller's own id on its success channel, which is the same claim.
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
      // NAMED RATHER THAN ASSUMED. The SDK validates a call against the advertised `inputSchema`
      // and composes the refusal ITSELF, before any handler runs — so `maskText` is not on this
      // path and could not be. Measured on 2.0.0 (2026-08-16): the message names the field and the
      // rule and never quotes the rejected value. This cell reds the day that changes, which is the
      // only way a channel outside our masker can be watched at all.
      // 432-12: the proposal read is gone; a MEM short-ID refinement on the knowledge change tool is
      // the SDK-validated input that now refuses the plant, before any handler or writer runs.
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
  // 2026-09-30, 432-12 (D-05/D-13): the apply refusal payload is gone with the apply tools. The
  // payload that now carries caller-supplied content back is the change tool's own answer: a typed
  // absence echoes the target it was asked about, through the one masked serialization.
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

// 2026-10-14 (441-18, D-15): group E (the config-write construction scan) is deleted with the scan.
// A config change is not scanned; a declared value in its diff reaches the wire as its marker
// (C441-MCP-DIFF below).

describe('F · the controls, and the bound they measure', () => {
  it('HOSTILE CONTROL: an UNSEEDED value travels the same channel verbatim, and the helper '
    + 'finds it', async () => {
    await headless(async () => {
      const answer = await call('agent_qa_get_run_digest', { runId: UNSEEDED_PLANT })

      // The whole point. If this cell did not find the value, every `toBeUndefined()` above would
      // be an assertion over a dead channel — which is how an absence corpus passes while a
      // credential leaks (T-395-R5-10's own shape).
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

      // WRITTEN AS IT IS, NOT AS IT SHOULD BE. The change is written (432-11: in the call); the
      // diff's context lines
      // carry a neighbouring `providerHeaders.X-Client-Auth` value; and the value is neither
      // seeded, nor credential-shaped, nor under a key the shipped census enumerates — so nothing
      // on this road recognises it.
      expect(outcome.outcome, rendered(answer)).toBe('applied')
      expect(leakedWindow(outcome.shownDiff ?? '', OPAQUE_HEADER_PLANT), 'the bound closed — '
        + 'update this cell and the ledger, and tell 397').toBeDefined()

      // AND WHAT BOUNDS THE BOUND: a value declared in the secrets file reaches the wire as its
      // marker (C441-MCP-DIFF). This one is not declared, so it is not masked.
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
    // 2026-10-14 (441-07, D-24): the plant needs no YAML quoting; D-03 masks raw values only.
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

      // And the response is not wholesale opaque — v1's (P2) last assertion, re-derived.
      expect(JSON.stringify(outcome).length).toBeGreaterThan(200)
    })
  })
})
