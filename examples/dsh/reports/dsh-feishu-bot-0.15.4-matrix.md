# `dsh-feishu-bot@0.15.4` DSH compatibility matrix

Run date: 2026-08-18

Artifact: `dsh-feishu-bot@0.15.4`

Artifact SHA-256:
`85b2bae60efd1fa7878c0abd7e1bbcfff09860dcf2f4514a73a365d0617f64b7`

## Result

| DSH version | Artifact | Profile | Install | Registration | Load | Result |
| --- | --- | --- | --- | --- | --- | --- |
| `0.1.0-rc.6` | pass | pass | pass | pass | pass | compatible |
| `0.1.0-rc.7` | pass | pass | pass | pass | pass | compatible |

Summary: **2 compatible, 0 incompatible, 0 unknown**.

The test used a disposable DSH profile and `npm_config_ignore_scripts=true`.
It checked the exact artifact, profile registration, and DSH configuration load;
it did not run plugin business actions, call a model, or prove package safety.

This is a healthy compatibility baseline, not a security certificate. The same
artifact still needs dependency-vulnerability monitoring and DSH host-version
monitoring after admission.
