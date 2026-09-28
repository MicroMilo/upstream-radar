# DSH execution-plane observer

This cohort closes two evidence gaps left by a headless profile:

- `dsh-univer-office` runs in the official DSH Web profile under Chromium. Radar requires the page root, boot-manifest row, exact client bundle, and materialized module.
- `@deepseek-harness-tui/dsh-tui` runs in a real pseudo-terminal. Radar requires a rendered frame, bounded input, and the documented double-Ctrl-C shutdown.

The planner derives the exact plugin artifact, DSH version, and Node major from `compatibility-ledger.json`. Repository recommendations add every evidenced Web/TUI profile for every recommended Node runtime while preserving manually reviewed targets. The complete desired set may exceed one workflow run, so reconciliation processes bounded 32-cell batches and leaves the remainder explicitly deferred. A report from another artifact or execution plane cannot satisfy the cell. The scheduled workflow runs each cell in a fresh GitHub-hosted VM and restricted container without repository or model secrets.

Each surface observation independently records the installed profile lockfile
and effective profile-plus-exact-DSH-host graph. Compatible reports without that
graph or its exact host version are rejected. Actual platform, architecture,
pnpm version, artifact digest and the source graph participate in evidence binding.

For current DSH Web authentication, the observer accepts only the generated
login URL for its fixed disposable loopback origin. Client bundles are fetched
inside the authenticated browser context; retained host logs redact the
ephemeral token. An unestablished login is incomplete setup, not a plugin bug.
Only an exact packed manifest declaring `dsh.client.platform=web` requires a
browser client entry. Host-only tools installed into Web instead require exact
registration, host boot and stock application mount; no client materialization
is invented for them. An observed nonzero host exit remains a host failure,
not a browser-driver failure.

Execution contract `dsh-surface/v1alpha8` additionally records a complete,
bounded projection of the actual browser boot roster (ids, opaque revisions,
injection and external edges), its SHA-256, and the authenticated plugin
bundle's byte count and SHA-256. These observations are independent of the
Node graph. Boot revisions are not npm versions: exact browser peer versions
remain explicitly unobserved. Successful startup does not suppress Node
coverage gaps or peer declaration mismatches in the directory feed. New
scheduled reports must establish the new contract; old reports remain history.

An explicit credential-free `--network-proxy http://host:port` can be used for
package transport. It does not inherit host proxy credentials, disable registry
TLS, approve lifecycle scripts broadly, or permit non-loopback browser requests.
