// C432-LIVE-CALLERS-LANES / C432-LIVE-CALLERS (Phase 432 plan 41, D-02/D-14/D-23).
//
// The nine named live callers outside this package: the miniwob bench's product driver, three demo
// lanes, the 413 campaign, the two 394 pty drivers, the 395 ask-road pty driver and the 399 runbook
// gate. None passes the retired `--trust-session`, none answers a y/n prompt, and the drivers refuse
// (exit 86 / `prompt=<offset>`) rather than answer one if it ever renders again. Every drive runs
// against stub or fake children in temp directories; nothing launches a browser, a model or a lane.
//
// These files live in the super-repository and in the owner's miniwob checkout, so most cells need
// that layout, `bash`, `python3` and `expect`. agent-qa's own CI checks out agent-qa alone: there,
// the cells that drive a caller under `demo/` or the miniwob checkout are skipped with a reason the
// file prints (the D-16 mutation proof's pattern), and the cells over agent-qa's own scripts and
// the shipped CLI still run (quick 261002-hyg, 432-41 #8). A missing caller inside a present
// layout is a failure, never a skip.

import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const AGENT_QA_ROOT = resolve(here, '../../../..')
const SUPER_ROOT = resolve(AGENT_QA_ROOT, '..')
const CLI_DIST = join(AGENT_QA_ROOT, 'packages/cli/dist/cli.js')

const CALLERS = {
  miniwob: join(SUPER_ROOT, 'agent-qa-miniwob-bench/src/agent_qa_miniwob_bench/product.py'),
  laneExampleWeb: join(SUPER_ROOT, 'demo/init/scripts/lane-example-web.sh'),
  laneAutomationExercise: join(SUPER_ROOT, 'demo/init/scripts/lane-automation-exercise.sh'),
  laneWaiBad: join(SUPER_ROOT, 'demo/init/scripts/lane-wai-bad.sh'),
  campaign: join(SUPER_ROOT, 'demo/acceptance/413/campaign.sh'),
  fnDriver: join(SUPER_ROOT, 'demo/init/scripts/394-fn-confirm.exp'),
  chatDriver: join(SUPER_ROOT, 'demo/init/scripts/394-chat-arrival.exp'),
  askDriver: join(AGENT_QA_ROOT, 'scripts/395-ask-road-pty.py'),
  runbookGate: join(SUPER_ROOT, 'demo/acceptance/399/399-runbook-gate.sh'),
} as const

const DEMO_CALLERS = [
  'laneExampleWeb', 'laneAutomationExercise', 'laneWaiBad', 'campaign', 'fnDriver', 'chatDriver', 'runbookGate',
] as const satisfies readonly (keyof typeof CALLERS)[]

const DEMO_INIT = join(SUPER_ROOT, 'demo/init')
const LAYOUT_SKIP_REASON =
  existsSync(DEMO_INIT) && existsSync(join(SUPER_ROOT, 'demo/acceptance'))
    ? undefined
    : `agent-qa is not checked out inside the super-repository (no ${DEMO_INIT} or `
      + "demo/acceptance, as in agent-qa's own CI): the seven demo callers (three lanes, the 413 "
      + 'campaign, the two 394 pty drivers, the 399 runbook gate) were NOT driven. Run this file '
      + 'from the super-repository checkout to measure them.'

const MINIWOB_ROOT = join(SUPER_ROOT, 'agent-qa-miniwob-bench')
const MINIWOB_SKIP_REASON = existsSync(MINIWOB_ROOT)
  ? undefined
  : `the owner's miniwob bench checkout (${MINIWOB_ROOT}) is absent: its product driver was NOT read.`

const inLayout = it.skipIf(LAYOUT_SKIP_REASON !== undefined)
const withMiniwob = it.skipIf(MINIWOB_SKIP_REASON !== undefined)

const LIVE_FROM_ZERO = join(AGENT_QA_ROOT, 'scripts/395-live-from-zero.sh')
const LEG6_CHECK = join(AGENT_QA_ROOT, 'scripts/395-leg6-instrument-check.sh')

