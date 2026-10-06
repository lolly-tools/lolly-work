# SPDX-License-Identifier: MPL-2.0
terraform {
  required_version = ">= 1.9, < 2.0"
  required_providers {
    upcloud = {
      source  = "registry.terraform.io/UpCloudLtd/upcloud"
      version = "5.45.0"
    }
  }
}

# API credentials come from UPCLOUD_TOKEN or the provider's environment variables.
provider "upcloud" {}
