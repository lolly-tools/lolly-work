# SPDX-License-Identifier: MPL-2.0
"""Post-switch smoke and watch probes for lolly.tools (PROPOSAL 3.3).

Runs on the node against the real edge with normal TLS verification, no
redirect following, no cookies and no credentials. Response bodies are hashed,
never logged.
"""

from __future__ import annotations

import hashlib
import json
import socket
import ssl
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

from preview_common import Refusal, require, strict_json
from preview_receipt import etag_values, verify_frontend_receipt

MAX_BODY = 64 * 1024 * 1024


class Response:
    def __init__(self, status, headers, body):
        self.status = status
        self.headers = headers  # list of (name, value)
        self.body = body

    def header_values(self, name):
        return [value for key, value in self.headers if key.lower() == name.lower()]

    def header(self, name):
        values = self.header_values(name)
        return values[0] if len(values) == 1 else None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def http_fetch(url, method="GET", headers=None, limit=MAX_BODY):
    """One HTTPS request. Redirects are returned, never followed."""
    parts = urlsplit(url)
    require(parts.scheme == "https" and parts.hostname and not parts.username and not parts.password,
            "BAD_INPUT", "smoke URLs must be credential-free HTTPS")
    request = urllib.request.Request(url, method=method, headers=dict(headers or {}))
    request.add_header("Accept-Encoding", "identity")
    request.add_header("User-Agent", "lolly-preview-deploy")
    opener = urllib.request.build_opener(_NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    try:
        response = opener.open(request, timeout=20)
    except urllib.error.HTTPError as error:
        response = error
    except (OSError, urllib.error.URLError) as exc:
        raise Refusal("SMOKE_TRANSPORT", f"{method} {parts.path or '/'} failed: {type(exc).__name__}") from exc
    try:
        body = b"" if method == "HEAD" else response.read(limit + 1)
        require(len(body) <= limit, "SMOKE_TRANSPORT", "response exceeds its bound")
        return Response(response.status if hasattr(response, "status") else response.code,
                        list(response.headers.items()), body)
    finally:
        response.close()


# Replaced by tests; production code always uses http_fetch.
FETCH = http_fetch


def _sha(body):
    return hashlib.sha256(body).hexdigest()


class Checks:
    def __init__(self):
        self.items = []

    def record(self, name, ok, detail=""):
        self.items.append({"check": name, "ok": bool(ok), "detail": detail})
        return ok

    @property
    def ok(self):
        return bool(self.items) and all(item["ok"] for item in self.items)

    def failures(self):
        return [item for item in self.items if not item["ok"]]


def _get(checks, name, url, **kwargs):
    try:
        return FETCH(url, **kwargs)
    except Refusal as exc:
        checks.record(name, False, exc.message)
        return None


def _ids_with_prefix(document, key, prefix):
    items = document.get(key) if isinstance(document, dict) else None
    if not isinstance(items, list):
        return None
    return sorted({item.get("id") for item in items if isinstance(item, dict) and isinstance(item.get("id"), str)
                   and item["id"].lower().startswith(prefix)})


def check_dns(anchors, edge_address):
    for origin in (anchors["origin"], anchors["wwwOrigin"]):
        host = urlsplit(origin).hostname
        try:
            found = sorted({info[4][0] for info in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)})
        except OSError as exc:
            raise Refusal("SMOKE_DNS", f"{host} does not resolve on the node") from exc
        require(found == [edge_address], "SMOKE_DNS", f"{host} does not resolve only to the edge address")


