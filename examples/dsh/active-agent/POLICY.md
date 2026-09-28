# Active Agent policy

`policy.json` is the single operator-owned entry point for the active compatibility batch.
Omitting Node and execution-profile fields keeps the repository-evidence Agent recommendation authoritative.

The checked-in policy follows the `next` DSH channel and leaves every plugin environment to the Agent. Supported overrides are:

```json
{
  "schema": "upstream-radar.dsh-active-agent-policy/v1alpha1",
  "dsh": {
    "version": "0.1.7-rc.2",
    "sourceRef": "the-tag-or-commit-containing-that-exact-package-version"
  },
  "defaults": {
    "nodeMajors": [22, 24]
  },
  "plugins": [
    {
      "targetId": "context",
      "version": "0.59.0",
      "sourceRef": "the-tag-or-commit-containing-that-exact-package-version",
      "nodeMajors": [24],
      "executionProfiles": ["web"]
    }
  ]
}
```

- `dsh.channel` and `dsh.version` are mutually exclusive. An exact version requires `sourceRef` so package bytes and repository evidence cannot drift apart.
- A plugin `version` also requires `sourceRef` for the same reason.
- Per-plugin Node/profile settings override `defaults`; omitted settings still come from Agent review of README, manifests, lockfiles, CI and startup scripts.
- Changing an effective version, Node list, or profile list changes the durable task fingerprint and creates a new analysis. Reapplying the same policy stays deduplicated.
- Execution profiles are limited to `headless`, `web`, `tui`, `sdk`, and `acp`; executable Node majors are bounded to 20–40.
