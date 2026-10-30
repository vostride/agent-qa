import { describe, expect, it } from 'vitest'
import {
  cssComments,
  datesOutsideCode,
  formatHit,
  hashCommentLines,
  isTestPath,
  maskCodeSpans,
  pathPlanningIds,
  planningIdsIn,
  proseHits,
  stringHits,
} from '../planning-ids.js'

const dash = (...parts: string[]) => parts.join('-')
const found = (text: string) => planningIdsIn(text).map((hit) => hit.text)
const DATE = `${'2026'}-10-29`

describe('planningIdsIn', () => {
  it('finds plan numbers, including point phases and plan ranges', () => {
    expect(found(`see ${dash('432', '03')} and ${dash('444.1', '15')}`)).toEqual([
      dash('432', '03'),
      dash('444.1', '15'),
    ])
    expect(found(`after ${dash('407', '26')}/27`)).toEqual([`${dash('407', '26')}/27`])
  })

  it('finds a plan number written with an en dash', () => {
    expect(found(`the ${['432', '03'].join('\u2013')} plan`)).toEqual([
      ['432', '03'].join('\u2013'),
    ])
  })

  it('finds a plan number inside a hyphenated word', () => {
    expect(found(`see ${dash('plan', '432', '03')}`)).toEqual([dash('432', '03')])
  })

  it('finds a planning document named by its plan or phase number', () => {
    expect(found(`see ${dash('432', '03', 'PLAN')}.md`)).toEqual([
      dash('432', '03'),
      dash('432', '03', 'PLAN'),
    ])
    expect(found(`per ${dash('461', '26', 'SUMMARY')}.md`)).toContain(dash('461', '26', 'SUMMARY'))
    expect(found(`in ${dash('461', 'REVIEW')}.md`)).toEqual([dash('461', 'REVIEW')])
    expect(found(`in ${dash('461', 'UI', 'REVIEW')}.md`)).toEqual([dash('461', 'UI', 'REVIEW')])
  })

  it('finds a phase named by its three-digit number', () => {
    expect(found(`since ${'Phase'} 433`)).toEqual([`${'Phase'} 433`])
    expect(found(`in ${'phase'} 137 plan 2`)).toEqual([`${'phase'} 137`])
  })

  it('finds plural and hyphenated phase references', () => {
    expect(found(`${'Phases'} 432 and 433`)).toEqual([`${'Phases'} 432`])
    expect(found(`${dash('phase', '461')} work`)).toEqual([dash('phase', '461')])
  })

  it('finds a path into the planning directory', () => {
    const dir = `.${'planning'}/`
    expect(found(`read ${dir}${'phases'}/x/notes.md`)).toEqual([dir])
  })

  it('finds decision and review labels', () => {
    expect(found(`per ${dash('D', '14')}/${dash('D', '15')}`)).toEqual([
      dash('D', '14'),
      dash('D', '15'),
    ])
    const reviews = `fixes ${dash('WR', '05')}, ${dash('CR', '04')} and ${dash('IN', '09')}`
    expect(found(reviews)).toEqual([dash('WR', '05'), dash('CR', '04'), dash('IN', '09')])
  })

  it('finds threat, gap and finding labels and cell tags', () => {
    const labels = `${dash('T', '401', '13')} ${dash('G', '433', '9')} ${dash('F', '381', '48')}`
    expect(found(labels)).toEqual([
      dash('T', '401', '1'),
      dash('G', '433', '9'),
      dash('F', '381', '4'),
    ])
    expect(found(`cell ${dash('C432', 'NAME')}`)).toEqual([dash('C432', 'N')])
  })

  it('finds the defect ledger number with or without a hash', () => {
    expect(found(`${'WINDOWS'} #111 and ${'WINDOWS'} 112`)).toEqual([
      `${'WINDOWS'} #111`,
      `${'WINDOWS'} 112`,
    ])
  })

  it('finds quick-task labels, requirement labels and the retune marker', () => {
    expect(found(`quick ${dash('261029', '4ht')}`)).toEqual([dash('261029', '4ht')])
    expect(found(`${dash('HONEST', '15')} ${dash('PXH', 'LIVE', '01')}`)).toEqual([
      dash('HONEST', '15'),
      dash('PXH', 'LIVE', '01'),
    ])
    expect(found(`${'RET'}UNE`)).toEqual([`${'RET'}UNE`])
  })

  it('leaves encodings, status codes, sizes, runtime ids and class names alone', () => {
    const data = [
      'UTF-16',
      'SHA-256',
      'ISO-8601',
      'ROUTE-RANGE-206',
      'LAYOUT-BOUNDARY-768',
      'KEYBOARD-ADD-AT-400',
      'SEP-2575',
      'TST-42',
      'RUN-1',
      'TGT-001',
      'R-URL',
      'HISTORY-WRITES-NOTHING',
      'text-red-400',
      `gpt-4o-${DATE}`,
      'v24 and 1.2.3-4',
      'retune the pin',
    ]
    for (const text of data) expect(found(text)).toEqual([])
  })

  it('leaves time zone offsets alone in text and file names', () => {
    for (const text of ['UTC-05', 'at GMT-08']) expect(found(text)).toEqual([])
    expect(pathPlanningIds('fixtures/UTC-05.json')).toEqual([])
  })

  it('reports a span matched by two shapes once', () => {
    expect(planningIdsIn(`per ${dash('WR', '05')}`)).toHaveLength(1)
  })
})

