/**
 * THE APPROVAL AND PERMISSION DELETION CENSUS (Phase 432, PXH-SAFE-01..05; D-01..D-22).
 *
 * WHAT THIS PROVES. Phase 432 deleted every y/n question and every permission: the terminal and
 * chat prompts, the maintenance confirmations, the dashboard's run-confirm routes and dialogs, the
 * execution gate with its ask ladder and confirm ports, standing grants and their ledger, protected
 * classes, the proposal inbox with its ops, tools, envelope, store and CLI, the human-origin rule,
 * the capability scopes and every caller field they rode on, MCP and run-service tokens, the stdio
 * config-write switch, the trust flag and key, the fail-closed rule, the chat pin overlay, gate
 * remedies and their renderers, the unused command patterns, the execution-audit writer and the
 * product's own git commits. A green suite proves what IS there; nothing in it fails when one of
 * those comes back. So each removed member has a cell here, named in advance by the phase's mutation
 * map (`C432-RETURN-A01` … `C432-RETURN-A78`), that REDs on that member's return.
 *
 * REGION-SCOPED, AND COMMENTS DO NOT COUNT. Unlike the 430 census, these cells read CODE: every
 * scanned file is passed through a small lexer that blanks comments and keeps strings, template
 * literals and regex literals. The phase's own rule makes that necessary rather than convenient:
 * dated-history notes ("2026-10-01 (432-19): `resolveAsk` is deleted") are written beside the code
 * they explain and are never rewritten, so a raw-text census would accuse every retirement note. A
 * returning member is code — a declaration, an export, a registered id, a route string, a prompt
 * literal — and code is what each cell scans, in the region its member lived in (one file, or one
 * package's production source by the 412 path rule), never the whole tree by default.
 *
 * PUBLIC CONFIG AND COMMANDER RETURNS ARE OBSERVED, NOT GREPPED (mutation map, A59/A61/A63/A64/A65).
 * The four removed config keys are parsed through the REBUILT public `AgentQaConfigSchema`
 * (`packages/core/dist/index.js`) in an isolated Node process: a retained control config parses,
 * and the same config plus the removed member is refused with the strict unrecognized-key result.
 * The trust flag is asked of the REBUILT binary (`packages/cli/dist/cli.js run --help`); tsup
 * bundles the CLI and emits no per-command module, so the binary's own help for the registered
 * `run` command is the observable return. Turbo orders this package's tests after both builds.
 *
 * SPLIT NEEDLES. Every needle is assembled at run time from two halves, so this file never spells
 * what it forbids; the SELF-MATCH cell asserts that over this file's own bytes.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const PACKAGES = new URL('../../../', import.meta.url)
const PACKAGES_DIR = fileURLToPath(PACKAGES)
const THIS_FILE = fileURLToPath(import.meta.url)

// ---------------------------------------------------------------------------------------------
// The lexer: comments out, everything else in
// ---------------------------------------------------------------------------------------------

/** True when a `/` at this point starts a regex literal rather than a division. */
function regexAllowed(out: string): boolean {
  let k = out.length - 1
  while (k >= 0 && /\s/.test(out[k]!)) k--
  if (k < 0) return true
  if ('(,=:[!&|?{};+-*%<>~^'.includes(out[k]!)) return true
  const word = /([A-Za-z_$][\w$]*)$/.exec(out.slice(0, k + 1))
  return word !== null
    && ['return', 'typeof', 'case', 'yield', 'await', 'in', 'of', 'void', 'delete'].includes(word[1]!)
}

/**
 * The source with every comment blanked (newlines kept, so line numbers survive) and every string,
 * template and regex literal kept verbatim. A prompt is a string; a retirement note is a comment.
 */
export function codeOf(text: string): string {
  let out = ''
  let i = 0
  const n = text.length
  const templateDepths: number[] = []
  let depth = 0
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code'
  while (i < n) {
    const c = text[i]!
    const d = text[i + 1]
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; out += '  '; i += 2; continue }
      if (c === '/' && d === '*') { state = 'block'; out += '  '; i += 2; continue }
      if (c === '/' && regexAllowed(out)) {
        let j = i + 1
        let inClass = false
        while (j < n && text[j] !== '\n') {
          const ch = text[j]
          if (ch === '\\') { j += 2; continue }
          if (ch === '[') inClass = true
          else if (ch === ']') inClass = false
          else if (ch === '/' && !inClass) break
          j++
        }
        if (j < n && text[j] === '/') {
          j++
          while (j < n && /[a-z]/i.test(text[j]!)) j++
          out += text.slice(i, j)
          i = j
          continue
        }
      }
      if (c === "'") { state = 'single'; out += c; i++; continue }
      if (c === '"') { state = 'double'; out += c; i++; continue }
      if (c === '`') { state = 'template'; out += c; i++; continue }
      if (c === '{') { depth++; out += c; i++; continue }
      if (c === '}') {
        if (templateDepths.length > 0 && templateDepths[templateDepths.length - 1] === depth) {
          templateDepths.pop()
          depth--
          state = 'template'
          out += c
          i++
          continue
        }
        depth--
        out += c
        i++
        continue
      }
      out += c
      i++
      continue
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c } else out += ' '
      i++
      continue
    }
    if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; out += '  '; i += 2; continue }
      out += c === '\n' ? '\n' : ' '
      i++
      continue
    }
    if (state === 'single' || state === 'double') {
      const quote = state === 'single' ? "'" : '"'
      if (c === '\\') { out += c + (d ?? ''); i += 2; continue }
      if (c === quote || c === '\n') state = 'code'
      out += c
      i++
      continue
    }
    if (c === '\\') { out += c + (d ?? ''); i += 2; continue }
    if (c === '`') { state = 'code'; out += c; i++; continue }
    if (c === '$' && d === '{') { depth++; templateDepths.push(depth); state = 'code'; out += '${'; i += 2; continue }
    out += c
    i++
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// The universes: production source by the 412 path rule, never a hand list
// ---------------------------------------------------------------------------------------------

/** Every `.ts`/`.tsx` under a root (relative to `packages/`), as paths relative to `packages/`. */
function listTree(root: string): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    if (!existsSync(join(PACKAGES_DIR, dir))) return
    for (const entry of readdirSync(join(PACKAGES_DIR, dir), { withFileTypes: true })) {
      const child = `${dir}${entry.name}`
      if (entry.isDirectory()) walk(`${child}/`)
      else if (/\.tsx?$/.test(entry.name)) files.push(child)
    }
  }
  walk(root)
  return files.sort()
}

