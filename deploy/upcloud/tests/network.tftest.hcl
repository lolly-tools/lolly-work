# SPDX-License-Identifier: MPL-2.0
mock_provider "upcloud" {}

variables {
  hostname           = "lolly-staging"
  template_uuid      = "01000000-0000-4000-8000-000000000001"
  ssh_public_keys    = ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA test"]
  ssh_allowed_cidrs  = ["192.0.2.10/32", "2001:db8::10/128"]
  dns_resolver_cidrs = ["94.237.127.9/32", "2001:db8::53/128"]
}

run "private_service_ports" {
  command = plan
  assert {
    condition     = alltrue([for rule in upcloud_firewall_rules.lolly.firewall_rule : rule.direction != "in" || rule.action != "accept" || rule.protocol == "icmp" || contains(["22", "80", "443"], rule.destination_port_start) || (rule.destination_port_start == "32768" && rule.destination_port_end == "60999" && contains(["80", "443", "53"], rule.source_port_start))])
    error_message = "Hosted service ports stay restricted; stateless replies require both an explicit source port and the measured ephemeral range."
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

run "stateless_responses" {
  command = plan
  variables { ntp_server_cidrs = ["192.0.2.123/32"] }
  assert {
    condition     = length(local.http_response_rules) == 4 && alltrue([for rule in local.http_response_rules : rule.protocol == "tcp" && rule.source_port_start == rule.source_port_end && contains(["80", "443"], rule.source_port_start) && rule.destination_port_start == "32768" && rule.destination_port_end == "60999"])
    error_message = "HTTP replies must use exact source ports and the measured high destination range in both families."
  }
  assert {
    condition     = length(local.dns_response_rules) == 4 && alltrue([for rule in local.dns_response_rules : rule.source_address_start == rule.source_address_end && rule.source_port_start == "53" && rule.source_port_end == "53" && rule.destination_port_start == "32768" && rule.destination_port_end == "60999"])
    error_message = "TCP and UDP DNS reply rules must use each exact resolver address."
  }
  assert {
    condition     = length(local.ntp_response_rules) == 1 && local.ntp_response_rules[0].source_address_start == "192.0.2.123" && local.ntp_response_rules[0].source_address_end == "192.0.2.123" && local.ntp_response_rules[0].protocol == "udp" && local.ntp_response_rules[0].source_port_start == "123"
    error_message = "Optional NTP replies must come from the exact measured time server."
  }
}

run "reject_broad_dns" {
  command = plan
  variables { dns_resolver_cidrs = ["94.237.127.0/24"] }
  expect_failures = [var.dns_resolver_cidrs]
}

run "randomized_pod_dns_snat" {
  command = plan
  variables { dns_response_port_range = { start = 1024, end = 65535 } }
  assert {
    condition     = length(local.dns_response_rules) == 4 && alltrue([for rule in local.dns_response_rules : contains(["tcp", "udp"], rule.protocol) && rule.source_address_start == rule.source_address_end && contains(["94.237.127.9", "2001:db8::53"], rule.source_address_start) && rule.source_port_start == "53" && rule.source_port_end == "53" && rule.destination_port_start == "1024" && rule.destination_port_end == "65535"])
    error_message = "Randomized DNS SNAT needs only exact trusted resolver TCP/UDP53 return rules."
  }
  assert {
    condition     = alltrue([for rule in local.http_response_rules : rule.destination_port_start == "32768" && rule.destination_port_end == "60999"]) && alltrue([for rule in local.firewall_rules : lookup(rule, "destination_port_start", "") != "1024" || (lookup(rule, "source_port_start", "") == "53" && lookup(rule, "source_port_end", "") == "53" && lookup(rule, "source_address_start", "") == lookup(rule, "source_address_end", "") && contains(["94.237.127.9", "2001:db8::53"], lookup(rule, "source_address_start", "")))])
    error_message = "A dedicated DNS range must never widen HTTP or any-source service return paths."
  }
  assert {
    condition     = length(local.web_rules) == 6 && alltrue([for rule in local.web_rules : contains(["80", "443"], rule.destination_port_start)]) && length(local.ssh_rules) == 2 && local.ssh_rules[0].source_address_start == "192.0.2.10" && local.firewall_rules[length(local.firewall_rules) - 2].action == "drop"
    error_message = "Hosted web, administrator SSH and unmatched inbound denial must stay unchanged."
  }
}

run "reject_privileged_dns_return_ports" {
  command = plan
  variables { dns_response_port_range = { start = 1023, end = 65535 } }
  expect_failures = [var.dns_response_port_range]
}

run "reject_reversed_dns_return_ports" {
  command = plan
  variables { dns_response_port_range = { start = 65535, end = 1024 } }
  expect_failures = [var.dns_response_port_range]
}

run "reject_fractional_dns_return_ports" {
  command = plan
  variables { dns_response_port_range = { start = 1024.5, end = 65535 } }
  expect_failures = [var.dns_response_port_range]
}

run "reject_excess_dns_return_ports" {
  command = plan
  variables { dns_response_port_range = { start = 1024, end = 65536 } }
  expect_failures = [var.dns_response_port_range]
}

run "reject_broad_dns_with_dedicated_return_range" {
  command = plan
  variables {
    dns_resolver_cidrs      = ["2001:db8::/64"]
    dns_response_port_range = { start = 1024, end = 65535 }
  }
  expect_failures = [var.dns_resolver_cidrs]
}

run "reject_missing_dns" {
  command = plan
  variables { dns_resolver_cidrs = [] }
  expect_failures = [var.dns_resolver_cidrs]
}

run "reject_broad_ipv6_time_server" {
  command = plan
  variables { ntp_server_cidrs = ["2001:db8::/64"] }
  expect_failures = [var.ntp_server_cidrs]
}

run "reject_low_response_ports" {
  command = plan
  variables { ephemeral_port_range = { start = 30000, end = 60999 } }
  expect_failures = [var.ephemeral_port_range]
}

run "reject_reversed_response_range" {
  command = plan
  variables { ephemeral_port_range = { start = 60999, end = 32768 } }
  expect_failures = [var.ephemeral_port_range]
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

run "explicit_standard_candidate_storage" {
  command = plan
  variables {
    plan           = "STARTER-4xCPU-8GB"
    root_disk_tier = "standard"
  }
  assert {
    condition     = upcloud_server.lolly.plan == "STARTER-4xCPU-8GB" && upcloud_server.lolly.template[0].tier == "standard" && upcloud_server.lolly.template[0].encrypt && upcloud_server.lolly.template[0].size == 80
    error_message = "A Standard candidate must keep the selected plan, encryption and 80 GB capacity."
  }
}

run "reject_archive_boot_storage" {
  command = plan
  variables { root_disk_tier = "archive" }
  expect_failures = [var.root_disk_tier]
}