describe('maskCodeSpans', () => {
  it('blanks code span bodies and keeps their length and line breaks', () => {
    const text = 'a `b c` d ``e\nf`` g'
    const masked = maskCodeSpans(text)
    expect(masked).toBe('a `   ` d `` \n `` g')
    expect(masked).toHaveLength(text.length)
  })
})

describe('datesOutsideCode', () => {
  it('finds a date in prose, including one followed by a time', () => {
    expect(datesOutsideCode(`written ${DATE}`).map((hit) => hit.text)).toEqual([DATE])
    expect(datesOutsideCode(`at ${DATE}T00:00Z`).map((hit) => hit.text)).toEqual([DATE])
  })

  it('leaves a date written as code', () => {
    expect(datesOutsideCode(`the protocol \`${DATE}\``)).toEqual([])
  })

  it('pairs a code span across a line break', () => {
    expect(datesOutsideCode(`// \`knowledge\n// ${DATE} rollback\``)).toEqual([])
  })

  it('treats a lone backtick as prose', () => {
    expect(datesOutsideCode(`a \` then ${DATE}`).map((hit) => hit.text)).toEqual([DATE])
  })
})

describe('proseHits and stringHits', () => {
  it('report the line each hit sits on', () => {
    const text = `// first\n// per ${dash('D', '14')} on ${DATE}`
    expect(proseHits({ line: 10, text })).toEqual([
      { line: 11, text: dash('D', '14') },
      { line: 11, text: DATE },
    ])
  })

  it('read no dates in strings', () => {
    expect(stringHits({ line: 3, text: `messages-${DATE} ${dash('D', '14')}` })).toEqual([
      { line: 3, text: dash('D', '14') },
    ])
  })
})

