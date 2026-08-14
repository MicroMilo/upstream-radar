#!/usr/bin/env node

import process from 'node:process'
import { inspectNpmPackage } from './npm.js'
import { verdictAtLeast } from './policy.js'
import { renderTextReport } from './render.js'
import { scanDirectory } from './scan.js'
import type { Verdict } from './types.js'
import { TOOL_VERSION } from './version.js'

const VALID_THRESHOLDS = new Set<Verdict | 'never'>(['warn', 'review', 'block', 'never'])

function safeErrorMessage(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, character => (
    `\\u${character.codePointAt(0)?.toString(16).padStart(4, '0') ?? '0000'}`
  )).slice(0, 2_048)
}

function usage(): string {
  return `Plugin Notary — pre-install supply-chain review for agent plugins

Usage:
  plugin-notary scan <directory> [--json] [--fail-on <warn|review|block|never>]
  plugin-notary inspect npm:<package>@<exact-version> [--deep] [--json] [--fail-on <warn|review|block|never>]
  plugin-notary version

Commands:
  scan     bounded, read-only inspection of a local package directory
  inspect  fetch and verify the exact npm artifact before inspecting its contents

Options:
  --deep               resolve the dependency graph with scripts disabled and ask npm to verify signatures/provenance
  --registry <url>     HTTPS npm registry (default: https://registry.npmjs.org/)
  --json               emit the canonical JSON report
  --fail-on <verdict>  CI threshold; default is review

Exit codes:
  0  scan completed and policy threshold was not reached
  1  operational or input error
  2  configured policy threshold was reached
`
}

async function main(args: readonly string[]): Promise<number> {
  const command = args[0]
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(usage())
    return 0
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    process.stdout.write(`${TOOL_VERSION}\n`)
    return 0
  }
  if (command !== 'scan' && command !== 'inspect') throw new Error(`unknown command: ${command}`)

  const target = args[1]
  if (target === undefined || target.startsWith('-')) throw new Error(`${command} requires a target`)
  let thresholdValue: string = 'review'
  let registry: string | undefined
  let json = false
  let deep = false
  for (let index = 2; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--json') {
      json = true
    } else if (argument === '--deep' && command === 'inspect') {
      deep = true
    } else if (argument === '--fail-on' || (argument === '--registry' && command === 'inspect')) {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${argument} requires a value`)
      if (argument === '--fail-on') thresholdValue = value
      else registry = value
      index += 1
    } else {
      throw new Error(`unknown option for ${command}: ${argument}`)
    }
  }
  if (!VALID_THRESHOLDS.has(thresholdValue as Verdict | 'never')) {
    throw new Error(`invalid --fail-on value: ${thresholdValue}`)
  }

  const report = command === 'scan'
    ? await scanDirectory(target)
    : await inspectNpmPackage(target, {
        deep,
        ...(registry === undefined ? {} : { registry }),
      })
  if (json) {
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
    process.stderr.write(`plugin-notary: ${safeErrorMessage(message)}\n`)
    process.exitCode = 1
  },
)
