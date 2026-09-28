// Preserve each exact conclusion when a previously corrected launch is reopened.
// A second receipt for one launch must not overwrite the first archive.
import { open, readdir, rename } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'

export function dshActiveAgentHistoryArchiveName(launchId, inputFingerprint, evidenceDigest) {
  if (!/^[a-f0-9]{32}$/.test(launchId ?? '')
    || !/^sha256:[a-f0-9]{64}$/.test(inputFingerprint ?? '')
    || !/^sha256:[a-f0-9]{64}$/.test(evidenceDigest ?? '')) {
    throw new Error('agent history archive requires exact launch, review input, and receipt digest')
  }
  return `${launchId}.${inputFingerprint.slice(7)}.${evidenceDigest.slice(7)}`
}

export async function archiveDshActiveAgentTurnReceipts(batch, archive) {
  const entries = (await readdir(batch, { withFileTypes: true }))
    .filter(entry => /^agent-host-(?:resume-)?turn-[1-9][0-9]{0,3}\.json$/.test(entry.name))
  if (entries.length > 1000) throw new Error('agent history contains too many turn receipts')
  if (entries.some(entry => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error('agent history contains a non-regular local turn receipt')
  }
  for (const entry of entries) await rename(join(batch, entry.name), join(archive, entry.name))
  return entries.length
}

/** Recover only a previously persisted exact Codex session, never a guessed id. */
export async function recoverDshActiveAgentPrelaunchSession(batch, targetId) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(targetId ?? '')) {
    throw new Error('prelaunch Agent recovery requires an exact target')
  }
  const receipts = (await readdir(batch, { withFileTypes: true }))
    .filter(entry => /^agent-host-turn-[1-9][0-9]{0,2}\.json$/.test(entry.name))
  if (receipts.length === 0 || receipts.length > 512
    || receipts.some(entry => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error('prelaunch Agent recovery requires bounded regular turn receipts')
  }
  receipts.sort((a, b) => Number(a.name.match(/turn-(\d+)/)[1]) - Number(b.name.match(/turn-(\d+)/)[1]))
  const latest = receipts.at(-1)
  const turnNumber = Number(latest.name.match(/turn-(\d+)/)[1])
  const file = await open(join(batch, latest.name), constants.O_RDONLY | constants.O_NOFOLLOW)
  let receipt
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 16 * 1024) throw new Error('prelaunch Agent turn receipt is not bounded regular data')
    receipt = JSON.parse(await file.readFile('utf8'))
  } finally { await file.close() }
  if (receipt?.targetId !== targetId || receipt.turnNumber !== turnNumber
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(receipt.sessionId ?? '')
    || typeof receipt.observedAt !== 'string' || !Number.isFinite(Date.parse(receipt.observedAt))) {
    throw new Error('prelaunch Agent receipt does not bind the exact target and recorded session')
  }
  return { sessionId: receipt.sessionId, turnNumber, receiptName: latest.name }
}
