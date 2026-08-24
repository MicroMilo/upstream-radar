# DSH isolated install observer

This directory is the maintained headless-test corpus for Upstream Radar.
The Agent plans bounded follow-ups from repository instructions and the latest
runtime evidence; isolated execution establishes the result. The corpus now
contains 100 exact published plugins: 96 identity-checked npm artifacts imported
from the [`awesome-dsh-plugin` cohort](../awesome-observer/README.md), plus four
maintained behavior and repair cases.

## Agent-planned headless follow-up

The first isolated run uses the reviewed clean headless contract. When that run
ends in `build-approval-required` or `peer-contract-incompatible`, the scheduled
Action gives the exact evidence plus bounded repository documents to the
configured Agent. There is deliberately no static environment-planning
fallback. The Agent either stops the headless path or requests one retry whose
build approvals are a subset of the package names already observed by pnpm.
When pnpm reveals another gate, the next Agent decision must retain earlier
approvals and may only add newly observed names, so the loop cannot oscillate.

The plan is persisted in [`agent-plans.json`](agent-plans.json), rendered in
[`agent-plans.md`](agent-plans.md), and bound to the exact plugin artifact, DSH
release and Node major. The target package runs later in a separate no-secret
hosted VM; it never receives the model key. A successful retry retains that
exact build policy for refreshes of the same artifact, while a new artifact or
runtime cannot inherit it.

## What runs where

The reusable workflow runs each plugin in a fresh GitHub-hosted Linux VM. The
job has a read-only repository token, declares no secrets, and never passes the
GitHub token, DSH Agent model key, workspace, or Docker socket into the target
container.

Inside the restricted container, Radar:

1. downloads one exact npm artifact with lifecycle scripts disabled;
2. verifies the tarball's package identity and DSH bundle declaration;
3. binds the report to the tarball SHA-256;
4. checks the package's declared Node requirement against the exact isolated
   runtime before any plugin or dependency code may run;
5. records the exact Node and pnpm runtime used by the observation;
6. initializes one exact DSH release with scripts disabled;
7. installs the local tarball through DSH with lifecycle scripts enabled and
   only the dependency-build approvals explicitly declared for that target;
8. verifies that DSH registered the bundle;
9. runs a trusted one-shot wrapper from the real profile that resolves every
   declared non-optional peer with `import.meta.resolve()`, imports the plugin,
   and boots DSH headless with `--help`;
10. records install and load process execution, network destinations, write-like
   file syscalls, final filesystem changes, the resulting DSH profile lockfile,
   the effective profile-plus-DSH-host graph, and static literal-import evidence
   for every declared peer; and
11. destroys the container and hosted VM after preserving bounded JSON.

The container is read-only except for a memory-backed sandbox and one output
directory. It runs without the host workspace, without a Docker socket, with a
PID limit, memory/CPU limits, `no-new-privileges`, all capabilities dropped
except the `SYS_PTRACE` capability needed by `strace`, and a hard outer timeout.
Its declared Linux baseline includes Python 3, `make`, and `g++`, so an approved
native dependency is tested against a usable build environment instead of being
misclassified merely because the observer image omitted the standard Node-gyp
toolchain.

## When the matrix runs

[`targets.json`](targets.json) is not a popularity ranking. Adoption signals
help choose the cohort, but identity, category coverage and executable evidence
decide admission. It is the set of exact plugins whose install/load behavior we
commit to retesting. The durable
[`compatibility-ledger.json`](../../../compatibility-ledger.json) holds the most
recent evidence for every active plugin × DSH × Node/runtime-policy cell.
The same reconciliation writes a compact
[`compatibility-ir.json`](../../../compatibility-ir.json) and
[`compatibility-reverse-index.json`](../../../compatibility-reverse-index.json):
one exact peer declaration paired with the concrete host version DSH resolved,
then the inverse `host package → affected plugin cell` lookup.

An entry may declare `allowedBuilds` when the plugin's documented installation
contract explicitly approves named dependency scripts. The names become pnpm
`--allow-build` arguments and are copied into the signed-off report boundary.
An absent list means no dependency build is approved; Radar never turns one
blocked script into a global “allow all” policy.