const RETIRED_FLAG = '--trust-session'
const RETIRED_PROMPT_TEXT =
  'agent-qa: authoring.draft.write needs your approval. Proceed? [y/a/N] (y = once, a = always allow this action class) '
const REFUSED_RETIRED_PROMPT = 86

/** Every run flag a named caller still passes; each must stay declared on the shipped `run`. */
const CALLER_RUN_FLAGS = [
  '--headless', '--detach', '--disable-cache', '--no-parallel', '--excluded-from-outcomes',
  '--screenshot-mode', '--record', '--no-record', '--reporter',
] as const

const LANES = [
  ['lane-example-web.sh', CALLERS.laneExampleWeb, 'tests/example-pass.yaml'],
  ['lane-automation-exercise.sh', CALLERS.laneAutomationExercise, 'tests/automation-exercise/home-smoke.yaml'],
  ['lane-wai-bad.sh', CALLERS.laneWaiBad, 'tests/bad-a11y.yaml'],
] as const

const ZERO_TARGET_CONFIG = `workspace:
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
use:
  llm: judge
  mobile:
    appState: preserve
`

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `agent-qa-432-41-${label}-`))
  roots.push(root)
  return root
}

function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): SpawnSyncReturns<string> {
  return spawnSync(command, [...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    timeout: options.timeout ?? 60_000,
    env: { ...process.env, DO_NOT_TRACK: '1', NO_COLOR: '1', PYTHONDONTWRITEBYTECODE: '1', ...options.env },
  })
}

function binary(name: string): string {
  const found = run('/bin/sh', ['-c', `command -v ${name}`]).stdout.trim()
  expect(found, `${name} must be on PATH for this caller's drive`).not.toBe('')
  return found
}

