import { expectTypeOf, test } from 'vitest'
import type { Action } from '@vostride/agent-qa-schema'
import type { ScoringValueAction, ScoringValueActionType } from '../sidecar-leg'
import { SCORING_VALUE_ACTION_TYPES, projectActionGoldValue } from '../sidecar-leg'

test('the scoring value policy, its runtime set and the gold value projector have fixed types', () => {
  // The policy discriminants are exactly the five current target value operations.
  expectTypeOf<ScoringValueActionType>().toEqualTypeOf<
    'fill' | 'select' | 'paste' | 'nativeSelect' | 'pickerSelect'
  >()

  // paste is a first-class ref-targeted string-value policy member.
  expectTypeOf<Extract<ScoringValueAction, { type: 'paste' }>>().toEqualTypeOf<
    Extract<Action, { type: 'paste' }>
  >()
  expectTypeOf<Extract<Action, { type: 'paste' }>>().not.toEqualTypeOf<never>()

  // pickerSelect participates only through its value arm; the order arm is not a policy member.
  expectTypeOf<Extract<ScoringValueAction, { type: 'pickerSelect' }>>().toEqualTypeOf<
    Extract<Action, { type: 'pickerSelect'; value: string }>
  >()

  // The runtime set is constrained to the exact policy discriminants.
  expectTypeOf(SCORING_VALUE_ACTION_TYPES).toEqualTypeOf<ReadonlySet<ScoringValueActionType>>()

  // The projector accepts any recorded Action and yields an optional recorded string.
  expectTypeOf(projectActionGoldValue).toEqualTypeOf<(action: Action) => string | undefined>()
})

test('a value discriminant outside the policy is refused', () => {
  // Negative pin: an invented ref-targeted string-value discriminant is NOT a current policy
  // member, so the exact handler map cannot accept it without a new key.
  type InventedRefValueType = 'inventedRefValue'
  expectTypeOf<InventedRefValueType>().not.toEqualTypeOf<ScoringValueActionType>()

  // @ts-expect-error the mapped handler table has no key for a discriminant outside the policy.
  const _rejected: { [T in ScoringValueActionType | InventedRefValueType]: unknown } = {
    fill: 0,
    select: 0,
    paste: 0,
    nativeSelect: 0,
    pickerSelect: 0,
  }
  void _rejected
})
