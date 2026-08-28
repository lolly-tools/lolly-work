# WebDAV / Nextcloud (kind: `webdav`)

Federate a WebDAV server **read-only** as a catalog source. The kind is the **protocol**, not a
vendor: anything that answers RFC 4918 PROPFIND federates through here. **Nextcloud** is the
primary documented flavor, because it is the open, self-hostable, sovereign option and it is the
one most deploys already run; ownCloud, Apache `mod_dav`, Sabre/DAV and any other RFC 4918
server ride the same kind through `flavor: "generic"`.

Zero-dep, like every driver here: HTTP Basic (or a bearer token) over `fetch`, and the 207
multistatus body is read by a small parser written for that one layout. No SDK, no XML library.

## What you need from the server

### Nextcloud (the primary path)

1. **A dedicated read-only account.** Make one (`lolly-federation` is a fine name) rather than
   reusing a person's. Give it read access to what you want federated: share the folder or the
   Group folder with it as **"Read only"**, or put the files in its own Files tree. A share shows
   up in that account's Files root under the share name, which is what `options.root` then points
   at. No write, create, delete or reshare permission is needed.
2. **An app password for that account**, generated under
   **Settings > Security > Devices and sessions > Create new app password**. Nextcloud shows the
   generated password once - copy it then. Never use the account password: an account with 2FA on
   rejects it at the DAV endpoint outright, and an app password can be revoked on its own without
   touching the account or any other integration.
3. **The account's LOGIN name.** The DAV path carries the login, which can differ from the display
   name (Settings > Personal info shows both, and it is the last path segment when that account
   opens Files). That is `options.username`; it defaults to the username half of the credential.
4. **The server root** as `options.baseUrl`, e.g. `https://cloud.example`. If Nextcloud is served
   under a subpath, include it: `https://example.org/nextcloud`. The driver builds the files root
   as `<baseUrl>/remote.php/dav/files/<username>/<root>` and pins every request to that host.

### Generic WebDAV (ownCloud, Apache mod_dav, any RFC 4918 server)

