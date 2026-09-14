# DSH repository environment recommendation

This is the pre-execution reasoning stage for the maintained compatibility
corpus. It reads one exact plugin coordinate, the exact observed DSH release,
source and exact npm manifests, and a bounded set of repository documents
before any target code executes.

The Agent reports every Node major explicitly recommended or tested by the
bounded repository evidence (up to 16 values), without being constrained by a
preconfigured runtime pool, plus the execution surfaces `headless`, `web`, and `tui`.
`nodeEvidence` separates author recommendations, CI-configured tests, engine
support and DSH baselines; a CI file is not proof of a successful run. An
evidenced `tuiProfile` retains the author's actual profile name. Named SDK/ACP
workflows are not covered by these three smoke-test surfaces. Explicit
`coverageGaps` for such workflows and missing evidence survive the planners
and keep the directory summary in review even when every smoke cell passes.
Radar currently schedules Node majors 22-40 dynamically; a recommendation
outside that execution range remains visible as a coverage gap rather than
being rewritten to a convenient local version. This scheduling range does not
prove image availability; the pinned pnpm 11.7 requires Node >=22.13. The
detector is built with Node 24 independently of the plugin test runtime.
Deterministic validation rejects
a Node selection that contradicts a declared `engines.node`, requires Web when
the manifest declares `dsh.client.platform=web`, and rejects evidence
references that were not supplied to the Agent.

Document discovery enumerates only immutable package, setup-document and CI
Git trees, excluding symlinks and submodules. It preserves the 24-file,
48-KiB-per-file and 192-KiB-total text bounds. Canonical READMEs and CI precede
redundant translations; oversized or omitted documents remain explicit gaps,
not evidence of absence. DSH baseline files are separately prefixed
`dsh-repository/` and cannot justify extra plugin surfaces. Pass an optional
fifth `candidates.json` argument to the planner to retain the exact bounded
Agent input for review.

`collectionGaps` carries file-count omissions, oversized documents and read
failures into that exact input and its fingerprint. The validator adds an
incomplete-collection coverage flag independently of the Agent's answer;
logging a failed fetch alone is not sufficient coverage accounting.

The planner atomically saves a bounded `recommendations.json.evidence.json`
checkpoint before model delivery. Each collection is bound to the repository,
immutable Git commit, package path, baseline/plugin role, collector code digest,
and collected bytes. An unchanged collection does not refetch documents, so a
later network outage cannot discard valid evidence or create a spurious review.
Fixed file/count/byte omissions remain explicit coverage gaps in the cache;
HTTP failures and parser errors are never cached as a completed collection and
will be retried. Changed commits or collector code force collection again;
changed published manifests still invalidate review independently of this cache.
Only the current cohort's collections are retained (at most 101, including DSH),
with a 64-MiB checkpoint input/output bound. Corrupt or symlinked checkpoints
fail visibly before model delivery. The scheduled observer persists the sidecar
with its recommendation state; validation runs retain it in their review artifact.

Pending analysis tasks are written into
[`recommendations.json`](recommendations.json) before Agent delivery, so model
failure or interruption cannot lose the work. At most 32 tasks are delivered
to the Agent in one workflow run; the rest stay explicitly pending for later
reconciliation. The resulting recommendation is a compatibility signal, not
runtime proof. Each entry is bound to the exact plugin coordinate, DSH version,
source commit/static evidence and hashes of the
bounded documents. The install and surface planners apply only a
recommendation whose source fingerprint is still current. Isolated VMs
establish the eventual compatibility result.

Review contract `dsh-environment/v8` preserves exact DSH release-table rows as
evidence when their own bounded Markdown table explicitly names the DSH
release/version column. Other package columns, detached tables, ranges instead
of exact versions, and DSH's own baseline documents cannot supply a plugin's
release baseline. Single-row and multi-line table quotations use the same column
check; citing an entire table cannot turn another package's version into a DSH
release. Literal quotes must still match collected bytes. Earlier
reviews are retained as history but must be reviewed again under this contract.

DSH-owned manifest references and repository documents cannot establish plugin
author package managers, overrides, workflows, startup settings or release
baselines. On a repeated review of the same exact plugin coordinate, repository
and immutable source commit, prior author DSH baselines are revalidated against
the current collected bytes and rules. A recommended decision that drops a still
supported baseline enters the bounded model-correction loop; old decisions are
never copied into new execution authority. Removed quotes, changed plugin source,
and evidence rejected by current rules do not constrain a new review. Unresolved
contradictions can remain `insufficient-evidence`, which cannot schedule a reduced
plan. This consistency check protects known claims; it does not replace a full
first review of the collected repository evidence.
