import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'insights.title': 'Estadísticas',
  'insights.description':
    'Señales de fiabilidad, coste y curación de todo el período, con una sección aparte para comparar pruebas, suites y plataformas.',
  'insights.scope.label': 'Ámbito de las ejecuciones',
  'insights.scope.scoped': 'En el ámbito',
  'insights.scope.all': 'Todas las ejecuciones',
  'insights.window.label': 'Período',
  'insights.window.oneDay': '1 d',
  'insights.window.sevenDays': '7 d',
  'insights.window.thirtyDays': '30 d',
  'insights.window.all': 'Todo el tiempo',
  'insights.refreshing': 'Actualizando el intervalo seleccionado',
  'insights.unavailable.title': 'Estadísticas no disponibles',
  'insights.unavailable.description':
    'Actualiza la página. Si el problema continúa, cambia el período y comprueba que haya datos de análisis disponibles.',
  'insights.empty.title': 'No hay ejecuciones en este período',
  'insights.empty.description':
    'Ejecuta o vuelve a ejecutar pruebas para llenar las estadísticas. Si esperas datos más antiguos, cambia a 30 d o a Todo el tiempo.',
  'insights.empty.action': 'Abrir Ejecuciones',
  'insights.refreshFailed.window':
    'La última actualización falló. Se muestra en su lugar el período seleccionado anterior.',
  'insights.refreshFailed.range':
    'La última actualización falló. Se muestra en su lugar el intervalo seleccionado anterior.',
  'insights.metric.totalRuns': 'Ejecuciones totales',
  'insights.metric.runsPerDay.window_one': '{{count}} ejecución por día activo en este período.',
  'insights.metric.runsPerDay.window_other':
    '{{count}} ejecuciones por día activo en este período.',
  'insights.metric.runsPerDay.range_one': '{{count}} ejecución por día activo en este intervalo.',
  'insights.metric.runsPerDay.range_other':
    '{{count}} ejecuciones por día activo en este intervalo.',
  'insights.metric.scopedRunsPerDay.window_one':
    '{{count}} ejecución del ámbito por día activo en este período.',
  'insights.metric.scopedRunsPerDay.window_other':
    '{{count}} ejecuciones del ámbito por día activo en este período.',
  'insights.metric.scopedRunsPerDay.range_one':
    '{{count}} ejecución del ámbito por día activo en este intervalo.',
  'insights.metric.scopedRunsPerDay.range_other':
    '{{count}} ejecuciones del ámbito por día activo en este intervalo.',
  'insights.metric.passRate': 'Tasa de aprobación',
  'insights.metric.passedOutOf_one':
    '{{count}} ejecución aprobada de {{decided}} con resultado aprobado o fallido.',
  'insights.metric.passedOutOf_other':
    '{{count}} ejecuciones aprobadas de {{decided}} con resultado aprobado o fallido.',
  'insights.metric.scopedPassedOutOf_one':
    '{{count}} ejecución del ámbito aprobada de {{decided}} con resultado aprobado o fallido.',
  'insights.metric.scopedPassedOutOf_other':
    '{{count}} ejecuciones del ámbito aprobadas de {{decided}} con resultado aprobado o fallido.',
  'insights.metric.avgDuration': 'Duración media',
  'insights.metric.avgDurationDescription':
    'Tiempo medio de las ejecuciones completadas en el intervalo seleccionado.',
  'insights.metric.flakeRate': 'Tasa de inestabilidad',
  'insights.metric.flakeRateDescription_one':
    '{{count}} ejecución fallida; las reparadas y las inestables se cuentan aparte.',
  'insights.metric.flakeRateDescription_other':
    '{{count}} ejecuciones fallidas; las reparadas y las inestables se cuentan aparte.',
  'insights.passRate.title': 'Tasa de aprobación',
  'insights.passRate.description':
    'Evolución de los resultados aprobados a lo largo del período seleccionado.',
  'insights.duration.title': 'Duración',
  'insights.duration.description':
    'Duración media de las ejecuciones por día en el período seleccionado.',
  'insights.chart.passRate': 'Tasa de aprobación',
  'insights.chart.duration': 'Duración',
  'insights.breakdown.test': 'Prueba',
  'insights.breakdown.suite': 'Suite',
  'insights.breakdown.platform': 'Plataforma',
  'insights.breakdown.testTitle': 'Desglose por prueba',
  'insights.breakdown.suiteTitle': 'Desglose por suite',
  'insights.breakdown.platformTitle': 'Desglose por plataforma',
  'insights.breakdown.description':
    'Compara la fiabilidad en una sección inferior aparte para que el resumen del período no cambie.',
  'insights.breakdown.refreshFailed':
    'No se pudo actualizar la comparación. Se muestran los resultados anteriores.',
  'insights.breakdown.updating': 'Actualizando la comparación',
  'insights.breakdown.comparison': 'Comparación por {{label}}',
  'insights.breakdown.breakDownBy': 'Desglosar por',
  'insights.breakdown.unavailable.title': 'Desglose no disponible',
  'insights.breakdown.unavailable.description':
    'Actualiza la página o elige otro período para volver a cargar la comparación seleccionada.',
  'insights.breakdown.empty.test': 'No hay datos de pruebas en este período',
  'insights.breakdown.empty.suite': 'No hay datos de suites en este período',
  'insights.breakdown.empty.platform': 'No hay datos de plataformas en este período',
  'insights.breakdown.empty.description': 'Prueba otro desglose o amplía el período.',
  'insights.breakdown.column.runs': 'Ejecuciones',
  'insights.breakdown.column.passed': 'Aprobadas',
  'insights.breakdown.column.failed': 'Fallidas',
  'insights.breakdown.column.passRate': 'Tasa de aprobación',
  'insights.breakdown.column.flakeRate': 'Tasa de inestabilidad',
  'insights.breakdown.column.avgDuration': 'Duración media',
  'insights.tokens.title': 'Uso de tokens',
  'insights.tokens.description':
    'Actividad de los modelos en todo el período, independiente del selector de desglose.',
  'insights.tokens.total': 'Tokens totales',
  'insights.tokens.input': 'Entrada',
  'insights.tokens.output': 'Salida',
  'insights.tokens.tooltipTotal': 'Total',
  'insights.tokens.byModel': 'Por modelo',
  'insights.tokens.activeModels_one': 'Entrada frente a salida en {{count}} modelo activo',
  'insights.tokens.activeModels_other': 'Entrada frente a salida en {{count}} modelos activos',
  'insights.tokens.testRuns': 'Ejecuciones de pruebas',
  'insights.tokens.liveEditor': 'Editor en vivo',
  'insights.tokens.notRecorded': 'No registrado',
  'insights.tokens.unmeasuredSteps_one':
    '{{count}} paso de una ejecución de prueba no registró uso de tokens y no se cuenta.',
  'insights.tokens.unmeasuredSteps_other':
    '{{count}} pasos de ejecuciones de pruebas no registraron uso de tokens y no se cuentan.',
  'insights.tokens.empty.title': 'No hay uso de tokens en este período',
  'insights.tokens.empty.description':
    'Las métricas de tokens aparecen cuando las ejecuciones o las sesiones en vivo llaman a un modelo.',
  'insights.memory.title': 'Curador de memoria',
  'insights.memory.description':
    'Cambios de conocimiento que la curación registró para las ejecuciones del período seleccionado.',
  'insights.memory.reading': 'Leyendo los cambios de curación de este período.',
  'insights.memory.noAgentHost':
    'No se pudieron leer los cambios de curación: este panel se inició sin un host de agente.',
  'insights.memory.unreadable':
    'No se pudieron leer los cambios de curación de este período. Actualiza la página para volver a intentarlo.',
  'insights.memory.empty.title': 'No hay actividad del curador de memoria en este período',
  'insights.memory.empty.description':
    'Las métricas de memoria aparecen cuando las ejecuciones crean o confirman observaciones.',
  'insights.memory.truncated_one':
    'Se contaron las {{read}} ejecuciones más recientes de {{count}} en este período; las más antiguas no se leyeron.',
  'insights.memory.truncated_other':
    'Se contaron las {{read}} ejecuciones más recientes de {{count}} en este período; las más antiguas no se leyeron.',
  'insights.memory.runsUnreadable_one':
    'No se pudo leer la curación de {{affected}} de {{count}} ejecución; sus cambios no se cuentan.',
  'insights.memory.runsUnreadable_other':
    'No se pudo leer la curación de {{affected}} de {{count}} ejecuciones; sus cambios no se cuentan.',
  'insights.memory.curationFailed_one':
    'La curación falló en {{affected}} de {{count}} ejecución; sus cambios no se cuentan.',
  'insights.memory.curationFailed_other':
    'La curación falló en {{affected}} de {{count}} ejecuciones; sus cambios no se cuentan.',
  'insights.memory.curationUnfinished_one':
    'La curación aún no terminó en {{affected}} de {{count}} ejecución; sus cambios todavía no se cuentan.',
  'insights.memory.curationUnfinished_other':
    'La curación aún no terminó en {{affected}} de {{count}} ejecuciones; sus cambios todavía no se cuentan.',
  'insights.memory.inFlight_one':
    '{{count}} ejecución de este período aún no terminó y no se cuenta.',
  'insights.memory.inFlight_other':
    '{{count}} ejecuciones de este período aún no terminaron y no se cuentan.',
  'insights.memory.changes': 'Cambios',
  'insights.memory.runsRead': 'Ejecuciones leídas',
  'insights.memory.runsReadValue': '{{read}} de {{total}}',
  'insights.memory.changeMix': 'Tipos de cambio',
  'insights.memory.kind.added': 'Añadido',
  'insights.memory.kind.confirmed': 'Confirmado',
  'insights.memory.kind.promoted': 'Promovido',
  'insights.memory.kind.superseded': 'Sustituido',
  'insights.memory.kind.deprecated': 'Obsoleto',
  'insights.memory.noChanges_one':
    'No se encontraron cambios en la única ejecución cuya curación terminó.',
  'insights.memory.noChanges_other':
    'No se encontraron cambios en las {{count}} ejecuciones cuya curación terminó.',
  'insights.memory.noFinishedCuration':
    'Ninguna ejecución de este período tiene una curación terminada que contar.',
} satisfies Translation<typeof en>
