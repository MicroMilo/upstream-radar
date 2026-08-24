# Follow-up: three DSH plugins with stale lockfile root metadata

This is a maintainer-quality finding, not a vulnerability report. It matters
because Upstream Radar cannot reliably attach a dependency graph to the release
the author says they are publishing when the lockfile root still names an older
release.

## Rechecked with the public CLI

Each repository was cloned at its current public `main` commit and scanned with
`upstream-radar@0.43.1`. No package was installed, loaded, or executed.

| Repository | Commit | `package.json` | `package-lock.json` root | Result |
| --- | --- | ---: | ---: | --- |
| [dsh-composer-expand](https://github.com/13071301808/dsh-composer-expand) | [`cb61627`](https://github.com/13071301808/dsh-composer-expand/commit/cb6162753f6f48923b19275008c9d7a87718068a) | 0.1.2 | 0.1.0 | `lockfile-root-metadata-stale` |
| [dsh-msg-hub](https://github.com/AbcdefgXW/dsh-msg-hub) | [`767a94a`](https://github.com/AbcdefgXW/dsh-msg-hub/commit/767a94ac72aff2049946b0ed4e816693031f47e7) | 0.1.7 | 0.1.1 | `lockfile-root-metadata-stale` |
| [dsh-toolbox-web](https://github.com/AbcdefgXW/dsh-toolbox-web) | [`e960e39`](https://github.com/AbcdefgXW/dsh-toolbox-web/commit/e960e394a5727c084010fdb6ce722885835e121a) | 0.1.6 | 0.1.1 | `lockfile-root-metadata-stale` |

All three returned `riskVerdict: allow` and `coverageVerdict: incomplete`.
That distinction is important: this is not evidence of a compromised package;
it is evidence that future dependency monitoring may be joined to the wrong
release identity.

## Author action

Each maintainer should confirm whether npm or pnpm is canonical. If npm is
canonical, regenerate `package-lock.json` from the intended `package.json` with
lifecycle scripts disabled and review the complete diff. If pnpm is canonical,
remove the stale competing npm lockfile instead of publishing two conflicting
graphs.

The corresponding author feedback draft is
[`dsh-composer-expand-lockfile-feedback.md`](dsh-composer-expand-lockfile-feedback.md).
The neutral confirmation issue is now published as
[13071301808/dsh-composer-expand#1](https://github.com/13071301808/dsh-composer-expand/issues/1).
