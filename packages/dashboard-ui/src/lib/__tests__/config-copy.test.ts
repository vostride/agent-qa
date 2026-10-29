// Every exported Config sentence is non-empty, and connection failures use the shared classifier.

import {
  CONFIG_WRITE_REFUSALS,
  LLM_SETUP_REFUSALS,
  providerErrorSentence as schemaProviderErrorSentence,
} from '@vostride/agent-qa-schema'
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import * as copy from '../config-copy'
import { CONFIG_SECTION_IDS, CONFIG_TABS, EXPLICIT_ACTION_KINDS, MODEL_STATUSES } from '../config-tabs'

function collectStrings(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value)
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, into)
  else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, into)
  }
  return into
}

const deleteKinds = EXPLICIT_ACTION_KINDS.filter(
  (kind): kind is copy.DeleteActionKind => kind.startsWith('delete-'),
)

/** Every function of the module, called over its whole domain with sample names. */
function functionOutputs(): string[] {
  return [
    ...CONFIG_TABS.flatMap((tab) => CONFIG_SECTION_IDS.map((section) => copy.configCommandLabel(tab, section))),
    copy.configLoadFailedBody('The file is not valid YAML'),
    copy.configFileIssuesBody('Step timeout must be a duration such as 30s'),
    ...EXPLICIT_ACTION_KINDS.map((kind) => copy.undoLine(kind, 'gpt')),
    ...deleteKinds.map((kind) => copy.deleteActionName(kind, 'staging')),
    copy.modelLine('gpt-5.6', 'OpenAI-compatible'),
    ...MODEL_STATUSES.flatMap((status) => [
      copy.connectionSentence(status, 'ChatGPT', { signIn: true }),
      copy.connectionSentence(status, 'Gemini', { signIn: false }),
      copy.connectionSentence(status, 'OpenAI-compatible', { signIn: false, keyOptional: true }),
    ]),
    copy.fixedFactsLine('an OpenAI-compatible API key'),
    copy.existingCredentialLine('key', 'gpt'),
    copy.existingCredentialLine('sign-in', 'gpt'),
    copy.nameTakenError('gpt'),
    copy.nameCredentialConflictError('gpt', 'Gemini'),
    copy.signInFailedText('the page was closed'),
    copy.connectedSavedText('gpt'),
    copy.applyActionName('knowledge folder'),
    copy.keepPathName('knowledge folder'),
    copy.replaceValueName('Authorization'),
    copy.saveValueName('Authorization'),
    copy.keepValueName('Authorization'),
    copy.attributeValueLabel('git.branch'),
    copy.removeAttributeName('git.branch'),
    copy.targetNameTakenError('staging'),
    copy.deviceNameTakenError('pixel'),
    copy.deviceMatchKeysHelp('iOS', ['udid', 'bundleId']),
    copy.deviceMatchSettingLabel('pixel', 'serial'),
    copy.removeMatchSettingName('pixel', 'serial'),
  ]
}

const everyString = () => [...collectStrings(Object.values(copy)), ...functionOutputs()]

const GENERIC_BUTTON_WORDS = ['Save', 'Cancel', 'OK', 'Submit', 'Replace', 'Reset', 'Discard', 'Try again']
const OWNER_LOCKED_ONE_WORD = ['Connect', 'Apply', 'Undo', 'Retry']
/** The in-flight label of the owner-locked Connect button, the one word it turns into while busy. */
const BUSY_FORMS: Record<string, string> = { 'Connecting…': 'Connect' }

