import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'language.label': '언어',
  'language.followBrowser': '브라우저 언어({{language}})',
  'language.help': '이 브라우저에만 저장됩니다. agent-qa.config.yaml에는 아무것도 기록하지 않습니다.',
} satisfies Translation<typeof en>
