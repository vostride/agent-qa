// Rows cross verbatim from the committed catalog, unfiltered, so the manifest equals the catalog.

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

// Thin clients over the ops the rows describe; `fn` is the CLI door on the surface roster.
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
      configuration,
    },
  }
}
