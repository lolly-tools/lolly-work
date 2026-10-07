# Small K3s and RKE2 deployments

`values-small-suse.yaml` is a bounded starting profile for a candidate cluster on
SUSE or openSUSE hosts. It keeps one collaboration owner, the existing `Recreate`
replacement strategy and a 60-second drain. It does not establish high availability
or a tested user-capacity figure. Do not apply it to the current production host
without a capacity and cutover rehearsal.

Render it with your reviewed instance configuration and existing secret:

```sh
helm template lolly-work deploy/helm \
  -f deploy/helm/values-small-suse.yaml \
  -f /path/to/reviewed-environment-values.yaml \
  --set existingSecret=lolly-work-secrets
```

This command does not apply resources. The referenced secret must provide the
database and signing credentials listed in `values.yaml`. PostgreSQL and its
durable storage, recovery process, ingress and TLS remain deployment responsibilities.
The profile does not enable a database, pack mount, web-shell mount or render worker.

For an immutable release set `image.digest` and, when enabled,
`renderWorker.image.digest` to `sha256:` followed by 64 lowercase hex characters.
The digest overrides the tag. App and migration use the same image reference.
Keep `repository` as the image name, without a tag or digest. Existing installs
that leave these fields empty retain their tag defaults. Mirror the reviewed
images into an accessible registry where needed. Top-level `imagePullSecrets`
cover app, migration, pack/shell init containers and, by default, render worker;
`renderWorker.imagePullSecrets` can be a different list, or `[]` for a public image.

The shell and pack can be copied from pinned OCI images into disk-backed
`emptyDir` volumes (`shell.type`/`pack.type: emptyDir`, with the relevant `image` and
shell enable flag). The profile bounds these copies at 2Gi and 1Gi respectively
and the app's `/tmp` at 256Mi. It reserves 2Gi of ephemeral storage for the app
pod and caps it at 6Gi; OCI-copy init containers also receive resource budgets.
Measure expanded release sizes and allow room for logs before choosing bounds.
Optional `sizeLimit` values accept an empty string for the old unbounded behavior,
or positive integer strings in bytes, binary Ki/Mi/Gi/Ti/Pi/Ei or decimal
k/M/G/T/P/E. Zero, negative, fractional, exponent and CPU-style quantities are
refused for active volumes.
Reproducible release files do not need replicated persistent storage. User uploads
and session state must remain in durable PostgreSQL or the configured S3-compatible
blob store, not an `emptyDir` or release image.

The optional worker is limited to one concurrent browser render, one replica,
1Gi of `/tmp` and 2Gi of ephemeral storage. To enable it, provide its reviewed
`webBase`, shared `LW_RENDER_WORKER_SECRET`, and matching
`config.render.worker.url`. Review network policy and allowed origins for the real
shell location. Worker `nodeSelector`, `tolerations`, `affinity` and
`topologySpreadConstraints` allow placement on separate capacity later.

When worker network policy is enabled, DNS trust is limited to both the configured
namespace labels (default `kube-system`) and pod labels (default `kube-dns`). The
small profile limits public egress to HTTPS on port 443. Base values also permit
HTTP on port 80 for compatibility; `publicPorts: []` disables public web egress.
Private shell access requires a narrow `extraEgress` rule. For a namespace-wide
default-deny deployment, add an explicitly scoped namespace DNS allowance and
set the app policy's `allowAllEgress=false` before adding reviewed destination
rules. Network policies add permissions, so an unrestricted second rule would
undo a narrower rule. Verify actual DNS, proxy and renderer traffic on the cluster.

Worker HPA remains off and is capped at two replicas in this profile. HPA creates
pods; it does not provision cloud nodes and still needs metrics and spare CPU,
memory and disk. Qualify rendering and saturation behavior before enabling it.
Do not scale the collaboration owner: the chart refuses multiple owners until
room routing is supported.

`emptyDir.sizeLimit` and container ephemeral-storage limits do not bound the
node's image cache. Plan image retention/garbage collection, node disk headroom,
off-node backups and monitoring separately. Provider CSI or an intentionally
single-node local volume can serve persistent data initially. Longhorn is an
optional separately qualified multi-node storage profile, not a requirement for
the reproducible shell and pack copies.

Before promotion, verify exact signed releases, authenticated image pulls,
configuration and migration wiring, TLS, WebSocket reconnect/drain, agents and
asset access, render fidelity and busy responses, and backup/restore on the actual
cluster. The Helm charts do not yet cover every service in the current public
Vercel topology or the deployed separate relay; complete that parity before a
public hosting cutover. See `DAY-ONE-RKE2.md` for the render verification ladder.
