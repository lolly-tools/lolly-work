# SPDX-License-Identifier: MPL-2.0
terraform {
  required_version = ">= 1.9, < 2.0"
  required_providers {
    evroc = {
      source  = "registry.terraform.io/evroc-oss/evroc"
      version = "0.9.5"
    }
  }
}

# Authentication comes from the existing CLI config or provider environment.
provider "evroc" {
  project = var.project
  region  = var.region
}
