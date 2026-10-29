import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs'
import { basename, dirname, relative, resolve, sep } from 'node:path'
// the managed block's SHAPE — markers, header line, splice and append — lives with the
// rest of the scaffold's content, so the proposal path composes the identical bytes this path
// writes. What stays here is the WRITING: classification, lock, atomic publish, preserve
// semantics.
import { composeManagedBlock, type ManagedBlockContent } from './managed-block.js'
import { managedGitignoreContent } from './scaffold-content.js'

export type InitFileOutcome = 'created' | 'updated' | 'preserved'

export interface InitPathPlan {
  root?: string
  path: string
  content: string | Uint8Array
  force?: boolean
  preserveOnForce?: boolean
  mode?: number
}

export interface InitFileResult {
  path: string
  outcome: InitFileOutcome
}

export interface InitPreflightResult {
  path: string
  classification: 'missing' | 'regular'
}

export interface InitFilesystemHooks {
  beforeExclusivePublish?: (path: string) => void
  // The only point between the exclusive publication's `link` and the removal of the
  // temporary it published from. It exists because the behaviour of that removal — on a path
  // where the destination has ALREADY been created — was reviewable only by reading the
  // source; with no injection point there, what a failing removal reports to an operator
  // could be reasoned about but not executed.
  afterExclusiveLink?: (temporaryPath: string) => void
  beforeAtomicReplacePublish?: (path: string) => void
  beforeRetainedModeOpen?: (path: string) => void
  afterRetainedModeOpen?: (path: string) => void
  afterRetainedModeConfirm?: (path: string) => void
  afterTemporaryModeApply?: (temporaryPath: string) => void
}

const PERMISSION_MASK = 0o7777
const MODE_ENFORCEMENT_SUPPORTED = process.platform !== 'win32'

export interface GitignoreProbe {
  path: string
  expected: 'ignored' | 'visible'
  requiredRule?: string
}

/**
 * Covers the namespace `writeDurableTemporary` publishes through. That temporary is a
 * sibling of its destination carrying the DESTINATION'S content at the destination's mode —
 * for `.env.secrets.local`, live credential bytes at 0600 — and it survives any cleanup that
 * cannot run, including a SIGINT between the content write and the unlink. Without this rule
 * real git reports it untracked, so `git add .` picks it up.
 *
 * The spelling is measured, not reasoned: `git check-ignore` decides it, and the leading dot
 * plus the literal `.agent-qa-init-` infix and `.tmp` suffix keep it inside this module's own
 * namespace — `notes.agent-qa-init.md` and `.env.secrets.local.tmp` both stay visible.
 *
 * **The rule has to be present in EVERY root that can be a repository, and it has to be the
 * first write into each.** Round 9 established that the target root's block is the first write
 * of the run, and recorded that its own temporary was therefore "the only uncovered one in the
 * whole run". CORRECTION (round 10): that was measured against the target root's git alone. A
 * knowledge tree is routinely its own repository, and a nested repository does not inherit its
 * parent's `.gitignore` — measured `VISIBLE` with the parent block in place. While the
 * knowledge `.gitignore` was ordered after `README.md` and `policies/global.md`, those two
 * temporaries were uncovered at the instant they existed in that case (README and policy
 * template bytes, never credential bytes). Both roots now write their covering rule first, so
 * the accurate statement is one uncovered temporary PER ROOT and it is that root's own
 * `.gitignore`.
 */
export const DURABLE_TEMPORARY_GITIGNORE_RULE = '.*.agent-qa-init-*.tmp'

// A concrete name of the exact shape the module produces, so the probe asks git about a real
// temporary rather than about the pattern that is supposed to cover it.
const DURABLE_TEMPORARY_PROBE_NAME
  = '..env.secrets.local.agent-qa-init-4242-00000000-0000-4000-8000-000000000000.tmp'

const KNOWLEDGE_DURABLE_TEMPORARY_PROBE_NAME
  = '..gitignore.agent-qa-init-4242-00000000-0000-4000-8000-000000000000.tmp'

export const TARGET_GITIGNORE_PROBES = [
  { path: '.agent-qa/cache/cache.json', expected: 'ignored', requiredRule: '.agent-qa/' },
  {
    path: '.agent-qa/auth-states/default.json',
    expected: 'ignored',
    requiredRule: '.agent-qa/auth-states/',
  },
  { path: 'node_modules/example/index.js', expected: 'ignored', requiredRule: 'node_modules/' },
  {
    path: 'agent-qa.local.yaml',
    expected: 'ignored',
    requiredRule: 'agent-qa.local.yaml',
  },
  { path: '.env', expected: 'ignored', requiredRule: '.env' },
  { path: '.env.secrets.local', expected: 'ignored', requiredRule: '.env.secrets.local' },
  {
    path: DURABLE_TEMPORARY_PROBE_NAME,
    expected: 'ignored',
    requiredRule: DURABLE_TEMPORARY_GITIGNORE_RULE,
  },
  {
    path: 'tests/.agent-qa-drafts/0123456789abcdef.yaml',
    expected: 'ignored',
    requiredRule: 'tests/.agent-qa-drafts/',
  },
  { path: 'agent-qa.config.yaml', expected: 'visible' },
  // Beside the probe above, this is the two-sided pin the shelf needs from git: a draft under
  // `tests/` is covered, and an ordinary test in the same tree is still commit-visible.
  { path: 'tests/example-pass.yaml', expected: 'visible' },
] as const satisfies readonly GitignoreProbe[]

export const KNOWLEDGE_GITIGNORE_PROBES = [
  {
    path: 'memory/index/knowledge.sqlite',
    expected: 'ignored',
    requiredRule: 'memory/index/',
  },
  {
    path: 'memory/queue/candidate.json',
    expected: 'ignored',
    requiredRule: 'memory/queue/',
  },
  // the writer-lease guard lives under `memory/queue/` so that the
  // rule every knowledge repository already has keeps it out of commits; init's probe proves it.
  {
    path: 'memory/queue/lease-guard/owner-00000000-0000-4000-8000-000000000000',
    expected: 'ignored',
    requiredRule: 'memory/queue/',
  },
  { path: '.lease', expected: 'ignored', requiredRule: '.lease' },
  { path: '.epoch', expected: 'ignored', requiredRule: '.epoch' },
  {
    path: '.writer-authority.sqlite',
    expected: 'ignored',
    requiredRule: '.writer-authority.sqlite*',
  },
  {
    path: '.writer-authority.sqlite-wal',
    expected: 'ignored',
    requiredRule: '.writer-authority.sqlite*',
  },
  {
    path: '.writer-authority.sqlite-shm',
    expected: 'ignored',
    requiredRule: '.writer-authority.sqlite*',
  },
  {
    path: 'memory/example/bundles/fact-example/artifacts/screenshot.png',
    expected: 'ignored',
    requiredRule: '**/artifacts/',
  },
  {
    path: 'skills/.staging/draft.md',
    expected: 'ignored',
    requiredRule: 'skills/.staging/',
  },
  {
    path: 'memory/komazon/bundles/.staging/fact.md',
    expected: 'ignored',
    requiredRule: 'memory/*/bundles/.staging/',
  },
  {
    path: KNOWLEDGE_DURABLE_TEMPORARY_PROBE_NAME,
    expected: 'ignored',
    requiredRule: DURABLE_TEMPORARY_GITIGNORE_RULE,
  },
  // 391 D-11 probed `grants.jsonl` as commit-visible here. 2026-10-01: the grant
  // ledger is deleted, so init no longer asks git about it; an old file is left exactly as it is.
  { path: 'memory/example/bundles/fact-example/record.md', expected: 'visible' },
  { path: 'memory/example/bundles/fact-example/manifest.json', expected: 'visible' },
  {
    path: 'memory/example/bundles/fact-example/evidence/outcomes.jsonl',
    expected: 'visible',
  },
  { path: 'policies/global.md', expected: 'visible' },
] as const satisfies readonly GitignoreProbe[]

