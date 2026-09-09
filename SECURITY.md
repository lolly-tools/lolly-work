# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately — do not open a public issue.

- **Email:** [fitzy+security@suse.com](mailto:fitzy+security@suse.com)
- **GitHub:** private vulnerability reporting on the
  [lolly-tools](https://github.com/lolly-tools) `lolly-work` repository
  (Security → "Report a vulnerability")

Include what you can: affected component (IAM, RBAC, audit, an `api/` endpoint,
a worker), reproduction steps, and impact as you understand it. We will
acknowledge your report, keep you informed while we investigate, and credit you
in the fix notes unless you prefer otherwise. We practise coordinated
disclosure: we ask that you give us the opportunity to remediate before
publishing details.

Findings in the vendored OSS engine (`vendor/@lolly/engine`,
`vendor/@lolly-tools/core`) belong to the open-source
[lolly](https://github.com/lolly-tools/lolly) repository — same contact, and
its own `SECURITY.md` documents the engine's threat model.

## Supported versions

| Version | Supported |
|---|---|
| 0.x (`main`) | ✅ Security fixes land on `main` only |
| anything else | ❌ No other branches or tags are maintained |

The control plane is pre-1.0 and deployed from `main`; there are no maintained
release branches. Operators are expected to track `main`.

## Threat model

The control plane sits between an organisation's identity provider and the
Lolly engine: it authenticates people, decides what they may do, records what
they did, and serves rendered exports. Every claim below cites the file that
enforces it.

### What we enforce

- **Tamper-evident audit trail** — every governance-relevant action is
  appended to a hash-chained log (`server/src/audit/chain.ts`): each event's
  hash covers the previous hash plus the canonical JSON of the event body, and
  each row also carries an HMAC of that hash under a key derived from
  `LW_SESSION_SECRET` that the database never holds. An in-place edit breaks
  the chain at a detectable sequence number; a rewrite that recomputes the
  public chain still fails the MAC. On Postgres a trigger refuses `UPDATE` and
  `DELETE` on `audit_log` (migration 0034); the retention trim is the one
  delete it admits, and it writes its anchor first. Truncating the newest rows
  remains visible only through the externally logged head (`docs/audit.md`).
  Payloads carry digests and field names, never raw input values.
- **Deny-wins authorization** — RBAC evaluation
  (`server/src/rbac/evaluate.ts`) is a pure function over a fixed role set
  plus fine-grained grants, evaluated deny → allow → role default. An explicit
  deny can never be overridden by any allow or role.
- **Sealed credentials** — secrets at rest (IdP client secrets, signing
  material) are sealed with AES-256-GCM under an HKDF-derived key; password
  hashing is scrypt with a per-password salt; MAC comparison is constant-time
  (`server/src/lib/crypto.ts`). node:crypto only — no third-party crypto.
- **Domain-separated tokens** — every HMAC token carries a `typ` domain baked
  into the signed payload (`server/src/iam/tokens.ts`), so a session token can
  never be replayed as a guest token, a link signature, an OAuth state, or an
  API key. Verification checks signature, domain, and expiry, and never throws
  on malformed input.
- **Rate limiting on the unauthenticated surface** — auth endpoints, telemetry
  ingest, and the public link resolver sit behind a per-IP token-bucket
  limiter (`server/src/observability/rate-limit.ts`) with LRU-bounded memory.
- **Engine integrity** — the vendored engine is a pinned snapshot;
  `scripts/verify-engine-pin.ts` recomputes its content hashes against
  `engine-pin.json` before every test run and in CI, so a locally patched
  engine cannot ship unnoticed.

### Accepted limitations

These are documented design choices, not vulnerabilities — please check here
before reporting.

- **Stateless sessions: no per-individual-session revocation.** Session and
  guest cookies are HMAC-signed stateless tokens (`server/src/iam/sessions.ts`,
  `server/src/iam/tokens.ts`); there is no session table naming one token to
  kill early. Per **user**, sign-out-everywhere exists: disabling an account,
  or `POST /api/v1/users/:id/revoke-sessions`, bumps the user's session epoch
  and every prior token fails its next request. The residual is scoped to one
  token vs all of a user's, bounded by `policy.sessionTtlHours` (default 12h).
- **CSRF stance is `SameSite=Lax` plus a site check.** All cookies are
  `HttpOnly; SameSite=Lax` (plus `Secure` on https instances). There is no
  per-request CSRF token; a cookie-authenticated mutation is refused before
  routing when the browser reports `Sec-Fetch-Site: cross-site` or its
  `Origin` is a different site from the `Host` (`server/src/iam/csrf.ts`).
  Sign-in routes still mint a session on a GET (`/api/auth/dev`,
  `/api/auth/proxy`, the OIDC callback), so a login-CSRF - being signed in as
  an attacker's account - is not prevented; it grants the attacker nothing.
- **The dev sign-in provider is unthrottled.** `/api/auth/dev` exists for
  local evaluation and the hosted sandbox; it upserts a user and writes an
  audit row per hit and is exempt from the auth rate bucket, so it must be off
  (`dev.enabled: false`) on any instance with a real IdP. The server warns at
  boot when it is not.
- **In-process hooks are contained, not isolated.** With
  `render.allowHooksInFastPath` on, a pack's `hooks.js` runs in a `node:vm`
  context (`server/src/render/vm-hooks.ts`) that carries the render's DOM and
  the host bridge but no `process`, `require` or working `fetch`. That removes
  ambient authority; it is not a hardened sandbox, because objects from the
  outer realm are reachable through prototypes. Keep the switch off for any
  pack you do not curate and use the Chromium worker tier.
- **Anonymous automation principals are the caller's IP** in open access
  mode, so callers behind one NAT share a job namespace. Gated mode has no
  anonymous principal.
- **Authenticated paths are unthrottled by design.** The rate limiter
  classifies only the unauthenticated surface; console and API traffic from a
  signed-in principal is never throttled. Abuse by an authenticated user is an
  accountability problem (audit log + admin action), not a throttling one.

## Supply chain

`sbom.cdx.json` (CycloneDX 1.5, generated by `pnpm run sbom`) lists every
runtime npm component with its registry SRI hash; `pnpm run sbom --check`
fails CI on drift. Third-party license notices are in
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).

## Safe harbour

Good-faith security research against your own lolly-work instance is welcome.
We will not pursue action against researchers who make a good-faith effort to
respect user privacy, avoid data destruction and service disruption, and
report through the channel above. Do not test against other people's instances
or data.
