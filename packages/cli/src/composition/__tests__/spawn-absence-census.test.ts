// NO SPAWN-BASED RUN INVOCATION, AND NO STDOUT-SCRAPE CHANNEL, ON THE RUN PATH
// (Phase 401 plan 10 — D-01, D-04, INVK-01. The retirement's companion invariant.)
//
// WHAT THIS IS FOR. D-01 says "no spawn-based run invocation survives as a second spelling". The
// three families are dead — the dashboard's `TestRunner`, the CLI host's `createCliRunExecution`,
// the daemon's piped child — and each retirement was measured by the plan that made it. What no
// plan could measure is the NEXT one: a later phase that re-mints a child because re-entering
// `agent-qa run` looks like the easy way to get a run out of a process that has none. This cell is
// what reds then.
//
// ═══ WHY THERE ARE TWO PREDICATES AND NOT ONE ════════════════════════════════════════════════
//
// 401-08 built its consumer census exactly the way this phase has been prescribing — discovery
// predicate re-derived at execution time, self-checked against its own known members — and the
// predicate silently dropped FIVE real files while every self-check stayed green. The rule it
// found, and the reason this file is shaped the way it is:
//
//     A SELF-CHECK ONLY SEES NARROWINGS THAT REACH THE MEMBERS IT NAMES.
//
// The self-check below is still here and still necessary. It is not sufficient. So the claim is
// carried by two predicates whose narrowings are not the same narrowing, and they are RECONCILED:
//
//   PREDICATE 1 — POPULATION-SCOPED AND VOCABULARY-KEYED. Over a pinned complete set of run-path
//     production modules, which modules hold child-process vocabulary at all? Answer must equal an
//     exact named allow-list. Blind spot: a run-path module the pinned set forgot to name.
//
//   PREDICATE 2 — REACHABILITY-SCOPED AND SHAPE-KEYED. Over the transitive first-party import
//     closure of the run-path roots — 800-odd modules, static AND dynamic edges — which modules
//     launch a child whose argument vector names THIS PRODUCT? Answer must equal a named survivor
//     that launches somebody else's CLI. Blind spot: an indirected argument vector.
//
//   THE RECONCILIATION is the part neither predicate can do alone. Every module the closure
//   reaches that holds the vocabulary and the pinned set never scanned is reported BY NAME. That
//   list is exactly the 401-08 failure made mechanical: if the pin is too narrow, the closure says
//   so instead of the self-check staying green. And every pinned module must be reachable, or the
//   pin is naming something off the path (or a door is missing from the roots).
//
// ═══ WHAT STAYS, AND WHY ALLOWED IS NOT UNEXAMINED ═══════════════════════════════════════════
//
// INVK-01's own scoping sentence keeps two children, and they are named here rather than pattern-
// matched: the BUNDLED APPIUM SERVER (`dashboard-server/src/execution/appium-manager.ts`) and the
// DAEMON-OWNED EMBEDDER WORKER (spawned at `cli/src/daemon/host.ts`). A census that refused these
// would be wrong about the design of record. But a name on an allow-list is not a verdict about
// behaviour, so each survivor carries a SHAPE PIN asserting what it does with the vocabulary —
// which is the part a later edit could silently change while keeping the file's name unchanged.
//
// ═══ THE SCRAPE HALF, AND THE THING THIS CENSUS FOUND ════════════════════════════════════════
//
// The READ half of `AGENT_QA_EVENT:` died with the dashboard's `TestRunner` (401-07 pinned its
// absence in that package). The WRITE half did not: `cli/src/reporters/wire-reporter.ts` and
// `core/src/logging/log-manager.ts` still print the prefix on stdout. They are ARMED BY AN
// ENVIRONMENT VARIABLE — `AGENT_QA_LIVE_EVENTS` — and the thing that used to set it was the
// dashboard child's environment, which is deleted. No production module sets it any more.
//
// So the census does not pretend the prefix is gone. It asserts the true and much stronger fact:
// the emitters are a CLOSED SET OF TWO, nothing reads the prefix back, and NOTHING ARMS THE
// CHANNEL. Re-minting the scrape needs a reader or an armer, and either one reds here.

