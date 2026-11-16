import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'live.preview.loading': 'Connexion à l’aperçu…',
  'live.preview.delayed': 'Aperçu retardé',
  'live.preview.reconnecting': 'Reconnexion…',
  'live.preview.disconnected': 'Déconnecté',
  'live.preview.expired': 'Lien expiré',
  'live.preview.sessionEnded': 'Session terminée',
  'live.preview.runEnded': 'Exécution terminée',
  'live.preview.memberEnded': 'Ce test est terminé, mais l’exécution continue',
  'live.preview.unavailable': 'L’aperçu en direct n’est pas disponible ici',
  'live.preview.noStream':
    'aucun aperçu en direct pour cette cible : la liste des étapes continue d’avancer',
  'live.preview.waitingGaveUp':
    'la vue en direct a été attendue, mais rien n’est arrivé : la liste des étapes continue d’avancer',
  'live.preview.waitingGaveUpLabel': 'abandonné',
  'live.preview.action.reconnect': 'Se reconnecter',
  'live.preview.action.refresh': 'Actualiser',
  'live.preview.action.startFresh': 'Repartir de zéro',
  'live.preview.dotName.green': 'Aperçu en direct opérationnel',
  'live.preview.dotName.amber': 'Aperçu en direct retardé',
  'live.preview.dotName.red': 'Aperçu en direct arrêté',
  'live.preview.dotMeaning.green': 'Les images arrivent du navigateur.',
  'live.preview.dotMeaning.amber':
    'L’image la plus récente est en retard, ou l’aperçu se reconnecte.',
  'live.preview.dotMeaning.red': 'L’aperçu ne reçoit plus d’images.',
  'live.preview.frameTitle': 'aperçu en direct',
  'live.config.targetNotFound':
    'La cible sélectionnée « {{name}} » est introuvable dans la configuration de l’espace de travail',
  'live.config.webTargetMissingUrl': 'Il manque une URL à la cible Web sélectionnée « {{name}} »',
  'live.session.stepFailed': 'Échec de l’étape {{number}} : {{error}}',
  'live.session.stepBusy': 'Étape déjà en cours : {{step}}',
  'live.session.notReady': 'La session en direct n’est pas prête',
  'live.session.busyOrNotReady': 'La session en direct est occupée ou n’est pas prête',
  'live.pane.fallbackTitle': 'Session en direct',
  'live.pane.draft.invalid': 'Brouillon non valide',
  'live.pane.draft.saved': 'Brouillon enregistré',
  'live.pane.draft.unsaved': 'Brouillon non enregistré utilisé',
  'live.pane.runAll': 'Exécuter toutes les étapes',
  'live.pane.stopAll': 'Arrêter toutes les étapes',
  'live.pane.stopping': 'Arrêt…',
  'live.pane.endSession': 'Terminer la session en direct',
  'live.pane.restartSession': 'Redémarrer la session en direct',
  'live.pane.closeLiveMode': 'Fermer le mode en direct',
  'live.pane.startFreshSession': 'Démarrer une nouvelle session',
  'live.pane.hooksStale':
    'L’ordre ou les noms des hooks ont changé après le démarrage de cette session en direct. Continuez avec la session jetable actuelle, ou redémarrez-la pour appliquer les derniers hooks de préparation et de nettoyage.',
  'live.pane.signedOut':
    'L’état d’authentification « {{name}} » de la cible « {{target}} » est introuvable ou illisible : cette session a donc démarré sans connexion. Connectez-vous ici, puis utilisez Enregistrer l’état d’authentification pour le capturer.',
  'live.pane.idleTitle': 'Le mode en direct est lié à une cible',
  'live.pane.idleDescription':
    'Cet espace exécute le brouillon actuel de l’éditeur visuel sur la cible sélectionnée. Les sessions sont jetables, et les modifications du brouillon ne sont conservées que lorsque vous enregistrez le test.',
  'live.pane.connecting': 'Connexion au navigateur…',
  'live.pane.address.startUrl': 'URL de départ configurée',
  'live.pane.address.androidDevice': 'Appareil Android',
  'live.pane.address.iosDevice': 'Appareil iOS',
  'live.pane.address.back': 'Page précédente',
  'live.pane.address.forward': 'Page suivante',
  'live.pane.address.refresh': 'Actualiser la page',
  'live.pane.address.copy': 'Copier l’URL',
  'live.pane.address.copied': 'URL copiée',
  'live.pane.tab.reasoning': 'Raisonnement',
  'live.pane.tab.env': 'Env',
  'live.pane.tab.network': 'Réseau',
  'live.pane.tab.console': 'Console',
  'live.pane.tab.aria': 'Arborescence ARIA',
  'live.pane.hook.noVariables': 'Ce hook n’a émis aucune variable',
  'live.pane.hook.emittedVariables': 'Variables émises',
  'live.pane.hook.noOutputTitle': 'Aucune sortie de hook pour l’instant',
  'live.pane.hook.noOutputDescription':
    'Connectez une session en direct, exécutez un hook de nettoyage ou terminez la session actuelle pour capturer la sortie des hooks.',
  'live.pane.hook.withStatus': '{{name}} ({{status}})',
  'live.pane.test.setupHooks': 'Hooks de préparation',
  'live.pane.test.teardownHooks': 'Hooks de nettoyage',
  'live.pane.test.noSetupHooks': 'Aucun hook de préparation propre au test',
  'live.pane.test.noTeardownHooks': 'Aucun hook de nettoyage propre au test',
  'live.pane.test.steps': 'Étapes',
  'live.pane.test.stepNumber': 'Étape nº {{number}}',
  'live.pane.test.noStepDetail':
    'Ce test n’a encore produit aucun détail d’étape en direct. Exécutez-le depuis la file d’attente pour examiner le raisonnement, la console, le réseau et la sortie des hooks.',
  'live.pane.reasoning.selectTestDescription':
    'Choisissez un test dans la file d’attente en direct pour voir son raisonnement, ses journaux, ses hooks et son activité réseau.',
  'live.pane.reasoning.selectionGone': 'La sélection n’est plus disponible',
  'live.pane.reasoning.selectionGoneDescription':
    'Choisissez une autre étape dans l’éditeur visuel pour examiner son raisonnement.',
  'live.pane.reasoning.empty': 'Aucun raisonnement pour l’instant',
  'live.pane.reasoning.emptyDescription':
    'Exécutez une étape depuis l’éditeur visuel ou utilisez Exécuter toutes les étapes pour alimenter la trace de raisonnement en direct.',
  'live.pane.selectTest': 'Sélectionnez un test pour l’examiner',
  'live.pane.env.selectTestHook':
    'Sélectionnez un hook du test ou exécutez une étape pour examiner les variables et la sortie de runJS',
  'live.pane.env.selectStep':
    'Sélectionnez une étape pour examiner les variables et la sortie de runJS',
  'live.pane.network.hookInTest':
    'Les hooks ne capturent pas l’activité réseau du navigateur. Sélectionnez une étape du test pour examiner les requêtes.',
  'live.pane.network.hook':
    'Les hooks ne capturent pas l’activité réseau du navigateur. Sélectionnez une étape pour examiner les requêtes.',
  'live.pane.network.runTest': 'Exécutez ce test pour examiner son activité réseau',
  'live.pane.network.selectStep': 'Sélectionnez une étape pour examiner l’activité réseau',
  'live.pane.console.runTest': 'Exécutez ce test pour examiner la sortie de la console',
  'live.pane.console.selectStep': 'Sélectionnez une étape pour examiner la sortie de la console',
  'live.authState.save': 'Enregistrer l’état d’authentification',
  'live.authState.replace': 'Remplacer l’état d’authentification',
  'live.authState.openForm': 'Ouvrir le formulaire d’enregistrement de l’état d’authentification',
  'live.authState.description':
    'Capturez la session actuelle du navigateur pour cette cible : cookies, localStorage, IndexedDB et le sessionStorage de ses onglets ouverts.',
  'live.authState.target': 'Cible',
  'live.authState.name': 'Nom de l’état d’authentification',
  'live.authState.nameHint': 'Utilisez des lettres minuscules, des chiffres et des tirets.',
  'live.authState.nameInvalid':
    'Le nom de l’état d’authentification doit être un slug en minuscules.',
  'live.authState.savedForTarget': 'Enregistrés pour cette cible',
  'live.authState.noneSaved': 'Aucun état d’authentification enregistré pour cette cible.',
  'live.authState.willReplace': 'L’état d’authentification existant sera remplacé.',
  'live.authState.saveFailed':
    'Impossible d’enregistrer l’état d’authentification « {{name}} » pour la cible « {{target}} ».',
  'live.run.title': 'Exécution en direct',
  'live.run.noRun': 'Aucune exécution sélectionnée',
  'live.run.noRunDescription': 'Sélectionnez une exécution de test pour la suivre en direct',
  'live.run.cancel': 'Annuler',
  'live.run.cancelling': 'Annulation…',
  'live.run.cancelFailed': 'Impossible d’annuler l’exécution',
  'live.run.viewRunDetail': 'voir le détail de l’exécution',
  'live.run.ended': 'exécution terminée',
  'live.run.over': 'cette exécution est terminée : voir le détail de l’exécution',
  'live.run.metaUnavailable':
    'détails de l’exécution indisponibles ; le flux en direct n’est pas affecté',
  'live.run.gapMarker_one':
    '{{count}} événement manqué (seq {{from}}–{{to}}) : voir le détail de l’exécution',
  'live.run.gapMarker_other':
    '{{count}} événements manqués (seq {{from}}–{{to}}) : voir le détail de l’exécution',
  'live.run.remoteProgress': 'Service distant {{remote}} : {{message}}',
  'live.run.remoteProgressPercent': 'Service distant {{remote}} : {{message}} {{percent}}',
  'live.run.testFallback': 'test {{number}}',
  'live.steps.empty': 'en attente de la première étape',
  'live.steps.memberFallback': 'membre {{number}}',
} satisfies Translation<typeof en>
