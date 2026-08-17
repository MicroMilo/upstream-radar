import { appendFileSync, existsSync } from 'node:fs'

const config = process.env.RADAR_CONFIG || 'upstream-radar.config.json'
const output = process.env.GITHUB_OUTPUT

let kind = 'missing'
let path = ''

if (existsSync(config)) {
  kind = 'config'
} else {
  const hasPnpm = existsSync('pnpm-lock.yaml')
  const hasNpm = existsSync('package-lock.json')
  if (hasPnpm && hasNpm) {
    kind = 'ambiguous'
  } else if (hasPnpm) {
    kind = 'pnpm'
    path = 'pnpm-lock.yaml'
  } else if (hasNpm) {
    kind = 'npm'
    path = 'package-lock.json'
  }
}

const lines = [`kind=${kind}`]
if (path) lines.push(`path=${path}`)
if (output) appendFileSync(output, `${lines.join('\n')}\n`)
process.stdout.write(`${lines.join('\n')}\n`)
