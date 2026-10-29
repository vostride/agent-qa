// `init --agent`: the machine entry point.
//
// WHAT AN EXTERNAL AGENT GETS FROM ONE READ. Every capability this product has, in the words a
// person reads, and whether THIS workspace has a configuration that reads. Local, non-interactive,
// idempotent: it opens no prompt, writes no file and reaches no network.
//
// THE MANIFEST IS A LOAD, NOT A DERIVATION, and that is the whole of why SC-1's "the same manifest"
// clause is a measurement rather than a promise. `loadCapabilityCatalog()` reads the committed
// bytes; the rows cross into the output VERBATIM. There is no second recipe here that could be
// improved out of agreement with the artifact, which is why `manifest ≡ catalog` can be a suite
// cell at all.
//
// UNFILTERED BY DESIGN (D-16, prohibition P1). Every row is emitted, for every caller,
// with no scope filter applied anywhere below. 2026-10-01 (432-20/432-21, D-12): there is no
// per-caller filter anywhere else either — the MCP `tools/list` visibility law is deleted, so every
// caller lists and calls what this manifest lists. The emitted `$note` says so in the document
// itself, so a reader who never opens this source still learns it.
//
// NO SECRET PATH, STRUCTURALLY. 2026-10-01 (432-21/432-22, D-12): the posture
// no longer reports declared MCP credentials at all — `services.mcp.tokens` is a deleted config key
// (a file declaring it does not resolve), and the resolver that once turned a declared name into a
// credential is deleted. 2026-10-02: the posture's `tokenEnvRefs`, `defaultScopes`
// and `safeMode` members are deleted, so the posture carries only `configuration`. The
// sentinel-absence cell in `conformance/manifest.test.ts` keeps that true as the file changes.

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import type { AgentManifest, AgentManifestPosture } from '@vostride/agent-qa-schema'

import { WRITE_AGENT_INSTRUCTIONS_FLAG } from '../commands/knowledge-guide.js'
import { resolveConfig } from '../config.js'
import { loadCapabilityCatalog } from './loader.js'

/**
 * What the manifest says about itself, appended to the catalog's own note.
 *
 * IN THE DOCUMENT AND NOT ONLY IN THIS SOURCE, deliberately. The reader this file exists for is an
 * agent that will never open a `.ts` file; a warning it cannot see is a warning aimed at the wrong
 * person. The catalog's note already carries the describes-does-not-gate law for the rows; these two
 * lines carry it for the manifest as a whole, including the posture.
 */
export const AGENT_MANIFEST_NOTE: readonly string[] = Object.freeze([
  'THIS MANIFEST IS UNFILTERED (2026-08-17, D-16; re-spelled 2026-10-02, 432-42). Every capability',
  'is listed for every reader.',
  'Since 2026-10-01 (432 D-12) there are no permissions: every caller on every door may see and',
  'call every capability listed here, MCP included, with no token. The posture reports only',
  'whether this workspace has a configuration that reads; it names no scope and no token.',
])

/** One dedicated CLI read verb: its Commander path, its long flags and the ops it invokes. */
export interface DedicatedReadVerb {
  readonly verb: string
  readonly flags: readonly string[]
  readonly opIds: readonly string[]
}

/**
 * The dedicated read verbs, each a thin client over the ops the manifest's rows
 * describe. They stay off the four-door surface roster: `fn` is the roster's CLI
 * door, and these verbs own no capability of their own.
 */
export const DEDICATED_READ_VERBS: readonly DedicatedReadVerb[] = Object.freeze([
  { verb: 'runs list', flags: ['--verdict', '--test', '--target', '--since', '--limit', '--json'], opIds: ['runs.list'] },
  { verb: 'runs overview', flags: ['--json'], opIds: ['runs.overview'] },
  { verb: 'runs knowledge', flags: ['--json'], opIds: ['runs.knowledge'] },
  {
    verb: 'runs evidence',
    flags: ['--test', '--step', '--sub-action', '--kind', '--screenshot', '--out', '--range-start', '--range-end', '--json'],
    opIds: ['runs.evidence', 'runs.artifact'],
  },
  { verb: 'knowledge show', flags: ['--json'], opIds: ['knowledge.record.show'] },
  { verb: 'knowledge brief-why', flags: ['--step', '--test', '--record', '--json'], opIds: ['knowledge.brief.why'] },
].map((entry) => Object.freeze({ ...entry, flags: Object.freeze(entry.flags), opIds: Object.freeze(entry.opIds) })))

/** `init`'s opt-in that writes the root pointer block into AGENTS.md. */
export const INIT_AGENT_INSTRUCTIONS_VERB: { readonly verb: 'init', readonly flags: readonly string[] } =
  Object.freeze({ verb: 'init', flags: Object.freeze([WRITE_AGENT_INSTRUCTIONS_FLAG]) })

/** What `buildAgentManifest` needs from the outside: a config path, or nothing. */
export interface AgentManifestInput {
  /** Where this workspace's configuration lives. Defaults to the conventional file under `cwd`. */
  readonly configPath?: string
}

// `tokenEnvRefsOf` is deleted. It projected `services.mcp.tokens` onto
// names for the posture, and that key is no longer read by anything.

/**
 * The whole manifest: the committed catalog, the projected map, and this workspace's posture.
 *
 * TOLERANT OF A MISSING OR BROKEN CONFIGURATION, AND SAYS WHICH OF THE TWO. `init --agent` is the
 * command an agent runs in a directory that is not a project yet — that is what `init` is for — so
 * neither state is an error here. They are told apart by whether the FILE EXISTS, which is a fact
 * about the filesystem rather than a fact read out of an exception message: `absent` means run
 * `init`, `unresolved` means fix the file, and reporting either as `resolved` would say "this
 * workspace is fine" about a workspace nobody could read.
 *
 * NOT TOLERANT OF A MISSING CATALOG. A broken install throws {@link
 * CapabilityCatalogUnavailableError} with the regen instruction, because the alternative — an empty
 * manifest — presents a broken install as a product that can do nothing, which is the one failure
 * mode this artifact's loader was written to refuse.
 */
export async function buildAgentManifest(
  input: AgentManifestInput = {},
): Promise<AgentManifest> {
  const catalog = loadCapabilityCatalog()

  const configPath = resolve(input.configPath ?? 'agent-qa.config.yaml')
  // The two failing arms are told apart BEFORE the read, by whether the file is there. Deciding it
  // afterwards would mean reading the failure's message to classify it, and a message is exactly
  // what must not travel here.
  let configuration: AgentManifestPosture['configuration'] =
    existsSync(configPath) ? 'unresolved' : 'absent'
  if (configuration === 'unresolved') {
    try {
      // `loadAuthPlugins: false` keeps the read a read: resolving a posture must not load and
      // execute plugin code, on the reasoning `createConfigReader` already states next door.
      await resolveConfig({ configPath, loadAuthPlugins: false })
      configuration = 'resolved'
    } catch {
      // The reason is deliberately NOT carried into the manifest — see the doc comment above.
      configuration = 'unresolved'
    }
  }

  return {
    $note: [...catalog.$note, ...AGENT_MANIFEST_NOTE],
    // VERBATIM. No filter, no re-sort, no re-shape — see this file's header.
    rows: catalog.rows,
    posture: {
      // no `defaultScopes`, `safeMode` or `tokenEnvRefs`. Each reported a
      // constant since 432-20/21 (every scope name, `false`, empty) and leaves with the permission
      // metadata it described.
      configuration,
    },
  }
}
