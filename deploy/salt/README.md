# Salt host readiness

This state runs the shared read-only host check from an existing reviewed source
checkout. It does not download code, copy files, manage packages, install a
runtime or restart services. Each selected argument is shell-quoted through
Salt's `quote` filter, then the command runs with `python_shell: false`. It
reports `changed: false` through Salt's stateful
protocol. A blocked host returns a failed state.

Put these public selection fields in your existing private pillar. Choose the
actual hostname and reviewed checkout path; keep secrets in your existing secret
manager and preserve Salt's current file roots and pillar configuration.

```yaml
lolly:
  expected_host: lolly-rehearsal
  source_checkout: /opt/source/lolly-work
  host_profile: k3s
```

Add this directory to a dedicated reviewed file-root environment using your
normal Salt administration procedure. Compile without executing a command:

```sh
salt 'lolly-rehearsal' state.show_sls host-readiness saltenv=lolly
salt 'lolly-rehearsal' state.apply host-readiness saltenv=lolly test=true
```

After reviewing that exact minion's selection, run the read-only inventory:

```sh
salt 'lolly-rehearsal' state.apply host-readiness saltenv=lolly
```

`test=true` previews the state and does not execute the host check. Keep the
result in a private release record. Cluster profiles inspect as the minion's
root account. For `podman-build`, use the CLI or Ansible under the intended
rootless build owner; this state deliberately does not assume a user's home or
change minion identity. Continue through the
[platform-team workflow](../suse/PLATFORM-TEAMS.md) after the inventory passes.

Reference: [Salt stateful commands](https://docs.saltproject.io/en/latest/ref/states/all/salt.states.cmd.html#using-the-stateful-argument).
