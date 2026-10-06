# SPDX-License-Identifier: MPL-2.0
locals {
  labels = merge(var.labels, { application = "lolly", managed_by = "opentofu-terraform" })
  ssh_rules = [for index, network in sort(tolist(var.ssh_allowed_cidrs)) : {
    name = "ssh-${index}", direction = "Ingress", protocol = "TCP", port = 22, remote_ip = network
  }]
  web_rules = flatten([for index, network in ["0.0.0.0/0", "::/0"] : [for service in [
    { name = "http", port = 80, protocol = "TCP" },
    { name = "https", port = 443, protocol = "TCP" },
    { name = "http3", port = 443, protocol = "UDP" }
    ] : {
    name = "${service.name}-${index}", direction = "Ingress", protocol = service.protocol,
    port = service.port, remote_ip = network
  }]])
  network_rules = flatten([for index, network in ["0.0.0.0/0", "::/0"] : [
    { name = "icmp-${index}", direction = "Ingress", protocol = "ICMP", remote_ip = network },
    { name = "egress-${index}", direction = "Egress", protocol = "All", remote_ip = network }
  ]])
  rules = concat(local.ssh_rules, local.web_rules, local.network_rules)
  cloud_config = "#cloud-config\n${yamlencode({
    ssh_pwauth       = false
    disable_root     = true
    manage_etc_hosts = "localhost"
    users = [{
      name                = var.ssh_user
      gecos               = "Lolly deployment operator"
      lock_passwd         = true
      sudo                = ["ALL=(ALL) NOPASSWD:ALL"]
      groups              = [var.ssh_sudo_group]
      shell               = "/bin/bash"
      ssh_authorized_keys = sort(tolist(var.ssh_public_keys))
    }]
  })}"
}

resource "evroc_public_ip" "lolly" {
  name        = "${var.name}-public"
  project     = var.project
  region      = var.region
  user_labels = local.labels
  lifecycle { prevent_destroy = true }
}

resource "evroc_disk" "boot" {
  name        = "${var.name}-boot"
  project     = var.project
  region      = var.region
  image       = var.disk_image
  size        = var.root_disk_gb
  zone        = var.zone
  user_labels = local.labels
  lifecycle { prevent_destroy = true }
}

resource "evroc_security_group" "lolly" {
  name        = "${var.name}-network"
  project     = var.project
  region      = var.region
  user_labels = local.labels
  dynamic "rule" {
    for_each = local.rules
    content {
      name      = rule.value.name
      direction = rule.value.direction
      protocol  = rule.value.protocol
      remote_ip = rule.value.remote_ip
      port      = lookup(rule.value, "port", null)
    }
  }
}

resource "evroc_virtual_machine" "lolly" {
  name                   = var.name
  project                = var.project
  region                 = var.region
  flavor                 = var.flavor
  boot_disk              = evroc_disk.boot.fqid
  zone                   = var.zone
  public_ip              = evroc_public_ip.lolly.fqid
  security_groups        = [evroc_security_group.lolly.fqid]
  stack_type             = "dual-stack"
  ssh_keys               = sort(tolist(var.ssh_public_keys))
  cloud_config_user_data = local.cloud_config
  user_labels            = local.labels
  lifecycle { prevent_destroy = true }
}
