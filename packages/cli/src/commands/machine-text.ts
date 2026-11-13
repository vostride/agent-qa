import { stripVTControlCharacters } from 'node:util'

// Text this machine or a server chose, without the characters that would move a terminal's cursor,
// start a command to it, or break or reorder its line.
const UNPRINTED = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu

export function machineText(text: string): string {
  return stripVTControlCharacters(text).replace(UNPRINTED, '')
}
