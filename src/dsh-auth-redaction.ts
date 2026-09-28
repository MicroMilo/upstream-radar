/** One-time device-login output is not reusable compatibility evidence. */
const EXTERNAL_AUTH_PROMPT = /(?:[?&]user_code=|\bdevice_code\s*[:=]|\bverification_uri\s*[:=]|二维码有效期|扫码登录|scan (?:this )?qr code to (?:log|sign) in)/i
const WITHHELD = '[external account authorization prompt detected; one-time code, URL and QR content withheld]'

export function dshExternalAuthPrompt(output: string): boolean {
  return EXTERNAL_AUTH_PROMPT.test(output)
}

export function redactDshExternalAuthPrompt(output: string): string {
  return dshExternalAuthPrompt(output) ? WITHHELD : output
}