export const TARGET_GITIGNORE_ENTRIES = [
  '.agent-qa/',
  '.agent-qa/auth-states/',
  // 394: the draft shelf. It sits INSIDE `tests/` on purpose — see the two-sided
  // admission note in `composition/local-agent-host.ts` — which is exactly why it needs a rule of
  // its own: everything else under `tests/` is a file the user means to commit, and an authored
  // draft is not one until they accept it.
  'tests/.agent-qa-drafts/',
  'node_modules/',
  'agent-qa.local.yaml',
  '.env',
  '.env.secrets.local',
  DURABLE_TEMPORARY_GITIGNORE_RULE,
] as const


function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code
}

function lstatIfPresent(path: string): Stats | undefined {
  try {
    return lstatSync(path)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined
    throw error
  }
}

function pathKind(stat: Stats): string {
  if (stat.isSymbolicLink()) return 'symbolic link'
  if (stat.isDirectory()) return 'directory'
  if (stat.isFIFO()) return 'FIFO'
  if (stat.isSocket()) return 'socket'
  if (stat.isBlockDevice()) return 'block device'
  if (stat.isCharacterDevice()) return 'character device'
  return 'non-regular file'
}

function resolvePlanRoot(file: string, root?: string): string {
  const absoluteFile = resolve(file)
  const absoluteRoot = resolve(root ?? dirname(absoluteFile))
  const relativeFile = relative(absoluteRoot, absoluteFile)
  if (
    relativeFile === '..'
    || relativeFile.startsWith(`..${sep}`)
    || relativeFile === ''
  ) {
    throw new Error(`Init destination ${absoluteFile} must be a file inside ${absoluteRoot}`)
  }
  return absoluteRoot
}

function assertDirectoryComponent(file: string, component: string, root: boolean): void {
  const stat = lstatIfPresent(component)
  if (stat === undefined) return
  if (stat.isSymbolicLink()) {
    throw new Error(
      root
        ? `Refusing init destination ${file}: scaffold root ${component} is a symbolic link`
        : `Refusing init destination ${file}: symbolic link parent ${component}`,
    )
  }
  if (!stat.isDirectory()) {
    throw new Error(
      `Refusing init destination ${file}: ${pathKind(stat)} parent ${component}`,
    )
  }
}

function assertSafeParentComponents(file: string, planRoot?: string): void {
  const absoluteFile = resolve(file)
  const root = resolvePlanRoot(absoluteFile, planRoot)
  assertDirectoryComponent(absoluteFile, root, true)
  const relativeParent = relative(root, dirname(absoluteFile))
  const segments = relativeParent.split(sep).filter(Boolean)
  let current = root

  for (const segment of segments) {
    current = resolve(current, segment)
    assertDirectoryComponent(absoluteFile, current, false)
  }
}

function ensureDirectoryComponent(file: string, component: string, root: boolean): void {
  let stat = lstatIfPresent(component)
  if (stat === undefined) {
    try {
      if (root) mkdirSync(component, { recursive: true })
      else mkdirSync(component)
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error
    }
    stat = lstatIfPresent(component)
  }
  if (stat?.isSymbolicLink()) {
    throw new Error(
      root
        ? `Refusing init destination ${file}: scaffold root ${component} is a symbolic link`
        : `Refusing init destination ${file}: symbolic link parent ${component}`,
    )
  }
  if (stat === undefined || !stat.isDirectory()) {
    throw new Error(
      `Refusing init destination ${file}: non-directory parent ${component}`,
    )
  }
}

function ensureSafeParentDirectories(file: string, planRoot?: string): void {
  const absoluteFile = resolve(file)
  const root = resolvePlanRoot(absoluteFile, planRoot)
  ensureDirectoryComponent(absoluteFile, root, true)
  const relativeParent = relative(root, dirname(absoluteFile))
  const segments = relativeParent.split(sep).filter(Boolean)
  let current = root

  for (const segment of segments) {
    current = resolve(current, segment)
    ensureDirectoryComponent(absoluteFile, current, false)
  }
}

interface InitPathInspection {
  classification: 'missing' | 'regular'
  dev?: number
  ino?: number
  nlink?: number
  permissions?: number
}

function inspectInitPath(path: string, root?: string): InitPathInspection {
  const absolutePath = resolve(path)
  assertSafeParentComponents(absolutePath, root)
  const stat = lstatIfPresent(absolutePath)
  if (stat === undefined) return { classification: 'missing' }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(
      `Refusing init destination ${absolutePath}: existing path is a ${pathKind(stat)}`,
    )
  }
  return {
    classification: 'regular',
    dev: stat.dev,
    ino: stat.ino,
    nlink: stat.nlink,
    permissions: stat.mode & PERMISSION_MASK,
  }
}

export function classifyInitPath(
  path: string,
  root?: string,
): 'missing' | 'regular' {
  return inspectInitPath(path, root).classification
}

export function preflightInitPlan(
  plans: readonly InitPathPlan[],
): InitPreflightResult[] {
  const normalizedPlans = plans.map(plan => ({ ...plan, path: resolve(plan.path) }))
  const seen = new Set<string>()
  for (const plan of normalizedPlans) {
    if (seen.has(plan.path)) {
      throw new Error(`Init plan contains duplicate destination ${plan.path}`)
    }
    seen.add(plan.path)
  }

  // An ancestor WALK, not a comparison of adjacent sorted pairs. Sorting does not put a
  // parent next to its child: `-` (0x2D) and `.` (0x2E) both sort below the path separator
  // (0x2F), so any sibling whose name extends the parent with such a byte lands strictly
  // between them — and `tests/` beside `tests-extra.md` is a shape this scaffold publishes.
  // Walking each destination's own ancestors and testing set membership cannot be defeated by
  // what else happens to be in the plan, because it never consults a neighbour. Iterating the
  // sorted list and climbing from the nearest parent upward keeps the reported pair
  // deterministic and names the closest true ancestor.
  const orderedPaths = [...seen].sort()
  for (const path of orderedPaths) {
    let ancestor = dirname(path)
    while (ancestor !== dirname(ancestor)) {
      if (seen.has(ancestor)) {
        throw new Error(`Init plan destination ${ancestor} is a parent of ${path}`)
      }
      ancestor = dirname(ancestor)
    }
  }

  return normalizedPlans.map(plan => ({
    path: plan.path,
    classification: classifyInitPath(plan.path, plan.root),
  }))
}

