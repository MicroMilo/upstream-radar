#!/usr/bin/env node

import { appendFile, readFile } from 'node:fs/promises'
import {
  buildDshCompatibilityIssuePlan,
  DSH_COMPATIBILITY_ISSUE_LABELS,
} from '../dist/src/dsh-compatibility-issues.js'

const [ledgerPath] = process.argv.slice(2)
if (ledgerPath === undefined) {
  throw new Error('usage: sync-dsh-compatibility-issues.mjs <compatibility-ledger.json>')
}

const repository = process.env.GITHUB_REPOSITORY
const token = process.env.GITHUB_TOKEN
if (repository === undefined || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
  throw new Error('GITHUB_REPOSITORY must identify the repository that owns compatibility incidents')
}
if (token === undefined || token.length < 20) throw new Error('GITHUB_TOKEN is required to reconcile compatibility incidents')

const apiBase = (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '')
const serverBase = (process.env.GITHUB_SERVER_URL ?? 'https://github.com').replace(/\/$/, '')
const runId = process.env.GITHUB_RUN_ID
const runUrl = runId === undefined ? undefined : `${serverBase}/${repository}/actions/runs/${encodeURIComponent(runId)}`

async function github(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'upstream-radar/compatibility-issue-sync',
      'x-github-api-version': '2022-11-28',
      ...(options.headers ?? {}),
    },
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`GitHub API ${options.method ?? 'GET'} ${path} returned ${response.status}: ${text.slice(0, 1_024)}`)
  }
  return text === '' ? undefined : JSON.parse(text)
}

async function listManagedCandidates() {
  const issues = []
  for (let page = 1; page <= 10; page += 1) {
    const batch = await github(`/repos/${repository}/issues?state=all&per_page=100&page=${page}`)
    if (!Array.isArray(batch)) throw new Error('GitHub issues response is not an array')
    for (const issue of batch) {
      if (issue?.pull_request !== undefined) continue
      if (!Number.isSafeInteger(issue?.number) || (issue.state !== 'open' && issue.state !== 'closed')) continue
      issues.push({
        number: issue.number,
        state: issue.state,
        title: typeof issue.title === 'string' ? issue.title : '',
        body: typeof issue.body === 'string' ? issue.body : '',
      })
    }
    if (batch.length < 100) break
    if (page === 10) throw new Error('compatibility issue reconciliation exceeded 1,000 repository issues')
  }
  return issues
}

async function ensureLabel(name, color, description) {
  const path = `/repos/${repository}/labels/${encodeURIComponent(name)}`
  const response = await fetch(`${apiBase}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'upstream-radar/compatibility-issue-sync',
      'x-github-api-version': '2022-11-28',
    },
  })
  if (response.ok) return
  if (response.status !== 404) throw new Error(`GitHub label lookup for ${name} returned ${response.status}: ${(await response.text()).slice(0, 1_024)}`)
  await github(`/repos/${repository}/labels`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, color, description }),
  })
}

const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'))
const existingIssues = await listManagedCandidates()
const plan = buildDshCompatibilityIssuePlan({ ledger, existingIssues, runUrl })

if (plan.actions.some(action => action.kind !== 'close')) {
  await ensureLabel(DSH_COMPATIBILITY_ISSUE_LABELS[0], '0969da', 'Managed automatically by Upstream Radar')
  await ensureLabel(DSH_COMPATIBILITY_ISSUE_LABELS[1], 'd73a4a', 'A reproduced DSH plugin compatibility incident')
}

const applied = { create: 0, update: 0, reopen: 0, close: 0 }
for (const action of plan.actions) {
  if (action.kind === 'create') {
    await github(`/repos/${repository}/issues`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: action.title, body: action.body, labels: [...DSH_COMPATIBILITY_ISSUE_LABELS] }),
    })
  } else if (action.kind === 'close') {
    await github(`/repos/${repository}/issues/${action.issueNumber}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: action.comment }),
    })
    await github(`/repos/${repository}/issues/${action.issueNumber}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
    })
  } else {
    await github(`/repos/${repository}/issues/${action.issueNumber}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: action.title,
        body: action.body,
        labels: [...DSH_COMPATIBILITY_ISSUE_LABELS],
        ...(action.kind === 'reopen' ? { state: 'open', state_reason: 'reopened' } : {}),
      }),
    })
  }
  applied[action.kind] += 1
}

const summary = {
  repository,
  activeCompatibilityIncidents: plan.openCaseIds.length,
  reviewOnlyCells: plan.reviewOnlyCaseIds.length,
  ignoredUnknownCells: plan.ignoredUnknownCaseIds.length,
  actions: applied,
}
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)

if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
  const lines = [
    '',
    '## Upstream Radar — compatibility incident reconciliation',
    '',
    `- Active compatibility incidents: **${summary.activeCompatibilityIncidents}**`,
    `- Created: **${applied.create}**; updated: **${applied.update}**; reopened: **${applied.reopen}**; resolved and closed: **${applied.close}**`,
    `- Peer-contract cells held for execution-plane review: **${summary.reviewOnlyCells}**`,
    `- Unknown cells held for observer review: **${summary.ignoredUnknownCells}**`,
    '',
  ]
  await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'), 'utf8')
}
