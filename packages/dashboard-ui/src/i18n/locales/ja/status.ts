import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'status.passed': '成功',
  'status.failed': '失敗',
  'status.timedOut': 'タイムアウト',
  'status.cancelled': 'キャンセル済み',
  'status.healed': '修復済み',
  'status.flaky': '不安定',
  'status.skipped': 'スキップ',
  'status.running': '実行中',
  'status.pending': '保留中',
  'status.queued': 'キュー待ち',
  'status.unknown': '不明',
  'status.name.idle': 'アイドル',
  'status.name.pending': '保留中',
  'status.name.running': '実行中',
  'status.name.cancelling': 'キャンセル中',
  'status.name.passed': '成功',
  'status.name.failed': '失敗',
  'status.name.healed': '修復済み',
  'status.name.flaky': '不安定',
  'status.name.skipped': 'スキップ',
  'status.name.cancelled': 'キャンセル済み',
  'status.name.timeout': 'タイムアウト',
} satisfies Translation<typeof en>
