import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'insights.title': 'Statistiques',
  'insights.description':
    'Fiabilité, coût et signaux du curateur sur toute la période, avec une section de comparaison distincte pour les tests, les suites et les plateformes.',
  'insights.scope.label': 'Périmètre des exécutions',
  'insights.scope.scoped': 'Dans le périmètre',
  'insights.scope.all': 'Toutes les exécutions',
  'insights.window.label': 'Période',
  'insights.window.oneDay': '1 j',
  'insights.window.sevenDays': '7 j',
  'insights.window.thirtyDays': '30 j',
  'insights.window.all': 'Toute la période',
  'insights.refreshing': 'Actualisation de la plage sélectionnée',
  'insights.unavailable.title': 'Statistiques indisponibles',
  'insights.unavailable.description':
    'Actualisez la page. Si le problème persiste, changez de période et vérifiez que les données d’analyse sont disponibles.',
  'insights.empty.title': 'Aucune exécution sur cette période',
  'insights.empty.description':
    'Exécutez ou relancez des tests pour alimenter les statistiques. Si vous attendez des données plus anciennes, passez à 30 j ou à Toute la période.',
  'insights.empty.action': 'Ouvrir les exécutions',
  'insights.refreshFailed.window':
    'La dernière actualisation a échoué. La période sélectionnée précédente est affichée à la place.',
  'insights.refreshFailed.range':
    'La dernière actualisation a échoué. La plage sélectionnée précédente est affichée à la place.',
  'insights.metric.totalRuns': 'Total des exécutions',
  'insights.metric.runsPerDay.window_one': '{{count}} exécution par jour actif sur cette période.',
  'insights.metric.runsPerDay.window_other':
    '{{count}} exécutions par jour actif sur cette période.',
  'insights.metric.runsPerDay.range_one': '{{count}} exécution par jour actif sur cette plage.',
  'insights.metric.runsPerDay.range_other': '{{count}} exécutions par jour actif sur cette plage.',
  'insights.metric.scopedRunsPerDay.window_one':
    '{{count}} exécution du périmètre par jour actif sur cette période.',
  'insights.metric.scopedRunsPerDay.window_other':
    '{{count}} exécutions du périmètre par jour actif sur cette période.',
  'insights.metric.scopedRunsPerDay.range_one':
    '{{count}} exécution du périmètre par jour actif sur cette plage.',
  'insights.metric.scopedRunsPerDay.range_other':
    '{{count}} exécutions du périmètre par jour actif sur cette plage.',
  'insights.metric.passRate': 'Taux de réussite',
  'insights.metric.passedOutOf_one':
    '{{count}} exécution réussie sur les {{decided}} qui ont réussi ou échoué.',
  'insights.metric.passedOutOf_other':
    '{{count}} exécutions réussies sur les {{decided}} qui ont réussi ou échoué.',
  'insights.metric.scopedPassedOutOf_one':
    '{{count}} exécution du périmètre réussie sur les {{decided}} qui ont réussi ou échoué.',
  'insights.metric.scopedPassedOutOf_other':
    '{{count}} exécutions du périmètre réussies sur les {{decided}} qui ont réussi ou échoué.',
  'insights.metric.avgDuration': 'Durée moyenne',
  'insights.metric.avgDurationDescription':
    'Durée moyenne des exécutions terminées sur la plage sélectionnée.',
  'insights.metric.flakeRate': 'Taux d’instabilité',
  'insights.metric.flakeRateDescription_one':
    '{{count}} exécution échouée ; les comportements réparés ou instables sont suivis à part.',
  'insights.metric.flakeRateDescription_other':
    '{{count}} exécutions échouées ; les comportements réparés ou instables sont suivis à part.',
  'insights.passRate.title': 'Taux de réussite',
  'insights.passRate.description': 'Évolution des résultats réussis sur la période sélectionnée.',
  'insights.duration.title': 'Durée',
  'insights.duration.description':
    'Durée moyenne des exécutions par jour sur la période sélectionnée.',
  'insights.chart.passRate': 'Taux de réussite',
  'insights.chart.duration': 'Durée',
  'insights.breakdown.test': 'Test',
  'insights.breakdown.suite': 'Suite',
  'insights.breakdown.platform': 'Plateforme',
  'insights.breakdown.testTitle': 'Répartition par test',
  'insights.breakdown.suiteTitle': 'Répartition par suite',
  'insights.breakdown.platformTitle': 'Répartition par plateforme',
  'insights.breakdown.description':
    'Comparez la fiabilité dans une section inférieure dédiée, pour que le résumé de la période reste stable.',
  'insights.breakdown.refreshFailed':
    'Impossible d’actualiser la comparaison. Les résultats précédents sont affichés.',
  'insights.breakdown.updating': 'Mise à jour de la comparaison',
  'insights.breakdown.comparison': 'Comparaison : {{label}}',
  'insights.breakdown.breakDownBy': 'Répartir par',
  'insights.breakdown.unavailable.title': 'Répartition indisponible',
  'insights.breakdown.unavailable.description':
    'Actualisez la page ou choisissez une autre période pour recharger la comparaison sélectionnée.',
  'insights.breakdown.empty.test': 'Aucune donnée de test sur cette période',
  'insights.breakdown.empty.suite': 'Aucune donnée de suite sur cette période',
  'insights.breakdown.empty.platform': 'Aucune donnée de plateforme sur cette période',
  'insights.breakdown.empty.description': 'Essayez une autre répartition ou élargissez la période.',
  'insights.breakdown.column.runs': 'Exécutions',
  'insights.breakdown.column.passed': 'Réussies',
  'insights.breakdown.column.failed': 'Échouées',
  'insights.breakdown.column.passRate': 'Taux de réussite',
  'insights.breakdown.column.flakeRate': 'Taux d’instabilité',
  'insights.breakdown.column.avgDuration': 'Durée moyenne',
  'insights.tokens.title': 'Utilisation des jetons',
  'insights.tokens.description':
    'Activité des modèles sur toute la période, indépendamment du sélecteur de répartition.',
  'insights.tokens.total': 'Total des jetons',
  'insights.tokens.input': 'Entrée',
  'insights.tokens.output': 'Sortie',
  'insights.tokens.tooltipTotal': 'Total',
  'insights.tokens.byModel': 'Par modèle',
  'insights.tokens.activeModels_one': 'Entrée et sortie pour {{count}} modèle actif',
  'insights.tokens.activeModels_other': 'Entrée et sortie pour {{count}} modèles actifs',
  'insights.tokens.testRuns': 'Exécutions de tests',
  'insights.tokens.liveEditor': 'Éditeur en direct',
  'insights.tokens.notRecorded': 'Non enregistré',
  'insights.tokens.unmeasuredSteps_one':
    '{{count}} étape d’exécution de test n’a enregistré aucune utilisation de jetons et n’est pas comptée.',
  'insights.tokens.unmeasuredSteps_other':
    '{{count}} étapes d’exécution de test n’ont enregistré aucune utilisation de jetons et ne sont pas comptées.',
  'insights.tokens.empty.title': 'Aucune utilisation de jetons sur cette période',
  'insights.tokens.empty.description':
    'Les mesures de jetons apparaissent une fois que des exécutions ou des sessions en direct font appel aux modèles.',
  'insights.memory.title': 'Curateur de mémoire',
  'insights.memory.description':
    'Modifications des connaissances enregistrées par la curation pour les exécutions de la période sélectionnée.',
  'insights.memory.reading': 'Lecture des modifications de curation de cette période.',
  'insights.memory.noAgentHost':
    'Impossible de lire les modifications de curation : ce tableau de bord a été démarré sans hôte d’agent.',
  'insights.memory.unreadable':
    'Impossible de lire les modifications de curation de cette période. Actualisez la page pour réessayer.',
  'insights.memory.empty.title': 'Aucune activité du curateur de mémoire sur cette période',
  'insights.memory.empty.description':
    'Les mesures de mémoire apparaissent une fois que des exécutions créent ou confirment des observations.',
  'insights.memory.truncated_one':
    'Seules les {{read}} dernières exécutions sur {{count}} de cette période ont été comptées ; les plus anciennes n’ont pas été lues.',
  'insights.memory.truncated_other':
    'Seules les {{read}} dernières exécutions sur {{count}} de cette période ont été comptées ; les plus anciennes n’ont pas été lues.',
  'insights.memory.runsUnreadable_one':
    'Impossible de lire la curation de {{affected}} sur {{count}} exécution ; ses modifications ne sont pas comptées.',
  'insights.memory.runsUnreadable_other':
    'Impossible de lire la curation de {{affected}} sur {{count}} exécutions ; leurs modifications ne sont pas comptées.',
  'insights.memory.curationFailed_one':
    'La curation a échoué pour {{affected}} sur {{count}} exécution ; ses modifications ne sont pas comptées.',
  'insights.memory.curationFailed_other':
    'La curation a échoué pour {{affected}} sur {{count}} exécutions ; leurs modifications ne sont pas comptées.',
  'insights.memory.curationUnfinished_one':
    'La curation n’est pas terminée pour {{affected}} sur {{count}} exécution ; ses modifications ne sont pas encore comptées.',
  'insights.memory.curationUnfinished_other':
    'La curation n’est pas terminée pour {{affected}} sur {{count}} exécutions ; leurs modifications ne sont pas encore comptées.',
  'insights.memory.inFlight_one':
    '{{count}} exécution de cette période n’est pas encore terminée et n’est pas comptée.',
  'insights.memory.inFlight_other':
    '{{count}} exécutions de cette période ne sont pas encore terminées et ne sont pas comptées.',
  'insights.memory.changes': 'Modifications',
  'insights.memory.runsRead': 'Exécutions lues',
  'insights.memory.runsReadValue': '{{read}} sur {{total}}',
  'insights.memory.changeMix': 'Répartition des modifications',
  'insights.memory.kind.added': 'Ajouté',
  'insights.memory.kind.confirmed': 'Confirmé',
  'insights.memory.kind.promoted': 'Promu',
  'insights.memory.kind.superseded': 'Remplacé',
  'insights.memory.kind.deprecated': 'Obsolète',
  'insights.memory.noChanges_one':
    'Aucune modification trouvée : curation terminée pour {{count}} exécution.',
  'insights.memory.noChanges_other':
    'Aucune modification trouvée : curation terminée pour {{count}} exécutions.',
  'insights.memory.noFinishedCuration':
    'Aucune exécution de cette période n’a de curation terminée à compter.',
} satisfies Translation<typeof en>
