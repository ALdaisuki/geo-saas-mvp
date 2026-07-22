# Ctrip Host Supervision Plan

1. Add a tenant-authenticated operational readiness probe distinct from liveness and live-canary approval.
2. Add a Windows host supervisor that restores Docker, dedicated Edge CDP and the bridge in dependency order.
3. Separate the Docker-facing CDP proxy port from the local Edge debug port and restrict its firewall source range.
4. Install the supervisor as a single-instance highest-privilege logon task from the one-click Ctrip connector.
5. Add bridge unit tests, launcher contract tests and live recovery verification without creating a new publication.
