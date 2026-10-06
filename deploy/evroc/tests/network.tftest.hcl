# SPDX-License-Identifier: MPL-2.0
mock_provider "evroc" {}

variables {
  name              = "lolly-staging"
  project           = "example-project"
  region            = "se-sto"
  flavor            = "a1a.s"
  disk_image        = "ubuntu-24.04"
  ssh_public_keys   = ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA test"]
  ssh_allowed_cidrs = ["192.0.2.10/32", "2001:db8::10/128"]
}

run "private_service_ports_and_complete_ssh_user" {
  command = plan
  assert {
    condition     = alltrue([for rule in evroc_security_group.lolly.rule : rule.direction != "Ingress" || rule.protocol == "ICMP" || contains([22, 80, 443], rule.port)])
    error_message = "Only SSH and web ports may accept inbound TCP/UDP traffic."
  }
  assert {
    condition     = length(local.ssh_rules) == 2 && alltrue([for rule in local.ssh_rules : contains(["192.0.2.10/32", "2001:db8::10/128"], rule.remote_ip)])
    error_message = "SSH must use only the administrator networks."
  }
  assert {
    condition     = length(evroc_virtual_machine.lolly.security_groups) == 1 && evroc_virtual_machine.lolly.stack_type == "dual-stack" && evroc_disk.boot.size == 80
    error_message = "Use the module's restricted group, dual stack and explicit disk headroom."
  }
  assert {
    condition     = !yamldecode(evroc_virtual_machine.lolly.cloud_config_user_data).ssh_pwauth && yamldecode(evroc_virtual_machine.lolly.cloud_config_user_data).disable_root && yamldecode(evroc_virtual_machine.lolly.cloud_config_user_data).users[0].name == "evroc-user" && yamldecode(evroc_virtual_machine.lolly.cloud_config_user_data).users[0].lock_passwd && toset(yamldecode(evroc_virtual_machine.lolly.cloud_config_user_data).users[0].ssh_authorized_keys) == toset(var.ssh_public_keys)
    error_message = "Custom cloud-init must include key-only non-root login; it replaces evroc defaults."
  }
}

run "reject_open_ssh" {
  command = plan
  variables { ssh_allowed_cidrs = ["0.0.0.0/0"] }
  expect_failures = [var.ssh_allowed_cidrs]
}

run "reject_open_ipv6_ssh" {
  command = plan
  variables { ssh_allowed_cidrs = ["::/0"] }
  expect_failures = [var.ssh_allowed_cidrs]
}

run "reject_small_disk" {
  command = plan
  variables { root_disk_gb = 20 }
  expect_failures = [var.root_disk_gb]
}

run "reject_missing_key" {
  command = plan
  variables { ssh_public_keys = [] }
  expect_failures = [var.ssh_public_keys]
}

run "reject_root_login" {
  command = plan
  variables { ssh_user = "root" }
  expect_failures = [var.ssh_user]
}
