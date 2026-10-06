# SPDX-License-Identifier: MPL-2.0
variable "name" {
  description = "Name prefix for new VM, disk, public IP and security group resources."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,40}$", var.name))
    error_message = "Use a lowercase resource name of 2-41 letters, digits and hyphens."
  }
}

variable "project" {
  description = "Explicit evroc project ID; no CLI default project is selected implicitly."
  type        = string
  validation {
    condition     = length(trimspace(var.project)) > 0
    error_message = "Select the deployment project."
  }
}

variable "region" {
  description = "Qualified evroc region available to this project."
  type        = string
  validation {
    condition     = length(trimspace(var.region)) > 0
    error_message = "Select the deployment region."
  }
}

variable "zone" {
  description = "Zone available within the selected region."
  type        = string
  default     = "a"
}

variable "flavor" {
  description = "Qualified compute profile; inspect availability and price before applying."
  type        = string
  validation {
    condition     = length(trimspace(var.flavor)) > 0
    error_message = "Supply a qualified compute profile."
  }
}

variable "disk_image" {
  description = "Qualified cloud-init image name from the project's disk-image inventory."
  type        = string
  validation {
    condition     = length(trimspace(var.disk_image)) > 0
    error_message = "Supply a qualified image; no operating system is selected implicitly."
  }
}

variable "root_disk_gb" {
  description = "Boot disk capacity for signed shells and retained releases."
  type        = number
  default     = 80
  validation {
    condition     = var.root_disk_gb >= 50 && floor(var.root_disk_gb) == var.root_disk_gb
    error_message = "Use an integer of at least 50 GB."
  }
}

variable "ssh_user" {
  description = "Account created by the complete custom cloud-init configuration."
  type        = string
  default     = "evroc-user"
  validation {
    condition     = can(regex("^[a-z_][a-z0-9_-]{0,30}$", var.ssh_user)) && var.ssh_user != "root"
    error_message = "Choose a valid non-root login account."
  }
}

variable "ssh_sudo_group" {
  description = "Image's administrator group (sudo on Ubuntu/Debian, wheel on a qualified SUSE image)."
  type        = string
  default     = "sudo"
}

variable "ssh_public_keys" {
  description = "Public keys only; no private key enters cloud-init or state."
  type        = set(string)
  validation {
    condition     = length(var.ssh_public_keys) > 0 && alltrue([for key in var.ssh_public_keys : can(regex("^(ssh-ed25519|ssh-rsa|ecdsa-sha2-[^ ]+) [A-Za-z0-9+/=]+", key))])
    error_message = "Provide at least one SSH public key."
  }
}

variable "ssh_allowed_cidrs" {
  description = "Administrator networks; at most 40 fit alongside web/control/egress rules."
  type        = set(string)
  validation {
    condition     = length(var.ssh_allowed_cidrs) > 0 && length(var.ssh_allowed_cidrs) <= 40 && alltrue([for network in var.ssh_allowed_cidrs : can(cidrhost(network, 0)) && !can(regex("/0+$", network))])
    error_message = "Provide 1-40 administrator CIDRs without an all-addresses /0 network."
  }
}

variable "labels" {
  description = "Additional inventory labels."
  type        = map(string)
  default     = {}
}
