# Security policy

Upstream Radar is security-sensitive software. Please avoid publishing exploit details for a vulnerability that could cause it to miss, misroute, erase, or unsafely analyze an upstream security event.

Report vulnerabilities through GitHub's **Security → Report a vulnerability** flow. Do not open a public issue containing exploit details, secrets, proprietary source, or sensitive paths.

## High-priority report scope

- a known affected exact package version is not matched because of graph or source parsing;
- paths from one plugin/project are attributed to another;
- advisory or release text escapes its data boundary and becomes DSH Agent instruction;
- a pending event is deleted before a DSH Agent accepts it;
- malformed state is silently reset, hiding active alerts;
- unchanged events produce an unbounded alert or model-call loop;
- a compatibility heuristic is promoted to a confirmed break without evidence;
- target package code executes during graph or static collection;
- target package code escapes the explicit install-observation container, receives a repository/model secret, or persists onto another plugin's worker;
- archive/path/symlink escape in the supporting scanner;
- credentials, proprietary source, or local paths leak into an unintended report or destination;
- configured bounds can be bypassed to exhaust disk, memory, network, or model quota.

## Claims

An exact OSV result and dependency path establish that an installed package version is reported as affected. They do not prove that the vulnerable behavior is reachable in a particular project.

A compatibility signal establishes a manifest/version difference or definite range exclusion. It does not prove that every project will fail after upgrading.

DSH Agent analysis is model-generated reasoning. It must cite project evidence and preserve uncertainty; it is not a replacement for deterministic matching or tests.

Deep npm collection remains static: it runs in a fresh temporary project with lifecycle scripts disabled, a scrubbed environment, and controlled npm/Git configuration.

The separately named `probe dsh-install` path intentionally executes package
and load code. Its supported workflow gives each target a fresh GitHub-hosted
VM plus a restricted container, passes no model/repository secret into that
container, and binds evidence to one exact tarball. This is bounded behavior
evidence, not a hardened malware-analysis claim: the container shares the VM
kernel and same-container trace/output evidence is not tamper-proof.