const isProduction = (file: string): boolean =>
  !file.includes('/__tests__/') && !/\.test(-d)?\.tsx?$/.test(file)

/** A region entry is a file, or a directory (trailing `/`) whose production files are scanned. */
function filesOf(region: string): string[] {
  if (region.endsWith('/')) return listTree(region).filter(isProduction)
  return existsSync(join(PACKAGES_DIR, region)) ? [region] : []
}

const codeCache = new Map<string, string>()
function code(file: string): string {
  let cached = codeCache.get(file)
  if (cached === undefined) {
    cached = codeOf(readFileSync(join(PACKAGES_DIR, file), 'utf8'))
    codeCache.set(file, cached)
  }
  return cached
}

/** Every code line of every file in the regions that carries the needle, as `file:line: text`. */
function hitsIn(regions: readonly string[], needle: string): string[] {
  return regions.flatMap(filesOf).flatMap((file) =>
    code(file).split('\n').flatMap((text, index) =>
      text.includes(needle) ? [`${file}:${index + 1}: ${text.trim().slice(0, 160)}`] : []))
}

function regexHitsIn(regions: readonly string[], pattern: RegExp): string[] {
  return regions.flatMap(filesOf).flatMap((file) =>
    code(file).split('\n').flatMap((text, index) =>
      pattern.test(text) ? [`${file}:${index + 1}: ${text.trim().slice(0, 160)}`] : []))
}

// ---------------------------------------------------------------------------------------------
// The inventory: one leg per removed member (432-MUTATION-MAP.md, rows A01..A78)
// ---------------------------------------------------------------------------------------------

type Halves = readonly [string, string]
const joined = (halves: Halves): string => halves[0] + halves[1]

interface ReturnLeg {
  /** The mutation-map row; the cell is named `C432-RETURN-<leg>`. */
  readonly leg: string
  readonly subject: string
  /** Module files the member lived in; a restored module REDs by existing. */
  readonly absentFiles?: readonly string[]
  /** Region(s) and needle(s): no code line in the region may carry any needle. */
  readonly regions?: readonly string[]
  readonly needles?: readonly Halves[]
  /** A region-scoped declaration shape, as two halves of a RegExp source. */
  readonly pattern?: Halves
  /** A runtime observation the cell also asserts (public config parse or Commander help). */
  readonly runtime?: 'mcp-tokens' | 'run-service-tokens' | 'stdio-config-write' | 'trust-mode' | 'trust-flag'
}

const CLI_HOST = 'cli/src/composition/local-agent-host.ts'
const CHAT = 'cli/src/commands/chat.ts'
const MAINTAIN = 'cli/src/commands/knowledge-maintain.ts'
const CACHE = 'cli/src/commands/cache.ts'
const SERVER = 'dashboard-server/src/'
const DOOR = 'cli/src/commands/dashboard.ts'
const UI = 'dashboard-ui/src/'
const SAFETY = 'safety/src/'
const SAFETY_LOCAL = 'safety-local/src/'
const AGENT = 'agent/src/'
const AGENT_LOCAL = 'agent-local/src/'
const KNOWLEDGE = 'knowledge-local/src/'
const SCHEMA = 'schema/src/'
const SCHEMA_FUNCTIONS = 'schema/src/functions/'
const CALLER = 'schema/src/functions/function-caller.ts'
const SPEC = 'agent/src/functions/spec.ts'
const REGISTRY = 'agent/src/functions/registry.ts'
const MAPPING = 'mcp/src/mapping.ts'
const CATALOG = 'mcp/src/catalog.ts'
const SERVICES = 'core/src/schema/services-schema.ts'
const CONFIG_SCHEMA = 'core/src/schema/config-schema.ts'
const SCOPE_MODULE = 'schema/src/functions/function-scope.ts'
const REMEDY_MODULE = 'schema/src/safety/remedies.ts'
const PROTECTED_MODULE = 'schema/src/safety/protected-classes.ts'

/** A literal of the deleted scope union inside a restored `FunctionScope…` enum declaration. */
const scopeLiteral = (literal: string): Halves => [
  "FunctionScope\\w*\\s*=\\s*z\\.enum\\(\\[[^\\]]*'",
  `${literal}'`,
]

