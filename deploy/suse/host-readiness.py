#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Read-only SUSE host inventory; never installs or adopts a runtime."""
import argparse
import datetime
import json
import os
from pathlib import Path
import platform
import pwd
import re
import shlex
import shutil
import socket
import subprocess
import sys

PROFILES = ("k3s", "rke2", "podman-build")
CLUSTER_PATHS = ("/etc/rancher/k3s", "/var/lib/rancher/k3s", "/etc/rancher/rke2", "/var/lib/rancher/rke2", "/usr/local/bin/k3s", "/usr/local/bin/rke2")
CLUSTER_PORTS = (80, 443, 2379, 2380, 6443, 9345, 10250)
HOST_PATTERN = re.compile(r"[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?")


def read_text(path):
    return Path(path).read_text(encoding="utf-8")


def os_release(text):
    """Parse data only; sourcing os-release would execute shell expressions."""
    result = {}
    for line in text.splitlines():
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key not in ("ID", "VERSION_ID"):
            continue
        words = shlex.split(value)
        if len(words) != 1:
            raise ValueError("invalid os-release value")
        result[key] = words[0]
    return result


def command(argv, errors):
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=10, check=False)
    except (OSError, subprocess.TimeoutExpired):
        errors.append(argv[0])
        return None
    if result.returncode:
        errors.append(argv[0])
        return None
    return result.stdout.strip()


def collect(profile):
    errors = []
    facts = {"system": platform.system(), "architecture": platform.machine(), "hostname": socket.gethostname(), "effectiveUid": os.geteuid()}
    try:
        facts["os"] = os_release(read_text("/etc/os-release"))
        facts["cpus"] = os.cpu_count() or 0
        facts["memoryBytes"] = next(int(line.split()[1]) * 1024 for line in read_text("/proc/meminfo").splitlines() if line.startswith("MemTotal:"))
        space = os.statvfs("/var")
        facts["freeVarBytes"] = space.f_bavail * space.f_frsize
        facts["cgroupControllers"] = read_text("/sys/fs/cgroup/cgroup.controllers").split()
        facts["swapActive"] = len(read_text("/proc/swaps").splitlines()) != 1
        facts["clusterPaths"] = [p for p in CLUSTER_PATHS if os.path.lexists(p)]
    except (OSError, ValueError, StopIteration):
        errors.append("host-files")
    tools = ("python3", "rpm", "systemctl", "podman", "newuidmap", "newgidmap") if profile == "podman-build" else ("python3", "rpm", "systemctl", "curl", "sha256sum", "ip", "ss", "firewall-cmd")
    facts["missingTools"] = [tool for tool in tools if shutil.which(tool) is None]
    if facts["system"] == "Linux" and shutil.which("systemctl"):
        units = command(["systemctl", "list-unit-files", "--no-legend", "--no-pager"], errors)
        if units is not None:
            facts["existingOwners"] = sorted({line.split()[0] for line in units.splitlines() if re.match(r"(?:k3s(?:[.-])|rke2(?:[.-])|docker(?:[.-])|caddy(?:[.-])|lolly(?:[.-]))", line)})
    if profile != "podman-build" and shutil.which("ss"):
        listeners = command(["ss", "--no-header", "--listening", "--tcp", "--numeric"], errors)
        if listeners is not None:
            occupied = set()
            for line in listeners.splitlines():
                columns = line.split()
                if len(columns) < 4:
                    errors.append("ss-format")
                    break
                try:
                    port = int(columns[3].rsplit(":", 1)[1])
                except (ValueError, IndexError):
                    errors.append("ss-format")
                    break
                if port in CLUSTER_PORTS:
                    occupied.add(port)
            facts["occupiedPorts"] = sorted(occupied)
    if profile != "podman-build" and shutil.which("firewall-cmd"):
        facts["firewallRunning"] = command(["firewall-cmd", "--state"], errors) == "running"
    if shutil.which("getenforce"):
        facts["selinux"] = command(["getenforce"], errors)
    else:
        facts["selinux"] = "unavailable"
    if profile == "podman-build":
        # Avoid podman info: it can initialize the owner's local storage.
        facts["unprivilegedOwner"] = os.geteuid() != 0
        facts["subordinateIds"] = False
        try:
            account = pwd.getpwuid(os.geteuid())
            owner = account.pw_name
            build_space = os.statvfs(account.pw_dir)
            facts["freeBuildBytes"] = build_space.f_bavail * build_space.f_frsize
            def has_range(path):
                for line in read_text(path).splitlines():
                    parts = line.split(":")
                    if len(parts) == 3 and parts[0] in (owner, str(os.geteuid())):
                        if int(parts[1]) >= 65536 and int(parts[2]) >= 65536:
                            return True
                return False
            facts["subordinateIds"] = has_range("/etc/subuid") and has_range("/etc/subgid")
        except (OSError, KeyError, ValueError):
            errors.append("subordinate-ids")
    facts["inspectionErrors"] = sorted(set(errors))
    return facts