function bestEffortFsyncDirectory(path: string): void {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    fsyncSync(fd)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (
      code !== 'ENOENT'
      && code !== 'EINVAL'
      && code !== 'EISDIR'
      && code !== 'EPERM'
      && code !== 'ENOTSUP'
      && code !== 'EBADF'
    ) {
      throw error
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error
  }
}

/**
 * What real git says about a leftover temporary at the moment the operator is told about it.
 *
 * `undetermined` is a first-class answer rather than a fallback to `covered`. The whole defect
 * this replaces was a sentence that claimed coverage it had not established; claiming
 * commit-visibility that has not been established would be the same defect facing the other
 * way. When git cannot answer, the message says so and still directs the removal.
 */
type TemporaryCoverage = 'covered' | 'commit-visible' | 'undetermined'

// Resolved LAZILY. Built at the call site, where the destination and therefore the root the
// question has to be put to are in hand, and INVOKED only when a removal has actually failed
// — so no publication pays for a `git` spawn it does not need, and the answer is the one that
// holds AT THE MOMENT THE MESSAGE IS EMITTED. That moment is the one that matters: it is when
// the operator reads the sentence and it is the state of the disk they will act on. It can
// differ from the instant the temporary was created — on the post-link path the destination
// has already been published, so a `.gitignore` temporary that was uncovered when it was
// written may be covered by the very rule it just finished publishing.
type TemporaryCoverageProbe = () => TemporaryCoverage

function durableTemporaryCoverageProbe(
  destination: string,
  temporary: string,
): TemporaryCoverageProbe {
  // The question is put at the DESTINATION's own directory, not at the plan root: a knowledge
  // tree is routinely its own repository and does not inherit its parent's rules (see the
  // round-10 correction on `DURABLE_TEMPORARY_GITIGNORE_RULE`), so the root that decides is
  // whichever one git itself resolves from the file's own location.
  const directory = dirname(resolve(destination))
  const name = basename(temporary)
  return () => {
    // Measured, not reasoned — the same call this module already trusts to decide whether the
    // rule's spelling works. Reading `DURABLE_TEMPORARY_GITIGNORE_RULE` and concluding would
    // be the third time this file's coverage story was settled by argument, and twice it was
    // wrong. Any failure to ASK is `undetermined`, never an assumed answer.
    try {
      return checkIgnoreStatus(directory, name) === 0 ? 'covered' : 'commit-visible'
    } catch {
      return 'undetermined'
    }
  }
}

const TEMPORARY_COVERAGE_CLAUSE: Record<TemporaryCoverage, string> = {
  covered:
    'It is covered by the managed .gitignore rule, so it cannot enter a commit; '
    + 'delete it once the condition that blocked the removal is cleared.',
  'commit-visible':
    'It is NOT covered by the managed .gitignore rule here — git reports it commit-visible, '
    + 'so `git add .` would stage it; remove it before staging, once the condition that '
    + 'blocked the removal is cleared.',
  undetermined:
    'Whether the managed .gitignore rule covers it could not be determined here, because git '
    + 'could not be asked; treat it as stageable and remove it before staging, once the '
    + 'condition that blocked the removal is cleared.',
}

/**
 * Removes a publication temporary from a `finally` WITHOUT ever throwing.
 *
 * A `finally` that throws discards the exception already in flight, so a cleanup failure
 * replaces the publication refusal with an unlink error naming a path the operator never
 * acted on — the reason they needed is gone and the one they get is unactionable. The
 * failure is still reported, as a warning, rather than swallowed.
 *
 * Whether the leftover is inert to a commit is a statement of fact about the operator's tree,
 * so it cannot be a constant. `DURABLE_TEMPORARY_GITIGNORE_RULE` covers the namespace only
 * where that rule is already in force, and this module's own correction names the temporaries
 * for which it is not: each root's own `.gitignore`, because the rule that would cover such a
 * temporary is the thing that temporary is on its way to writing. The claim is therefore
 * conditioned on `coverage`, which real `git check-ignore` decides.
 */
function cleanUpTemporaryWithoutMasking(
  temporary: string,
  coverage: TemporaryCoverageProbe,
): void {
  try {
    unlinkIfPresent(temporary)
  } catch (error) {
    process.emitWarning(
      `agent-qa init could not remove its temporary ${temporary} `
      + `(${error instanceof Error ? error.message : String(error)}). `
      + TEMPORARY_COVERAGE_CLAUSE[coverage()],
    )
  }
}

interface DurableTemporary {
  temporary: string
  confirmed?: { dev: number, ino: number }
  /**
   * The temporary's descriptor, held open until publication has been confirmed, and closed by
   * the publisher's `finally`.
   *
   * `confirmed` proves publication linked the inode whose mode was confirmed, by comparing
   * `{ dev, ino }`. That comparison is only sound while the confirmed inode CANNOT be handed to
   * anyone else: ext4 reuses an inode number immediately on unlink-then-create in the same
   * directory, so a substituted temporary carrying exactly the requested mode used to satisfy
   * every arm of the check and publish attacker bytes as a confirmed credential file. POSIX will
   * not free an inode while an open descriptor references it, so pinning it here denies that
   * reuse and forces any substitute to a different inode, which the check then catches.
   *
   * Only held when `confirmed` is set (POSIX with a requested mode). Windows never sets it —
   * `MODE_ENFORCEMENT_SUPPORTED` is false there — so no open handle can block its `rename`/`link`.
   */
  pin?: number
}

/** Close a pinned temporary descriptor. Never masks the publisher's own error. */
function releaseTemporaryPin(pin: number | undefined): void {
  if (pin === undefined) return
  try {
    closeSync(pin)
  } catch {
    // The descriptor is process-local and the publication verdict is already decided; a close
    // failure cannot change it and must not replace it.
  }
}

