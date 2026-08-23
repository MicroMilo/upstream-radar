# DSH directory compatibility evidence

Generated from catalog commit [`7f79f9c11b3c`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/commit/7f79f9c11b3c655fe7656a00e54f0b6f8aa0bf82) at `2026-08-23T08:02:26.261Z`.

**4 observed compatible · 0 observed incompatible · 2 needs review · 2 not observed**

| Catalog plugin | Exact artifact | Exact DSH / runtime | Evidence status | Observed |
| --- | --- | --- | --- | --- |
| [bowenliang123/dsh-context](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/7f79f9c11b3c655fe7656a00e54f0b6f8aa0bf82/data/plugins/bowenliang123__dsh-context.yml) | `dsh-context@0.25.3` | `0.1.1-rc.2` / Node 22 | `observed-compatible` | 2026-08-23T03:40:17.088Z |
| [dsh-market/dsh-market](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/7f79f9c11b3c655fe7656a00e54f0b6f8aa0bf82/data/plugins/dsh-market__dsh-market.yml) | `dshmarket@1.19.0` | `0.1.1-rc.2` / Node 22 | `observed-compatible` | 2026-08-23T07:09:16.954Z |
| [GanyuanRan/Aegis](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/7f79f9c11b3c655fe7656a00e54f0b6f8aa0bf82/data/plugins/GanyuanRan__Aegis.yml) | — | — | `not-observed` | — |
| [Han-1413141/dsh-cost-meter](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/7f79f9c11b3c655fe7656a00e54f0b6f8aa0bf82/data/plugins/Han-1413141__dsh-cost-meter.yml) | `dsh-cost-meter@1.5.38` | `0.1.1-rc.2` / Node 22 | `observed-compatible` | 2026-08-23T03:40:18.405Z |
| [Lum1104/dsh-browser](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/7f79f9c11b3c655fe7656a00e54f0b6f8aa0bf82/data/plugins/Lum1104__dsh-browser--packages-browser-bridge-browser.yml) | — | — | `not-observed` | — |
| [NanmiCoder/dsh-agent-teams](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/7f79f9c11b3c655fe7656a00e54f0b6f8aa0bf82/data/plugins/NanmiCoder__dsh-agent-teams.yml) | `@nanmicoder/dsh-agent-teams@0.1.13` | `0.1.1-rc.2` / Node 22 | `observed-compatible` | 2026-08-23T03:40:29.383Z |
| [omdsh-dev/DSH-better-sidebar](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/7f79f9c11b3c655fe7656a00e54f0b6f8aa0bf82/data/plugins/omdsh-dev__DSH-better-sidebar.yml) | `dsh-better-sidebar@0.15.2` | `0.1.1-rc.2` / Node 22 | `needs-review` | 2026-08-23T03:40:58.944Z |
| [ZSeven-W/dsh-openpencil](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/7f79f9c11b3c655fe7656a00e54f0b6f8aa0bf82/data/plugins/ZSeven-W__dsh-openpencil.yml) | `@zseven-w/dsh-openpencil@0.1.0-rc.1` | `0.1.1-rc.2` / Node 24 | `needs-review` | 2026-08-23T03:40:15.559Z |

## Reading the status

- `observed-compatible`: the exact artifact installed, registered and loaded in the stated headless cell.
- `observed-incompatible`: the exact cell reproduced a runtime gate, install, registration or load failure.
- `needs-review`: evidence exists, but Radar cannot yet separate a plugin defect from an uncovered execution plane or environment condition.
- `not-observed`: the catalog entry is monitored statically but has no matching executable npm artifact in this cohort.

A cell expires at its `recheckDueAt` value (168 hours after observation). Consumers must then show it as stale. This is exact compatibility evidence, not a security review or endorsement.

[Machine-readable feed](dsh-plugin-compatibility.json) · [Full compatibility ledger](https://github.com/MicroMilo/upstream-radar/blob/main/compatibility-ledger.json)
