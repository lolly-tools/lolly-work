# Ansible host readiness

The playbook runs the shared SUSE host check on exact selected inventory members,
one host at a time. It uses `ansible-core` built-in modules and no downloaded
roles or collections. It creates only Ansible's temporary script transfer, which
Ansible removes; the script never installs packages, starts services or changes
the firewall. Required Python 3 and OS tooling must already be available.

Copy `inventory.example.yml` into private operator custody, select the actual
host address, image login user and exact hostname, then validate and inspect:

```sh
ansible-playbook -i /private/lolly-inventory.yml deploy/ansible/host-readiness.yml --syntax-check
ansible-playbook -i /private/lolly-inventory.yml deploy/ansible/host-readiness.yml --limit rehearsal --check
```

The read-only script explicitly runs in Ansible check mode and reports no
changes. `k3s` and `rke2` inspect as root through your existing become setup;
`podman-build` runs as the selected unprivileged build account. A blocked receipt
fails the play. Keep its hostname and resource metadata in a private release
record. Do not add passwords, registry tokens or provider credentials to the
inventory or command line. Preserve existing SSH and Ansible configuration.

This gate does not install a cluster or apply Helm releases. Continue through
the [platform-team workflow](../suse/PLATFORM-TEAMS.md) and the existing guarded
installer. An existing production host is an upgrade target with a different
procedure; it should fail the fresh-host gate.

Reference: [Ansible script module](https://docs.ansible.com/projects/ansible/latest/collections/ansible/builtin/script_module.html).