function writeDurableTemporary(
  plan: InitPathPlan,
  hooks: InitFilesystemHooks = {},
): DurableTemporary {
  const path = resolve(plan.path)
  const temporary = resolve(
    dirname(path),
    `.${basename(path)}.agent-qa-init-${process.pid}-${randomUUID()}.tmp`,
  )
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx', plan.mode ?? 0o666)
    let confirmed: { dev: number, ino: number } | undefined
    if (plan.mode !== undefined && MODE_ENFORCEMENT_SUPPORTED) {
      // The creation mode is masked by the process umask; harden the descriptor and
      // re-read the bits before any content reaches the inode, then record that
      // inode so publication can prove it linked the file it confirmed.
      const requested = plan.mode & PERMISSION_MASK
      fchmodSync(fd, requested)
      invokeHook(hooks.afterTemporaryModeApply, temporary)
      const opened = confirmDescriptorMode(fd, path, requested)
      confirmed = { dev: opened.dev, ino: opened.ino }
    }
    writeFileSync(fd, plan.content)
    fsyncSync(fd)
    if (confirmed === undefined) {
      closeSync(fd)
      fd = undefined
      return { temporary }
    }
    // Deliberately NOT closed here: the descriptor pins the confirmed inode against reuse until
    // publication has been confirmed. Ownership transfers to the publisher's `finally`.
    const pin = fd
    fd = undefined
    return { temporary, confirmed, pin }
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    unlinkIfPresent(temporary)
    throw error
  }
}

