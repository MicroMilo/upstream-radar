# Real DSH plugin review: `dsh-feishu-bot@0.14.0`

This is the first negative result from the one-command DSH plugin review. It
uses the exact npm release and the same packed bytes for dependency inspection
and DSH loading.

## Result

Command:

```bash
node dist/src/cli.js review dsh-plugin dsh-feishu-bot@0.14.0 \
  --dsh-version 0.1.0-rc.6,0.1.0-rc.7
```

```text
Overall: REVIEW
Exact artifact: same bytes for inspection and DSH probe
Dependency review: REVIEW (coverage incomplete)
Known vulnerabilities: 0
Install-time dependency scripts: protobufjs@7.6.5
DSH load matrix: COMPATIBLE (2/2 versions loaded)
  DSH 0.1.0-rc.6: COMPATIBLE
  DSH 0.1.0-rc.7: COMPATIBLE
Findings: 1
  [HIGH] dependency-install-script-present
```

The exact resolved npm lockfile marks `protobufjs@7.6.5` as having an
install-time script. Its published metadata declares:

```text
postinstall: node scripts/postinstall
```

Radar disabled scripts while collecting the graph. It did not execute this
script and this result does not claim that `protobufjs` is malicious or has a
known vulnerability. It says something narrower and actionable: a normal DSH
installation may execute or stop on this transitive install-time behavior.

The separate real adoption replay reached the same operational boundary: a
clean DSH profile stopped on the unapproved `protobufjs` build script. The
static review therefore explains the dependency that caused the installation
problem before the user installs the plugin.

## Closed loop

1. Fetch one exact npm package release.
2. Resolve its exact reachable dependency graph with scripts disabled.
3. Read the lockfile metadata and identify the risky dependency.
4. Pack the exact release and verify the DSH probe uses identical bytes.
5. Load that artifact in DSH `rc.6` and `rc.7`.
6. Return an author-facing finding instead of calling a load-compatible plugin
   safe.

## Maintainer action

Review why `protobufjs@7.6.5` is present and whether its install-time script is
needed. Prefer a dependency path that has no install-time script, or document
and explicitly approve the required script in the DSH installation path. Then
publish a new exact version and rerun the same command.

## Boundary

- No DSH LLM was configured or called.
- No plugin code or business action was executed.
- No npm lifecycle script was executed by Radar.
- DSH loading proves registration and profile loading only; it is not a
  security approval.
