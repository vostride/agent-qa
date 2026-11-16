import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'status.passed': '통과',
  'status.failed': '실패',
  'status.timedOut': '시간 초과',
  'status.cancelled': '취소됨',
  'status.healed': '복구됨',
  'status.flaky': '불안정',
  'status.skipped': '건너뜀',
  'status.running': '실행 중',
  'status.pending': '대기 중',
  'status.queued': '대기열',
  'status.unknown': '알 수 없음',
  'status.name.idle': '유휴',
  'status.name.pending': '대기 중',
  'status.name.running': '실행 중',
  'status.name.cancelling': '취소 중',
  'status.name.passed': '통과',
  'status.name.failed': '실패',
  'status.name.healed': '복구됨',
  'status.name.flaky': '불안정',
  'status.name.skipped': '건너뜀',
  'status.name.cancelled': '취소됨',
  'status.name.timeout': '시간 초과',
} satisfies Translation<typeof en>
