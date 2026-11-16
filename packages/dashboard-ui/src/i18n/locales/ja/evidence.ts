import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'evidence.loading': '記録を読み込み中',
  'evidence.incompleteExplanation':
    'エビデンスが不完全です。記録はされましたが、保存されたファイルはもうディスクにありません。',
  'evidence.recordedOnStep': 'ステップ{{step}}で記録されています。',
  'evidence.explanationWithStep': '{{explanation}}{{step}}',
  'evidence.goToStep': 'ステップ{{step}}に移動',

  'evidence.retry.variables': '変数を再読み込み',
  'evidence.retry.network': 'ネットワークの記録を再読み込み',
  'evidence.retry.console': 'コンソールの記録を再読み込み',
  'evidence.retry.aria': 'ARIAツリーを再読み込み',
  'evidence.retry.a11y': 'アクセシビリティの結果を再読み込み',
  'evidence.retry.video': '録画を再読み込み',
  'evidence.retry.frame': 'スクリーンショットを再読み込み',

  'evidence.variables.empty.title': 'このステップには変数がありません',
  'evidence.variables.empty.explanation': 'このステップの実行時に設定された変数はありません。',
  'evidence.variables.notCaptured.title': 'このステップの変数は記録されていません',
  'evidence.variables.notCaptured.explanation':
    'このステップでは変数のスナップショットが保存されていません。',
  'evidence.variables.unsupported.title': 'このプラットフォームでは変数は記録されません',
  'evidence.variables.unsupported.explanation':
    'この実行のプラットフォームは変数のスナップショットの保存に対応していません。',
  'evidence.variables.unavailable.title': 'この実行の変数は利用できません',
  'evidence.variables.unavailable.explanation':
    'この実行の時点では変数が記録されていなかったため、表示できるものはありません。',
  'evidence.variables.failed.capture.title': '変数の記録に失敗しました',
  'evidence.variables.failed.capture.explanation':
    '実行中に変数のスナップショットを保存できませんでした。再試行できるものはありません。',
  'evidence.variables.failed.load.title': '変数を読み込めませんでした',
  'evidence.variables.failed.load.explanation': '変数は記録されていますが、読み込めませんでした。',
  'evidence.variables.noSelection.title': 'ステップが選択されていません',
  'evidence.variables.noSelection.explanation':
    '変数はステップごとに表示されます。ツリーまたはタイムラインでステップを選択すると表示されます。',

  'evidence.network.empty.title': 'ネットワークリクエストはありません',
  'evidence.network.empty.explanation': 'このステップの間、ページはリクエストを送信しませんでした。',
  'evidence.network.notCaptured.title': 'このステップのネットワークは記録されていません',
  'evidence.network.notCaptured.explanation':
    'このステップではネットワークのアクティビティが保存されていません。',
  'evidence.network.unsupported.title': 'このプラットフォームではネットワークは記録されません',
  'evidence.network.unsupported.explanation':
    'この実行のプラットフォームはネットワークリクエストの記録に対応していません。',
  'evidence.network.unavailable.title': 'この実行のネットワークは利用できません',
  'evidence.network.unavailable.explanation':
    'この実行の時点ではネットワークのアクティビティが記録されていませんでした。実行がリクエストを送信しなかったという意味ではありません。',
  'evidence.network.failed.capture.title': 'ネットワークの記録に失敗しました',
  'evidence.network.failed.capture.explanation':
    '実行中にネットワークのアクティビティを記録できませんでした。再試行できるものはありません。',
  'evidence.network.failed.load.title': 'ネットワークの記録を読み込めませんでした',
  'evidence.network.failed.load.explanation': '記録はありますが、読み込めませんでした。',
  'evidence.network.noSelection.title': 'ステップが選択されていません',
  'evidence.network.noSelection.explanation':
    'ネットワークリクエストはステップごとに表示されます。ツリーまたはタイムラインでステップを選択すると表示されます。',

  'evidence.console.empty.title': 'コンソール出力はありません',
  'evidence.console.empty.explanation': 'このステップの間、ページは何もログに出力しませんでした。',
  'evidence.console.notCaptured.title': 'このステップのコンソールは記録されていません',
  'evidence.console.notCaptured.explanation': 'このステップではコンソール出力が保存されていません。',
  'evidence.console.unsupported.title': 'このプラットフォームではコンソールは記録されません',
  'evidence.console.unsupported.explanation':
    'この実行のプラットフォームはコンソール出力の記録に対応していません。',
  'evidence.console.unavailable.title': 'この実行のコンソールは利用できません',
  'evidence.console.unavailable.explanation':
    'この実行の時点ではコンソール出力が記録されていませんでした。ページが何もログに出力しなかったという意味ではありません。',
  'evidence.console.failed.capture.title': 'コンソールの記録に失敗しました',
  'evidence.console.failed.capture.explanation':
    '実行中にコンソール出力を記録できませんでした。再試行できるものはありません。',
  'evidence.console.failed.load.title': 'コンソールの記録を読み込めませんでした',
  'evidence.console.failed.load.explanation': '記録はありますが、読み込めませんでした。',
  'evidence.console.noSelection.title': 'ステップが選択されていません',
  'evidence.console.noSelection.explanation':
    'コンソール出力はステップごとに表示されます。ツリーまたはタイムラインでステップを選択すると表示されます。',

  'evidence.aria.empty.title': 'アクセシビリティツリーは空です',
  'evidence.aria.empty.explanation':
    'このアクションが決定された時点で、画面にアクセシブルな要素はありませんでした。',
  'evidence.aria.notCaptured.title': 'このアクションのARIAツリーは記録されていません',
  'evidence.aria.notCaptured.explanation':
    'このサブアクションではアクセシビリティツリーが保存されていません。',
  'evidence.aria.unsupported.title': 'このプラットフォームではARIAツリーは記録されません',
  'evidence.aria.unsupported.explanation':
    'この実行のプラットフォームはアクセシビリティツリーの記録に対応していません。',
  'evidence.aria.unavailable.title': 'この実行のARIAツリーは利用できません',
  'evidence.aria.unavailable.explanation':
    'この実行の時点ではアクセシビリティツリーが記録されていませんでした。',
  'evidence.aria.failed.capture.title': 'ARIAツリーの記録に失敗しました',
  'evidence.aria.failed.capture.explanation':
    '実行中にアクセシビリティツリーを記録できませんでした。再試行できるものはありません。',
  'evidence.aria.failed.load.title': 'ARIAツリーを読み込めませんでした',
  'evidence.aria.failed.load.explanation': 'ツリーは記録されていますが、読み込めませんでした。',
  'evidence.aria.noSelection.title': 'サブアクションが選択されていません',
  'evidence.aria.noSelection.explanation':
    'アクセシビリティツリーはサブアクションごとに表示されます。ツリーまたはタイムラインでサブアクションを選択すると、モデルが見ていたものが表示されます。',

  'evidence.a11y.empty.title': 'アクセシビリティ違反は見つかりませんでした',
  'evidence.a11y.empty.explanation':
    'このステップでチェックを実行し、修正が必要な問題は見つかりませんでした。',
  'evidence.a11y.notCaptured.title': 'このステップのアクセシビリティチェックは記録されていません',
  'evidence.a11y.notCaptured.explanation':
    'このステップではアクセシビリティの結果が保存されていません。',
  'evidence.a11y.unsupported.title':
    'このプラットフォームはアクセシビリティチェックに対応していません',
  'evidence.a11y.unsupported.explanation':
    'この実行のプラットフォームではアクセシビリティチェックを実行できません。',
  'evidence.a11y.unavailable.title': 'この実行のアクセシビリティの結果は利用できません',
  'evidence.a11y.unavailable.explanation':
    'この実行の時点ではアクセシビリティチェックが記録されていませんでした。実行に違反がなかったという意味ではありません。',
  'evidence.a11y.failed.capture.title': 'アクセシビリティチェックを実行できませんでした',
  'evidence.a11y.failed.capture.explanation':
    '実行中にチェックでエラーが発生したため、結果はありません。再試行できるものはありません。',
  'evidence.a11y.failed.load.title': 'アクセシビリティの結果を読み込めませんでした',
  'evidence.a11y.failed.load.explanation': '結果はありますが、読み込めませんでした。',
  'evidence.a11y.noSelection.title': 'ステップが選択されていません',
  'evidence.a11y.noSelection.explanation':
    'アクセシビリティの結果はステップごとに表示されます。ツリーまたはタイムラインでステップを選択すると表示されます。',

  'evidence.video.empty.title': '録画に動画がありません',
  'evidence.video.empty.explanation':
    'このテストの録画は保存されていますが、再生できる内容がありません。',
  'evidence.video.notCaptured.title': 'このテストの録画はありません',
  'evidence.video.notCaptured.explanation':
    'このテストでは動画が保存されていません。「フレーム」タブには、各判断の時点でモデルが見ていたものが引き続き表示されます。',
  'evidence.video.unsupported.title': 'このプラットフォームは録画に対応していません',
  'evidence.video.unsupported.explanation':
    'この実行のプラットフォームは動画を録画しません。「フレーム」タブには、各判断の時点でモデルが見ていたものが引き続き表示されます。',
  'evidence.video.unavailable.title': 'この実行の録画は利用できません',
  'evidence.video.unavailable.explanation':
    'この実行の時点では動画が録画されていませんでした。「フレーム」タブには、各判断の時点でモデルが見ていたものが引き続き表示されます。',
  'evidence.video.failed.capture.title': '録画に失敗しました',
  'evidence.video.failed.capture.explanation':
    'このテストの終了時に動画を保存できませんでした。再試行できるものはありません。「フレーム」タブには、各判断の時点でモデルが見ていたものが引き続き表示されます。',
  'evidence.video.failed.load.title': '録画を読み込めませんでした',
  'evidence.video.failed.load.explanation':
    '録画はありますが、読み込めませんでした。再試行するか、「フレーム」タブに切り替えてください。',
  'evidence.video.noSelection.title': 'ステップが選択されていません',
  'evidence.video.noSelection.explanation':
    '録画はタイムラインに沿って再生されます。ツリーまたはタイムラインでステップを選択すると、その位置に移動します。',

  'evidence.frame.notCaptured.subAction.title': 'このアクションのスクリーンショットはありません',
  'evidence.frame.notCaptured.subAction.explanation':
    'このサブアクションではスクリーンショットが保存されていません。',
  'evidence.frame.notCaptured.step.title': 'このステップのスクリーンショットはありません',
  'evidence.frame.notCaptured.step.explanation':
    'このステップのどのサブアクションもスクリーンショットを保存していません。',
  'evidence.frame.unavailable.title': 'スクリーンショットは利用できません',
  'evidence.frame.failed.load.title': 'スクリーンショットを読み込めませんでした',
  'evidence.frame.failed.load.explanation': 'スクリーンショットはありますが、読み込めませんでした。',

  'evidence.tab.variables': '変数',
  'evidence.tab.network': 'ネットワーク',
  'evidence.tab.console': 'コンソール',
  'evidence.tab.aria': 'ARIAツリー',
  'evidence.tab.a11y': 'アクセシビリティ',
  'evidence.trigger.variables': '変数（{{count}}件）',
  'evidence.trigger.aria': 'ARIAツリー（{{count}}件）',
  'evidence.trigger.consoleErrors_other': 'コンソール（エラー{{count}}件）',
  'evidence.trigger.consoleMessages_other': 'コンソール（メッセージ{{count}}件）',
  'evidence.trigger.networkFailed_other': 'ネットワーク（失敗したリクエスト{{count}}件）',
  'evidence.trigger.networkRequests_other': 'ネットワーク（リクエスト{{count}}件）',
  'evidence.trigger.a11yViolations_other': 'アクセシビリティ（違反{{count}}件）',
  'evidence.trigger.absent': '{{tab}}：{{title}}',
  'evidence.signal.console_other':
    'ステップ{{step}}のコンソールエラー{{count}}件：「コンソール」を開く',
  'evidence.signal.network_other':
    'ステップ{{step}}の失敗したリクエスト{{count}}件：「ネットワーク」を開く',
  'evidence.signal.a11y_other':
    'ステップ{{step}}のアクセシビリティ違反{{count}}件：「アクセシビリティ」を開く',

  'evidence.drawer.test': 'テスト',
  'evidence.drawer.config': '設定',
  'evidence.drawer.testAsWritten': '記述どおりのテスト',
  'evidence.drawer.resolvedDefinition': '解決済みの定義',
  'evidence.drawer.suiteMembers': 'スイートのメンバー',
  'evidence.drawer.runTests': 'この実行のテスト',
  'evidence.drawer.runAttributes': '実行の属性',
  'evidence.drawer.effectiveConfig': '有効な設定',
  'evidence.drawer.globalConfigAsWritten': '記述どおりのグローバル設定',
  'evidence.drawer.model': 'モデル',
  'evidence.drawer.runtime': 'ランタイム',
  'evidence.drawer.errors': 'エラー',
  'evidence.drawer.notCaptured': '記録なし',
  'evidence.drawer.configNotCaptured': '設定は記録されていません',
  'evidence.drawer.unsealedCapture':
    'この実行のセットアップの記録が完了していないため、ここに表示されているテストと設定は不完全な可能性があります。',
  'evidence.drawer.technicalDetails': '技術的な詳細',
  'evidence.drawer.runId': '実行ID',
  'evidence.drawer.artifactKind': '成果物の種類',
  'evidence.drawer.schemaVersion': 'スキーマのバージョン',
  'evidence.drawer.captureSealedAt': '記録の確定日時',
  'evidence.drawer.copyRunId': '実行IDをコピー',
  'evidence.drawer.retry': '実行の詳細を再読み込み',
  'evidence.drawer.ranHere': 'このマシンで実行しました',
  'evidence.drawer.ranHereOn': 'このマシンの{{deviceType}}で実行しました',
  'evidence.drawer.deviceType.simulator': 'シミュレーター',
  'evidence.drawer.deviceType.realDevice': '実機',
  'evidence.drawer.opensInNewTab': '（新しいタブで開きます）',
  'evidence.drawer.remote': '{{name}}（{{where}}）',
  'evidence.drawer.ranOn': '{{remote}}で実行しました',
  'evidence.drawer.ranOnVersion': '{{remote}}で実行しました（{{version}}）',
  'evidence.drawer.lostOn': '{{remote}}で実行しました（接続が切断されるまで）',
  'evidence.drawer.lostOnVersion': '{{remote}}で実行しました（{{version}}、接続が切断されるまで）',
  'evidence.drawer.endedOn': '{{remote}}で実行しました（リモートがセッションを終了するまで）',
  'evidence.drawer.endedOnVersion':
    '{{remote}}で実行しました（{{version}}、リモートがセッションを終了するまで）',
  'evidence.drawer.couldNotRun': '{{remote}}で実行できませんでした：{{reason}}',
  'evidence.drawer.sessionRefused': 'セッションが拒否されました',
  'evidence.drawer.plugin': 'プラグイン{{entry}}',
  'evidence.drawer.pluginSource': 'プラグイン{{entry}}（{{source}}）',
  'evidence.drawer.sessionPage': 'セッションページ',
  'evidence.drawer.kind.test': 'テスト',
  'evidence.drawer.kind.unknown': '記録なし',
  'evidence.drawer.titleFallback': '実行{{id}}',

  'evidence.scope.step': 'ステップ{{step}}／{{total}}・ステップ全体',
  'evidence.scope.subAction': 'サブアクション#{{number}}／{{total}}・ステップ{{step}}',

  'evidence.artifact.loadingLabel': '成果物のデータを読み込み中',
  'evidence.artifact.loading': '成果物のデータを読み込み中…',
  'evidence.artifact.loadFailed': '成果物のデータを読み込めませんでした',
  'evidence.artifact.loadFailedHelp':
    'もう一度リクエストしてください。問題が続く場合は、ダッシュボードサーバーが実行の成果物を読み取れることを確認してください。',
  'evidence.artifact.missing': 'この実行の成果物のデータはありません',
  'evidence.artifact.missingHelp': 'この実行には保存された成果物の記録がありません。',
  'evidence.artifact.none': 'なし',
  'evidence.artifact.items_other': '{{count}}項目',
  'evidence.artifact.fields_other': '{{count}}フィールド',
  'evidence.artifact.sectionNotCaptured': 'この実行では{{section}}は記録されていません。',
  'evidence.artifact.unnamedMember': '名前のないメンバー',
  'evidence.artifact.testId': 'テストID',
  'evidence.artifact.ref': '参照',
  'evidence.artifact.refId': '参照ID',
  'evidence.artifact.path': 'パス',
  'evidence.artifact.target': 'ターゲット',
  'evidence.artifact.childRun': '子の実行',
  'evidence.artifact.error': 'エラー',
  'evidence.artifact.ranAgainst': '実行対象',
  'evidence.artifact.memberSnapshots': 'メンバーのスナップショット',
  'evidence.artifact.rawTestYaml': '未加工のテストYAML',
  'evidence.artifact.rawMemberYaml': '未加工のメンバーYAML',
  'evidence.artifact.rawSuiteYaml': '未加工のスイートYAML',
  'evidence.artifact.rawGlobalConfig': '未加工のグローバル設定',
  'evidence.artifact.noAttributes': '実行の属性はありません',
  'evidence.artifact.noAttributesHelp': 'この実行には属性が記録されていません。',
  'evidence.artifact.copyJson': 'JSONをコピー',
  'evidence.artifact.copyNamedValue': '{{key}}の値をコピー',
  'evidence.artifact.copyValue': '値をコピー',
} satisfies Translation<typeof en>
