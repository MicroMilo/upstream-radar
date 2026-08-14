#!/usr/bin/env node

import process from 'node:process'
import { verdictAtLeast } from './policy.js'
import { renderTextReport } from './render.js'
import { scanDirectory } from './scan.js'
import type { Verdict } from './types.js'

const VERSION = '0.1.0'
const VALID_THRESHOLDS = new Set<Verdict | 'never'>(['warn', 'review', 'block', 'never'])

function usage(): string {
  return `Plugin Notary — pre-install supply-chain review for agent plugins

Usage:
  plugin-notary scan <directory> [--json] [--fail-on <warn|review|block|never>]
  plugin-notary version

Exit codes:
  0  scan completed and policy threshold was not reached
  1  operational or input error
  2  configured policy threshold was reached
`
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  if (index === -1) return undefined
  return args[index + 1]
}

async function main(args: readonly string[]): Promise<number> {
  const command = args[0]
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(usage())
    return 0
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }
  if (command !== 'scan') throw new Error(`unknown command: ${command}`)

  const target = args[1]
  if (target === undefined || target.startsWith('-')) throw new Error('scan requires a directory')
  const thresholdValue = valueAfter(args, '--fail-on') ?? 'review'
  if (!VALID_THRESHOLDS.has(thresholdValue as Verdict | 'never')) {
    throw new Error(`invalid --fail-on value: ${thresholdValue}`)
  }

  const report = await scanDirectory(target)
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(renderTextReport(report))
  }

  if (thresholdValue !== 'never' && verdictAtLeast(report.verdict, thresholdValue as Verdict)) return 2
  return 0
}

main(process.argv.slice(2)).then(
  (exitCode) => {
    process.exitCode = exitCode
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`plugin-notary: ${message}\n`)
    process.exitCode = 1
  },
)
