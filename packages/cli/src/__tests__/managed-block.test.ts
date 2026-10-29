// Everything outside a block's marker lines is the user's, byte for byte; bad markers refuse first.

import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  ManagedBlockLockRefusal,
  managedBlockLockPath,
  preflightManagedBlock,
  upsertManagedBlock,
  upsertManagedGitignoreBlock,
  type InitFileResult,
} from '../commands/init-filesystem.js'
import {
  AGENT_QA_INIT_GITIGNORE_BLOCK,
  AGENT_QA_INIT_MARKDOWN_BLOCK,
  ManagedBlockRefusal,
  composeManagedBlock,
  managedBlockMarkers,
  type ManagedBlockContent,
  type ManagedBlockRefusalReason,
} from '../commands/managed-block.js'
import { buildAgentInstructionPointer } from '../commands/knowledge-guide.js'
import { composeManagedGitignore, managedGitignoreContent } from '../commands/scaffold-content.js'

interface Variant {
  readonly name: string
  readonly content: ManagedBlockContent
  readonly regenerated: ManagedBlockContent
  readonly otherSyntaxStart: string
}

const GITIGNORE: Variant = {
  name: 'hash (.gitignore)',
  content: {
    descriptor: AGENT_QA_INIT_GITIGNORE_BLOCK,
    body: ['# Runtime paths managed by agent-qa init.', '.agent-qa/', '.env'],
    target: 'target .gitignore',
  },
  regenerated: {
    descriptor: AGENT_QA_INIT_GITIGNORE_BLOCK,
    body: ['# Runtime paths managed by agent-qa init.', '.agent-qa/', '.env', 'node_modules/'],
    target: 'target .gitignore',
  },
  otherSyntaxStart: '<!-- agent-qa init:start -->',
}

const MARKDOWN: Variant = {
  name: 'html (AGENTS.md)',
  content: {
    descriptor: AGENT_QA_INIT_MARKDOWN_BLOCK,
    body: ['## agent-qa', 'This project is tested with agent-qa.'],
    target: 'AGENTS.md',
  },
  regenerated: {
    descriptor: AGENT_QA_INIT_MARKDOWN_BLOCK,
    body: [
      '## agent-qa',
      'This project is tested with agent-qa.',
      '- Runs: `agent-qa runs list`, then `agent-qa runs overview <runId>`',
    ],
    target: 'AGENTS.md',
  },
  otherSyntaxStart: '# agent-qa init:start',
}

const VARIANTS = [GITIGNORE, MARKDOWN] as const

function rendered(content: ManagedBlockContent): string {
  const { start, end } = managedBlockMarkers(content.descriptor)
  return [start, ...content.body, end].join('\n')
}

// Separator and final newline are the historic append rule: the original is an exact prefix.
const ABSENT_FIXTURES = [
  { name: 'empty file', original: '', separator: '' },
  { name: 'LF with final newline', original: 'first\nsecond\n', separator: '\n' },
  { name: 'no final newline', original: 'first\nno final newline', separator: '\n\n' },
  { name: 'CRLF', original: 'first\r\nsecond\r\n', separator: '\n' },
  { name: 'already blank-line terminated', original: 'first\n\n', separator: '' },
  {
    name: 'Unicode with BOM',
    original: '\uFEFFtitre ✓ 日本語 👩\u200D👩\u200D👧 e\u0301\n',
    separator: '\n',
  },
] as const

// Every fixture is prefix + old block + suffix. The suffix starts at the byte after the end
// marker's text, so it carries that line's own terminator or its absence.
function middleFixtures(variant: Variant): {
  name: string
  prefix: string
  block: string
  suffix: string
}[] {
  const { start, end } = managedBlockMarkers(variant.content.descriptor)
  return [
    {
      name: 'LF, block between user lines',
      prefix: '# user heading\nkeep this\n\n',
      block: [start, 'stale owned line', end].join('\n'),
      suffix: '\n\nuser text after the block\n',
    },
    {
      name: 'CRLF throughout',
      prefix: 'user line one\r\nuser line two\r\n',
      block: [start, 'stale owned line', end].join('\r\n'),
      suffix: '\r\nuser line three\r\n',
    },
    {
      name: 'block is the last line with no final newline',
      prefix: 'user line\n',
      block: [start, 'stale', end].join('\n'),
      suffix: '',
    },
    {
      name: 'Unicode prefix and suffix',
      prefix: '\uFEFF# Überblick ✓ 日本語\n\n👩\u200D👩\u200D👧 family e\u0301\n',
      block: [start, 'ancien contenu ✓', end].join('\n'),
      suffix: '\n\n## Nächster Abschnitt 🚀\ntrailing',
    },
    {
      name: 'mixed endings kept exactly',
      prefix: 'lf line\ncrlf line\r\n',
      block: [start, end].join('\r\n'),
      suffix: '\ncr-free tail\r\n\n',
    },
  ]
}

