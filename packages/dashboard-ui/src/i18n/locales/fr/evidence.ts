import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'evidence.loading': 'Chargement des données',
  'evidence.incompleteExplanation':
    'preuves incomplètes : cet élément a été enregistré, mais le fichier sauvegardé n’est plus sur le disque.',
  'evidence.recordedOnStep': 'Enregistré à l’étape {{step}}',
  'evidence.explanationWithStep': '{{explanation}} {{step}}',
  'evidence.goToStep': 'Aller à l’étape {{step}}',

  'evidence.retry.variables': 'Recharger les variables',
  'evidence.retry.network': 'Recharger les données réseau',
  'evidence.retry.console': 'Recharger les données de la console',
  'evidence.retry.aria': 'Recharger l’arborescence ARIA',
  'evidence.retry.a11y': 'Recharger les résultats d’accessibilité',
  'evidence.retry.video': 'Recharger l’enregistrement',
  'evidence.retry.frame': 'Recharger la capture d’écran',

  'evidence.variables.empty.title': 'Aucune variable à cette étape',
  'evidence.variables.empty.explanation':
    'Aucune variable n’était définie lors de l’exécution de cette étape.',
  'evidence.variables.notCaptured.title': 'Variables non enregistrées pour cette étape',
  'evidence.variables.notCaptured.explanation':
    'Aucun instantané des variables n’a été sauvegardé pour cette étape.',
  'evidence.variables.unsupported.title':
    'Les variables ne sont pas enregistrées sur cette plateforme',
  'evidence.variables.unsupported.explanation':
    'La plateforme de cette exécution ne permet pas de sauvegarder un instantané des variables.',
  'evidence.variables.unavailable.title': 'Variables indisponibles pour cette exécution',
  'evidence.variables.unavailable.explanation':
    'Les variables n’étaient pas enregistrées lors de cette exécution : il n’y a rien à afficher.',
  'evidence.variables.failed.capture.title': 'Échec de la capture des variables',
  'evidence.variables.failed.capture.explanation':
    'La sauvegarde de l’instantané des variables a échoué pendant l’exécution. Il n’y a rien à réessayer.',
  'evidence.variables.failed.load.title': 'Impossible de charger les variables',
  'evidence.variables.failed.load.explanation':
    'Les variables ont été enregistrées, mais n’ont pas pu être chargées.',
  'evidence.variables.noSelection.title': 'Aucune étape sélectionnée',
  'evidence.variables.noSelection.explanation':
    'Les variables sont affichées par étape. Choisissez une étape dans l’arborescence ou sur la chronologie pour les voir.',

  'evidence.network.empty.title': 'Aucune requête réseau',
  'evidence.network.empty.explanation': 'La page n’a envoyé aucune requête pendant cette étape.',
  'evidence.network.notCaptured.title': 'Réseau non enregistré pour cette étape',
  'evidence.network.notCaptured.explanation':
    'Aucune activité réseau n’a été sauvegardée pour cette étape.',
  'evidence.network.unsupported.title': 'Le réseau n’est pas enregistré sur cette plateforme',
  'evidence.network.unsupported.explanation':
    'La plateforme de cette exécution ne permet pas de capturer les requêtes réseau.',
  'evidence.network.unavailable.title': 'Réseau indisponible pour cette exécution',
  'evidence.network.unavailable.explanation':
    'L’activité réseau n’était pas enregistrée lors de cette exécution. Cela ne signifie pas que l’exécution n’a envoyé aucune requête.',
  'evidence.network.failed.capture.title': 'Échec de la capture réseau',
  'evidence.network.failed.capture.explanation':
    'La capture de l’activité réseau a échoué pendant l’exécution. Il n’y a rien à réessayer.',
  'evidence.network.failed.load.title': 'Impossible de charger les données réseau',
  'evidence.network.failed.load.explanation':
    'Les données existent, mais n’ont pas pu être chargées.',
  'evidence.network.noSelection.title': 'Aucune étape sélectionnée',
  'evidence.network.noSelection.explanation':
    'Les requêtes réseau sont affichées par étape. Choisissez une étape dans l’arborescence ou sur la chronologie pour les voir.',

  'evidence.console.empty.title': 'Aucune sortie de console',
  'evidence.console.empty.explanation': 'La page n’a rien journalisé pendant cette étape.',
  'evidence.console.notCaptured.title': 'Console non enregistrée pour cette étape',
  'evidence.console.notCaptured.explanation':
    'Aucune sortie de console n’a été sauvegardée pour cette étape.',
  'evidence.console.unsupported.title': 'La console n’est pas enregistrée sur cette plateforme',
  'evidence.console.unsupported.explanation':
    'La plateforme de cette exécution ne permet pas de capturer la sortie de la console.',
  'evidence.console.unavailable.title': 'Console indisponible pour cette exécution',
  'evidence.console.unavailable.explanation':
    'La sortie de la console n’était pas enregistrée lors de cette exécution. Cela ne signifie pas que la page n’a rien journalisé.',
  'evidence.console.failed.capture.title': 'Échec de la capture de la console',
  'evidence.console.failed.capture.explanation':
    'La capture de la sortie de la console a échoué pendant l’exécution. Il n’y a rien à réessayer.',
  'evidence.console.failed.load.title': 'Impossible de charger les données de la console',
  'evidence.console.failed.load.explanation':
    'Les données existent, mais n’ont pas pu être chargées.',
  'evidence.console.noSelection.title': 'Aucune étape sélectionnée',
  'evidence.console.noSelection.explanation':
    'La sortie de la console est affichée par étape. Choisissez une étape dans l’arborescence ou sur la chronologie pour la voir.',

  'evidence.aria.empty.title': 'Arborescence d’accessibilité vide',
  'evidence.aria.empty.explanation':
    'L’écran n’exposait aucun élément accessible au moment où cette action a été décidée.',
  'evidence.aria.notCaptured.title': 'Arborescence ARIA non enregistrée pour cette action',
  'evidence.aria.notCaptured.explanation':
    'Aucune arborescence d’accessibilité n’a été sauvegardée pour cette sous-action.',
  'evidence.aria.unsupported.title':
    'L’arborescence ARIA n’est pas enregistrée sur cette plateforme',
  'evidence.aria.unsupported.explanation':
    'La plateforme de cette exécution ne permet pas de capturer une arborescence d’accessibilité.',
  'evidence.aria.unavailable.title': 'Arborescence ARIA indisponible pour cette exécution',
  'evidence.aria.unavailable.explanation':
    'L’arborescence d’accessibilité n’était pas enregistrée lors de cette exécution.',
  'evidence.aria.failed.capture.title': 'Échec de la capture de l’arborescence ARIA',
  'evidence.aria.failed.capture.explanation':
    'La capture de l’arborescence d’accessibilité a échoué pendant l’exécution. Il n’y a rien à réessayer.',
  'evidence.aria.failed.load.title': 'Impossible de charger l’arborescence ARIA',
  'evidence.aria.failed.load.explanation':
    'L’arborescence a été enregistrée, mais n’a pas pu être chargée.',
  'evidence.aria.noSelection.title': 'Aucune sous-action sélectionnée',
  'evidence.aria.noSelection.explanation':
    'L’arborescence d’accessibilité est affichée par sous-action. Choisissez une sous-action dans l’arborescence ou sur la chronologie pour voir ce que le modèle a vu.',

  'evidence.a11y.empty.title': 'Aucune violation d’accessibilité trouvée',
  'evidence.a11y.empty.explanation':
    'Les vérifications ont été exécutées sur cette étape et n’ont rien trouvé à corriger.',
  'evidence.a11y.notCaptured.title':
    'Vérifications d’accessibilité non enregistrées pour cette étape',
  'evidence.a11y.notCaptured.explanation':
    'Aucun résultat d’accessibilité n’a été sauvegardé pour cette étape.',
  'evidence.a11y.unsupported.title':
    'Les vérifications d’accessibilité ne sont pas prises en charge sur cette plateforme',
  'evidence.a11y.unsupported.explanation':
    'La plateforme de cette exécution ne peut pas exécuter de vérifications d’accessibilité.',
  'evidence.a11y.unavailable.title': 'Résultats d’accessibilité indisponibles pour cette exécution',
  'evidence.a11y.unavailable.explanation':
    'Les vérifications d’accessibilité n’étaient pas enregistrées lors de cette exécution. Cela ne signifie pas que l’exécution n’a eu aucune violation.',
  'evidence.a11y.failed.capture.title': 'Les vérifications d’accessibilité n’ont pas pu s’exécuter',
  'evidence.a11y.failed.capture.explanation':
    'Les vérifications ont rencontré une erreur pendant l’exécution : il n’y a donc aucun résultat. Il n’y a rien à réessayer.',
  'evidence.a11y.failed.load.title': 'Impossible de charger les résultats d’accessibilité',
  'evidence.a11y.failed.load.explanation':
    'Les résultats existent, mais n’ont pas pu être chargés.',
  'evidence.a11y.noSelection.title': 'Aucune étape sélectionnée',
  'evidence.a11y.noSelection.explanation':
    'Les résultats d’accessibilité sont affichés par étape. Choisissez une étape dans l’arborescence ou sur la chronologie pour les voir.',

  'evidence.video.empty.title': 'L’enregistrement ne contient pas de vidéo',
  'evidence.video.empty.explanation':
    'Un enregistrement a été sauvegardé pour ce test, mais il ne contient rien à lire.',
  'evidence.video.notCaptured.title': 'Aucun enregistrement pour ce test',
  'evidence.video.notCaptured.explanation':
    'Aucune vidéo n’a été sauvegardée pour ce test. L’onglet Images montre toujours ce que le modèle a vu à chaque décision.',
  'evidence.video.unsupported.title':
    'L’enregistrement n’est pas pris en charge sur cette plateforme',
  'evidence.video.unsupported.explanation':
    'La plateforme de cette exécution n’enregistre pas de vidéo. L’onglet Images montre toujours ce que le modèle a vu à chaque décision.',
  'evidence.video.unavailable.title': 'Enregistrement indisponible pour cette exécution',
  'evidence.video.unavailable.explanation':
    'La vidéo n’était pas enregistrée lors de cette exécution. L’onglet Images montre toujours ce que le modèle a vu à chaque décision.',
  'evidence.video.failed.capture.title': 'Échec de l’enregistrement',
  'evidence.video.failed.capture.explanation':
    'La vidéo n’a pas pu être sauvegardée à la fin de ce test. Il n’y a rien à réessayer. L’onglet Images montre toujours ce que le modèle a vu à chaque décision.',
  'evidence.video.failed.load.title': 'Impossible de charger l’enregistrement',
  'evidence.video.failed.load.explanation':
    'L’enregistrement existe, mais n’a pas pu être chargé. Réessayez ou passez à l’onglet Images.',
  'evidence.video.noSelection.title': 'Aucune étape sélectionnée',
  'evidence.video.noSelection.explanation':
    'L’enregistrement suit la chronologie. Choisissez une étape dans l’arborescence ou sur la chronologie pour s’y placer.',

  'evidence.frame.notCaptured.subAction.title': 'Aucune capture d’écran pour cette action',
  'evidence.frame.notCaptured.subAction.explanation':
    'Aucune capture d’écran n’a été sauvegardée pour cette sous-action.',
  'evidence.frame.notCaptured.step.title': 'Aucune capture d’écran pour cette étape',
  'evidence.frame.notCaptured.step.explanation':
    'Aucune sous-action de cette étape n’a sauvegardé de capture d’écran.',
  'evidence.frame.unavailable.title': 'Capture d’écran indisponible',
  'evidence.frame.failed.load.title': 'Impossible de charger la capture d’écran',
  'evidence.frame.failed.load.explanation':
    'La capture d’écran existe, mais n’a pas pu être chargée.',

  'evidence.tab.variables': 'Variables',
  'evidence.tab.network': 'Réseau',
  'evidence.tab.console': 'Console',
  'evidence.tab.aria': 'Arborescence ARIA',
  'evidence.tab.a11y': 'A11y',
  'evidence.trigger.variables': 'Variables, {{number}}',
  'evidence.trigger.aria': 'Arborescence ARIA, {{number}}',
  'evidence.trigger.consoleErrors_one': 'Console, {{count}} erreur',
  'evidence.trigger.consoleErrors_other': 'Console, {{count}} erreurs',
  'evidence.trigger.consoleMessages_one': 'Console, {{count}} message',
  'evidence.trigger.consoleMessages_other': 'Console, {{count}} messages',
  'evidence.trigger.networkFailed_one': 'Réseau, {{count}} requête en échec',
  'evidence.trigger.networkFailed_other': 'Réseau, {{count}} requêtes en échec',
  'evidence.trigger.networkRequests_one': 'Réseau, {{count}} requête',
  'evidence.trigger.networkRequests_other': 'Réseau, {{count}} requêtes',
  'evidence.trigger.a11yViolations_one': 'A11y, {{count}} violation',
  'evidence.trigger.a11yViolations_other': 'A11y, {{count}} violations',
  'evidence.trigger.absent': '{{tab}} : {{title}}',
  'evidence.signal.console_one':
    '{{count}} erreur de console à l’étape {{step}}. Ouvrir l’onglet Console',
  'evidence.signal.console_other':
    '{{count}} erreurs de console à l’étape {{step}}. Ouvrir l’onglet Console',
  'evidence.signal.network_one':
    '{{count}} requête en échec à l’étape {{step}}. Ouvrir l’onglet Réseau',
  'evidence.signal.network_other':
    '{{count}} requêtes en échec à l’étape {{step}}. Ouvrir l’onglet Réseau',
  'evidence.signal.a11y_one':
    '{{count}} violation d’accessibilité à l’étape {{step}}. Ouvrir l’onglet A11y',
  'evidence.signal.a11y_other':
    '{{count}} violations d’accessibilité à l’étape {{step}}. Ouvrir l’onglet A11y',

  'evidence.drawer.test': 'Test',
  'evidence.drawer.config': 'Configuration',
  'evidence.drawer.testAsWritten': 'Test tel qu’écrit',
  'evidence.drawer.resolvedDefinition': 'Définition résolue',
  'evidence.drawer.suiteMembers': 'Membres de la suite',
  'evidence.drawer.runTests': 'Tests de cette exécution',
  'evidence.drawer.runAttributes': 'Attributs de l’exécution',
  'evidence.drawer.effectiveConfig': 'Configuration effective',
  'evidence.drawer.globalConfigAsWritten': 'Configuration globale telle qu’écrite',
  'evidence.drawer.model': 'Modèle',
  'evidence.drawer.runtime': 'Environnement d’exécution',
  'evidence.drawer.errors': 'Erreurs',
  'evidence.drawer.notCaptured': 'Non capturé',
  'evidence.drawer.configNotCaptured': 'Configuration non capturée',
  'evidence.drawer.unsealedCapture':
    'La capture de la préparation de cette exécution ne s’est pas terminée : le test et la configuration affichés ici peuvent être incomplets.',
  'evidence.drawer.technicalDetails': 'Détails techniques',
  'evidence.drawer.runId': 'ID d’exécution',
  'evidence.drawer.artifactKind': 'Type d’artefact',
  'evidence.drawer.schemaVersion': 'Version du schéma',
  'evidence.drawer.captureSealedAt': 'Capture scellée le',
  'evidence.drawer.copyRunId': 'Copier l’ID d’exécution',
  'evidence.drawer.retry': 'Recharger les détails de l’exécution',
  'evidence.drawer.ranHere': 'Exécuté sur cette machine',
  'evidence.drawer.ranHereOn': 'Exécuté sur cette machine, sur {{deviceType}}',
  'evidence.drawer.deviceType.simulator': 'simulateur',
  'evidence.drawer.deviceType.realDevice': 'appareil réel',
  'evidence.drawer.opensInNewTab': '(s’ouvre dans un nouvel onglet)',
  'evidence.drawer.remote': '{{name}} ({{where}})',
  'evidence.drawer.ranOn': 'Exécuté sur {{remote}}',
  'evidence.drawer.ranOnVersion': 'Exécuté sur {{remote}}, {{version}}',
  'evidence.drawer.lostOn': 'Exécuté sur {{remote}} jusqu’à la perte de la connexion',
  'evidence.drawer.lostOnVersion':
    'Exécuté sur {{remote}}, {{version}}, jusqu’à la perte de la connexion',
  'evidence.drawer.endedOn':
    'Exécuté sur {{remote}} jusqu’à ce que le service distant mette fin à la session',
  'evidence.drawer.endedOnVersion':
    'Exécuté sur {{remote}}, {{version}}, jusqu’à ce que le service distant mette fin à la session',
  'evidence.drawer.couldNotRun': 'Impossible d’exécuter sur {{remote}} : {{reason}}',
  'evidence.drawer.sessionRefused': 'session refusée',
  'evidence.drawer.plugin': 'Plugin {{entry}}',
  'evidence.drawer.pluginSource': 'Plugin {{entry}} ({{source}})',
  'evidence.drawer.sessionPage': 'Page de la session',
  'evidence.drawer.kind.test': 'Test',
  'evidence.drawer.kind.unknown': 'Non enregistré',
  'evidence.drawer.titleFallback': 'Exécution {{id}}',

  'evidence.scope.step': 'Étape {{step}} sur {{total}} · étape entière',
  'evidence.scope.subAction': 'Sous-action nº {{number}} sur {{total}} · étape {{step}}',

  'evidence.artifact.loadingLabel': 'Chargement des données de l’artefact',
  'evidence.artifact.loading': 'Chargement des données de l’artefact…',
  'evidence.artifact.loadFailed': 'Impossible de charger les données de l’artefact',
  'evidence.artifact.loadFailedHelp':
    'Relancez la requête. Si le problème persiste, vérifiez que le serveur du tableau de bord peut lire les artefacts des exécutions.',
  'evidence.artifact.missing':
    'Les données de l’artefact ne sont pas disponibles pour cette exécution',
  'evidence.artifact.missingHelp':
    'Cette exécution n’a pas d’enregistrement d’artefact persistant.',
  'evidence.artifact.none': 'Aucun',
  'evidence.artifact.items_one': '{{count}} élément',
  'evidence.artifact.items_other': '{{count}} éléments',
  'evidence.artifact.fields_one': '{{count}} champ',
  'evidence.artifact.fields_other': '{{count}} champs',
  'evidence.artifact.sectionNotCaptured': '{{section}} : non capturé pour cette exécution.',
  'evidence.artifact.unnamedMember': 'Membre sans nom',
  'evidence.artifact.testId': 'ID du test',
  'evidence.artifact.ref': 'Réf.',
  'evidence.artifact.refId': 'ID de réf.',
  'evidence.artifact.path': 'Chemin',
  'evidence.artifact.target': 'Cible',
  'evidence.artifact.childRun': 'Exécution enfant',
  'evidence.artifact.error': 'Erreur',
  'evidence.artifact.ranAgainst': 'Exécuté sur',
  'evidence.artifact.memberSnapshots': 'Instantanés des membres',
  'evidence.artifact.rawTestYaml': 'YAML brut du test',
  'evidence.artifact.rawMemberYaml': 'YAML brut du membre',
  'evidence.artifact.rawSuiteYaml': 'YAML brut de la suite',
  'evidence.artifact.rawGlobalConfig': 'Configuration globale brute',
  'evidence.artifact.noAttributes': 'Aucun attribut d’exécution',
  'evidence.artifact.noAttributesHelp': 'Cette exécution n’a enregistré aucun attribut.',
  'evidence.artifact.copyJson': 'Copier le JSON',
  'evidence.artifact.copyNamedValue': 'Copier la valeur de {{key}}',
  'evidence.artifact.copyValue': 'Copier la valeur',
} satisfies Translation<typeof en>
