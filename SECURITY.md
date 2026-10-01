# Security policy

## Supported versions

Grapher is early preview software. Security fixes target the latest `main` revision; older snapshots have no separate maintenance commitment.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/zhexusun10/grapher/security/advisories/new). Include the affected revision and platform, impact, and minimal reproduction in a disposable project. Do not disclose vulnerabilities in public issues or pull requests before coordinated disclosure.

Never include real API keys, provider auth files, private source code, or unredacted runtime databases. There is no guaranteed response time or bug bounty.

## Trust boundaries

- Use only trusted projects, extensions, and tools. Agents can execute commands; model requests go to your configured provider.
- Independent Git repositories provide version isolation, not a security boundary. Windows workspaces are not filesystem sandboxes.
- Keep the local API on loopback. Origin restrictions are not authentication; do not expose it to untrusted clients.
- Planning and snapshots can change or commit project files before graph approval. Rejecting a graph is not rollback.

Read [Filesystem isolation](docs/architecture/filesystem-isolation.md) and the [execution model](docs/architecture/execution-model.md) before working on sensitive projects.
