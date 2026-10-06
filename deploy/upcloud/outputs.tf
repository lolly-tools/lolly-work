# SPDX-License-Identifier: MPL-2.0
output "server_id" {
  description = "UpCloud server UUID."
  value       = upcloud_server.lolly.id
}

output "public_ipv4" {
  description = "Address for pre-DNS tests; this module does not change DNS."
  value       = one([for nic in upcloud_server.lolly.network_interface : nic.ip_address if nic.type == "public" && nic.ip_address_family == "IPv4"])
}
