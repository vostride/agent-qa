import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'language.label': 'Idioma',
  'language.followBrowser': 'Idioma do navegador ({{language}})',
  'language.help':
    'Salvo apenas neste navegador. Nada é gravado no agent-qa.config.yaml.',
} satisfies Translation<typeof en>
