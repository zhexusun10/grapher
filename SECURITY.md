# Security Policy

## Supported Versions

Grapher is an early-preview project. Security fixes target the latest `main` revision.

## Reporting Vulnerabilities

Please report security issues privately through [GitHub Security Advisories](https://github.com/zhexusun10/grapher/security/advisories/new). Include the affected revision, impact, and reproduction steps. Avoid sharing credentials or private data.

## Security Considerations

Grapher can execute commands and modify project files, including during planning. Use trusted projects and extensions, and keep the local API private. Git isolation is not a security sandbox, and rejecting a graph does not undo earlier changes.

For details, see [Filesystem isolation](docs/architecture/filesystem-isolation.md) and the [execution model](docs/architecture/execution-model.md).