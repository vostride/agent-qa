import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'language.label': '言語',
  'language.followBrowser': 'ブラウザーの言語（{{language}}）',
  'language.help':
    'このブラウザーにのみ保存されます。agent-qa.config.yamlには何も書き込まれません。',
} satisfies Translation<typeof en>
