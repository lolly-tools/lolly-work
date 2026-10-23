# SPDX-License-Identifier: MPL-2.0
"""Shared helpers for the preview deploy command. Python 3.9+ standard library only."""

from __future__ import annotations

import datetime
import hashlib
import json
import os
import re
import sys

SHA = re.compile(r"[0-9a-f]{40}\Z")
HEX64 = re.compile(r"[0-9a-f]{64}\Z")
RUN_ID = re.compile(r"[1-9][0-9]{0,15}\Z")
DEPLOY_ID = re.compile(r"[0-9]{8}T[0-9]{6}Z-[a-z0-9-]{1,40}\Z")


class Refusal(RuntimeError):
    """A named reason to stop before (or instead of) changing anything."""

    def __init__(self, code, message):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


def require(condition, code, message):
    if not condition:
        raise Refusal(code, message)


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc)


def utc_stamp(moment=None):
    return (moment or utc_now()).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_utc(text):
    """Parse the GitHub and Kubernetes timestamp form 2026-10-23T04:00:01Z."""
    require(isinstance(text, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", text),
            "BAD_TIMESTAMP", "expected a UTC timestamp")
    return datetime.datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)


def sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


def strict_json(text, label="JSON"):
    """Parse JSON, refusing duplicate keys and non-finite numbers."""
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "BAD_JSON", f"{label} has a duplicate key")
            result[key] = value
        return result

    def constant(_):
        raise Refusal("BAD_JSON", f"{label} has a non-finite number")
    try:
        return json.loads(text, object_pairs_hook=unique, parse_constant=constant)
    except ValueError as exc:
        raise Refusal("BAD_JSON", f"{label} is not valid JSON") from exc


def compact(value):
    """Stable compact JSON for annotations and hashes (sorted keys, no spaces)."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def compact_digest(value):
    return sha256_hex(compact(value).encode())


def _js_string(text):
    # Fast path: printable ASCII with nothing to escape is emitted as is.
    if text.isascii() and text.isprintable() and '"' not in text and "\\" not in text:
        return '"' + text + '"'
    out = ['"']
    for char in text:
        code = ord(char)
        if char == '"':
            out.append('\\"')
        elif char == "\\":
            out.append("\\\\")
        elif char == "\b":
            out.append("\\b")
        elif char == "\f":
            out.append("\\f")
        elif char == "\n":
            out.append("\\n")
        elif char == "\r":
            out.append("\\r")
        elif char == "\t":
            out.append("\\t")
        elif code < 0x20 or 0xD800 <= code <= 0xDFFF:
            # JSON.stringify escapes control characters and lone surrogates.
            out.append("\\u%04x" % code)
        else:
            out.append(char)
    out.append('"')
    return "".join(out)


def _utf16_key(text):
    return text.encode("utf-16-be", "surrogatepass")


def canonical_js_json(value):
    """Byte-for-byte port of Lolly's engine/src/canonical-json.ts (JSON.stringify rules).

    Only the value kinds a signed receipt can hold are accepted. Non-integer
    numbers are refused because JavaScript and Python format them differently.
    """
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        require(abs(value) <= 2 ** 53, "BAD_JSON", "integer outside the exact JavaScript range")
        return str(value)
    if isinstance(value, str):
        return _js_string(value)
    if isinstance(value, list):
        return "[" + ",".join(canonical_js_json(item) for item in value) + "]"
    if isinstance(value, dict):
        parts = []
        for key in sorted(value, key=_utf16_key):
            require(isinstance(key, str), "BAD_JSON", "object keys must be strings")
            parts.append(_js_string(key) + ":" + canonical_js_json(value[key]))
        return "{" + ",".join(parts) + "}"
    raise Refusal("BAD_JSON", "unsupported value in canonical JSON")


def emit(event, **fields):
    """One JSON progress line on stdout. Never pass response bodies or secrets."""
    record = {"t": utc_stamp(), "event": event}
    record.update(fields)
    print(json.dumps(record, sort_keys=True), flush=True)


def write_private_new(path, text):
    """Create a new 0600 file; never overwrite."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as out:
        out.write(text)


def require_python():
    require(sys.version_info >= (3, 9), "PYTHON_TOO_OLD", "Python 3.9 or newer is required")
