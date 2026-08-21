# DSH isolated install observer

This directory is the maintained dynamic-test corpus for Upstream Radar. It is
small on purpose: static checks can cover the wider plugin inventory every day;
code execution happens only after an exact DSH or mapped plugin publication
changes. The corpus currently contains nine published plugins: the original
three behavior cases plus six identity-checked targets imported from the
[`awesome-dsh-plugin` cohort](../awesome-observer/README.md).

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
9. loads the profile with `--dump-config`;
10. records install and load process execution, network destinations, write-like
   file syscalls, and final filesystem changes; and
11. destroys the container and hosted VM after preserving bounded JSON.

The container is read-only except for a memory-backed sandbox and one output
directory. It runs without the host workspace, without a Docker socket, with a
PID limit, memory/CPU limits, `no-new-privileges`, all capabilities dropped
except the `SYS_PTRACE` capability needed by `strace`, and a hard outer timeout.

## When the matrix runs

[`targets.json`](targets.json) is not a popularity list. It is the set of exact
plugins whose install/load behavior we commit to retesting.

An entry may declare `allowedBuilds` when the plugin's documented installation
contract explicitly approves named dependency scripts. The names become pnpm
`--allow-build` arguments and are copied into the signed-off report boundary.
An absent list means no dependency build is approved; Radar never turns one
blocked script into a global “allow all” policy.

- A new exact `@deepseek-ai/dsh` package tests every enabled corpus entry at
  its latest successfully observed npm coordinate; the checked-in exact spec
  is the fallback when no trustworthy observation exists yet.
- A new exact package for a plugin mapped by `observerTargetId` tests only that
  plugin, using the newly observed version.
- A source-only commit, unchanged package coordinate, baseline, or unrelated
  target does not execute plugin code.
- Every selected plugin receives a separate hosted VM through the workflow
  matrix.

## Result semantics

| Result | Meaning |
| --- | --- |
| `compatible` | The exact tarball installed, registered, and loaded under the exact DSH release and recorded build-approval set, with readable bounded traces. |
| `runtime-incompatible` | The exact tarball requires a Node version that excludes the isolated runtime. No plugin or dependency code is executed. |
| `install-failed` | The traced install failed or DSH did not register the plugin. |
| `load-failed` | Installation and registration passed, but the traced profile load failed. |
| `unknown` | The artifact, DSH bootstrap, timeout/output bound, tracer, or collector could not establish a reliable result. |

The report separately preserves `captured`, `truncated`, and `missing` trace
coverage. A failed attempt is not silently converted into a compatibility
result. The JSON artifact and Job Summary are written first, then the GitHub
check fails unless the result is `compatible`, so a scheduled regression is
visible without somebody opening the artifact by hand.

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