// ═══ MUTATION LEDGER (2026-08-23, 401-10) ════════════════════════════════════════════════════
//
// Each applied to the real tree, run, and reverted with `git diff --quiet` verified. A census that
// has never been shown to red is a census nobody has measured.
//
//   M1  A re-minted run child in the emptied host — `spawn(process.execPath, [entry, 'run', '--',
//       ...patterns])` in `composition/local-agent-host.ts`.        → 4 red: (2) all three, (4) the
//       emptied-host pin. Cell (1) stayed green, correctly: that file is ALREADY an allowed holder,
//       which is exactly why its shape pin is the tight one.
//   M2  A stdout-scrape reader — `line.startsWith('AGENT_QA_EVENT:')` in the dashboard's in-process
//       run backend.                                                 → 1 red: (5) the holder set.
//   M3  The ARMING half — a child env carrying `AGENT_QA_LIVE_EVENTS: 'true'` in `daemon/host.ts`.
//                                                                    → 1 red: (5) nothing arms it.
//   M4  THE 401-08 FAILURE ITSELF: drop `dashboard-server/src/execution` from the pinned set AND
//       drop `appium-manager.ts` from the allow-list, so PREDICATE 1's self-consistency is intact.
//                        → cell (1) STAYED GREEN — its holders still equalled its own allow-list —
//       and cell (3) red naming the dropped module. That is the whole argument for two predicates,
//       measured rather than asserted.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/** `packages/cli/src/composition/__tests__` → four levels up is the workspace's `packages/`. */
const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

// ══════════════════════════════════════════════════════════════════════════════════════════════
// The two predicates, as functions, so the self-check can drive them over planted source.
// ══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Drop block and line comments, so a module may NAME what it retired without satisfying a census.
 *
 * The `[^:]` guard keeps a protocol-relative URL from being read as a line comment — the trap that
 * eats this kind of stripper. One stripper idiom for the phase: this is byte-identical to the one
 * in `daemon/__tests__/daemon-run-execution.test.ts` and `__tests__/run-door-invocation-census.test.ts`.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** PREDICATE 1's key: does this source hold child-process launch vocabulary at all? */
const SPAWN_VOCABULARY = ['node:child_process', "'child_process'", 'tree-kill', 'treeKill'] as const

function holdsSpawnVocabulary(source: string): boolean {
  const code = stripComments(source)
  return SPAWN_VOCABULARY.some((token) => code.includes(token))
}

/**
 * PREDICATE 2's key: the ARGUMENT SPANS of every child-process launch call in a source.
 *
 * Extracted by balancing parentheses from the call's own `(`, so the question asked of each call is
 * "what is this launching", not "what words are in this file". A file-level co-occurrence test
 * would flag `local-agent-host.ts` — which names `process.execPath` nowhere now, but did — and
 * would keep flagging any file that happened to mention the node binary in unrelated code.
 */
