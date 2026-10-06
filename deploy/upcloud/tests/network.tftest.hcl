# SPDX-License-Identifier: MPL-2.0
mock_provider "upcloud" {}

variables {
  hostname          = "lolly-staging"
  template_uuid     = "01000000-0000-4000-8000-000000000001"
  ssh_public_keys   = ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA test"]
  ssh_allowed_cidrs = ["192.0.2.10/32", "2001:db8::10/128"]
}

run "private_service_ports" {
  command = plan
  assert {
    condition     = alltrue([for rule in upcloud_firewall_rules.lolly.firewall_rule : rule.direction != "in" || rule.action != "accept" || rule.protocol == "icmp" || contains(["22", "80", "443"], rule.destination_port_start)])
    error_message = "Only SSH and web ports may accept inbound TCP/UDP traffic."
  }
  assert {
    condition     = local.firewall_rules[length(local.firewall_rules) - 2].action == "drop" && local.firewall_rules[length(local.firewall_rules) - 2].direction == "in"
    error_message = "The final inbound rule must deny unmatched traffic."
  }
  assert {
    condition     = length(local.ssh_rules) == 2 && local.ssh_rules[0].source_address_start == "192.0.2.10" && local.ssh_rules[1].family == "IPv6"
    error_message = "SSH must stay restricted to the explicit administrator networks."
  }
  assert {
    condition     = upcloud_server.lolly.metadata && upcloud_server.lolly.firewall && !upcloud_server.lolly.login[0].create_password && upcloud_server.lolly.template[0].size == 80 && upcloud_server.lolly.template[0].encrypt
    error_message = "Cloud-init, firewall, key-only access and encrypted disk headroom are required."
  }
}

run "reject_open_ssh" {
  command = plan
  variables { ssh_allowed_cidrs = ["0.0.0.0/0"] }
  expect_failures = [var.ssh_allowed_cidrs]
}

run "reject_small_disk" {
  command = plan
  variables { root_disk_gb = 20 }
  expect_failures = [var.root_disk_gb]
}

run "reject_open_ipv6_ssh" {
  command = plan
  variables { ssh_allowed_cidrs = ["::/0"] }
  expect_failures = [var.ssh_allowed_cidrs]
}

run "reject_invalid_network" {
  command = plan
  variables { ssh_allowed_cidrs = ["not-a-network"] }
  expect_failures = [var.ssh_allowed_cidrs]
}

run "reject_missing_key" {
  command = plan
  variables { ssh_public_keys = [] }
  expect_failures = [var.ssh_public_keys]
}
