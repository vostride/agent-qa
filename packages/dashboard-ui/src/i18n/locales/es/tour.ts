import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'tour.intro.title': 'Te damos la bienvenida a agent-qa',
  'tour.intro.body':
    'agent-qa permite escribir pruebas en lenguaje natural para web y móvil. Las ejecuta con un arnés de QA estricto, aprende de las ejecuciones anteriores, se adapta cuando cambia la interfaz y muestra exactamente lo que ocurrió.',
  'tour.llmSetup.title': 'Configura primero el LLM',
  'tour.runs.title': 'Las ejecuciones muestran los resultados',
  'tour.runs.body':
    'Las ejecuciones muestran los resultados, los artefactos y el razonamiento de cada ejecución de agent-qa.',
  'tour.tests.title': 'Las pruebas contienen comprobaciones en lenguaje natural',
  'tour.tests.body':
    'Las pruebas son comprobaciones en lenguaje natural que agent-qa puede ejecutar contra el destino web o móvil configurado.',
  'tour.suites.title': 'Las suites agrupan flujos repetibles',
  'tour.suites.body':
    'Las suites agrupan comprobaciones relacionadas en flujos repetibles cuando una sola prueba no basta.',
  'tour.hooks.title': 'Los hooks se ejecutan alrededor de los pasos y entre ellos',
  'tour.hooks.body':
    'Los hooks pueden preparar el entorno, ejecutarse en línea entre pasos y encargarse de la limpieza alrededor de una prueba o una suite.',
  'tour.config.title': 'La configuración controla el entorno local',
  'tour.config.body':
    'La configuración controla el modelo, el destino, el entorno de ejecución y el panel que agent-qa usa localmente.',
  'tour.exampleTest.title': 'Ejecuta la prueba de ejemplo que debe aprobarse',
  'tour.exampleTest.body':
    'Esta prueba generada es la primera ejecución más segura, porque init la crea para validar la configuración.',
  'tour.exampleMissing.title': 'Busca la prueba de ejemplo que debe aprobarse',
  'tour.exampleMissing.body':
    'agent-qa init suele crear una prueba de ejemplo que debe aprobarse. Elígela en Pruebas cuando esté disponible o crea una más adelante.',
  'tour.runAction.title': 'Haz clic en Ejecutar cuando quieras',
  'tour.runAction.body':
    'Haz clic en Ejecutar cuando quieras empezar. El recorrido continuará desde la vista de la ejecución o desde la página Ejecuciones.',
  'tour.liveRun.title': 'Sigue la ejecución en vivo',
  'tour.liveRun.body':
    'El modo en vivo muestra la prueba en curso: sus pasos a un lado y el navegador junto a ellos.',
  'tour.runDetail.title': 'Examina el detalle de la ejecución',
  'tour.runDetail.body':
    'Este es el momento clave: examina lo que agent-qa observó, planificó, ejecutó y verificó.',
  'tour.githubNudge.title': 'Si agent-qa te ayudó',
  'tour.githubNudge.body': 'Si agent-qa te ayudó, considera darle una estrella en GitHub.',
  'tour.githubNudge.actionLabel': 'Ver en GitHub',
  'tour.runsFallback.title': 'Abre la ejecución más reciente',
  'tour.runsFallback.body':
    'Si aún no hay ninguna ejecución abierta aquí, usa Ejecuciones para abrir la más reciente y examinar la vista de detalle.',
  'tour.ui.progress': 'Progreso del recorrido: {{current}} de {{total}}',
  'tour.ui.skip': 'Omitir',
  'tour.ui.restart': 'Reiniciar',
  'tour.ui.back': 'Atrás',
  'tour.ui.done': 'Listo',
  'tour.ui.startTour': 'Iniciar el recorrido',
} satisfies Translation<typeof en>