- **The URL your server mounts DAV at**, as `options.baseUrl` - `https://dav.example/store` for an
  Apache `Alias` with `Dav On`, `https://cloud.example/remote.php/dav/files/<login>` for ownCloud
  (its files path is Nextcloud's, so give the whole thing as the base and leave `flavor` generic).
  The driver appends `options.root` and nothing else.
- **A read-only account**, over HTTP Basic. Point it at a read-only mount, or give the account no
  write permission; the driver issues only `PROPFIND` and `GET`.
- **That `PROPFIND` with `Depth: 1` reaches the server.** A reverse proxy in front of it often
  passes `GET` and drops every other method, which reads as a `405` on the first health check.
- **HTTPS.** The credential is HTTP Basic, so a plaintext hop hands the password to the network.

## Credential shape

One string, the username and the password joined by a colon - the `s3` precedent:

```
"<username>:<app password>"
```

For Nextcloud that password **must be the app password** from Settings > Security, never the
account password. A server fronted by a token-issuing proxy can use the bearer form instead:

```
"bearer:<token>"
```

No OAuth flow is invented for this kind: those two forms are all the driver parses, and anything
else fails closed before a single request leaves.

```bash
lw providers credential acme-nextcloud   # hidden prompt; never argv, never shell history
```

Credentials are **write-only** here: sealed at rest, and only a fingerprint is ever read back.
Rotating one is another `lw providers credential` - revoke the old app password in Nextcloud
afterwards.

## instance.json / `lw providers add`

Nextcloud:

```json
{
  "id": "acme-nextcloud",
  "kind": "webdav",
  "label": "Acme Nextcloud",
  "options": { "baseUrl": "https://cloud.example", "flavor": "nextcloud", "username": "lolly-federation", "root": "Brand", "recursive": true },
  "exposure": { "groups": ["design"], "tier": "reference" }
}
```

Generic WebDAV:

```json
{
  "id": "acme-dav",
  "kind": "webdav",
  "label": "Acme file server",
  "options": { "baseUrl": "https://dav.example/store", "flavor": "generic", "root": "brand", "recursive": true, "minGapMs": 500 },
  "exposure": { "groups": ["marketing"] }
}
```

- **`options.baseUrl`** (required) - parsed at configuration time, and its host is the pin:
  request URLs are built from it, an `<href>` naming another host is refused, and redirects are
  never followed (a `3xx` is an error naming its target).
- **`options.flavor`** - `"nextcloud"` or `"generic"` (default). It picks the URL template and
  whether Nextcloud's `oc:tags` property is requested. Everything else is plain WebDAV either way.
- **`options.username`** - the Nextcloud login the DAV path carries. Defaults to the username half
  of the credential; set it when the login differs, and set it outright when the credential is a
  bearer token, since that form carries no username.
- **`options.root`** - federate only this subpath of the files root. Leading and trailing slashes
  are tolerated. This is the scoping control: point it at the shared folder rather than federating
  someone's whole Files tree.
- **`options.recursive`** - walk subdirectories (default `false`, one directory only). Each
  directory level below the root becomes a **section**, so `exposure.includeSections` and section
  tags work on the folder structure you already have.
- **`options.minGapMs`** - minimum gap between calls to this provider, default `250` (about 4
  requests a second). WebDAV publishes no rate limit, so that default is deliberate caution rather
  than a documented ceiling; raise it for a small self-hosted box.
- **`mapping.availabilityFields`** applies only if your server exposes a **custom DAV property**
  carrying a date; naming it imports an
  [availability window](../catalog.md#imported-availability-windows). Give the **local** name
  with the namespace prefix dropped (`embargo-until`, not `x:embargo-until`). Setting it
  switches the `PROPFIND` to `<d:allprop/>` so the custom property is actually returned
  (RFC 4918 section 9.1) - the more expensive call, which is why it is opt-in.

## Verify

```bash
lw providers preview --kind webdav --options '{"baseUrl":"https://cloud.example","flavor":"nextcloud","username":"lolly-federation","root":"Brand"}'
lw providers credential acme-nextcloud
lw providers health acme-nextcloud
```

`preview` builds a throwaway provider record, asks the server, and discards it: nothing is
created, stored or enabled, so a wrong option costs a retry. `health` runs a `PROPFIND` with
`Depth: 0` against the files root, which is the cheapest call that proves both the URL template
and the credential.

| Symptom | What it means |
|---|---|
| `webdav propfind 401 - the server rejected the credential` | Wrong login, wrong password, or the **account** password where an app password is required. |
| `webdav propfind 403 - the server rejected the credential` | The credential parsed and the server refused it for this path. Usually that account may not read the folder: check the share in the Nextcloud UI. |
| `webdav propfind 404 for /remote.php/dav/files/…` | The files root is wrong: usually `options.username` is the display name rather than the login, or `options.root` names a folder that account cannot see. |
| `webdav propfind 405 for /…` | The server, or a proxy in front of it, does not allow `PROPFIND`. |
| `webdav propfind 301 for /… - the server redirected, sending it to …` | The server wants a different URL, usually the trailing slash on a collection or an `options.baseUrl` that is one hop off. The driver refuses every redirect, on either method, so it never streams another origin's bytes as your asset. |
| `webdav credential must be "<username>:<password>" …` | The sealed string is neither documented form. Nothing was fetched. |
| `none of the N resource(s) PROPFIND returned sit under the files root this driver built` | The server answered, but names its resources by a different path - a proxy rewriting the prefix, or the wrong login. |

To see what your server actually carries, property names and value types only, never values. This
one asks with `<d:propname/>`, so it reports every property your server holds rather than only the
five the driver names:

```bash
lw providers preview --kind webdav --shape --options '{"baseUrl":"https://cloud.example","flavor":"nextcloud","username":"lolly-federation"}'
```

Run the [WebDAV live-verify runbook](webdav-live-verify.md) against a real server before you
commit to this kind: it is the ordered pass that confirms every assumption below and names the
constant to edit when one is wrong.

## Notes / limits

- **This driver is fixture-verified only.** Its URL templates, property names and the multistatus
  layout it reads come from RFC 4918 and Nextcloud's public documentation, and have not been
  confirmed against a running server by this repo. Nothing here is verified live. The open items
  are the `LIVE-VERIFY` block in `server/src/catalog/providers/webdav.ts` and the
  [runbook](webdav-live-verify.md); read the first sync as the verification and report anything
  that does not match.
- **No server-side search, no thumbnails, no expiring URLs.** WebDAV has no search this driver
  relies on (Nextcloud's SEARCH method is deliberately not built until one server confirms it),
  no rendition endpoint, and bytes stream through the driver per request rather than through a
  signed URL, so nothing expires.
- **No availability window.** A WebDAV file has a size, a modification stamp and a content
  type, and nothing that says when it may be published: the manual `catalog.expire` arm is the
  whole story unless a custom property is named in `mapping.availabilityFields` (above).
- **A rename federates as a new asset.** The federated id is the file's path relative to the files
  root, so moving or renaming a file upstream produces a new one downstream. Nextcloud's
  `oc:fileid` would survive a rename but cannot address bytes, so it is deliberately not requested.
- **The recursive walk is bounded.** At most 500 directories per walk (`MAX_DIRS`), and a single
  sync stops after 50 pages, one page being one directory - the smaller bound wins. Hitting either
  is reported as an operator note on the sync, never as silence. Narrow `options.root` rather than
  federating a whole home directory.
- **Directories become sections, never assets.** Each level of the path below the root is one
  section, which is what `exposure.includeSections` scopes on.
- Supports the **exit** (materialize then cutover): bytes stream per request, so a federated file
  can be pinned into this instance's own [BlobStore](../catalog.md#where-instance-bytes-live) and
  checksummed like any other source. This is a storage source you run yourself rather than a DAM
  held under someone else's contract, so it carries no vendor off-boarding story - it is far more
  often the destination of an exit than the start of one. See
  [off-boarding](../offboarding.md#exit-readiness-by-kind).
- Does **not** accept published exports.

See also: [catalog](../catalog.md) · [permissions](../permissions.md) ·
[the live-verify runbook](webdav-live-verify.md).