describe('pathPlanningIds', () => {
  it('flags a directory named after a finding and every path under it', () => {
    const dir = dash('f', '381', '48')
    const hits = pathPlanningIds(`packages/web/${dir}/a.ts`)
    expect(hits.map((hit) => hit.path)).toEqual([`packages/web/${dir}`, `packages/web/${dir}`])
    expect(new Set(hits.map((hit) => hit.segment))).toEqual(new Set([dir]))
  })

  it('flags a file name that starts with a phase number', () => {
    expect(pathPlanningIds(`src/__tests__/${'433'}-cells.test.ts`).map((hit) => hit.text)).toEqual([
      `${'433'}-`,
    ])
  })

  it('flags a file name that starts with a plan number', () => {
    expect(pathPlanningIds(`src/${dash('432', '03', 'x')}.ts`).map((hit) => hit.text)).toEqual([
      dash('432', '03'),
      `${'432'}-`,
    ])
  })

  it('flags a phase directory in any case', () => {
    expect(pathPlanningIds(`docs/${'phase'}-433/a.md`)).not.toEqual([])
    expect(pathPlanningIds(`docs/${'PHASE'}_433/a.md`)).not.toEqual([])
  })

  it('flags an upper-case ledger number and label', () => {
    expect(pathPlanningIds(`docs/${'WINDOWS'}-12.txt`)).not.toEqual([])
    expect(pathPlanningIds(`docs/${dash('WR', '05')}.md`)).not.toEqual([])
    expect(pathPlanningIds(`docs/${dash('HONEST', '15')}.md`)).not.toEqual([])
  })

  it('leaves kebab-case names that carry numbers as data', () => {
    for (const path of [
      'packages/web/src/utf-16.ts',
      'packages/core/src/sha-256.ts',
      'packages/web/src/viewport-1280x800.png',
      'packages/web/src/route-range-206.test.ts',
      'packages/web/src/v24.ts',
    ]) {
      expect(pathPlanningIds(path)).toEqual([])
    }
  })

  it('leaves status pages, icons, migrations and numbered or versioned names alone', () => {
    for (const path of [
      'packages/dashboard-ui/public/404.html',
      'icons/512.png',
      'packages/x/migrations/001_init.sql',
      'packages/web/fixtures/step-01.png',
      'docs/screen-10.png',
      '__fixtures__/page-02.html',
      'scripts/node-24.sh',
      'packages/x/ubuntu-22.04.txt',
      'ci/windows-2022.yml',
      'fade-in-200.css',
      'zoom-in-150.ts',
    ]) {
      expect(pathPlanningIds(path)).toEqual([])
    }
  })
})

describe('hashCommentLines', () => {
  it('reads comments in shell and skips the shebang and quoted hashes', () => {
    const text = `#!/usr/bin/env bash\n# one\n# two\necho "# not" '# not' # trailing\n`
    expect(hashCommentLines('scripts/a.sh', text)).toEqual([
      { line: 2, text: '# one\n# two' },
      { line: 4, text: '# trailing' },
    ])
  })

  it('splits paragraphs at blank comment lines', () => {
    expect(hashCommentLines('.gitignore', '# a\n#\n# b\ndist\n')).toEqual([
      { line: 1, text: '# a' },
      { line: 3, text: '# b' },
    ])
  })

  it('reads YAML comments and the shell comments inside a workflow run block', () => {
    const text = [
      '# top',
      'jobs:',
      '  a:',
      '    steps:',
      "      - name: 'x # not'",
      '        run: |',
      '          # inside',
      '          echo "#not"',
      '      - run: echo hi',
    ].join('\n')
    expect(hashCommentLines('.github/workflows/ci.yml', text).map((p) => p.text)).toEqual([
      '# top',
      '# inside',
    ])
  })

  it('reads Dockerfile comments and nothing in other files', () => {
    expect(hashCommentLines('docker/Dockerfile.web', '# base\nFROM node\n')).toEqual([
      { line: 1, text: '# base' },
    ])
    expect(hashCommentLines('package.json', '# not a comment\n')).toEqual([])
  })
})

describe('cssComments', () => {
  it('reads block comments with their first line', () => {
    expect(cssComments('a {}\n/* one\n two */\nb {}')).toEqual([
      { line: 2, text: '/* one\n two */' },
    ])
  })
})

describe('isTestPath', () => {
  it('treats test directories, test names and type tests as tests', () => {
    expect(isTestPath('packages/a/src/__tests__/helper.ts')).toBe(true)
    expect(isTestPath('packages/a/src/run.test.ts')).toBe(true)
    expect(isTestPath('packages/a/src/types.test-d.ts')).toBe(true)
    expect(isTestPath('packages/a/src/testing.ts')).toBe(false)
  })
})

describe('formatHit', () => {
  it('prints the file, line, kind and text on one line', () => {
    expect(formatHit({ file: 'a.ts', line: 3, kind: 'comment', text: 'x\ny' })).toBe(
      'a.ts:3 comment x\\ny',
    )
  })
})
