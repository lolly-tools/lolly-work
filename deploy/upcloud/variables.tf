# SPDX-License-Identifier: MPL-2.0
variable "hostname" {
  description = "Host label; DNS records are managed separately from this module."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{0,251}[a-z0-9]$", var.hostname))
    error_message = "Use a lowercase DNS hostname."
  }
}

variable "zone" {
  description = "UpCloud location for the server and its storage."
  type        = string
  default     = "de-fra1"
}

variable "plan" {
  description = "Select and price the VM plan before applying."
  type        = string
  default     = "CLOUDNATIVE-2xCPU-4GB"
}

variable "template_uuid" {
  description = "Qualified cloud-init image UUID. For the openSUSE VM kit, supply an imported openSUSE image."
  type        = string
  validation {
    condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.template_uuid))
    error_message = "Supply the UUID of a qualified UpCloud template; no operating system is selected implicitly."
  }
}

variable "root_disk_gb" {
  description = "Root disk size; signed shells and retained releases need substantial headroom."
  type        = number
  default     = 80
  validation {
    condition     = var.root_disk_gb >= 50 && floor(var.root_disk_gb) == var.root_disk_gb
    error_message = "Use an integer of at least 50 GB."
  }
}

variable "root_disk_tier" {
  description = "Select and price the root storage explicitly; Standard suits a cost-conscious Starter candidate."
  type        = string
  default     = "maxiops"
  validation {
    condition     = contains(["standard", "maxiops"], var.root_disk_tier)
    error_message = "Use standard or maxiops for the boot disk."
  }
}

variable "ssh_user" {
  description = "Image's cloud-init login account (sles for the openSUSE Leap image)."
  type        = string
  default     = "sles"
}

variable "ssh_public_keys" {
  description = "Public keys only. Private keys never enter state or cloud-init."
  type        = set(string)
  validation {
    condition     = length(var.ssh_public_keys) > 0 && alltrue([for key in var.ssh_public_keys : can(regex("^(ssh-ed25519|ssh-rsa|ecdsa-sha2-[^ ]+) [A-Za-z0-9+/=]+", key))])
    error_message = "Provide at least one SSH public key."
  }
}

variable "ssh_allowed_cidrs" {
  description = "IPv4/IPv6 administrator networks; SSH is closed to all other sources."
  type        = set(string)
  validation {
    condition     = length(var.ssh_allowed_cidrs) > 0 && alltrue([for network in var.ssh_allowed_cidrs : can(cidrhost(network, 0)) && !can(regex("/0+$", network))])
    error_message = "Provide valid administrator CIDRs, without an all-addresses /0 network."
  }
}

variable "labels" {
  description = "Additional inventory labels."
  type        = map(string)
  default     = {}
}

variable "ephemeral_port_range" {
  description = "Measured Linux ip_local_port_range for stateless response rules; keep below-hosted and NodePort ports excluded."
  type        = object({ start = number, end = number })
  default     = { start = 32768, end = 60999 }
  validation {
    condition     = var.ephemeral_port_range.start >= 32768 && var.ephemeral_port_range.end <= 65535 && var.ephemeral_port_range.start <= var.ephemeral_port_range.end && floor(var.ephemeral_port_range.start) == var.ephemeral_port_range.start && floor(var.ephemeral_port_range.end) == var.ephemeral_port_range.end
    error_message = "Use the measured integer ephemeral range between 32768 and 65535; never include application, Kubernetes API or NodePort ports."
  }
}

variable "dns_resolver_cidrs" {
  description = "Measured DNS resolver addresses, each an exact IPv4 /32 or IPv6 /128; required for stateless DNS responses."
  type        = set(string)
  validation {
    condition     = length(var.dns_resolver_cidrs) > 0 && alltrue([for network in var.dns_resolver_cidrs : can(cidrhost(network, 0)) && can(regex(strcontains(network, ":") ? "/128$" : "/32$", network))])
    error_message = "Provide each actual DNS resolver as a single-host /32 or /128 CIDR."
  }
}

variable "dns_response_port_range" {
  description = "Optional separately reviewed DNS reply destination range for randomized pod SNAT. Only TCP/UDP source port 53 from dns_resolver_cidrs uses it; null preserves ephemeral_port_range. Requires a stateful host firewall."
  type        = object({ start = number, end = number })
  default     = null
  validation {
    condition     = var.dns_response_port_range == null ? true : var.dns_response_port_range.start >= 1024 && var.dns_response_port_range.end <= 65535 && var.dns_response_port_range.start <= var.dns_response_port_range.end && floor(var.dns_response_port_range.start) == var.dns_response_port_range.start && floor(var.dns_response_port_range.end) == var.dns_response_port_range.end
    error_message = "Use an explicitly reviewed integer DNS return range between 1024 and 65535; trusted resolver source port 53 and stateful host rejection of unsolicited packets remain required."
  }
}

variable "ntp_server_cidrs" {
  description = "Optional measured time server addresses, each an exact /32 or /128; qualify the client's actual UDP response destination separately."
  type        = set(string)
  default     = []
  validation {
    condition     = alltrue([for network in var.ntp_server_cidrs : can(cidrhost(network, 0)) && can(regex(strcontains(network, ":") ? "/128$" : "/32$", network))])
    error_message = "Time server response rules require single-host /32 or /128 CIDRs."
  }
}