def smoke(expect, anchors, public_jwk, pod_check=None, extra_pages=None, exact_headers=True):
    """Run every check; return (Checks, receipt files or None).

    extra_pages is a callable that gets the verified receipt file map and returns
    more {path, file} pages to check, such as /info pages this build added.
    """
    checks, origin = Checks(), anchors["origin"]
    files = None
    receipt = _get(checks, "receipt", origin + "/release-frontend.sig.json", limit=MAX_BODY)
    if receipt is not None:
        if receipt.status != 200:
            checks.record("receipt", False, f"HTTP {receipt.status}")
        else:
            try:
                files = verify_frontend_receipt(receipt.body, public_jwk, expect["source"], anchors["receiptTarget"], expect["profile"])
                checks.record("receipt", True, f"signed by the pin; source {expect['source'][:12]}; {len(files)} files")
            except Refusal as exc:
                checks.record("receipt", False, exc.code)
    root = _get(checks, "root", origin + "/")
    if root is not None:
        etag = root.header("ETag")
        body_ok = files is not None and root.status == 200 and _sha(root.body) == files.get("index.html")
        etag_ok = files is not None and etag in etag_values(files)
        checks.record("root", body_ok and etag_ok,
                      f"HTTP {root.status}; body {'matches' if body_ok else 'differs from'} the signed index.html; "
                      f"ETag {'is' if etag_ok else 'is not'} a delivery-map value")
        if exact_headers:
            bad = [name for name, value in expect["headers"] if root.header_values(name) != [value]]
            checks.record("headers", not bad, "all source security headers served exactly" if not bad
                          else "differs: " + ", ".join(bad))
    for path, key in (("/catalog/tools/index.json", "tools"), ("/catalog/tools/index.sig.json", None),
                      ("/catalog/assets/index.json", "assets")):
        file = path.lstrip("/")
        response = _get(checks, "catalog " + file, origin + path)
        if response is None:
            continue
        ok = files is not None and response.status == 200 and _sha(response.body) == files.get(file)
        detail = f"HTTP {response.status}; hash {'matches' if ok else 'differs from'} the receipt"
        if ok and key:
            try:
                document = strict_json(response.body.decode("utf-8"), file)
            except (Refusal, UnicodeDecodeError):
                document = None
            found = _ids_with_prefix(document, key, anchors["forbiddenIdPrefix"])
            if found is None:
                ok, detail = False, f"{file} has no {key} list"
            elif found:
                ok, detail = False, f"{len(found)} {key} ids start with {anchors['forbiddenIdPrefix']!r}"
        checks.record("catalog " + file, ok, detail)
    redirect = _get(checks, "redirect", anchors["wwwOrigin"] + "/")
    if redirect is not None:
        checks.record("redirect", redirect.status == 308 and redirect.header("Location") == origin + "/",
                      f"HTTP {redirect.status} to {redirect.header('Location')!r}")
    health = _get(checks, "healthz", origin + "/healthz")
    if health is not None:
        checks.record("healthz", health.status == 200, f"HTTP {health.status}")
    more = extra_pages(files) if (extra_pages and files is not None) else []
    for page in list(expect["pages"]) + list(more):
        response = _get(checks, "page " + page["path"], origin + page["path"])
        if response is None:
            continue
        expected = files.get(page["file"]) if files else None
        checks.record("page " + page["path"], response.status == 200 and expected is not None and _sha(response.body) == expected,
                      f"HTTP {response.status}; " + ("not in the receipt" if expected is None else
                                                     "hash matches" if _sha(response.body) == expected else "hash differs"))
    model = expect["models"]
    head = _get(checks, "model head", origin + model["url"], method="HEAD")
    if head is not None:
        checks.record("model head", head.status == 200 and head.header("Content-Length") == str(model["size"]),
                      f"HTTP {head.status}; length {head.header('Content-Length')}")
    ranged = _get(checks, "model range", origin + model["url"], headers={"Range": "bytes=0-0"})
    if ranged is not None:
        checks.record("model range", ranged.status == 206 and len(ranged.body) == 1
                      and ranged.header("Content-Range") == f"bytes 0-0/{model['size']}", f"HTTP {ranged.status}")
    if pod_check is not None:
        ok, detail = pod_check(memory=True)
        checks.record("pod", ok, detail)
    return checks, files


def added_info_pages(new_files, old_files, limit):
    """New /info pages in this build, shortest paths first (English before locales)."""
    if not new_files or old_files is None:
        return []
    added = [path for path in new_files if path.startswith("info/") and path.endswith(".html") and path not in old_files]
    added.sort(key=lambda path: (path.count("/"), path))
    return [{"path": "/" + path, "file": path} for path in added[:limit]]


def watch_probe(expect_index_sha, anchors, pod_check):
    """One watch probe: `/` serves the expected bytes, /healthz answers, the Pod is healthy."""
    problems = []
    for path, want_sha in (("/", expect_index_sha), ("/healthz", None)):
        try:
            response = FETCH(anchors["origin"] + path)
            if response.status != 200 or (want_sha and _sha(response.body) != want_sha):
                problems.append(f"{path} HTTP {response.status}")
        except Refusal as exc:
            problems.append(f"{path} {exc.code}")
    ok, detail = pod_check(memory=False)
    if not ok:
        problems.append(detail)
    return problems


def watch(expect_index_sha, anchors, pod_check, minutes, interval, failures_allowed, sleep=time.sleep, clock=time.monotonic, log=None):
    """Probe until the window ends. Return None, or the reason after N consecutive failures."""
    deadline, consecutive = clock() + minutes * 60, 0
    while clock() < deadline:
        problems = watch_probe(expect_index_sha, anchors, pod_check)
        consecutive = consecutive + 1 if problems else 0
        if log and problems:
            log("watch-probe-failed", problems=problems, consecutive=consecutive)
        if consecutive >= failures_allowed:
            return "; ".join(problems)
        sleep(interval)
    ok, detail = pod_check(memory=True)
    return None if ok else detail


def summary(checks):
    return json.dumps([item for item in checks.items if not item["ok"]] or "all passed")