def evaluate(facts, profile, expected_host):
    """A receipt is a host gate, never evidence of application acceptance."""
    checks = []

    def check(code, passed, message):
        checks.append({"code": code, "passed": bool(passed), "message": message})

    check("linux", facts.get("system") == "Linux", "Linux host required")
    check("host-identity", facts.get("hostname") == expected_host, "Actual hostname must match the selected host")
    distro = facts.get("os", {})
    check("suse-os", distro.get("ID") in ("sles", "opensuse-leap") and re.fullmatch(r"[0-9]+(?:\.[0-9]+)*", str(distro.get("VERSION_ID", ""))) is not None, "Versioned SLES or openSUSE Leap required; review the selected runtime support matrix")
    check("architecture", facts.get("architecture") in (("x86_64", "aarch64") if profile == "podman-build" else ("x86_64",)), "K3s lock currently targets amd64; Podman builds also accept native arm64")
    check("inspection", facts.get("inspectionErrors") == [], "Every required host inspection must succeed")
    check("tools", facts.get("missingTools") == [], "Required tools must be available from reviewed OS repositories")
    check("cgroup-v2", {"cpu", "memory", "pids"}.issubset(facts.get("cgroupControllers", [])), "Unified CPU, memory and PID controllers required")
    if profile == "podman-build":
        check("rootless-owner", facts.get("unprivilegedOwner") is True and facts.get("subordinateIds") is True, "Run under the unprivileged build owner with reviewed subordinate UID/GID ranges")
        check("build-space", facts.get("freeBuildBytes", 0) >= 10 * 1024**3, "At least 10 GiB free on the build owner's home filesystem; qualify custom storage and larger release needs")
    else:
        check("administrator-inspection", facts.get("effectiveUid") == 0, "Inspect as root so private runtime paths cannot be mistaken for an empty host")
        check("fresh-cluster", facts.get("clusterPaths") == [] and facts.get("existingOwners") == [], "Existing cluster/application owners require a separate adoption or upgrade procedure")
        check("ports", facts.get("occupiedPorts") == [], "Fresh cluster HTTP and control-plane ports must be unoccupied")
        check("firewall", facts.get("firewallRunning") is True, "Active firewalld required; exact interface and provider rules need separate review")
        check("capacity", facts.get("cpus", 0) >= 4 and facts.get("memoryBytes", 0) >= 7 * 1024**3 and facts.get("freeVarBytes", 0) >= 40 * 1024**3, "Initial rehearsal budget: four CPUs, seven usable GiB RAM and 40 GiB free in /var")
        check("swap", facts.get("swapActive") is False, "Active swap requires a separately qualified configuration")
        check("selinux", facts.get("selinux") in ("Enforcing", "Disabled", "unavailable"), "Permissive or unreadable SELinux posture requires review; never disable enforcement here")
    return {"schemaVersion": 1, "readOnly": True, "profile": profile, "expectedHost": expected_host, "status": "ready" if all(c["passed"] for c in checks) else "blocked", "facts": facts, "checks": checks}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=PROFILES, required=True)
    parser.add_argument("--expect-host", required=True)
    parser.add_argument("--salt-stateful", action="store_true", help="Emit Salt's unchanged-state result; the receipt remains nested")
    args = parser.parse_args()
    if not HOST_PATTERN.fullmatch(args.expect_host):
        parser.error("expected host must be a hostname, without shell expressions")
    receipt = evaluate(collect(args.profile), args.profile, args.expect_host)
    receipt["observedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    if args.salt_stateful:
        print(json.dumps({"changed": False, "comment": "Read-only Lolly host check: " + receipt["status"], "receipt": receipt}, sort_keys=True))
    else:
        print(json.dumps(receipt, indent=2, sort_keys=True))
    return 0 if receipt["status"] == "ready" else 1


if __name__ == "__main__":
    sys.exit(main())
