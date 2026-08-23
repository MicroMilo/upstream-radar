# DSH core artifact: exact dependency review

This is a real deep inspection of the exact published
`@deepseek-ai/dsh@0.1.0-rc.7` artifact. It was run from the current Upstream
Radar branch; it did not start DSH, load a bundle, call an LLM, or execute a
package lifecycle script.

```bash
GITHUB_TOKEN='a read-only GitHub token' node dist/src/cli.js inspect \
  npm:@deepseek-ai/dsh@0.1.0-rc.7 --deep --json --fail-on never
```

## Result

- Verdict: `REVIEW / INCOMPLETE`
- Exact artifact SHA-256: `sha256:2f8f0b763d611ac536f7a9411ee43c0afc067c1b8732c3102c04dbe398bcacc5`
- npm integrity: verified
- npm registry signature: verified
- Build provenance: missing
- Resolved dependency graph: 568 nodes, 2,085 edges
- Unresolved edges: 262, of which 257 are peer edges and 5 are optional edges
- npm audit result for the resolved graph: 0 known vulnerabilities

## Why the report is review, not allow

Strict npm peer resolution did not produce a graph within its one-minute
bounded window. Radar then retried with `--legacy-peer-deps`, still with
`--ignore-scripts`, and produced the 568-node graph. That fallback makes the
dependency inventory useful, but it does not claim that every peer relationship
has been enforced. The report therefore records
`dependency-peer-resolution-relaxed` and keeps the 262 unresolved edges
visible.

The missing provenance is a separate supply-chain fact: the registry bytes and
ECDSA signature were verified, but npm did not provide an attestation tying this
artifact to a source commit and build workflow. This is not evidence that DSH
is malicious. It is a concrete reason for a maintainer or adopter to keep the
artifact in review while checking the source release path.

The key product result is that a resolver timeout no longer ends with an empty
dependency audit. Upstream Radar returns the exact artifact digest, a usable
graph, the unresolved peer boundary, the vulnerability result, and the two
remaining review actions in one report.

This report was produced by the current branch, not the already published
`upstream-radar@0.42.0`. Review the Draft PR before relying on the fallback
resolver from npm.
