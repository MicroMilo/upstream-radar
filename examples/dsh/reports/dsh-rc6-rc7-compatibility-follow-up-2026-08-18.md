# DSH `rc.6 → rc.7` compatibility follow-up

Date: 2026-08-18

This is the follow-up to the live adoption run in
[`adoption-smoke.json`](adoption-smoke.json). The observer first found two
candidate DSH updates while checking 513 exact package versions:

- `dsh-cloudflare-browser-run@0.1.1`
- `@open-agfs/dsh-agfs@0.1.9`

For both events, the candidate dependency graph was unavailable. Radar then
ran the bounded `probe dsh-matrix` against the exact published tarball and
DSH `0.1.0-rc.6` and `0.1.0-rc.7`.

| Exact artifact | SHA-256 | `rc.6` | `rc.7` | Result |
| --- | --- | --- | --- | --- |
| `dsh-cloudflare-browser-run@0.1.1` | `27fe660b2fe40b15b70a206310b883ca15722d8ffaacab63232b71128d28701f` | compatible | compatible | 2/2 loaded |
| `@open-agfs/dsh-agfs@0.1.9` | `bfbb878b8c69cf1822dfed27dfb75aaf31fe06fe56ad1542c185f261f963229a` | compatible | compatible | 2/2 loaded |

## What this proves

The exact bundles registered in a disposable DSH profile and their profile
configuration loaded under both DSH versions. This turns the original
“needs analysis” event into a concrete bundle-load result for these two
plugins.

It does not prove that their dependency graphs are complete, that they have
no vulnerabilities, or that their business actions work. The adoption report
still records `dependencyStatus: unavailable` and `activeVulnerabilities: 0`
as separate facts. The probe packs with lifecycle scripts disabled and does
not start a DSH Agent, call an LLM, or execute plugin business actions.

`dsh-feishu-bot@0.14.0` is not included in this matrix because its clean DSH
installation stopped at an unapproved transitive `protobufjs` build script;
the adoption report keeps that installation as `blocked` rather than treating
it as a compatibility pass.
