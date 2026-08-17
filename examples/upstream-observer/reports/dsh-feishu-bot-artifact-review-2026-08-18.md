# Real DSH plugin: upstream change plus exact artifact review

This is the current-source replay of the public
[`PlutoKeating/dsh-lark-bot`](https://github.com/PlutoKeating/dsh-lark-bot) case.
It uses the source commit transition `43f0e65` → `c2f8cf7` and the currently
published `dsh-feishu-bot@0.15.8`. No DSH LLM was configured or called.

## Result

```text
Source: 43f0e65... → c2f8cf7...
Graph: 242 nodes, 378 edges, 7 unresolved → 242 nodes, 380 edges, 7 unresolved
Added runtime edges:
  dsh-lark-bot@<root> -> @deepseek-ai/cordis@4.0.1
  dsh-lark-bot@<root> -> @deepseek-ai/dsh-tools@0.1.0-rc.6
DSH task: upstream-task-c6134ba72fae177456a80d27

Exact artifact review: REVIEW (risk REVIEW; coverage INCOMPLETE)
Artifact authenticity: integrity verified; npm signature verified; provenance verified
Artifact dependency audit: findings; 89 packages; known vulnerabilities: 0; unresolved: 12
Artifact resolution: strict
Artifact install scripts: protobufjs@7.6.5 postinstall: node scripts/postinstall
Artifact finding: [HIGH] dependency-install-script-present
DSH Agent: not configured; meaningful tasks remain pending
```

## What this proves

The observer now closes the deterministic part of the loop in one scheduled
run:

1. Read the old and new DSH source commits and their committed dependency graph.
2. Detect the two newly added DSH runtime dependency edges.
3. Resolve the exact currently published npm artifact in a temporary review
   directory with lifecycle scripts disabled.
4. Preserve the artifact's integrity, registry signature, provenance, package
   count, unresolved edges, install script and author-facing finding in the
   pending task.
5. Leave the optional DSH/model step pending because no DSH LLM is configured.

The exact artifact had zero reported known vulnerabilities in this run. It is
still `REVIEW`, because a reachable dependency declares an install-time script
and 12 artifact graph edges remain unresolved. That is an actionable author
question, not a claim that the plugin is malicious or vulnerable.
