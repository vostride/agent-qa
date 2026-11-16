import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'insights.title': 'Estatísticas',
  'insights.description':
    'Sinais de confiabilidade, custo e curadoria de todo o período, com uma seção separada para comparar testes, suítes e plataformas.',
  'insights.scope.label': 'Escopo das execuções',
  'insights.scope.scoped': 'No escopo',
  'insights.scope.all': 'Todas as execuções',
  'insights.window.label': 'Período',
  'insights.window.oneDay': '1D',
  'insights.window.sevenDays': '7D',
  'insights.window.thirtyDays': '30D',
  'insights.window.all': 'Todo o período',
  'insights.refreshing': 'Atualizando o intervalo selecionado',
  'insights.unavailable.title': 'Estatísticas indisponíveis',
  'insights.unavailable.description':
    'Recarregue a página. Se o problema continuar, mude o período e verifique se há dados de análise disponíveis.',
  'insights.empty.title': 'Nenhuma execução neste período',
  'insights.empty.description':
    'Execute testes ou execute-os novamente para preencher as estatísticas. Se você espera dados mais antigos, mude para 30D ou Todo o período.',
  'insights.empty.action': 'Abrir Execuções',
  'insights.refreshFailed.window':
    'A última atualização falhou. Mostrando o período selecionado anteriormente.',
  'insights.refreshFailed.range':
    'A última atualização falhou. Mostrando o intervalo selecionado anteriormente.',
  'insights.metric.totalRuns': 'Total de execuções',
  'insights.metric.runsPerDay.window_one': '{{count}} execução por dia ativo neste período.',
  'insights.metric.runsPerDay.window_other': '{{count}} execuções por dia ativo neste período.',
  'insights.metric.runsPerDay.range_one': '{{count}} execução por dia ativo neste intervalo.',
  'insights.metric.runsPerDay.range_other': '{{count}} execuções por dia ativo neste intervalo.',
  'insights.metric.scopedRunsPerDay.window_one':
    '{{count}} execução no escopo por dia ativo neste período.',
  'insights.metric.scopedRunsPerDay.window_other':
    '{{count}} execuções no escopo por dia ativo neste período.',
  'insights.metric.scopedRunsPerDay.range_one':
    '{{count}} execução no escopo por dia ativo neste intervalo.',
  'insights.metric.scopedRunsPerDay.range_other':
    '{{count}} execuções no escopo por dia ativo neste intervalo.',
  'insights.metric.passRate': 'Taxa de aprovação',
  'insights.metric.passedOutOf_one':
    '{{count}} execução bem-sucedida de {{decided}} que foram aprovadas ou falharam.',
  'insights.metric.passedOutOf_other':
    '{{count}} execuções bem-sucedidas de {{decided}} que foram aprovadas ou falharam.',
  'insights.metric.scopedPassedOutOf_one':
    '{{count}} execução no escopo bem-sucedida de {{decided}} que foram aprovadas ou falharam.',
  'insights.metric.scopedPassedOutOf_other':
    '{{count}} execuções no escopo bem-sucedidas de {{decided}} que foram aprovadas ou falharam.',
  'insights.metric.avgDuration': 'Duração média',
  'insights.metric.avgDurationDescription':
    'Tempo médio das execuções concluídas no intervalo selecionado.',
  'insights.metric.flakeRate': 'Taxa de instabilidade',
  'insights.metric.flakeRateDescription_one':
    '{{count}} execução com falha; o comportamento reparado ou instável é contado à parte.',
  'insights.metric.flakeRateDescription_other':
    '{{count}} execuções com falha; o comportamento reparado ou instável é contado à parte.',
  'insights.passRate.title': 'Taxa de aprovação',
  'insights.passRate.description': 'Tendência dos resultados bem-sucedidos no período selecionado.',
  'insights.duration.title': 'Duração',
  'insights.duration.description': 'Duração média das execuções por dia no período selecionado.',
  'insights.chart.passRate': 'Taxa de aprovação',
  'insights.chart.duration': 'Duração',
  'insights.breakdown.test': 'Teste',
  'insights.breakdown.suite': 'Suíte',
  'insights.breakdown.platform': 'Plataforma',
  'insights.breakdown.testTitle': 'Detalhamento por teste',
  'insights.breakdown.suiteTitle': 'Detalhamento por suíte',
  'insights.breakdown.platformTitle': 'Detalhamento por plataforma',
  'insights.breakdown.description':
    'Compare a confiabilidade em uma seção à parte, mais abaixo, para que o resumo geral do período não mude.',
  'insights.breakdown.refreshFailed':
    'Não foi possível atualizar a comparação. Mostrando os resultados anteriores.',
  'insights.breakdown.updating': 'Atualizando a comparação',
  'insights.breakdown.comparison': 'Comparação por {{label}}',
  'insights.breakdown.breakDownBy': 'Detalhar por',
  'insights.breakdown.unavailable.title': 'Detalhamento indisponível',
  'insights.breakdown.unavailable.description':
    'Recarregue a página ou escolha outro período para carregar de novo a comparação selecionada.',
  'insights.breakdown.empty.test': 'Nenhum dado de teste neste período',
  'insights.breakdown.empty.suite': 'Nenhum dado de suíte neste período',
  'insights.breakdown.empty.platform': 'Nenhum dado de plataforma neste período',
  'insights.breakdown.empty.description': 'Tente outro detalhamento ou amplie o período.',
  'insights.breakdown.column.runs': 'Execuções',
  'insights.breakdown.column.passed': 'Aprovadas',
  'insights.breakdown.column.failed': 'Com falha',
  'insights.breakdown.column.passRate': 'Taxa de aprovação',
  'insights.breakdown.column.flakeRate': 'Taxa de instabilidade',
  'insights.breakdown.column.avgDuration': 'Duração média',
  'insights.tokens.title': 'Uso de tokens',
  'insights.tokens.description':
    'Atividade dos modelos em todo o período, independente do seletor de detalhamento.',
  'insights.tokens.total': 'Total de tokens',
  'insights.tokens.input': 'Entrada',
  'insights.tokens.output': 'Saída',
  'insights.tokens.tooltipTotal': 'Total',
  'insights.tokens.byModel': 'Por modelo',
  'insights.tokens.activeModels_one': 'Entrada e saída em {{count}} modelo ativo',
  'insights.tokens.activeModels_other': 'Entrada e saída em {{count}} modelos ativos',
  'insights.tokens.testRuns': 'Execuções de teste',
  'insights.tokens.liveEditor': 'Editor ao vivo',
  'insights.tokens.notRecorded': 'Não registrado',
  'insights.tokens.unmeasuredSteps_one':
    '{{count}} etapa de execução de teste não registrou uso de tokens e não é contada.',
  'insights.tokens.unmeasuredSteps_other':
    '{{count}} etapas de execução de teste não registraram uso de tokens e não são contadas.',
  'insights.tokens.empty.title': 'Nenhum uso de tokens neste período',
  'insights.tokens.empty.description':
    'As métricas de tokens aparecem depois que execuções ou sessões ao vivo fazem chamadas ao modelo.',
  'insights.memory.title': 'Curador de memória',
  'insights.memory.description':
    'Mudanças no conhecimento que a curadoria registrou para as execuções do período selecionado.',
  'insights.memory.reading': 'Lendo as mudanças da curadoria neste período.',
  'insights.memory.noAgentHost':
    'Não foi possível ler as mudanças da curadoria: este painel foi iniciado sem um host de agente.',
  'insights.memory.unreadable':
    'Não foi possível ler as mudanças da curadoria neste período. Recarregue a página para tentar novamente.',
  'insights.memory.empty.title': 'Nenhuma atividade do curador de memória neste período',
  'insights.memory.empty.description':
    'As métricas de memória aparecem depois que as execuções criam ou confirmam observações.',
  'insights.memory.truncated_one':
    'Foram contadas as {{read}} mais recentes de {{count}} execução neste período; as mais antigas não foram lidas.',
  'insights.memory.truncated_other':
    'Foram contadas as {{read}} mais recentes de {{count}} execuções neste período; as mais antigas não foram lidas.',
  'insights.memory.runsUnreadable_one':
    'Não foi possível ler a curadoria de {{affected}} de {{count}} execução; as mudanças dela não são contadas.',
  'insights.memory.runsUnreadable_other':
    'Não foi possível ler a curadoria de {{affected}} de {{count}} execuções; as mudanças delas não são contadas.',
  'insights.memory.curationFailed_one':
    'A curadoria falhou em {{affected}} de {{count}} execução; as mudanças dela não são contadas.',
  'insights.memory.curationFailed_other':
    'A curadoria falhou em {{affected}} de {{count}} execuções; as mudanças delas não são contadas.',
  'insights.memory.curationUnfinished_one':
    'A curadoria ainda não terminou em {{affected}} de {{count}} execução; as mudanças dela ainda não são contadas.',
  'insights.memory.curationUnfinished_other':
    'A curadoria ainda não terminou em {{affected}} de {{count}} execuções; as mudanças delas ainda não são contadas.',
  'insights.memory.inFlight_one':
    '{{count}} execução neste período ainda não terminou e não é contada.',
  'insights.memory.inFlight_other':
    '{{count}} execuções neste período ainda não terminaram e não são contadas.',
  'insights.memory.changes': 'Mudanças',
  'insights.memory.runsRead': 'Execuções lidas',
  'insights.memory.runsReadValue': '{{read}} de {{total}}',
  'insights.memory.changeMix': 'Tipos de mudança',
  'insights.memory.kind.added': 'Adicionado',
  'insights.memory.kind.confirmed': 'Confirmado',
  'insights.memory.kind.promoted': 'Promovido',
  'insights.memory.kind.superseded': 'Substituído',
  'insights.memory.kind.deprecated': 'Obsoleto',
  'insights.memory.noChanges_one':
    'Nenhuma mudança encontrada na {{count}} execução cuja curadoria terminou.',
  'insights.memory.noChanges_other':
    'Nenhuma mudança encontrada nas {{count}} execuções cuja curadoria terminou.',
  'insights.memory.noFinishedCuration':
    'Nenhuma execução neste período tem uma curadoria concluída para contar.',
} satisfies Translation<typeof en>
