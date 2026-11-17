import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'evidence.loading': '기록을 불러오는 중',
  'evidence.incompleteExplanation':
    '증거가 불완전합니다. 기록은 되었지만 저장된 파일이 더 이상 디스크에 없습니다.',
  'evidence.recordedOnStep': '{{step}}단계에서 기록됨',
  'evidence.explanationWithStep': '{{explanation}} {{step}}',
  'evidence.goToStep': '{{step}}단계로 이동',

  'evidence.retry.variables': '변수 다시 불러오기',
  'evidence.retry.network': '네트워크 기록 다시 불러오기',
  'evidence.retry.console': '콘솔 기록 다시 불러오기',
  'evidence.retry.aria': 'ARIA 트리 다시 불러오기',
  'evidence.retry.a11y': '접근성 결과 다시 불러오기',
  'evidence.retry.video': '녹화 다시 불러오기',
  'evidence.retry.frame': '스크린샷 다시 불러오기',

  'evidence.variables.empty.title': '이 단계에 변수가 없습니다',
  'evidence.variables.empty.explanation': '이 단계가 실행될 때 설정된 변수가 없습니다.',
  'evidence.variables.notCaptured.title': '이 단계의 변수가 기록되지 않았습니다',
  'evidence.variables.notCaptured.explanation': '이 단계의 변수 스냅샷이 저장되지 않았습니다.',
  'evidence.variables.unsupported.title': '이 플랫폼에서는 변수를 기록하지 않습니다',
  'evidence.variables.unsupported.explanation':
    '이 실행의 플랫폼은 변수 스냅샷 저장을 지원하지 않습니다.',
  'evidence.variables.unavailable.title': '이 실행의 변수를 사용할 수 없음',
  'evidence.variables.unavailable.explanation':
    '이 실행 당시에는 변수를 기록하지 않았으므로 표시할 내용이 없습니다.',
  'evidence.variables.failed.capture.title': '변수 수집 실패',
  'evidence.variables.failed.capture.explanation':
    '실행 중에 변수 스냅샷을 저장하지 못했습니다. 다시 시도할 수 있는 항목이 없습니다.',
  'evidence.variables.failed.load.title': '변수를 불러오지 못했습니다',
  'evidence.variables.failed.load.explanation': '변수는 기록되었지만 불러오지 못했습니다.',
  'evidence.variables.noSelection.title': '선택한 단계 없음',
  'evidence.variables.noSelection.explanation':
    '변수는 단계별로 표시됩니다. 트리나 타임라인에서 단계를 선택하면 볼 수 있습니다.',

  'evidence.network.empty.title': '네트워크 요청 없음',
  'evidence.network.empty.explanation': '이 단계 동안 페이지가 보낸 요청이 없습니다.',
  'evidence.network.notCaptured.title': '이 단계의 네트워크가 기록되지 않았습니다',
  'evidence.network.notCaptured.explanation': '이 단계의 네트워크 활동이 저장되지 않았습니다.',
  'evidence.network.unsupported.title': '이 플랫폼에서는 네트워크를 기록하지 않습니다',
  'evidence.network.unsupported.explanation':
    '이 실행의 플랫폼은 네트워크 요청 수집을 지원하지 않습니다.',
  'evidence.network.unavailable.title': '이 실행의 네트워크를 사용할 수 없음',
  'evidence.network.unavailable.explanation':
    '이 실행 당시에는 네트워크 활동을 기록하지 않았습니다. 실행이 요청을 보내지 않았다는 뜻은 아닙니다.',
  'evidence.network.failed.capture.title': '네트워크 수집 실패',
  'evidence.network.failed.capture.explanation':
    '실행 중에 네트워크 활동을 수집하지 못했습니다. 다시 시도할 수 있는 항목이 없습니다.',
  'evidence.network.failed.load.title': '네트워크 기록을 불러오지 못했습니다',
  'evidence.network.failed.load.explanation': '기록은 있지만 불러오지 못했습니다.',
  'evidence.network.noSelection.title': '선택한 단계 없음',
  'evidence.network.noSelection.explanation':
    '네트워크 요청은 단계별로 표시됩니다. 트리나 타임라인에서 단계를 선택하면 볼 수 있습니다.',

  'evidence.console.empty.title': '콘솔 출력 없음',
  'evidence.console.empty.explanation': '이 단계 동안 페이지가 기록한 로그가 없습니다.',
  'evidence.console.notCaptured.title': '이 단계의 콘솔이 기록되지 않았습니다',
  'evidence.console.notCaptured.explanation': '이 단계의 콘솔 출력이 저장되지 않았습니다.',
  'evidence.console.unsupported.title': '이 플랫폼에서는 콘솔을 기록하지 않습니다',
  'evidence.console.unsupported.explanation':
    '이 실행의 플랫폼은 콘솔 출력 수집을 지원하지 않습니다.',
  'evidence.console.unavailable.title': '이 실행의 콘솔을 사용할 수 없음',
  'evidence.console.unavailable.explanation':
    '이 실행 당시에는 콘솔 출력을 기록하지 않았습니다. 페이지가 아무 로그도 남기지 않았다는 뜻은 아닙니다.',
  'evidence.console.failed.capture.title': '콘솔 수집 실패',
  'evidence.console.failed.capture.explanation':
    '실행 중에 콘솔 출력을 수집하지 못했습니다. 다시 시도할 수 있는 항목이 없습니다.',
  'evidence.console.failed.load.title': '콘솔 기록을 불러오지 못했습니다',
  'evidence.console.failed.load.explanation': '기록은 있지만 불러오지 못했습니다.',
  'evidence.console.noSelection.title': '선택한 단계 없음',
  'evidence.console.noSelection.explanation':
    '콘솔 출력은 단계별로 표시됩니다. 트리나 타임라인에서 단계를 선택하면 볼 수 있습니다.',

  'evidence.aria.empty.title': '접근성 트리가 비어 있음',
  'evidence.aria.empty.explanation':
    '이 동작이 결정될 때 화면에 노출된 접근 가능한 요소가 없었습니다.',
  'evidence.aria.notCaptured.title': '이 동작의 ARIA 트리가 기록되지 않았습니다',
  'evidence.aria.notCaptured.explanation': '이 하위 동작의 접근성 트리가 저장되지 않았습니다.',
  'evidence.aria.unsupported.title': '이 플랫폼에서는 ARIA 트리를 기록하지 않습니다',
  'evidence.aria.unsupported.explanation':
    '이 실행의 플랫폼은 접근성 트리 수집을 지원하지 않습니다.',
  'evidence.aria.unavailable.title': '이 실행의 ARIA 트리를 사용할 수 없음',
  'evidence.aria.unavailable.explanation': '이 실행 당시에는 접근성 트리를 기록하지 않았습니다.',
  'evidence.aria.failed.capture.title': 'ARIA 트리 수집 실패',
  'evidence.aria.failed.capture.explanation':
    '실행 중에 접근성 트리를 수집하지 못했습니다. 다시 시도할 수 있는 항목이 없습니다.',
  'evidence.aria.failed.load.title': 'ARIA 트리를 불러오지 못했습니다',
  'evidence.aria.failed.load.explanation': '트리는 기록되었지만 불러오지 못했습니다.',
  'evidence.aria.noSelection.title': '선택한 하위 동작 없음',
  'evidence.aria.noSelection.explanation':
    '접근성 트리는 하위 동작별로 표시됩니다. 트리나 타임라인에서 하위 동작을 선택하면 모델이 본 내용을 볼 수 있습니다.',

  'evidence.a11y.empty.title': '접근성 위반 사항 없음',
  'evidence.a11y.empty.explanation': '이 단계에서 검사를 실행했으며 고칠 사항이 없습니다.',
  'evidence.a11y.notCaptured.title': '이 단계의 접근성 검사가 기록되지 않았습니다',
  'evidence.a11y.notCaptured.explanation': '이 단계의 접근성 결과가 저장되지 않았습니다.',
  'evidence.a11y.unsupported.title': '이 플랫폼에서는 접근성 검사를 지원하지 않습니다',
  'evidence.a11y.unsupported.explanation': '이 실행의 플랫폼은 접근성 검사를 실행할 수 없습니다.',
  'evidence.a11y.unavailable.title': '이 실행의 접근성 결과를 사용할 수 없음',
  'evidence.a11y.unavailable.explanation':
    '이 실행 당시에는 접근성 검사를 기록하지 않았습니다. 실행에 위반 사항이 없었다는 뜻은 아닙니다.',
  'evidence.a11y.failed.capture.title': '접근성 검사를 실행하지 못했습니다',
  'evidence.a11y.failed.capture.explanation':
    '실행 중에 검사에서 오류가 발생해 결과가 없습니다. 다시 시도할 수 있는 항목이 없습니다.',
  'evidence.a11y.failed.load.title': '접근성 결과를 불러오지 못했습니다',
  'evidence.a11y.failed.load.explanation': '결과는 있지만 불러오지 못했습니다.',
  'evidence.a11y.noSelection.title': '선택한 단계 없음',
  'evidence.a11y.noSelection.explanation':
    '접근성 결과는 단계별로 표시됩니다. 트리나 타임라인에서 단계를 선택하면 볼 수 있습니다.',

  'evidence.video.empty.title': '녹화에 동영상이 없습니다',
  'evidence.video.empty.explanation':
    '이 테스트의 녹화가 저장되었지만 재생할 내용이 없습니다.',
  'evidence.video.notCaptured.title': '이 테스트의 녹화 없음',
  'evidence.video.notCaptured.explanation':
    '이 테스트의 동영상이 저장되지 않았습니다. 프레임 탭에서 각 결정 시점에 모델이 본 화면을 계속 볼 수 있습니다.',
  'evidence.video.unsupported.title': '이 플랫폼에서는 녹화를 지원하지 않습니다',
  'evidence.video.unsupported.explanation':
    '이 실행의 플랫폼은 동영상을 녹화하지 않습니다. 프레임 탭에서 각 결정 시점에 모델이 본 화면을 계속 볼 수 있습니다.',
  'evidence.video.unavailable.title': '이 실행의 녹화를 사용할 수 없음',
  'evidence.video.unavailable.explanation':
    '이 실행 당시에는 동영상을 녹화하지 않았습니다. 프레임 탭에서 각 결정 시점에 모델이 본 화면을 계속 볼 수 있습니다.',
  'evidence.video.failed.capture.title': '녹화 실패',
  'evidence.video.failed.capture.explanation':
    '이 테스트가 끝날 때 동영상을 저장하지 못했습니다. 다시 시도할 수 있는 항목이 없습니다. 프레임 탭에서 각 결정 시점에 모델이 본 화면을 계속 볼 수 있습니다.',
  'evidence.video.failed.load.title': '녹화를 불러오지 못했습니다',
  'evidence.video.failed.load.explanation':
    '녹화는 있지만 불러오지 못했습니다. 다시 시도하거나 프레임 탭으로 전환하세요.',
  'evidence.video.noSelection.title': '선택한 단계 없음',
  'evidence.video.noSelection.explanation':
    '녹화는 타임라인을 따라갑니다. 트리나 타임라인에서 단계를 선택하면 그 위치로 이동합니다.',

  'evidence.frame.notCaptured.subAction.title': '이 동작의 스크린샷 없음',
  'evidence.frame.notCaptured.subAction.explanation':
    '이 하위 동작의 스크린샷이 저장되지 않았습니다.',
  'evidence.frame.notCaptured.step.title': '이 단계의 스크린샷 없음',
  'evidence.frame.notCaptured.step.explanation':
    '이 단계의 하위 동작 중 스크린샷을 저장한 동작이 없습니다.',
  'evidence.frame.unavailable.title': '스크린샷을 사용할 수 없음',
  'evidence.frame.failed.load.title': '스크린샷을 불러오지 못했습니다',
  'evidence.frame.failed.load.explanation': '스크린샷은 있지만 불러오지 못했습니다.',

  'evidence.tab.variables': '변수',
  'evidence.tab.network': '네트워크',
  'evidence.tab.console': '콘솔',
  'evidence.tab.aria': 'ARIA 트리',
  'evidence.tab.a11y': '접근성',
  'evidence.trigger.variables': '변수, {{number}}개',
  'evidence.trigger.aria': 'ARIA 트리, {{number}}개',
  'evidence.trigger.consoleErrors_other': '콘솔, 오류 {{count}}개',
  'evidence.trigger.consoleMessages_other': '콘솔, 메시지 {{count}}개',
  'evidence.trigger.networkFailed_other': '네트워크, 실패한 요청 {{count}}개',
  'evidence.trigger.networkRequests_other': '네트워크, 요청 {{count}}개',
  'evidence.trigger.a11yViolations_other': '접근성, 위반 사항 {{count}}개',
  'evidence.trigger.absent': '{{tab}} — {{title}}',
  'evidence.signal.console_other': '{{step}}단계에 콘솔 오류 {{count}}개 — 콘솔 열기',
  'evidence.signal.network_other': '{{step}}단계에 실패한 요청 {{count}}개 — 네트워크 열기',
  'evidence.signal.a11y_other': '{{step}}단계에 접근성 위반 사항 {{count}}개 — 접근성 열기',

  'evidence.drawer.test': '테스트',
  'evidence.drawer.config': '설정',
  'evidence.drawer.testAsWritten': '작성된 테스트',
  'evidence.drawer.resolvedDefinition': '확정된 정의',
  'evidence.drawer.suiteMembers': '스위트 구성원',
  'evidence.drawer.runTests': '이 실행의 테스트',
  'evidence.drawer.runAttributes': '실행 속성',
  'evidence.drawer.effectiveConfig': '적용된 설정',
  'evidence.drawer.globalConfigAsWritten': '작성된 전역 설정',
  'evidence.drawer.model': '모델',
  'evidence.drawer.runtime': '런타임',
  'evidence.drawer.errors': '오류',
  'evidence.drawer.notCaptured': '수집되지 않음',
  'evidence.drawer.configNotCaptured': '설정이 수집되지 않음',
  'evidence.drawer.unsealedCapture':
    '이 실행의 설정 수집이 끝나지 않아 여기에 표시된 테스트와 설정이 불완전할 수 있습니다.',
  'evidence.drawer.technicalDetails': '기술 세부 정보',
  'evidence.drawer.runId': '실행 ID',
  'evidence.drawer.artifactKind': '산출물 종류',
  'evidence.drawer.schemaVersion': '스키마 버전',
  'evidence.drawer.captureSealedAt': '수집 확정 시각',
  'evidence.drawer.copyRunId': '실행 ID 복사',
  'evidence.drawer.retry': '실행 세부 정보 다시 불러오기',
  'evidence.drawer.ranHere': '이 컴퓨터에서 실행됨',
  'evidence.drawer.ranHereOn': '이 컴퓨터에서 실행됨, {{deviceType}}',
  'evidence.drawer.deviceType.simulator': '시뮬레이터',
  'evidence.drawer.deviceType.realDevice': '실제 기기',
  'evidence.drawer.opensInNewTab': '(새 탭에서 열림)',
  'evidence.drawer.remote': '{{name}}({{where}})',
  'evidence.drawer.ranOn': '실행 위치: {{remote}}',
  'evidence.drawer.ranOnVersion': '실행 위치: {{remote}}, {{version}}',
  'evidence.drawer.lostOn': '실행 위치: {{remote}}, 연결이 끊길 때까지',
  'evidence.drawer.lostOnVersion': '실행 위치: {{remote}}, {{version}}, 연결이 끊길 때까지',
  'evidence.drawer.endedOn': '실행 위치: {{remote}}, 원격 환경이 세션을 끝낼 때까지',
  'evidence.drawer.endedOnVersion':
    '실행 위치: {{remote}}, {{version}}, 원격 환경이 세션을 끝낼 때까지',
  'evidence.drawer.couldNotRun': '{{remote}}에서 실행하지 못했습니다: {{reason}}',
  'evidence.drawer.sessionRefused': '세션이 거부됨',
  'evidence.drawer.plugin': '플러그인 {{entry}}',
  'evidence.drawer.pluginSource': '플러그인 {{entry}}({{source}})',
  'evidence.drawer.sessionPage': '세션 페이지',
  'evidence.drawer.kind.test': '테스트',
  'evidence.drawer.kind.unknown': '기록되지 않음',
  'evidence.drawer.titleFallback': '실행 {{id}}',

  'evidence.scope.step': '{{total}}단계 중 {{step}}단계 · 전체 단계',
  'evidence.scope.subAction': '하위 동작 {{total}}개 중 #{{number}} · {{step}}단계',

  'evidence.artifact.loadingLabel': '산출물 데이터를 불러오는 중',
  'evidence.artifact.loading': '산출물 데이터를 불러오는 중…',
  'evidence.artifact.loadFailed': '산출물 데이터를 불러오지 못했습니다',
  'evidence.artifact.loadFailedHelp':
    '요청을 다시 시도하세요. 문제가 계속되면 대시보드 서버가 실행 산출물을 읽을 수 있는지 확인하세요.',
  'evidence.artifact.missing': '이 실행의 산출물 데이터가 없습니다',
  'evidence.artifact.missingHelp': '이 실행에는 저장된 산출물 기록이 없습니다.',
  'evidence.artifact.none': '없음',
  'evidence.artifact.items_other': '항목 {{count}}개',
  'evidence.artifact.fields_other': '필드 {{count}}개',
  'evidence.artifact.sectionNotCaptured': '이 실행에서는 {{section}} 항목이 수집되지 않았습니다.',
  'evidence.artifact.unnamedMember': '이름 없는 구성원',
  'evidence.artifact.testId': '테스트 ID',
  'evidence.artifact.ref': '참조',
  'evidence.artifact.refId': '참조 ID',
  'evidence.artifact.path': '경로',
  'evidence.artifact.target': '대상',
  'evidence.artifact.childRun': '하위 실행',
  'evidence.artifact.error': '오류',
  'evidence.artifact.ranAgainst': '실행 대상',
  'evidence.artifact.memberSnapshots': '구성원 스냅샷',
  'evidence.artifact.rawTestYaml': '원본 테스트 YAML',
  'evidence.artifact.rawMemberYaml': '원본 구성원 YAML',
  'evidence.artifact.rawSuiteYaml': '원본 스위트 YAML',
  'evidence.artifact.rawGlobalConfig': '원본 전역 설정',
  'evidence.artifact.noAttributes': '실행 속성 없음',
  'evidence.artifact.noAttributesHelp': '이 실행은 속성을 기록하지 않았습니다.',
  'evidence.artifact.copyJson': 'JSON 복사',
  'evidence.artifact.copyNamedValue': '{{key}} 값 복사',
  'evidence.artifact.copyValue': '값 복사',
} satisfies Translation<typeof en>
