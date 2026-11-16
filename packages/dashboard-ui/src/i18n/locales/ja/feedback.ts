import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'feedback.place.thisTest': 'このテスト',
  'feedback.place.test': '{{name}} {{handle}}',
  'feedback.place.step': 'ステップ{{number}}',
  'feedback.place.stepOfTest': '{{test}}のステップ{{number}}',
  'feedback.composer.pinnedTarget': '表示中：{{viewed}}。このフィードバックの対象：{{about}}。',
  'feedback.composer.switchTarget': '切り替え先：{{place}}',
  'feedback.composer.unsentDraft': '未送信の下書き：{{place}}',
  'feedback.composer.headingStep': 'ステップ{{number}}／{{total}}へのフィードバック・{{name}}',
  'feedback.composer.headingTest': 'フィードバック：{{name}}',
  'feedback.composer.headingSuiteTest': 'フィードバック：{{name}} {{handle}}',
  'feedback.choice.falseFail': 'これは成功すべきでした',
  'feedback.choice.falsePass': 'これは失敗すべきでした',
  'feedback.choice.confirmedBug': 'これは実際の製品バグです',
  'feedback.choiceMeaning.failed.falseFail':
    'アプリは正しく動作していました。テストが誤って失敗しました。',
  'feedback.choiceMeaning.failed.confirmedBug': 'この失敗は本物です。アプリはここで壊れています。',
  'feedback.choiceMeaning.failed.falsePass': 'テストは検出すべき問題を見逃しました。',
  'feedback.choiceMeaning.passed.falseFail': 'この成功は正しく、テストの正しさが確認されます。',
  'feedback.choiceMeaning.passed.confirmedBug':
    'テストは成功しましたが、アプリにはここで実際のバグがあります。',
  'feedback.choiceMeaning.passed.falsePass':
    'アプリはここで壊れていましたが、テストは成功してしまいました。',
  'feedback.scope.recorded.passed': '記録：成功',
  'feedback.scope.recorded.healed': '記録：修復済み（成功として集計）',
  'feedback.scope.recorded.failed': '記録：失敗',
  'feedback.scope.recorded.timeout': '記録：タイムアウト（失敗として集計）',
  'feedback.scope.recorded.cancelled': '記録：キャンセル済み（失敗として集計）',
  'feedback.scope.recorded.skipped': '記録：スキップ（失敗として集計）',
  'feedback.scope.noStepVerdict':
    'ステップの判定は記録されていません。テストの結果を使用します（{{recorded}}）',
  'feedback.scope.wholeTest': 'テスト全体・{{recorded}}',
  'feedback.scope.oneStep': '1つのステップ・{{recorded}}',
  'feedback.scope.oneStepInTest': '{{name}} {{handle}}の1つのステップ・{{recorded}}',
  'feedback.entry.step': 'ステップ{{number}}にフィードバック',
  'feedback.entry.member': '{{name}} {{handle}}にフィードバック',
  'feedback.entry.stepMarked': 'ステップ{{number}}にフィードバック（マーク済み：{{choice}}）',
  'feedback.entry.testMarked': 'このテストにフィードバック（マーク済み：{{choice}}）',
  'feedback.entry.memberMarked': '{{name}} {{handle}}にフィードバック（マーク済み：{{choice}}）',
  'feedback.entry.stepMarkedTooltip': 'ステップ{{number}}はマーク済みです。確認または変更できます',
  'feedback.entry.markGlyph': 'マーク済み：{{choice}}',
  'feedback.disposition.applied.fact': '記録済み（ナレッジの事実を追加）',
  'feedback.disposition.applied.caution': '記録済み（注意を追加）',
  'feedback.disposition.applied.procedureHint': '記録済み（手順のヒントを追加）',
  'feedback.disposition.applied.testEdit': '記録済み（テストファイルを編集）',
  'feedback.disposition.drafted': '記録済み（修正を下書き、以前のマーク）',
  'feedback.disposition.noDraftableFix': '記録済み（修正を下書きできず）',
  'feedback.disposition.confirmedBug': '記録済み（実際の製品バグとして保持、変更なし）',
  'feedback.disposition.notApplied.targetNotFound':
    '記録済み（修正は未適用、置き換え対象のナレッジが存在しない）',
  'feedback.disposition.notApplied.policyMaterializeRefused':
    '記録済み（修正は未適用、ポリシーの文面が拒否された）',
  'feedback.disposition.notApplied.outsideWorkspace':
    '記録済み（修正は未適用、テストファイルがワークスペースの外にある）',
  'feedback.disposition.quarantined': '記録済み（隔離、{{cause}}）',
  'feedback.recorded.applied.fact':
    'フィードバックを記録しました。ナレッジの事実を追加しました。',
  'feedback.recorded.applied.caution': 'フィードバックを記録しました。注意を追加しました。',
  'feedback.recorded.applied.procedureHint':
    'フィードバックを記録しました。手順のヒントを追加しました。',
  'feedback.recorded.applied.testEdit':
    'フィードバックを記録しました。テストファイルを編集しました。',
  'feedback.recorded.drafted':
    'フィードバックを記録しました。修正を下書きしました（以前のマーク）。',
  'feedback.recorded.noDraftableFix':
    'フィードバックを記録しました。修正を下書きできませんでした。',
  'feedback.recorded.confirmedBug':
    'フィードバックを記録しました。実際の製品バグとして保持し、何も変更していません。',
  'feedback.recorded.notApplied.targetNotFound':
    'フィードバックを記録しました。置き換え対象のナレッジが存在しないため、修正は適用されていません。',
  'feedback.recorded.notApplied.policyMaterializeRefused':
    'フィードバックを記録しました。ポリシーの文面が拒否されたため、修正は適用されていません。',
  'feedback.recorded.notApplied.outsideWorkspace':
    'フィードバックを記録しました。テストファイルがワークスペースの外にあるため、修正は適用されていません。',
  'feedback.recorded.quarantined': 'フィードバックを記録しました。隔離されています（{{cause}}）。',
  'feedback.preview.lineLabel.knowledge': 'ナレッジ',
  'feedback.preview.lineLabel.change': '変更',
  'feedback.preview.noRecordsReached': '対象となるナレッジのレコードはありません',
  'feedback.preview.confirmed_other': 'レコード{{count}}件を確認',
  'feedback.preview.countedAgainst_other': '{{count}}件を反証として集計',
  'feedback.preview.confirmedAndCountedAgainst': '{{confirmed}}・{{countedAgainst}}',
  'feedback.preview.unreadableRecords_other': '対象のレコード{{count}}件（読み取れません）',
  'feedback.preview.showRecords': 'レコードを表示（{{number}}）',
  'feedback.preview.effect.confirm': '確認',
  'feedback.preview.effect.overturn': '反証として集計',
  'feedback.preview.effect.overturnTimes': '反証として集計×{{times}}',
  'feedback.preview.effect.confirmAndOverturn': '{{confirm}}・{{overturn}}',
  'feedback.preview.contentAbsence.notFound': 'レコードの内容が見つかりません',
  'feedback.preview.contentAbsence.scanIncomplete': 'レコードの内容をすべて読み取れませんでした',
  'feedback.preview.contentAbsence.notBound': 'このホストではレコードの内容を利用できません',
  'feedback.preview.fix.fact': 'ナレッジの事実が追加されます',
  'feedback.preview.fix.caution': '注意が追加されます',
  'feedback.preview.fix.procedureHint': '手順のヒントが追加されます',
  'feedback.preview.fix.testEdit': 'テストファイルが編集されます',
  'feedback.preview.fix.noDraftableFix': 'この実行からは修正を作成できません',
  'feedback.preview.fix.confirmedBug':
    '何も変更されません。実際の製品バグには、テストやナレッジの変更ではなく製品の修正が必要です',
  'feedback.preview.replaces':
    '以前のマーク（#{{mark}}）を置き換えます。そのマークによる変更はそのまま残ります',
  'feedback.preview.replacesAt':
    '以前のマーク（#{{mark}}、{{time}}）を置き換えます。そのマークによる変更はそのまま残ります',
  'feedback.preview.resolvedStep.failingStep':
    'このマークの対象はステップ{{number}}／{{total}}です。最初に失敗したステップです。',
  'feedback.preview.resolvedStep.lastStepFinished':
    'このマークの対象はステップ{{number}}／{{total}}です。テストが終了した最後のステップです。',
  'feedback.preview.resolvedStep.lastStepNoFailure':
    'このマークの対象はステップ{{number}}／{{total}}です。失敗したステップがないため、最後のステップです。',
  'feedback.preview.showStep': 'ステップ{{number}}を表示',
  'feedback.preview.quarantined.timeout':
    'このテストはタイムアウトで失敗したため、マークは記録されますが隔離されます。ナレッジとテストは変更されません。',
  'feedback.preview.quarantined.flake':
    'このテストは不安定な実行で失敗したため、マークは記録されますが隔離されます。ナレッジとテストは変更されません。',
  'feedback.preview.quarantined.environment':
    'このテストは環境の問題で失敗したため、マークは記録されますが隔離されます。ナレッジとテストは変更されません。',
  'feedback.preview.alreadyMarked':
    'これはすでに伝えられています。新しいメモだけでは記録されません。',
  'feedback.preview.alreadyMarkedAt':
    'これはすでに伝えられています（{{time}}）。新しいメモだけでは記録されません。',
  'feedback.preview.refusal.runNotFound':
    'この実行は実行ストアにもうないため、フィードバックを記録できません。',
  'feedback.preview.refusal.memberNotFound':
    'このテストが実行内に見つからないため、フィードバックを記録できません。',
  'feedback.preview.refusal.noSteps':
    'このテストにはステップが記録されていないため、マークできるものはありません。',
  'feedback.preview.refusal.stepNotFound_other':
    'このテストに記録されたステップは{{count}}件のため、マークできるステップ{{number}}はありません。',
  'feedback.preview.refusal.ambiguousAddress_other':
    'この実行の{{count}}件のテストが同じアドレスを共有しているため、マークを付けられません。',
  'feedback.preview.readFailed': 'この操作の結果を確認できませんでした（{{reason}}）。',
  'feedback.readFailure.network': 'ダッシュボードサーバーが応答しませんでした',
  'feedback.readFailure.ledgerCorrupt': 'この実行のフィードバック台帳が破損しています',
  'feedback.readFailure.ledgerUnavailable': 'この実行のフィードバック台帳を現在読み取れません',
  'feedback.readFailure.refused': 'サーバーがリクエストを拒否しました',
  'feedback.readFailure.shape': 'サーバーの応答が想定された形式と一致しませんでした',
  'feedback.details.row.kind': 'マークの種類',
  'feedback.details.row.address': 'アドレス',
  'feedback.details.row.testId': 'テストID',
  'feedback.details.row.records': '対象のレコード',
  'feedback.details.row.basis': '根拠',
  'feedback.details.basis': '台帳の序数{{ledger}}',
  'feedback.details.basisWithPrior': '台帳の序数{{ledger}}・以前のマーク#{{prior}}',
  'feedback.history.title.step': 'このステップへのフィードバック',
  'feedback.history.title.test': 'このテストへのフィードバック',
  'feedback.history.titleCount.step': 'このステップへのフィードバック（{{number}}）',
  'feedback.history.titleCount.test': 'このテストへのフィードバック（{{number}}）',
  'feedback.history.runLabel': 'この実行へのすべてのフィードバック（{{number}}）',
  'feedback.history.replacedBy': '後のマークで置き換え済み',
  'feedback.history.replacedByAt': '{{time}}の後のマークで置き換え済み',
  'feedback.history.recordUnavailable': '{{recordId}}（内容を利用できません）',
  'feedback.history.quoted': '「{{content}}」',
  'feedback.history.appliedKnowledge': '変更したナレッジ：{{records}}',
  'feedback.history.appliedTestFile': 'テストファイル{{file}}を編集しました',
  'feedback.history.change.records': '{{disposition}}：{{records}}',
  'feedback.history.change.file': '{{disposition}}：{{file}}',
  'feedback.history.change.draftedNotRecorded': '{{disposition}}。変更内容は記録されていません。',
  'feedback.history.change.contentNotRecorded': '{{disposition}}。その内容は記録されていません。',
  'feedback.history.empty.step': 'このステップへのフィードバックはまだありません。',
  'feedback.history.empty.test': 'このテストへのフィードバックはまだありません。',
  'feedback.history.empty.run': 'この実行へのフィードバックはまだありません。',
  'feedback.history.state.runNotFound': 'この実行のフィードバック履歴が見つかりません。',
  'feedback.history.state.ledgerCorrupt':
    'この実行のフィードバック履歴は{{line}}行目で破損しているため、表示できません。',
  'feedback.history.state.ledgerUnavailable': 'この実行のフィードバック履歴を現在読み取れません。',
  'feedback.history.readFailed':
    'この実行のフィードバック履歴を読み込めませんでした（{{reason}}）。',
  'feedback.history.targetStep': 'ステップ{{number}}／{{total}}・{{name}}',
  'feedback.history.targetTest': '{{name}} {{handle}}・テスト全体',
  'feedback.composer.noteLabel': 'メモ（任意）',
  'feedback.composer.choiceLegend': 'どれが正しいですか？',
  'feedback.composer.testSwitcherLabel': 'テスト',
  'feedback.composer.noUniqueAddress':
    'このテストにはこの実行内で一意のアドレスがないため、フィードバックを記録できません。',
  'feedback.composer.submitReason.noUniqueAddress':
    'このテストはダッシュボードからマークできません。',
  'feedback.composer.submitReason.noChoice': '3つの選択肢から1つを選んでください。',
  'feedback.composer.submitReason.checking': 'この操作の結果を確認中…',
  'feedback.composer.submitReason.previewFailed':
    '結果を確認できませんでした。上で再試行してください。',
  'feedback.composer.submitReason.refused': 'このマークは記録できません。上の説明を確認してください。',
  'feedback.composer.submitReason.alreadyMarked':
    'これはすでに伝えられています。新たに記録するものはありません。',
  'feedback.composer.submitReason.sending': '送信中…',
  'feedback.composer.send': 'フィードバックを送信',
  'feedback.preview.title': 'この操作の結果',
  'feedback.composer.sendingStatus': 'フィードバックを送信中…',
  'feedback.entry.test': 'このテストにフィードバック',
  'feedback.composer.close': 'フィードバックを閉じる',
  'feedback.composer.closeTooltip': '閉じる（Esc）',
  'feedback.composer.draftKeptStatus':
    '下書きを保持しました。もう一度送信する前に、上のメッセージを確認してください。',
  'feedback.entry.tooltip': 'フィードバック',
  'feedback.entry.markedTooltip': 'マーク済みです。確認または変更できます',
  'feedback.preview.updating': '更新中…',
  'feedback.preview.idle': '上の選択肢を選ぶと、この操作の結果が表示されます。',
  'feedback.preview.unreadableRecord':
    'このレコードは読み取れません。位置はそのまま残り、何も適用されません。',
  'feedback.preview.draftWordingNotShown':
    '正確な文面はここには表示されません。送信時に作成されます。',
  'feedback.retry': '再試行',
  'feedback.details.label': '技術的な詳細',
  'feedback.history.active': '有効',
  'feedback.history.replacementExplanation':
    'テストまたはステップごとに、最新のマークだけが有効です。',
  'feedback.history.appliedUnavailable': 'このマークによる変更は記録されていません。',
  'feedback.preview.cliEscape':
    'CLI（{{name}}）またはMCP経由で、引き続きフィードバックを記録できます。',
  'feedback.preview.retryName': 'この操作の結果を再確認',
  'feedback.history.retryName': 'フィードバック履歴を再読み込み',
  'feedback.history.appliedCorrection':
    'もう一度マークしても修正は残ります。ナレッジは新しいフィードバックで訂正するか忘れさせることで修正し、テストの編集はgitで元に戻してください。',
} satisfies Translation<typeof en>