const RETURN_LEGS: readonly ReturnLeg[] = [
  {
    leg: 'A01', subject: 'the terminal y/N approval prompt', regions: [CLI_HOST],
    needles: [['[y/', 'N]'], ['needs your ', 'approval'], ['.quest', 'ion('], ['createInter', 'face']],
  },
  {
    leg: 'A02', subject: 'the chat two-answer approval prompt', regions: [CHAT],
    needles: [['[y/', 'N]'], ['(y/', 'N)'], ['needs your ', 'approval'], ['Proceed', '?']],
  },
  {
    leg: 'A03', subject: 'the chat always-answer branch', regions: [CHAT],
    needles: [['[y/a', '/N]'], ["'alw", "ays'"]],
  },
  {
    leg: 'A04', subject: 'the knowledge rollback confirmation', regions: [MAINTAIN],
    needles: [['Apply this ', 'rollback'], ['(y/', 'N)'], ['.quest', 'ion('], ['createInter', 'face'], ["'--y", "es'"],
      ['confirmation-', 'required']],
  },
  {
    leg: 'A05', subject: 'the cache purge confirmation', regions: [CACHE],
    needles: [['Continue? (y/', 'N)'], ['(y/', 'N)'], ['createInter', 'face'], ['.quest', 'ion('], ["'--for", "ce'"]],
  },
  {
    leg: 'A06', subject: 'the knowledge purge repeated-id confirmation', regions: [MAINTAIN],
    needles: [["'--conf", 'irm'], ['to confirm irreversible ', 'purge'], ['confirmation-', 'mismatch'],
      ['confirmation-', 'required']],
  },
  {
    leg: 'A07', subject: 'the GET run-confirm channel route', regions: [SERVER, DOOR, SCHEMA],
    needles: [['/api/run-confirm/', 'channel'], ['RUN_CONFIRM_CHANNEL', '_ROUTE']],
  },
  {
    leg: 'A08', subject: 'the POST run-confirm answer route', regions: [SERVER, DOOR, SCHEMA],
    needles: [['/api/run-confirm/', 'answer'], ['RUN_CONFIRM_ANSWER', '_ROUTE']],
  },
  {
    leg: 'A09', subject: 'the dashboard run-confirm dialog',
    absentFiles: ['dashboard-ui/src/components/run-confirm-dialog.tsx'], regions: [UI],
    needles: [['RunConfirm', 'Dialog'], ['run-confirm-', 'dialog']],
  },
  {
    leg: 'A10', subject: 'the dashboard mark approval',
    absentFiles: ['dashboard-ui/src/components/run-detail/feedback-approval.tsx'], regions: [UI],
    needles: [['Feedback', 'Approval'], ['feedback-', 'approval']],
  },
  {
    leg: 'A11', subject: 'the confirm registry', absentFiles: ['dashboard-server/src/chat/confirm-registry.ts'],
    regions: [SERVER, 'cli/src/'], needles: [['Confirm', 'Registry'], ['confirm-', 'registry']],
  },
  { leg: 'A12', subject: 'resolveAsk', regions: [SAFETY], needles: [['resolve', 'Ask']] },
  {
    leg: 'A13', subject: 'the execution-policy evaluate export', regions: [SAFETY],
    pattern: ['\\b(function|const|let)\\s+evaluate\\b|export\\s*\\{[^}]*\\bevalu', 'ate\\b'],
    needles: [['ExecutionPolicy', 'Outcome'], ['ExecutionPolicy', 'Result']],
  },
  {
    leg: 'A14', subject: 'the baseVerdict ask ladder', regions: [SAFETY],
    needles: [['base', 'Verdict'], ["'a", "sk'"], ['Gate', 'Trust']],
  },
  {
    leg: 'A15', subject: 'the execution gate hook', absentFiles: ['safety/src/policy/gate-hook.ts'], regions: [SAFETY],
    needles: [['createPolicyGate', 'ToolCallHook'], ['PolicyGate', 'HookDeps'], ['gate-', 'hook']],
  },
  { leg: 'A16', subject: 'ConfirmPort', regions: [SAFETY], needles: [['Confirm', 'Port']] },
  {
    leg: 'A17', subject: 'the readline confirmation', absentFiles: ['safety-local/src/readline-confirm.ts'],
    regions: [SAFETY_LOCAL], needles: [['createReadline', 'Confirm'], ['node:read', 'line'], ['readline-', 'confirm']],
  },
  { leg: 'A18', subject: 'grants.list', regions: [AGENT], needles: [["'grants.", "list'"]] },
  { leg: 'A19', subject: 'grants.revoke', regions: [AGENT], needles: [["'grants.", "revoke'"]] },
  {
    leg: 'A20', subject: 'the grant ledger writer', absentFiles: ['knowledge-local/src/grants/ledger.ts'],
    regions: [KNOWLEDGE, 'cli/src/commands/init-filesystem.ts'],
    needles: [['grants', '.jsonl'], ['appendGrant', 'LedgerEvents'], ['GRANT_LEDGER', '_FILENAME']],
  },
  {
    leg: 'A21', subject: 'the grant ledger reader', absentFiles: ['knowledge-local/src/grants/reader.ts'],
    regions: [KNOWLEDGE],
    needles: [['createStandingApproval', 'Reader'], ['readGrant', 'Ledger'], ['foldActive', 'Grants']],
  },
  {
    leg: 'A22', subject: 'the standing approval contract', absentFiles: ['schema/src/safety/standing-approval.ts'],
    regions: [SCHEMA, SAFETY], needles: [['StandingApproval', 'Grant']],
  },
  {
    leg: 'A23', subject: 'the protected proposals class', absentFiles: [PROTECTED_MODULE], regions: [SCHEMA],
    needles: [['fn:proposals.', 'accept'], ['PROTECTED_ACTION', '_CLASSES']],
  },
  {
    leg: 'A24', subject: 'the protected grants class', absentFiles: [PROTECTED_MODULE], regions: [SCHEMA],
    needles: [['fn:grants.', 'revoke'], ['PROTECTED_ACTION', '_CLASSES']],
  },
  { leg: 'A25', subject: 'proposals.list', regions: [AGENT], needles: [["'proposals.", "list'"]] },
  { leg: 'A26', subject: 'proposals.show', regions: [AGENT], needles: [["'proposals.", "show'"]] },
  { leg: 'A27', subject: 'proposals.accept', regions: [AGENT], needles: [["'proposals.", "accept'"]] },
  { leg: 'A28', subject: 'proposals.reject', regions: [AGENT], needles: [["'proposals.", "reject'"]] },
  { leg: 'A29', subject: 'knowledge.proposal.apply', regions: [AGENT], needles: [["'knowledge.proposal.", "apply'"]] },
  { leg: 'A30', subject: 'config.proposal.apply', regions: [AGENT], needles: [["'config.proposal.", "apply'"]] },
  { leg: 'A31', subject: 'config.undo.propose', regions: [AGENT], needles: [["'config.undo.", "propose'"]] },
  { leg: 'A32', subject: 'knowledge.accept.propose', regions: [AGENT], needles: [["'knowledge.accept.", "propose'"]] },
  { leg: 'A33', subject: 'knowledge.reject.propose', regions: [AGENT], needles: [["'knowledge.reject.", "propose'"]] },
  { leg: 'A34', subject: 'knowledge.forget.propose', regions: [AGENT], needles: [["'knowledge.forget.", "propose'"]] },
  {
    leg: 'A35', subject: 'the propose-knowledge-change tool', regions: [MAPPING, CATALOG],
    needles: [['agent_qa_propose_', 'knowledge_change']],
  },
  { leg: 'A36', subject: 'the apply-proposal tool', regions: [MAPPING, CATALOG], needles: [['agent_qa_apply_', 'proposal']] },
  {
    leg: 'A37', subject: 'the propose-config-change tool', regions: [MAPPING, CATALOG],
    needles: [['agent_qa_propose_', 'config_change']],
  },
  {
    leg: 'A38', subject: 'the apply-config-proposal tool', regions: [MAPPING, CATALOG],
    needles: [['agent_qa_apply_', 'config_proposal']],
  },
  { leg: 'A39', subject: 'the list-proposals tool', regions: [MAPPING, CATALOG], needles: [['agent_qa_list_', 'proposals']] },
  { leg: 'A40', subject: 'the show-proposal tool', regions: [MAPPING, CATALOG], needles: [['agent_qa_show_', 'proposal']] },
  {
    leg: 'A41', subject: 'the proposal envelope', absentFiles: ['schema/src/proposal/envelope.ts'], regions: [SCHEMA],
    needles: [['Proposal', 'Envelope'], ['PROPOSAL_', 'KINDS']],
  },
  {
    leg: 'A42', subject: 'the proposal store', absentFiles: ['knowledge-local/src/review/proposals-store.ts'],
    regions: [KNOWLEDGE], needles: [['writePending', 'Proposal'], ['claimPending', 'Proposal'], ['proposals-', 'store']],
  },
  {
    leg: 'A43', subject: 'the proposal inbox reader', absentFiles: ['knowledge-local/src/review/proposals-inbox.ts'],
    regions: [KNOWLEDGE],
    needles: [['createProposals', 'Inbox'], ['proposals-', 'inbox'], ['ProposalsInbox', 'Options']],
  },
  {
    leg: 'A44', subject: 'the proposals CLI', absentFiles: ['cli/src/commands/proposals.ts'], regions: ['cli/src/'],
    needles: [['createProposals', 'Command'], [".command('pro", "posals"], ['commands/pro', 'posals']],
  },
  {
    leg: 'A45', subject: 'requiresHumanOrigin', regions: [SPEC, REGISTRY, 'agent/src/functions/invoke.ts'],
    needles: [['requiresHuman', 'Origin']],
  },
  {
    leg: 'A46', subject: 'FunctionScope', absentFiles: [SCOPE_MODULE], regions: [SCHEMA],
    needles: [['FunctionScope', 'Schema'], ['type FunctionScope', ' ='], ['function-', 'scope']],
  },
  { leg: 'A47', subject: 'the capability member read', absentFiles: [SCOPE_MODULE], regions: [SCHEMA_FUNCTIONS], pattern: scopeLiteral('read') },
  { leg: 'A48', subject: 'the capability member run', absentFiles: [SCOPE_MODULE], regions: [SCHEMA_FUNCTIONS], pattern: scopeLiteral('run') },
  {
    leg: 'A49', subject: 'the capability member config-write', absentFiles: [SCOPE_MODULE], regions: [SCHEMA_FUNCTIONS],
    pattern: scopeLiteral('config-write'),
  },
  {
    leg: 'A50', subject: 'the capability member knowledge-write', absentFiles: [SCOPE_MODULE], regions: [SCHEMA_FUNCTIONS],
    pattern: scopeLiteral('knowledge-write'),
  },
  {
    leg: 'A51', subject: 'the capability member approval-write', absentFiles: [SCOPE_MODULE], regions: [SCHEMA_FUNCTIONS],
    pattern: scopeLiteral('approval-write'),
  },
  {
    leg: 'A52', subject: 'the capability member test-write', absentFiles: [SCOPE_MODULE], regions: [SCHEMA_FUNCTIONS],
    pattern: scopeLiteral('test-write'),
  },
  { leg: 'A53', subject: 'requiredScopes metadata', regions: [SPEC, REGISTRY], needles: [['required', 'Scopes']] },
  { leg: 'A54', subject: 'the grantedScopes caller key', regions: [CALLER], needles: [['granted', 'Scopes']] },
  { leg: 'A55', subject: 'the safeMode caller key', regions: [CALLER], needles: [['safe', 'Mode']] },
  { leg: 'A56', subject: 'the credential caller key', regions: [CALLER], needles: [['creden', 'tial']] },
  { leg: 'A57', subject: 'the sessionId overlay caller key', regions: [CALLER], needles: [['session', 'Id']] },
  {
    leg: 'A58', subject: 'MCP permission visibility', absentFiles: ['mcp/src/visibility.ts'], regions: ['mcp/src/'],
    needles: [['visibleTo', 'Caller']],
  },
  {
    leg: 'A59', subject: 'services.mcp.tokens', runtime: 'mcp-tokens',
    regions: [SERVICES, 'schema/src/config/', 'schema/src/index.ts'],
    needles: [['McpToken', 'Entry'], ['tokens', ':']],
  },
  {
    leg: 'A60', subject: 'the MCP bearer check', regions: ['cli/src/commands/mcp.ts'],
    needles: [['Bear', 'er'], ['authoriz', 'ation'], ['WWW-Authen', 'ticate'], ['40', '1']],
  },
  {
    leg: 'A61', subject: 'services.dashboard.runServiceTokens', runtime: 'run-service-tokens',
    regions: [SERVICES, 'schema/src/config/', 'schema/src/index.ts'],
    needles: [['runService', 'Tokens'], ['RunServiceToken', 'Entry']],
  },
  {
    leg: 'A62', subject: 'the run-service bearer check', regions: ['dashboard-server/src/run-service/run-service-routes.ts'],
    needles: [['Bear', 'er'], ['authoriz', 'ation'], ['verify', 'Bearer'], ['40', '1']],
  },
  {
    leg: 'A63', subject: 'services.mcp.stdio.grantConfigWrite', runtime: 'stdio-config-write',
    regions: [SERVICES, 'schema/src/config/', 'schema/src/index.ts'],
    needles: [['grantConfig', 'Write'], ['McpStdio', 'Grant'], ['stdio', ':']],
  },
  {
    leg: 'A64', subject: 'the trust-session flag', runtime: 'trust-flag', regions: ['cli/src/commands/run.ts', 'cli/src/program.ts'],
    needles: [['--trust-', 'session'], ['trust', 'Session']],
  },
  {
    leg: 'A65', subject: 'safety.trustMode', runtime: 'trust-mode', regions: [CONFIG_SCHEMA],
    needles: [['trust', 'Mode'], ['safety', ':']],
  },
  { leg: 'A66', subject: 'the fail-closed policy', regions: [SAFETY], needles: [['requiresFail', 'Closed']] },
  {
    leg: 'A67', subject: 'the pin directive', regions: ['agent/src/chat/turn-engine.ts', 'agent/src/chat/resolver-table.ts'],
    needles: [["'/p", "in'"], ["'pi", "n'"]],
  },
  {
    leg: 'A68', subject: 'the pin overlay resolver', absentFiles: ['agent/src/chat/pin-overlay.ts'], regions: [AGENT, AGENT_LOCAL],
    needles: [['createPin', 'Overlay'], ['ChatPin', 'Error'], ['PIN_ACTION_CLASS', '_PREFIX'], ['pin-', 'overlay']],
  },
  {
    leg: 'A69', subject: 'the answer-confirm remedy', absentFiles: [REMEDY_MODULE], regions: [SCHEMA],
    needles: [["'answer-", "confirm'"]],
  },
  {
    leg: 'A70', subject: 'the trust-session-flag remedy', absentFiles: [REMEDY_MODULE], regions: [SCHEMA],
    needles: [["'trust-session", "-flag'"]],
  },
  {
    leg: 'A71', subject: 'the session-pin-final remedy', absentFiles: [REMEDY_MODULE], regions: [SCHEMA],
    needles: [["'session-pin", "-final'"]],
  },
  {
    leg: 'A72', subject: 'the present-bearer-scope remedy', absentFiles: [REMEDY_MODULE], regions: [SCHEMA],
    needles: [["'present-bearer", "-scope'"]],
  },
  {
    leg: 'A73', subject: 'the CLI remedy renderer', regions: ['cli/src/commands/receipt-line.ts'],
    needles: [['remed', ''], ['Remed', '']],
  },
  {
    leg: 'A74', subject: 'the dashboard remedy renderer', regions: ['dashboard-ui/src/components/run-detail/denial-block.tsx'],
    needles: [['remed', ''], ['Remed', '']],
  },
  {
    leg: 'A75', subject: 'the hard destructive command patterns', regions: [SAFETY],
    needles: [['HARD_DESTRUCTIVE', '_PATTERNS'], ['COMMAND_', 'PATTERNS']],
  },
  {
    leg: 'A76', subject: 'the execution audit writer', regions: [SAFETY_LOCAL],
    needles: [['appendExecution', 'Audit'], ['execution_', 'audit']],
  },
  { leg: 'A77', subject: 'ExecutionAuditRow', regions: [SAFETY], needles: [['ExecutionAudit', 'Row']] },
  {
    leg: 'A78', subject: 'the product git commit', regions: [CLI_HOST],
    needles: [["'com", "mit'"], ['"com', 'mit"'], ["'gi", "t'"], ['Agent-QA-', 'Proposal:']],
  },
]

