# Real DSH bundle probe: `dsh-feishu-bot@0.15.4`

Checked on 2026-08-17 against the exact npm tarball
[`dsh-feishu-bot@0.15.4`](https://www.npmjs.com/package/dsh-feishu-bot/v/0.15.4).
The artifact digest is:

```text
sha256:85b2bae60efd1fa7878c0abd7e1bbcfff09860dcf2f4514a73a365d0617f64b7
```

## Result

The same artifact was loaded in two disposable DSH `headless` profiles:

| DSH version | Artifact preflight | Profile registration | Profile load | Result |
| --- | --- | --- | --- | --- |
| `0.1.0-rc.6` | passed | passed | passed | `compatible` |
| `0.1.0-rc.7` | passed | passed | passed | `compatible` |

Reproduce it with:

```bash
npm pack --ignore-scripts --pack-destination /tmp dsh-feishu-bot@0.15.4
pnpm dlx --package=upstream-radar@0.33.8 upstream-radar probe dsh-matrix \
  /tmp/dsh-feishu-bot-0.15.4.tgz \
  --dsh-version 0.1.0-rc.6,0.1.0-rc.7
```

## What the installation scan found

- The package declares a DSH bundle patch at `cordis.patch.yml`.
- The exact tarball has no lifecycle scripts.
- npm tarball integrity, registry signature, and build provenance were verified.
- The dependency audit resolved 89 packages and found 0 known vulnerabilities.
- 12 unresolved edges are all optional platform or feature choices, so coverage is
  `INCOMPLETE`; the empty vulnerability list is not a safety certificate.
- Source-to-artifact matching was not performed.

The probe only proves that DSH registered the bundle and loaded its profile
configuration. It does not run Feishu actions, exercise the model, or prove the
package is safe. The value of this case is narrower and concrete: the current
published artifact loads on both tested DSH releases, so a compatibility report
should not claim a break based only on its older `rc.6` dependency declarations.
