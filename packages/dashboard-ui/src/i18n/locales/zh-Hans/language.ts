import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'language.label': '语言',
  'language.followBrowser': '浏览器语言（{{language}}）',
  'language.help': '仅保存在此浏览器中，不会写入 agent-qa.config.yaml。',
} satisfies Translation<typeof en>
