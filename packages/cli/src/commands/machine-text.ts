import { stripVTControlCharacters } from 'node:util'

// Text this machine or a server chose, without the characters that would move a terminal's cursor
// or break its line.
export function machineText(text: string): string {
  return stripVTControlCharacters(text).replace(/[\u0000-\u001f\u007f]/gu, '')
}
