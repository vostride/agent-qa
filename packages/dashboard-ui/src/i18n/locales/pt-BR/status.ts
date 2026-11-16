import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'status.passed': 'Aprovado',
  'status.failed': 'Com falha',
  'status.timedOut': 'Tempo esgotado',
  'status.cancelled': 'Cancelado',
  'status.healed': 'Reparado',
  'status.flaky': 'Instável',
  'status.skipped': 'Ignorado',
  'status.running': 'Em execução',
  'status.pending': 'Pendente',
  'status.queued': 'Na fila',
  'status.unknown': 'Desconhecido',
  'status.name.idle': 'inativo',
  'status.name.pending': 'pendente',
  'status.name.running': 'em execução',
  'status.name.cancelling': 'cancelando',
  'status.name.passed': 'aprovado',
  'status.name.failed': 'com falha',
  'status.name.healed': 'reparado',
  'status.name.flaky': 'instável',
  'status.name.skipped': 'ignorado',
  'status.name.cancelled': 'cancelado',
  'status.name.timeout': 'tempo esgotado',
} satisfies Translation<typeof en>
