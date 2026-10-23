# SPDX-License-Identifier: MPL-2.0
"""Verify Lolly's signed frontend receipt (release-frontend.sig.json) with the standard library.

The receipt is signed by Lolly's scripts/release-frontend-receipt.ts: Node's
crypto.sign('sha256', canonicalJson(body), key) with a P-256 key, which gives a
DER-encoded ECDSA signature. This module carries its own small P-256 verifier,
because the Python standard library has none. It only verifies public data, so
it holds no secret and timing does not matter.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re

from preview_common import HEX64, SHA, Refusal, canonical_js_json, require, strict_json

# NIST P-256 (secp256r1) domain parameters, FIPS 186-4 D.1.2.3.
P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
A = P - 3
B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B
N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
GX = 0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296
GY = 0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5

MAX_RECEIPT_FILES = 150000  # the same bound as release-frontend-receipt.ts


def _b64url(text):
    require(isinstance(text, str) and re.fullmatch(r"[A-Za-z0-9_-]+", text), "BAD_KEY", "invalid base64url")
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def jwk_thumbprint(jwk):
    """RFC 7638 thumbprint of a public EC JWK."""
    member = {"crv": jwk["crv"], "kty": jwk["kty"], "x": jwk["x"], "y": jwk["y"]}
    digest = hashlib.sha256(json.dumps(member, sort_keys=True, separators=(",", ":")).encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def public_point(jwk):
    """Validate a public P-256 JWK and return its affine point."""
    require(isinstance(jwk, dict) and jwk.get("kty") == "EC" and jwk.get("crv") == "P-256"
            and "d" not in jwk, "BAD_KEY", "a public P-256 JWK is required")
    x_bytes, y_bytes = _b64url(jwk.get("x")), _b64url(jwk.get("y"))
    require(len(x_bytes) == 32 and len(y_bytes) == 32, "BAD_KEY", "P-256 coordinates must be 32 bytes")
    x, y = int.from_bytes(x_bytes, "big"), int.from_bytes(y_bytes, "big")
    require(x < P and y < P and (y * y - (x * x * x + A * x + B)) % P == 0, "BAD_KEY", "point is not on P-256")
    return x, y


# Jacobian arithmetic. None is the point at infinity.
def _double(point):
    if point is None:
        return None
    x, y, z = point
    if y == 0:
        return None
    yy = y * y % P
    s = 4 * x * yy % P
    zz = z * z % P
    m = 3 * (x - zz) * (x + zz) % P  # a = -3
    x3 = (m * m - 2 * s) % P
    y3 = (m * (s - x3) - 8 * yy * yy) % P
    z3 = 2 * y * z % P
    return x3, y3, z3


def _add(p1, p2):
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    x1, y1, z1 = p1
    x2, y2, z2 = p2
    z1z1, z2z2 = z1 * z1 % P, z2 * z2 % P
    u1, u2 = x1 * z2z2 % P, x2 * z1z1 % P
    s1, s2 = y1 * z2 * z2z2 % P, y2 * z1 * z1z1 % P
    if u1 == u2:
        return _double(p1) if s1 == s2 else None
    h, r = (u2 - u1) % P, (s2 - s1) % P
    hh = h * h % P
    hhh = h * hh % P
    v = u1 * hh % P
    x3 = (r * r - hhh - 2 * v) % P
    y3 = (r * (v - x3) - s1 * hhh) % P
    z3 = h * z1 * z2 % P
    return x3, y3, z3


def _multiply_add(k1, p1, k2, p2):
    """k1*p1 + k2*p2 by simultaneous double-and-add."""
    j1, j2 = (p1[0], p1[1], 1), (p2[0], p2[1], 1)
    both = _add(j1, j2)
    result = None
    for bit in range(max(k1.bit_length(), k2.bit_length()) - 1, -1, -1):
        result = _double(result)
        a, b = (k1 >> bit) & 1, (k2 >> bit) & 1
        if a and b:
            result = _add(result, both)
        elif a:
            result = _add(result, j1)
        elif b:
            result = _add(result, j2)
    return result


def _der_signature(signature):
    """Strict DER SEQUENCE { INTEGER r, INTEGER s }, as OpenSSL requires."""
    def integer(data, at):
        require(at + 2 <= len(data) and data[at] == 0x02, "BAD_SIGNATURE", "DER integer expected")
        length = data[at + 1]
        require(1 <= length <= 33 and at + 2 + length <= len(data), "BAD_SIGNATURE", "bad DER integer length")
        body = data[at + 2:at + 2 + length]
        require(body[0] < 0x80, "BAD_SIGNATURE", "negative DER integer")
        require(not (length > 1 and body[0] == 0 and body[1] < 0x80), "BAD_SIGNATURE", "non-minimal DER integer")
        return int.from_bytes(body, "big"), at + 2 + length
    require(len(signature) >= 8 and signature[0] == 0x30 and signature[1] == len(signature) - 2,
            "BAD_SIGNATURE", "bad DER sequence")
    r, at = integer(signature, 2)
    s, at = integer(signature, at)
    require(at == len(signature), "BAD_SIGNATURE", "trailing DER bytes")
    return r, s


def verify_p256(jwk, message, signature):
    """True when the DER ECDSA signature over SHA-256(message) verifies against the JWK."""
    try:
        q = public_point(jwk)
        r, s = _der_signature(signature)
    except Refusal:
        return False
    if not (1 <= r < N and 1 <= s < N):
        return False
    e = int.from_bytes(hashlib.sha256(message).digest(), "big")
    w = pow(s, -1, N)
    point = _multiply_add(e * w % N, (GX, GY), r * w % N, q)
    if point is None:
        return False
    x, _, z = point
    affine_x = x * pow(z * z % P, -1, P) % P
    return affine_x % N == r


def verify_frontend_receipt(raw, jwk, source, target="web", profile=None):
    """Return the receipt's file map after checking its signature and bindings.

    raw is the served bytes of /release-frontend.sig.json.
    """
    require(len(raw) <= 64 * 1024 * 1024, "RECEIPT_INVALID", "receipt is larger than 64 MiB")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise Refusal("RECEIPT_INVALID", "receipt is not UTF-8") from exc
    receipt = strict_json(text, "receipt")
    require(isinstance(receipt, dict) and set(receipt) == {"kind", "version", "source", "target", "profile", "files", "signature"},
            "RECEIPT_INVALID", "receipt has missing or unexpected fields")
    require(receipt["kind"] == "lolly-release-frontend" and receipt["version"] == 1, "RECEIPT_INVALID", "not a version 1 frontend receipt")
    require(isinstance(receipt["source"], str) and SHA.fullmatch(receipt["source"]), "RECEIPT_INVALID", "receipt source is not a commit")
    require(receipt["source"] == source, "RECEIPT_SOURCE", "served receipt names a different source commit")
    require(receipt["target"] == target, "RECEIPT_INVALID", "receipt target differs")
    require(profile is None or receipt["profile"] == profile, "RECEIPT_PROFILE", "served receipt names a different profile")
    files = receipt["files"]
    require(isinstance(files, dict) and 0 < len(files) <= MAX_RECEIPT_FILES, "RECEIPT_INVALID", "receipt file map is empty or too large")
    for path, digest in files.items():
        require(isinstance(path, str) and 0 < len(path) < 1024 and isinstance(digest, str) and HEX64.fullmatch(digest),
                "RECEIPT_INVALID", "receipt file entry is malformed")
    require("index.html" in files and "catalog/tools/index.sig.json" in files, "RECEIPT_INVALID", "receipt is incomplete")
    signature_text = receipt["signature"]
    require(isinstance(signature_text, str) and len(signature_text) <= 200, "RECEIPT_INVALID", "receipt signature is malformed")
    try:
        signature = base64.b64decode(signature_text, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise Refusal("RECEIPT_INVALID", "receipt signature is not base64") from exc
    body = {key: value for key, value in receipt.items() if key != "signature"}
    require(verify_p256(jwk, canonical_js_json(body).encode("utf-8"), signature),
            "RECEIPT_SIGNATURE", "receipt signature does not verify against the pinned key")
    return files


def etag_values(files, path="index.html"):
    """The delivery map's validators for one file: identity, gzip and br wire hashes.

    scripts/build-delivery.ts writes them before the receipt is signed, so the
    receipt carries the exact hash of every sidecar the map names.
    """
    values = set()
    for name in (path, path + ".gz", path + ".br"):
        if name in files:
            values.add('"' + files[name] + '"')
            values.add('W/"' + files[name] + '"')
    return values