- Every scheduled pass builds the desired current matrix from the observed
  DSH/plugin coordinates and retained runtime evidence.
- A cell runs when it is missing, has become older than `refreshAfterHours`, or
  its source/package evidence, runtime image, or allowed-build policy differs from the
  record in the ledger. DSH and mapped plugin publications are immediate
  invalidation signals, not the sole source of work.
- A `runtime-incompatible` result records the artifact's Node engine before any
  plugin code runs. If another configured runtime could satisfy that range,
  Radar adds one alternate-runtime cell rather than calling the plugin globally
  incompatible.
- Every selected cell receives a separate hosted VM through the workflow
  matrix. The ledger accepts a report only when its case label, tarball, DSH
  version, Node major, and explicit build approvals match the scheduled plan.
- A missing or malformed report is never saved as compatible. It remains
  unsatisfied and will be selected again on the next reconciliation.
- A `compatible` result only closes its matrix cell when the final effective
  profile-plus-DSH-host graph is complete and every direct required peer
  resolves inside the real profile with a version satisfying the declared
  range. A green install/load with missing, out-of-range, or unresolved
  contract evidence remains an explicit evidence gap. The report keeps a
  bounded sample of unresolved edges and labels source-level peer use as runtime,
  type-only, no literal reference observed, or scan-incomplete.
- An actionable incompatibility creates one managed issue keyed by the stable
  target/runtime cell. Persistent failures update that issue, regressions
  reopen it, and a later compatible retest adds evidence and closes it.

## Result semantics

| Result | Meaning |
| --- | --- |
| `compatible` | The exact tarball installed, registered, and loaded under the exact DSH release and recorded build-approval set, with readable bounded traces. |
| `runtime-incompatible` | The exact tarball requires a Node version that excludes the isolated runtime. No plugin or dependency code is executed. |
| `peer-contract-incompatible` | Install and load passed, but a declared required peer is missing from the actual DSH profile or its resolved version is outside the declared range. This is not by itself proof that every UI/business path fails. |
| `build-approval-required` | pnpm stopped before registration and supplied an exact list of dependency packages whose lifecycle builds need explicit approval. This is a trust-policy gate, not proof that the plugin is incompatible. |
| `install-failed` | The traced install failed or DSH did not register the plugin. |
| `load-failed` | Installation and registration passed, but the traced profile load failed. |
| `unknown` | The artifact, DSH bootstrap, timeout/output bound, tracer, or collector could not establish a reliable result. |

The report separately preserves `captured`, `truncated`, and `missing` trace
coverage. A failed attempt is not silently converted into a compatibility
result. The JSON artifact and Job Summary are written first. A reproduced
incompatibility is a successful observer result and is reconciled into a
managed issue; the check fails only when no trustworthy result survives, such
as a missing, malformed, rejected, or `unknown` report. This distinction keeps
product findings separate from observer-infrastructure failures.

The [OpenPencil current-DSH case](reports/2026-08-22-openpencil-node24.md)
shows the full distinction in practice: headless load passed, but one
type-only peer declaration was absent from DSH and one runtime `react-dom`
import resolved outside the plugin's declared range.

## Security boundary

This is useful behavior evidence, not a malware-analysis certificate. Docker
containers share the VM kernel, network destinations are IP/socket evidence
rather than guaranteed domain attribution, and code running in the same
container may try to tamper with its own trace or output. The disposable outer
VM and absence of secrets limit the consequence of that gap. A future
Firecracker backend can move tracing outside the guest when adversarial
tamper-resistance becomes a product requirement.

Every approved dependency build executes third-party code. Approval is accepted
only as a bounded npm package-name list, is visible in JSON and the Job Summary,
and is never inferred from an error message or model output.

The workflow follows GitHub's warning that downloaded third-party code can
compromise a runner and therefore gives that runner no secret worth stealing:

- <https://docs.github.com/en/actions/concepts/security/compromised-runners>
- <https://docs.github.com/en/actions/concepts/runners/github-hosted-runners>
- <https://docs.docker.com/engine/containers/run/>
- <https://strace.io/>
