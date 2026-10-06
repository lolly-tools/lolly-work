# SPDX-License-Identifier: MPL-2.0
output "server_id" {
  description = "Fully qualified VM ID."
  value       = evroc_virtual_machine.lolly.fqid
}

output "public_ipv4" {
  description = "Allocated address for pre-DNS tests."
  value       = evroc_virtual_machine.lolly.public_ipv4_address
}

output "public_ipv6" {
  description = "Dual-stack IPv6 address; publish DNS only after qualification."
  value       = evroc_virtual_machine.lolly.ipv6_address
}
