## What the package does

It installs the Lolly Work control plane (a Node 24 service on a local port, behind the domain's nginx) with a PostgreSQL database, and the prebuilt Lolly web app the server serves at `/`. The server's configuration is `instance.json` in the install directory, its secrets are in `.env` beside it, and the instance pack (brand, tools, catalog) lives in the data directory. The full documentation the server ships is at `/admin#/docs` on your instance.

## Sign-in and roles

There is no separate login. A member opens the app, the YunoHost portal signs them in, and SSOwat hands the identity to the server, which mints its own session. Roles come from YunoHost:

| YunoHost | Lolly Work |
|---|---|
| permission `lolly-work.owner` | owner: instance settings, brand sources, everything |
| permission `lolly-work.admin` (the `admins` group by default) | admin |
| permission `lolly-work.approver` | approver |
| permission `lolly-work.author` | author |
| every other member of the app | member |
| YunoHost groups | Lolly Work groups, for tool overlays, approval chains and grants |

Change roles in **Users › Groups and permissions**; the change applies at the next sign-in. The `main` permission decides who may open the app at all; the `api` permission stays public because the API, share links and render links authenticate themselves (session, service token or signed link), and the `sso` permission is the sign-in endpoint, never openable to visitors.

## The brand

The instance starts with the neutral starter brand and the full community tool set, copied from the web app into `<data dir>/pack`. To use your own brand: import design tokens from the console, or replace that directory with your own pack (the same `tools/` and `catalog/` layout the Lolly repository builds) and restart the service. An upgrade never touches the pack once it exists.

## Config panel

Instance name, access mode (gated, per-tool, open), guest edit links, telemetry level, and whether tool hooks run in the server's in-process renderer. Each change rewrites `instance.json` and restarts the service. Finer governance (which groups see which tools, locked inputs, approval chains, brand sources, deliveries) is in the console.

## Running it

- Service: `lolly-work` (`yunohost service status lolly-work`, log in `/var/log/lolly-work/`).
- Database migrations apply when the service starts after an upgrade.
- `curl https://<domain>/healthz` answers with the instance name and access mode.
- Backups include the install directory (with `node_modules`), the pack and the database; restore reinstalls the service.

## Security notes

The identity headers SSOwat sets are only believed when the request also carries a shared secret that this domain's nginx configuration injects, so a local process that reaches the server's port cannot sign in as someone else. The web app is served with the same Content-Security-Policy as lolly.tools; the control plane's own pages send their own stricter policies, which the nginx configuration passes through.