const LAUNCH_CALL = /\b(?:spawnSync|spawn|execFileSync|execFile|execSync|exec|fork)\s*\(/g

function launchSpans(source: string): string[] {
  const code = stripComments(source)
  const spans: string[] = []
  for (const match of code.matchAll(LAUNCH_CALL)) {
    let index = match.index + match[0].length - 1
    const start = index
    let depth = 0
    for (; index < code.length; index++) {
      if (code[index] === '(') depth++
      else if (code[index] === ')') {
        depth--
        if (depth === 0) { index++; break }
      }
    }
    spans.push(code.slice(start, index))
  }
  return spans
}

/**
 * Does this launch call point the child at THIS PRODUCT?
 *
 * The node binary, this process's own entry script, or a resolved `agent-qa` binary. A run child is
 * one of these by construction: there is no other way to re-enter the CLI.
 */
const SELF_REFERENTS = [
  'process.execPath',
  'process.argv[1]',
  'cliBin',
  'cliEntry',
  'require.main',
  "'agent-qa'",
  '"agent-qa"',
] as const

function launchesThisProduct(span: string): boolean {
  return SELF_REFERENTS.some((token) => span.includes(token))
}

/**
 * The SAME question, asked of a module rather than of a call — because an argument vector can be
 * built somewhere else.
 *
 * The daemon's embedder worker is exactly that shape: `spawn(spawnOptions)` where the options
 * object two statements up carries `command: process.execPath`. A span-scoped reading clears it,
 * which would be a blind spot rather than a verdict. This is deliberately coarse — a launch call
 * anywhere in a module that names the node binary anywhere — so it over-reports rather than
 * under-reports, and every module it reports carries a shape pin below.
 */
function mayLaunchThisProduct(source: string): boolean {
  const code = stripComments(source)
  return launchSpans(source).length > 0 && SELF_REFERENTS.some((token) => code.includes(token))
}

/** …and does it ask that child for a RUN? The verb `agent-qa run` takes, as an argv element. */
function namesTheRunVerb(span: string): boolean {
  return /(?:^|[^\w-])['"`]run['"`]/.test(span)
}

/** The scrape's own wire prefix — the only name the retired channel ever had. */
const SCRAPE_PREFIX = 'AGENT_QA_EVENT'
/** …and the environment variable that arms the two surviving emitters. */
const SCRAPE_ARMING_VAR = 'AGENT_QA_LIVE_EVENTS'

function holdsScrapePrefix(source: string): boolean {
  return stripComments(source).includes(SCRAPE_PREFIX)
}

/**
 * Does this source ARM the wire — assign the variable, rather than read it?
 *
 * `X = ...`, `X: ...` (a child-env object literal) and `env.X = ...` are the three shapes a child's
 * environment is built with. A READ (`process.env.X === 'true'`) is not arming and is not flagged:
 * the emitters and the run command read it, which is what makes them dormant rather than dead.
 */
function armsScrapeChannel(source: string): boolean {
  const code = stripComments(source)
  return new RegExp(`${SCRAPE_ARMING_VAR}\\s*[:=][^=]`).test(code)
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// PREDICATE 1's population: the pinned complete set of run-path production modules.
// ══════════════════════════════════════════════════════════════════════════════════════════════

const PINNED_DIRECTORIES = [
  'cli/src/composition',
  'cli/src/daemon',
  'dashboard-server/src/execution',
  'dashboard-server/src/server',
  'agent-local/src/composition',
] as const
const PINNED_FILES = ['cli/src/commands/run.ts', 'cli/src/commands/dashboard.ts'] as const

function walk(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === '__fixtures__') continue
      found.push(...walk(full))
      continue
    }
    if (entry.endsWith('.ts') || entry.endsWith('.tsx')) found.push(full)
  }
  return found
}

const PINNED_SET = [
  ...PINNED_DIRECTORIES.flatMap((dir) => walk(join(PACKAGES, dir))),
  ...PINNED_FILES.map((file) => join(PACKAGES, file)),
].sort()

// ══════════════════════════════════════════════════════════════════════════════════════════════
// PREDICATE 2's population: the transitive first-party import closure of the run-path roots.
// ══════════════════════════════════════════════════════════════════════════════════════════════

/** Workspace package name → its `src` root, read off the manifests rather than remembered. */
const PACKAGE_ROOTS = new Map<string, string>(
  readdirSync(PACKAGES)
    .map((dir) => [join(PACKAGES, dir, 'package.json'), join(PACKAGES, dir, 'src')] as const)
    .filter(([manifest]) => existsSync(manifest))
    .map(([manifest, src]) => [
      (JSON.parse(readFileSync(manifest, 'utf8')) as { name: string }).name,
      src,
    ]),
)

