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

## Nextcloud on the same server

Install and upgrade look for a Nextcloud app (`yunohost app list`) and prefill its address in **Configuration > Nextcloud**. The connection is never switched on for you, because it needs an app password only you can create:

1. In Nextcloud, create a dedicated account, for example `lolly-federation`, and share the brand folder with it read-only.
2. As that account, create an app password under **Settings > Security**. Never use the account password.
3. In the Lolly Work configuration panel, turn on **Connect Nextcloud** and fill in the address, the login name, the app password, the brand folder to read and, optionally, an existing writable delivery folder.

Applying the panel adds a WebDAV catalog source and a WebDAV delivery destination, both named Nextcloud, to `instance.json`. They are config-managed, so the console shows them read-only; change them here. The delivery destination is limited to the `admins` group by default. The app password lives in the app settings and in `.env`, and reaches the server only as the `LW_PROVIDER_NEXTCLOUD` and `LW_DESTINATION_NEXTCLOUD` environment variables. The panel adds the Nextcloud origin to the providers' allowed private origins, because a Nextcloud on this host resolves to a private address.

Lolly Work takes a whole domain, so the Nextcloud is on another domain or subdomain of this server. The server talks to it directly. The WebDAV connection that the Lolly web app can make from the browser is separate: it is cross-origin from this domain and needs CORS on the Nextcloud and a matching entry in the page's content policy.

## On-device AI

On-device AI features are off: this package's `instance.json` does not allow any, and an upgrade rewrites that file. Turning them on takes `policy.ai` in `instance.json` (the capabilities you allow) and **Managed AI** in the console. The tools then fetch their models from `https://lolli.li`, the Lolly project's release host, through this server. The models are under free licences except the singing voices of the `sing` capability: one is under the OpenRAIL-M licence, which restricts some uses, and the voice models state no licence. Leave `sing` out unless you have checked those terms.

## Running it

- Service: `lolly-work` (`yunohost service status lolly-work`, log in `/var/log/lolly-work/`).
- Database migrations apply when the service starts after an upgrade.
- `curl https://<domain>/healthz` answers with the instance name and access mode.
- Backups include the install directory (with `node_modules`), the pack and the database; restore reinstalls the service.

## Security notes

The identity headers SSOwat sets are only believed when the request also carries a shared secret that this domain's nginx configuration injects, so a local process that reaches the server's port cannot sign in as someone else. The web app is served with the same Content-Security-Policy as lolly.tools; the control plane's own pages send their own stricter policies, which the nginx configuration passes through.
