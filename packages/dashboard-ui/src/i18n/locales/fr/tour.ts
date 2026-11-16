import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'tour.intro.title': 'Bienvenue dans agent-qa',
  'tour.intro.body':
    'agent-qa vous permet d’écrire des tests en langage naturel pour le Web et le mobile. Il les exécute dans un cadre d’assurance qualité strict, apprend des exécutions passées, s’adapte quand l’interface change et vous montre exactement ce qui s’est passé.',
  'tour.llmSetup.title': 'Configurez d’abord votre LLM',
  'tour.runs.title': 'Les exécutions montrent les résultats',
  'tour.runs.body':
    'Les exécutions montrent les résultats, les artefacts et le raisonnement de chaque exécution d’agent-qa.',
  'tour.tests.title': 'Les tests contiennent des vérifications en langage naturel',
  'tour.tests.body':
    'Les tests sont des vérifications en langage naturel qu’agent-qa peut exécuter sur la cible Web ou mobile que vous avez configurée.',
  'tour.suites.title': 'Les suites regroupent des parcours reproductibles',
  'tour.suites.body':
    'Les suites regroupent des vérifications liées en parcours reproductibles quand un seul test ne suffit pas.',
  'tour.hooks.title': 'Les hooks s’exécutent autour des étapes et entre elles',
  'tour.hooks.body':
    'Les hooks peuvent préparer l’environnement, s’exécuter en ligne entre les étapes et faire le nettoyage autour d’un test ou d’une suite.',
  'tour.config.title': 'La configuration pilote l’installation locale',
  'tour.config.body':
    'La configuration définit le modèle, la cible, l’environnement d’exécution et le tableau de bord qu’agent-qa utilise en local.',
  'tour.exampleTest.title': 'Exécutez le test d’exemple qui réussit',
  'tour.exampleTest.body':
    'Ce test généré est la première exécution la plus sûre, car init le crée pour valider votre configuration.',
  'tour.exampleMissing.title': 'Trouvez le test d’exemple qui réussit',
  'tour.exampleMissing.body':
    'agent-qa init crée normalement un test d’exemple qui réussit. Choisissez-le dans Tests quand il est disponible, ou créez-en un plus tard.',
  'tour.runAction.title': 'Cliquez sur Exécuter quand vous êtes prêt',
  'tour.runAction.body':
    'Cliquez sur Exécuter quand vous êtes prêt. La visite reprendra depuis la vue de l’exécution ou la page Exécutions.',
  'tour.liveRun.title': 'Suivez l’exécution en direct',
  'tour.liveRun.body':
    'Le mode en direct montre le test en cours : ses étapes d’un côté et le navigateur à côté.',
  'tour.runDetail.title': 'Examinez le détail de l’exécution',
  'tour.runDetail.body':
    'C’est le moment clé : examinez ce qu’agent-qa a observé, planifié, exécuté et vérifié.',
  'tour.githubNudge.title': 'Si agent-qa vous a aidé',
  'tour.githubNudge.body': 'Si agent-qa vous a aidé, pensez à lui donner une étoile sur GitHub.',
  'tour.githubNudge.actionLabel': 'Voir sur GitHub',
  'tour.runsFallback.title': 'Ouvrez votre dernière exécution',
  'tour.runsFallback.body':
    'Si aucune exécution n’est encore ouverte ici, utilisez Exécutions pour ouvrir la plus récente et examiner sa vue détaillée.',
  'tour.ui.progress': 'Progression de la visite : {{current}} sur {{total}}',
  'tour.ui.skip': 'Passer',
  'tour.ui.restart': 'Recommencer',
  'tour.ui.back': 'Précédent',
  'tour.ui.done': 'Terminer',
  'tour.ui.startTour': 'Commencer la visite',
} satisfies Translation<typeof en>
