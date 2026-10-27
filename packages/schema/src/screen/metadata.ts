export interface ScreenStateMetadataBase {
  coordSpace: 'viewport' | 'content' | 'screen'
  viewportWidth: number
  viewportHeight: number
  scroll: {
    offsetX: number
    offsetY: number
    contentWidth: number
    contentHeight: number
  }
}

export type ScreenStateMetadata =
  | (ScreenStateMetadataBase & { captureMode: 'full'; imageWidth: number; imageHeight: number })
  | (ScreenStateMetadataBase & { captureMode: 'textOnly' })
