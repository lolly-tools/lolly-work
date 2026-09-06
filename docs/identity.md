# Identity and sessions

Two principals, two cookies, two token domains. Everything is a signed, stateless token - 
there is no session table.

![The People directory - every signed-in member with role, groups and instant lockout](shots/people-directory.svg)

| Principal | Cookie | Comes from | Lives |
|---|---|---|---|
| Member | `lw_session` | OIDC sign-in, reverse-proxy sign-in, or the dev provider | `policy.sessionTtlHours` (default 12h) |
| Guest | `lw_guest` | admission through a guest-edit link | the remaining lifetime of that link |

Cookies are `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` whenever `instance.baseUrl`
is https. A member session wins when both cookies are present. Every token carries a `typ`
domain in its signed payload, so a session token can never be replayed as a guest token, a
link signature or an OAuth state.

## OIDC SSO

Provider-agnostic by construction - nothing in the code knows your IdP. Set:

```json
"idp": {
  "issuer": "https://id.example.com/realms/main",
  "clientId": "lolly-work",
  "displayName": "Keycloak",
  "groupsClaim": "groups",
  "claimMap": { "firstname": "given_name", "lastname": "family_name", "email": "email", "title": "title" }
}
```

The flow is discovery → Authorization Code + PKCE (S256) → `id_token` verified against the
provider JWKS (RS256 via WebCrypto) **before any claim is believed**. Verified claims fill
the org user record through `claimMap`.

- Redirect URI: `<instance.baseUrl>/api/auth/callback`. `baseUrl` must match the URL the
  deploy actually answers on.
- `LW_IDP_CLIENT_SECRET` only if your IdP issues a confidential client.
- `displayName` is what the sign-in button and "managed by …" copy say. Any compliant
  issuer works; open and sovereign providers are first-class.

Routes: `GET /api/auth/config` (what the sign-in screen needs), `GET /api/auth/login`,
`GET /api/auth/callback`, `GET /api/auth/session`, `POST /api/auth/logout`.

### More than one IdP

A migration in flight, or a subsidiary on its own house: `idp.additional` lists further
issuers beside the primary (plans/36) -

```json
"idp": {
  "issuer": "https://id.example.com/realms/main", "clientId": "lolly-work", "displayName": "Example ID",
  "additional": [{
    "id": "subsidiary", "issuer": "https://login.subsidiary.example", "clientId": "lolly",
    "displayName": "Subsidiary SSO", "groupsClaim": "roles", "clientSecretRef": "LW_IDP_SECRET_SUBSIDIARY"
  }]
}
```