function confirmPublishedDestination(
  path: string,
  requested: number,
  identity: { dev: number, ino: number },
): void {
  const { O_RDONLY, O_NOFOLLOW = 0 } = fsConstants
  let fd: number | undefined
  try {
    fd = openSync(path, O_RDONLY | O_NOFOLLOW)
    const published = confirmDescriptorMode(fd, path, requested)
    if (!published.isFile()) {
      refuseModeEnforcement(path, 'on a non-regular destination')
    }
    if (
      published.dev !== identity.dev
      || published.ino !== identity.ino
      || published.nlink !== 1
    ) {
      refuseModeEnforcement(path, 'because the destination changed at publication')
    }
  } catch (error) {
    // the unlink STAYS. For a credential-bearing publication, leaving a file at a
    // mode that could not be confirmed is the worse failure, and on the replacement path
    // the rename has already consumed the original bytes before this runs. What changes
    // is only that the refusal now SAYS which disposition it took.
    unlinkIfPresent(path)
    throw withRefusalDisposition(error, REFUSAL_DISPOSITION_REMOVED)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function publishExclusive(
  plan: InitPathPlan,
  hooks: InitFilesystemHooks,
): InitFileResult {
  const path = resolve(plan.path)
  const parent = dirname(path)
  const { temporary, confirmed, pin } = writeDurableTemporary(plan, hooks)
  // Built here, where the destination is known; the answer is taken at emission, so the two
  // sites below can and do differ — see the comment at each.
  const coverage = durableTemporaryCoverageProbe(path, temporary)
  try {
    invokeHook(hooks.beforeExclusivePublish, path)
    try {
      linkSync(temporary, path)
    } catch (error) {
      if (isErrno(error, 'EEXIST')) {
        throw new Error(
          `Refusing init destination ${path}: path appeared during exclusive create`,
        )
      }
      throw error
    }
    invokeHook(hooks.afterExclusiveLink, temporary)
    // The publication has ALREADY succeeded here — `link` created the destination with this
    // temporary's content. A removal that fails past that point is housekeeping, not a
    // refusal: measured, letting it throw produced `EACCES … unlink <temporary>` carrying
    // the backstop's RETAINED sentence ("the destination was not removed or rewritten — if
    // it still exists it retains its original contents at an unconfirmed mode") about a
    // destination that had just been created with new bytes. Reported as a warning through
    // the same non-masking cleanup the `finally` uses, which that `finally` then repeats as
    // a no-op.
    //
    // COVERAGE AT THIS SITE: the destination EXISTS by now. For a `.gitignore` publication
    // that is the moment the covering rule comes into force, so this site can answer
    // `covered` where the `finally` below answers `commit-visible` for the same destination —
    // which is exactly why the answer is taken at emission rather than once per plan.
    cleanUpTemporaryWithoutMasking(temporary, coverage)
    if (confirmed !== undefined && plan.mode !== undefined) {
      confirmPublishedDestination(path, plan.mode & PERMISSION_MASK, confirmed)
    }
    afterPublication(() => bestEffortFsyncDirectory(parent))
    return { path, outcome: 'created' }
  } finally {
    // Released only here, so the confirmed inode stays pinned across link AND confirmation.
    releaseTemporaryPin(pin)
    // COVERAGE AT THIS SITE: reached on success (a no-op) and on every failure path,
    // including one that aborted BEFORE the link. On that path the destination does not
    // exist, so a `.gitignore` publication's temporary is genuinely commit-visible here.
    cleanUpTemporaryWithoutMasking(temporary, coverage)
  }
}

function replaceRegularAtomic(
  plan: InitPathPlan,
  hooks: InitFilesystemHooks = {},
): InitFileResult {
  const path = resolve(plan.path)
  const parent = dirname(path)
  // The confirmed identity is consumed, not discarded: publication must prove it renamed
  // the inode whose mode was confirmed, exactly as the exclusive path does — and the pinned
  // descriptor is what makes that identity unforgeable against inode reuse.
  const { temporary, confirmed, pin } = writeDurableTemporary(plan, hooks)
  const coverage = durableTemporaryCoverageProbe(path, temporary)
  try {
    const classification = classifyInitPath(path, plan.root)
    if (classification !== 'regular') {
      throw new Error(`Refusing atomic replacement of missing init destination ${path}`)
    }
    invokeHook(hooks.beforeAtomicReplacePublish, path)
    renameSync(temporary, path)
    if (confirmed !== undefined && plan.mode !== undefined) {
      confirmPublishedDestination(path, plan.mode & PERMISSION_MASK, confirmed)
    }
    afterPublication(() => bestEffortFsyncDirectory(parent))
    return { path, outcome: 'updated' }
  } finally {
    // Released only here, so the confirmed inode stays pinned across rename AND confirmation.
    releaseTemporaryPin(pin)
    // COVERAGE AT THIS SITE: on success the rename has already consumed the temporary and
    // the unlink is a no-op. On a failure before the rename the destination still holds its
    // ORIGINAL bytes, so a `.gitignore` being amended to add the managed block answers by
    // whatever the pre-existing file already ignored — measured, not assumed.
    cleanUpTemporaryWithoutMasking(temporary, coverage)
  }
}

function refuseModeEnforcement(path: string, reason: string): never {
  throw new Error(
    `Refusing init destination ${path}: cannot enforce owner-only permissions ${reason}`,
  )
}

function octalMode(mode: number): string {
  return (mode & PERMISSION_MASK).toString(8).padStart(4, '0')
}

// The two dispositions a refusal can carry, appended after the existing reason so every
// reason string still reads verbatim at the head of the message. They are deliberately
// non-overlapping — neither is a substring of the other — so a caller holding only the
// thrown message can tell a removed destination from a retained one. Ratified as D-22.
// The token both disposition sentences open with, so the two sentences cannot drift apart in
// how they announce themselves to a reader. Nothing in this module DECIDES anything by
// looking for this token in a message: see `dispositionedRefusals` below for why.
const REFUSAL_DISPOSITION_LEAD = 'Disposition:'

const REFUSAL_DISPOSITION_REMOVED
  = `${REFUSAL_DISPOSITION_LEAD} the unconfirmed destination was not left in place — `
  + 'it was unlinked. '
  + 'If it was published by replacement, the bytes it held beforehand were already '
  + 'consumed by the rename and are not recoverable.'

// Phrased so it stays true even for the refusal that fires BECAUSE the destination
// vanished: this code did not remove or rewrite it, and the retention clause is
// conditioned on the destination still existing.
const REFUSAL_DISPOSITION_RETAINED
  = `${REFUSAL_DISPOSITION_LEAD} the destination was not removed or rewritten — if it `
  + 'still exists it '
  + 'retains its original contents at an unconfirmed mode.'

// Errors that must leave `writeScaffoldFileAtomic` exactly as they were thrown, because
// neither disposition is this module's to claim about them:
//
//   - a caller-supplied hook's own error. It is the consumer's, not a refusal of ours, and
//     grafting a factual claim about the destination onto it is a false statement.
//   - an error raised AFTER a publication has already succeeded (the directory fsync). The
//     destination was rewritten, so the retention sentence would be false, and it was not
//     unlinked, so the removal sentence would be false too.
//
// Keyed by identity in a module-private WeakSet: nothing about it is observable as API, and
// it cannot retain the errors it marks.
const passthroughRefusalErrors = new WeakSet<object>()

// The refusals to which this module has ALREADY appended a disposition sentence, recorded the
// same way and for the same reasons as the passthrough set above.
//
// Identity rather than text, because the text is partly the caller's. "Has a disposition
// already been appended?" is a question about what THIS module did, and every refusal message
// embeds the destination path verbatim — a public parameter. Deciding the question by testing
// the message for the disposition's lead token therefore let a caller-supplied path decide it:
// a destination under a directory named after the lead token suppressed the disposition
// entirely, one named after the removal sentence made a RETAINED refusal read as a destroyed
// destination, and either one could produce a second sentence. Membership in this set cannot
// be forged by any byte of any path.
const dispositionedRefusals = new WeakSet<object>()

// `WeakSet` keys on object identity, but `typeof` reports 'function' rather than 'object' for
// callable values — which are legal throw values. Marking and testing have to agree on which
// values are markable, or a thrown function would be marked and then never recognised.
function isMarkable(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

function markPassthrough(error: unknown): unknown {
  if (isMarkable(error)) {
    passthroughRefusalErrors.add(error)
    return error
  }
  // A primitive cannot carry an identity mark, and leaving it unmarked is precisely what let a
  // consumer's own `throw 'oops'` acquire a factual claim about a destination this module never
  // acted on. Wrap it so identity marking always applies: the message is the thrown value's own
  // string form and the value itself stays reachable as the cause, so nothing is lost.
  const wrapper = new Error(String(error), { cause: error })
  passthroughRefusalErrors.add(wrapper)
  return wrapper
}

function isPassthrough(error: unknown): boolean {
  return isMarkable(error) && passthroughRefusalErrors.has(error)
}

// Every caller hook is invoked through here, at exactly the point it was invoked before —
// the hooks are marked, never hoisted, so their firing order is unchanged.
function invokeHook(
  hook: ((argument: string) => void) | undefined,
  argument: string,
): void {
  if (hook === undefined) return
  try {
    hook(argument)
  } catch (error) {
    throw markPassthrough(error)
  }
}

function afterPublication(operation: () => void): void {
  try {
    operation()
  } catch (error) {
    throw markPassthrough(error)
  }
}

function withRefusalDisposition(error: unknown, disposition: string): Error {
  // A non-`Error` throw value is converted rather than rethrown bare, so the removal path
  // can never deliver a destination-was-unlinked outcome carrying no disposition at all.
  const reason = error instanceof Error ? error.message : String(error)
  const refusal = new Error(`${reason} ${disposition}`, { cause: error })
  // Recorded at the moment the sentence is appended, so the fact travels with the error object
  // rather than having to be recovered from its text later.
  dispositionedRefusals.add(refusal)
  return refusal
}

function carriesDisposition(error: unknown): boolean {
  return isMarkable(error) && dispositionedRefusals.has(error)
}

// The floor under the whole refusal contract, not a replacement for the inner wraps: those
// are what keep each disposition specific to its path. Anything that reaches here escaped
// without one, and on every such path this module neither removed nor rewrote the
// destination — so retention is the correct default. A refusal added anywhere below
// inherits it, which is what makes the universal structural rather than sampled.
function withRefusalBackstop<T>(operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    if (isPassthrough(error)) throw error
    if (carriesDisposition(error)) throw error
    throw withRefusalDisposition(error, REFUSAL_DISPOSITION_RETAINED)
  }
}

function confirmDescriptorMode(fd: number, path: string, requested: number): Stats {
  const observed = fstatSync(fd)
  if ((observed.mode & PERMISSION_MASK) !== requested) {
    refuseModeEnforcement(
      path,
      `because the requested mode ${octalMode(requested)} was not applied `
      + `(observed ${octalMode(observed.mode)}); the destination filesystem may not `
      + 'persist POSIX permissions. Remount the destination with permission support '
      + 'or place the project on a filesystem that can store POSIX permissions.',
    )
  }
  return observed
}

/**
 * Applies an explicitly requested mode to a retained file through a descriptor
 * bound to the inode that classification inspected. Credential bytes are never
 * read, rewritten, or logged, and any identity, link-count, type, or permission
 * change between inspection, open, chmod, and the post-check fails closed — the
 * permission bits are re-read from the descriptor rather than assumed applied and are
 * compared again on the settle observation, so the composite claim is a single one: the
 * path resolves to the inspected inode carrying the requested mode.
 *
 * Conditional on the platform: where `process.platform === 'win32'` this returns
 * immediately and none of the above happens — no chmod, no confirmation, no refusal.
 */
function enforceRetainedFileMode(
  path: string,
  inspection: InitPathInspection,
  mode: number,
  hooks: InitFilesystemHooks,
): void {
  if (!MODE_ENFORCEMENT_SUPPORTED) return

  // The retention disposition wraps the WHOLE body, not a single throw, so the
  // classification refusals raised before the descriptor is opened carry it too. This
  // function is the sole site that leaves the destination alone, which is why the
  // disposition is a property of the path rather than of any one reason.
  try {
    if (
      inspection.classification !== 'regular'
      || inspection.dev === undefined
      || inspection.ino === undefined
    ) {
      refuseModeEnforcement(path, 'on a non-regular destination')
    }
    if (inspection.nlink !== 1) {
      refuseModeEnforcement(path, 'on a file with multiple hard links')
    }

    const requested = mode & PERMISSION_MASK
    invokeHook(hooks.beforeRetainedModeOpen, path)

    const { O_RDONLY, O_NOFOLLOW = 0 } = fsConstants
    let fd: number | undefined
    try {
      try {
        fd = openSync(path, O_RDONLY | O_NOFOLLOW)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT') {
          refuseModeEnforcement(path, 'because the destination disappeared')
        }
        if (code === 'ELOOP' || code === 'EMLINK') {
          refuseModeEnforcement(path, 'on a symbolic-link destination')
        }
        if (code === 'EACCES' || code === 'EPERM') {
          throw new Error(
            `Refusing init destination ${path}: cannot enforce owner-only permissions `
            + `(permission denied). Run \`chmod 600 ${path}\` and rerun agent-qa init.`,
          )
        }
        throw error
      }

      const opened = fstatSync(fd)
      if (!opened.isFile()) refuseModeEnforcement(path, 'on a non-regular destination')
      if (opened.dev !== inspection.dev || opened.ino !== inspection.ino) {
        refuseModeEnforcement(path, 'because the destination changed')
      }
      if (opened.nlink !== 1) {
        refuseModeEnforcement(path, 'on a file with multiple hard links')
      }

      if ((opened.mode & PERMISSION_MASK) !== requested) fchmodSync(fd, requested)

      invokeHook(hooks.afterRetainedModeOpen, path)

      confirmDescriptorMode(fd, path, requested)

      invokeHook(hooks.afterRetainedModeConfirm, path)

      const settled = lstatIfPresent(path)
      if (settled === undefined) {
        refuseModeEnforcement(path, 'because the destination disappeared')
      }
      if (settled.isSymbolicLink() || !settled.isFile()) {
        refuseModeEnforcement(path, 'on a non-regular destination')
      }
      if (
        settled.dev !== inspection.dev
        || settled.ino !== inspection.ino
        || settled.nlink !== 1
      ) {
        refuseModeEnforcement(path, 'because the destination changed')
      }
      // The settle observation already holds the permission bits; comparing them collapses
      // "the inode had mode M" and "the path resolves to that inode" into one observation.
      if ((settled.mode & PERMISSION_MASK) !== requested) {
        refuseModeEnforcement(
          path,
          `because the requested mode ${octalMode(requested)} did not settle `
          + `(observed ${octalMode(settled.mode)}); another process changed the destination's `
          + `permissions. Run \`chmod 600 ${path}\` and rerun agent-qa init.`,
        )
      }
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  } catch (error) {
    // A caller hook's own error is the consumer's; it is not restated as an init refusal
    // and acquires no factual claim about the destination.
    if (isPassthrough(error)) throw error
    throw withRefusalDisposition(error, REFUSAL_DISPOSITION_RETAINED)
  }
}

/**
 * Publishes one scaffold destination and returns one of three outcomes:
 *
 * - `created` — the destination was absent and was published by the exclusive path
 *   (`link` from a durable temporary).
 * - `updated` — the destination existed, `force` was set without `preserveOnForce`, and it
 *   was published by the atomic-replacement path (`rename` over the existing inode).
 * - `preserved` — the destination existed and was kept; when the plan declares a mode AND
 *   the host platform enforces POSIX permissions, its permission bits are enforced in place
 *   on the retained inode.
 *
 * **Mode enforcement is conditional on the platform.** Every mode claim here — on all three
 * outcomes — holds only where `process.platform !== 'win32'`. On win32 a declared mode is a
 * silent no-op: nothing is applied, nothing is confirmed, and no refusal is raised, so a
 * plan that declares owner-only bits publishes at whatever mode the host gives it. This is
 * the shipped behaviour, stated rather than changed.
 *
 * **A refused post-publication confirmation DESTROYS the destination.** On both the
 * `created` and `updated` paths, if the mode or identity of the published file cannot be
 * confirmed after publication, the destination is UNLINKED before the refusal is rethrown.
 * On the `updated` path this is not recoverable: the `rename` has already consumed the
 * bytes the destination held beforehand, and this function does not retain a copy of them.
 *
 * A refused RETENTION behaves oppositely: the destination is neither removed nor
 * rewritten, so it is left in place at an unconfirmed mode with its contents intact.
 *
 * The asymmetry is deliberate, not accidental. For a credential-bearing publication a file
 * left at a mode that could not be confirmed is the worse failure, and on the replacement
 * path "leave it alone" was never available — the rename runs before the confirmation. The
 * two outcomes are told apart from the thrown error alone: every refusal this function
 * raises appends exactly one disposition sentence stating whether the destination was
 * unlinked or left in place. That is a floor, held by an outermost backstop rather than by
 * each throw site, so a refusal added anywhere beneath this function inherits it.
 *
 * **The floor is held by identity, not by reading the message.** Whether a refusal already
 * carries a disposition is recorded by adding the error OBJECT to a module-private `WeakSet`
 * at the moment the sentence is appended; the backstop tests membership. It is not decided by
 * looking for the disposition's lead token in the message. That distinction is load-bearing:
 * every refusal message embeds the destination path verbatim and the destination path is a
 * caller-supplied parameter, so a message-reading predicate handed those bytes a decision
 * about what this code did. Under identity marking a destination path cannot suppress the
 * disposition, cannot invert which of the two is reported, and cannot produce a second one,
 * because no decision is taken from the message at all. What a caller-supplied path CAN still
 * do is put the lead token, or an entire disposition sentence, inside the reason — so a
 * message may contain either more than once. Only the sentence appended past the reason is
 * this function's claim; a reader recovering the claim programmatically should take it from
 * the suffix past the root `cause`'s message rather than by scanning the whole string.
 *
 * Exactly two classes of error escape WITHOUT a disposition, and neither is a refusal of
 * this function's:
 *
 * - an error thrown by a caller-supplied hook, which is rethrown carrying its own message
 *   rather than restated as an init refusal with a claim about the destination. This holds
 *   for EVERY throw value, not only object ones: a primitive cannot carry an identity mark,
 *   so it is wrapped in an `Error` whose message is the value's own string form and whose
 *   `cause` is the value itself, and the wrapper is what gets marked;
 * - an error raised after a publication has already SUCCEEDED (the parent-directory fsync),
 *   for which neither sentence is true — the destination was rewritten, so it was not
 *   retained, and it was not unlinked either.
 *
 * Two limits on the EVIDENCE for this floor. The first is carried forward: the refusal walk
 * asserting it enumerates 15 of the 21 refusal sites reachable beneath this function — the 15
 * counted from `REFUSAL_PATH_WALK`, and round 10 adds no refusal site to this module — so the
 * floor is structural by construction but sampled by test.
 *
 * The second was the temporary-cleanup `finally` in both publication paths, and it is
 * RE-MEASURED rather than restated. That `finally` calls `cleanUpTemporaryWithoutMasking`,
 * which does not throw: measured against a wedged directory it emits a warning and returns, so
 * nothing escapes from it to be stamped at all. The exclusive path's post-link removal, which
 * DID escape and was stamped retained over a destination it had just created, now runs through
 * that same cleanup. What replaces the limit, measured on the same fixture: a temporary that
 * could not be removed keeps the published destination's link count at 2, so a mode-declaring
 * plan refuses at the identity confirmation — and if THAT refusal's own D-22 unlink of the
 * destination also fails, the resulting error reaches the backstop and is stamped retained
 * about a destination this module had just created with new content. That site is inside the
 * D-22 region, which round 10 leaves byte-unchanged, so it is disclosed rather than fixed.
 *
 * Ratified as decision D-22.
 */
export function writeScaffoldFileAtomic(
  plan: InitPathPlan,
  hooks: InitFilesystemHooks = {},
): InitFileResult {
  return withRefusalBackstop(() => {
    const normalizedPlan = { ...plan, path: resolve(plan.path) }
    const inspection = inspectInitPath(normalizedPlan.path, normalizedPlan.root)

    if (inspection.classification === 'regular') {
      if (!normalizedPlan.force || normalizedPlan.preserveOnForce) {
        if (normalizedPlan.mode !== undefined) {
          enforceRetainedFileMode(
            normalizedPlan.path,
            inspection,
            normalizedPlan.mode,
            hooks,
          )
        }
        return { path: normalizedPlan.path, outcome: 'preserved' }
      }
      ensureSafeParentDirectories(normalizedPlan.path, normalizedPlan.root)
      return replaceRegularAtomic(normalizedPlan, hooks)
    }

    ensureSafeParentDirectories(normalizedPlan.path, normalizedPlan.root)
    return publishExclusive(normalizedPlan, hooks)
  })
}

export function writeConfigMarkerLast(
  plan: InitPathPlan,
  hooks: InitFilesystemHooks = {},
): InitFileResult {
  if (basename(plan.path) !== 'agent-qa.config.yaml') {
    throw new Error('Init completion marker must be agent-qa.config.yaml')
  }
  return writeScaffoldFileAtomic(plan, hooks)
}

export interface ManagedBlockUpsertPlan {
  path: string
  root?: string
  content: ManagedBlockContent
}

// Inside `DURABLE_TEMPORARY_GITIGNORE_RULE`'s namespace, so a lock an interrupted writer leaves
// behind is not commit-visible wherever that rule is in force.
const MANAGED_BLOCK_LOCK_SUFFIX = '.agent-qa-init-lock.tmp'

export function managedBlockLockPath(path: string): string {
  const absolutePath = resolve(path)
  return resolve(dirname(absolutePath), `.${basename(absolutePath)}${MANAGED_BLOCK_LOCK_SUFFIX}`)
}

/** The target's lock already exists. It is never removed by a writer that did not create it. */
export class ManagedBlockLockRefusal extends Error {
  readonly lockPath: string

  constructor(path: string, lockPath: string) {
    super(
      `Refusing to update ${path}: its lock ${lockPath} already exists. Another agent-qa `
      + 'writer holds it, or an interrupted one left it behind; if no agent-qa command is '
      + 'writing this file, delete the lock and rerun.',
    )
    this.name = 'ManagedBlockLockRefusal'
    this.lockPath = lockPath
  }
}

interface HeldManagedBlockLock {
  path: string
  dev: number
  ino: number
}

function releaseManagedBlockLock(lock: HeldManagedBlockLock): void {
  try {
    const stat = lstatIfPresent(lock.path)
    if (stat === undefined || stat.dev !== lock.dev || stat.ino !== lock.ino) return
    unlinkSync(lock.path)
  } catch (error) {
    process.emitWarning(
      `agent-qa could not remove its lock ${lock.path} `
      + `(${error instanceof Error ? error.message : String(error)}); `
      + 'delete it before the next agent-qa write to this file.',
    )
  }
}

function acquireManagedBlockLock(path: string): HeldManagedBlockLock {
  const lockPath = managedBlockLockPath(path)
  let fd: number
  try {
    fd = openSync(lockPath, 'wx', 0o600)
  } catch (error) {
    if (isErrno(error, 'EEXIST')) throw new ManagedBlockLockRefusal(path, lockPath)
    throw error
  }
  let held: HeldManagedBlockLock | undefined
  try {
    try {
      const { dev, ino } = fstatSync(fd)
      held = { path: lockPath, dev, ino }
      writeFileSync(fd, `pid ${process.pid}\n`)
    } finally {
      closeSync(fd)
    }
    return held
  } catch (error) {
    if (held !== undefined) releaseManagedBlockLock(held)
    throw error
  }
}

interface ManagedBlockRead {
  text: string
  size: number
  mtimeMs: number
}

function readManagedBlockTarget(path: string, inspection: InitPathInspection): ManagedBlockRead {
  if (inspection.nlink !== 1) {
    throw new Error(
      `Refusing to update ${path}: it has ${inspection.nlink} hard links, and replacing it `
      + 'would leave the other names holding the old bytes',
    )
  }
  const { O_RDONLY, O_NOFOLLOW = 0 } = fsConstants
  const fd = openSync(path, O_RDONLY | O_NOFOLLOW)
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.dev !== inspection.dev || opened.ino !== inspection.ino) {
      throw new Error(`Refusing to update ${path}: it changed while it was being read`)
    }
    const bytes = readFileSync(fd)
    const text = bytes.toString('utf8')
    // Decoding would replace invalid sequences, and writing that back rewrites user bytes.
    if (!Buffer.from(text, 'utf8').equals(bytes)) {
      throw new Error(`Refusing to update ${path}: it is not valid UTF-8`)
    }
    return { text, size: opened.size, mtimeMs: opened.mtimeMs }
  } finally {
    closeSync(fd)
  }
}

