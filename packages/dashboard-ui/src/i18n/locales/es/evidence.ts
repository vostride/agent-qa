import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'evidence.loading': 'Cargando los registros',
  'evidence.incompleteExplanation':
    'evidencias incompletas: esto se registró, pero el archivo guardado ya no está en el disco.',
  'evidence.recordedOnStep': 'Registrado en el paso {{step}}',
  'evidence.explanationWithStep': '{{explanation}} {{step}}',
  'evidence.goToStep': 'Ir al paso {{step}}',

  'evidence.retry.variables': 'Reintentar la carga de las variables',
  'evidence.retry.network': 'Reintentar la carga de los registros de red',
  'evidence.retry.console': 'Reintentar la carga de los registros de consola',
  'evidence.retry.aria': 'Reintentar la carga del árbol ARIA',
  'evidence.retry.a11y': 'Reintentar la carga de los resultados de accesibilidad',
  'evidence.retry.video': 'Reintentar la carga de la grabación',
  'evidence.retry.frame': 'Reintentar la carga de la captura de pantalla',

  'evidence.variables.empty.title': 'No hay variables en este paso',
  'evidence.variables.empty.explanation':
    'No había ninguna variable establecida cuando se ejecutó este paso.',
  'evidence.variables.notCaptured.title': 'No se registraron variables en este paso',
  'evidence.variables.notCaptured.explanation':
    'No se guardó ninguna instantánea de variables en este paso.',
  'evidence.variables.unsupported.title': 'Las variables no se registran en esta plataforma',
  'evidence.variables.unsupported.explanation':
    'La plataforma de esta ejecución no permite guardar una instantánea de variables.',
  'evidence.variables.unavailable.title': 'Variables no disponibles en esta ejecución',
  'evidence.variables.unavailable.explanation':
    'Las variables no se registraban cuando se hizo esta ejecución, así que no hay nada que mostrar.',
  'evidence.variables.failed.capture.title': 'Falló el registro de las variables',
  'evidence.variables.failed.capture.explanation':
    'No se pudo guardar la instantánea de variables durante la ejecución. No hay nada que reintentar.',
  'evidence.variables.failed.load.title': 'No se pudieron cargar las variables',
  'evidence.variables.failed.load.explanation':
    'Las variables se registraron, pero no se cargaron.',
  'evidence.variables.noSelection.title': 'Ningún paso seleccionado',
  'evidence.variables.noSelection.explanation':
    'Las variables se muestran por paso. Elige un paso en el árbol o en la línea de tiempo para verlas.',

  'evidence.network.empty.title': 'No hay solicitudes de red',
  'evidence.network.empty.explanation': 'La página no hizo ninguna solicitud durante este paso.',
  'evidence.network.notCaptured.title': 'No se registró la red en este paso',
  'evidence.network.notCaptured.explanation': 'No se guardó ninguna actividad de red en este paso.',
  'evidence.network.unsupported.title': 'La red no se registra en esta plataforma',
  'evidence.network.unsupported.explanation':
    'La plataforma de esta ejecución no permite registrar las solicitudes de red.',
  'evidence.network.unavailable.title': 'Red no disponible en esta ejecución',
  'evidence.network.unavailable.explanation':
    'La actividad de red no se registraba cuando se hizo esta ejecución. Eso no significa que la ejecución no hiciera solicitudes.',
  'evidence.network.failed.capture.title': 'Falló el registro de la red',
  'evidence.network.failed.capture.explanation':
    'No se pudo registrar la actividad de red durante la ejecución. No hay nada que reintentar.',
  'evidence.network.failed.load.title': 'No se pudieron cargar los registros de red',
  'evidence.network.failed.load.explanation': 'Los registros existen, pero no se cargaron.',
  'evidence.network.noSelection.title': 'Ningún paso seleccionado',
  'evidence.network.noSelection.explanation':
    'Las solicitudes de red se muestran por paso. Elige un paso en el árbol o en la línea de tiempo para verlas.',

  'evidence.console.empty.title': 'No hay salida de consola',
  'evidence.console.empty.explanation':
    'La página no escribió nada en la consola durante este paso.',
  'evidence.console.notCaptured.title': 'No se registró la consola en este paso',
  'evidence.console.notCaptured.explanation':
    'No se guardó ninguna salida de consola en este paso.',
  'evidence.console.unsupported.title': 'La consola no se registra en esta plataforma',
  'evidence.console.unsupported.explanation':
    'La plataforma de esta ejecución no permite registrar la salida de consola.',
  'evidence.console.unavailable.title': 'Consola no disponible en esta ejecución',
  'evidence.console.unavailable.explanation':
    'La salida de consola no se registraba cuando se hizo esta ejecución. Eso no significa que la página no escribiera nada.',
  'evidence.console.failed.capture.title': 'Falló el registro de la consola',
  'evidence.console.failed.capture.explanation':
    'No se pudo registrar la salida de consola durante la ejecución. No hay nada que reintentar.',
  'evidence.console.failed.load.title': 'No se pudieron cargar los registros de consola',
  'evidence.console.failed.load.explanation': 'Los registros existen, pero no se cargaron.',
  'evidence.console.noSelection.title': 'Ningún paso seleccionado',
  'evidence.console.noSelection.explanation':
    'La salida de consola se muestra por paso. Elige un paso en el árbol o en la línea de tiempo para verla.',

  'evidence.aria.empty.title': 'Árbol de accesibilidad vacío',
  'evidence.aria.empty.explanation':
    'La pantalla no exponía ningún elemento accesible cuando se decidió esta acción.',
  'evidence.aria.notCaptured.title': 'No se registró el árbol ARIA en esta acción',
  'evidence.aria.notCaptured.explanation':
    'No se guardó ningún árbol de accesibilidad en esta subacción.',
  'evidence.aria.unsupported.title': 'El árbol ARIA no se registra en esta plataforma',
  'evidence.aria.unsupported.explanation':
    'La plataforma de esta ejecución no permite registrar un árbol de accesibilidad.',
  'evidence.aria.unavailable.title': 'Árbol ARIA no disponible en esta ejecución',
  'evidence.aria.unavailable.explanation':
    'El árbol de accesibilidad no se registraba cuando se hizo esta ejecución.',
  'evidence.aria.failed.capture.title': 'Falló el registro del árbol ARIA',
  'evidence.aria.failed.capture.explanation':
    'No se pudo registrar el árbol de accesibilidad durante la ejecución. No hay nada que reintentar.',
  'evidence.aria.failed.load.title': 'No se pudo cargar el árbol ARIA',
  'evidence.aria.failed.load.explanation': 'El árbol se registró, pero no se cargó.',
  'evidence.aria.noSelection.title': 'Ninguna subacción seleccionada',
  'evidence.aria.noSelection.explanation':
    'El árbol de accesibilidad se muestra por subacción. Elige una subacción en el árbol o en la línea de tiempo para ver lo que vio el modelo.',

  'evidence.a11y.empty.title': 'No se encontraron infracciones de accesibilidad',
  'evidence.a11y.empty.explanation':
    'Las comprobaciones se ejecutaron en este paso y no encontraron nada que corregir.',
  'evidence.a11y.notCaptured.title':
    'No se registraron comprobaciones de accesibilidad en este paso',
  'evidence.a11y.notCaptured.explanation':
    'No se guardó ningún resultado de accesibilidad en este paso.',
  'evidence.a11y.unsupported.title':
    'Las comprobaciones de accesibilidad no se admiten en esta plataforma',
  'evidence.a11y.unsupported.explanation':
    'La plataforma de esta ejecución no puede ejecutar comprobaciones de accesibilidad.',
  'evidence.a11y.unavailable.title': 'Resultados de accesibilidad no disponibles en esta ejecución',
  'evidence.a11y.unavailable.explanation':
    'Las comprobaciones de accesibilidad no se registraban cuando se hizo esta ejecución. Eso no significa que la ejecución no tuviera infracciones.',
  'evidence.a11y.failed.capture.title':
    'No se pudieron ejecutar las comprobaciones de accesibilidad',
  'evidence.a11y.failed.capture.explanation':
    'Las comprobaciones encontraron un error durante la ejecución, así que no hay resultados. No hay nada que reintentar.',
  'evidence.a11y.failed.load.title': 'No se pudieron cargar los resultados de accesibilidad',
  'evidence.a11y.failed.load.explanation': 'Los resultados existen, pero no se cargaron.',
  'evidence.a11y.noSelection.title': 'Ningún paso seleccionado',
  'evidence.a11y.noSelection.explanation':
    'Los resultados de accesibilidad se muestran por paso. Elige un paso en el árbol o en la línea de tiempo para verlos.',

  'evidence.video.empty.title': 'La grabación no tiene video',
  'evidence.video.empty.explanation':
    'Se guardó una grabación de esta prueba, pero no contiene nada que reproducir.',
  'evidence.video.notCaptured.title': 'No hay grabación de esta prueba',
  'evidence.video.notCaptured.explanation':
    'No se guardó ningún video de esta prueba. La pestaña Fotogramas sigue mostrando lo que vio el modelo en cada decisión.',
  'evidence.video.unsupported.title': 'La grabación no se admite en esta plataforma',
  'evidence.video.unsupported.explanation':
    'La plataforma de esta ejecución no graba video. La pestaña Fotogramas sigue mostrando lo que vio el modelo en cada decisión.',
  'evidence.video.unavailable.title': 'Grabación no disponible en esta ejecución',
  'evidence.video.unavailable.explanation':
    'No se grababa video cuando se hizo esta ejecución. La pestaña Fotogramas sigue mostrando lo que vio el modelo en cada decisión.',
  'evidence.video.failed.capture.title': 'Falló la grabación',
  'evidence.video.failed.capture.explanation':
    'No se pudo guardar el video cuando terminó esta prueba. No hay nada que reintentar. La pestaña Fotogramas sigue mostrando lo que vio el modelo en cada decisión.',
  'evidence.video.failed.load.title': 'No se pudo cargar la grabación',
  'evidence.video.failed.load.explanation':
    'La grabación existe, pero no se cargó. Reinténtalo o cambia a Fotogramas.',
  'evidence.video.noSelection.title': 'Ningún paso seleccionado',
  'evidence.video.noSelection.explanation':
    'La grabación sigue la línea de tiempo. Elige un paso en el árbol o en la línea de tiempo para situarla.',

  'evidence.frame.notCaptured.subAction.title': 'No hay captura de pantalla de esta acción',
  'evidence.frame.notCaptured.subAction.explanation':
    'No se guardó ninguna captura de pantalla de esta subacción.',
  'evidence.frame.notCaptured.step.title': 'No hay capturas de pantalla de este paso',
  'evidence.frame.notCaptured.step.explanation':
    'Ninguna subacción de este paso guardó una captura de pantalla.',
  'evidence.frame.unavailable.title': 'Captura de pantalla no disponible',
  'evidence.frame.failed.load.title': 'No se pudo cargar la captura de pantalla',
  'evidence.frame.failed.load.explanation': 'La captura de pantalla existe, pero no se cargó.',

  'evidence.tab.variables': 'Variables',
  'evidence.tab.network': 'Red',
  'evidence.tab.console': 'Consola',
  'evidence.tab.aria': 'Árbol ARIA',
  'evidence.tab.a11y': 'A11y',
  'evidence.trigger.variables': 'Variables, {{number}}',
  'evidence.trigger.aria': 'Árbol ARIA, {{number}}',
  'evidence.trigger.consoleErrors_one': 'Consola, {{count}} error',
  'evidence.trigger.consoleErrors_other': 'Consola, {{count}} errores',
  'evidence.trigger.consoleMessages_one': 'Consola, {{count}} mensaje',
  'evidence.trigger.consoleMessages_other': 'Consola, {{count}} mensajes',
  'evidence.trigger.networkFailed_one': 'Red, {{count}} solicitud fallida',
  'evidence.trigger.networkFailed_other': 'Red, {{count}} solicitudes fallidas',
  'evidence.trigger.networkRequests_one': 'Red, {{count}} solicitud',
  'evidence.trigger.networkRequests_other': 'Red, {{count}} solicitudes',
  'evidence.trigger.a11yViolations_one': 'A11y, {{count}} infracción',
  'evidence.trigger.a11yViolations_other': 'A11y, {{count}} infracciones',
  'evidence.trigger.absent': '{{tab}}: {{title}}',
  'evidence.signal.console_one':
    '{{count}} error de consola en el paso {{step}}: abre la pestaña Consola',
  'evidence.signal.console_other':
    '{{count}} errores de consola en el paso {{step}}: abre la pestaña Consola',
  'evidence.signal.network_one':
    '{{count}} solicitud fallida en el paso {{step}}: abre la pestaña Red',
  'evidence.signal.network_other':
    '{{count}} solicitudes fallidas en el paso {{step}}: abre la pestaña Red',
  'evidence.signal.a11y_one':
    '{{count}} infracción de accesibilidad en el paso {{step}}: abre la pestaña A11y',
  'evidence.signal.a11y_other':
    '{{count}} infracciones de accesibilidad en el paso {{step}}: abre la pestaña A11y',

  'evidence.drawer.test': 'Prueba',
  'evidence.drawer.config': 'Configuración',
  'evidence.drawer.testAsWritten': 'Prueba tal como está escrita',
  'evidence.drawer.resolvedDefinition': 'Definición resuelta',
  'evidence.drawer.suiteMembers': 'Miembros de la suite',
  'evidence.drawer.runTests': 'Pruebas de esta ejecución',
  'evidence.drawer.runAttributes': 'Atributos de la ejecución',
  'evidence.drawer.effectiveConfig': 'Configuración efectiva',
  'evidence.drawer.globalConfigAsWritten': 'Configuración global tal como está escrita',
  'evidence.drawer.model': 'Modelo',
  'evidence.drawer.runtime': 'Entorno de ejecución',
  'evidence.drawer.errors': 'Errores',
  'evidence.drawer.notCaptured': 'No registrado',
  'evidence.drawer.configNotCaptured': 'Configuración no registrada',
  'evidence.drawer.unsealedCapture':
    'El registro de la preparación de esta ejecución no terminó, así que la prueba y la configuración que se muestran aquí pueden estar incompletas.',
  'evidence.drawer.technicalDetails': 'Detalles técnicos',
  'evidence.drawer.runId': 'ID de la ejecución',
  'evidence.drawer.artifactKind': 'Tipo de artefacto',
  'evidence.drawer.schemaVersion': 'Versión del esquema',
  'evidence.drawer.captureSealedAt': 'Fecha de cierre del registro',
  'evidence.drawer.copyRunId': 'Copiar el ID de la ejecución',
  'evidence.drawer.retry': 'Reintentar la carga de los detalles de la ejecución',
  'evidence.drawer.ranHere': 'Se ejecutó en este equipo',
  'evidence.drawer.ranHereOn': 'Se ejecutó en este equipo, {{deviceType}}',
  'evidence.drawer.deviceType.simulator': 'simulador',
  'evidence.drawer.deviceType.realDevice': 'dispositivo real',
  'evidence.drawer.opensInNewTab': '(se abre en una pestaña nueva)',
  'evidence.drawer.remote': '{{name}} ({{where}})',
  'evidence.drawer.ranOn': 'Se ejecutó en {{remote}}',
  'evidence.drawer.ranOnVersion': 'Se ejecutó en {{remote}}, {{version}}',
  'evidence.drawer.lostOn': 'Se ejecutó en {{remote}} hasta que se perdió la conexión',
  'evidence.drawer.lostOnVersion':
    'Se ejecutó en {{remote}}, {{version}}, hasta que se perdió la conexión',
  'evidence.drawer.endedOn': 'Se ejecutó en {{remote}} hasta que el remoto terminó la sesión',
  'evidence.drawer.endedOnVersion':
    'Se ejecutó en {{remote}}, {{version}}, hasta que el remoto terminó la sesión',
  'evidence.drawer.couldNotRun': 'No se pudo ejecutar en {{remote}}: {{reason}}',
  'evidence.drawer.sessionRefused': 'sesión rechazada',
  'evidence.drawer.plugin': 'Complemento {{entry}}',
  'evidence.drawer.pluginSource': 'Complemento {{entry}} ({{source}})',
  'evidence.drawer.sessionPage': 'Página de la sesión',
  'evidence.drawer.kind.test': 'Prueba',
  'evidence.drawer.kind.unknown': 'No registrado',
  'evidence.drawer.titleFallback': 'Ejecución {{id}}',

  'evidence.scope.step': 'Paso {{step}} de {{total}} · todo el paso',
  'evidence.scope.subAction': 'Subacción n.º {{number}} de {{total}} · paso {{step}}',

  'evidence.artifact.loadingLabel': 'Cargando los datos del artefacto',
  'evidence.artifact.loading': 'Cargando los datos del artefacto…',
  'evidence.artifact.loadFailed': 'No se pudieron cargar los datos del artefacto',
  'evidence.artifact.loadFailedHelp':
    'Reintenta la solicitud. Si sigue fallando, comprueba que el servidor del panel puede leer los artefactos de las ejecuciones.',
  'evidence.artifact.missing': 'Los datos del artefacto no están disponibles en esta ejecución',
  'evidence.artifact.missingHelp': 'Esta ejecución no tiene un registro de artefacto guardado.',
  'evidence.artifact.none': 'Ninguno',
  'evidence.artifact.items_one': '{{count}} elemento',
  'evidence.artifact.items_other': '{{count}} elementos',
  'evidence.artifact.fields_one': '{{count}} campo',
  'evidence.artifact.fields_other': '{{count}} campos',
  'evidence.artifact.sectionNotCaptured': '{{section}}: no se registró en esta ejecución.',
  'evidence.artifact.unnamedMember': 'Miembro sin nombre',
  'evidence.artifact.testId': 'ID de la prueba',
  'evidence.artifact.ref': 'Referencia',
  'evidence.artifact.refId': 'ID de referencia',
  'evidence.artifact.path': 'Ruta',
  'evidence.artifact.target': 'Destino',
  'evidence.artifact.childRun': 'Ejecución secundaria',
  'evidence.artifact.error': 'Error',
  'evidence.artifact.ranAgainst': 'Se ejecutó contra',
  'evidence.artifact.memberSnapshots': 'Instantáneas de los miembros',
  'evidence.artifact.rawTestYaml': 'YAML original de la prueba',
  'evidence.artifact.rawMemberYaml': 'YAML original del miembro',
  'evidence.artifact.rawSuiteYaml': 'YAML original de la suite',
  'evidence.artifact.rawGlobalConfig': 'Configuración global original',
  'evidence.artifact.noAttributes': 'Sin atributos de ejecución',
  'evidence.artifact.noAttributesHelp': 'Esta ejecución no registró ningún atributo.',
  'evidence.artifact.copyJson': 'Copiar JSON',
  'evidence.artifact.copyNamedValue': 'Copiar el valor de {{key}}',
  'evidence.artifact.copyValue': 'Copiar el valor',
} satisfies Translation<typeof en>
