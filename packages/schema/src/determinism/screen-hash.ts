import type { BoundingBox } from '../primitives/bounding-box'
import { asRef } from '../primitives/ref'
import type { Ref } from '../primitives/ref'
import type { ElementBounds } from '../screen/element-bounds'
import type { ElementInfo } from '../screen/element-info'
import type { ScreenState } from '../screen/screen-state'
import { sha256hex } from './sha256'

type ScreenRegion = 'above' | 'visible' | 'below'

const FIELD = '\x1f'
const RECORD = '\x01'

function text(value: string): string {
  return `${value.length}:${value}`
}

function numberValue(value: number): string {
  return String(value)
}

function booleanValue(value: boolean): string {
  return value ? '1' : '0'
}

function optionalString(value: string | undefined): string {
  return value === undefined ? '0' : `1${FIELD}${text(value)}`
}

function optionalBoolean(value: boolean | undefined): string {
  return value === undefined ? '0' : `1${FIELD}${booleanValue(value)}`
}

function record(tag: string, fields: string[]): string {
  return [tag, ...fields].join(FIELD)
}

function arrayValue(values: string[]): string {
  return [numberValue(values.length), ...values].join(FIELD)
}

function regionOf(bounds: BoundingBox, scrollOffsetY: number, viewportHeight: number): ScreenRegion {
  const windowTop = scrollOffsetY
  const windowBottom = scrollOffsetY + viewportHeight
  const elementTop = bounds.y
  const elementBottom = bounds.y + bounds.height

  if (elementBottom <= windowTop) {
    return 'above'
  }

  if (elementTop >= windowBottom) {
    return 'below'
  }

  return 'visible'
}

function serializeBounds(bounds: BoundingBox): string {
  return record('bounds', [
    numberValue(bounds.x),
    numberValue(bounds.y),
    numberValue(bounds.width),
    numberValue(bounds.height),
  ])
}

function serializePoint(point: { x: number; y: number }): string {
  return record('point', [
    numberValue(point.x),
    numberValue(point.y),
  ])
}

function optionalBounds(bounds: BoundingBox | undefined): string {
  return bounds === undefined ? '0' : `1${FIELD}${serializeBounds(bounds)}`
}

function optionalPoint(point: { x: number; y: number } | undefined): string {
  return point === undefined ? '0' : `1${FIELD}${serializePoint(point)}`
}

function optionalRef(ref: Ref | undefined): string {
  return ref === undefined ? '0' : `1${FIELD}${text(ref)}`
}

function optionalRefArray(refs: Ref[] | undefined): string {
  return refs === undefined ? '0' : `1${FIELD}${arrayValue(refs.map(ref => text(ref)))}`
}

function serializeStringMap(values: Record<string, string>): string {
  return arrayValue(
    Object.keys(values).sort().map(key => record('entry', [
      text(key),
      text(values[key]),
    ])),
  )
}

function serializeElement(element: ElementInfo): string {
  return record('element', [
    text(element.ref),
    text(element.role),
    text(element.name),
    text(element.nameNormalized),
    optionalString(element.value),
    optionalBounds(element.bounds),
    optionalPoint(element.center),
    record('state', [
      booleanValue(element.state.enabled),
      booleanValue(element.state.focused),
      booleanValue(element.state.visible),
      optionalBoolean(element.state.selected),
      optionalBoolean(element.state.checked),
      optionalBoolean(element.state.editable),
      optionalBoolean(element.state.clickable),
    ]),
    record('labels', [
      optionalString(element.labels.testId),
      optionalString(element.labels.ariaLabel),
      optionalString(element.labels.placeholder),
      optionalString(element.labels.title),
    ]),
    element.hierarchy === undefined
      ? '0'
      : `1${FIELD}${record('hierarchy', [
        optionalRef(element.hierarchy.parentRef),
        optionalRefArray(element.hierarchy.childRefs),
      ])}`,
    serializeStringMap(element.attributes),
  ])
}

function serializeElementBounds(bounds: ElementBounds): string {
  return record('elementBounds', [
    serializeBounds(bounds.bounds),
    serializePoint(bounds.center),
    bounds.scrollContext === undefined
      ? '0'
      : `1${FIELD}${record('scrollContext', [
        optionalRef(bounds.scrollContext.container),
        numberValue(bounds.scrollContext.offsetX),
        numberValue(bounds.scrollContext.offsetY),
      ])}`,
  ])
}

function serializeRefMap(refMap: ScreenState['refMap']): string {
  return arrayValue(
    Object.keys(refMap).sort().map(key => {
      const ref = asRef(key)
      return record('refMapEntry', [
        text(key),
        serializeElementBounds(refMap[ref]),
      ])
    }),
  )
}

function serializeMetadata(metadata: ScreenState['metadata']): string {
  const base = [
    metadata.captureMode,
    metadata.coordSpace,
    numberValue(metadata.viewportWidth),
    numberValue(metadata.viewportHeight),
    record('scroll', [
      numberValue(metadata.scroll.offsetX),
      numberValue(metadata.scroll.offsetY),
      numberValue(metadata.scroll.contentWidth),
      numberValue(metadata.scroll.contentHeight),
    ]),
    // Fixed slot of a removed field; keeps recorded screenStateHash values stable.
    '0',
  ]

  if (metadata.captureMode === 'full') {
    return record('metadata', [
      ...base,
      numberValue(metadata.imageWidth),
      numberValue(metadata.imageHeight),
    ])
  }

  return record('metadata', base)
}

function canonicalScreenState(state: ScreenState): string {
  return [
    'screen-state:v1',
    text(state.platform),
    text(state.tree),
    arrayValue(state.elements.map(serializeElement)),
    serializeRefMap(state.refMap),
    optionalString(state.url),
    numberValue(state.timestamp),
    serializeMetadata(state.metadata),
  ].join(RECORD)
}

export function screenIdentityHash(state: ScreenState): string {
  const scrollOffsetY = state.metadata.scroll.offsetY
  const viewportHeight = state.metadata.viewportHeight
  const elements = state.elements.map(element => record('identityElement', [
    text(element.role),
    text(element.nameNormalized),
    element.bounds === undefined ? 'visible' : regionOf(element.bounds, scrollOffsetY, viewportHeight),
  ]))

  return sha256hex(['screen-identity:v1', ...elements].join(RECORD))
}

export function screenStateHash(state: ScreenState): string {
  return sha256hex(canonicalScreenState(state))
}
