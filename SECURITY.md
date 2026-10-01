# Security

Report vulnerabilities privately to security@sillo.build or via GitHub Security Advisories on
`sillohq/agent`. Please do not open public issues for them.

`sillo-agent` writes only inside the skill directories and instruction files it manages, records
every file it owns in a manifest, refuses to follow symlinks out of those directories, never
overwrites edited files without `--force`, makes no network requests, and sends no telemetry.
