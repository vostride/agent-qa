import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'status.passed': '通過',
  'status.failed': '失敗',
  'status.timedOut': '逾時',
  'status.cancelled': '已取消',
  'status.healed': '已修復',
  'status.flaky': '不穩定',
  'status.skipped': '已略過',
  'status.running': '執行中',
  'status.pending': '擱置中',
  'status.queued': '佇列中',
  'status.unknown': '未知',
  'status.name.idle': '閒置',
  'status.name.pending': '擱置中',
  'status.name.running': '執行中',
  'status.name.cancelling': '正在取消',
  'status.name.passed': '通過',
  'status.name.failed': '失敗',
  'status.name.healed': '已修復',
  'status.name.flaky': '不穩定',
  'status.name.skipped': '已略過',
  'status.name.cancelled': '已取消',
  'status.name.timeout': '逾時',
} satisfies Translation<typeof en>