function composeManagedBlockTarget(
  path: string,
  inspection: InitPathInspection,
  content: ManagedBlockContent,
): { existing: string, candidate: string, read?: ManagedBlockRead } {
  const read = inspection.classification === 'regular'
    ? readManagedBlockTarget(path, inspection)
    : undefined
  const existing = read?.text ?? ''
  return { existing, candidate: composeManagedBlock(existing, content), read }
}

// The lock serializes agent-qa writers only; an editor saving between the read and the rename
// would otherwise be overwritten.
function refuseIfChangedSinceRead(
  path: string,
  inspection: InitPathInspection,
  read: ManagedBlockRead,
): void {
  const now = lstatIfPresent(path)
  if (
    now === undefined || !now.isFile() || now.dev !== inspection.dev || now.ino !== inspection.ino
    || now.size !== read.size || now.mtimeMs !== read.mtimeMs
    || readFileSync(path, 'utf8') !== read.text
  ) {
    throw new Error(
      `Refusing to update ${path}: it changed while it was being updated; rerun to apply the block`,
    )
  }
}

/**
 * Everything `upsertManagedBlock` would refuse, checked without taking its lock or writing
 * so a caller can refuse before its first write. The writer checks it all again
 * under the lock: this answer authorizes nothing.
 */
export function preflightManagedBlock(plan: ManagedBlockUpsertPlan): InitPreflightResult {
  const path = resolve(plan.path)
  const inspection = inspectInitPath(path, resolve(plan.root ?? dirname(path)))
  const lockPath = managedBlockLockPath(path)
  if (lstatIfPresent(lockPath) !== undefined) throw new ManagedBlockLockRefusal(path, lockPath)
  composeManagedBlockTarget(path, inspection, plan.content)
  return { path, classification: inspection.classification }
}

