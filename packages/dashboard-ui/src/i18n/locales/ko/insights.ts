import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'insights.title': '인사이트',
  'insights.description':
    '기간 전체의 안정성, 비용, 큐레이터 신호를 보여 주며, 테스트, 스위트, 플랫폼을 비교하는 섹션은 따로 있습니다.',
  'insights.scope.label': '실행 집계 대상',
  'insights.scope.scoped': '집계 대상',
  'insights.scope.all': '모든 실행',
  'insights.window.label': '기간',
  'insights.window.oneDay': '1일',
  'insights.window.sevenDays': '7일',
  'insights.window.thirtyDays': '30일',
  'insights.window.all': '전체 기간',
  'insights.refreshing': '선택한 범위를 새로 고치는 중',
  'insights.unavailable.title': '인사이트를 사용할 수 없음',
  'insights.unavailable.description':
    '페이지를 새로 고치세요. 문제가 계속되면 기간을 바꾸고 분석 데이터가 있는지 확인하세요.',
  'insights.empty.title': '이 기간에 실행이 없습니다',
  'insights.empty.description':
    '테스트를 실행하거나 다시 실행하면 인사이트가 채워집니다. 더 오래된 데이터가 있어야 한다면 30일 또는 전체 기간으로 바꾸세요.',
  'insights.empty.action': '실행 페이지 열기',
  'insights.refreshFailed.window':
    '마지막 새로 고침에 실패했습니다. 이전에 선택한 기간을 대신 표시합니다.',
  'insights.refreshFailed.range':
    '마지막 새로 고침에 실패했습니다. 이전에 선택한 범위를 대신 표시합니다.',
  'insights.metric.totalRuns': '총 실행',
  'insights.metric.runsPerDay.window_other': '이 기간의 활동일 하루 평균 실행은 {{count}}개입니다.',
  'insights.metric.runsPerDay.range_other': '이 범위의 활동일 하루 평균 실행은 {{count}}개입니다.',
  'insights.metric.scopedRunsPerDay.window_other':
    '이 기간의 활동일 하루 평균 집계 대상 실행은 {{count}}개입니다.',
  'insights.metric.scopedRunsPerDay.range_other':
    '이 범위의 활동일 하루 평균 집계 대상 실행은 {{count}}개입니다.',
  'insights.metric.passRate': '통과율',
  'insights.metric.passedOutOf_other':
    '통과 또는 실패한 실행 {{decided}}개 중 {{count}}개가 성공했습니다.',
  'insights.metric.scopedPassedOutOf_other':
    '통과 또는 실패한 집계 대상 실행 {{decided}}개 중 {{count}}개가 성공했습니다.',
  'insights.metric.avgDuration': '평균 소요 시간',
  'insights.metric.avgDurationDescription': '선택한 범위에서 완료된 실행의 평균 소요 시간입니다.',
  'insights.metric.flakeRate': '불안정률',
  'insights.metric.flakeRateDescription_other':
    '실패한 실행 {{count}}개입니다. 복구됨/불안정 동작은 따로 집계합니다.',
  'insights.passRate.title': '통과율',
  'insights.passRate.description': '선택한 기간의 성공 결과 추이입니다.',
  'insights.duration.title': '소요 시간',
  'insights.duration.description': '선택한 기간의 일별 평균 실행 소요 시간입니다.',
  'insights.chart.passRate': '통과율',
  'insights.chart.duration': '소요 시간',
  'insights.breakdown.test': '테스트',
  'insights.breakdown.suite': '스위트',
  'insights.breakdown.platform': '플랫폼',
  'insights.breakdown.testTitle': '테스트별 세부 현황',
  'insights.breakdown.suiteTitle': '스위트별 세부 현황',
  'insights.breakdown.platformTitle': '플랫폼별 세부 현황',
  'insights.breakdown.description':
    '아래의 별도 섹션에서 안정성을 비교하므로 기간 전체 요약은 그대로 유지됩니다.',
  'insights.breakdown.refreshFailed': '비교를 새로 고치지 못했습니다. 이전 결과를 표시합니다.',
  'insights.breakdown.updating': '비교 업데이트 중',
  'insights.breakdown.comparison': '{{label}} 비교',
  'insights.breakdown.breakDownBy': '구분 기준',
  'insights.breakdown.unavailable.title': '세부 현황을 사용할 수 없음',
  'insights.breakdown.unavailable.description':
    '페이지를 새로 고치거나 다른 기간을 선택해 선택한 비교를 다시 불러오세요.',
  'insights.breakdown.empty.test': '이 기간에 테스트 데이터가 없습니다',
  'insights.breakdown.empty.suite': '이 기간에 스위트 데이터가 없습니다',
  'insights.breakdown.empty.platform': '이 기간에 플랫폼 데이터가 없습니다',
  'insights.breakdown.empty.description': '다른 구분 기준을 선택하거나 기간을 넓혀 보세요.',
  'insights.breakdown.column.runs': '실행',
  'insights.breakdown.column.passed': '통과',
  'insights.breakdown.column.failed': '실패',
  'insights.breakdown.column.passRate': '통과율',
  'insights.breakdown.column.flakeRate': '불안정률',
  'insights.breakdown.column.avgDuration': '평균 소요 시간',
  'insights.tokens.title': '토큰 사용량',
  'insights.tokens.description': '구분 기준 선택과 관계없는 기간 전체의 모델 활동입니다.',
  'insights.tokens.total': '총 토큰',
  'insights.tokens.input': '입력',
  'insights.tokens.output': '출력',
  'insights.tokens.tooltipTotal': '합계',
  'insights.tokens.byModel': '모델별',
  'insights.tokens.activeModels_other': '활성 모델 {{count}}개의 입력 대비 출력',
  'insights.tokens.testRuns': '테스트 실행',
  'insights.tokens.liveEditor': '라이브 편집기',
  'insights.tokens.notRecorded': '기록되지 않음',
  'insights.tokens.unmeasuredSteps_other':
    '토큰 사용량을 기록하지 않은 테스트 실행 단계 {{count}}개는 집계하지 않습니다.',
  'insights.tokens.empty.title': '이 기간에 토큰 사용량이 없습니다',
  'insights.tokens.empty.description':
    '실행이나 라이브 세션에서 모델을 호출하면 토큰 지표가 표시됩니다.',
  'insights.memory.title': '메모리 큐레이터',
  'insights.memory.description':
    '선택한 기간의 실행에 대해 큐레이션이 기록한 지식 변경 사항입니다.',
  'insights.memory.reading': '이 기간의 큐레이션 변경 사항을 읽는 중입니다.',
  'insights.memory.noAgentHost':
    '큐레이션 변경 사항을 읽을 수 없습니다. 이 대시보드는 에이전트 호스트 없이 시작되었습니다.',
  'insights.memory.unreadable':
    '이 기간의 큐레이션 변경 사항을 읽을 수 없습니다. 페이지를 새로 고쳐 다시 시도하세요.',
  'insights.memory.empty.title': '이 기간에 메모리 큐레이터 활동이 없습니다',
  'insights.memory.empty.description':
    '실행에서 관찰을 만들거나 확인하면 메모리 지표가 표시됩니다.',
  'insights.memory.truncated_other':
    '이 기간의 실행 {{count}}개 중 최근 {{read}}개를 집계했습니다. 그 이전 실행은 읽지 않았습니다.',
  'insights.memory.runsUnreadable_other':
    '실행 {{count}}개 중 {{affected}}개의 큐레이션을 읽지 못했습니다. 해당 변경 사항은 집계하지 않습니다.',
  'insights.memory.curationFailed_other':
    '실행 {{count}}개 중 {{affected}}개의 큐레이션이 실패했습니다. 해당 변경 사항은 집계하지 않습니다.',
  'insights.memory.curationUnfinished_other':
    '실행 {{count}}개 중 {{affected}}개의 큐레이션이 아직 끝나지 않았습니다. 해당 변경 사항은 아직 집계하지 않습니다.',
  'insights.memory.inFlight_other':
    '이 기간의 실행 {{count}}개가 아직 끝나지 않아 집계하지 않습니다.',
  'insights.memory.changes': '변경 사항',
  'insights.memory.runsRead': '읽은 실행',
  'insights.memory.runsReadValue': '{{total}}개 중 {{read}}개',
  'insights.memory.changeMix': '변경 유형 구성',
  'insights.memory.kind.added': '추가됨',
  'insights.memory.kind.confirmed': '확인됨',
  'insights.memory.kind.promoted': '승격됨',
  'insights.memory.kind.superseded': '대체됨',
  'insights.memory.kind.deprecated': '폐기됨',
  'insights.memory.noChanges_other': '큐레이션이 끝난 실행 {{count}}개에서 변경 사항이 없습니다.',
  'insights.memory.noFinishedCuration': '이 기간에는 집계할 큐레이션이 끝난 실행이 없습니다.',
} satisfies Translation<typeof en>