/** `undefined` ⇒ external (not first-party); `null` ⇒ first-party but UNRESOLVED, which is a bug. */
function resolveSpecifier(from: string, specifier: string): string | null | undefined {
  if (specifier.endsWith('.json')) return undefined
  if (specifier.startsWith('.')) {
    const base = join(dirname(from), specifier.replace(/\.js$/, ''))
    for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
      if (existsSync(candidate)) return candidate
    }
    return null
  }
  for (const [name, src] of PACKAGE_ROOTS) {
    if (specifier === name) {
      for (const candidate of [join(src, 'index.ts'), join(src, 'index.tsx')]) {
        if (existsSync(candidate)) return candidate
      }
      return null
    }
    if (specifier.startsWith(`${name}/`)) {
      const rest = specifier.slice(name.length + 1).replace(/\.js$/, '')
      for (const candidate of [join(src, `${rest}.ts`), join(src, rest, 'index.ts')]) {
        if (existsSync(candidate)) return candidate
      }
      return null
    }
  }
  return undefined
}

/**
 * Every first-party module a run can reach from one of the doors, transitively.
 *
 * DYNAMIC EDGES COUNT. `in-process-run-execution.ts` is acquired through `await import(...)` at
 * both of its call sites — that deferral is the surface firewall's only legal route and 401-11
 * measured what happens without it — so a walker reading only static edges would miss the run
 * execution, which is the subject. `require(...)` counts for the same reason.
 */
const RUN_PATH_ROOTS = [
  'cli/src/composition/in-process-run-execution.ts',
  'cli/src/composition/local-agent-host.ts',
  'cli/src/commands/run.ts',
  'cli/src/commands/dashboard.ts',
  'cli/src/commands/mcp.ts',
  'cli/src/commands/agent-jobs.ts',
  'cli/src/daemon/host.ts',
  'dashboard-server/src/server/server.ts',
  'cli/src/composition/run-assembly.ts',
  'agent-local/src/composition/compose-local-agent.ts',
] as const

function runPathClosure(): { modules: string[]; unresolved: string[] } {
  const seen = new Set<string>()
  const unresolved: string[] = []
  const queue = RUN_PATH_ROOTS.map((root) => join(PACKAGES, root))
  while (queue.length > 0) {
    const current = queue.pop()!
    if (seen.has(current)) continue
    seen.add(current)
    const code = stripComments(readFileSync(current, 'utf8'))
    const specifiers = [
      ...[...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]!),
      ...[...code.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]!),
      ...[...code.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]!),
    ]
    for (const specifier of specifiers) {
      const resolved = resolveSpecifier(current, specifier)
      if (typeof resolved === 'string') queue.push(resolved)
      else if (resolved === null) unresolved.push(`${relative(PACKAGES, current)} -> ${specifier}`)
    }
  }
  return { modules: [...seen].sort(), unresolved }
}

const CLOSURE = runPathClosure()
const rel = (path: string): string => relative(PACKAGES, path).split('\\').join('/')

// ══════════════════════════════════════════════════════════════════════════════════════════════
// The named sets. Each entry is a claim about BEHAVIOUR; the shape pins below are where it is
// cashed. A name here that nothing pins would be an exemption rather than a record.
// ══════════════════════════════════════════════════════════════════════════════════════════════

/** Run-path modules permitted to hold the vocabulary — PREDICATE 1's answer. */
const PINNED_VOCABULARY_HOLDERS = [
  // THE BUNDLED APPIUM SERVER — design-of-record, named in INVK-01's own scoping sentence.
  'dashboard-server/src/execution/appium-manager.ts',
  // THE DAEMON-OWNED EMBEDDER WORKER — design-of-record, the other child INVK-01 keeps.
  'cli/src/daemon/host.ts',
  // 2026-10-01 (432-16, D-07): `cli/src/composition/local-agent-host.ts` LEFT this set. It held git
  // plumbing (`spawnSync('git', …)` behind an injected exec seam) for the one-commit applies and the
  // undo source; agent-qa makes no git commits and reads no history now, so it holds no child
  // vocabulary at all. Its shape pin below says so.
  // `exec('open <url>')` — the operator's own browser, opened once when `agent-qa dashboard` boots.
  'cli/src/commands/dashboard.ts',
].sort()

