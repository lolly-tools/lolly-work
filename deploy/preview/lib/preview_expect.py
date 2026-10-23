# SPDX-License-Identifier: MPL-2.0
"""Expectations for one source commit, computed from that commit's own files.

Headers come from deploy/docker/security-headers.conf of the source, with the
CSP resolved from the $lolly_csp map in deploy/docker/nginx.conf and the build's
connector origins applied exactly as scripts/configure-connector-origins.ts does.
"""

from __future__ import annotations

import re

from preview_common import Refusal, require, strict_json

ADD_HEADER = re.compile(r'add_header\s+([A-Za-z0-9-]+)\s+(?:"([^"\\]*)"|\$([a-z_]+))(?:\s+always)?\s*;')
INCLUDE = re.compile(r"include\s+/etc/nginx/[a-z-]+\.conf\s*;")
CONNECT_SRC = re.compile(r"connect-src[ \t]+((?:'self'|'none')[^;\r\n]*);")
ORIGIN = re.compile(r"https://[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?/?\Z", re.I)
LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z", re.I)


def parse_connector_origins(raw):
    """Port of parseConnectorOrigins in Lolly's packages/core/src/connector-origins.ts."""
    require(isinstance(raw, str) and len(raw) <= 8192 and not re.search(r"[^\x20-\x7e]", raw),
            "CONNECTOR_ORIGINS", "connector origins must be a bounded space-separated list")
    values = re.split(r" +", raw.strip()) if raw.strip() else []
    require(len(values) <= 64, "CONNECTOR_ORIGINS", "at most 64 connector origins")
    origins = []
    for value in values:
        require(bool(ORIGIN.fullmatch(value)), "CONNECTOR_ORIGINS", "connector origins must be exact HTTPS origins")
        rest = value[len("https://"):].rstrip("/")
        host, _, port = rest.partition(":")
        host = host.lower()
        if port:
            number = int(port)
            require(1 <= number <= 65535, "CONNECTOR_ORIGINS", "connector origin port is invalid")
        require(len(host) <= 253 and not host.endswith(".") and "." in host
                and all(LABEL.fullmatch(label) for label in host.split("."))
                and not re.fullmatch(r"[0-9.]+", host), "CONNECTOR_ORIGINS", "connector origins must name a DNS host")
        origins.append("https://" + host + (f":{int(port)}" if port and int(port) != 443 else ""))
    return sorted(set(origins))


def configure_connect_src(policy, origins):
    """Port of configureDeploymentOrigins in Lolly's scripts/configure-connector-origins.ts."""
    require(bool(CONNECT_SRC.search(policy)), "HEADERS_UNPARSED", "policy has no connect-src")

    def replace(match):
        existing = match.group(1).strip().split()
        require(not any(source == "https:" or "*" in source for source in existing),
                "HEADERS_UNPARSED", "connect-src must use exact origins")
        return "connect-src " + " ".join(dict.fromkeys(existing + list(origins))) + ";"
    return CONNECT_SRC.sub(replace, policy)


def csp_default(nginx_conf):
    """The default value of `map $request_uri $lolly_csp { ... }`; `/` is served under it."""
    block = re.search(r"map \$request_uri \$lolly_csp \{\n(.*?)\n\}", nginx_conf, re.S)
    require(block is not None, "HEADERS_UNPARSED", "nginx.conf has no $lolly_csp map")
    defaults = re.findall(r'^\s*default "([^"\\]*)";\s*$', block.group(1), re.M)
    require(len(defaults) == 1, "HEADERS_UNPARSED", "the $lolly_csp map needs exactly one default")
    return defaults[0]


def expected_headers(security_headers_conf, nginx_conf, connector_origins_raw):
    """[[name, exact value], ...] for every add_header in the source's security-headers.conf."""
    origins = parse_connector_origins(connector_origins_raw)
    headers = []
    for number, line in enumerate(security_headers_conf.splitlines(), 1):
        text = line.strip()
        if not text or text.startswith("#") or INCLUDE.fullmatch(text):
            continue
        match = ADD_HEADER.fullmatch(text)
        require(match is not None, "HEADERS_UNPARSED", f"security-headers.conf line {number} is not a known directive")
        name, literal, variable = match.groups()
        if variable is not None:
            require(variable == "lolly_csp", "HEADERS_UNPARSED", f"unknown header variable ${variable}")
            value = configure_connect_src(csp_default(nginx_conf), origins)
        else:
            value = literal
        require(name.lower() not in {n.lower() for n, _ in headers}, "HEADERS_UNPARSED", "duplicate header in source")
        headers.append([name, value])
    require(any(name.lower() == "content-security-policy" for name, _ in headers),
            "HEADERS_UNPARSED", "source declares no Content-Security-Policy")
    return headers


def configured_nginx_conf(nginx_conf, connector_origins_raw):
    """The default.conf the web image carries (configure-connector-origins.ts output)."""
    origins = parse_connector_origins(connector_origins_raw)
    require(bool(CONNECT_SRC.search(nginx_conf)), "HEADERS_UNPARSED", "nginx.conf has no connection policy")
    return configure_connect_src(nginx_conf, origins)


def models_sample(manifest_bytes):
    """The smallest non-empty model file in the build's models manifest."""
    entries = strict_json(manifest_bytes.decode("utf-8"), "models manifest")
    require(isinstance(entries, list) and entries, "MODELS_MANIFEST", "models manifest is empty")
    best = None
    for entry in entries:
        require(isinstance(entry, dict) and isinstance(entry.get("url"), str) and type(entry.get("size")) is int,
                "MODELS_MANIFEST", "models manifest entry is malformed")
        url, size = entry["url"], entry["size"]
        require(re.fullmatch(r"/models/[A-Za-z0-9._@/-]{1,900}", url) is not None and ".." not in url,
                "MODELS_MANIFEST", "model URL is unsafe")
        if size > 0 and (best is None or (size, url) < (best["size"], best["url"])):
            best = {"url": url, "size": size}
    require(best is not None, "MODELS_MANIFEST", "models manifest has no non-empty file")
    return best


def stored_formats(read_file, anchors):
    """Read each anchored stored-format version from the source; None when absent or ambiguous."""
    formats = {}
    for name, (path, pattern) in sorted(anchors.items()):
        try:
            text = read_file(path).decode("utf-8")
        except Refusal:
            formats[name] = None
            continue
        found = re.findall(pattern, text)
        formats[name] = int(found[0]) if len(found) == 1 else None
    return formats


def format_lowering(live, target):
    """Names of stored formats the target would lower, or that cannot be compared."""
    problems = []
    if not isinstance(live, dict) or not isinstance(target, dict) or not live:
        return ["unknown"]
    for name in sorted(set(live) | set(target)):
        a, b = live.get(name), target.get(name)
        if type(a) is not int or type(b) is not int:
            problems.append(name + ":unknown")
        elif b < a:
            problems.append(f"{name}:{a}->{b}")
    return problems
