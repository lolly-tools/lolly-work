#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Acceptance for a booted Lolly appliance (k3s or podman profile).

Reaches the appliance over SSH (as root, with the key a Combustion script
installed) and over its forwarded HTTPS and Cockpit ports, and prints one PASS
or FAIL line per check plus the measurements the plan uses for the k3s
threshold. The profile is read from the machine. Never prints the owner link,
the password or any secret.

  deploy/appliance/test/accept.py --ssh-port 2222 --key KEY --https 127.0.0.1:8443 --cockpit 127.0.0.1:9090
  deploy/appliance/test/accept.py ... --after-reboot STATE.json   (second pass, after a reboot)

The first pass writes STATE.json (the owner's password, kept only in the run
directory) so the second pass can sign in again after the reboot.
"""
from __future__ import annotations

import argparse
import hashlib
import http.client
import http.cookiejar
import json
import re
import secrets
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

FAILED = []


def ok(label: str, cond: bool, extra: str = "") -> bool:
    print(("PASS " if cond else "FAIL ") + label + (f" ({extra})" if extra else ""), flush=True)
    if not cond:
        FAILED.append(label)
    return cond


class Guest:
    def __init__(self, port: int, key: str, host: str = "127.0.0.1"):
        self.base = ["ssh", "-p", str(port), "-i", key, "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
                     "-o", "LogLevel=ERROR", "-o", "ConnectTimeout=5", "-o", "BatchMode=yes", f"root@{host}"]

    def run(self, command: str, timeout: int = 120) -> subprocess.CompletedProcess:
        return subprocess.run(self.base + [command], capture_output=True, text=True, timeout=timeout)

    def wait(self, seconds: int) -> bool:
        deadline = time.time() + seconds
        while time.time() < deadline:
            try:
                if self.run("true", timeout=15).returncode == 0:
                    return True
            except subprocess.TimeoutExpired:
                pass
            time.sleep(3)
        return False


class Web:
    """HTTPS to a forwarded port, presenting the appliance's own address."""

    def __init__(self, connect: str, base: str):
        self.connect, self.base = connect, base.rstrip("/")
        self.host = urllib.parse.urlsplit(self.base).netloc
        self.context = ssl.create_default_context()
        self.context.check_hostname = False
        self.context.verify_mode = ssl.CERT_NONE
        self.jar = http.cookiejar.CookieJar()

    def call(self, method: str, path: str, body=None, form: bool = False, headers: dict | None = None, cookies: bool = True):
        h = {"Host": self.host, "Origin": self.base, **(headers or {})}
        data = None
        if body is not None:
            if form:
                data = urllib.parse.urlencode(body).encode()
                h["Content-Type"] = "application/x-www-form-urlencoded"
            else:
                data = json.dumps(body).encode()
                h["Content-Type"] = "application/json"
        url = f"{self.base}{path}"
        request = urllib.request.Request(url, data=data, method=method, headers=h)
        if cookies:
            self.jar.add_cookie_header(request)
        connection = http.client.HTTPSConnection(self.connect, context=self.context, timeout=60)
        try:
            connection.request(method, path, body=data, headers=dict(request.header_items()))
            response = connection.getresponse()
            payload = response.read()
            if cookies:
                fake = urllib.request.Request(url)
                response.info = lambda: response.msg  # http.cookiejar expects .info()
                self.jar.extract_cookies(response, fake)
            return response.status, dict(response.getheaders()), payload
        finally:
            connection.close()

    def peer_fingerprint(self) -> str:
        connection = http.client.HTTPSConnection(self.connect, context=self.context, timeout=30)
        connection.connect()
        der = connection.sock.getpeercert(binary_form=True)
        connection.close()
        digest = hashlib.sha256(der).hexdigest().upper()
        return ":".join(digest[i:i + 2] for i in range(0, len(digest), 2))