/** Executable lines only: shell/Tcl/Python `#` comment lines and a leading Python docstring removed. */
function codeLines(path: string): string[] {
  let text = readFileSync(path, 'utf8')
  if (path.endsWith('.py')) text = text.replace(/^(#![^\n]*\n)?\s*"""[\s\S]*?"""/, '')
  return text.split('\n').filter((line) => !line.trimStart().startsWith('#'))
}

function declares(help: string, flag: string): boolean {
  return new RegExp(`(^|\\s)${flag.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}(\\s|,|$)`, 'm').test(help)
}

/** Runs the shipped CLI and names how the child ended, so a kill or a spawn timeout reports its cause. */
function shippedRun(args: readonly string[], cwd: string): { result: SpawnSyncReturns<string>; seen: string } {
  const started = performance.now()
  const result = run(process.execPath, [CLI_DIST, ...args], { cwd })
  const elapsed = Math.round(performance.now() - started)
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code ?? 'none'
  const seen = `agent-qa ${args.join(' ')} ended with status ${result.status}, signal ${result.signal}, `
    + `error ${code}, after ${elapsed} ms; stderr: ${JSON.stringify(result.stderr ?? '')}`
  return { result, seen }
}

let helpCache: { run: string; global: string } | undefined
function shippedHelp(): { run: string; global: string } {
  if (helpCache !== undefined) return helpCache
  expect(existsSync(CLI_DIST), `build the CLI first: ${CLI_DIST}`).toBe(true)
  const cwd = scratch('help')
  const runHelp = shippedRun(['run', '--help'], cwd)
  const globalHelp = shippedRun(['--help'], cwd)
  expect(runHelp.result.status, runHelp.seen).toBe(0)
  expect(globalHelp.result.status, globalHelp.seen).toBe(0)
  helpCache = { run: runHelp.result.stdout, global: globalHelp.result.stdout }
  return helpCache
}

/**
 * A fake `agent-qa chat` behind an `npx` shim, for `394-chat-arrival.exp`. Modes: `clean` answers
 * both turns, `retired` renders the retired approval prompt on turn 1, `redraw` re-renders the REPL
 * prompt on turn 1 with nothing before it. Every line the fake receives is logged.
 */
function chatFixture(): (mode: 'clean' | 'retired' | 'redraw') => { result: SpawnSyncReturns<string>; lines: string[] } {
  const expectBin = binary('expect')
  const dir = scratch('chat')
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const fake = join(dir, 'fake-chat.mjs')
  writeFileSync(fake, [
    "import { appendFileSync } from 'node:fs'",
    'const mode = process.env.FAKE_MODE',
    'const log = process.env.FAKE_LOG',
    "const PROMPT = '\\x1b[1G\\x1b[0J> \\x1b[3G'",
    'process.stdout.write(PROMPT)',
    "let turn = 0, buffered = ''",
    "process.stdin.on('data', (chunk) => {",
    '  buffered += String(chunk)',
    '  let at',
    '  while ((at = buffered.search(/[\\r\\n]/)) >= 0) {',
    '    const line = buffered.slice(0, at)',
    '    buffered = buffered.slice(at + 1)',
    "    if (line === '') continue",
    "    appendFileSync(log, line + '\\n')",
    "    if (line === '/quit') process.exit(0)",
    '    turn += 1',
    "    if (turn === 1 && mode === 'retired') {",
    `      process.stdout.write('\\x1b[1G\\x1b[0J' + ${JSON.stringify(RETIRED_PROMPT_TEXT)})`,
    '      continue',
    '    }',
    "    if (turn === 1 && mode === 'redraw') {",
    '      process.stdout.write(PROMPT)',
    '      continue',
    '    }',
    '    setTimeout(() => {',
    "      if (turn === 1) process.stdout.write('agent-qa: This authoring invocation will execute up to 7 runs.\\r\\nRuns consumed: 0 (previewed up to 7)\\r\\n')",
    "      else process.stdout.write('answer two\\r\\n')",
    '      process.stdout.write(PROMPT)',
    '    }, 100)',
    '  }',
    '})',
    '',
  ].join('\n'))
  const npx = join(bin, 'npx')
  writeFileSync(npx, `#!/bin/sh\nexec "${process.execPath}" "${fake}"\n`)
  chmodSync(npx, 0o755)

  return (mode) => {
    const log = join(dir, `${mode}.log`)
    writeFileSync(log, '')
    const result = run(
      expectBin,
      ['-f', CALLERS.chatDriver, '30', '/dev/null', 'write a test', 'how am I doing'],
      { env: { PATH: `${bin}:${process.env.PATH ?? ''}`, FAKE_MODE: mode, FAKE_LOG: log } },
    )
    return { result, lines: readFileSync(log, 'utf8').split('\n').filter(Boolean) }
  }
}

function verdictField(line: string, name: string): number | undefined {
  const match = new RegExp(`(?:^|\\s)${name}=(-?\\d+)`).exec(line)
  return match === null ? undefined : Number(match[1])
}

describe('C432-LIVE-CALLERS-LAYOUT — the file says which callers it could drive (quick 261002-hyg)', () => {
  it('C432-LIVE-CALLERS-LAYOUT: names every skipped caller group and why, so a skip is never a pass', () => {
    const layout = LAYOUT_SKIP_REASON ?? 'super-repository layout present: every demo caller is driven'
    const miniwob = MINIWOB_SKIP_REASON ?? 'miniwob checkout present: its product driver is read'
    process.stderr.write(`\n[432 external callers] ${layout}\n[432 external callers] ${miniwob}\n`)
    for (const path of [CALLERS.askDriver, LIVE_FROM_ZERO, LEG6_CHECK]) {
      expect(existsSync(path), path).toBe(true)
    }
    if (LAYOUT_SKIP_REASON === undefined) {
      for (const name of DEMO_CALLERS) expect(existsSync(CALLERS[name]), name).toBe(true)
    }
    if (MINIWOB_SKIP_REASON === undefined) expect(existsSync(CALLERS.miniwob), 'miniwob').toBe(true)
  })
})

describe('C432-LIVE-CALLERS-LANES — no live run caller passes the retired trust flag (432-41)', () => {
  it('C432-LIVE-CALLERS-LANES: the shipped run refuses the retired flag and declares every flag the callers pass', () => {
    const { run: runHelp, global } = shippedHelp()
    expect(runHelp).not.toContain(RETIRED_FLAG)
    for (const flag of CALLER_RUN_FLAGS) expect(declares(runHelp, flag), flag).toBe(true)
    expect(declares(global, '--config')).toBe(true)

    const cwd = scratch('refusal')
    const refused = shippedRun(['run', 'tests/none.yaml', RETIRED_FLAG], cwd)
    expect(refused.result.status, refused.seen).not.toBe(0)
    expect(refused.result.stderr, refused.seen).toContain(`unknown option '${RETIRED_FLAG}'`)
    expect(readdirSync(cwd)).toEqual([])
  })

  inLayout.each(LANES)(
    'C432-LIVE-CALLERS-LANES: %s parses and execs the CLI with its test and the passed-through args only',
    (_name, path, testFile) => {
      expect(run('bash', ['-n', path]).status).toBe(0)
      const dir = scratch('lane')
      const stub = join(dir, 'cli.js')
      const argvFile = join(dir, 'argv.json')
      writeFileSync(
        stub,
        "require('node:fs').writeFileSync(process.env.LANE_ARGV_FILE, JSON.stringify(process.argv.slice(2)))\n",
      )

      const result = run('bash', [path, '--headless'], { env: { AGENT_QA_CLI: stub, LANE_ARGV_FILE: argvFile } })

      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(readFileSync(argvFile, 'utf8'))).toEqual(['run', testFile, '--headless'])
      expect(codeLines(path).join('\n')).not.toContain(RETIRED_FLAG)
    },
  )

  inLayout('C432-LIVE-CALLERS-LANES: the 413 campaign parses and runs every leg with no retired flag', () => {
    expect(run('bash', ['-n', CALLERS.campaign]).status).toBe(0)
    const code = codeLines(CALLERS.campaign)
    const runLines = code.filter((line) => /^\s*cli run /.test(line))

    expect(runLines).toHaveLength(2)
    for (const line of runLines) {
      expect(line).not.toContain(RETIRED_FLAG)
      expect(line).toContain('--detach')
    }
    expect(code.join('\n')).not.toContain(RETIRED_FLAG)
    expect(code.join('\n')).not.toMatch(/trustSource=|session\.trustMode/)
  })

  withMiniwob('C432-LIVE-CALLERS-LANES: the miniwob product builds its run argv with no retired flag, every flag declared', () => {
    const python = binary('python3')
    const extract = run(python, ['-c', `
import ast, json, sys
tree = ast.parse(open(sys.argv[1]).read())
out = {'argv': None, 'extra': [], 'flags': None}
const = lambda e: e.value if isinstance(e, ast.Constant) else None
for node in ast.walk(tree):
    if isinstance(node, ast.FunctionDef) and node.name == 'run_goal':
        for sub in ast.walk(node):
            if isinstance(sub, ast.Assign) and isinstance(sub.value, ast.List) and any(isinstance(t, ast.Name) and t.id == 'argv' for t in sub.targets):
                out['argv'] = [const(e) for e in sub.value.elts]
            if isinstance(sub, ast.AugAssign) and isinstance(sub.target, ast.Name) and sub.target.id == 'argv' and isinstance(sub.value, ast.List):
                out['extra'] += [const(e) for e in sub.value.elts]
            if isinstance(sub, ast.Call) and isinstance(sub.func, ast.Attribute) and sub.func.attr == 'append' and isinstance(sub.func.value, ast.Name) and sub.func.value.id == 'argv':
                out['extra'] += [const(a) for a in sub.args]
    if isinstance(node, ast.Dict):
        for k, v in zip(node.keys, node.values):
            if isinstance(k, ast.Constant) and k.value == 'flags' and isinstance(v, ast.List):
                out['flags'] = [const(e) for e in v.elts]
print(json.dumps(out))
`, CALLERS.miniwob])
    expect(extract.status, extract.stderr).toBe(0)
    const found = JSON.parse(extract.stdout) as { argv: (string | null)[]; extra: (string | null)[]; flags: (string | null)[] }

    expect(found.argv).toEqual([
      null, null, '--config', 'agent-qa.config.yaml', 'run', 'tests/episode.yaml',
      '--disable-cache', '--no-parallel', '--excluded-from-outcomes', '--detach',
      '--screenshot-mode', 'every-step',
    ])
    expect(found.extra).toEqual(['--record', '--reporter', 'console', 'stdout-live', 'dashboard', '--no-record'])
    expect(found.flags).toEqual(['--disable-cache', '--no-parallel', '--excluded-from-outcomes', '--detach'])

    const { run: runHelp, global } = shippedHelp()
    const passed = [...found.argv, ...found.extra, ...found.flags].filter(
      (token): token is string => token !== null && token.startsWith('--'),
    )
    expect(passed).not.toContain(RETIRED_FLAG)
    for (const flag of passed) expect(declares(flag === '--config' ? global : runHelp, flag), flag).toBe(true)
  })
})

describe('C432-LIVE-CALLERS — the nine named live callers carry no retired flag and answer no prompt (432-41)', () => {
  inLayout('C432-LIVE-CALLERS: no live caller passes the retired flag; the 399 gate names it only to watch the parser refuse it', () => {
    for (const [name, path] of Object.entries(CALLERS)) {
      if (name === 'miniwob' && MINIWOB_SKIP_REASON !== undefined) continue
      expect(existsSync(path), name).toBe(true)
      if (name === 'runbookGate') continue
      expect(codeLines(path).join('\n'), name).not.toContain(RETIRED_FLAG)
    }

    const gate = codeLines(CALLERS.runbookGate)
    const launches = gate.filter((line) => line.includes('node "$CLI_JS"') && line.includes(RETIRED_FLAG))
    expect(launches).toHaveLength(1)
    expect(launches[0]).toContain('run tests/none.yaml --trust-session')
    expect(gate.join('\n')).toContain("unknown option '--trust-session'")
  })

  inLayout('C432-LIVE-CALLERS: the prompt drivers send nothing but the typed lines', () => {
    const sends = (path: string): string[] =>
      codeLines(path).map((line) => line.trim()).filter((line) => /^send\s/.test(line))

    expect(sends(CALLERS.fnDriver)).toEqual([])
    expect(sends(CALLERS.chatDriver)).toEqual([
      'send -- "$utterance\\r"',
      'send -- "$followup\\r"',
      'send -- "/quit\\r"',
    ])
    for (const driver of [CALLERS.fnDriver, CALLERS.chatDriver]) {
      const code = codeLines(driver).join('\n')
      expect(code).toContain('needs your approval\\. Proceed\\? \\[y/')
      expect(code).toContain(`exit ${REFUSED_RETIRED_PROMPT}`)
    }
    const ask = codeLines(CALLERS.askDriver).join('\n')
    expect(ask).not.toContain('os.write(')
    expect(ask).not.toContain('declined')
  })

  inLayout('C432-LIVE-CALLERS: the fn driver exits with its child status and refuses a retired prompt unanswered', () => {
    const expectBin = binary('expect')
    const dir = scratch('fn')
    const exits = join(dir, 'exits.js')
    const asks = join(dir, 'asks.js')
    const received = join(dir, 'received.txt')
    writeFileSync(exits, "process.stdout.write('done\\n'); process.exit(3)\n")
    writeFileSync(asks, [
      "const { appendFileSync } = require('node:fs')",
      `process.stdout.write(${JSON.stringify('agent-qa: fn:authoring.draft.write needs your approval. Proceed? [y/N] ')})`,
      `process.stdin.on('data', (chunk) => appendFileSync(${JSON.stringify(received)}, String(chunk)))`,
      'setTimeout(() => process.exit(0), 5000)',
      '',
    ].join('\n'))

    const clean = run(expectBin, ['-f', CALLERS.fnDriver, '30', process.execPath, exits])
    expect(clean.status, clean.stdout).toBe(3)
    expect(clean.stdout).toContain('394-fn-confirm: approval prompts seen: 0')

    const prompted = run(expectBin, ['-f', CALLERS.fnDriver, '30', process.execPath, asks])
    expect(prompted.status, prompted.stdout).toBe(REFUSED_RETIRED_PROMPT)
    expect(prompted.stdout).toContain('it was NOT answered')
    expect(existsSync(received)).toBe(false)
  })

  inLayout('C432-LIVE-CALLERS: the chat driver drives a prompt-free session to exit 0 and refuses a retired prompt unanswered', () => {
    const drive = chatFixture()

    const clean = drive('clean')
    expect(clean.result.status, clean.result.stdout).toBe(0)
    expect(clean.result.stdout).toContain('drive complete (disclosure=1 consumed=1 approval-prompts=0)')
    expect(clean.lines).toEqual(['write a test', 'how am I doing', '/quit'])

    const retired = drive('retired')
    expect(retired.result.status, retired.result.stdout).toBe(REFUSED_RETIRED_PROMPT)
    expect(retired.result.stdout).toContain('RENDERED during turn 1')
    expect(retired.lines).toEqual(['write a test'])
  })

  it('C432-LIVE-CALLERS: the ask-road driver writes nothing to the pty and reports a retired prompt by offset', () => {
    const python = binary('python3')
    const dir = scratch('ask')
    const renders = join(dir, 'renders.js')
    const asks = join(dir, 'asks.js')
    const received = join(dir, 'received.txt')
    writeFileSync(renders, [
      "process.stdout.write('configure this project for https://booking.com as target booking-com\\n')",
      "process.stdout.write('  agent-qa.config.yaml\\n@@ -1,2 +1,5 @@\\n')",
      'process.exit(0)',
      '',
    ].join('\n'))
    // The driver runs `node <entry> ask <utterance>`, so the utterance slot (argv[3]) names the record.
    writeFileSync(asks, [
      "const { appendFileSync } = require('node:fs')",
      "process.stdout.write('agent-qa: fn:config.project.scaffold needs your approval. Proceed? [y/N] ')",
      "process.stdin.on('data', (chunk) => appendFileSync(process.argv[3], String(chunk)))",
      'setTimeout(() => process.exit(0), 1500)',
      '',
    ].join('\n'))
    const verdict = (entry: string, utterance: string): string => {
      const result = run(python, [CALLERS.askDriver, dir, entry, utterance, join(dir, 'transcript.txt'), '30'])
      expect(result.status, result.stderr).toBe(0)
      const line = result.stdout.split('\n').find((candidate) => candidate.startsWith('L6-VERDICT')) ?? ''
      expect(line).not.toBe('')
      return line
    }

    const shown = verdict(renders, 'write a test for booking.com checkout')
    expect(verdictField(shown, 'prompt')).toBe(-1)
    expect(verdictField(shown, 'timedout')).toBe(0)
    expect(verdictField(shown, 'status')).toBe(0)
    for (const marker of ['summary', 'files', 'diff']) expect(verdictField(shown, marker), marker).toBeGreaterThanOrEqual(0)
    expect(shown).not.toContain('declined=')

    const asked = verdict(asks, received)
    expect(verdictField(asked, 'prompt')).toBeGreaterThanOrEqual(0)
    expect(verdictField(asked, 'timedout')).toBe(0)
    expect(existsSync(received)).toBe(false)
  })

  inLayout('C432-LIVE-CALLERS: the chat driver keeps its CR-03 refusal of a boundary that crossed nothing', () => {
    const redraw = chatFixture()('redraw')
    expect(redraw.result.status, redraw.result.stdout).toBe(89)
    expect(redraw.result.stdout).toContain("REFUSING turn 1's boundary")
    expect(redraw.lines).toEqual(['write a test'])
  })

  inLayout('C432-LIVE-CALLERS: the fn driver keeps its no-command and timeout exits', () => {
    const expectBin = binary('expect')
    const dir = scratch('fn-retained')
    const hangs = join(dir, 'hangs.js')
    writeFileSync(hangs, 'setTimeout(() => process.exit(0), 30000)\n')

    expect(run(expectBin, ['-f', CALLERS.fnDriver, '30']).status).toBe(96)
    const timedOut = run(expectBin, ['-f', CALLERS.fnDriver, '2', process.execPath, hangs])
    expect(timedOut.status, timedOut.stdout).toBe(97)
    expect(timedOut.stdout).toContain('TIMEOUT after 2 second(s)')
  })

  inLayout('C432-LIVE-CALLERS: the 399 runbook gate asks the live CLI instead of reading the deleted gate source', () => {
    expect(run('bash', ['-n', CALLERS.runbookGate]).status).toBe(0)
    const code = codeLines(CALLERS.runbookGate).join('\n')

    expect(code).not.toContain('policy/gate.ts')
    expect(code).not.toContain('SAFETY_GATE_SRC')
    expect(code).not.toContain('fail-closed: ask in ')
    expect(code).not.toMatch(/commands\/run\\?\.ts:/)
    expect(code).toContain('node "$CLI_JS" run --help')
    expect(code).toContain("grep -F -q -- '--detach'")

    const { run: runHelp } = shippedHelp()
    expect(declares(runHelp, '--detach')).toBe(true)
    expect(runHelp).not.toContain(RETIRED_FLAG)
  })

  it('C432-LIVE-CALLERS: 395-live-from-zero rung 1 expects what the shipped scaffold answers', () => {
    expect(run('bash', ['-n', LIVE_FROM_ZERO]).status).toBe(0)
    const probes = codeLines(LIVE_FROM_ZERO)
      .map((line) => /^probe_gate '([^']*)' (\S+)(?: '([^']*)')?$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map(([, token, expected, carries]) => ({ token: token ?? '', expected: expected ?? '', carries }))

    expect(probes.map((probe) => probe.token)).toEqual([
      '127.0.0.1:8931', '127.0.0.1', 'localhost:8931', 'localhost', 'http://127.0.0.1:8931/form.html',
      '192.168.0.1', 'http://127.1:8931', 'booking.com', 'agent-qa.test',
    ])
    for (const probe of probes) {
      const project = scratch('rung1')
      writeFileSync(join(project, 'agent-qa.config.yaml'), ZERO_TARGET_CONFIG)
      // The script's `write_config` leaves an empty secrets file beside the config.
      writeFileSync(join(project, '.env.secrets.local'), '')
      const answer = run(
        process.execPath,
        [CLI_DIST, 'fn', 'config.project.scaffold', '--input', JSON.stringify({ domain: probe.token })],
        { cwd: project },
      )
      expect(answer.status, `${probe.token}: ${answer.stderr}`).toBe(0)
      const parsed = JSON.parse(answer.stdout.slice(answer.stdout.indexOf('{'))) as { reason?: string; outcome?: string }
      expect(parsed.reason ?? parsed.outcome, probe.token).toBe(probe.expected)
      if (probe.carries !== undefined) expect(answer.stdout, probe.token).toContain(probe.carries)
    }
  }, 240_000)

  it('C432-LIVE-CALLERS: the leg-6 instrument check is green over the prompt-free driver and grade', () => {
    const check = run('bash', [LEG6_CHECK], {
      env: { TMPDIR: scratch('leg6'), L6_CHECK_TIMEOUT: '10' },
      timeout: 150_000,
    })
    expect(check.status, check.stdout + check.stderr).toBe(0)
    expect(check.stdout).toContain('failures 0')
    for (const probe of ['D1', 'D2', 'D3', 'D4', 'G1', 'G2', 'G3', 'G4', 'G5']) {
      expect(check.stdout, probe).toMatch(new RegExp(`ok {4}${probe} `))
    }
  }, 180_000)
})