// ---------------------------------------------------------------------------------------------
// The runtime returns: the rebuilt public parser and the rebuilt binary
// ---------------------------------------------------------------------------------------------

interface ParseVerdict {
  readonly success: boolean
  /** The parsed config still carries the member (a non-empty list, or a set switch). */
  readonly retained: boolean
  readonly unrecognized: readonly string[]
}

interface ConfigObservations {
  readonly control: ParseVerdict
  readonly ordinaryInvalid: ParseVerdict
  readonly members: Readonly<Record<'mcp-tokens' | 'run-service-tokens' | 'stdio-config-write' | 'trust-mode', ParseVerdict>>
}

const CORE_DIST = join(PACKAGES_DIR, 'core/dist/index.js')
const CLI_DIST = join(PACKAGES_DIR, 'cli/dist/cli.js')

/**
 * One isolated Node process over the REBUILT public parser. The control config is a known-valid
 * retained shape; each removed member is added to it alone. Token values are fixture labels and
 * env-var NAMES only.
 */
const PARSE_SCRIPT = `
const core = await import(process.argv[1])
const base = {
  workspace: { testMatch: ['tests/**/*.yaml'], suiteMatch: ['suites/**/*.suite.yaml'], hooksFile: 'hooks.yaml',
    envFile: '.env', secretsFile: '.env.secrets.local' },
  registry: { targets: { site: { platform: 'web', url: 'http://127.0.0.1:9/', product: 'census' } } },
  use: { timeout: { step: '30s', test: '90m', navigation: '2m' }, mobile: { appState: 'reset' } },
  services: { mcp: { enabled: true }, dashboard: { port: 4000 } },
}
const at = (value, keys) => keys.reduce((node, key) => (node === null || typeof node !== 'object' ? undefined : node[key]), value)
const verdict = (value, kept) => {
  const parsed = core.AgentQaConfigSchema.safeParse(value)
  const field = parsed.success && kept !== undefined ? at(parsed.data, kept.split('.')) : undefined
  return {
    success: parsed.success,
    retained: field !== undefined && field !== false && !(Array.isArray(field) && field.length === 0),
    unrecognized: parsed.success ? [] : parsed.error.issues
      .filter((issue) => issue.code === 'unrecognized_keys')
      .flatMap((issue) => issue.keys.map((key) => [...issue.path, key].join('.'))),
  }
}
const withServices = (patch) => ({ ...base, services: { mcp: { ...base.services.mcp, ...(patch.mcp ?? {}) },
  dashboard: { ...base.services.dashboard, ...(patch.dashboard ?? {}) } } })
process.stdout.write(JSON.stringify({
  control: verdict(base),
  ordinaryInvalid: verdict({ ...base, use: { ...base.use, timeout: { ...base.use.timeout, step: 42 } } }),
  members: {
    'mcp-tokens': verdict(withServices({ mcp: { ['tok' + 'ens']: [{ name: 'ci', tokenEnvVar: 'AGENT_QA_CENSUS_TOKEN', scopes: ['read'] }] } }),
      'services.mcp.' + 'tokens'),
    'run-service-tokens': verdict(withServices({ dashboard: { ['runService' + 'Tokens']: [{ name: 'ci', tokenEnvVar: 'AGENT_QA_CENSUS_TOKEN',
      trustScope: { project: 'census' } }] } }), 'services.dashboard.' + 'runServiceTokens'),
    'stdio-config-write': verdict(withServices({ mcp: { ['std' + 'io']: { ['grantConfig' + 'Write']: true } } }),
      'services.mcp.std' + 'io.grantConfig' + 'Write'),
    'trust-mode': verdict({ ...base, ['safe' + 'ty']: { ['trust' + 'Mode']: true } }, 'safe' + 'ty.trust' + 'Mode'),
  },
}))
`

