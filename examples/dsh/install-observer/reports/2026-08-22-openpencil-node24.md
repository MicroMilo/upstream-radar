# Real compatibility case: OpenPencil on current DSH

This is a reproducible contract-drift case, not a claim that OpenPencil's UI is
known to crash. The evidence comes from a fresh GitHub-hosted VM and restricted
container: [Actions run 32502554160](https://github.com/MicroMilo/upstream-radar/actions/runs/32502554160).

| Exact input | Observed value |
| --- | --- |
| Plugin artifact | `@zseven-w/dsh-openpencil@0.1.0-rc.1` |
| Tarball SHA-256 | `a4563e560e91bcd3a2a9302ee7dbee046b146c1bd0de6b27b7c7524fd52e77ca` |
| DSH | `@deepseek-ai/dsh@0.1.1-rc.1` |
| Runtime | Node `24.19.0`, pnpm `11.7.0`, Linux x64 |
| Effective graph | 448 nodes, 2,026 edges, 59 unavailable optional platform packages |

## What actually passed

The exact tarball was packed with scripts disabled, then DSH initialized a new
profile, installed the local tarball, registered its bundle, imported the
plugin from the profile's real module-resolution anchor, and booted DSH
headless. All six stages passed: runtime, artifact, profile, install,
registration, and load.

## What the static and dynamic evidence disagree on

Radar read 14 non-optional peer declarations from that same packed artifact,
then ran `import.meta.resolve()` for each one inside the final DSH profile and
checked the concrete package manifest that Node resolved.

| Declared peer | Plugin declaration | DSH actually resolves | Static artifact use | Interpretation |
| --- | --- | --- | --- | --- |
| `@deepseek-ai/dsh-client-ui-slots` | `^0.1.0-rc.6` | not resolved | Type-only reference observed | The package currently declares a required host peer that the current DSH profile does not provide. The published source only showed type references, so this is a declaration/typing contract drift, not proof of a headless runtime crash. |
| `react-dom` | `^18.2.0` | `19.2.8` | Runtime import observed | The client bundle imports `react-dom`, while the current host exposes React DOM 19 outside the declared range. Headless boot passed, but a client/UI path still needs explicit React 19 validation. |

The remaining **12/14** direct peer contracts were satisfied. There were no
indeterminate contracts. The one required unresolved graph edge is the missing
`dsh-client-ui-slots` contract above; optional platform variants are reported
separately and do not turn into a false failure.

## Author-facing repair path

1. Decide whether `dsh-client-ui-slots` is needed at runtime. If it is only a
   compile-time type, remove it from required `peerDependencies`, make it
   optional, or obtain the type through a supported development dependency. If
   the web bundle needs it at runtime, align the plugin with the current DSH
   client API instead.
2. Exercise the OpenPencil client path against DSH's React DOM 19. If it is
   supported, widen the peer range deliberately (for example, after tests);
   otherwise keep the range and declare the DSH version boundary clearly.

The follow-up test should rerun this exact artifact/DSH/Node cell. A green
headless load alone is insufficient: Radar will close the cell only when all
required direct host contracts resolve and satisfy their declared ranges.