function refusalOf(run: () => unknown): ManagedBlockRefusal {
  try {
    run()
  } catch (error) {
    if (error instanceof ManagedBlockRefusal) return error
    throw error
  }
  throw new Error('expected a ManagedBlockRefusal, but the composition succeeded')
}

describe('MANAGED-BYTES', () => {
  it('spells the managed-block markers for both comment syntaxes', () => {
    expect(managedBlockMarkers(AGENT_QA_INIT_GITIGNORE_BLOCK)).toEqual({
      start: '# agent-qa init:start',
      end: '# agent-qa init:end',
    })
    expect(managedBlockMarkers(AGENT_QA_INIT_MARKDOWN_BLOCK)).toEqual({
      start: '<!-- agent-qa init:start -->',
      end: '<!-- agent-qa init:end -->',
    })
  })

  describe.each(VARIANTS)('$name', (variant) => {
    it.each(ABSENT_FIXTURES)(
      'appends an absent block after the original bytes ($name)',
      ({ original, separator }) => {
        const composed = composeManagedBlock(original, variant.content)
        expect(composed).toBe(`${original}${separator}${rendered(variant.content)}\n`)
        expect(composed.startsWith(original)).toBe(true)
        expect(composeManagedBlock(composed, variant.content)).toBe(composed)
      },
    )

    it('replaces a middle block in place, keeping every outside byte and the block position', () => {
      for (const fixture of middleFixtures(variant)) {
        const input = `${fixture.prefix}${fixture.block}${fixture.suffix}`
        const composed = composeManagedBlock(input, variant.content)
        expect(composed, fixture.name).toBe(
          `${fixture.prefix}${rendered(variant.content)}${fixture.suffix}`,
        )
        const { start } = managedBlockMarkers(variant.content.descriptor)
        expect(composed.indexOf(start), fixture.name).toBe(fixture.prefix.length)
      }
    })

    it('returns the same bytes when composed a second time', () => {
      for (const fixture of middleFixtures(variant)) {
        const input = `${fixture.prefix}${fixture.block}${fixture.suffix}`
        const once = composeManagedBlock(input, variant.content)
        expect(composeManagedBlock(once, variant.content), fixture.name).toBe(once)
      }
    })

    it('regenerates owned content and changes nothing outside the markers', () => {
      for (const fixture of middleFixtures(variant)) {
        const input = `${fixture.prefix}${fixture.block}${fixture.suffix}`
        const first = composeManagedBlock(input, variant.content)
        const second = composeManagedBlock(first, variant.regenerated)
        expect(second, fixture.name).toBe(
          `${fixture.prefix}${rendered(variant.regenerated)}${fixture.suffix}`,
        )
        expect(composeManagedBlock(second, variant.content), fixture.name).toBe(first)
      }
    })

    it('leaves a differently named block of the same owner untouched', () => {
      const skills = {
        ...variant.content,
        descriptor: { ...variant.content.descriptor, blockName: 'skills' },
        body: ['skills owned line'],
      }
      const skillsBlock = rendered(skills)
      const input = `head\n${skillsBlock}\nmiddle\n`
      const withInit = composeManagedBlock(input, variant.content)
      expect(withInit).toBe(`${input}\n${rendered(variant.content)}\n`)
      const regenerated = composeManagedBlock(withInit, variant.regenerated)
      expect(regenerated.startsWith(`head\n${skillsBlock}\nmiddle\n`)).toBe(true)
      expect(composeManagedBlock(regenerated, skills)).toBe(regenerated)
    })
  })

  it('composes the .gitignore through the shared hash-comment writer', () => {
    const entries = ['.agent-qa/', 'node_modules/', '.env']
    const content = managedGitignoreContent(entries)
    expect(content.descriptor).toEqual(AGENT_QA_INIT_GITIGNORE_BLOCK)
    for (const original of ['', 'dist/\n', 'dist/\n# agent-qa init:start\nold\n# agent-qa init:end\ntail/\n']) {
      expect(composeManagedGitignore(original, entries)).toBe(
        composeManagedBlock(original, content),
      )
    }
    // The fresh bytes are the historic ones, so the scaffold proposal's goldens do not move.
    expect(composeManagedGitignore('dist/\n', entries)).toBe([
      'dist/',
      '',
      '# agent-qa init:start',
      '# Runtime, credential, dependency, and local-only paths managed by agent-qa init.',
      '.agent-qa/',
      'node_modules/',
      '.env',
      '# agent-qa init:end',
      '',
    ].join('\n'))
  })
})

