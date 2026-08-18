# Latest real DSH plugin review: `dsh-feishu-bot@0.15.8`

This is a fresh review of the latest published Feishu plugin release. The
inspection and the DSH probe used the same exact npm artifact; no plugin code,
business action, lifecycle script, or LLM was executed.

## Result

Command:

```bash
node dist/src/cli.js review dsh-plugin dsh-feishu-bot@0.15.8 \
  --dsh-version 0.1.0-rc.6,0.1.0-rc.7
```

```text
Overall: REVIEW
Artifact integrity: verified
Dependency graph: 89 packages; 12 optional edges unresolved
Known vulnerabilities: 0
Install-time dependency scripts: protobufjs@7.6.5
  postinstall: node scripts/postinstall
DSH load matrix: COMPATIBLE (2/2 versions loaded)
  DSH 0.1.0-rc.6: COMPATIBLE
  DSH 0.1.0-rc.7: COMPATIBLE
```

The release has verified npm provenance pointing to:

```text
Repository: https://github.com/PlutoKeating/dsh-lark-bot
Tag: refs/tags/v0.15.8
Commit: 4ee9739eb6de22a810b5dbb6f93cbf68045cbf8
Workflow: .github/workflows/release.yml
```

## What the author can fix

`protobufjs@7.6.5` is reachable through the exact published dependency graph
and declares `postinstall: node scripts/postinstall`. Radar disables lifecycle
scripts while collecting evidence and does not call this package malicious or
vulnerable. The actionable question is whether this transitive install-time
script is necessary for the DSH plugin and whether the installation path should
document or avoid it.

The 12 unresolved edges are optional platform packages, not an empty result;
they remain visible so an author does not mistake “0 known vulnerabilities” for
complete coverage of every optional platform combination.

## Why this is useful

The plugin loads on both tested DSH releases, has verified source provenance,
and has no known vulnerabilities, yet still receives `REVIEW` because its
installation has an extra trust boundary. That is the distinction an author
needs before asking users to install the plugin.

## Boundary

- No DSH LLM was configured or called.
- No npm lifecycle script was executed.
- No plugin code or business action was executed.
- DSH loading proves registration and profile loading only; it is not a safety
  certificate.
