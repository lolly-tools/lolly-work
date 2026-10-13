# OIDC hardening implementation

Status: implemented and locally verified, 2026-10-13.

Canonical cross-repository plan: `lolly/plans/oidc-hardening-2026-10-13.md` on branch `fix/oidc-hardening-20261013`.

Work scope: maintained JWT verification, discovery validation, client authentication options, optional assurance policy, IdP logout and back-channel logout, linked-identity standing enforcement, regression tests and operator documentation. The agreed policy decisions are recorded below and in the canonical plan.

Source changes are isolated in this worktree. Production deployment is outside this implementation step.


## Governance decisions

The user chose local sign-out by default, with an explicit provider sign-out action;
a 30-day linked-identity standing window backed by SCIM/admin revocation; optional
per-provider assurance requirements; and back-channel logout limited to the named
IdP session. Session-specific logout requires the provider to include `sid` in both
ID and logout tokens. Subject-only logout is refused, preserving other sign-ins.
The CA requires verified email unless an operator explicitly trusts the managed
SUSE issuer to omit the claim. False or malformed verification claims are refused.

## Delivery and validation

The implementation includes jose verification, exact discovery binding, bounded
network requests, configurable algorithms/client authentication and optional
returned-claim assurance. It adds local-default/explicit-provider logout, durable
sid revocation with atomic replay records (migration 0067), rate limits and
standing deadlines preserved through renewal, device approval and unlinking.
Newer issue times cannot revive the same revoked sid. Provider-only subject
notifications are refused, following the chosen session-specific scope.

The new `docs/enterprise-identity.md` runbook is linked from installation,
deployment, identity, configuration, operations and Helm guides. It covers exact
registration URLs, configuration and secret custody, admission, assurance, SCIM,
logout, legacy cookies, migration, rotation, upgrade, rollback and live acceptance.

Validation completed:

- 114 identity/admission/linking/session/SCIM tests passed with isolated PostgreSQL,
  including concurrent durable logout replay. Six rate-limit tests and the HTTP
  lifecycle test passed after adding logout throttling.
- Typecheck, docs/comment wording gates and console revision checks passed.
- Updated frozen lock, license inventory, CycloneDX SBOM and console asset revision.
- Full suite: 2,409 tests; 2,323 passed, 79 skipped, seven failed. Six reproduced
  on unchanged base 26aa9c0: five filesystem clone cases hit the local <2-GiB
  free-space guard, and the demo-brand token-render fixture failed. The seventh,
  engine-manifest reporting, passed in isolation on both base and this branch.
- The disposable PostgreSQL server was stopped and its data removed; the temporary
  baseline worktree was removed. Shared main checkout changes were preserved.

Live-provider and container qualification remain deployment acceptance steps.
The canonical plan records the Lolly checks and CA packaging verification.
No production deployment or main-branch merge was performed.

## Local credential boundary

Passkeys are existing independent local credentials, outside per-provider OIDC
assurance and sid logout. SCIM/admin suspension still stops their account access.
The user was asked whether to extend the thirty-day work-identity recheck policy
to passkeys. In the absence of a further decision, this change preserves their
existing behavior and documents that boundary explicitly. An organisation-wide
MFA or periodic-IdP-login claim would need policy for every local sign-in path.