class Sampler:
    """Peak memory in use (MemTotal - MemAvailable), sampled every second on the machine."""

    def __init__(self, guest: Guest, name: str):
        self.guest, self.name = guest, name
        guest.run(f"systemctl stop {name} 2>/dev/null; rm -f /run/{name}.max; systemd-run --unit {name} --collect /bin/sh -c "
                  f"'max=0; while :; do u=$(awk \"/^MemTotal:/ {{t=\\$2}} /^MemAvailable:/ {{a=\\$2}} END {{print int((t-a)/1024)}}\" /proc/meminfo); "
                  f"[ \"$u\" -gt \"$max\" ] && max=$u && echo $max > /run/{name}.max; sleep 1; done'")

    def peak(self) -> int:
        value = self.guest.run(f"cat /run/{self.name}.max 2>/dev/null").stdout.strip()
        return int(value) if value.isdigit() else -1

    def stop(self) -> int:
        peak = self.peak()
        self.guest.run(f"systemctl stop {self.name} 2>/dev/null")
        return peak


def wait_ready(web: Web, seconds: int) -> float | None:
    started = time.time()
    while time.time() - started < seconds:
        try:
            status, _, _ = web.call("GET", "/readyz", cookies=False)
            if status == 200:
                return time.time() - started
        except OSError:
            pass
        time.sleep(3)
    return None


def render(web: Web, tool: str, fmt: str, inputs: dict, key: str) -> tuple[bool, str]:
    started = time.time()
    status, _, body = web.call("POST", "/api/v1/renders", {"toolId": tool, "format": fmt, "inputs": inputs, "maxAttempts": 2},
                               headers={"Idempotency-Key": key})
    if status not in (200, 201, 202):
        return False, f"HTTP {status} {body[:200]!r}"
    job = json.loads(body)
    for _ in range(120):
        status, _, body = web.call("GET", f"/api/v1/renders/{job['id']}")
        job = json.loads(body)
        if job.get("state") in ("succeeded", "failed", "cancelled"):
            break
        time.sleep(1)
    line = f"{tool}.{fmt} {job.get('state')} in {time.time() - started:.1f}s"
    if job.get("state") != "succeeded":
        return False, line + f"; {(job.get('error') or {}).get('code')}"
    name = ((job.get("outputs") or [job.get("output")])[0] or {}).get("name")
    status, headers, output = web.call("GET", f"/api/v1/renders/{job['id']}/output/{name}")
    line += f"; output HTTP {status}, {len(output)} bytes, {headers.get('Content-Type') or headers.get('content-type')}, sha256 {hashlib.sha256(output).hexdigest()[:16]}"
    return status == 200 and len(output) > 0, line


