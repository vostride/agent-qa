import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'tour.intro.title': 'agent-qa에 오신 것을 환영합니다',
  'tour.intro.body':
    'agent-qa로 웹과 모바일 테스트를 자연어로 작성할 수 있습니다. 테스트를 엄격한 QA 하네스로 실행하고, 지난 실행에서 학습하며, UI가 바뀌면 적응하고, 무슨 일이 있었는지 정확히 보여 줍니다.',
  'tour.llmSetup.title': '먼저 LLM 설정하기',
  'tour.runs.title': '실행에서 결과 확인',
  'tour.runs.body': '실행 페이지에는 agent-qa의 모든 실행 결과, 산출물, 추론 과정이 표시됩니다.',
  'tour.tests.title': '테스트는 자연어 검사를 담습니다',
  'tour.tests.body':
    '테스트는 agent-qa가 설정된 웹 또는 모바일 대상에 대해 실행할 수 있는 자연어 검사입니다.',
  'tour.suites.title': '스위트로 반복 가능한 워크플로 구성',
  'tour.suites.body':
    '테스트 하나로 충분하지 않을 때 스위트는 관련 검사를 반복 가능한 워크플로로 묶습니다.',
  'tour.hooks.title': '훅은 단계 앞뒤와 사이에서 실행됩니다',
  'tour.hooks.body':
    '훅은 테스트나 스위트 전후에 준비와 정리를 맡고, 단계 사이에서 인라인으로 실행될 수도 있습니다.',
  'tour.config.title': '설정에서 로컬 환경 관리',
  'tour.config.body':
    '설정에서는 agent-qa가 로컬에서 사용하는 모델, 대상, 런타임, 대시보드 구성을 관리합니다.',
  'tour.exampleTest.title': '통과 예시 테스트 실행',
  'tour.exampleTest.body':
    '이 생성된 테스트는 init이 설정을 검증하려고 만든 것이므로 첫 실행으로 가장 안전합니다.',
  'tour.exampleMissing.title': '통과 예시 테스트 찾기',
  'tour.exampleMissing.body':
    '보통 agent-qa init이 통과 예시 테스트를 만듭니다. 테스트 페이지에 있으면 선택하고, 없으면 나중에 직접 만드세요.',
  'tour.runAction.title': '준비되면 실행 클릭',
  'tour.runAction.body':
    '준비되면 실행 버튼을 클릭하세요. 둘러보기는 실행 화면이나 실행 페이지에서 이어집니다.',
  'tour.liveRun.title': '실행을 실시간으로 보기',
  'tour.liveRun.body':
    '라이브 모드에서는 실행 중인 테스트를 볼 수 있습니다. 한쪽에는 단계가, 그 옆에는 브라우저가 표시됩니다.',
  'tour.runDetail.title': '실행 세부 정보 살펴보기',
  'tour.runDetail.body':
    '바로 이 순간이 핵심입니다. agent-qa가 무엇을 관찰하고 계획하고 실행하고 검증했는지 살펴보세요.',
  'tour.githubNudge.title': 'agent-qa가 도움이 되었다면',
  'tour.githubNudge.body': 'agent-qa가 도움이 되었다면 GitHub에서 별표를 눌러 주세요.',
  'tour.githubNudge.actionLabel': 'GitHub에서 보기',
  'tour.runsFallback.title': '최근 실행 열기',
  'tour.runsFallback.body':
    '아직 여기에 열린 실행이 없다면 실행 페이지에서 최근 실행을 열고 세부 정보 화면을 살펴보세요.',
  'tour.ui.progress': '둘러보기 진행률 {{current}}/{{total}}',
  'tour.ui.skip': '건너뛰기',
  'tour.ui.restart': '다시 시작',
  'tour.ui.back': '뒤로',
  'tour.ui.done': '완료',
  'tour.ui.startTour': '둘러보기 시작',
} satisfies Translation<typeof en>
