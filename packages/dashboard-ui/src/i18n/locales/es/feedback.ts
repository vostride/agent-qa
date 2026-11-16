import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'feedback.place.thisTest': 'esta prueba',
  'feedback.place.test': '{{name}} {{handle}}',
  'feedback.place.step': 'paso {{number}}',
  'feedback.place.stepOfTest': 'paso {{number}} de {{test}}',
  'feedback.composer.pinnedTarget':
    'Vista actual: {{viewed}}. Estos comentarios son sobre: {{about}}.',
  'feedback.composer.switchTarget': 'Cambiar a: {{place}}',
  'feedback.composer.unsentDraft': 'Borrador sin enviar: {{place}}',
  'feedback.composer.headingStep': 'Comentarios sobre el paso {{number}} de {{total}} · {{name}}',
  'feedback.composer.headingTest': 'Comentarios sobre {{name}}',
  'feedback.composer.headingSuiteTest': 'Comentarios sobre {{name}} {{handle}}',
  'feedback.choice.falseFail': 'Esto debería haberse aprobado',
  'feedback.choice.falsePass': 'Esto debería haber fallado',
  'feedback.choice.confirmedBug': 'Es un error real del producto',
  'feedback.choiceMeaning.failed.falseFail':
    'La aplicación se comportó correctamente; la prueba falló por error.',
  'feedback.choiceMeaning.failed.confirmedBug':
    'El fallo es real: la aplicación no funciona bien aquí.',
  'feedback.choiceMeaning.failed.falsePass':
    'La prueba pasó por alto un problema que debería haber detectado.',
  'feedback.choiceMeaning.passed.falseFail': 'La aprobación es correcta; esto confirma la prueba.',
  'feedback.choiceMeaning.passed.confirmedBug':
    'La aplicación tiene un error real aquí, aunque la prueba se aprobó.',
  'feedback.choiceMeaning.passed.falsePass':
    'La aplicación no funcionaba bien aquí, pero la prueba se aprobó de todos modos.',
  'feedback.scope.recorded.passed': 'registrado: aprobado',
  'feedback.scope.recorded.healed': 'registrado: reparado; cuenta como aprobado',
  'feedback.scope.recorded.failed': 'registrado: fallido',
  'feedback.scope.recorded.timeout': 'registrado: tiempo agotado; cuenta como fallido',
  'feedback.scope.recorded.cancelled': 'registrado: cancelado; cuenta como fallido',
  'feedback.scope.recorded.skipped': 'registrado: omitido; cuenta como fallido',
  'feedback.scope.noStepVerdict':
    'no se registró ningún veredicto del paso; se usa el resultado de la prueba ({{recorded}})',
  'feedback.scope.wholeTest': 'Toda la prueba · {{recorded}}',
  'feedback.scope.oneStep': 'Un paso · {{recorded}}',
  'feedback.scope.oneStepInTest': 'Un paso de {{name}} {{handle}} · {{recorded}}',
  'feedback.entry.step': 'Dar comentarios sobre el paso {{number}}',
  'feedback.entry.member': 'Dar comentarios sobre {{name}} {{handle}}',
  'feedback.entry.stepMarked':
    'Dar comentarios sobre el paso {{number}}. Ya tiene una marca: {{choice}}',
  'feedback.entry.testMarked': 'Dar comentarios sobre esta prueba. Ya tiene una marca: {{choice}}',
  'feedback.entry.memberMarked':
    'Dar comentarios sobre {{name}} {{handle}}. Ya tiene una marca: {{choice}}',
  'feedback.entry.stepMarkedTooltip': 'El paso {{number}} ya tiene una marca: revísala o cámbiala',
  'feedback.entry.markGlyph': 'Marca: {{choice}}',
  'feedback.disposition.applied.fact': 'Registrado: se añadió un dato de conocimiento',
  'feedback.disposition.applied.caution': 'Registrado: se añadió una advertencia',
  'feedback.disposition.applied.procedureHint': 'Registrado: se añadió una pista de procedimiento',
  'feedback.disposition.applied.testEdit': 'Registrado: se editó el archivo de la prueba',
  'feedback.disposition.drafted': 'Registrado: se redactó una corrección (marca antigua)',
  'feedback.disposition.noDraftableFix': 'Registrado: no se pudo redactar ninguna corrección',
  'feedback.disposition.confirmedBug':
    'Registrado: se mantiene como error real del producto; no cambió nada',
  'feedback.disposition.notApplied.targetNotFound':
    'Registrado: no se aplicó la corrección porque el conocimiento que sustituye ya no existe',
  'feedback.disposition.notApplied.policyMaterializeRefused':
    'Registrado: no se aplicó la corrección porque se rechazó el texto de su política',
  'feedback.disposition.notApplied.outsideWorkspace':
    'Registrado: no se aplicó la corrección porque el archivo de la prueba está fuera del espacio de trabajo',
  'feedback.disposition.quarantined': 'Registrado: en cuarentena ({{cause}})',
  'feedback.recorded.applied.fact': 'Comentarios registrados: se añadió un dato de conocimiento.',
  'feedback.recorded.applied.caution': 'Comentarios registrados: se añadió una advertencia.',
  'feedback.recorded.applied.procedureHint':
    'Comentarios registrados: se añadió una pista de procedimiento.',
  'feedback.recorded.applied.testEdit':
    'Comentarios registrados: se editó el archivo de la prueba.',
  'feedback.recorded.drafted':
    'Comentarios registrados: se redactó una corrección (marca antigua).',
  'feedback.recorded.noDraftableFix':
    'Comentarios registrados: no se pudo redactar ninguna corrección.',
  'feedback.recorded.confirmedBug':
    'Comentarios registrados: se mantiene como error real del producto; no cambió nada.',
  'feedback.recorded.notApplied.targetNotFound':
    'Comentarios registrados: no se aplicó la corrección porque el conocimiento que sustituye ya no existe.',
  'feedback.recorded.notApplied.policyMaterializeRefused':
    'Comentarios registrados: no se aplicó la corrección porque se rechazó el texto de su política.',
  'feedback.recorded.notApplied.outsideWorkspace':
    'Comentarios registrados: no se aplicó la corrección porque el archivo de la prueba está fuera del espacio de trabajo.',
  'feedback.recorded.quarantined': 'Comentarios registrados: en cuarentena ({{cause}}).',
  'feedback.preview.lineLabel.knowledge': 'Conocimiento',
  'feedback.preview.lineLabel.change': 'Cambio',
  'feedback.preview.noRecordsReached': 'No afecta a ningún registro de conocimiento',
  'feedback.preview.confirmed_one': '{{count}} registro confirmado',
  'feedback.preview.confirmed_other': '{{count}} registros confirmados',
  'feedback.preview.countedAgainst_one': '{{count}} contado en contra',
  'feedback.preview.countedAgainst_other': '{{count}} contados en contra',
  'feedback.preview.confirmedAndCountedAgainst': '{{confirmed}} · {{countedAgainst}}',
  'feedback.preview.unreadableRecords_one': '{{count}} registro afectado: no se puede leer',
  'feedback.preview.unreadableRecords_other':
    '{{count}} registros afectados: no se puede leer ninguno',
  'feedback.preview.showRecords': 'Mostrar los registros ({{number}})',
  'feedback.preview.effect.confirm': 'confirma',
  'feedback.preview.effect.overturn': 'cuenta en contra',
  'feedback.preview.effect.overturnTimes': 'cuenta en contra × {{times}}',
  'feedback.preview.effect.confirmAndOverturn': '{{confirm}} · {{overturn}}',
  'feedback.preview.contentAbsence.notFound': 'No se encontró el contenido del registro',
  'feedback.preview.contentAbsence.scanIncomplete':
    'No se pudo leer todo el contenido del registro',
  'feedback.preview.contentAbsence.notBound':
    'El contenido del registro no está disponible en este host',
  'feedback.preview.fix.fact': 'Se añadirá un dato de conocimiento',
  'feedback.preview.fix.caution': 'Se añadirá una advertencia',
  'feedback.preview.fix.procedureHint': 'Se añadirá una pista de procedimiento',
  'feedback.preview.fix.testEdit': 'Se editará el archivo de la prueba',
  'feedback.preview.fix.noDraftableFix':
    'No se puede hacer ninguna corrección a partir de esta ejecución',
  'feedback.preview.fix.confirmedBug':
    'No cambia nada: un error real del producto necesita una corrección en el producto, no un cambio en la prueba ni en el conocimiento',
  'feedback.preview.replaces':
    'Sustituye tu marca anterior (n.º {{mark}}); lo que cambió se mantiene',
  'feedback.preview.replacesAt':
    'Sustituye tu marca anterior (n.º {{mark}}, {{time}}); lo que cambió se mantiene',
  'feedback.preview.resolvedStep.failingStep':
    'Esto marca el paso {{number}} de {{total}}, el primer paso que falló.',
  'feedback.preview.resolvedStep.lastStepFinished':
    'Esto marca el paso {{number}} de {{total}}, el último paso, donde terminó la prueba.',
  'feedback.preview.resolvedStep.lastStepNoFailure':
    'Esto marca el paso {{number}} de {{total}}, el último paso, porque ningún paso falló.',
  'feedback.preview.showStep': 'Mostrar el paso {{number}}',
  'feedback.preview.quarantined.timeout':
    'Esta prueba falló por un tiempo agotado, así que tu marca se registra, pero queda en cuarentena: no cambia ningún conocimiento ni ninguna prueba.',
  'feedback.preview.quarantined.flake':
    'Esta prueba falló en una ejecución inestable, así que tu marca se registra, pero queda en cuarentena: no cambia ningún conocimiento ni ninguna prueba.',
  'feedback.preview.quarantined.environment':
    'Esta prueba falló por un problema del entorno, así que tu marca se registra, pero queda en cuarentena: no cambia ningún conocimiento ni ninguna prueba.',
  'feedback.preview.alreadyMarked': 'Ya dijiste esto. Una nota nueva por sí sola no se registra.',
  'feedback.preview.alreadyMarkedAt':
    'Ya dijiste esto ({{time}}). Una nota nueva por sí sola no se registra.',
  'feedback.preview.refusal.runNotFound':
    'Esta ejecución ya no está en el almacén de ejecuciones, así que no se pueden registrar comentarios.',
  'feedback.preview.refusal.memberNotFound':
    'Esta prueba no se encuentra en la ejecución, así que no se pueden registrar comentarios.',
  'feedback.preview.refusal.noSteps':
    'Esta prueba no registró ningún paso, así que no hay nada que marcar.',
  'feedback.preview.refusal.stepNotFound_one':
    'Esta prueba registró {{count}} paso, así que no hay ningún paso {{number}} que marcar.',
  'feedback.preview.refusal.stepNotFound_other':
    'Esta prueba registró {{count}} pasos, así que no hay ningún paso {{number}} que marcar.',
  'feedback.preview.refusal.ambiguousAddress_one':
    '{{count}} prueba de esta ejecución tiene esta dirección, así que no se puede colocar la marca.',
  'feedback.preview.refusal.ambiguousAddress_other':
    '{{count}} pruebas de esta ejecución comparten esta dirección, así que no se puede colocar la marca.',
  'feedback.preview.readFailed': 'No se pudo comprobar qué hará esto: {{reason}}.',
  'feedback.readFailure.network': 'el servidor del panel no respondió',
  'feedback.readFailure.ledgerCorrupt': 'el registro de comentarios de esta ejecución está dañado',
  'feedback.readFailure.ledgerUnavailable':
    'el registro de comentarios de esta ejecución no se puede leer ahora',
  'feedback.readFailure.refused': 'el servidor rechazó la solicitud',
  'feedback.readFailure.shape': 'la respuesta del servidor no tenía el formato esperado',
  'feedback.details.row.kind': 'Tipo de marca',
  'feedback.details.row.address': 'Dirección',
  'feedback.details.row.testId': 'ID de la prueba',
  'feedback.details.row.records': 'Registros afectados',
  'feedback.details.row.basis': 'Base',
  'feedback.details.basis': 'número de orden en el registro de comentarios: {{ledger}}',
  'feedback.details.basisWithPrior':
    'número de orden en el registro de comentarios: {{ledger}} · marca anterior n.º {{prior}}',
  'feedback.history.title.step': 'Comentarios sobre este paso',
  'feedback.history.title.test': 'Comentarios sobre esta prueba',
  'feedback.history.titleCount.step': 'Comentarios sobre este paso ({{number}})',
  'feedback.history.titleCount.test': 'Comentarios sobre esta prueba ({{number}})',
  'feedback.history.runLabel': 'Todos los comentarios sobre esta ejecución ({{number}})',
  'feedback.history.replacedBy': 'Sustituida por tu marca posterior',
  'feedback.history.replacedByAt': 'Sustituida por tu marca posterior ({{time}})',
  'feedback.history.recordUnavailable': '{{recordId}} (contenido no disponible)',
  'feedback.history.quoted': '“{{content}}”',
  'feedback.history.appliedKnowledge': 'Conocimiento cambiado: {{records}}',
  'feedback.history.appliedTestFile': 'Se editó el archivo de la prueba {{file}}',
  'feedback.history.change.records': '{{disposition}}: {{records}}',
  'feedback.history.change.file': '{{disposition}}: {{file}}',
  'feedback.history.change.draftedNotRecorded': '{{disposition}}; no se registró lo que cambió.',
  'feedback.history.change.contentNotRecorded': '{{disposition}}; no se registró su contenido.',
  'feedback.history.empty.step': 'Aún no hay comentarios sobre este paso.',
  'feedback.history.empty.test': 'Aún no hay comentarios sobre esta prueba.',
  'feedback.history.empty.run': 'Aún no hay comentarios sobre esta ejecución.',
  'feedback.history.state.runNotFound':
    'No se encuentra el historial de comentarios de esta ejecución.',
  'feedback.history.state.ledgerCorrupt':
    'El historial de comentarios de esta ejecución está dañado en la línea {{line}}, así que no se puede mostrar.',
  'feedback.history.state.ledgerUnavailable':
    'El historial de comentarios de esta ejecución no se puede leer ahora.',
  'feedback.history.readFailed':
    'No se pudo cargar el historial de comentarios de esta ejecución: {{reason}}.',
  'feedback.history.targetStep': 'Paso {{number}} de {{total}} · {{name}}',
  'feedback.history.targetTest': '{{name}} {{handle}} · toda la prueba',
  'feedback.composer.noteLabel': 'Nota (opcional)',
  'feedback.composer.choiceLegend': '¿Qué es cierto?',
  'feedback.composer.testSwitcherLabel': 'Prueba',
  'feedback.composer.noUniqueAddress':
    'Esta prueba no tiene una dirección única en esta ejecución, así que no se pueden registrar comentarios sobre ella.',
  'feedback.composer.submitReason.noUniqueAddress':
    'Esta prueba no se puede marcar desde el panel.',
  'feedback.composer.submitReason.noChoice': 'Elige una de las tres opciones.',
  'feedback.composer.submitReason.checking': 'Comprobando qué hará esto…',
  'feedback.composer.submitReason.previewFailed':
    'No se pudieron comprobar las consecuencias. Reinténtalo arriba.',
  'feedback.composer.submitReason.refused': 'Esta marca no se puede registrar. Consulta arriba.',
  'feedback.composer.submitReason.alreadyMarked':
    'Ya dijiste esto: no hay nada nuevo que registrar.',
  'feedback.composer.submitReason.sending': 'Enviando…',
  'feedback.composer.send': 'Enviar comentarios',
  'feedback.preview.title': 'Qué hará esto',
  'feedback.composer.sendingStatus': 'Enviando comentarios…',
  'feedback.entry.test': 'Dar comentarios sobre esta prueba',
  'feedback.composer.close': 'Cerrar los comentarios',
  'feedback.composer.closeTooltip': 'Cerrar (Esc)',
  'feedback.composer.draftKeptStatus':
    'Se conservó el borrador. Revisa el mensaje de arriba antes de volver a enviarlo.',
  'feedback.entry.tooltip': 'Dar comentarios',
  'feedback.entry.markedTooltip': 'Ya tiene una marca: revísala o cámbiala',
  'feedback.preview.updating': 'Actualizando…',
  'feedback.preview.idle': 'Elige una opción arriba para ver qué hará esto.',
  'feedback.preview.unreadableRecord':
    'Este registro no se puede leer: conserva su lugar y no se le aplica nada.',
  'feedback.preview.draftWordingNotShown':
    'El texto exacto no se muestra aquí: se redacta cuando envías.',
  'feedback.retry': 'Reintentar',
  'feedback.details.label': 'Detalles técnicos',
  'feedback.history.active': 'Activa',
  'feedback.history.replacementExplanation':
    'Solo cuenta tu última marca en una prueba o en un paso.',
  'feedback.history.appliedUnavailable': 'No se registró lo que cambió esta marca.',
  'feedback.preview.cliEscape':
    'Todavía puedes registrar comentarios desde la CLI ({{name}}) o por MCP.',
  'feedback.preview.retryName': 'Reintentar la comprobación de qué hará esto',
  'feedback.history.retryName': 'Reintentar la carga del historial de comentarios',
  'feedback.history.appliedCorrection':
    'Una corrección se mantiene cuando vuelves a marcar: corrige el conocimiento con nuevos comentarios o olvidándolo, y revierte una edición de la prueba con git.',
} satisfies Translation<typeof en>