describe('the Config strings of record', () => {
  it('every exported string is non-empty', () => {
    const strings = everyString()
    expect(strings.length, 'the witness: the walk found the strings').toBeGreaterThan(100)
    for (const text of strings) expect(text.trim(), JSON.stringify(text)).not.toBe('')
  })

  it('the tab labels, status words and model status words are the locked words', () => {
    expect(CONFIG_TABS.map((tab) => copy.CONFIG_TAB_LABELS[tab])).toEqual([
      'Models',
      'Targets',
      'Execution',
      'Project',
      'Advanced',
    ])
    expect(copy.SAVE_STATUS_WORDS).toEqual({
      saving: 'Saving…',
      saved: 'Saved',
      draft: 'Not saved',
      failed: "Couldn't save",
    })
    expect(copy.MODEL_STATUS_WORDS).toEqual({
      'signed-in': 'Signed in',
      'key-saved': 'Key saved',
      'not-connected': 'Not connected',
      'sign-in-expired': 'Sign-in expired',
    })
    expect(copy.RETRY_LABEL).toBe('Retry')
    expect(copy.UNDO_LABEL).toBe('Undo')
    expect(copy.APPLY_LABEL).toBe('Apply')
    expect(copy.CONNECT_LABEL).toBe('Connect')
    expect(copy.DEFAULT_BADGE).toBe('Default')
    expect(copy.ADD_MODEL_LABEL).toBe('Add model')
    expect(copy.CONNECT_FORM_LEGEND).toBe('How do you connect?')
    expect(copy.SAVE_WITHOUT_TESTING_LABEL).toBe('Save without testing')
    expect(Object.keys(copy.CONFIG_SECTION_LABELS)).toEqual([...CONFIG_SECTION_IDS])
  })

  it('the Undo lines name what happened', () => {
    expect(copy.undoLine('delete-model', 'gpt')).toBe('Deleted gpt')
    expect(copy.undoLine('delete-target', 'staging')).toBe('Deleted target staging')
    expect(copy.undoLine('sign-out', 'gpt')).toBe('Signed out of gpt')
    expect(copy.undoLine('remove-key', 'gpt')).toBe('Removed the key for gpt')
    expect(copy.undoLine('change-db-path', 'ignored')).toBe('Changed the database')
    expect(copy.deleteActionName('delete-device', 'pixel')).toBe('Delete device pixel')
    expect(copy.applyActionName('database')).toBe('Apply database')
  })

  it('a passed test says Connected with no milliseconds', () => {
    expect(copy.TEST_RESULT_TEXT.connected).toBe('Connected')
    expect(copy.TEST_RESULT_TEXT.connected).not.toMatch(/\d/)
    expect(copy.TEST_RESULT_TEXT['connected-without-key']).toBe('Connected without a key')
  })

  it('the connection sentences follow the row status and the connection kind', () => {
    expect(copy.connectionSentence('signed-in', 'ChatGPT', { signIn: true })).toBe(
      'Signed in with your ChatGPT plan.',
    )
    expect(copy.connectionSentence('not-connected', 'Gemini', { signIn: false })).toBe('No key saved.')
    expect(copy.connectionSentence('not-connected', 'OpenAI-compatible', { signIn: false, keyOptional: true })).toBe(
      'No key saved. This endpoint may not need one.',
    )
    expect(copy.connectionSentence('not-connected', 'Claude', { signIn: true })).toBe('Not signed in.')
  })

  it('no string carries storage vocabulary', () => {
    for (const text of everyString()) {
      const lower = text.toLowerCase()
      expect(lower, text).not.toContain('bucket')
      expect(lower, text).not.toContain('registry.')
      expect(lower, text).not.toContain('use.')
    }
  })

  it('no button label is a bare generic word, and only four owner-locked words stand alone', () => {
    const labels = Object.entries(copy)
      .filter(([name, value]) => name.endsWith('_LABEL') && typeof value === 'string')
      .map(([, value]) => value as string)
    expect(labels.length, 'the witness: the scan found the labels').toBeGreaterThan(20)
    for (const label of labels) {
      expect(GENERIC_BUTTON_WORDS, label).not.toContain(label)
      if (!label.includes(' ')) expect(OWNER_LOCKED_ONE_WORD, label).toContain(BUSY_FORMS[label] ?? label)
    }
  })

  it('providerErrorSentence is the schema classifier function itself, never re-spelled', () => {
    expect(copy.providerErrorSentence).toBe(schemaProviderErrorSentence)
    const source = readFileSync(new URL('../config-copy.ts', import.meta.url), 'utf-8')
    expect(source).toContain("export { providerErrorSentence } from '@vostride/agent-qa-schema'")
    expect(source).not.toContain('Rate limited. Try again later.')
    expect(source).not.toContain('Authentication failed.')
  })

  // Each line is re-derived from the code that reads its path.
  it('CONSEQUENCE-LINES-PINNED: the three data paths, each with the one sentence the code bears out', () => {
    expect(copy.APPLY_CONSEQUENCES).toEqual({
      'knowledge.dir':
        'New runs and agents use the new folder right away; a running agent-qa daemon switches when it restarts. Nothing in the current folder is moved or deleted.',
      'services.dashboard.dbPath':
        "The dashboard opens the new database when it restarts, and runs in the current one won't show until you switch back. Nothing is moved or deleted.",
      'services.dashboard.artifactsDir':
        'New runs write their working-memory file to the new folder. Earlier runs still show, and nothing is moved or deleted.',
    })
    for (const line of Object.values(copy.APPLY_CONSEQUENCES)) {
      expect(line, line).not.toMatch(/\d/)
      expect(line, line).not.toMatch(/\b(?:screenshots?|recordings?)\b/i)
    }
  })

  it('FIELD-CHANGED-COPY: a computed write the file keeps moving under says the page now shows the file', () => {
    expect(copy.FIELD_CHANGED_TEXT).toBe("This changed in the file. The page now shows the file's value.")
  })

  it('the timing constants', () => {
    expect(copy.SETTLE_DELAY_MS).toBe(1_000)
    expect(copy.SAVED_VISIBLE_MS).toBe(2_000)
    expect(copy.UNDO_WINDOW_MS).toBe(10_000)
    expect(copy.REVISION_POLL_MS).toBe(2_000)
  })
})