/**
 * Vocabulary holders the closure reaches that the pinned set does not scan — THE RECONCILIATION.
 *
 * This list is the 401-08 failure made mechanical. Each of these is a real child-process user on
 * the run path that PREDICATE 1 is structurally blind to, and each is here with a reason rather
 * than as an exemption. A new member appearing is not automatically wrong — it is the signal that
 * somebody added a child somewhere the pin does not look, and a person should read it.
 */
const REACHED_BUT_UNPINNED = [
  // `node <playwright-core cli> install <browsers>` — a THIRD-PARTY CLI, via the node binary. The
  // one survivor of PREDICATE 2, pinned by shape below.
  'cli/src/commands/install-browsers.ts',
  // `spawnSync` git probes while `agent-qa init` decides what kind of checkout it is in.
  'cli/src/commands/init-filesystem.ts',
  // `spawnSync('/usr/sbin/ioreg', …)` — the macOS hardware UUID that names a run owner's host.
  'dashboard-server/src/db/run-owner-host.ts',
  // `spawnSync('ps', …)` — is the process holding this writer lease still alive?
  'knowledge-local/src/lease/writer-lease.ts',
  // `execFileSync` git reads. Its own header declares it the only sanctioned home for them.
  'runner-local/src/branch-resolver.ts',
  // `execFile(dockerBin, …)` — the USER'S hooks and their container. Design-of-record: a hook is a
  // subprocess by definition, and it is not a run.
  'runner-local/src/hook-executor.ts',
].sort()

/** The one launch call on the whole run path whose own arguments name the node binary. */
const SELF_LAUNCH_SURVIVORS = ['cli/src/commands/install-browsers.ts']

/**
 * …and every module that could point a child at the node binary through an indirection.
 *
 * Two, and the second is the reason this reading exists at all: the daemon builds its embedder
 * worker's `command` into an options object before spawning it, so the call site alone reads clean.
 */
const INDIRECT_SELF_LAUNCHERS = [
  'cli/src/commands/install-browsers.ts',
  'cli/src/daemon/host.ts',
].sort()

/** The two surviving emitters of the retired wire prefix. Nothing else may hold it. */
const SCRAPE_EMITTERS = [
  'cli/src/reporters/wire-reporter.ts',
  'core/src/logging/log-manager.ts',
].sort()

// ══════════════════════════════════════════════════════════════════════════════════════════════

