#!/usr/bin/env python3
"""Live catalog smoke tests for TDengine All-in-One packages."""

from __future__ import annotations

import json
import re
import ssl
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Callable, Iterable

BASE_URL = "https://downloads.tdengine.com"
DOCKER_ASSET_BASE = f"{BASE_URL}/apex/docker/v1.0.0"
HUB_API = "https://hub.docker.com/v2/repositories"
USER_AGENT = "TDengine-AIO-Smoketest/1.0"
CTX = ssl.create_default_context()

ProgressFn = Callable[[str], None]


@dataclass
class Check:
    platform: str
    component: str
    name: str
    url: str
    kind: str = "http"
    ok: bool | None = None
    http: int | None = None
    size: str = ""
    detail: str = ""

    def as_dict(self) -> dict:
        return asdict(self)


def _request(url: str, method: str = "HEAD", timeout: int = 25) -> tuple[int, dict[str, str]]:
    req = urllib.request.Request(
        url,
        method=method,
        headers={"User-Agent": USER_AGENT, "Accept": "*/*"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=CTX) as resp:
            headers = {k.lower(): v for k, v in resp.headers.items()}
            return resp.status, headers
    except urllib.error.HTTPError as exc:
        headers = {k.lower(): v for k, v in exc.headers.items()} if exc.headers else {}
        return exc.code, headers


def _get_text(url: str, timeout: int = 40) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout, context=CTX) as resp:
        return resp.read().decode("utf-8", errors="replace")


def _get_json(url: str, timeout: int = 40) -> dict:
    return json.loads(_get_text(url, timeout=timeout))


def fetch_catalog() -> dict:
    versions = _get_json(f"{BASE_URL}/apex/versions.json")
    aio = versions["profiles"]["all-in-one"]
    channel = aio["channels"]["stable"]
    components = aio["releases"][channel]["components"]
    return {
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "base_url": BASE_URL,
        "channel": channel,
        "components": components,
        "install_sh": f"{BASE_URL}/apex/latest/install.sh",
        "windows_setup": f"{BASE_URL}/apex/latest/TDengineSetup-x64.exe",
        "docker_assets": DOCKER_ASSET_BASE,
    }


def _component_yaml_url(name: str, version: str) -> str:
    pkg = {
        "tsdb": "tdengine-tsdb-enterprise",
        "idmp": "tdengine-idmp-enterprise",
        "tdgpt": "tdengine-tdgpt-enterprise",
        "tdmodel": "tdengine-tdmodel",
    }[name]
    return f"{BASE_URL}/{pkg}/{version}/{pkg}-{version}.yaml"


def _parse_artifact_urls(yaml_text: str, base_url: str) -> list[tuple[str, str, str]]:
    """Return (platform, filename, url) from an Apex component YAML."""
    platform = "unknown"
    found: list[tuple[str, str, str]] = []
    plat_re = re.compile(
        r"^(?P<indent>\s{2,})(?P<plat>linux-x64|linux-arm64|windows-x64|darwin-arm64|darwin-x64):\s*$"
    )
    url_re = re.compile(r"^\s+url:\s*(?P<url>\S+)\s*$")
    file_re = re.compile(r"^\s+file:\s*(?P<file>\S+)\s*$")
    pending_file = ""
    for raw in yaml_text.splitlines():
        line = raw.rstrip()
        mplat = plat_re.match(line)
        if mplat:
            platform = mplat.group("plat")
            pending_file = ""
            continue
        mfile = file_re.match(line)
        if mfile:
            pending_file = mfile.group("file").strip().strip("\"'")
            continue
        murl = url_re.match(line)
        if murl:
            url = murl.group("url").strip().strip("\"'").replace("${base_url}", base_url)
            name = pending_file or url.rsplit("/", 1)[-1]
            found.append((platform, name, url))
            pending_file = ""
    return found


def _human_size(n: int | None) -> str:
    if n is None or n < 0:
        return ""
    value = float(n)
    for unit in ("B", "KiB", "MiB", "GiB"):
        if value < 1024 or unit == "GiB":
            if unit == "B":
                return f"{int(value)} {unit}"
            return f"{value:.1f} {unit}"
        value /= 1024
    return f"{n} B"


def _content_length(headers: dict[str, str]) -> int | None:
    raw = headers.get("content-length")
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def check_http(item: Check) -> Check:
    try:
        status, headers = _request(item.url, "HEAD")
        if status in (403, 405, 501):
            status, headers = _request(item.url, "GET")
        item.http = status
        length = _content_length(headers)
        item.size = _human_size(length)
        if status == 200:
            item.ok = True
            item.detail = "available"
        else:
            item.ok = False
            item.detail = f"HTTP {status}"
    except Exception as exc:  # noqa: BLE001 — surface any network failure
        item.ok = False
        item.detail = str(exc)
    return item


def check_docker_tag(item: Check) -> Check:
    # image like tdengine/tsdb-ee:latest
    try:
        image = item.url
        if ":" not in image:
            image = f"{image}:latest"
        repo, tag = image.rsplit(":", 1)
        if "/" not in repo:
            repo = f"library/{repo}"
        api = f"{HUB_API}/{repo}/tags/{tag}"
        payload = _get_json(api, timeout=30)
        item.http = 200
        item.ok = True
        updated = payload.get("last_updated") or payload.get("tag_last_pushed") or ""
        size = payload.get("full_size")
        item.size = _human_size(size) if size else ""
        item.detail = f"Docker Hub latest={tag} updated={updated[:19]}"
    except urllib.error.HTTPError as exc:
        item.http = exc.code
        item.ok = False
        item.detail = f"Docker Hub HTTP {exc.code}"
    except Exception as exc:  # noqa: BLE001
        item.ok = False
        item.detail = str(exc)
    return item