Each entry carries its own client, display name, and (optionally) its own `groupsClaim`
and `claimMap` - unset ones inherit the primary's. A confidential secret rides the env
var `clientSecretRef` names; omit it for a public/PKCE client. With several houses
configured, plain `/api/auth/login` serves a script-free **chooser page**, so every
existing sign-in link (the console gate, the OSS shell's gate) grows the buttons with no
client change; `?idp=<id>` picks one directly, and `/api/auth/config` +
`GET /api/v1/instance` list `providers` for clients that render their own. The IdP that
STARTS a flow finishes it - the id rides the signed state token - and an additional
house's subs are stored namespaced (`<id>:<sub>`), so two issuers handing out the same
bare sub can never collide into one row. The primary's subs stay raw: existing rows and
the SCIM `externalId` linkage are untouched.

## The dev provider

`dev.enabled: true` plus a `dev.users` list enables `GET /api/auth/dev?email=…`: a
passwordless local sign-in for development, demos and tests. It bypasses OIDC entirely - 
keep it off in production. The Helm values ship it disabled.

## Reverse-proxy sign-in

Some hosts already authenticate every request before it reaches the instance: YunoHost's
SSOwat, Authelia, oauth2-proxy, an enterprise gateway. `proxyAuth` lets that proxy be the
identity provider. It states who the person is in request headers, and
`GET /api/auth/proxy?returnTo=…` turns those headers into an ordinary member session - the
same cookie, the same role derivation, the same audit row (`auth.login` with
`provider: "proxy"`) as OIDC. Members get the sub `proxy:<login>`.

```json
"proxyAuth": {
  "enabled": true,
  "displayName": "YunoHost",
  "secretRef": "LW_PROXY_AUTH_SECRET",
  "headers": { "user": "ynh_user", "email": "ynh_user_email", "name": "ynh_user_fullname", "groups": "" },
  "groups": { "andy": ["owner"] },
  "directory": {
    "url": "ldap://127.0.0.1:389",
    "userDn": "uid={user},ou=users,dc=yunohost,dc=org",
    "groupMap": [
      { "attribute": "memberOf",   "pattern": "^cn=([^,]+),ou=groups,dc=yunohost,dc=org$" },
      { "attribute": "permission", "pattern": "^cn=lolly-work\\.(owner|admin|approver|author),ou=permission,dc=yunohost,dc=org$" }
    ]
  }
}
```

**The header contract.** `headers.user` is the only required header: the stable login the
proxy asserts. `email` and `name` fill the member record when present, `groups` is a
comma-separated list when the proxy sends one (Authelia's `Remote-Groups`). Names are
matched case-insensitively, so `YNH_USER` and `Remote-User` both work as written. The
defaults are the three headers SSOwat sets: `YNH_USER`, `YNH_USER_EMAIL`,
`YNH_USER_FULLNAME`. For Authelia set `remote-user` / `remote-email` / `remote-name` /
`remote-groups`; for oauth2-proxy `x-forwarded-user` / `x-forwarded-email`.

**The shared secret.** The proxy must add one more header, `x-lw-proxy-auth`, carrying the
value of the environment variable `secretRef` names (`LW_PROXY_AUTH_SECRET` by default).
A request without it, or with the wrong value, is refused with `403 PROXY_SECRET_MISMATCH`
and an `auth.proxy.rejected` audit row; the presented value is never recorded. This is what
stops a process on the same host from reaching the instance port directly and naming
itself an owner: only the proxy knows the secret, and it injects the header on every request
it forwards. In production the variable is required whenever the provider is enabled; the
server refuses to boot without it.

**Static grants.** `groups` maps a login to groups that are unioned in at every sign-in -
the way a deployment gives its first owner the `owner` group before any directory or group
header exists. It follows the same rule as everything else here: role is derived from
groups, never assigned.

**The directory.** An optional LDAP read, once per sign-in, of the person's own entry.
`userDn` is a template; `{user}` is replaced with the login, escaped per RFC 4514 so a login
can never break out of its own RDN. `attributes` (defaults `mail`, `givenName`, `sn`, `cn`)
fill whatever the headers left blank, and `groupMap` turns attribute values into groups:
every value of `attribute` that matches `pattern` contributes its first capture group. The
bind is anonymous unless `bindDn` is set; the bind password rides the env var
`bindPasswordRef` names. Groups from the headers, the directory and the static grants are
unioned, and a group named after the login itself is dropped (YunoHost gives every account a
primary group of its own name). The directory is fail-closed: configured but not answering
means `502 DIRECTORY_UNAVAILABLE` and no session, never a session with fewer groups than the
person holds. The client is `server/src/iam/ldap.ts`, plain `ldap://` over TCP, meant for
the loopback of the host that owns the directory.

**YunoHost, worked through.** SSOwat authenticates against the portal, strips any `ynh_*`
header and any `Authorization: Basic` a client sent, then sets `YNH_USER`, `YNH_USER_EMAIL`
and `YNH_USER_FULLNAME` for a signed-in user. Each user's LDAP entry carries `memberOf`
(YunoHost groups) and `permission` (the app permissions the user holds), which the two
`groupMap` rules above turn into groups: a YunoHost group `marketing` becomes the
lolly-work group `marketing`, and the app permissions `lolly-work.owner` / `.admin` /
`.approver` / `.author` become the role groups. Roles are therefore managed in YunoHost's
own Users → Groups and permissions screen, and take effect at the next sign-in. The
YunoHost package sets all of this up, including the nginx line that injects the secret.

**Security posture.** Never enable `proxyAuth` unless both hold: the proxy strips every
client-supplied identity header before adding its own, and the proxy is the only thing
that knows the shared secret. With either missing, anyone who can reach the port can be
anyone. The route rides the auth rate-limit bucket, and `POST /api/auth/logout` clears the
instance session only - the proxy's own session is the proxy's to end.

## Device-code sign-in

A device that cannot run the browser flow - the CLI, a native shell against a gated
instance - signs in by code (plans/34): it asks `POST /api/v1/auth/device` for a short
code, the person opens `/activate` in any browser where they are already signed in and
confirms it, and the device's next poll collects an ordinary session cookie minted for
that person. The approving browser session is the whole authority - the flow never
touches IdP credentials, works identically over OIDC and the dev provider, and the
mint re-checks disable/revocation so an account closed mid-flow gets nothing. Codes
live ten minutes, are single-use, and pending ones are listable (and deniable, never
approvable) in the console's Fleet view. Codes are database rows (plans/35), so any
replica answers the poll - HA needs no sticky sessions, and serverless deploys have
the flow too.

## Groups → role

Groups arrive from the IdP claim named by `groupsClaim`. The console can add **local
groups** on top, for organizational structure your IdP does not model:

```
GET/POST /api/v1/groups              # list / create a local group
DELETE   /api/v1/groups/:name
PUT      /api/v1/users/:id/local-groups
```

The effective group set is the union (IdP ∪ local), and role is derived from it: the
highest of `owner`, `admin`, `approver`, `author` present, otherwise `member`. A local
group named after a role escalates exactly like an IdP one - which is deliberate, and why
group editing is an admin action and audited.

Group membership is also how governance targets people: overlay visibility, approval-chain
eligibility, provider exposure, and grant principals (`group:<name>`) all read groups.
See [permissions](permissions.md).

## SCIM provisioning

An IdP can push user lifecycle over SCIM 2.0 at `/scim/v2`, so joiners, movers and leavers
are provisioned without a console visit. Supported: Users (create, patch, `active=false`)
and Group membership; passwords, bulk, sort and ETags are declared unsupported in
`GET /scim/v2/ServiceProviderConfig`.

SCIM is **another writer of the one identity model**, never a second one:

- a SCIM **User** is a `UserRecord`. Its `externalId` is the `sub` OIDC login also keys on,
  so a person the IdP provisions and the same person signing in resolve to **one row** - and
  the groups SCIM set survive that sign-in, because they land in `localGroups` (durable),
  not the IdP-authoritative `idpGroups` (re-synced on login).
- a SCIM **Group** is a local group. Membership is stored per-user (`localGroups`), so a
  Group `PATCH` becomes a set of per-user edits - the same `localGroups` the console writes.
- `active=false` is the deprovision: it flips the disabled flag **and** bumps the session
  epoch, exactly as the console disable does (below), so every live session dies at once.

The connector authenticates with a bearer token, one per IdP, minted by an **owner**
(`scim.manage`) and shown once:

```
POST   /api/v1/scim/tokens     { "idp": "keycloak" }   # returns the secret ONCE
GET    /api/v1/scim/tokens                              # metadata only - never the secret or its hash
DELETE /api/v1/scim/tokens/:id                          # revoke
```

The secret is stored only as its sha256, so a leaked database yields hashes, not usable
tokens. **SAML is not implemented**, and does not need to be: Keycloak (which id.suse.com
runs) bridges a SAML-only IdP to the OIDC this already speaks.

## Service tokens

Automation identity (plans/35): CI running `lw export`/`lw apply`, a
governance-drift check, an audit poller - no more session cookies in secret
stores. A token is minted by an owner (`lw tokens create --label ci --role
admin`), shown once, stored as a hash, and revoked with one command; presenting
it resolves to a synthetic principal with the token's role and no groups, so
the RBAC evaluator, grants and the audit trail treat it exactly like a person -
there is no second authorization model. Tokens work on the action-gated
API and are refused on the member-workflow routes (approvals, submissions,
collab): those flows mean "a person decided". Authenticate the CLI with
`LW_TOKEN=<token>` or `--token`.

## Offboarding, disable and revocation

```
POST /api/v1/users/:id/disabled     # { disabled: true }   (or SCIM active=false)
```

Disable is **instant and it revokes**: `resolveMember` rejects a disabled account on every
request, and disabling also bumps the user's **session epoch** - a counter each session
token embeds at mint, so a token minted before the bump is refused from that moment. Every
live session of the disabled person therefore dies on its next request; there is no window
to ride out. SCIM `active=false` (above) composes exactly this. Two further notes:

- Revocation is **per user, not per session**: the epoch kills all of a person's sessions at
  once (there is no list of individual sessions to revoke one of). `bumpSessionEpoch` is the
  same lever for a "sign everyone-of-this-person out" without disabling them.
- A group or role change is **immediate for API authorization**: `requireAction` resolves
  the live user record on every request and ignores the role baked into the cookie. What
  waits for the next token mint is only the role the shell's own token *claims*; lowering
  `policy.sessionTtlHours` shortens that window.

## Guest sessions

A guest-edit link admits someone with no account: `GET /l/:id?s=…` mints an `lw_guest`
cookie scoped to that link's tool (and session, if the link names one), for whatever
remains of the link's lifetime. Guests carry the `guest` role, which grants **nothing** by
default - their access is entirely link-scoped. Links can carry a password (scrypt-hashed),
and `policy.guestLinks.maxTtlHours` caps the lifetime regardless of what the minting UI
asks for. `guestLinks.enabled: false` refuses minting outright.

See [sharing](sharing.md) for the link lifecycle and [permissions](permissions.md) for
what a guest can be granted.

## What a shell sees

Once signed in, a connected shell polls one document - `GET /api/v1/org-config` - carrying
identity, role, permissions, tool and input governance, managed profile fields and feature
flags, pre-filtered for that caller's groups and ETag'd on a policy version. Profile fields
sourced from the IdP come back `mode: locked, source: idp`, which is what renders the
padlocks in the shell's profile view. To check what any group combination would receive,
without impersonating anyone: `GET /api/v1/org-config/preview?groups=…`, the console's
Preview view, or `lw preview --groups a,b`.
