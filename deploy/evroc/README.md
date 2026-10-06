# Evroc deployment foundation

This module creates a new Lolly VM, boot disk, public IPv4 address and restricted
security group. OpenTofu and Terraform share the official Evroc provider source,
version and committed lock file. The application, signed shell, backups and upgrade
procedure use the same contracts as [UpCloud](../upcloud/README.md).

Start with the [cloud deployment guide](../../docs/cloud-deployment.md). This is a
provider-schema-tested foundation; it has not been boot-tested against an Evroc
account. It does not provision a database, change DNS or apply infrastructure in CI.

## Validate without a cloud account

CI pins OpenTofu 1.13.1, Terraform 1.16.5 and `evroc-oss/evroc` 0.9.5. Either CLI
can check the real provider schema and mocked plans without credentials:

```sh
tofu -chdir=deploy/evroc fmt -check -recursive
tofu -chdir=deploy/evroc init -backend=false -input=false -lockfile=readonly
tofu -chdir=deploy/evroc validate
tofu -chdir=deploy/evroc test
```

Replace `tofu` with `terraform` for the other supported CLI. Tests check private
service ports, administrator-only SSH, key-only non-root cloud-init, disk headroom
and refusal of unrestricted SSH or root login. These checks do not verify project
quotas, regional capacity, image availability or a successful boot.

## Authentication and reviewed creation

Use `evroc login` for an operator session; the provider reads the existing SDK
configuration at `~/.evroc/config.yaml`, or `EVROC_CONFIG_FILE`. Preserve that file.
For automation, use a scoped service account with `EVROC_SERVICE_ACCOUNT_ID` and
`EVROC_SERVICE_ACCOUNT_SECRET` supplied by the operator's secret manager. The
provider also supports token authentication. Credentials belong in the provider's
environment or SDK configuration, never in module variables, user data, Git or CI.
See the [versioned provider authentication schema](https://github.com/evroc-oss/terraform-provider-evroc/blob/v0.9.5/docs/index.md).

Copy `terraform.tfvars.example` to `terraform.tfvars` and select the actual project,
region, zone, compute profile and disk image. The example names are placeholders;
check their availability and the total recurring compute, disk, address and backup
cost before applying. Every resource uses the selected project and region explicitly.
Supply only public SSH keys and administrator CIDRs. New disks default to 80 GB
and cannot be smaller than 50 GB.

Configure a private state backend with locking, encryption and access controls
before a real plan. Keep state and saved plans private even when the module has no
secret inputs. Select one pinned CLI for that state; qualification under two CLIs
does not authorize concurrent state writes or a format migration. The workflow has
read-only repository permissions and no cloud credentials or apply step.

The VM, boot disk and public IP have `prevent_destroy`. Replacements that would
destroy them are refused. Existing resources require a separately reviewed import
and no-change plan; this module is not an automatic adoption tool.

## SSH, image and host preparation

Evroc's custom cloud-init replaces its default configuration. The module therefore
writes a complete non-root login account with public keys, a locked password and
sudo access, using YAML encoding. Choose the image's existing administrator group:
`sudo` for a qualified Ubuntu/Debian image, or `wheel` for a qualified SUSE image.
Do not place application secrets or provider credentials in this user data.

The current [VM provisioning kit](../vm/README.md) is explicitly openSUSE-specific.
Qualify an available or operator-imported openSUSE cloud-init image before using
`provision.sh` on Evroc; UpCloud's bootstrap script is provider-specific. An Ubuntu
image may run the provider-independent Compose application after equivalent Docker,
proxy, SSH, firewall, mounts and service-startup preparation, but the openSUSE
provisioner does not support that OS. Record real SSH, reboot, cloud-init and health
checks before advertising a deployable image. A SUSE/Evroc partnership does not
establish that a particular image is present in this project's catalog.

## Network and data boundaries

The module attaches only its custom security group, without Evroc's unrestricted
`default_allow_ssh` group. Security-group permissions are combined, so adding a
second broad group would weaken this boundary. SSH accepts the configured source
CIDRs; TCP 80 and TCP/UDP 443 accept web traffic over IPv4 and IPv6. ICMP and outbound
traffic support network control and normal application dependencies. Other inbound
ports remain denied. At most 40 SSH ranges leave room within the documented 50-rule
limit. Explicit `dual-stack` avoids the deprecated IPv4-only topology.

Keep Work, render, relay and PostgreSQL inside the container/private network, with
only Caddy public. Bind Docker-published service ports to loopback. The provider's
disk schema has no encryption switch; verify the cloud's disk security and recovery
policy independently rather than inferring it from the module.

Use a reviewed external PostgreSQL service or the optional
[local PostgreSQL override](../vm/postgres.compose.yml) after a real restore and
capacity rehearsal. No Evroc managed PostgreSQL product is assumed by this module.
The [database migration procedure](../../docs/cloud-deployment.md#database-migration)
is identical across providers. Keep logical backups independently of the VM.

Evroc's object storage has a documented S3 compatibility matrix. Qualify the exact
bucket's versioning, private access, retention, CORS, ranges and restore behavior
before using it for uploaded assets, release archives or backups. S3 compatibility
does not imply support for every AWS feature or a static website endpoint.

## Primary references

- [Official provider release 0.9.5](https://github.com/evroc-oss/terraform-provider-evroc/releases/tag/v0.9.5)
- [VM schema](https://github.com/evroc-oss/terraform-provider-evroc/blob/v0.9.5/docs/resources/virtual_machine.md)
- [Disk schema](https://github.com/evroc-oss/terraform-provider-evroc/blob/v0.9.5/docs/resources/disk.md)
- [Security-group schema](https://github.com/evroc-oss/terraform-provider-evroc/blob/v0.9.5/docs/resources/security_group.md)
- [Security-group behavior](https://docs.evroc.com/products/compute/concepts/security-groups.html)
- [Custom cloud-init](https://docs.evroc.com/products/compute/guides/use-custom-cloud-init.html)
- [Object-storage compatibility](https://docs.evroc.com/products/storage/object-storage/s3compat.html)
