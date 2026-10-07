# SPDX-License-Identifier: MPL-2.0
resource "upcloud_server" "lolly" {
  hostname = var.hostname
  zone     = var.zone
  plan     = var.plan
  metadata = true
  firewall = true
  labels   = merge(var.labels, { application = "lolly", managed_by = "opentofu-terraform" })

  template {
    storage = var.template_uuid
    size    = var.root_disk_gb
    tier    = var.root_disk_tier
    encrypt = true
  }
  login {
    user              = var.ssh_user
    keys              = sort(tolist(var.ssh_public_keys))
    create_password   = false
    password_delivery = "none"
  }
  network_interface {
    type              = "public"
    ip_address_family = "IPv4"
  }
  lifecycle {
    prevent_destroy = true
  }
}

locals {
  ssh_rules = [for network in sort(tolist(var.ssh_allowed_cidrs)) : {
    action                 = "accept", direction = "in", protocol = "tcp",
    family                 = strcontains(network, ":") ? "IPv6" : "IPv4",
    source_address_start   = cidrhost(network, 0), source_address_end = cidrhost(network, -1),
    destination_port_start = "22", destination_port_end = "22",
    comment                = "Administrator SSH"
  }]
  web_rules = flatten([for family in ["IPv4", "IPv6"] : [for port in [
    { port = "80", protocol = "tcp" },
    { port = "443", protocol = "tcp" },
    { port = "443", protocol = "udp" }
    ] : {
    action                 = "accept", direction = "in", family = family, protocol = port.protocol,
    destination_port_start = port.port, destination_port_end = port.port,
    comment                = "Web and ACME"
  }]])
  control_rules = [for family in ["IPv4", "IPv6"] : {
    action  = "accept", direction = "in", family = family, protocol = "icmp",
    comment = "Network control and path MTU"
  }]
  http_response_rules = flatten([for family in ["IPv4", "IPv6"] : [for port in ["80", "443"] : {
    action                 = "accept", direction = "in", family = family, protocol = "tcp",
    source_port_start      = port, source_port_end = port,
    destination_port_start = tostring(var.ephemeral_port_range.start), destination_port_end = tostring(var.ephemeral_port_range.end),
    comment                = "HTTP response packets; host connection tracking required"
  }]])
  dns_response_rules = flatten([for network in sort(tolist(var.dns_resolver_cidrs)) : [for protocol in ["tcp", "udp"] : {
    action                 = "accept", direction = "in", protocol = protocol,
    family                 = strcontains(network, ":") ? "IPv6" : "IPv4",
    source_address_start   = cidrhost(network, 0), source_address_end = cidrhost(network, 0),
    source_port_start      = "53", source_port_end = "53",
    destination_port_start = tostring(var.ephemeral_port_range.start), destination_port_end = tostring(var.ephemeral_port_range.end),
    comment                = "Exact DNS resolver responses; host connection tracking required"
  }]])
  ntp_response_rules = [for network in sort(tolist(var.ntp_server_cidrs)) : {
    action                 = "accept", direction = "in", protocol = "udp",
    family                 = strcontains(network, ":") ? "IPv6" : "IPv4",
    source_address_start   = cidrhost(network, 0), source_address_end = cidrhost(network, 0),
    source_port_start      = "123", source_port_end = "123",
    destination_port_start = tostring(var.ephemeral_port_range.start), destination_port_end = tostring(var.ephemeral_port_range.end),
    comment                = "Exact time server responses; host connection tracking required"
  }]
  firewall_rules = concat(local.ssh_rules, local.web_rules, local.control_rules, local.http_response_rules, local.dns_response_rules, local.ntp_response_rules, [
    { action = "drop", direction = "in", comment = "Deny other inbound traffic" },
    { action = "accept", direction = "out", comment = "Allow outbound connections" }
  ])
}

resource "upcloud_firewall_rules" "lolly" {
  server_id = upcloud_server.lolly.id
  dynamic "firewall_rule" {
    for_each = local.firewall_rules
    content {
      action                 = firewall_rule.value.action
      direction              = firewall_rule.value.direction
      comment                = firewall_rule.value.comment
      family                 = lookup(firewall_rule.value, "family", null)
      protocol               = lookup(firewall_rule.value, "protocol", null)
      source_address_start   = lookup(firewall_rule.value, "source_address_start", null)
      source_address_end     = lookup(firewall_rule.value, "source_address_end", null)
      source_port_start      = lookup(firewall_rule.value, "source_port_start", null)
      source_port_end        = lookup(firewall_rule.value, "source_port_end", null)
      destination_port_start = lookup(firewall_rule.value, "destination_port_start", null)
      destination_port_end   = lookup(firewall_rule.value, "destination_port_end", null)
    }
  }
}