def _linux_windows_checks(catalog: dict) -> list[Check]:
    items: list[Check] = [
        Check("linux", "apex", "install.sh", catalog["install_sh"]),
        Check("windows", "apex", "TDengineSetup-x64.exe", catalog["windows_setup"]),
    ]
    for name, version in catalog["components"].items():
        if name == "tdmodel":
            continue  # host All-in-One does not install TDmodel
        yaml_url = _component_yaml_url(name, version)
        items.append(Check("linux", name, f"{name}-{version}.yaml", yaml_url))
        try:
            yaml_text = _get_text(yaml_url)
        except Exception as exc:  # noqa: BLE001
            items[-1].ok = False
            items[-1].detail = str(exc)
            continue
        items[-1].ok = True
        items[-1].http = 200
        items[-1].detail = "manifest"
        for platform, filename, url in _parse_artifact_urls(yaml_text, catalog["base_url"]):
            bucket = "windows" if platform.startswith("windows") else "linux"
            items.append(Check(bucket, name, filename, url))
    return items


def _docker_checks(catalog: dict) -> list[Check]:
    items: list[Check] = [
        Check("docker", "apex", "install.sh (docker mode)", catalog["install_sh"]),
    ]
    for filename in (
        "tdengine.sh",
        "tdengine.ps1",
        "docker-compose-tdengine.yml",
        ".env.example",
        "init-anode.sql",
    ):
        items.append(
            Check(
                "docker",
                "apex-docker",
                filename,
                f"{catalog['docker_assets']}/{filename}",
            )
        )
    compose_url = f"{catalog['docker_assets']}/docker-compose-tdengine.yml"
    try:
        compose = _get_text(compose_url)
        images = sorted(set(re.findall(r"image:\s*(\S+)", compose)))
        for raw in images:
            image = re.sub(r"\$\{[^:]+:-([^}]+)\}", r"\1", raw)
            image = image.strip().strip("\"'")
            items.append(
                Check("docker", "image", image, image, kind="docker")
            )
    except Exception as exc:  # noqa: BLE001
        items.append(
            Check(
                "docker",
                "apex-docker",
                "docker-compose-tdengine.yml",
                compose_url,
                ok=False,
                detail=str(exc),
            )
        )
    return items


def plan_checks(catalog: dict, platforms: Iterable[str]) -> list[Check]:
    wanted = {p.lower() for p in platforms}
    items: list[Check] = []
    if wanted & {"linux", "windows"}:
        for item in _linux_windows_checks(catalog):
            if item.platform in wanted:
                items.append(item)
    if "docker" in wanted:
        items.extend(_docker_checks(catalog))
    # de-dupe by url+platform
    seen: set[tuple[str, str]] = set()
    unique: list[Check] = []
    for item in items:
        key = (item.platform, item.url)
        if key in seen:
            continue
        seen.add(key)
        unique.append(item)
    return unique


def run_checks(
    items: list[Check],
    workers: int = 8,
    progress: ProgressFn | None = None,
) -> list[Check]:
    pending = [item for item in items if item.ok is None]
    already = [item for item in items if item.ok is not None]
    results: list[Check] = list(already)
    total = len(items)
    done = len(already)

    def _work(item: Check) -> Check:
        if item.kind == "docker":
            return check_docker_tag(item)
        return check_http(item)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(_work, item): item for item in pending}
        for fut in as_completed(futures):
            result = fut.result()
            results.append(result)
            done += 1
            if progress:
                flag = "PASS" if result.ok else "FAIL"
                progress(f"{done}/{total} {flag} {result.platform} {result.name}")
    order = {(item.platform, item.url): i for i, item in enumerate(items)}
    results.sort(key=lambda item: order.get((item.platform, item.url), 9999))
    return results


def summarize(items: list[Check]) -> dict:
    by: dict[str, dict[str, int]] = {}
    for item in items:
        slot = by.setdefault(item.platform, {"pass": 0, "fail": 0, "total": 0})
        slot["total"] += 1
        if item.ok:
            slot["pass"] += 1
        else:
            slot["fail"] += 1
    failures = [item.as_dict() for item in items if item.ok is False]
    return {
        "platforms": by,
        "total": len(items),
        "failed": len(failures),
        "passed": len(items) - len(failures),
        "failures": failures,
    }


def support_email_body(catalog: dict, items: list[Check]) -> str:
    summary = summarize(items)
    lines = [
        "Subject: APEX All-in-One smoke test failures from download center",
        "",
        f"Catalog: {catalog['base_url']}",
        f"Stable channel: {catalog['channel']}",
        f"Components: {json.dumps(catalog['components'])}",
        f"Fetched: {catalog['fetched_at']}",
        f"Result: {summary['passed']} passed, {summary['failed']} failed, {summary['total']} checked",
        "",
        "Failures:",
    ]
    if not summary["failures"]:
        lines.append("  (none)")
    for item in summary["failures"]:
        lines.append(
            f"- [{item['platform']}] {item['component']} {item['name']}: "
            f"{item['detail']} ({item['url']})"
        )
    lines.extend(["", "This report was generated by TDengine AIO Smoketest."])
    return "\n".join(lines)