describe('The Connect refusal sentences', () => {
  it('CONNECT-REFUSAL-COPY-TOTAL: every code the connect door can answer has its own full sentence', () => {
    const codes = new Set<string>([...LLM_SETUP_REFUSALS, ...CONFIG_WRITE_REFUSALS, 'connect_failed', 'cross_site_refused'])
    expect(new Set(Object.keys(copy.CONNECT_REFUSAL_COPY))).toEqual(codes)
    for (const [code, sentence] of Object.entries(copy.CONNECT_REFUSAL_COPY)) {
      expect(sentence.trim(), code).not.toBe('')
      expect(sentence, code).toMatch(/\.$/)
      expect(sentence, code).not.toBe(schemaProviderErrorSentence('network_error', ''))
    }
  })

  it('CONNECT-REFUSAL-COPY-TOTAL: the network sentence only without a code the map knows; issues follow two codes', () => {
    const network = schemaProviderErrorSentence('network_error', '')
    expect(copy.connectRefusalSentence(undefined)).toBe(network)
    expect(copy.connectRefusalSentence('not_a_code')).toBe(network)
    expect(copy.connectRefusalSentence('toString')).toBe(network)
    expect(copy.connectRefusalSentence('file_invalid')).toBe(copy.CONNECT_REFUSAL_COPY.file_invalid)
    expect(copy.connectRefusalSentence('validation_failed', [])).toBe(copy.CONNECT_REFUSAL_COPY.validation_failed)
    expect(copy.connectRefusalSentence('validation_failed', [{ message: 'Invalid duration' }, { message: 'Second' }])).toBe(
      'The config file has a problem to fix first: Invalid duration',
    )
    expect(copy.connectRefusalSentence('invalid_setup_input', [{ message: 'Invalid URL' }])).toBe(
      'Check the model and base URL: Invalid URL',
    )
    expect(copy.connectRefusalSentence('write_failed', [{ message: 'Ignored' }])).toBe(copy.CONNECT_REFUSAL_COPY.write_failed)
    expect(copy.CONNECT_REFUSAL_COPY.name_invalid).toBe(copy.NAME_RULE_ERROR)
    expect(copy.CONNECT_REFUSAL_COPY.credential_missing).toBe(copy.KEY_REQUIRED_ERROR)
  })
})