describe('MANAGED-MARKERS', () => {
  describe.each(VARIANTS)('$name', (variant) => {
    const { start, end } = managedBlockMarkers(variant.content.descriptor)
    const cases: { name: string, input: string, reason: ManagedBlockRefusalReason }[] = [
      { name: 'start marker only', input: `a\n${start}\nb\n`, reason: 'unbalanced' },
      { name: 'end marker only', input: `a\n${end}\nb\n`, reason: 'unbalanced' },
      {
        name: 'two starts and one end',
        input: `${start}\n${start}\nx\n${end}\n`,
        reason: 'unbalanced',
      },
      {
        name: 'two complete blocks',
        input: `${start}\none\n${end}\nuser\n${start}\ntwo\n${end}\n`,
        reason: 'duplicate',
      },
      { name: 'inverted pair', input: `${end}\nuser\n${start}\n`, reason: 'inverted' },
      { name: 'indented marker', input: `  ${start}\nx\n${end}\n`, reason: 'ambiguous-marker' },
      {
        name: 'marker with trailing text',
        input: `${start} extra\nx\n${end}\n`,
        reason: 'ambiguous-marker',
      },
      {
        name: 'marker mid-line',
        input: `see ${start} here\n`,
        reason: 'ambiguous-marker',
      },
      {
        name: 'marker followed by a lone carriage return',
        input: `${start}\rx\n${end}\n`,
        reason: 'ambiguous-marker',
      },
      {
        name: 'the other comment syntax spelling this block',
        input: `${variant.otherSyntaxStart}\nx\n`,
        reason: 'ambiguous-marker',
      },
    ]

    it.each(cases)('refuses $name', ({ input, reason }) => {
      const before = `${input}`
      const refusal = refusalOf(() => composeManagedBlock(input, variant.content))
      expect(refusal.reason).toBe(reason)
      expect(refusal.message.startsWith(`Refusing malformed ${variant.content.target}: `)).toBe(true)
      expect(input).toBe(before)
    })

    it('refuses a body that spells its own marker', () => {
      const poisoned = { ...variant.content, body: ['fine', end] }
      expect(refusalOf(() => composeManagedBlock('user\n', poisoned)).reason)
        .toBe('ambiguous-marker')
    })
  })

  it('keeps the historic .gitignore refusal sentences', () => {
    const content = GITIGNORE.content
    expect(() => composeManagedBlock('# agent-qa init:start\n', content)).toThrow(
      'Refusing malformed target .gitignore: expected at most one complete '
      + 'agent-qa init managed block',
    )
    expect(() => composeManagedBlock('# agent-qa init:end\nx\n# agent-qa init:start\n', content))
      .toThrow(
        'Refusing malformed target .gitignore: the agent-qa init managed '
        + 'end marker precedes its start marker',
      )
  })
})

// The filesystem half: validated, locked, atomic publication.

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-managed-block-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// Lock and publication temporaries share the `.agent-qa-init-` infix; none may survive a call.
function writerLeftovers(directory: string): string[] {
  return readdirSync(directory).filter(name => name.includes('.agent-qa-init-'))
}

const INIT_BLOCK = MARKDOWN.content
const SKILLS_BLOCK: ManagedBlockContent = {
  descriptor: { ...AGENT_QA_INIT_MARKDOWN_BLOCK, blockName: 'skills' },
  body: ['- agent-qa-knowledge: read its SKILL.md'],
  target: 'AGENTS.md',
}
const USER_PROSE = '\uFEFF# Project rules ✓\r\n\r\nUse pnpm. 日本語 👩\u200D👩\u200D👧\r\nno final newline'

