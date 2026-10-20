"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { formatPst } = require("./time");

const ROOT = __dirname;
const SNAP_DIR = path.join(ROOT, "snapshots");

function stampName(value) {
  const date = value ? new Date(value) : new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).formatToParts(date);
  const get = (type) => (parts.find((part) => part.type === type) || {}).value || "00";
  return `${get("year")}-${get("month")}-${get("day")}-${get("hour")}${get("minute")}-${get("timeZoneName")}`;
}

function compactResults(results = []) {
  return results.map((item) => ({
    platform: item.platform,
    component: item.component,
    name: item.name,
    ok: item.ok,
    http: item.http,
    detail: item.detail,
    size: item.size || "",
    sha256: item.sha256 ? String(item.sha256).slice(0, 12) : "",
  }));
}

function writeRunSnapshot(report) {
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  const stamp = stampName(report.catalog && report.catalog.fetched_at);
  const human = report.human || {};
  const payload = {
    fetched_at: report.catalog && report.catalog.fetched_at,
    fetched_at_pt: human.fetchedAt || formatPst(report.catalog && report.catalog.fetched_at),
    channel: report.catalog && report.catalog.channel,
    components: (report.catalog && report.catalog.components) || {},
    trigger: report.trigger || "current",
    summary: {
      passed: report.summary && report.summary.passed,
      failed: report.summary && report.summary.failed,
      total: report.summary && report.summary.total,
      platforms: (report.summary && report.summary.platforms) || {},
      failures: (report.summary && report.summary.failures) || [],
    },
    results: compactResults(report.results),
    aiSummary: report.aiSummary || null,
    report: human.plain || "",
  };
  const mdPath = path.join(SNAP_DIR, `${stamp}.md`);
  const jsonPath = path.join(SNAP_DIR, `${stamp}.json`);
  const body = `${human.plain || ""}\n`;
  fs.writeFileSync(mdPath, body);
  fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  fs.writeFileSync(path.join(SNAP_DIR, "latest.md"), body);
  fs.writeFileSync(path.join(SNAP_DIR, "latest.json"), `${JSON.stringify(payload, null, 2)}\n`);
  return { stamp, mdPath, jsonPath };
}

function git(args, opts = {}) {
  return spawnSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    ...opts,
  });
}

function commitSnapshots(report, files) {
  const inside = git(["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0) {
    return { committed: false, reason: "not a git repo yet" };
  }
  const add = git(["add", "snapshots"]);
  if (add.status !== 0) {
    return { committed: false, reason: (add.stderr || add.stdout || "git add failed").trim() };
  }
  const staged = git(["diff", "--cached", "--name-only"]);
  if (!String(staged.stdout || "").trim()) {
    return { committed: false, reason: "nothing new to save" };
  }
  const channel = (report.catalog && report.catalog.channel) || "unknown";
  const smoke = (report.human && report.human.smoke) || "smoke";
  const message = `Snapshot ${files.stamp}: channel ${channel}, ${smoke}`;
  const commit = git(["commit", "-m", message]);
  if (commit.status !== 0) {
    return { committed: false, reason: (commit.stderr || commit.stdout || "git commit failed").trim() };
  }
  const remotes = git(["remote"]);
  if (!String(remotes.stdout || "").includes("origin")) {
    return { committed: true, pushed: false, reason: "no origin yet" };
  }
  const push = git(["push", "-u", "origin", "HEAD"]);
  if (push.status !== 0) {
    return { committed: true, pushed: false, reason: (push.stderr || push.stdout || "git push failed").trim() };
  }
  return { committed: true, pushed: true };
}

function saveAndCommitSnapshot(report) {
  const files = writeRunSnapshot(report);
  const gitResult = commitSnapshots(report, files);
  return { ...files, ...gitResult };
}

module.exports = {
  SNAP_DIR,
  writeRunSnapshot,
  saveAndCommitSnapshot,
};
