import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'status.passed': 'Réussi',
  'status.failed': 'Échoué',
  'status.timedOut': 'Expiré',
  'status.cancelled': 'Annulé',
  'status.healed': 'Réparé',
  'status.flaky': 'Instable',
  'status.skipped': 'Ignoré',
  'status.running': 'En cours',
  'status.pending': 'En attente',
  'status.queued': 'En file d’attente',
  'status.unknown': 'Inconnu',
  'status.name.idle': 'inactif',
  'status.name.pending': 'en attente',
  'status.name.running': 'en cours',
  'status.name.cancelling': 'annulation en cours',
  'status.name.passed': 'réussi',
  'status.name.failed': 'échoué',
  'status.name.healed': 'réparé',
  'status.name.flaky': 'instable',
  'status.name.skipped': 'ignoré',
  'status.name.cancelled': 'annulé',
  'status.name.timeout': 'expiré',
} satisfies Translation<typeof en>
