import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'config.tabs.models': 'Modèles',
  'config.tabs.targets': 'Cibles',
  'config.tabs.execution': 'Exécution',
  'config.tabs.project': 'Projet',
  'config.tabs.advanced': 'Avancé',
  'config.sections.models': 'Modèles',
  'config.sections.screenshotSize': 'Taille des captures d’écran',
  'config.sections.plannerLimits': 'Limites du planificateur',
  'config.sections.targets': 'Cibles',
  'config.sections.remotes': 'Services distants',
  'config.sections.devices': 'Appareils',
  'config.sections.loginStates': 'États d’authentification enregistrés',
  'config.sections.mobileAppState': 'État de l’application mobile',
  'config.sections.browser': 'Navigateur',
  'config.sections.timeouts': 'Délais d’expiration',
  'config.sections.runs': 'Exécutions parallèles',
  'config.sections.cache': 'Cache',
  'config.sections.recording': 'Enregistrement',
  'config.sections.accessibility': 'Accessibilité',
  'config.sections.logCapture': 'Capture des journaux',
  'config.sections.testDiscovery': 'Découverte des tests',
  'config.sections.files': 'Fichiers de hooks, d’environnement et de secrets',
  'config.sections.knowledge': 'Base de connaissances',
  'config.sections.dashboard': 'Tableau de bord',
  'config.sections.logging': 'Journalisation',
  'config.sections.passRateScope': 'Périmètre du taux de réussite',
  'config.sections.mcp': 'Accès MCP',
  'config.sections.configFile': 'Fichier de configuration',
  'config.saveStatus.saving': 'Enregistrement…',
  'config.saveStatus.saved': 'Enregistré',
  'config.saveStatus.draft': 'Non enregistré',
  'config.saveStatus.failed': 'Échec de l’enregistrement',
  'config.modelStatus.signedIn': 'Connecté',
  'config.modelStatus.keySaved': 'Clé enregistrée',
  'config.modelStatus.notConnected': 'Non connecté',
  'config.modelStatus.signInExpired': 'Connexion expirée',
  'config.providerFallback.openaiCompatible': 'Compatible OpenAI',
  'config.providerFallback.anthropicCompatible': 'Compatible Anthropic',
  'config.providerFallback.openaiSubscription': 'Abonnement ChatGPT',
  'config.providerFallback.anthropicSubscription': 'Abonnement Claude',
  'config.fixedConnection.openaiSubscription': 'votre abonnement ChatGPT',
  'config.fixedConnection.anthropicSubscription': 'votre abonnement Claude',
  'config.fixedConnection.openaiCompatible': 'une clé d’API compatible OpenAI',
  'config.fixedConnection.anthropicCompatible': 'une clé ou un jeton compatible Anthropic',
  'config.fixedConnection.gemini': 'une clé d’API Gemini',
  'config.modelSetting.vision': 'Vision',
  'config.modelSetting.contextWindow': 'Fenêtre de contexte',
  'config.modelSettingHelp.vision':
    'Indique si ce modèle peut lire des captures d’écran. Désactivez cette option pour les modèles texte uniquement.',
  'config.modelSettingHelp.contextWindow': 'Une taille comme 256k. Laissez vide pour la détecter.',
  'config.headerField.name': 'Nom',
  'config.headerField.value': 'Valeur',
  'config.testResult.testing': 'Test de la connexion…',
  'config.testResult.connected': 'Connecté',
  'config.testResult.connectedWithoutKey': 'Connecté sans clé',
  'config.connectionChoice.chatgptSignIn': 'Se connecter avec ChatGPT',
  'config.connectionChoice.claudeSignIn': 'Se connecter avec Claude',
  'config.connectionChoice.openaiCompatibleKey': 'Clé d’API compatible OpenAI',
  'config.connectionChoice.anthropicCompatibleKey': 'Clé ou jeton compatible Anthropic',
  'config.connectionChoice.geminiKey': 'Clé d’API Gemini',
  'config.connectionChoiceHints.chatgptSignIn':
    'Utilise votre abonnement ChatGPT. Aucune clé nécessaire.',
  'config.connectionChoiceHints.claudeSignIn':
    'Utilise votre abonnement Claude. Aucune clé nécessaire.',
  'config.connectionChoiceHints.openaiCompatibleKey':
    'OpenAI, ou tout point de terminaison compatible avec son API.',
  'config.connectionChoiceHints.anthropicCompatibleKey':
    'Anthropic, ou tout point de terminaison compatible avec son API.',
  'config.connectionChoiceHints.geminiKey': 'Une clé obtenue dans Google AI Studio.',
  'config.addFlowField.baseUrl': 'URL de base',
  'config.addFlowField.model': 'Modèle',
  'config.addFlowField.apiKey': 'Clé d’API',
  'config.addFlowField.keyType': 'Type de clé',
  'config.addFlowField.key': 'Clé',
  'config.addFlowField.token': 'Jeton',
  'config.addFlowField.headers': 'En-têtes',
  'config.addFlowField.name': 'Nom',
  'config.addFlowField.signInCode': 'Code de la page de connexion',
  'config.keyType.apiKey': 'Clé d’API',
  'config.keyType.bearerToken': 'Jeton Bearer',
  'config.connectRefusal.invalidSetupInput': 'Vérifiez le modèle et l’URL de base.',
  'config.connectRefusal.nameTaken': 'Un autre modèle utilise déjà ce nom.',
  'config.connectRefusal.credentialProviderConflict':
    'Ce nom contient une clé pour une autre connexion. Choisissez un autre nom.',
  'config.connectRefusal.credentialNotAccepted': 'Cette connexion n’accepte pas ce type de clé.',
  'config.connectRefusal.credentialExists': 'Une autre clé enregistrée utilise déjà ce nom.',
  'config.connectRefusal.validationFailed':
    'Le fichier de configuration présente d’abord un problème à corriger.',
  'config.connectRefusal.fileInvalid':
    'Le fichier de configuration ne peut pas être analysé. Corrigez-le dans votre éditeur, puis reconnectez-vous.',
  'config.connectRefusal.crossSiteRefused':
    'Cette page n’est pas autorisée à modifier la configuration.',
  'config.applyConsequences.knowledgeDir':
    'Les nouvelles exécutions et les agents utilisent immédiatement le nouveau dossier ; un démon agent-qa en cours d’exécution bascule à son redémarrage. Rien n’est déplacé ni supprimé dans le dossier actuel.',
  'config.applyConsequences.dbPath':
    'Le tableau de bord ouvre la nouvelle base de données à son redémarrage, et les exécutions de la base actuelle ne s’afficheront plus tant que vous n’y serez pas revenu. Rien n’est déplacé ni supprimé.',
  'config.applyConsequences.artifactsDir':
    'Les nouvelles exécutions écrivent leur fichier de mémoire de travail dans le nouveau dossier. Les exécutions précédentes restent visibles, et rien n’est déplacé ni supprimé.',
  'config.knowledgeField.dir': 'Dossier des connaissances',
  'config.knowledgeFieldHelp.dir': 'Un dossier de ce dépôt.',
  'config.dashboardField.port': 'Port',
  'config.dashboardField.host': 'Hôte',
  'config.dashboardField.dbPath': 'Fichier de base de données',
  'config.dashboardField.artifactsDir': 'Dossier des artefacts',
  'config.dashboardField.baseUrl': 'Adresse du tableau de bord',
  'config.dashboardField.workspace': 'Nom de l’espace de travail',
  'config.dashboardFieldHelp.host':
    'Doit être une adresse de cette machine. Prend effet après le redémarrage du tableau de bord.',
  'config.dashboardFieldHelp.baseUrl':
    'Les liens vers les tests et les exécutions dans les réponses des agents commencent par cette adresse. Ils nécessitent aussi un nom d’espace de travail.',
  'config.dashboardFieldHelp.workspace': 'Désigne ce projet dans ces liens.',
  'config.testDiscoveryField.testMatch': 'Fichiers de test',
  'config.testDiscoveryField.suiteMatch': 'Fichiers de suite',
  'config.testDiscoveryField.testPathIgnore': 'Chemins à ignorer',
  'config.testDiscoveryFieldHelp.testMatch':
    'Un motif glob par ligne. Tout fichier correspondant à l’un d’eux est un test.',
  'config.testDiscoveryFieldHelp.suiteMatch':
    'Un motif glob par ligne. Tout fichier correspondant à l’un d’eux est une suite.',
  'config.testDiscoveryFieldHelp.testPathIgnore':
    'Un motif glob par ligne. Les fichiers correspondants ne sont jamais pris comme tests.',
  'config.filesField.hooksFile': 'Fichier de hooks',
  'config.filesField.envFile': 'Fichier d’environnement',
  'config.filesField.secretsFile': 'Fichier de secrets',
  'config.filesFieldHelp.hooksFile': 'Le module de hooks partagé par les tests et les suites.',
  'config.filesFieldHelp.envFile': 'Un fichier dotenv chargé avant le début des exécutions.',
  'config.filesFieldHelp.secretsFile':
    'Un fichier de type dotenv pour les secrets que seuls les tests en cours d’exécution lisent. Ses valeurs s’affichent sous la forme [secret:<name>] et ne sont jamais restaurées ; rien d’autre n’est masqué.',
  'config.loggingField.level': 'Niveau de journalisation',
  'config.loggingFieldHelp.level':
    'Quantité de détails qu’une exécution affiche. L’option propre à une commande l’emporte sur ce réglage.',
  'config.loggingLevel.silent': 'Silencieux',
  'config.loggingLevel.error': 'Erreur',
  'config.loggingLevel.warn': 'Avertissement',
  'config.loggingLevel.info': 'Info',
  'config.loggingLevel.debug': 'Débogage',
  'config.attributeField.key': 'Attribut',
  'config.attributeField.value': 'Valeur',
  'config.privacyField.privacy': 'Désactiver les données d’utilisation et les rapports d’erreurs',
  'config.privacyFieldHelp.privacy':
    'Lorsque cette option est activée, agent-qa n’envoie ni données d’utilisation ni rapports d’erreurs depuis ce projet. Les rapports d’erreurs portent le même identifiant anonyme et les mêmes propriétés que les données d’utilisation.',
  'config.browserField.name': 'Navigateur',
  'config.browserField.headless': 'Sans interface (headless)',
  'config.browserField.viewportWidth': 'Largeur de la zone d’affichage',
  'config.browserField.viewportHeight': 'Hauteur de la zone d’affichage',
  'config.visionField.screenshotSize': 'Poids maximal des captures d’écran',
  'config.visionField.effectiveResolution': 'Plus grand côté en pixels',
  'config.visionFieldHelp.screenshotSize':
    'Le poids maximal d’une capture d’écran envoyée à un modèle de vision, par exemple 256k. Si ce champ est vide, la capture est envoyée sans compression.',
  'config.visionFieldHelp.effectiveResolution':
    'Les captures d’écran sont redimensionnées pour que leur plus grand côté tienne dans ce nombre de pixels.',
  'config.plannerField.maxActions': 'Nombre maximal d’actions par étape',
  'config.plannerField.maxPlanningTurns': 'Nombre maximal d’appels au planificateur par étape',
  'config.plannerField.previousStepCount': 'Étapes précédentes vues par le planificateur',
  'config.plannerFieldHelp.maxActions':
    'Chaque étape peut exécuter ce nombre d’actions ; l’étape s’arrête avec le motif de limite si elle en demande une de plus. 30 par défaut.',
  'config.plannerFieldHelp.maxPlanningTurns':
    'Chaque étape peut faire ce nombre d’appels au modèle du planificateur ; l’étape s’arrête avec le motif de limite si elle en demande un de plus. 30 par défaut.',
  'config.plannerFieldHelp.previousStepCount':
    'Nombre d’étapes précédentes que le planificateur lit avant de planifier la suivante.',
  'config.timeoutField.step': 'Délai d’expiration d’une étape',
  'config.timeoutField.test': 'Délai d’expiration d’un test',
  'config.timeoutField.navigation': 'Délai d’expiration de navigation',
  'config.timeoutFieldHelp.navigation':
    'Durée maximale d’un chargement de page Web ou d’une attente d’URL. 2m par défaut. Les exécutions Android et iOS ne l’utilisent pas.',
  'config.runsField.parallel': 'Exécuter les tests en parallèle',
  'config.runsField.workers': 'Processus parallèles',
  'config.runsField.buildTag': 'Étiquette de build',
  'config.runsFieldHelp.parallel': 'Exécuter en même temps les tests d’une même exécution.',
  'config.runsFieldHelp.workers': 'Nombre maximal de tests exécutés simultanément.',
  'config.runsFieldHelp.buildTag': 'Désigne le build de l’application testé.',
  'config.cacheField.enabled': 'Réutiliser les actions en cache',
  'config.cacheField.dir': 'Dossier du cache',
  'config.recordingField.enabled': 'Enregistrer une vidéo',
  'config.recordingField.keepFailuresOnly':
    'Conserver uniquement les enregistrements des tests échoués',
  'config.recordingFieldHelp.enabled':
    'Enregistre une vidéo de chaque test. Les enregistrements restent sur cette machine.',
  'config.recordingFieldHelp.keepFailuresOnly':
    'Utile pour la CI et les grandes suites. Les tests réussis s’ouvrent alors sur l’onglet Images.',
  'config.accessibilityField.enabled': 'Vérifier l’accessibilité',
  'config.accessibilityField.standard': 'Norme',
  'config.accessibilityField.runAfter': 'Exécuter les vérifications',
  'config.accessibilityField.failOnViolation':
    'Faire échouer les tests qui présentent des violations',
  'config.accessibilityField.disableRules': 'Règles à ignorer',
  'config.accessibilityField.exclude': 'Éléments à ignorer',
  'config.accessibilityFieldHelp.disableRules': 'Un ID de règle axe par ligne.',
  'config.accessibilityFieldHelp.exclude': 'Un sélecteur CSS par ligne.',
  'config.accessibilityRunAfter.everyStep': 'Après chaque étape',
  'config.accessibilityRunAfter.testEnd': 'À la fin du test',
  'config.logCaptureField.console': 'Capturer les journaux de la console',
  'config.logCaptureField.network': 'Capturer les journaux réseau',
  'config.remotes.defaultLabel': 'Par défaut pour les tests Web',
  'config.remotes.inherit':
    'Les tests et les suites héritent de cette valeur par défaut depuis agent-qa.config.yaml et peuvent la remplacer dans leurs paramètres.',
  'config.remotes.thisMachine': 'Cette machine',
  'config.remotes.runsOnLabel': 'S’exécute sur',
  'config.remotes.suiteWinsHint':
    'Quand une suite choisit où elle s’exécute, le choix de la suite l’emporte.',
  'config.remotes.columns.name': 'Nom',
  'config.remotes.columns.kind': 'Type',
  'config.remotes.columns.origin': 'Origine',
  'config.remotes.pluginNotDeclared': 'non déclaré sous plugins',
  'config.remotes.empty':
    'Aucun service distant n’est listé. Ajoutez-en un sous registry.remotes dans agent-qa.config.yaml :',
  'config.remotes.pick':
    'Choisissez-en un avec use.browser.remote: <name> dans agent-qa.config.yaml, une suite ou un test. Utilisez local pour exécuter sur cette machine.',
  'config.remotes.listed':
    'Les services distants sont définis sous registry.remotes dans agent-qa.config.yaml et choisis avec use.browser.remote.',
  'config.remotes.pluginsTitle': 'Plugins',
  'config.remotes.pluginColumns.name': 'Nom',
  'config.remotes.pluginColumns.source': 'Package ou chemin',
  'config.remotes.pluginsListed':
    'Les plugins sont déclarés sous plugins dans agent-qa.config.yaml ; leurs options restent dans le fichier.',
  'config.loginStateColumn.target': 'Cible',
  'config.loginStateColumn.name': 'Nom',
  'config.loginStateColumn.captured': 'Capturé',
  'config.loginStatesField.dir': 'Dossier des états d’authentification',
  'config.mobileField.appState': 'État de l’application',
  'config.mobileAppState.preserve': 'Conserver les données de l’application',
  'config.mobileAppState.reset': 'Réinitialiser les données de l’application',
  'config.targetPlatform.web': 'Web',
  'config.targetEnvironment.local': 'Local',
  'config.targetEnvironment.shared': 'Partagé',
  'config.targetEnvironment.production': 'Production',
  'config.targetEnvironmentChoice.undeclared': 'Non déclaré',
  'config.targetField.name': 'Nom',
  'config.targetField.platform': 'Plateforme',
  'config.targetField.url': 'URL',
  'config.targetField.product': 'Produit',
  'config.targetField.bundleId': 'ID de bundle',
  'config.targetField.appPackage': 'Package de l’application',
  'config.targetField.appActivity': 'Activité de l’application',
  'config.targetField.appPath': 'Fichier de l’application',
  'config.targetField.appRef': 'Référence de l’application',
  'config.targetField.device': 'Appareil par défaut',
  'config.targetField.environment': 'Environnement',
  'config.deviceField.name': 'Nom',
  'config.deviceField.platform': 'Plateforme',
  'config.deviceField.model': 'Modèle',
  'config.deviceField.os': 'Version de l’OS',
  'config.deviceField.id': 'ID de l’appareil',
  'config.deviceField.capabilities': 'Capacités',
  'config.mcpField.enabled': 'Serveur MCP',
  'config.mcpField.port': 'Port',
  'config.mcpFieldHelp.enabled':
    'Lorsque cette option est désactivée, le tableau de bord n’héberge pas le point de terminaison MCP.',
  'config.copyStatus.copied': 'Copié',
  'config.copyStatus.failed': 'Impossible de copier',
  'config.sectionAliases.models':
    'modèle, modèles, modèle par défaut, fournisseurs, clé d’api, connexion, se connecter, model, llm, llms, default model, providers, api key, sign in',
  'config.sectionAliases.screenshotSize':
    'vision, capture d’écran, taille des captures, résolution, screenshot, resolution',
  'config.sectionAliases.plannerLimits':
    'planificateur, limites, sous-actions, historique, planner, sub actions, history limit',
  'config.sectionAliases.targets':
    'cible, cibles, urls, id de bundle, package de l’application, target, bundle id, app package',
  'config.sectionAliases.remotes':
    'service distant, services distants, navigateur distant, où les tests s’exécutent, remote, remote browser',
  'config.sectionAliases.devices':
    'appareil, appareils, profils d’appareil, device, device profiles',
  'config.sectionAliases.loginStates':
    'état d’authentification, états d’authentification, connexion, authentification enregistrée, login state, auth state, auth states, saved auth',
  'config.sectionAliases.mobileAppState':
    'mobile, état de l’application, données de l’application, réinitialiser les données, conserver les données, app state, app data',
  'config.sectionAliases.browser':
    'navigateur, zone d’affichage, sans interface, moteur, viewport, headless, browser, engine',
  'config.sectionAliases.timeouts':
    'délai, délai d’expiration, délai de navigation, délai d’étape, timeout, navigation timeout, step timeout',
  'config.sectionAliases.runs':
    'parallèle, exécutions parallèles, processus, étiquette de build, parallel, workers, build tag',
  'config.sectionAliases.cache':
    'cache, dossier du cache, répertoire du cache, cache dir, cache directory',
  'config.sectionAliases.recording': 'enregistrement, enregistrer, vidéo, record, video',
  'config.sectionAliases.accessibility': 'accessibilité, a11y, wcag',
  'config.sectionAliases.logCapture':
    'journaux, capture de la console, capture réseau, console capture, network capture',
  'config.sectionAliases.testDiscovery':
    'tests, découverte, testMatch, suiteMatch, motifs à ignorer, discovery, test match, suite match, ignore patterns',
  'config.sectionAliases.files':
    'fichier de hooks, fichier env, fichier d’environnement, fichier de secrets, hooks file, env file, environment file, secrets file',
  'config.sectionAliases.knowledge':
    'connaissances, dossier des connaissances, knowledge, knowledge dir',
  'config.sectionAliases.dashboard':
    'tableau de bord, port, base de données, chemin de la base, artefacts, dossier des artefacts, db path, database, artifacts, artifacts dir, runs db',
  'config.sectionAliases.logging': 'journalisation, niveau de journalisation, log level',
  'config.sectionAliases.passRateScope':
    'taux de réussite, périmètre, attributs, instabilité, pass rate, scope, attributes, flakiness',
  'config.sectionAliases.mcp': 'mcp, port mcp, mcp port',
  'config.sectionAliases.configFile':
    'yaml, chemin du fichier de configuration, configuration brute, config file path, raw config',
  'config.commandLabel': 'Configuration : {{tab}} / {{section}}',
  'config.loadFailedBody':
    '{{reason}}. Rechargez la configuration ou corrigez le fichier dans votre éditeur. Cette page prendra en compte la modification.',
  'config.fileIssuesBody':
    '{{reason}}. Corrigez-le dans votre éditeur. Cette page prendra en compte la modification.',
  'config.undo.deleteModel': '{{name}} supprimé',
  'config.undo.deleteTarget': 'Cible {{name}} supprimée',
  'config.undo.deleteDevice': 'Appareil {{name}} supprimé',
  'config.undo.signOut': 'Déconnecté de {{name}}',
  'config.undo.removeKey': 'Clé de {{name}} retirée',
  'config.undo.changeKnowledgeDir': 'Dossier des connaissances modifié',
  'config.undo.changeDbPath': 'Base de données modifiée',
  'config.undo.changeArtifactsDir': 'Dossier des artefacts modifié',
  'config.deleteAction.model': 'Supprimer le modèle {{name}}',
  'config.deleteAction.target': 'Supprimer la cible {{name}}',
  'config.deleteAction.device': 'Supprimer l’appareil {{name}}',
  'config.connection.signedIn': 'Connecté avec votre abonnement {{provider}}.',
  'config.connection.keySaved': 'Clé enregistrée sur cette machine.',
  'config.connection.notSignedIn': 'Non connecté.',
  'config.connection.noKeyOptional':
    'Aucune clé enregistrée. Ce point de terminaison n’en a peut-être pas besoin.',
  'config.connection.noKey': 'Aucune clé enregistrée.',
  'config.connection.signInExpired': 'Connexion expirée. Reconnectez-vous pour utiliser ce modèle.',
  'config.fixedFacts':
    'Se connecte avec {{connection}}. Le nom et la connexion sont fixes ; pour les changer, ajoutez un nouveau modèle.',
  'config.headerNameTaken': 'Un en-tête nommé {{name}} existe déjà.',
  'config.headerNameFieldName': 'Nom de l’en-tête {{header}}',
  'config.modelHeader': 'En-tête {{header}}',
  'config.existingCredential.key': 'Une clé pour {{name}} est déjà enregistrée sur cette machine.',
  'config.existingCredential.signIn': 'Déjà connecté en tant que {{name}} sur cette machine.',
  'config.nameTaken': 'Un modèle nommé {{name}} existe déjà.',
  'config.nameCredentialConflict':
    '{{name}} a déjà une connexion ou une clé enregistrée pour {{provider}}. Choisissez un autre nom.',
  'config.connectRefusalIssue.validationFailed':
    'Le fichier de configuration présente d’abord un problème à corriger : {{issue}}',
  'config.connectRefusalIssue.invalidSetupInput': 'Vérifiez le modèle et l’URL de base : {{issue}}',
  'config.signInFailed.reason': 'La connexion n’a pas abouti : {{reason}}',
  'config.signInFailed.noReason': 'La connexion n’a pas abouti : elle n’a pas pu être terminée.',
  'config.connectedSaved': 'Connecté. Enregistré sous le nom {{name}}.',
  'config.signInPluginMissing':
    '{{choice}} nécessite le plugin @vostride/agent-qa-subscription-auth. Installez-le et ajoutez-le à plugins sous la forme name: subscription dans agent-qa.config.yaml.',
  'config.applyAction': 'Appliquer {{path}}',
  'config.keepPath': 'Conserver le chemin actuel pour {{path}}',
  'config.attributeValue': 'Valeur de {{key}}',
  'config.removeAttribute': 'Retirer l’attribut {{key}}',
  'config.pluginRemote': 'plugin {{entry}}',
  'config.remoteNotListed':
    '{{name}} n’est pas listé sous registry.remotes : les tests Web qui utilisent cette valeur par défaut ne peuvent donc pas s’exécuter. Ajoutez-le à la liste ou modifiez use.browser.remote.',
  'config.remoteUnlistedChoice': '{{name}} (non listé)',
  'config.remotePickNotListed':
    '{{name}} n’est pas listé parmi les services distants de la configuration.',
  'config.remoteCredentials.file':
    'Écrivez les identifiants sous forme de références {{reference}} vers des noms déclarés dans {{file}}.',
  'config.remoteCredentials.noFile':
    'Écrivez les identifiants sous forme de références {{reference}} vers des noms déclarés dans votre fichier de secrets (définissez workspace.secretsFile).',
  'config.targetDeviceUnlistedChoice': '{{name}} (non listé pour cette plateforme)',
  'config.targetNameTaken': 'Une cible nommée {{name}} existe déjà.',
  'config.deviceNameTaken': 'Un appareil nommé {{name}} existe déjà.',
  'config.deviceCapability': 'Capacité {{key}} de {{device}}',
  'config.deviceRemote': 'S’exécute sur le service distant {{remote}}',
  'config.replaceValue': 'Remplacer la valeur de {{label}}',
  'config.saveValue': 'Enregistrer la valeur de {{label}}',
  'config.keepValue': 'Conserver la valeur actuelle de {{label}}',
} satisfies Translation<typeof en>