function thrownBy(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('expected the call to refuse, but it succeeded')
}

describe('MANAGED-ATOMIC', () => {
  it('creates, updates and then preserves, keeping every outside byte', () => {
    const root = tempRoot()
    const path = join(root, 'AGENTS.md')

    expect(upsertManagedBlock({ path, root, content: INIT_BLOCK })).toEqual({
      path,
      outcome: 'created',
    })
    expect(readFileSync(path, 'utf8')).toBe(`${rendered(INIT_BLOCK)}\n`)

    writeFileSync(path, USER_PROSE)
    expect(upsertManagedBlock({ path, root, content: INIT_BLOCK }).outcome).toBe('updated')
    const once = readFileSync(path)
    expect(once.toString('utf8')).toBe(`${USER_PROSE}\n\n${rendered(INIT_BLOCK)}\n`)

    expect(upsertManagedBlock({ path, root, content: INIT_BLOCK }).outcome).toBe('preserved')
    expect(readFileSync(path).equals(once)).toBe(true)

    const middle = `head\r\n${rendered(SKILLS_BLOCK)}\r\n${rendered(INIT_BLOCK)}\r\ntail ✓`
    writeFileSync(path, middle)
    upsertManagedBlock({ path, root, content: MARKDOWN.regenerated })
    expect(readFileSync(path, 'utf8')).toBe(
      `head\r\n${rendered(SKILLS_BLOCK)}\r\n${rendered(MARKDOWN.regenerated)}\r\ntail ✓`,
    )
    expect(writerLeftovers(root)).toEqual([])
  })

  it('names its lock beside the target, inside the managed temporary namespace', () => {
    const root = tempRoot()
    expect(managedBlockLockPath(join(root, 'AGENTS.md')))
      .toBe(join(root, '.AGENTS.md.agent-qa-init-lock.tmp'))
  })

  it('refuses a symlink, hardlink, directory, symlinked parent or out-of-root target untouched', () => {
    const root = tempRoot()
    const outside = tempRoot()
    const victim = join(outside, 'victim.md')
    writeFileSync(victim, 'victim bytes\n')

    const symlinked = join(root, 'linked')
    mkdirSync(symlinked)
    symlinkSync(victim, join(symlinked, 'AGENTS.md'))

    const hardlinked = join(root, 'hard')
    mkdirSync(hardlinked)
    writeFileSync(join(hardlinked, 'AGENTS.md'), 'shared inode\n')
    linkSync(join(hardlinked, 'AGENTS.md'), join(hardlinked, 'OTHER.md'))

    const directory = join(root, 'directory')
    mkdirSync(join(directory, 'AGENTS.md'), { recursive: true })

    const parentLink = join(root, 'parent-link')
    mkdirSync(parentLink)
    symlinkSync(outside, join(parentLink, 'docs'))

    const cases = [
      { root: symlinked, path: join(symlinked, 'AGENTS.md'), pattern: /symbolic link/ },
      { root: hardlinked, path: join(hardlinked, 'AGENTS.md'), pattern: /hard links/ },
      { root: directory, path: join(directory, 'AGENTS.md'), pattern: /directory/ },
      { root: parentLink, path: join(parentLink, 'docs', 'victim.md'), pattern: /symbolic link/ },
      { root: symlinked, path: join(outside, 'victim.md'), pattern: /must be a file inside/ },
    ]
    for (const { root: caseRoot, path, pattern } of cases) {
      expect(() => upsertManagedBlock({ path, root: caseRoot, content: INIT_BLOCK }), path)
        .toThrow(pattern)
      expect(writerLeftovers(caseRoot), path).toEqual([])
    }
    expect(readFileSync(victim, 'utf8')).toBe('victim bytes\n')
    expect(readFileSync(join(hardlinked, 'OTHER.md'), 'utf8')).toBe('shared inode\n')
    expect(lstatSync(join(hardlinked, 'AGENTS.md')).nlink).toBe(2)
    expect(lstatSync(join(symlinked, 'AGENTS.md')).isSymbolicLink()).toBe(true)
    expect(writerLeftovers(outside)).toEqual([])
  })

  it('leaves the prior file whole when publication fails before the rename', () => {
    const root = tempRoot()
    const path = join(root, 'AGENTS.md')
    writeFileSync(path, USER_PROSE)
    const abort = (): never => {
      throw new Error('injected publication abort')
    }

    expect(() => upsertManagedBlock(
      { path, root, content: INIT_BLOCK },
      { beforeAtomicReplacePublish: abort },
    )).toThrow('injected publication abort')
    expect(readFileSync(path, 'utf8')).toBe(USER_PROSE)
    expect(writerLeftovers(root)).toEqual([])

    const absent = join(root, 'NEW.md')
    expect(() => upsertManagedBlock(
      { path: absent, root, content: INIT_BLOCK },
      { beforeExclusivePublish: abort },
    )).toThrow('injected publication abort')
    expect(existsSync(absent)).toBe(false)
    expect(writerLeftovers(root)).toEqual([])

    expect(upsertManagedBlock({ path, root, content: INIT_BLOCK }).outcome).toBe('updated')
    expect(readFileSync(path, 'utf8')).toBe(`${USER_PROSE}\n\n${rendered(INIT_BLOCK)}\n`)
  })

  it('refuses malformed markers and non-UTF-8 bytes without writing or leaving a lock', () => {
    const root = tempRoot()
    const path = join(root, 'AGENTS.md')
    const { start, end } = managedBlockMarkers(INIT_BLOCK.descriptor)
    const duplicate = `${start}\na\n${end}\n${start}\nb\n${end}\n`
    writeFileSync(path, duplicate)
    expect(thrownBy(() => upsertManagedBlock({ path, root, content: INIT_BLOCK })))
      .toBeInstanceOf(ManagedBlockRefusal)
    expect(readFileSync(path, 'utf8')).toBe(duplicate)
    expect(writerLeftovers(root)).toEqual([])

    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])
    writeFileSync(path, latin1)
    expect(() => upsertManagedBlock({ path, root, content: INIT_BLOCK })).toThrow(/UTF-8/)
    expect(readFileSync(path).equals(latin1)).toBe(true)
    expect(writerLeftovers(root)).toEqual([])
  })
})