describe('(0) BOTH PREDICATES SEE WHAT THEY FORBID — before any verdict about any module', () => {
  it('PREDICATE 1 matches every vocabulary form, and a comment satisfies none of them', () => {
    expect(holdsSpawnVocabulary("import { spawn } from 'node:child_process'")).toBe(true)
    expect(holdsSpawnVocabulary("const cp = require('child_process')")).toBe(true)
    expect(holdsSpawnVocabulary("import treeKill from 'tree-kill'")).toBe(true)
    expect(holdsSpawnVocabulary("await import('node:child_process')")).toBe(true)
    // …and prose naming the retirement is not a wire.
    expect(holdsSpawnVocabulary('// the daemon used to import node:child_process here')).toBe(false)
    expect(holdsSpawnVocabulary('/**\n * retired: tree-kill on the run path (D-01)\n */')).toBe(false)
    // …and the stripper does not eat a protocol-relative URL, the trap that hollows this out.
    expect(stripComments("const u = 'https://example.test/x'").trim())
      .toBe("const u = 'https://example.test/x'")
  })

  it('PREDICATE 2 reads a launch call ARGUMENT SPAN, and tells a run child from a tool child', () => {
    const runChild = launchSpans(
      "const child = spawn(process.execPath, [entry, 'run', '--', ...patterns], { env })",
    )
    expect(runChild).toHaveLength(1)
    expect(launchesThisProduct(runChild[0]!)).toBe(true)
    expect(namesTheRunVerb(runChild[0]!)).toBe(true)

    // The daemon's piped spelling, and the dashboard's, both of which really existed.
    const piped = launchSpans("spawn(process.execPath, [entry, ...argv], { stdio: ['ignore','pipe','pipe'] })")
    expect(launchesThisProduct(piped[0]!)).toBe(true)
    const dashboard = launchSpans("spawn(this.cliBin, ['run', ...spawnArgs], { env })")
    expect(launchesThisProduct(dashboard[0]!)).toBe(true)
    expect(namesTheRunVerb(dashboard[0]!)).toBe(true)

    // A TOOL child is not a run child. Both halves matter: the span is found, and it is cleared.
    const tool = launchSpans("spawn(appium.command, ['-p', String(port), '--relaxed-security'])")
    expect(tool).toHaveLength(1)
    expect(launchesThisProduct(tool[0]!)).toBe(false)

    // The balancer must survive a nested call in the argument list, or a span ends early and the
    // self-referent after it is never read — a clean verdict produced by truncation.
    const nested = launchSpans('spawn(resolveNode(opts), [entry, ...build(sel)], { env: withRunId(env, process.execPath) })')
    expect(nested[0]).toContain('process.execPath')
  })

  it('THE SCRAPE PREDICATES separate an emitter, a reader and an ARMER', () => {
    expect(holdsScrapePrefix("const PREFIX = 'AGENT_QA_EVENT:'")).toBe(true)
    expect(holdsScrapePrefix("if (line.startsWith('AGENT_QA_EVENT:')) parse(line.slice(15))")).toBe(true)
    expect(holdsScrapePrefix('// AGENT_QA_EVENT: retired with the child (D-04)')).toBe(false)
    // Arming is an assignment; reading is not. The distinction is the whole claim.
    expect(armsScrapeChannel("env: { ...process.env, AGENT_QA_LIVE_EVENTS: 'true' }")).toBe(true)
    expect(armsScrapeChannel("childEnv.AGENT_QA_LIVE_EVENTS = 'true'")).toBe(true)
    expect(armsScrapeChannel("process.env.AGENT_QA_LIVE_EVENTS === 'true'")).toBe(false)
  })

  it('BOTH POPULATIONS ARE REAL — a walk that returned nothing cannot sweep clean', () => {
    expect(PINNED_SET.length).toBeGreaterThan(25)
    expect(PINNED_SET.map(rel)).toContain('cli/src/composition/in-process-run-execution.ts')
    expect(PINNED_SET.map(rel)).toContain('dashboard-server/src/execution/in-process-backend.ts')

    expect(CLOSURE.modules.length).toBeGreaterThan(400)
    // Named members, which a floor cannot assert: the run shell, the assembler, the core, the
    // runner's own member execution. If the walk stops reaching these it is not ranging a run.
    for (const member of [
      'cli/src/commands/run.ts',
      'cli/src/composition/in-process-run-execution.ts',
      'cli/src/composition/run-assembly.ts',
      'agent-local/src/composition/run-invocation-core.ts',
      'runner-local/src/hook-executor.ts',
    ]) {
      expect(CLOSURE.modules.map(rel), `the closure is not ranging ${member}`).toContain(member)
    }
    // A first-party specifier the walk could not resolve is a silently truncated closure.
    expect(CLOSURE.unresolved).toEqual([])
    // The package map was read off the manifests, so an empty one would make every cross-package
    // specifier "external" and shrink the closure to one package without saying so.
    expect(PACKAGE_ROOTS.size).toBeGreaterThan(15)
  })
})

describe('(1) PREDICATE 1 — the pinned run-path set holds no unaccounted child', () => {
  it('THE COMPLETE SET — vocabulary holders equal the named survivors, exactly', () => {
    const holders = PINNED_SET
      .filter((path) => holdsSpawnVocabulary(readFileSync(path, 'utf8')))
      .map(rel)
      .sort()
    expect(holders).toEqual(PINNED_VOCABULARY_HOLDERS)
  })
})

