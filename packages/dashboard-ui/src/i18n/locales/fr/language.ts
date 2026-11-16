import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'language.label': 'Langue',
  'language.followBrowser': 'Langue du navigateur ({{language}})',
  'language.help':
    'Enregistré dans ce navigateur uniquement. Rien n’est écrit dans agent-qa.config.yaml.',
} satisfies Translation<typeof en>