describe('MANAGED-CONCURRENCY', () => {
  it('serializes cooperative writers per target and loses no block update', () => {
    const root = tempRoot()
    const path = join(root, 'AGENTS.md')
    writeFileSync(path, USER_PROSE)
    const succeeded: ManagedBlockContent[] = []
    let second: unknown

    const first = upsertManagedBlock({ path, root, content: INIT_BLOCK }, {
      beforeAtomicReplacePublish: () => {
        try {
          upsertManagedBlock({ path, root, content: SKILLS_BLOCK })
          succeeded.push(SKILLS_BLOCK)
        } catch (error) {
          second = error
        }
      },
    })
    succeeded.push(INIT_BLOCK)
    expect(first.outcome).toBe('updated')

    // Every writer that reported success still has its block on disk.
    const afterRace = readFileSync(path, 'utf8')
    for (const content of succeeded) expect(afterRace).toContain(rendered(content))
    expect(second).toBeInstanceOf(ManagedBlockLockRefusal)
    expect((second as ManagedBlockLockRefusal).lockPath).toBe(managedBlockLockPath(path))
    expect((second as Error).message).toContain(managedBlockLockPath(path))

    // The refused writer retries once the lock is released, and both blocks stand.
    const retried: InitFileResult = upsertManagedBlock({ path, root, content: SKILLS_BLOCK })
    expect(retried.outcome).toBe('updated')
    expect(readFileSync(path, 'utf8')).toBe(
      `${USER_PROSE}\n\n${rendered(INIT_BLOCK)}\n\n${rendered(SKILLS_BLOCK)}\n`,
    )
    expect(writerLeftovers(root)).toEqual([])
  })

  it('refuses, keeping a concurrent save, when the target changes before publication', () => {
    const root = tempRoot()
    const path = join(root, 'AGENTS.md')
    writeFileSync(path, USER_PROSE)
    const saved = `${USER_PROSE}\nsaved by an editor meanwhile\n`

    expect(() => upsertManagedBlock({ path, root, content: INIT_BLOCK }, {
      beforeAtomicReplacePublish: () => { writeFileSync(path, saved) },
    })).toThrow(/changed while it was being updated/)
    expect(readFileSync(path, 'utf8')).toBe(saved)
    expect(writerLeftovers(root)).toEqual([])

    expect(upsertManagedBlock({ path, root, content: INIT_BLOCK }).outcome).toBe('updated')
    expect(readFileSync(path, 'utf8')).toBe(`${saved}\n${rendered(INIT_BLOCK)}\n`)
  })

  // The owner-only mode path removes the destination when its post-rename confirmation fails,
  // which here would delete a save that replaced the file in that window.
  it.skipIf(process.platform === 'win32')('replaces the file at the writer default mode, never through the owner-only mode path', () => {
    const root = tempRoot()
    const probe = join(root, 'default-mode-probe')
    writeFileSync(probe, '')
    const defaultMode = lstatSync(probe).mode & 0o777
    rmSync(probe)
    for (const mode of [0o600, 0o640, 0o664]) {
      const path = join(root, `AGENTS-${mode.toString(8)}.md`)
      writeFileSync(path, USER_PROSE)
      chmodSync(path, mode)
      const modeApplied: string[] = []
      expect(upsertManagedBlock({ path, root, content: INIT_BLOCK }, {
        afterTemporaryModeApply: (temporary) => { modeApplied.push(temporary) },
      }).outcome).toBe('updated')
      expect(modeApplied).toEqual([])
      expect(lstatSync(path).mode & 0o777).toBe(defaultMode)
    }
    expect(writerLeftovers(root)).toEqual([])
  })

  it('refuses an existing lock it did not create and never removes it', () => {
    const root = tempRoot()
    const path = join(root, 'AGENTS.md')
    writeFileSync(path, USER_PROSE)
    const lock = managedBlockLockPath(path)
    writeFileSync(lock, 'held by an interrupted writer\n')
    const inode = lstatSync(lock).ino

    const refusal = thrownBy(() => upsertManagedBlock({ path, root, content: INIT_BLOCK }))
    expect(refusal).toBeInstanceOf(ManagedBlockLockRefusal)
    expect((refusal as Error).message).toContain(lock)
    expect((refusal as Error).message).toMatch(/delete the lock/)
    expect(readFileSync(lock, 'utf8')).toBe('held by an interrupted writer\n')
    expect(lstatSync(lock).ino).toBe(inode)
    expect(readFileSync(path, 'utf8')).toBe(USER_PROSE)

    // A lock that is a symlink is occupied too: never followed, never removed.
    const outside = tempRoot()
    const victim = join(outside, 'victim')
    writeFileSync(victim, 'victim\n')
    const other = join(root, 'OTHER.md')
    symlinkSync(victim, managedBlockLockPath(other))
    expect(thrownBy(() => upsertManagedBlock({ path: other, root, content: INIT_BLOCK })))
      .toBeInstanceOf(ManagedBlockLockRefusal)
    expect(lstatSync(managedBlockLockPath(other)).isSymbolicLink()).toBe(true)
    expect(readFileSync(victim, 'utf8')).toBe('victim\n')
    expect(existsSync(other)).toBe(false)
  })

  it('never removes a publication temporary it did not create', () => {
    const root = tempRoot()
    const path = join(root, 'AGENTS.md')
    const foreign = join(root, '.AGENTS.md.agent-qa-init-4242-00000000-0000-4000-8000-000000000000.tmp')
    writeFileSync(foreign, 'another writer\n')
    upsertManagedBlock({ path, root, content: INIT_BLOCK })
    upsertManagedBlock({ path, root, content: MARKDOWN.regenerated })
    expect(readFileSync(foreign, 'utf8')).toBe('another writer\n')
    expect(writerLeftovers(root)).toEqual([
      '.AGENTS.md.agent-qa-init-4242-00000000-0000-4000-8000-000000000000.tmp',
    ])
  })

  it('puts the .gitignore upsert on the same locked writer', () => {
    const root = tempRoot()
    const path = join(root, '.gitignore')
    writeFileSync(path, 'dist/\n# agent-qa init:start\nstale\n# agent-qa init:end\nlocal/\n')
    const lock = join(root, '..gitignore.agent-qa-init-lock.tmp')
    writeFileSync(lock, '')
    expect(() => upsertManagedGitignoreBlock(path, ['.agent-qa/'])).toThrow(ManagedBlockLockRefusal)
    expect(readFileSync(path, 'utf8'))
      .toBe('dist/\n# agent-qa init:start\nstale\n# agent-qa init:end\nlocal/\n')

    rmSync(lock)
    expect(upsertManagedGitignoreBlock(path, ['.agent-qa/']).outcome).toBe('updated')
    expect(readFileSync(path, 'utf8')).toBe(
      `dist/\n${rendered(managedGitignoreContent(['.agent-qa/']))}\nlocal/\n`,
    )
    expect(writerLeftovers(root)).toEqual([])
  })
})

