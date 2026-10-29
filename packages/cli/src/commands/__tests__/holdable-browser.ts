// THE HOLDABLE MEMBER: a stand-in browser that claims an ordinal, records its argv, and parks.
//
// NOT A TEST FILE: vitest's include here is `src/**/__tests__/**/*.test.ts`, so this module is
// imported, never collected.
//
// WHY IT IS A SHARED PRIMITIVE AND NOT A SECOND COPY. It was born inside
// `dashboard-cancel-isolation.e2e.test.ts` (401 UAT item 14) and now has a second consumer,
// `composition/__tests__/interrupted-gate-run-exclusion.e2e.test.ts`. The whole value of this
// fixture is that a member's LIVENESS is ASSERTED rather than inferred, and an assertion is only
// as good as the plumbing under it — so two spellings of it would be two answers to "was the
// member still running", and the copy with the weaker plumbing would go green having measured
// nothing. One spelling, two consumers.
//
// WHAT IS STOOD IN FOR IS THE BROWSER BINARY — the external world, not this product's code. Every
// frame from the door down through `adapter.setup` to `chromium.launch(...)` is the shipped one.
//
// ---- THE LOAD-BEARING PROPERTIES, each with the reason it is load-bearing -------------------
//
// 1. `PLAYWRIGHT_BROWSERS_PATH` IS SET BEFORE ANYTHING IN THE PROCESS TOUCHES PLAYWRIGHT.
//    playwright-core resolves its browsers root ONCE, at first use, and caches it: a pin set after
//    some earlier import has already asked is INERT, and the cell then measures a
//    machine-installed browser (or a missing one) while believing it planted the answer. This
//    module sets the variable as its first act and then — the actual guard, because an ordering
//    rule nobody checks is a comment — ASSERTS that playwright's own answer lands inside the
//    planted root, throwing with the two paths named when it does not. Callers must not import
//    playwright, or anything that launches a browser, before calling `plantHoldableBrowser`.
//
// 2. THE PATH IS PLAYWRIGHT'S OWN ANSWER (`chromium.executablePath()`), never hand-spelled.
//    That path folds the browser revision and the host platform together; a literal would rot
//    silently on the next playwright bump and leave the plant unused — a cell green on nothing.
//    playwright-core is reached through `@vostride/agent-qa-web`'s own resolution because the web
//    adapter is the module that launches browsers, so ITS playwright is the one whose answer
//    matters; a second copy could disagree about the revision.
//
// 3. THE ORDINAL IS CLAIMED ATOMICALLY (`mkdirSync` of `slot-N` — one winner per slot).
//    It is what turns "some browser arrived" into "the N-th run's browser arrived", so a cell can
//    name a specific member. Callers start their runs ONE AT A TIME, each awaited to its arrival,
//    which is what makes ordinal N a NAME for run N rather than a race.
//
// 4. THE ARGV IS RECORDED. `--remote-debugging-pipe` in the recorded argv is the non-vacuity
//    witness for the plant itself: it fails if the stand-in was never reached (a stale path after
//    a playwright bump) or was spawned by something that is not a browser launch. It caught a real
//    defect on the first draft — the trampoline dropped `"$@"` — and the cell went red rather than
//    green-on-nothing.
//
// 5. THE RELEASE FILE IS CREATED BY THE CALLER AND NOBODY ELSE, and there is NO CLOCK anywhere in
//    the hold: no `sleep`, no timing window, no "act within N ms and hope". The stand-in blocks
//    until the cell says otherwise.
//
//    the argv is written to a pending file and RENAMED into
//    `arrived-N`. A direct write created the file before its bytes landed, and a caller counting
//    arrivals could read it in that gap: under forced gates at load 22-86 the cancel-isolation
//    cell read the argv as '' (`expected '' to contain '--remote-debugging-pipe'`, 432-03 #1,
//    432-37 #5). A rename is atomic on one filesystem, so an arrival is never seen half-written.
//
// 6. `releasesIssued()` / `releasedOrdinals()` MAKE LIVENESS AN ASSERTION. They are facts about
//    what the CELL has done, not guesses about what the run did — which is the difference between
//    "held mid-flight" and "already finished before we asked". `releasesIssued()` is the count
//    (the cancel-isolation cell's single-hold question); `releasedOrdinals()` is the set, and a
//    cell holding one member while releasing another can only ask its question that way.

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** How many slots the stand-in will try to claim before giving up. */
const MAX_ORDINALS = 32

/**
 * All this primitive needs from a fixture: a directory the fixture owns.
 *
 * Structural rather than nominal so `commands/__tests__` need not depend on
 * `composition/__tests__`. Both consumers pass an `InProcessFixture`.
 */
export interface HoldableBrowserHost {
  readonly project: string
}

/** The parked stand-in browsers, and the only lever that lets one of them go. */
export interface HoldableBrowser {
  /** The path playwright itself named, where the stand-in was planted. */
  readonly execPath: string
  /** The planted browsers root — what `PLAYWRIGHT_BROWSERS_PATH` was pinned to. */
  readonly browsersRoot: string
  /** One record per launch, in arrival order: the argv playwright spawned it with. */
  arrivals(): string[]
  /** How many releases THIS CELL has issued. Zero until it says otherwise. */
  releasesIssued(): number
  /**
   * WHICH ordinals this cell has released, ascending.
   *
   * A cell that holds one member while releasing another cannot ask its question with the count
   * alone: "member 0 was never released" is a statement about a NAMED member, and the count only
   * answers "nothing anywhere was released".
   */
  releasedOrdinals(): number[]
  /** Let the n-th arrival go. It exits non-zero, which is what playwright sees. */
  release(ordinal: number): void
  releaseAll(): void
  /** Put `PLAYWRIGHT_BROWSERS_PATH` back exactly as it was when this plant ran. */
  restoreBrowsersPath(): void
}

