import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'language.label': '語言',
  'language.followBrowser': '瀏覽器語言（{{language}}）',
  'language.help': '只會儲存在這個瀏覽器中，不會寫入 agent-qa.config.yaml。',
} satisfies Translation<typeof en>
