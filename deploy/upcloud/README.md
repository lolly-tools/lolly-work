# UpCloud deployment foundation

This module creates a new Lolly VM and its network firewall. OpenTofu and Terraform
use the same provider source, version and committed lock file. It leaves application
configuration, DNS, database provisioning and secrets to the operator. Existing
deployments keep their current configuration.

Start with the [deployment guide](../../docs/cloud-deployment.md). The existing
[openSUSE VM kit](../vm/README.md) provisions the operating system and publishes a
qualified application release after the server exists.

## Validate without a cloud account

CI pins OpenTofu 1.13.1, Terraform 1.16.5 and UpCloud provider 5.45.0. Either CLI
can run these checks without API credentials, a state backend or a billable server:

```sh
tofu -chdir=deploy/upcloud fmt -check -recursive
tofu -chdir=deploy/upcloud init -backend=false -input=false -lockfile=readonly
tofu -chdir=deploy/upcloud validate
tofu -chdir=deploy/upcloud test
```

Replace `tofu` with `terraform` for the second supported CLI. Tests use the
provider's actual schema and a mocked provider. They check inbound service
boundaries, key-only access, disk capacity and refusal of unrestricted SSH.
They do not prove that an image boots or that a chosen plan is available in a zone.

## Prepare a reviewed deployment

Copy `terraform.tfvars.example` to `terraform.tfvars`. Set a qualified image UUID,
the image's login account, actual public SSH keys and administrator CIDRs. The
module creates a single public IPv4 interface. IPv6 firewall rules are prepared,
but the module does not allocate an IPv6 interface. The disk defaults to 80 GB and
cannot be smaller than 50 GB. The example plan is a starting point for a small
private instance; qualify its capacity before adding public APIs or a database.

API credentials belong in the provider's environment variables, such as
`UPCLOUD_TOKEN`, never in `.tfvars`, cloud-init, Git or CI. The provider documents
the available [authentication options](https://github.com/UpCloudLtd/terraform-provider-upcloud/blob/v5.45.0/docs/index.md).
The module takes public keys only and disables generated login passwords.

For a real plan, configure a private state backend with locking, encryption and
controlled access first. Select one CLI for that state and keep its version pinned;
testing both CLIs does not make concurrent writes or a state-format migration safe.
Then run `init` with the backend enabled and save a plan for review. State files,
plan files and real `.tfvars` are ignored by Git. A live apply belongs to the
operator's deployment process; this repository's qualification workflow never
applies infrastructure and has no cloud credentials.

The server has `prevent_destroy` enabled. Replacements that would destroy it are
refused. Do not point the template UUID at an existing data disk. The module is for
new servers; taking ownership of a running server requires a separate import and
a no-change plan against its actual disks, network interfaces and firewall.

## Network boundaries

TCP 80 and TCP/UDP 443 are public for HTTP, HTTPS, ACME and HTTP/3. SSH accepts only
the configured administrator source ranges. ICMP is permitted for network control.
All other inbound traffic is dropped. PostgreSQL, Work, render and relay ports stay
behind Caddy and the container network. Docker-published ports still need explicit
loopback binding; the cloud firewall is an additional boundary.

## Database choices

The default VM deployment continues to use its external PostgreSQL connection.
UpCloud managed PostgreSQL is an available target for an operator-reviewed migration.
An optional [local PostgreSQL override](../vm/postgres.compose.yml) is also provided
for a new instance or a migration rehearsal. Neither option is enabled by this module.

Read the [database migration and restore procedure](../../docs/cloud-deployment.md#database-migration)
before adding the override: it changes the server's database URL to the local service.
Keep the existing connection and a verified backup until application acceptance is
complete. A local disk snapshot alone does not replace a tested, independent backup.

## Primary references

- [UpCloud server provider schema](https://github.com/UpCloudLtd/terraform-provider-upcloud/blob/v5.45.0/docs/resources/server.md)
- [UpCloud firewall provider schema](https://github.com/UpCloudLtd/terraform-provider-upcloud/blob/v5.45.0/docs/resources/firewall_rules.md)
- [OpenTofu test command](https://opentofu.org/docs/cli/commands/test/)
- [Terraform provider dependency locks](https://developer.hashicorp.com/terraform/language/files/dependency-lock)
