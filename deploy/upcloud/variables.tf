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
