# `@sanqi-normal/dsh-webui-market-plugin@0.5.4` dependency-resolution feedback

Run date: 2026-08-18

Package: [@sanqi-normal/dsh-webui-market-plugin@0.5.4](https://www.npmjs.com/package/@sanqi-normal/dsh-webui-market-plugin/v/0.5.4)

Source repository: [Sanqi-normal/dsh-webui-market-plugin](https://github.com/Sanqi-normal/dsh-webui-market-plugin)

Artifact SHA-256:
`af56c9dacbfcdc0a3ac8e50c0f84d285eefa67b05208008f14a0067c7605f2aa`

## Reproduction

The exact published artifact has no lifecycle scripts and its npm registry
integrity/signature check passes. Its manifest declares these peer dependencies:

```json
{
  "react": "^18.2.0",
  "@deepseek-ai/cordis": "*",
  "@deepseek-ai/dsh-client-runtime": "*",
  "@deepseek-ai/dsh-client-ui-slots": "*"
}
```

It has no runtime dependencies and the source repository has no committed
`pnpm-lock.yaml`, `package-lock.json`, or `yarn.lock` at the checked commit.

Running the bounded dependency resolver with scripts disabled fails before a
complete graph can be built:

```text
npm candidate dependency resolution failed with exit code 1:
404 Not Found - GET https://registry.npmjs.org/@deepseek-ai%2fdsh-compact
@deepseek-ai/dsh-compact@^0.0.1-rc.1 is not published
```

The missing package is pulled by the currently published peer candidate
`@deepseek-ai/dsh-client-runtime@0.0.1-rc.1`:

```text
@deepseek-ai/dsh-client-runtime@0.0.1-rc.1
└── @deepseek-ai/dsh-compact@^0.0.1-rc.1   (not published)
```

Radar therefore reports:

- dependency graph: **unavailable**;
- known vulnerability result: **not established**, not “zero vulnerabilities”;
- package risk: **review**, because the actual dependency set cannot be
  resolved from the public registry;
- provenance: missing, which is a separate evidence gap;
- lifecycle scripts: none found in the exact artifact.

## Why this matters to DSH users

The plugin may still work inside a DSH web profile that already supplies the
client runtime from another host plane. This check does not prove that the
plugin is malicious or that every DSH profile is broken.

It does prove that a clean registry-based dependency check cannot establish
what the plugin will receive for its DSH client peers. That prevents reliable
vulnerability monitoring and makes compatibility depend on whichever host
packages happen to be present.

## Smallest author fix

1. Publish or otherwise make the required `@deepseek-ai/dsh-compact` release
   available together with the DSH client runtime, or point the plugin at a
   client-runtime release whose published dependency graph is complete.
2. Replace the three `*` DSH peer ranges with the DSH host versions that the
   plugin actually tests.
3. Add a clean install/DSH profile check to release CI so a missing DSH host
   package fails before publishing.

After the fix, rerun the same exact-version check and confirm that the complete
graph is resolved before interpreting the vulnerability list.

## Boundary

This is a dependency publication and DSH host-compatibility finding, not a
confirmed vulnerability. The evidence is based on the exact npm artifact,
registry metadata, and a scripts-disabled resolver; no plugin code was run.

## Upstream feedback

Because ownership may belong to the DSH host publication chain rather than this
plugin, the first upstream contact was a semantics-confirmation issue rather
than a code-change PR:

- [Sanqi-normal/dsh-webui-market-plugin#5](https://github.com/Sanqi-normal/dsh-webui-market-plugin/issues/5)
- Status at the last check: **open**, with no maintainer or bot reply yet.

The issue includes the exact `upstream-radar@0.33.1` reproduction command and
asks whether the intended contract is public-registry resolution or a DSH
profile-supplied host plane.