/**
 * Plant a stand-in browser executable at the path playwright resolves, and park every launch.
 *
 * See the load-bearing properties in this file's header — every one of them is a property a
 * consumer's assertions rest on, and none of them is decoration.
 */
export function plantHoldableBrowser(host: HoldableBrowserHost): HoldableBrowser {
  const browsersRoot = join(host.project, 'planted-browsers')
  mkdirSync(browsersRoot, { recursive: true })
  const priorBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH
  const restoreBrowsersPath = (): void => {
    if (priorBrowsersPath === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH
    else process.env.PLAYWRIGHT_BROWSERS_PATH = priorBrowsersPath
  }
  // Property 1: the pin comes FIRST, before this module — or anything it reaches — asks
  // playwright anything.
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersRoot

  try {
    const requireFromWeb = createRequire(
      createRequire(import.meta.url).resolve('@vostride/agent-qa-web'),
    )
    const playwright = requireFromWeb('playwright-core') as { chromium: { executablePath(): string } }
    const execPath = playwright.chromium.executablePath()
    // Property 1's guard, and property 2: playwright's OWN answer, asserted to be inside the
    // planted root. A pin that arrived too late shows up here and nowhere else.
    if (!execPath.startsWith(`${browsersRoot}/`)) {
      throw new Error(
        `The planted browsers root was not honoured: playwright resolves ${execPath}, outside ${browsersRoot}. `
        + 'Either PLAYWRIGHT_BROWSERS_PATH was pinned after something in this process already '
        + 'resolved playwright, or the plant would land elsewhere — and this cell would be '
        + 'measuring a machine-installed browser.',
      )
    }

    const control = join(host.project, 'hold-control')
    mkdirSync(control, { recursive: true })

    // The stand-in itself, in two pieces so neither the interpreter path nor the argv needs
    // quoting: a `/bin/sh` trampoline (the file playwright spawns) and the node script that parks.
    const holdScript = join(control, 'hold.cjs')
    writeFileSync(
      holdScript,
      [
        "const fs = require('node:fs')",
        `const control = ${JSON.stringify(control)}`,
        '// Property 3 — an ATOMIC ordinal: mkdir either creates the slot or fails, so two',
        '// concurrent launches can never claim the same one. The cell starts its runs one at a',
        '// time and waits for each arrival, so ordinal N belongs to the N-th run it started.',
        'let ordinal = 0',
        `for (; ordinal < ${String(MAX_ORDINALS)}; ordinal += 1) {`,
        "  try { fs.mkdirSync(`${control}/slot-${ordinal}`); break } catch { /* taken */ }",
        '}',
        '// Property 4 — the argv is recorded so the cell can prove PLAYWRIGHT launched this.',
        '// Written aside and renamed into place: the arrival file appears whole or not at all.',
        'fs.writeFileSync(`${control}/pending-arrival-${ordinal}`, process.argv.slice(2).join(" "))',
        'fs.renameSync(`${control}/pending-arrival-${ordinal}`, `${control}/arrived-${ordinal}`)',
        '// Property 5 — no clock: park until the cell alone says otherwise.',
        'const parked = () => {',
        '  if (!fs.existsSync(control) || fs.existsSync(`${control}/release-${ordinal}`)) process.exit(1)',
        '  setTimeout(parked, 25)',
        '}',
        'parked()',
        '',
      ].join('\n'),
    )
    mkdirSync(dirname(execPath), { recursive: true })
    // `"$@"` is load-bearing (property 4): the cell proves the launch was PLAYWRIGHT's by reading
    // the argv back, so the trampoline has to forward what it was spawned with.
    writeFileSync(
      execPath,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(holdScript)} "$@"\n`,
    )
    chmodSync(execPath, 0o755)

    const released = new Set<number>()
    const issue = (ordinal: number): void => {
      if (existsSync(join(control, `release-${String(ordinal)}`))) return
      released.add(ordinal)
      writeFileSync(join(control, `release-${String(ordinal)}`), '')
    }
    return {
      execPath,
      browsersRoot,
      // The arrival file for an ordinal only exists once that launch is parked, which is what the
      // caller waits on.
      arrivals: () =>
        readdirSync(control)
          .filter((entry) => entry.startsWith('arrived-'))
          .sort()
          .map((entry) => readFileSync(join(control, entry), 'utf8')),
      releasesIssued: () => released.size,
      releasedOrdinals: () => [...released].sort((a, b) => a - b),
      release: issue,
      releaseAll: () => {
        for (let ordinal = 0; ordinal < MAX_ORDINALS; ordinal += 1) {
          if (!existsSync(join(control, `slot-${String(ordinal)}`))) continue
          issue(ordinal)
        }
      },
      restoreBrowsersPath,
    }
  } catch (error) {
    // A plant that failed after pinning the variable must not leave the pin behind for whatever
    // runs next in this process.
    restoreBrowsersPath()
    throw error
  }
}

/**
 * Wait for `assertion`, and FAIL with its own error rather than a bare timeout.
 *
 * It ships beside the primitive rather than in each cell because property 5 above — no clock in
 * the hold — is only true if the waiting is done on a REAL condition. A `sleep` open-coded in one
 * consumer would quietly retire that property for that consumer alone.
 */
export async function waitFor(assertion: () => void, timeoutMs = 60_000): Promise<void> {
  const startedAt = Date.now()
  let lastError: unknown
  while (Date.now() - startedAt < timeoutMs) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  if (lastError instanceof Error) throw lastError
  throw new Error('Timed out waiting for assertion')
}
