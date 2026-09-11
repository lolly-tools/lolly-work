# Preparing an internal release

Use the existing staging deployment to collect evidence for production promotion.
The optional `values-internal.yaml` overlay gives an employee-only first release
gated access, disabled development/proxy login, a 12-hour member session, disabled
guest links and nearby discovery, and no usage telemetry. Audit events and head
logging remain enabled. These are proposed application settings, not proof of
SUSE approvals or complete infrastructure configuration.

Merge the overlay with the reviewed environment values and inspect the result:

```sh
helm template lolly deploy/helm \
  -f /path/to/reviewed-environment-values.yaml \
  -f deploy/helm/values-internal.yaml > rendered.yaml
```

This command renders locally. It does not apply a change. Keep secrets in the
platform's secret store and use `existingSecret` references; rendered output can
otherwise contain chart-managed secrets. Review the effective `instance.json`,
and compare it with staging before choosing what to promote. The overlay requires
`config` to be a YAML map; if the deployment uses a raw JSON string via `--set-file`,
apply and validate the equivalent settings in that JSON instead. Do not combine
this overlay with the development `values-eval.yaml` profile.

The environment must still supply and demonstrate:

- The approved internal URL, TLS ingress, SUSE IdP issuer/client and callback,
  MFA and allowed membership/groups, least-privilege roles, and an offboarding
  process that updates Work and revokes active sessions. Gated access alone does
  not establish that every account admitted by the IdP is an authorised employee.
- Exact application, engine, shell and pack releases plus immutable image digests.
  The separately built Lolly shell must use its signed release build. Mount the
  governed shell/pack and verify that direct API, catalog, file and render requests
  enforce the intended access policy.
- Durable PostgreSQL storage, required migrations (including audit migration
  `0034`), protected secret references, blob storage and a tested recovery plan.
  Do not use memory storage for production. Existing secrets must include the
  required keys listed in `values.yaml`.
- Approved retention settings for each data category. The overlay deliberately
  leaves `policy.retention` to the environment: if omitted there too, both
  telemetry and audit retention default to indefinite. Security logs normally
  need at least 180 days under the supplied SUSE baseline, subject to its stated
  exceptions and the authoritative retention schedule. Disabling usage telemetry
  does not delete previously collected telemetry.
- Central logging/SIEM collection with verified receipt, retention and alert
  ownership. Audit-head stdout must be independently retained outside the
  deployment's control. Choose network policy and egress rules for the real
  ingress, DNS, identity, database, logging and enabled integration endpoints.
- Security decisions for submissions/scanning, sharing, local exports/offline
  storage, enabled AI/models and integrations. Disabling guest links and nearby
  discovery does not disable every sharing or AI capability.

Attach staging functional/UAT and security results, release scans and risk
treatment, privacy/AI review outcomes where applicable, service/support ownership,
and the implementation/rollback/communications plan to the change record. Submit
the actual tested release and configuration for the required approvals; a passing
CI job or this overlay does not approve production promotion.

## Matching managed web build

Build the updated Lolly shell with `--build-arg VITE_REQUIRE_AI_POLICY=true`
when using `deploy/docker/web.Dockerfile` (or the same Vite environment setting
in the actual approved builder). Runtime nginx environment variables cannot change
this setting. Keep `config.policy.ai.enabled=false` and `capabilities: []` in the
first internal values. Work and shell must be promoted together; old shells cannot
enforce the new policy. See `docs/ai-policy.md` for lease expiry and scope.

The local infrastructure checkout uses a separate build recipe. This overlay does
not update that recipe or add missing Work/PostgreSQL/IdP routing automatically.
Confirm and port the reviewed changes to the actual GitLab infrastructure revision
when access returns.
