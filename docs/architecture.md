# Architecture

## Components

```text
                         Public review service
                         +-------------------+
                         | index + monitors  |
                         | isolated workers  |
                         | human review      |
                         | signed receipts   |
                         +---------+---------+
                                   |
                                   v
User -> admission CLI -> evidence cache -> policy engine -> exact install
              |                                      |
              +-> local quarantine scanner           +-> trust lock
                                                            |
DSH profile boot -------------------------------------------+-> verify -> load
```

## Core packages envisioned

- `core`: schemas, canonicalization, artifact identity and digest handling;
- `collectors`: npm, Git, filesystem and future extension-format adapters;
- `analyzers`: provenance, dependency, lifecycle, archive, binary and malware evidence;
- `policy`: deterministic evidence-to-decision rules;
- `receipt`: signing, verification, expiry and revocation;
- `adapters/dsh`: profile resolution, candidate lock graph, installation and boot verification;
- `cli`: local user and CI interface;
- `service`: public index, scheduling and analyst workflow.

The prototype keeps these concepts in one package until boundaries are proven by use.

## Implemented v0.2 path

```text
exact npm spec
  -> registry metadata
  -> bounded tarball download
  -> integrity + registry signature
  -> bounded tar parser (no links materialized)
  -> static package evidence
  -> optional dependency resolution with scripts disabled
  -> npm signature/provenance verification + advisory audit
  -> risk verdict + coverage verdict
  -> admission decision (at least REVIEW while required coverage is missing)
```

## Admission transaction

1. Snapshot the current DSH profile manifest and lockfile.
2. Resolve the requested mutation in an isolated temporary profile.
3. Identify every new or changed artifact by digest.
4. Reuse valid signed receipts when possible.
5. Scan unresolved artifacts without lifecycle scripts.
6. Detonate artifacts requiring installation or load observation in an isolated worker.
7. Evaluate evidence under the selected policy.
8. If allowed, install the already-reviewed bytes under a frozen graph.
9. Verify the materialized graph and write an atomic trust lock.
10. At profile boot, verify the graph and revocation state before loading plugin code.

## Evidence versus policy

Evidence collectors must report bounded facts such as `signature valid`, `prepare script present`, or `source-artifact comparison incomplete`. They do not decide that a package is safe.

Policy maps evidence to `allow`, `warn`, `review`, or `block`. Organizations may use different policies over identical evidence. Signed receipts bind both the evidence and the policy decision so consumers can independently re-evaluate the evidence under another policy.

## Review receipt identity

A future receipt must bind at least:

- top-level artifact digest;
- complete dependency-graph digest;
- source and build provenance identities;
- scanner and rule-set versions;
- scan coverage and environment;
- findings and human approvals;
- policy identity and decision;
- issue, expiry and revocation information;
- reviewer signature.