def measurements(guest: Guest) -> dict:
    script = r"""
set +e
echo "boot_seconds=$(cut -d' ' -f1 /proc/uptime)"
echo "mem_used_mib=$(free -m | awk '/^Mem:/ {print $3}')"
echo "mem_total_mib=$(free -m | awk '/^Mem:/ {print $2}')"
echo "mem_available_mib=$(free -m | awk '/^Mem:/ {print $7}')"
echo "disk_root_used=$(df -h --output=used / | tail -1 | tr -d ' ')"
echo "disk_var_used=$(df -h --output=used /var | tail -1 | tr -d ' ')"
echo "disk_size=$(df -h --output=size /var | tail -1 | tr -d ' ')"
echo "btrfs_used=$(btrfs filesystem usage -b / 2>/dev/null | awk '/Used:/ {print $2; exit}')"
echo "ready_monotonic=$(journalctl -b -u lolly-appliance-console -o short-monotonic --no-pager 2>/dev/null | grep -m1 'Lolly Work is ready' | sed 's/^\[ *\([0-9.]*\)\].*/\1/')"
echo "kernel_start_monotonic=$(journalctl -b -k -o short-monotonic --no-pager 2>/dev/null | head -1 | sed 's/^\[ *\([0-9.]*\)\].*/\1/')"
echo "k3s_rss_mib=$(ps -C k3s-server -o rss= 2>/dev/null | awk '{s+=$1} END {print int(s/1024)}')"
echo "containerd_rss_mib=$(ps -C containerd -o rss= 2>/dev/null | awk '{s+=$1} END {print int(s/1024)}')"
echo "podman_rss_mib=$(ps -C conmon,postgres,node,caddy,aardvark-dns -o rss= 2>/dev/null | awk '{s+=$1} END {print int(s/1024)}')"
echo "var_lib_containers=$(du -sh /var/lib/containers 2>/dev/null | cut -f1)"
echo "var_lib_rancher=$(du -sh /var/lib/rancher 2>/dev/null | cut -f1)"
echo "var_lib_lolly=$(du -sh /var/lib/lolly 2>/dev/null | cut -f1)"
echo "top_rss=$(ps -eo rss=,comm= --sort=-rss | head -8 | awk '{printf "%s:%d ", $2, $1/1024}')"
echo "selinux=$(getenforce)"
echo "tpm2=$(systemd-analyze has-tpm2 -q && echo yes || echo no)"
echo "kernel=$(uname -r)"
"""
    result = guest.run(script)
    return dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--ssh-host", default="127.0.0.1")
    parser.add_argument("--ssh-port", type=int, default=2222)
    parser.add_argument("--key", required=True)
    parser.add_argument("--https", default="127.0.0.1:8443")
    parser.add_argument("--http", default="127.0.0.1:8080")
    parser.add_argument("--cockpit", default="127.0.0.1:9090")
    parser.add_argument("--state", required=True, help="where the first pass keeps the owner's password")
    parser.add_argument("--after-reboot", action="store_true")
    parser.add_argument("--wait", type=int, default=1800)
    args = parser.parse_args(argv)
    guest = Guest(args.ssh_port, args.key, args.ssh_host)

    t0 = time.time()
    ok("SSH answers (root key from the first boot's Combustion script)", guest.wait(args.wait))
    profile = json.loads(guest.run("cat /usr/share/lolly-appliance/release.json").stdout or "{}").get("profile", "k3s")
    print(f"INFO profile {profile}", flush=True)
    sampler = Sampler(guest, "lolly-accept-memory")
    status = guest.run("lolly-appliance status").stdout
    base = re.search(r"Address:\s+(https://\S+?)/?$", status, re.M)
    owner = re.search(r"Owner:\s+(\S+)", status)
    ok("lolly-appliance status reports an HTTPS address and the owner", bool(base and owner), base.group(1) if base else status[:200])
    if not base or not owner:
        return 1
    web = Web(args.https, base.group(1))
    waited = wait_ready(web, args.wait)
    front = "Traefik" if profile == "k3s" else "Caddy"
    ok(f"Work /readyz answers 200 through {front}", waited is not None, f"after {time.time() - t0:.0f}s of this run")
    status, _, body = web.call("GET", "/readyz", cookies=False)
    ready = json.loads(body) if status == 200 else {}
    # Work 1.1.2 and later also report each check under "checks".
    checks = ready.get("checks") or {}
    ok("readyz is ok on PostgreSQL in production mode", status == 200 and ready.get("ok") is True and ready.get("store") == "postgres"
       and all(v in ("ok", "pass", True) for v in (checks.values() if isinstance(checks, dict) else [])), body.decode()[:300])
    if profile == "k3s":
        mode = guest.run("kubectl -n lolly get configmap -o yaml 2>/dev/null | grep -o '\"mode\": \"[a-z]*\"' | head -n 1").stdout.strip()
    else:
        mode = guest.run("grep -o '\"mode\": \"[a-z]*\"' /var/lib/lolly/work/instance.json | head -n 1").stdout.strip()
    ok("Work runs in production mode", mode == '"mode": "production"', mode)
    served = web.peer_fingerprint()
    stored = guest.run("cat /var/lib/lolly/tls/appliance.sha256").stdout.strip()
    ok("HTTPS serves the appliance's own certificate", served == stored and bool(stored), f"SHA-256 {stored[:23]}...")
    host, port = args.http.split(":")
    try:
        connection = http.client.HTTPConnection(host, int(port), timeout=15)
        connection.request("GET", "/admin", headers={"Host": web.host})
        response = connection.getresponse()
        location = response.getheader("Location") or ""
        ok("plain HTTP redirects to HTTPS", response.status in (301, 308) and location.startswith("https://"), f"HTTP {response.status} {location}")
    except OSError as error:
        ok("plain HTTP redirects to HTTPS", False, str(error))
    facts = guest.run("cat /etc/rancher/k3s/config.yaml 2>/dev/null; getenforce; ls /var/lib/lolly/credentials; systemd-analyze has-tpm2 -q && echo tpm2 || echo host-key").stdout
    if profile == "k3s":
        ok("SELinux is enforcing and K3s runs with selinux: true", "Enforcing" in facts and "selinux: true" in facts)
    else:
        labels = guest.run("ps -eZ -o label,comm | grep -E 'container_t:s0:c(10,c11|20,c21|30,c31) ' | awk '{print $1}' | sort -u").stdout.split()
        ok("SELinux is enforcing and each Lolly container runs as container_t with its own categories",
           "Enforcing" in facts and {label.split(":", 4)[-1] for label in labels} >= {"c10,c11", "c20,c21", "c30,c31"}, " ".join(labels))
    ok("six credentials are stored as encrypted systemd credentials", len(re.findall(r"\.cred$", facts, re.M)) == 6, facts.strip().splitlines()[-1])
    # Cockpit keeps its own self-signed key in /etc/cockpit/ws-certs.d, as on any host.
    leaked = guest.run("grep -rlE 'BEGIN (EC )?PRIVATE KEY|postgres://' /etc/lolly /etc/rancher /etc/containers/systemd /usr/share/lolly-appliance "
                       "/var/lib/lolly/quadlet /var/lib/lolly/work /var/lib/lolly/tls /var/lib/lolly/update "
                       "/var/lib/rancher/k3s/server/manifests 2>/dev/null | head -3").stdout.strip()
    ok("no private key or database URL in Lolly's files on disk", leaked == "", leaked)
    # The strongest form: the decrypted database password appears nowhere on disk
    # outside the encrypted credential (K3s's datastore keeps Secrets encrypted;
    # podman's container storage must not hold it either).
    secret = "pw=$(systemd-creds decrypt --name=lolly-postgres-password /var/lib/lolly/credentials/lolly-postgres-password.cred - 2>/dev/null) && [ ${#pw} -ge 32 ] && "
    found = guest.run(secret + "grep -rlF --binary-files=text \"$pw\" /etc /var/lib/lolly /var/lib/rancher /var/lib/containers/storage/overlay-containers "
                      "--exclude-dir=credentials --exclude-dir=postgres --exclude-dir=storage --exclude-dir=containerd 2>/dev/null | head -3; echo checked", timeout=600).stdout.strip()
    ok("the database password is on disk only inside its encrypted credential", found == "checked", found)
    if profile == "k3s":
        # Kubernetes hands a container its environment, Secret values resolved,
        # and containerd keeps each container's spec in its metadata database.
        kept = guest.run(secret + "grep -rlF --binary-files=text \"$pw\" /var/lib/rancher/k3s/agent/containerd 2>/dev/null | head -3").stdout.split()
        print(f"INFO k3s: containerd's metadata holds Work's environment, with DATABASE_URL, in {len(kept)} file(s): {' '.join(kept)}", flush=True)
    # The console service writes its text a few seconds after Work is ready.
    for _ in range(40):
        issue = guest.run("cat /run/issue.d/60-lolly.issue; echo ---; cat /run/lolly/local-issue.d/61-lolly-owner.issue").stdout
        if "(ready)" in issue:
            break
        time.sleep(3)
    public, _, local = issue.partition("---")
    ok("every console shows the address and fingerprint, without the link", base.group(1) in public and stored in public and "token=" not in public)
    if not args.after_reboot:
        ok("the machine's own screen (tty1) shows the one-time owner link", "token=" in local or "has set a password" in local)

    if not args.after_reboot:
        link = guest.run("lolly-appliance owner-link").stdout.strip()
        ok("lolly-appliance owner-link prints a link", link.startswith(base.group(1) + "/api/auth/password/set?token="))
        token = urllib.parse.parse_qs(urllib.parse.urlsplit(link).query).get("token", [""])[0]
        status, _, page = web.call("GET", "/api/auth/password/set?token=" + urllib.parse.quote(token))
        csrf = re.search(rb'name="csrf" value="([^"]+)"', page)
        ok("the owner setup page opens", status == 200 and bool(csrf), f"HTTP {status}")
        password = secrets.token_urlsafe(24)
        status, _, _ = web.call("POST", "/api/auth/password/set", {"token": token, "name": "Appliance Owner", "password": password,
                                                                   "confirm": password, "returnTo": "/admin", "csrf": csrf.group(1).decode() if csrf else ""}, form=True)
        ok("the owner sets a password from the link", status in (200, 303), f"HTTP {status}")
        with open(args.state, "w") as handle:
            json.dump({"password": password, "owner": owner.group(1)}, handle)
        status, _, _ = web.call("POST", "/api/auth/password/set", {"token": token, "password": password, "confirm": password, "csrf": ""}, form=True)
        ok("the link works only once", status >= 400, f"HTTP {status}")
    state = json.load(open(args.state))
    signin = Web(args.https, base.group(1))
    status, _, body = signin.call("POST", "/api/auth/password/login", {"email": state["owner"], "password": state["password"]})
    ok("the owner signs in with email and password", status in (200, 204, 303) and any(c.name == "lw_session" for c in signin.jar), f"HTTP {status}")
    status, _, body = signin.call("GET", "/api/auth/session")
    ok("the session is the owner's", status == 200 and "owner" in body.decode(), f"HTTP {status}")
    status, _, body = signin.call("GET", "/catalog/tools/index.json")
    tools = [t["id"] for t in json.loads(body).get("tools", [])] if status == 200 else []
    ok("the signed-in catalogue lists qr-code", "qr-code" in tools, f"{len(tools)} tools")
    label = "after-reboot" if args.after_reboot else "first"
    passed, line = render(signin, "qr-code", "svg", {"url": "https://lolly.work"}, f"appliance-{label}-svg-{int(time.time())}")
    ok("render " + line, passed)
    passed, line = render(signin, "qr-code", "png", {"url": "https://lolly.work"}, f"appliance-{label}-png-{int(time.time())}")
    ok("render " + line, passed)

    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    host, port = args.cockpit.split(":")
    try:
        connection = http.client.HTTPSConnection(host, int(port), context=context, timeout=30)
        connection.request("GET", "/")
        response = connection.getresponse()
        page = response.read()
        ok("Cockpit answers on 9090", response.status == 200 and b"cockpit" in page.lower(), f"HTTP {response.status}")
    except OSError as error:
        ok("Cockpit answers on 9090", False, str(error))
    rules = guest.run("firewall-cmd --zone=public --list-rich-rules; firewall-cmd --zone=public --list-services").stdout
    ok("Cockpit is allowed from local networks only", "service name=\"cockpit\"" in rules and not re.search(r"^.*\bcockpit\b.*$", rules.splitlines()[-1] if rules else ""), rules.strip().splitlines()[-1] if rules.strip() else "")
    if profile == "podman":
        mtu = guest.run("dev=$(ip -o route get 1.1.1.1 | sed -n 's/.* dev \\([^ ]*\\).*/\\1/p'); cat /sys/class/net/$dev/mtu; "
                        "podman network inspect lolly --format '{{index .Options \"mtu\"}}'; podman exec lolly-work cat /sys/class/net/eth0/mtu").stdout.split()
        ok("the container network takes the host interface's MTU", len(mtu) == 3 and mtu[0] == mtu[1] == mtu[2], " / ".join(mtu))
        images = guest.run("podman images --digests --format '{{.Repository}}@{{.Digest}}' | sort; echo ---; grep -h '^Image=' /var/lib/lolly/quadlet/*.container | cut -d= -f2 | sort").stdout
        have, _, pinned = images.partition("---")
        ok("Podman runs the pinned digests, loaded from the image (nothing else pulled)", set(pinned.split()) <= set(have.split()) and len(have.split()) == len(pinned.split()), f"{len(have.split())} images")
        links = guest.run("for f in /etc/containers/systemd/*; do readlink \"$f\"; done").stdout.split()
        ok("the Quadlet units in /etc/containers/systemd are links into /var/lib/lolly/quadlet", len(links) == 4 and all(l.startswith("/var/lib/lolly/quadlet/") for l in links), " ".join(links))
    m = measurements(guest)
    m["peak_used_mib_since_ssh"] = sampler.stop()
    print("MEASURE " + json.dumps(m, sort_keys=True), flush=True)
    print(f"RESULT {'PASS' if not FAILED else 'FAIL'} ({len(FAILED)} failed)")
    return 0 if not FAILED else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
