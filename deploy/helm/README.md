# Lolly Work

Official upstream Helm chart for the free, MPL-2.0 Lolly control plane. Lolly
provides organisation sign-in, governed tools and assets, collaboration and audit.
The project charges no software fee and receives no usage commission. Operators
provide their infrastructure and identity service.

The chart runs one writable Work owner, with a PostgreSQL database supplied by the
operator. Replacement uses `Recreate`; additional nodes do not provide application
high availability. The optional Chromium worker is disabled by default.

Use the [official installation directory](https://github.com/lolly-tools/lolly-work/blob/main/docs/official-installations.md)
for publication status, immutable release pins and platform qualification.
Follow the [Kubernetes installation guide](https://github.com/lolly-tools/lolly-work/blob/main/docs/platform-deployment.md#install-for-production)
for secrets, database, real owner sign-in, ingress and verification. The default
installation serves `/admin` and the API. Add a matched shell and neutral/own pack
to serve the complete Lolly application at `/`.

Rancher users can add the published HTTP repository under **Apps > Repositories**.
The included `questions.yaml` covers initial connection settings. Review the full
values YAML, identity admission/owner mapping, storage and TLS before installation;
the form does not register an identity client or provision PostgreSQL.

The chart supports external Secrets, immutable image digests, shell/pack claims or
OCI copies, migration hooks, resource bounds and optional worker isolation. See
`values.yaml`, `values.schema.json` and `values-small-suse.yaml` in the source.
Use `values-official-release.yaml` for the qualified immutable 1.1.1 image pins;
it is generated from the same release record as the VM/Dokploy packages and keeps
the worker disabled. Merge your operator configuration separately. Explicit tag
selection and custom registries remain available through the base chart values.
Take an independent backup and complete a restore before every application upgrade.
Keep previous images, configuration, content and signing keys. A database migration
may require restoration or forward repair; an older image alone is insufficient.

Every install and upgrade runs the migration Job first. Helm removes the previous
Job (`before-hook-creation`) and waits for it to go, so the last Job and its logs
stay readable until the next upgrade. `helm rollback` does not run the Job. If an
upgrade stops in the pre-upgrade hook, read the error before changing anything
(names below are for a release called `lolly-work`):

- `server-side apply failed for object <namespace>/lolly-work-migrate`: the
  cluster API refused or dropped the request that creates the new Job, after the
  previous Job was already removed. Check that the API server answers, then run
  the same `helm upgrade` again. Nothing needs deleting by hand.
- `lolly-work-migrate still exists. status: Terminating`: the previous Job was
  still being deleted when `--timeout` ran out. Wait until `kubectl get job` no
  longer lists the Job, then run the upgrade again.
- `Job Failed`: the migration itself failed. Read
  `kubectl logs job/lolly-work-migrate`, fix the cause, then upgrade again.

These cases were checked with Helm 4.3.0 on K3s 1.35, including an upgrade after
an install that failed its readiness wait, repeated upgrades and a rollback.

Report issues through [the upstream repository](https://github.com/lolly-tools/lolly-work/issues).
Support is community best effort; marketplace publication adds no service-level
agreement or platform certification. See the repository's `SECURITY.md` for private
vulnerability reporting.