/**
 * Upserts one managed block into a file.
 *
 * Cooperative writers serialize per target on an exclusively created sibling lock. Under it the
 * target is classified and read again, composed, and published through `writeScaffoldFileAtomic`,
 * so a failure leaves either the prior file or the complete new one. A replacement takes the
 * writer's default mode and refuses if the target changed since it was read. An existing lock refuses
 * with `ManagedBlockLockRefusal`; only a lock this call created (same inode) is removed, and it
 * never touches a temporary it did not create.
 */
export function upsertManagedBlock(
  plan: ManagedBlockUpsertPlan,
  hooks: InitFilesystemHooks = {},
): InitFileResult {
  const path = resolve(plan.path)
  const root = resolve(plan.root ?? dirname(path))
  ensureSafeParentDirectories(path, root)
  const lock = acquireManagedBlockLock(path)
  try {
    const inspection = inspectInitPath(path, root)
    const { existing, candidate, read } = composeManagedBlockTarget(path, inspection, plan.content)
    if (candidate === existing) return { path, outcome: 'preserved' }
    if (read === undefined) return writeScaffoldFileAtomic({ path, root, content: candidate }, hooks)
    // No `mode`: the owner-only path removes the destination when its post-rename confirmation
    // fails, which would delete a concurrent save. The file takes the writer's default mode.
    return writeScaffoldFileAtomic(
      { path, root, content: candidate, force: true },
      {
        ...hooks,
        beforeAtomicReplacePublish: (target) => {
          hooks.beforeAtomicReplacePublish?.(target)
          refuseIfChangedSinceRead(target, inspection, read)
        },
      },
    )
  } finally {
    releaseManagedBlockLock(lock)
  }
}