// The root pointer through the shared writer, and its write-free preflight.

describe('MANAGED-POINTER', () => {
  const POINTER: ManagedBlockContent = {
    descriptor: AGENT_QA_INIT_MARKDOWN_BLOCK,
    body: buildAgentInstructionPointer(),
    target: 'AGENTS.md',
  }
  const { start, end } = managedBlockMarkers(AGENT_QA_INIT_MARKDOWN_BLOCK)

  it('applies twice to the same bytes, keeping every outside byte', () => {
    const absent = ['', USER_PROSE, `head\n${rendered(SKILLS_BLOCK)}\n`]
    for (const original of absent) {
      const once = composeManagedBlock(original, POINTER)
      expect(once.startsWith(original), original).toBe(true)
      expect(composeManagedBlock(once, POINTER), original).toBe(once)
    }
    const prefix = `${USER_PROSE}\r\n`
    const suffix = '\r\ntail ✓'
    const once = composeManagedBlock(`${prefix}${start}\r\nstale\r\n${end}${suffix}`, POINTER)
    expect(once).toBe(`${prefix}${rendered(POINTER)}${suffix}`)
    expect(composeManagedBlock(once, POINTER)).toBe(once)
  })

  it('preflights what the writer would refuse, with no lock, temporary or write', () => {
    const root = tempRoot()
    const path = join(root, 'AGENTS.md')
    const cases: { name: string; arrange: () => void; refusal: RegExp | typeof ManagedBlockRefusal }[] = [
      { name: 'duplicate', arrange: () => writeFileSync(path, `${start}\na\n${end}\n${start}\nb\n${end}\n`), refusal: ManagedBlockRefusal },
      { name: 'non-UTF-8', arrange: () => writeFileSync(path, Buffer.from([0x63, 0xe9, 0x0a])), refusal: /UTF-8/ },
      {
        name: 'hard link',
        arrange: () => {
          writeFileSync(path, 'shared\n')
          linkSync(path, join(root, 'OTHER.md'))
        },
        refusal: /hard links/,
      },
      {
        name: 'symbolic link',
        arrange: () => {
          writeFileSync(join(root, 'target.md'), 'target\n')
          symlinkSync(join(root, 'target.md'), path)
        },
        refusal: /symbolic link/,
      },
    ]
    for (const { name, arrange, refusal } of cases) {
      rmSync(root, { recursive: true, force: true })
      mkdirSync(root)
      arrange()
      const before = readdirSync(root).sort().map(entry => [entry, lstatSync(join(root, entry)).ino])
      expect(() => preflightManagedBlock({ path, root, content: POINTER }), name).toThrow(refusal)
      expect(readdirSync(root).sort().map(entry => [entry, lstatSync(join(root, entry)).ino]), name).toEqual(before)
    }

    rmSync(root, { recursive: true, force: true })
    mkdirSync(root)
    writeFileSync(path, USER_PROSE)
    const lock = managedBlockLockPath(path)
    writeFileSync(lock, 'another writer\n')
    expect(() => preflightManagedBlock({ path, root, content: POINTER })).toThrow(ManagedBlockLockRefusal)
    expect(readFileSync(lock, 'utf8')).toBe('another writer\n')

    rmSync(lock)
    expect(preflightManagedBlock({ path, root, content: POINTER })).toEqual({ path, classification: 'regular' })
    expect(readFileSync(path, 'utf8')).toBe(USER_PROSE)
    expect(writerLeftovers(root)).toEqual([])
    const absentPath = join(root, 'NEW.md')
    expect(preflightManagedBlock({ path: absentPath, root, content: POINTER }))
      .toEqual({ path: absentPath, classification: 'missing' })
    expect(existsSync(absentPath)).toBe(false)
  })
})
