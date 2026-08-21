# DSH known finding watch

This is the first always-on loop for the seven supply-chain findings discovered
in the real DSH plugin batch. It does not install a plugin, run a lifecycle
script, load plugin code, or call a model. It repeats the same two bounded
checks:

1. scan the public source repository;
2. inspect the exact npm version currently named by that source package.

The watch keeps the source and published artifact separate. A clean source scan
does not erase a finding that still exists in the published npm bytes. A failed
network request is `unknown`, never `resolved`.

## Run locally

```bash
pnpm run monitor:dsh-findings
```

The default output is:

- `state.json`: the last trusted source and artifact observations, suitable for
  the next run;
- `report.md`: the author-facing result;
- `report.json`: the machine-readable result.

Override paths when you do not want to change the checked-in observation point:

```bash
pnpm run monitor:dsh-findings -- \
  --state "$TMPDIR/dsh-finding-state.json" \
  --report "$TMPDIR/dsh-finding-report.md" \
  --json-report "$TMPDIR/dsh-finding-report.json"
```

The GitHub Actions workflow at `.github/workflows/dsh-finding-watch.yml` runs
the same command on a schedule and commits `state.json` only when a trusted
observation changes. Findings are evidence for review, not a claim that every
install script or native binary is malicious.