describe('(2) PREDICATE 2 — nothing a run can reach launches THIS PRODUCT as a child', () => {
  it('THE COMPLETE SET — one launch call names the node binary, and it is not a run', () => {
    const offenders = CLOSURE.modules
      .filter((path) => launchSpans(readFileSync(path, 'utf8')).some(launchesThisProduct))
      .map(rel)
      .sort()
    expect(offenders).toEqual(SELF_LAUNCH_SURVIVORS)
  })

  it('THROUGH AN INDIRECTION TOO — a launcher that names the node binary anywhere', () => {
    // The wider reading, because an argument vector built two statements above the call is exactly
    // how the surviving embedder child is written — and exactly how a re-mint would be.
    const launchers = CLOSURE.modules
      .filter((path) => mayLaunchThisProduct(readFileSync(path, 'utf8')))
      .map(rel)
      .sort()
    expect(launchers).toEqual(INDIRECT_SELF_LAUNCHERS)
  })

  it('AND NOT ONE LAUNCH CALL ANYWHERE ASKS A CHILD FOR A RUN — the verb rule', () => {
    // The survivor above passes the first test and must still fail this one. Stated separately so
    // a future third-party-CLI launch does not need this rule relaxed to be added.
    const asking = CLOSURE.modules.flatMap((path) =>
      launchSpans(readFileSync(path, 'utf8'))
        .filter((span) => launchesThisProduct(span) && namesTheRunVerb(span))
        .map((span) => `${rel(path)} :: ${span.replace(/\s+/g, ' ').slice(0, 120)}`),
    )
    expect(asking).toEqual([])
  })
})

describe('(3) THE RECONCILIATION — what each predicate is blind to, the other reports', () => {
  it('EVERY PINNED MODULE IS REACHABLE — or the pin names something off the run path', () => {
    const reachable = new Set(CLOSURE.modules)
    const stranded = PINNED_SET.filter((path) => !reachable.has(path)).map(rel)
    expect(
      stranded,
      'a pinned run-path module no door can reach: either it is not on the run path, or the root '
        + 'set below is missing a door',
    ).toEqual([])
  })

  it('EVERY REACHED HOLDER THE PIN DOES NOT SCAN IS NAMED', () => {
    // THIS is the assertion the self-check pattern cannot make about itself. If `PINNED_SET`'s
    // directories were narrowed tomorrow, cell (1) would stay green — its holders would still
    // equal its allow-list — and this one would red with the dropped module's name.
    const pinned = new Set(PINNED_SET.map(rel))
    const outside = CLOSURE.modules
      .map(rel)
      .filter((path) => !pinned.has(path))
      .filter((path) => holdsSpawnVocabulary(readFileSync(join(PACKAGES, path), 'utf8')))
      .sort()
    expect(outside).toEqual(REACHED_BUT_UNPINNED)
  })
})

