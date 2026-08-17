# Pi Automation Sandbox

`scripts/start-pi-automation-sandbox.sh` starts an isolated Linux-host test stack
for the automatic Pi drafting pipeline. It is for checking real Pi model behavior
while Plastic Promise is unavailable; it is not a production fallback.

The launcher has these fixed boundaries:

- Linux only, non-root deploy user only, and no Docker workload on the development workstation;
- binds its Web, API, MCP, and simulator ports to server loopback only;
- generates a separate database, identities, tokens, and session secret;
- copies only the configured Pi provider, model, protocol settings, and API key
  from `/srv/geo-saas/secrets/geo.env` into a separate mode-`0600` sandbox env file;
- reuses only the credential-free HTTPS `NPM_REGISTRY` value for the server build;
- uses `customer_demo` and `demo_fixture`, with real Pi enabled by the narrowly
  scoped `GEO_ALLOW_REAL_PI_IN_DEMO=true` flag;
- uses the Ctrip simulator and the Producer's fixed `dry_run` execution level.
- disables image generation and copies the production-selected licensed-search
  provider (`wikimedia_commons` or `pexels`); Pexels requires its separate sandbox
  copy of the server-side key, and every downloaded candidate still passes live Pi visual inspection.
- initializes the sandbox-only evidence and media volumes for the API's fixed UID
  through a networkless, capability-limited one-shot container before startup.

It never starts the production overlay, production edge, Browser Host, or a live
Ctrip session. Its only publishing-related outbound media access is the configured
fixed-host licensed search/download flow. The simulator has no Ctrip network access
and cannot create a live article.

`compose.pi-automation-sandbox.yaml` replaces the production-only configuration
preflight only for this stack. It validates the full sandbox service environment
and is never included by `start-production.sh`.

Run it only on `geo-production-host` from an immutable release:

```bash
/srv/geo-saas/app/current/scripts/start-pi-automation-sandbox.sh
```

Open the resulting loopback URL through an SSH tunnel. Use the seeded sandbox
tenant to create a batch, then inspect the Producer health, Pi trace, generated
draft, audit receipt, and simulator preview. Do not treat a sandbox result as
publication evidence or use it to authorize the production Ctrip account.
