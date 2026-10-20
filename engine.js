"use strict";

const { formatPst } = require("./time");

const BASE_URL = "https://downloads.tdengine.com";
const DOCKER_ASSET_BASE = `${BASE_URL}/apex/docker/v1.0.0`;
const HUB_API = "https://hub.docker.com/v2/repositories";
const USER_AGENT = "TDengine-AIO-Smoketest/1.0";

function check(partial) {
  return {
    platform: "",
    component: "",
    name: "",
    url: "",
    kind: "http",
    ok: null,
    http: null,
    size: "",
    detail: "",
    ...partial,
  };
}

async function fetchText(url, timeoutMs = 40000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const err = new Error(`HTTP ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, timeoutMs = 40000) {
  return JSON.parse(await fetchText(url, timeoutMs));
}

async function request(url, method = "HEAD", timeoutMs = 25000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "*/*",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
      cache: "no-store",
      signal: ctrl.signal,
      redirect: "follow",
    });
    return { status: resp.status, headers: resp.headers };
  } catch (err) {
    if (err && err.status) return { status: err.status, headers: new Headers() };
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function decodeContentMd5(value) {
  if (!value) return "";
  try {
    return Buffer.from(value, "base64").toString("hex");
  } catch {
    return "";
  }
}

function humanSize(n) {
  if (n == null || Number.isNaN(n) || n < 0) return "";
  let value = Number(n);
  for (const unit of ["B", "KiB", "MiB", "GiB"]) {
    if (value < 1024 || unit === "GiB") {
      return unit === "B" ? `${Math.round(value)} ${unit}` : `${value.toFixed(1)} ${unit}`;
    }
    value /= 1024;
  }
  return `${n} B`;
}

function parseArtifactUrls(yamlText, baseUrl) {
  const platRe = /^(?<indent>\s{2,})(?<plat>linux-x64|linux-arm64|windows-x64|darwin-arm64|darwin-x64):\s*$/;
  const urlRe = /^\s+url:\s*(?<url>\S+)\s*$/;
  const fileRe = /^\s+file:\s*(?<file>\S+)\s*$/;
  const shaRe = /^\s+sha256:\s*(?<sha>[0-9a-fA-F]{32,})\s*$/;
  let platform = "unknown";
  let pendingFile = "";
  const found = [];
  for (const raw of yamlText.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    const mplat = line.match(platRe);
    if (mplat) {
      platform = mplat.groups.plat;
      pendingFile = "";
      continue;
    }
    const mfile = line.match(fileRe);
    if (mfile) {
      pendingFile = mfile.groups.file.replace(/^["']|["']$/g, "");
      continue;
    }
    const murl = line.match(urlRe);
    if (murl) {
      const url = murl.groups.url.replace(/^["']|["']$/g, "").replaceAll("${base_url}", baseUrl);
      const name = pendingFile || url.split("/").pop();
      found.push({ platform, name, url, sha256: "" });
      pendingFile = "";
      continue;
    }
    const msha = line.match(shaRe);
    if (msha && found.length) {
      found[found.length - 1].sha256 = msha.groups.sha.toLowerCase();
    }
  }
  return found;
}

function componentYamlUrl(name, version) {
  const pkg = {
    tsdb: "tdengine-tsdb-enterprise",
    idmp: "tdengine-idmp-enterprise",
    tdgpt: "tdengine-tdgpt-enterprise",
    tdmodel: "tdengine-tdmodel",
  }[name];
  return `${BASE_URL}/${pkg}/${version}/${pkg}-${version}.yaml`;
}

async function fetchCatalog() {
  const versions = await fetchJson(`${BASE_URL}/apex/versions.json`);
  const aio = versions.profiles["all-in-one"];
  const channel = aio.channels.stable;
  const components = aio.releases[channel].components;
  return {
    fetched_at: new Date().toISOString(),
    base_url: BASE_URL,
    channel,
    components,
    install_sh: `${BASE_URL}/apex/latest/install.sh`,
    windows_setup: `${BASE_URL}/apex/latest/TDengineSetup-x64.exe`,
    docker_assets: DOCKER_ASSET_BASE,
  };
}

async function linuxWindowsChecks(catalog) {
  const items = [
    check({ platform: "linux", component: "apex", name: "install.sh", url: catalog.install_sh }),
    check({ platform: "windows", component: "apex", name: "TDengineSetup-x64.exe", url: catalog.windows_setup }),
  ];
  for (const [name, version] of Object.entries(catalog.components)) {
    if (name === "tdmodel") continue;
    const yamlUrl = componentYamlUrl(name, version);
    const yamlItem = check({
      platform: "linux",
      component: name,
      name: `${name}-${version}.yaml`,
      url: yamlUrl,
    });
    items.push(yamlItem);
    try {
      const yamlText = await fetchText(yamlUrl);
      yamlItem.ok = true;
      yamlItem.http = 200;
      yamlItem.detail = "manifest";
      for (const art of parseArtifactUrls(yamlText, catalog.base_url)) {
        items.push(
          check({
            platform: art.platform.startsWith("windows") ? "windows" : "linux",
            component: name,
            name: art.name,
            url: art.url,
            sha256: art.sha256 || "",
          })
        );
      }
    } catch (err) {
      yamlItem.ok = false;
      yamlItem.detail = String(err.message || err);
    }
  }
  return items;
}

async function dockerChecks(catalog) {
  const items = [
    check({
      platform: "docker",
      component: "apex",
      name: "install.sh (docker mode)",
      url: catalog.install_sh,
    }),
  ];
  for (const filename of [
    "tdengine.sh",
    "tdengine.ps1",
    "docker-compose-tdengine.yml",
    ".env.example",
    "init-anode.sql",
  ]) {
    items.push(
      check({
        platform: "docker",
        component: "apex-docker",
        name: filename,
        url: `${catalog.docker_assets}/${filename}`,
      })
    );
  }
  const composeUrl = `${catalog.docker_assets}/docker-compose-tdengine.yml`;
  try {
    const compose = await fetchText(composeUrl);
    const images = [...new Set([...compose.matchAll(/image:\s*(\S+)/g)].map((m) => m[1]))].sort();
    for (const raw of images) {
      const image = raw
        .replace(/\$\{[^:]+:-([^}]+)\}/g, "$1")
        .replace(/^["']|["']$/g, "");
      items.push(check({ platform: "docker", component: "image", name: image, url: image, kind: "docker" }));
    }
  } catch (err) {
    items.push(
      check({
        platform: "docker",
        component: "apex-docker",
        name: "docker-compose-tdengine.yml",
        url: composeUrl,
        ok: false,
        detail: String(err.message || err),
      })
    );
  }
  return items;
}

async function planChecks(catalog, platforms) {
  const wanted = new Set(platforms.map((p) => p.toLowerCase()));
  const items = [];
  if (wanted.has("linux") || wanted.has("windows")) {
    for (const item of await linuxWindowsChecks(catalog)) {
      if (wanted.has(item.platform)) items.push(item);
    }
  }
  if (wanted.has("docker")) items.push(...(await dockerChecks(catalog)));
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.platform}|${item.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function checkHttp(item) {
  try {
    let { status, headers } = await request(item.url, "HEAD");
    if ([403, 405, 501].includes(status)) {
      ({ status, headers } = await request(item.url, "GET"));
    }
    item.http = status;
    const length = Number(headers.get("content-length"));
    item.sizeBytes = Number.isFinite(length) ? length : null;
    item.size = Number.isFinite(length) ? humanSize(length) : "";
    item.etag = headers.get("etag") || "";
    item.lastModified = headers.get("last-modified") || "";
    item.contentMd5 = decodeContentMd5(headers.get("content-md5"));
    if (status === 200) {
      item.ok = true;
      item.detail = "available";
    } else {
      item.ok = false;
      item.detail = `HTTP ${status}`;
    }
  } catch (err) {
    item.ok = false;
    item.detail = String(err.message || err);
  }
  return item;
}

async function checkDockerTag(item) {
  try {
    let image = item.url.includes(":") ? item.url : `${item.url}:latest`;
    const colon = image.lastIndexOf(":");
    let repo = image.slice(0, colon);
    const tag = image.slice(colon + 1);
    if (!repo.includes("/")) repo = `library/${repo}`;
    const payload = await fetchJson(`${HUB_API}/${repo}/tags/${tag}`, 30000);
    item.http = 200;
    item.ok = true;
    const updated = payload.last_updated || payload.tag_last_pushed || "";
    item.size = payload.full_size ? humanSize(payload.full_size) : "";
    item.detail = `Docker Hub latest=${tag} updated=${String(updated).slice(0, 19)}`;
  } catch (err) {
    item.ok = false;
    item.http = err.status || null;
    item.detail = err.status ? `Docker Hub HTTP ${err.status}` : String(err.message || err);
  }
  return item;
}

async function runChecks(items, onProgress) {
  const pending = items.filter((item) => item.ok == null);
  const results = items.filter((item) => item.ok != null);
  const total = items.length;
  let done = results.length;
  const limit = 8;
  let index = 0;

  async function worker() {
    while (index < pending.length) {
      const item = pending[index++];
      const result = item.kind === "docker" ? await checkDockerTag(item) : await checkHttp(item);
      results.push(result);
      done += 1;
      if (onProgress) {
        onProgress({
          done,
          total,
          message: `${done}/${total} ${result.ok ? "PASS" : "FAIL"} ${result.platform} ${result.name}`,
          item: result,
        });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, pending.length) }, () => worker()));
  const order = new Map(items.map((item, i) => [`${item.platform}|${item.url}`, i]));
  results.sort(
    (a, b) => (order.get(`${a.platform}|${a.url}`) ?? 9999) - (order.get(`${b.platform}|${b.url}`) ?? 9999)
  );
  return results;
}

function summarize(items) {
  const platforms = {};
  for (const item of items) {
    const slot = platforms[item.platform] || { pass: 0, fail: 0, total: 0 };
    slot.total += 1;
    if (item.ok) slot.pass += 1;
    else slot.fail += 1;
    platforms[item.platform] = slot;
  }
  const failures = items.filter((item) => item.ok === false);
  return {
    platforms,
    total: items.length,
    failed: failures.length,
    passed: items.length - failures.length,
    failures,
  };
}

function supportEmailBody(catalog, items) {
  const summary = summarize(items);
  const lines = [
    "Subject: APEX All-in-One smoke test failures from download center",
    "",
    `Catalog: ${catalog.base_url}`,
    `Stable channel: ${catalog.channel}`,
    `Components: ${JSON.stringify(catalog.components)}`,
    `Fetched: ${formatPst(catalog.fetched_at)}`,
    `Result: ${summary.passed} passed, ${summary.failed} failed, ${summary.total} checked`,
    "",
    "Failures:",
  ];
  if (!summary.failures.length) lines.push("  (none)");
  for (const item of summary.failures) {
    lines.push(`- [${item.platform}] ${item.component} ${item.name}: ${item.detail} (${item.url})`);
  }
  lines.push("", "This report was generated by TDengine AIO Smoketest.");
  return lines.join("\n");
}

function withAiSummary(email, aiSummary) {
  if (!aiSummary) return email;
  return `${email}\n\nAI summary:\n${aiSummary}\n`;
}

function fingerprintItem(item) {
  return {
    platform: item.platform,
    component: item.component,
    name: item.name,
    url: item.url,
    kind: item.kind,
    ok: item.ok,
    sha256: item.sha256 || "",
    contentMd5: item.contentMd5 || "",
    etag: item.etag || "",
    lastModified: item.lastModified || "",
    sizeBytes: item.sizeBytes ?? null,
    size: item.size || "",
  };
}

function fingerprintRun(catalog, items) {
  const httpItems = items.filter((item) => item.kind !== "docker").map(fingerprintItem);
  const failures = httpItems.filter((item) => item.ok === false);
  return {
    savedAt: new Date().toISOString(),
    channel: catalog.channel,
    components: catalog.components,
    failed: failures.length,
    failures: failures.map((item) => ({
      platform: item.platform,
      component: item.component,
      name: item.name,
      url: item.url,
    })),
    items: httpItems,
  };
}

function compareFingerprints(current, previous) {
  if (!previous || !Array.isArray(previous.items)) return null;
  const prevByUrl = new Map(previous.items.map((item) => [item.url, item]));
  const currUrls = new Set(current.items.map((item) => item.url));
  const changed = [];
  const added = [];
  let unchanged = 0;
  for (const item of current.items) {
    const old = prevByUrl.get(item.url);
    if (!old) {
      added.push(item);
      continue;
    }
    const reasons = [];
    if (old.ok === false && item.ok === true) reasons.push("was missing, now reachable");
    if (item.ok === false && old.ok === true) reasons.push("was reachable, now missing");
    if (old.sha256 && item.sha256 && old.sha256 !== item.sha256) reasons.push("manifest sha256 changed");
    if (old.contentMd5 && item.contentMd5 && old.contentMd5 !== item.contentMd5) reasons.push("content md5 changed");
    if (old.lastModified && item.lastModified && old.lastModified !== item.lastModified) reasons.push("last-modified changed");
    if (old.sizeBytes != null && item.sizeBytes != null && old.sizeBytes !== item.sizeBytes) reasons.push("size changed");
    if (reasons.length) changed.push({ ...item, previous: old, reasons });
    else unchanged += 1;
  }
  const removed = previous.items.filter((item) => !currUrls.has(item.url));
  const previousFailures = Array.isArray(previous.failures) && previous.failures.length
    ? previous.failures
    : previous.items.filter((item) => item.ok === false).map((item) => ({
        platform: item.platform,
        component: item.component,
        name: item.name,
        url: item.url,
      }));
  const currentComponents = current.components || {};
  const previousComponents = previous.components || {};
  return {
    baseline: "last-failed",
    comparedTo: previous.savedAt,
    previousChannel: previous.channel,
    previousComponents,
    currentComponents,
    currentChannel: current.channel || "",
    versionsUnchanged: JSON.stringify(currentComponents) === JSON.stringify(previousComponents),
    previousFailures,
    unchanged,
    changed,
    added,
    removed,
  };
}

function releaseSignature(comparison) {
  const moved = [...comparison.changed, ...comparison.added, ...comparison.removed]
    .map((item) => `${item.url}|${(item.reasons || []).join(",")}|${item.sha256 || ""}|${item.lastModified || ""}`)
    .sort();
  return [
    comparison.previousChannel || "",
    comparison.currentChannel || "",
    JSON.stringify(comparison.previousComponents || {}),
    JSON.stringify(comparison.currentComponents || {}),
    comparison.versionsUnchanged ? "same-versions" : "version-bump",
    ...moved,
  ].join("\n");
}

function newestPublishedAt(comparison) {
  const stamps = [...comparison.changed, ...comparison.added]
    .map((item) => Date.parse(item.lastModified || ""))
    .filter((value) => !Number.isNaN(value));
  if (!stamps.length) return null;
  return new Date(Math.max(...stamps)).toISOString();
}

function describeRelease(comparison, detectedAt) {
  const moved = comparison.changed.length + comparison.added.length + comparison.removed.length;
  const versionsMoved = !comparison.versionsUnchanged;
  if (!moved && !versionsMoved) {
    return {
      believedNew: false,
      detectedAt: null,
      publishedAt: null,
      belief: "not a new release",
      reasons: ["Not a new release. Version numbers and published files match the last check."],
    };
  }
  const reasons = [];
  let belief = "same version, files replaced";
  if (versionsMoved) {
    belief = "version bump";
    reasons.push(
      `Component versions changed from ${componentLine(comparison.previousComponents)} to ${componentLine(comparison.currentComponents)}.`
    );
  } else {
    reasons.push(
      `Component versions stayed ${componentLine(comparison.currentComponents)}.`
    );
  }
  if (comparison.previousChannel && comparison.currentChannel && comparison.previousChannel !== comparison.currentChannel) {
    belief = "channel change";
    reasons.push(`Channel changed from ${comparison.previousChannel} to ${comparison.currentChannel}.`);
  }
  const appeared = comparison.changed.filter((item) => item.reasons.includes("was missing, now reachable"));
  const hashChanged = comparison.changed.filter((item) =>
    item.reasons.some((reason) => /sha256|md5|size/.test(reason))
  );
  if (appeared.length) {
    const names = appeared.map((item) => item.name).join(", ");
    reasons.push(`These artifacts failed last time and are reachable now: ${names}.`);
    const sameSha = appeared.filter((item) => item.previous && item.previous.sha256 && item.previous.sha256 === item.sha256);
    if (sameSha.length === appeared.length) {
      belief = versionsMoved ? belief : "same version, missing files published";
      reasons.push("Their manifest sha256 matches the failed run, so the declared package was published late rather than rebuilt.");
    }
  }
  if (hashChanged.length) {
    belief = versionsMoved ? belief : "same version, replaced bytes";
    reasons.push(`Content hash or size changed on ${hashChanged.map((item) => item.name).join(", ")}.`);
  }
  if (comparison.added.length) {
    reasons.push(`${comparison.added.length} artifact URL(s) were not in the failed run.`);
  }
  const publishedAt = newestPublishedAt(comparison);
  reasons.push(`We treated this as a new release because it is a ${belief}.`);
  return {
    believedNew: true,
    detectedAt,
    publishedAt,
    belief,
    reasons,
  };
}

function componentLine(components) {
  const c = components || {};
  return `TSDB ${c.tsdb || "—"} · IDMP ${c.idmp || "—"} · TDgpt ${c.tdgpt || "—"} · TDmodel ${c.tdmodel || "—"}`;
}

function hashLinesFor(item) {
  const lines = [];
  const prevSha = item.previous && item.previous.sha256;
  const nextSha = item.sha256;
  if (prevSha || nextSha) {
    if (prevSha && nextSha && prevSha === nextSha) {
      lines.push(`    sha256 unchanged ${nextSha}`);
    } else {
      lines.push(`    sha256 ${prevSha || "—"} -> ${nextSha || "—"}`);
    }
  }
  const prevMd5 = item.previous && item.previous.contentMd5;
  const nextMd5 = item.contentMd5;
  if (prevMd5 || nextMd5) {
    if (prevMd5 && nextMd5 && prevMd5 === nextMd5) {
      lines.push(`    md5 unchanged ${nextMd5}`);
    } else {
      lines.push(`    md5 ${prevMd5 || "—"} -> ${nextMd5 || "—"}`);
    }
  }
  if (item.previous && (item.previous.lastModified || item.lastModified)) {
    lines.push(`    modified ${item.previous.lastModified || "missing"} -> ${item.lastModified || "missing"}`);
  }
  return lines;
}

function hashCompareText(comparison) {
  if (!comparison) {
    return [
      "Compared with the last check:",
      "  No previous run is stored yet. This run becomes the baseline for the next report.",
    ].join("\n");
  }
  const release = comparison.release;
  const lines = [
    "Compared with the last check:",
    `  Last check: ${formatPst(comparison.comparedTo)} channel ${comparison.previousChannel || "unknown"}`,
    `  Last versions: ${componentLine(comparison.previousComponents)}`,
    `  This run: ${componentLine(comparison.currentComponents)}`,
    comparison.versionsUnchanged ? "  Version numbers did not change." : "  Version numbers changed.",
  ];
  if (!release) {
    lines.push("  Release: not classified.");
  } else if (!release.believedNew) {
    lines.push(`  ${release.reasons[0]}`);
  } else {
    lines.push(`  New drop first seen ${formatPst(release.detectedAt)}`);
    if (release.publishedAt) lines.push(`  Newest file timestamp ${formatPst(release.publishedAt)}`);
    lines.push(`  Why: ${release.belief}`);
    for (const reason of release.reasons) lines.push(`    - ${reason}`);
  }
  lines.push("  What changed:");
  if (!comparison.changed.length && !comparison.added.length && !comparison.removed.length) {
    lines.push("    Nothing. Same versions, same files.");
  }
  for (const item of comparison.changed) {
    lines.push(`    - [${item.platform}] ${item.component} ${item.name}: ${item.reasons.join("; ")}`);
    lines.push(...hashLinesFor(item));
  }
  for (const item of comparison.added) {
    lines.push(`    - [${item.platform}] ${item.component} ${item.name}: new url`);
  }
  for (const item of comparison.removed) {
    lines.push(`    - [${item.platform}] ${item.component} ${item.name}: no longer in the catalog`);
  }
  lines.push(`  Unchanged artifacts: ${comparison.unchanged}`);
  return lines.join("\n");
}

module.exports = {
  fetchCatalog,
  planChecks,
  runChecks,
  summarize,
  supportEmailBody,
  withAiSummary,
  fingerprintRun,
  compareFingerprints,
  hashCompareText,
  releaseSignature,
  describeRelease,
};
