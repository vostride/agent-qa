import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'language.label': 'Sprache',
  'language.followBrowser': 'Browsersprache ({{language}})',
  'language.help': 'Nur in diesem Browser gespeichert. In agent-qa.config.yaml wird nichts geschrieben.',
} satisfies Translation<typeof en>
