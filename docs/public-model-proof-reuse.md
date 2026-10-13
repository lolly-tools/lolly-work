# Model proof reuse and release measurements

A frontend stage can opt into a prior successful model checkpoint by adding a
`modelReuse` held file reference to its reviewed runtime input. Without that
field, staging continues to download all model bodies. The referenced request
has exactly these fields:

```json
{
  "version": 1,
  "status": "REVIEWED_ACCEPTED_MODEL_CHECKPOINT_REUSE_NOT_EXECUTED",
  "acceptedRelease": { "path": "/absolute/accepted-release.actual.json", "sha256": "<exact sha256>" },
  "checkpointProof": { "version": 1, "input": {}, "operator": {}, "phases": {} }
}
```

`checkpointProof` is the original accepted publication proof with the observe
accepted reference pointing to its genuine `observe.checkpoint.actual.json`.
The helper rederives the accepted publication and checkpoint, including original
source, commands, owner, configuration and full-body HTTP proof. The empty
objects above are placeholders, not executable inputs.

The checkpoint must be no more than **24 hours old at both qualification
bookends**. Its exact Deployment, ReplicaSet, Pod, container, native PID/start
time, boot, namespaces, executable and root must remain selected. Model recipe,
image, configuration bytes, origin, claim/PV identities and backing specs must
match. Historical records without the native-process checkpoint cannot opt in.
An invalid or expired explicit opt-in refuses; choosing full qualification
requires a separately reviewed input without the option.

Staging still performs all three complete physical model hash/inode scans, full
static qualification, native HTTP, and fresh global resource checks. Every model
gets fresh normal-TLS cache, CORS, conditional and range checks. Only the two
full-body responses for models larger than 64 KiB may be reused. Smaller models
still transfer both bodies. The model receipt explicitly links `reuse` to the
prior full-body proof and new process/physical/HTTP bookends. It never describes
prior bytes as a current download, and no active model PVC is mounted by staging.

Publication after Recreate always performs the full model-body checks on the
new owning process. Its newly accepted checkpoint can seed the next stage. The
separate failed-observation continuation uses a **15 minute** window and does
not permit new owners or replace successful-stage admission.

## Measuring the complete operation

`measure-public-release.py run` wraps one explicitly reviewed Python or Node
command. It runs no subsequent phase automatically. The wrapped adapter retains
its own source checks, preflights, approvals and original receipts.

A reviewed input contains `version: 1`,
`status: REVIEWED_SINGLE_PUBLIC_RELEASE_OPERATION`, one `releaseId`, an
`activity` of `preparation`, `staging`, `publication` or `verification`, held
`program` and `entrypoint` files, `interpreterArguments`, literal `arguments`,
held `inputFiles`, exact `cwd`, new `outputDirectory`, `timeoutSeconds`, and
expected new `httpTimingPaths`. Pass its checksum and the wrapper checksum:

```sh
python3 -B scripts/measure-public-release.py run \
  --input /absolute/operation-input.json \
  --reviewed-input-sha256 <sha256> \
  --reviewed-operator-sha256 <sha256>
```

Each journal retains the original process exit, stdout/stderr and monotonic
interval. This includes the wrapped constructor and local preparation. A failed
command or corrupt/missing expected sidecar remains recorded; telemetry cannot
convert command failure into success. The wrapper never retries. A command that
succeeds while telemetry fails keeps its actual zero exit code separately from
the refused timing result.

For an end-to-end record, wrap preparation, each staging command and each
publication command with the same release ID. Then pass an array of their held
`operation.actual.json` references to the `summarize` action, with `--output`
pointing to a new file. Summary requires one host boot and non-overlapping
intervals. It reports activity totals, elapsed first-command-to-last-command time
and unmeasured gaps separately. Nested model HTTP seconds are not added to
operation seconds. HTTP bytes count response bodies actually read, including
partial failure reads, and exclude headers/TLS framing. Wrapper setup before the
first command and after the last command is outside the measured span.

## Local measurement and practical limits

The runnable `tests/public_model_reuse_measurement_fixture.py --out-dir <newdir>`
uses a real loopback HTTP server with four synthetic models (empty, 64 KiB,
64 KiB + 1 byte and 8 MiB). It compares complete verification, same-process reuse,
and an unconditional full-publication transfer control. It does not establish
production owner custody or measure TLS/network deployment performance.

On the 2026-10-13 local fixture run, the 8,519,681-byte inventory transferred
17,039,653 response-body bytes in the full pass, 131,363 in the reuse pass, and
17,039,653 again in the full-publication control. HTTP portions took about
0.108 s, 0.084 s and 0.108 s; the complete wrapped fixture took about 0.986 s.
These short loopback times are not production release estimates. Actual owner,
physical scanning, signature, source, allocation, retirement and rollout checks
remain in the deployment path. The earlier 177-model production baseline read
about 5.39 GB and transferred 10.78 GB over TLS in roughly 13 minutes, with full
qualification about 28 minutes. There is no measured production speedup yet.
