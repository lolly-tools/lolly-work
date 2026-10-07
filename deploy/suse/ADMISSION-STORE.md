# Sovereign public admission storage

Lolly Work's PostgreSQL path does not require Redis. The optional public MCP and
certificate services use it for admission counters and the MCP daily compute/
response-byte ceiling. [The maintained compatibility service](../../services/admission/README.md)
lets an operator replace an external Redis REST provider without changing the
current consumers' wire contract. It is optional and not part of a Work release.

## Small SUSE topology

Use one standalone Redis from
[SUSE Application Collection](https://docs.apps.rancher.io/reference-guides/redis)
and one HTTPS adapter, in a separate owned namespace. A single node does not
gain availability from a Redis Sentinel or Cluster topology. No extra VM is
needed. This introduces two small Pods while removing an external admission
store. Native clients in both public applications could remove the adapter
later, after their own compatibility and release qualification.

An initial resource review should reserve 100m CPU/128Mi RAM for Redis and
100m/64Mi for the adapter, with respective limits of 300m/256Mi and 300m/128Mi.
A dedicated 2Gi PVC leaves room for append-only log rewrites; it is not workspace
storage. Use a 64Mi Redis `maxmemory` and `noeviction`: evicting live counters
would reopen admission. Qualify the limits against real request latency and
rewrite peaks, retain filesystem headroom and monitor disk/RSS/503s. AOF with
`appendfsync always` preserves acknowledged updates more strongly than the
one-second loss window of `everysec`; benchmark its latency on the chosen disk.
[Redis persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)
still needs an explicit restore drill and off-host recovery record. These limits
and local tests do not establish high availability or a qualified host disaster
recovery procedure.

The reviewed 2026-10-07 candidate was AppCo Redis chart 2.8.0, Redis 8.6.7-11.2:

| Artifact | Digest |
| --- | --- |
| Image index | `sha256:f2e6e6457f6661b1a4383fa140b22d1ddd2d0d831dd79d7052e0120c70e373d3` |
| linux/amd64 manifest | `sha256:ca56d5d6d6f79fddf671a71b6429f547f2b4df7fd7ac6df77d0c5f28e6f7a91c` |
| linux/arm64 manifest | `sha256:245cd81d7a60bba40b2041efe08316cbfbb6984f878e8304dfb8eeaa3a14ff57` |

The local arm64 container passed verified Redis TLS/password authentication,
concurrent atomic increments, nonrenewing TTLs, the MCP budget pair and the
deadline-preserving empty-candidate import. Its local setup used non-root UID
999; the AppCo chart uses configurable UID/fsGroup 1000. Inspect the exact chart
values and filesystem ownership before staging: an image inspection is not a
Kubernetes or amd64 acceptance. Keep the existing Application Collection login
unchanged; use a temporary registry configuration or namespace-owned pull Secret.

`admission/redis-values.example.yaml` is a version-specific values example,
not a production install command. `admission/adapter.example.yaml` deliberately
contains an unresolved adapter image digest. Resolve/publish that image, qualify
the rendered resources and pin the chart checksum and manifests in a reviewed
release before creating a candidate. Include `admission/network-policy.example.yaml`
after replacing its deliberately unmatched consumer selectors with reviewed
release labels. No existing workspace PVC, database,
application Deployment or Secret is part of candidate provisioning.

## Security boundaries

Keep Redis and the adapter as ClusterIP services. No Ingress, public DNS record,
NodePort, host networking or browser-facing endpoint is needed. Default-deny
both ingress and egress in the admission namespace. Allow only the exact public
MCP/CA Pods to adapter TCP 8443, only adapter to Redis TLS TCP 6379, and the
necessary namespace-scoped DNS path. Add corresponding narrowly scoped egress
to those two public consumers; preserve their existing unrelated egress rules.
Labels and policy selectors must come from the owning release, not broad
allow-all namespace rules. An operator transfer Job, if used, gets a separate
reviewed temporary path and credentials; it is not permanently admitted.

Use non-root UIDs, `RuntimeDefault` seccomp, no capabilities, no privilege
escalation, read-only application roots, no automounted service-account token and
small bounded temporary volumes. Redis alone owns its writable data claim.
Never mount it in a second staging Pod; backup through its owning Pod. Review
host overcommit and persistence behavior rather than introducing privileged
init containers or changing a cluster-wide security exception for convenience.

Issue private-CA certificates with the exact Service DNS SANs for Redis and the
adapter. TLS private keys, Redis credentials and the two random bearer tokens
belong in separate owned Secrets; public trust certificates may use ConfigMaps.
The public consumers must load that adapter CA via `NODE_EXTRA_CA_CERTS` at
process start and use its HTTPS Service URL. Never disable TLS verification.
The adapter separately loads the Redis CA. Certificate expiry is an operational
dependency; qualify rotation while preserving hostname checks.

Use Redis ACLs to restrict the runtime user to the `lolly:rl:*` and
`lolly:budget:mcp:*` key spaces and PING/EVAL/MGET plus the INCR/INCRBY,
PEXPIRE/PTTL/TTL/EXPIRE operations used inside the allowed scripts. A separate
temporary operator user may additionally need INFO/TIME/DBSIZE/GET/SET for
transfer; do not give those credentials to the public consumers. Script ACLs
also check the commands inside scripts. Redis user creation and exact chart
probe credentials must be qualified together. Do not disable authentication.
This AppCo chart materializes `redis.conf` on its data claim; changing a Secret
or ConfigMap alone must not be assumed to rotate a persisted password/config.
Review and qualify its specific configuration/rotation mechanism before use.

## Concrete cutover sequence

1. Review current cluster/node/workload identities, capacity and every source
   writer. Stage only the new namespace, Redis claim, certificates, credentials,
   adapter image and narrow policies under exclusive resource ownership. Keep
   the adapter out of the public consumers until qualification completes.
2. Qualify amd64 boot, security, DNS/TLS, allowed and denied network paths,
   Redis ACLs, concurrent increments, expiry, quota refusals, outage 503s,
   credential separation, AOF restart and off-host restore. Use synthetic data
   in a separate test database/claim; the final import destination must be empty.
3. Confirm old Vercel functions and every cached-DNS path can no longer write
   the source store. Gate the two public services' admission routes and drain
   in-flight requests/usage records. Verify the fence independently, then record
   protected quiescence evidence. Private workspace collaboration can continue.
4. Use the protected source credential to SCAN and atomically snapshot only the
   current counters and daily totals; the current provider must permit the
   read-only Lua GET/PTTL/TIME script. Export produces no reset or source write.
   Review the hash-bound import plan and empty Redis process identity, run the
   site's production preflight, import and verify its receipt while drained.
5. Serialize updates to MCP and CA. Set MCP's `LOLLY_RATE_LIMIT_REST_URL` and
   matching token to the adapter so they override the old KV family; keep the
   old pair in protected rollback custody. Set CA's own URL/token pair together.
   Explicitly disable both in-memory fallbacks. Mount/load the adapter CA and
   roll only these consumers. Preserve signing keys, provider identities,
   public routes, workspace data and other policies.
6. Check normal HTTPS rendering and CA admission with the gate controlled,
   preserved daily totals/deadlines and intentionally refused credentials and
   store outages. Reopen admission only after both consumers select the new
   service. Observe latency, memory, disk and refusal counters. Never reset a
   ceiling merely to make a health check pass.
7. Retain Upstash and its credential until the grace period and rollback review
   pass. Confirm the absence of calls from all retained deployments before
   detaching Marketplace billing or retiring the store. After reopening, any
   rollback needs a new drain and forward transfer of post-cutover counters;
   restoring stale source totals would weaken admission.

Counter snapshots and their operator attestation do not automatically prove a
deployment is fenced. A source and destination cannot be globally switched
atomically by this tool; the controlled drain is the consistency boundary. On
an ambiguous or partially committed import, leave admission closed and inspect
the exact isolated candidate. Do not activate it, retry blindly, flush shared
data or claim a zero-loss migration without the receipts and writer fence.