/** The unrecognized-key path each removed member is refused at (the parent for a removed container). */
const REFUSED_AT: Readonly<Record<keyof ConfigObservations['members'], string>> = {
  'mcp-tokens': 'services.mcp.' + 'tokens',
  'run-service-tokens': 'services.dashboard.' + 'runServiceTokens',
  'stdio-config-write': 'services.mcp.' + 'stdio',
  'trust-mode': 'safe' + 'ty',
}

let config: ConfigObservations | undefined
let configFailure = ''
let runHelp = ''
let runHelpStatus: number | null = null
let helpRoot = ''

beforeAll(() => {
  const parsed = spawnSync(process.execPath, ['--input-type=module', '-e', PARSE_SCRIPT, pathToFileURL(CORE_DIST).href], {
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (parsed.status === 0) config = JSON.parse(parsed.stdout) as ConfigObservations
  else configFailure = `${parsed.status} ${parsed.stderr}`

  helpRoot = mkdtempSync(join(tmpdir(), 'agent-qa-432-42-help-'))
  writeFileSync(join(helpRoot, 'agent-qa.config.yaml'), '')
  const help = spawnSync(process.execPath, [CLI_DIST, 'run', '--help'], {
    cwd: helpRoot,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: '1', AGENT_QA_TELEMETRY: '0', DO_NOT_TRACK: '1' },
  })
  runHelp = `${help.stdout}${help.stderr}`
  runHelpStatus = help.status
}, 120_000)

afterAll(() => {
  if (helpRoot !== '') rmSync(helpRoot, { recursive: true, force: true })
})

// The named assertions a C432-RETURN cell reports, spelled once for the cells below (the phase's
// mutation driver also held each leg to one of them; driver removed 2026-10-05, quick 261005-j31).
const backMessage = (leg: ReturnLeg, file: string): string => `${leg.leg}: ${file} is back`
const returnedMessage = (leg: ReturnLeg, spelled: string): string => `${leg.leg}: ${leg.subject} returned (${spelled})`
const reshapedMessage = (leg: ReturnLeg): string => `${leg.leg}: ${leg.subject} returned:`
const acceptedMessage = (kind: keyof ConfigObservations['members']): string =>
  `the public parser accepts the removed member (${REFUSED_AT[kind]})`
const FLAG_BACK_MESSAGE = 'the run command registers the trust flag again'

function assertRuntime(kind: NonNullable<ReturnLeg['runtime']>): void {
  if (kind === 'trust-flag') {
    expect(runHelpStatus, `the rebuilt binary could not print run --help:\n${runHelp}`).toBe(0)
    // Positive control: this is the real `run` command's help, with a retained option on it.
    expect(runHelp).toContain('--reporter')
    expect(runHelp, FLAG_BACK_MESSAGE).not.toContain(joined(['--trust-', 'session']))
    return
  }
  expect(config, `the rebuilt public parser could not be loaded: ${configFailure}`).toBeDefined()
  expect(config!.control.success, 'the retained control config no longer parses').toBe(true)
  expect(config!.ordinaryInvalid.success, 'an ordinary invalid value is accepted').toBe(false)
  const member = config!.members[kind]
  // Soft, so a returned member reports both facts: the parse accepted it AND kept it (432-43's driver
  // required the acceptance line by name for A59/A61/A63/A65; driver removed 2026-10-05, quick 261005-j31).
  expect.soft(member.success, acceptedMessage(kind)).toBe(false)
  expect.soft(member.retained, `the public parser keeps the removed member (${REFUSED_AT[kind]})`).toBe(false)
  expect(member.unrecognized, 'the removed member is not refused as an unrecognized key').toContain(REFUSED_AT[kind])
}

// ---------------------------------------------------------------------------------------------
// The cells
// ---------------------------------------------------------------------------------------------

describe('C432-RETURN: every removed approval and permission member reds by name on its return', () => {
  it('UNIVERSE-FLOORS: every region reads real code, so no leg can pass over an empty scan', () => {
    // 2026-10-15 (441-44, D-15): safety-local keeps five production files once the audit sink class
    // is deleted, so its floor is four; every other region still reads more than five.
    const floorOf = (region: string): number => (region === SAFETY_LOCAL ? 4 : 5)
    for (const region of [SERVER, UI, SAFETY, SAFETY_LOCAL, AGENT, AGENT_LOCAL, KNOWLEDGE, SCHEMA, 'cli/src/', 'mcp/src/']) {
      expect(filesOf(region).length, `${region} scanned nothing`).toBeGreaterThan(floorOf(region))
    }
    for (const leg of RETURN_LEGS) {
      for (const region of leg.regions ?? []) {
        expect(filesOf(region).length, `${leg.leg}: the region ${region} does not exist`).toBeGreaterThan(0)
      }
      expect(
        (leg.needles?.length ?? 0) + (leg.pattern === undefined ? 0 : 1) + (leg.absentFiles?.length ?? 0)
          + (leg.runtime === undefined ? 0 : 1),
        `${leg.leg} asserts nothing`,
      ).toBeGreaterThan(0)
    }
    expect(RETURN_LEGS.map((leg) => leg.leg)).toEqual(
      Array.from({ length: 78 }, (_, index) => `A${String(index + 1).padStart(2, '0')}`))
  })

  // 2026-10-02 (432-43): every sub-assertion is SOFT, so a red cell reports every returned spelling at
  // once. A returning module also reds by existing, and a sibling member of the same module reds by the
  // file; the phase's mutation driver required each leg's OWN assertion among the failures, never
  // just the cell (driver removed 2026-10-05, quick 261005-j31).
  for (const leg of RETURN_LEGS) {
    it(`C432-RETURN-${leg.leg}: ${leg.subject} stays deleted`, () => {
      for (const file of leg.absentFiles ?? []) {
        expect.soft(existsSync(join(PACKAGES_DIR, file)), backMessage(leg, file)).toBe(false)
      }
      const regions = leg.regions ?? []
      for (const needle of leg.needles ?? []) {
        const hits = hitsIn(regions, joined(needle))
        expect.soft(hits, `${returnedMessage(leg, joined(needle))}:\n${hits.join('\n')}`).toEqual([])
      }
      if (leg.pattern !== undefined) {
        const hits = regexHitsIn(regions, new RegExp(joined(leg.pattern)))
        expect.soft(hits, `${reshapedMessage(leg)}\n${hits.join('\n')}`).toEqual([])
      }
      if (leg.runtime !== undefined) assertRuntime(leg.runtime)
    })
  }
})

// ---------------------------------------------------------------------------------------------
// C432-DELETED-SYMBOLS: the deleted modules and their exports, by name, across the barrels
// ---------------------------------------------------------------------------------------------

const DELETED_MODULES: readonly string[] = [
  'safety/src/policy/gate.ts',
  'safety/src/policy/gate-hook.ts',
  'safety/src/policy/scope.ts',
  'safety/src/ports/policy-ports.ts',
  'safety-local/src/readline-confirm.ts',
  'dashboard-server/src/chat/confirm-registry.ts',
  'dashboard-server/src/chat/chat-routes.ts',
  'dashboard-ui/src/components/run-confirm-dialog.tsx',
  'dashboard-ui/src/components/run-detail/feedback-approval.tsx',
  'knowledge-local/src/grants/ledger.ts',
  'knowledge-local/src/grants/reader.ts',
  'knowledge-local/src/review/proposals-store.ts',
  'knowledge-local/src/review/proposals-inbox.ts',
  'schema/src/safety/standing-approval.ts',
  'schema/src/safety/protected-classes.ts',
  'schema/src/safety/remedies.ts',
  'schema/src/safety/grant-ledger.ts',
  'schema/src/safety/grant-ops.ts',
  'schema/src/safety/trust-credential.ts',
  'schema/src/proposal/envelope.ts',
  'schema/src/functions/function-scope.ts',
  'schema/src/chat/pin-overlay.ts',
  'schema/src/config/mcp.ts',
  'schema/src/config/run-service.ts',
  'agent/src/chat/pin-overlay.ts',
  'agent-local/src/composition/dispatch-grants.ts',
  'mcp/src/visibility.ts',
  'mcp/src/apply-refusal.ts',
  'cli/src/commands/proposals.ts',
  'cli/src/composition/mcp-token-resolution.ts',
]

/** Exported names of the deleted modules, as they were spelled before Phase 432. */
const DELETED_EXPORTS: readonly Halves[] = [
  ['resolve', 'Ask'], ['base', 'Verdict'], ['Gate', 'Trust'], ['createPolicyGate', 'ToolCallHook'],
  ['Confirm', 'Port'], ['createReadline', 'Confirm'], ['createConfirm', 'Registry'], ['Confirm', 'Registry'],
  ['RUN_CONFIRM_ANSWER', '_ROUTE'], ['RUN_CONFIRM_CHANNEL', '_ROUTE'], ['RunConfirm', 'Dialog'],
  ['Feedback', 'Approval'], ['appendGrant', 'LedgerEvents'], ['readGrant', 'Ledger'],
  ['createStandingApproval', 'Reader'], ['createProposals', 'Inbox'], ['writePending', 'Proposal'],
  ['StandingApproval', 'Grant'], ['PROTECTED_ACTION', '_CLASSES'], ['GATE_REMEDY', '_KINDS'],
  ['remediesRenderable', 'By'], ['TRUST_SCOPE', '_KEYS'], ['TrustScope', 'Key'], ['Trust', 'Credential'],
  ['Proposal', 'Envelope'], ['PROPOSAL_', 'KINDS'], ['FunctionScope', 'Schema'], ['createPin', 'Overlay'],
  ['visibleTo', 'Caller'], ['createProposals', 'Command'], ['credentialFor', 'Bearer'],
  ['McpToken', 'EntrySchema'], ['RunServiceToken', 'EntrySchema'], ['McpStdio', 'GrantSchema'],
  ['appendExecution', 'Audit'], ['ExecutionAudit', 'Row'], ['requiresFail', 'Closed'],
  ['HARD_DESTRUCTIVE', '_PATTERNS'], ['MarkRefusal', 'Schema'], ['MarkDenied', 'Error'],
  ['LivePause', 'Controller'], ['createLivePause', 'Controller'],
]

/** The package entry barrels a deleted export would have to come back through. */
const BARRELS: readonly string[] = [
  'schema/src/index.ts', 'schema/src/safety/index.ts', 'schema/src/functions/index.ts', 'safety/src/index.ts',
  'safety-local/src/index.ts', 'knowledge-local/src/index.ts', 'agent/src/index.ts', 'agent-local/src/index.ts',
  'mcp/src/index.ts', 'cli/src/index.ts', 'core/src/index.ts',
]

describe('C432-DELETED-SYMBOLS: the deleted modules stay deleted and no barrel exports their names', () => {
  it('C432-DELETED-SYMBOLS: every deleted module file is absent', () => {
    const back = DELETED_MODULES.filter((file) => existsSync(join(PACKAGES_DIR, file)))
    expect(back, `deleted modules are back:\n${back.join('\n')}`).toEqual([])
  })

  it('C432-DELETED-SYMBOLS: no package barrel names a deleted export in code', () => {
    const present = BARRELS.filter((file) => existsSync(join(PACKAGES_DIR, file)))
    expect(present.length, 'the barrel census read nothing').toBeGreaterThanOrEqual(10)
    const hits = DELETED_EXPORTS.flatMap((name) => hitsIn(present, joined(name)))
    expect(hits, `a barrel exports a deleted name:\n${hits.join('\n')}`).toEqual([])
  })

  it('C432-DELETED-SYMBOLS: no production source in any package declares a deleted export in code', () => {
    const packages = readdirSync(PACKAGES_DIR).filter((name) => existsSync(join(PACKAGES_DIR, name, 'src')))
    const regions = packages.map((name) => `${name}/src/`)
    const declaration = new RegExp(
      `\\b(function|class|interface|type|const|let|enum)\\s+(${DELETED_EXPORTS.map(joined).join('|')})\\b`)
    const hits = regexHitsIn(regions, declaration)
    expect(hits, `a deleted export is declared again:\n${hits.join('\n')}`).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// C432-LEFTOVERS-UNREAD (source half): legacy state has no reader, and 432-42's leftovers are gone
// ---------------------------------------------------------------------------------------------

/** Every package's production source. */
function everyProductionRegion(): string[] {
  return readdirSync(PACKAGES_DIR)
    .filter((name) => existsSync(join(PACKAGES_DIR, name, 'src')))
    .map((name) => `${name}/src/`)
}

describe('C432-LEFTOVERS-UNREAD: no production code names a legacy file or a deleted leftover (D-22)', () => {
  // D-22: old grant-ledger, proposal-envelope and execution-audit files stay on disk untouched; a
  // reader would have to spell their names. The runtime half (seeded files never
  // opened) lives in the CLI's `432-no-git.test.ts` and `432-mcp-direct-stdio.test.ts`.
  it('C432-LEFTOVERS-UNREAD: no production code spells a legacy grant, proposal or execution-audit path', () => {
    const regions = everyProductionRegion()
    const hits = [
      ...hitsIn(regions, joined(['grants', '.jsonl'])),
      ...hitsIn(regions, joined(['execution_audit', '.jsonl'])),
      ...hitsIn(regions, joined(['execution', '_audit'])),
      ...regexHitsIn(regions, new RegExp(joined(["join\\([^)]*'propo", "sals'"]))),
    ]
    expect(hits, `a legacy file has a reader again:\n${hits.join('\n')}`).toEqual([])
  })

  // 432-42's routed leftovers, deleted here: the descriptor's command and disclosure members, the
  // always-zero pause supplier and the live-pause seam, the dashboard's typed mark denial and its
  // DTO, the per-op disclosure and its declaration flag, the inbox dep key and the scope key set.
  it.each([
    ['the descriptor command member', ['schema/src/safety/action-descriptor.ts'], ['command', '?:']],
    ['the descriptor disclosure member', ['schema/src/safety/action-descriptor.ts'], ['disclosure', '?:']],
    ['the pause supplier', ['runner/src/', 'agent-local/src/', 'cli/src/'], ['confirmPaused', 'Ms']],
    ['the live-pause seam', ['agent-local/src/', 'cli/src/'], ['pause', 'Live']],
    ['the typed mark denial body', ['dashboard-ui/src/', 'dashboard-server/src/', 'schema/src/'], ['mark_', 'denied']],
    ['the typed mark denial error', ['dashboard-ui/src/'], ['MarkDenied', 'Error']],
    ['the per-op disclosure method', ['agent/src/functions/'], ['disclose', '(input']],
    ['the declaration disclosure flag', ['agent/src/functions/'], ['disclo', 'ses:']],
    ['the inbox dep key', ['agent/src/', 'agent-local/src/', 'cli/src/', 'mcp/src/', 'dashboard-server/src/'], ['proposals', 'Inbox']],
    ['the scope key set', ['schema/src/', 'safety/src/'], ['TRUST_SCOPE', '_KEYS']],
  ] as const)('C432-LEFTOVERS-UNREAD: %s is gone from code', (_label, regions, needle) => {
    for (const region of regions) expect(filesOf(region).length, region).toBeGreaterThan(0)
    const hits = hitsIn(regions, joined(needle))
    expect(hits, `${joined(needle)} returned:\n${hits.join('\n')}`).toEqual([])
  })

  it('C432-LEFTOVERS-UNREAD: the historical approval_decision reader stays while no writer remains (D-22)', () => {
    const vocabulary = code('schema/src/chat/session-events.ts')
    expect(vocabulary, 'the session guard stopped reading old approval events').toContain(joined(["'approval", "_decision'"]))
    const writers = regexHitsIn(everyProductionRegion(), new RegExp(joined(["kind:\\s*'approval", "_decision'"])))
    expect(writers, `a writer of approval events returned:\n${writers.join('\n')}`).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// Controls: the lexer, the planted needles and this file
// ---------------------------------------------------------------------------------------------

describe('the census instruments', () => {
  it('LEXER-CONTROL: comments are blanked, strings, templates and regex literals are kept', () => {
    const sample = [
      "const a = 'kept // not a comment' // dropped",
      '/* dropped */ const b = `kept ${x ? `nested ${y}` : "q"} tail` // dropped',
      'const c = /kept\\/regex/g.test(z) /* dropped */',
      '// dropped entirely',
      '/** dropped',
      ' * dropped */ const d = "kept"',
    ].join('\n')
    const lines = codeOf(sample).split('\n')
    expect(lines).toHaveLength(6)
    expect(lines[0]).toContain("'kept // not a comment'")
    expect(lines[0]).not.toContain('dropped')
    expect(lines[1]).toContain('`kept ${x ? `nested ${y}` : "q"} tail`')
    expect(lines[1]).not.toContain('dropped')
    expect(lines[2]).toContain('/kept\\/regex/g')
    expect(lines[2]).not.toContain('dropped')
    expect(lines[3]!.trim()).toBe('')
    expect(lines[4]!.trim()).toBe('')
    expect(lines[5]).toContain('"kept"')
    expect(lines[5]).not.toContain('dropped')
  })

  it('LEXER-ENCODING (EDGE-15): CRLF line ends and UTF-8 text keep every line and every kept literal', () => {
    const prompt = joined(['[y/', 'N] ✓'])
    const sample = `const é = '${prompt}'\r\n// gone ✓\r\nconst t = \`ünïcode\`\r\n`
    const lines = codeOf(sample).split('\n')
    expect(lines).toHaveLength(4)
    expect(lines[0]).toContain(`'${prompt}'`)
    expect(lines[1]!.trim()).toBe('')
    expect(lines[2]).toContain('`ünïcode`')
  })

  it('PLANTED-POSITIVE: every needle and pattern is found when planted as code, and none when planted as a comment', () => {
    const labels = RETURN_LEGS.map((leg) => leg.leg)
    expect(new Set(labels).size).toBe(labels.length)
    for (const leg of RETURN_LEGS) {
      for (const needle of leg.needles ?? []) {
        const planted = `const planted = \`${joined(needle)}\``
        expect(codeOf(planted).includes(joined(needle)), `${leg.leg}: ${joined(needle)} as code`).toBe(true)
        expect(codeOf(`// ${joined(needle)}`).includes(joined(needle)), `${leg.leg}: ${joined(needle)} as a comment`).toBe(false)
      }
      if (leg.pattern !== undefined && leg.pattern[0].startsWith('FunctionScope')) {
        const literal = /'([^']+)'$/.exec(joined(leg.pattern))?.[1] ?? 'read'
        const restored = `export const FunctionScopeSchema = z.enum(['${literal}'])`
        expect(new RegExp(joined(leg.pattern)).test(codeOf(restored)), `${leg.leg}: the restored enum`).toBe(true)
      }
    }
    expect(new RegExp(joined(RETURN_LEGS.find((leg) => leg.leg === 'A13')!.pattern!)).test('export function evaluate(')).toBe(true)
    expect(new RegExp(joined(RETURN_LEGS.find((leg) => leg.leg === 'A13')!.pattern!)).test('page.evaluate(() => 1)')).toBe(false)
  })

  // The 430 census spelled its needles in halves because that file sat beside its universes. This
  // one is under `arch/src/__tests__/`, which no region above reaches (every region is a package's
  // production source by the 412 path rule), so it can neither satisfy nor accuse itself; what is
  // asserted is that property, over the real region lists.
  it('SELF-MATCH: this file lies outside every region it scans, so it cannot match itself', () => {
    const own = 'arch/src/__tests__/432-approval-permission-deleted.test.ts'
    expect(existsSync(join(PACKAGES_DIR, own)), 'the self path is wrong').toBe(true)
    const regions = new Set([
      ...RETURN_LEGS.flatMap((leg) => leg.regions ?? []),
      ...everyProductionRegion(),
      ...BARRELS,
    ])
    const scanned = [...regions].flatMap(filesOf)
    expect(scanned.length, 'the regions scanned nothing').toBeGreaterThan(1000)
    expect(scanned, 'this census file is inside a region it scans').not.toContain(own)
    expect(scanned.filter((file) => file.includes('/__tests__/')), 'a test file was scanned').toEqual([])
  })
})
