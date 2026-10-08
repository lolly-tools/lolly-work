# SPDX-License-Identifier: MPL-2.0
# The reviewed source checkout must already be available to this minion.
{% set profile = salt['pillar.get']('lolly:host_profile', 'k3s') %}
{% set host = salt['pillar.get']('lolly:expected_host', '') %}
{% set checkout = salt['pillar.get']('lolly:source_checkout', '') %}
{% if profile not in ['k3s', 'rke2', 'podman-build'] or not host or not checkout.startswith('/') %}
lolly-host-selection-required:
  test.fail_without_changes:
    - name: Provide an exact hostname, absolute reviewed source checkout and supported profile
{% else %}
{% set command = 'python3 ' ~ ((checkout ~ '/deploy/suse/host-readiness.py') | quote) ~ ' --profile ' ~ (profile | quote) ~ ' --expect-host ' ~ (host | quote) ~ ' --salt-stateful' %}
lolly-host-readiness:
  cmd.run:
    - name: {{ command | tojson }}
    - python_shell: false
    - timeout: 90
    - stateful: true
    - output_loglevel: quiet
{% endif %}
