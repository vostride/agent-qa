import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'language.label': 'Язык',
  'language.followBrowser': 'Язык браузера ({{language}})',
  'language.help':
    'Сохраняется только в этом браузере. В agent-qa.config.yaml ничего не записывается.',
} satisfies Translation<typeof en>