describe('(4) ALLOWED IS NOT UNEXAMINED — a shape pin per survivor', () => {
  const read = (path: string): string => stripComments(readFileSync(join(PACKAGES, path), 'utf8'))

  it('THE APPIUM CHILD is the Appium server binary, and nothing else', () => {
    const source = read('dashboard-server/src/execution/appium-manager.ts')
    expect(source).toContain('spawn(appium.command,')
    expect(source).not.toContain('process.execPath')
    expect(source).not.toContain(SCRAPE_PREFIX)
  })

  it('THE EMBEDDER CHILD is the daemon\u2019s worker — the node binary pointed at the WORKER entry', () => {
    const source = read('cli/src/daemon/host.ts')
    expect(source).toContain('spawnEmbedderWorker: (options) => spawn(')
    // Every `spawn(` in this host is that one. The daemon's piped RUN child was the other, and it
    // is gone; this is what makes "gone" a property of the file rather than of a memory.
    expect([...source.matchAll(/\bspawn\s*\(/g)]).toHaveLength(1)
    // It DOES launch the node binary — that is what a JS worker child is — so the discriminating
    // fact is the script it is pointed at. `resolveEmbedderWorkerEntryPath()` is the worker entry
    // and it is the FIRST argv element; the CLI entry the retired run child used is named nowhere.
    expect([...source.matchAll(/process\.execPath/g)]).toHaveLength(1)
    expect(source).toMatch(/command: process\.execPath,\s*args: \[\s*entryPath,/)
    expect(source).toContain('const entryPath = operations.resolveEmbedderWorkerEntryPath()')
    expect(source).not.toContain('cliEntry')
    expect(source).not.toContain('process.argv')
  })

  // RE-SPELLED 2026-10-01 (432-16): was 'THE EMPTIED HOST holds git plumbing only'. The git
  // plumbing went with the one-commit applies and the undo source; the host launches nothing.
  it('THE EMPTIED HOST launches nothing — no `child_process`, no git, no entry script, no argv', () => {
    // The tightest pin in this census, because this is the file `createCliRunExecution` lived in
    // and therefore the likeliest place for a re-mint to land.
    const source = read('cli/src/composition/local-agent-host.ts')
    expect(source).not.toContain('node:child_process')
    expect(source).not.toMatch(/\bspawn(?:Sync)?\s*\(/)
    expect(source).not.toContain('process.execPath')
    expect(source).not.toContain('process.argv')
    expect(launchSpans(source)).toEqual([])
  })

  it('THE DASHBOARD COMMAND opens a URL in the operator\u2019s browser', () => {
    const source = read('cli/src/commands/dashboard.ts')
    expect(source).toContain("await import('node:child_process')")
    expect(source).toMatch(/exec\(`\$\{openCmd\} http:\/\/localhost/)
    expect(source).not.toContain('process.execPath')
  })

  it('THE NODE-BINARY SURVIVOR launches PLAYWRIGHT\u2019s CLI, to install browsers', () => {
    const source = read('cli/src/commands/install-browsers.ts')
    const spans = launchSpans(source).filter(launchesThisProduct)
    expect(spans).toHaveLength(1)
    expect(spans[0]).toContain("'install'")
    expect(spans[0]).not.toContain("'run'")
    // The first argv element is Playwright's own CLI path, resolved by name.
    expect(source).toContain('resolvePlaywrightCoreCli')
  })
})

describe('(5) THE SCRAPE CHANNEL — two emitters, no reader, and nothing arms it', () => {
  it('THE COMPLETE SET OF PREFIX HOLDERS — the two emitters, and nothing else on the run path', () => {
    const holders = CLOSURE.modules
      .filter((path) => holdsScrapePrefix(readFileSync(path, 'utf8')))
      .map(rel)
      .sort()
    expect(holders).toEqual(SCRAPE_EMITTERS)
  })

  it('NEITHER EMITTER READS THE WIRE BACK — a scrape needs a parser, and there is none', () => {
    for (const emitter of SCRAPE_EMITTERS) {
      const source = stripComments(readFileSync(join(PACKAGES, emitter), 'utf8'))
      expect(source, `${emitter} parses the wire prefix`).not.toMatch(
        /(?:startsWith|indexOf|includes|split|match|slice)\s*\([^)]*AGENT_QA_EVENT/,
      )
      expect(source).toContain('write(')
    }
  })

  it('NOTHING ON THE RUN PATH ARMS THE CHANNEL — the thing that used to is deleted', () => {
    // `AGENT_QA_LIVE_EVENTS` was set in the dashboard child's environment. With no child there is
    // no environment to set it in, and no production module sets it any other way. This is what
    // makes the two emitters dormant rather than a live untyped side channel (D-04), and it is the
    // assertion a re-mint cannot avoid tripping: a scrape needs its writer armed.
    const armers = CLOSURE.modules
      .filter((path) => armsScrapeChannel(readFileSync(path, 'utf8')))
      .map(rel)
      .sort()
    expect(armers).toEqual([])
  })
})
