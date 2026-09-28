import assert from 'node:assert/strict'
import { it } from 'node:test'
import { dshExternalAuthPrompt, redactDshExternalAuthPrompt } from '../src/dsh-auth-redaction.js'

it('withholds one-time login URLs and QR content without erasing ordinary dependency failures', () => {
  const auth = '███ QR ███\n二维码有效期约 60 分钟。\n'
    + 'https://open.feishu.cn/page/launcher?user_code=T48U-MMPT&from=sdk'
  assert.equal(dshExternalAuthPrompt(auth), true)
  const redacted = redactDshExternalAuthPrompt(auth)
  assert.match(redacted, /external account authorization/i)
  assert.doesNotMatch(redacted, /T48U|launcher|███|二维码/)
  const fetch = 'ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/@types/node/-/node-26.6.0.tgz'
  assert.equal(dshExternalAuthPrompt(fetch), false)
  assert.equal(redactDshExternalAuthPrompt(fetch), fetch)
})