export function upsertManagedGitignoreBlock(
  path: string,
  entries: readonly string[] = TARGET_GITIGNORE_ENTRIES,
): InitFileResult {
  const absolutePath = resolve(path)
  return upsertManagedBlock({
    path: absolutePath,
    root: dirname(absolutePath),
    content: managedGitignoreContent(entries),
  })
}

function checkIgnoreStatus(cwd: string, path: string): number {
  const result = spawnSync(
    'git',
    ['check-ignore', '--no-index', '--quiet', '--', path],
    { cwd, encoding: 'utf8', stdio: 'pipe' },
  )
  if (result.error) throw result.error
  if (result.status === 0 || result.status === 1) return result.status
  throw new Error(
    `Unable to verify .gitignore semantics for "${path}" `
    + `(git check-ignore exited ${result.status ?? 'without status'})`,
  )
}

/**
 * What the run has ALREADY written at the moment a verification refuses.
 *
 * The closing clause of a refusal is a statement of fact about the operator's tree, so it
 * cannot be a constant. Round 9 made `upsertManagedGitignoreBlock` the FIRST write of the
 * run, executed immediately before the target-root verification — from which point the
 * unconditional "no files were changed" was false at that call site, and false of the whole
 * scaffold at the post-loop knowledge-root one. The information is kept and conditioned
 * rather than dropped: an operator deciding whether to re-run needs to know what is on disk.
 */
export type InitWritesSoFar = 'nothing' | 'managed-gitignore' | 'managed-gitignore-and-scaffold'

const UNCHANGED_CLAUSE: Record<InitWritesSoFar, string> = {
  nothing: 'no files were changed',
  'managed-gitignore':
    'the managed .gitignore block was already written; no scaffold files were changed',
  'managed-gitignore-and-scaffold':
    'the managed .gitignore block and the scaffold files were already written; '
    + 'this refusal changed nothing further',
}

function unchangedClause(written: InitWritesSoFar | undefined): string {
  return UNCHANGED_CLAUSE[written ?? 'nothing']
}

function asSentence(clause: string): string {
  return `${clause.charAt(0).toUpperCase()}${clause.slice(1)}.`
}

function gitignoreHasRule(cwd: string, rule: string | undefined): boolean {
  let content: string
  try {
    content = readFileSync(resolve(cwd, '.gitignore'), 'utf8')
  } catch {
    return false
  }
  return content.split(/\r?\n/).some((line) => line.trim() === rule)
}

export function verifyEffectiveGitignore(options: {
  cwd: string
  label: string
  probes: readonly GitignoreProbe[]
  written?: InitWritesSoFar
}): { checked: boolean } {
  const cwd = resolve(options.cwd)
  const unchanged = unchangedClause(options.written)
  const repositoryProbe = spawnSync(
    'git',
    ['rev-parse', '--is-inside-work-tree'],
    { cwd, encoding: 'utf8', stdio: 'pipe' },
  )
  if (repositoryProbe.error) {
    // git absent is the ONE spawn failure that may skip this verification. EACCES, EAGAIN
    // and EMFILE all mean the credential-visibility check did not run, and a safety check
    // that disables itself on an unexpected error is the wrong default in the module whose
    // job is keeping credential files out of commits. `checkIgnoreStatus` already throws
    // here; this now agrees with it.
    if (isErrno(repositoryProbe.error, 'ENOENT')) return { checked: false }
    throw new Error(
      `Unable to verify ${options.label}: git could not be run `
      + `(${repositoryProbe.error.message}). ${asSentence(unchanged)}`,
    )
  }
  if (repositoryProbe.status === null) {
    throw new Error(
      `Unable to verify ${options.label}: git exited without a status`
      + `${repositoryProbe.signal ? ` (signal ${repositoryProbe.signal})` : ''}. `
      + asSentence(unchanged),
    )
  }
  // A non-zero status is git's own ANSWER — "not a git repository" — rather than a failure
  // to ask, so it stays a legitimate skip.
  if (repositoryProbe.status !== 0 || repositoryProbe.stdout.trim() !== 'true') {
    return { checked: false }
  }

  for (const probe of options.probes) {
    const status = checkIgnoreStatus(cwd, probe.path)
    const ignored = status === 0
    if (probe.expected === 'ignored' && !ignored) {
      const fix = gitignoreHasRule(cwd, probe.requiredRule)
        ? `Move "${probe.requiredRule}" after any negation, then rerun agent-qa init`
        : `Add "${probe.requiredRule}" to ${resolve(cwd, '.gitignore')}, then rerun agent-qa init`
      throw new Error(
        `${options.label} is unsafe: "${probe.path}" must be ignored. ${fix}; ${unchanged}.`,
      )
    }
    if (probe.expected === 'visible' && ignored) {
      throw new Error(
        `${options.label} is unsafe: "${probe.path}" must remain commit-visible. `
        + `Remove the rule that ignores it, then rerun agent-qa init; ${unchanged}.`,
      )
    }
  }

  return { checked: true }
}
