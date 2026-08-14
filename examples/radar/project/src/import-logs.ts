import { parseIncomingLog } from 'plugin'

export function importCustomerLog(uploadedText: string): unknown {
  return parseIncomingLog(uploadedText, { expansion: true })
}
