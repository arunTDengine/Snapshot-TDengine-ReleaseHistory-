"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  fetchCatalog,
  planChecks,
  runChecks,
  summarize,
  fingerprintRun,
  compareFingerprints,
  releaseSignature,
  describeRelease,
} = require("./engine");
const { buildHumanReport } = require("./report");
const { summarizeIssues } = require("./ai-summary");
const { saveAndCommitSnapshot } = require("./snapshot");

const DEFAULT_USER_DATA = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "TDengine All-in-One Smoketest"
);

function resolveUserData(userDataDir) {
  return userDataDir || process.env.AIO_SMOKETEST_DATA || DEFAULT_USER_DATA;
}

function snapshotPath(userDataDir) {
  return path.join(resolveUserData(userDataDir), "artifact-hashes.json");
}

function readSnapshotFile(userDataDir) {
  try {
    return JSON.parse(fs.readFileSync(snapshotPath(userDataDir), "utf8"));
  } catch {
    return null;
  }
}

function writeSnapshotFile(userDataDir, payload) {
  const dir = resolveUserData(userDataDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(snapshotPath(userDataDir), JSON.stringify(payload, null, 2));
}

function storeSnapshot(catalog, results, userDataDir) {
  const stored = readSnapshotFile(userDataDir) || {};
  const latest = fingerprintRun(catalog, results);
  let lastFailed = stored.lastFailed || null;
  if (!lastFailed && stored.latest && stored.latest.failed) lastFailed = stored.latest;
  if (!lastFailed && stored.latest && (stored.latest.items || []).some((item) => item.ok === false)) {
    lastFailed = stored.latest;
  }

  const previous = stored.latest || null;
  const comparison = compareFingerprints(latest, previous);
  let releaseSighting = stored.releaseSighting || null;
  if (comparison) {
    comparison.baseline = "previous-run";
    const signature = releaseSignature(comparison);
    const sameSighting = releaseSighting && releaseSighting.signature === signature;
    const seeded = releaseSighting && releaseSighting.detectedAt && !releaseSighting.signature;
    const detectedAt = sameSighting || seeded ? releaseSighting.detectedAt : latest.savedAt;
    comparison.release = describeRelease(comparison, detectedAt);
    if (comparison.release.believedNew) {
      releaseSighting = { signature, detectedAt, belief: comparison.release.belief };
    }
  }
  if (latest.failed > 0) lastFailed = latest;
  writeSnapshotFile(userDataDir, {
    latest,
    previous,
    lastFailed,
    releaseSighting,
    lastPosted: stored.lastPosted || null,
  });
  return comparison;
}

function markPosted(userDataDir, comparison, trigger) {
  const stored = readSnapshotFile(userDataDir) || {};
  stored.lastPosted = {
    signature: comparison && comparison.release ? releaseSignature(comparison) : "",
    postedAt: new Date().toISOString(),
    trigger: trigger || "manual",
    channel: (comparison && comparison.currentChannel) || "",
    believedNew: Boolean(comparison && comparison.release && comparison.release.believedNew),
  };
  writeSnapshotFile(userDataDir, stored);
  return stored.lastPosted;
}

function shouldPostWatch(comparison, userDataDir) {
  if (!comparison || !comparison.release || !comparison.release.believedNew) return false;
  const stored = readSnapshotFile(userDataDir) || {};
  const signature = releaseSignature(comparison);
  return !stored.lastPosted || stored.lastPosted.signature !== signature;
}

async function runSmokeTest({
  platforms = ["linux", "windows", "docker"],
  userDataDir,
  trigger = "manual",
  onProgress,
} = {}) {
  const catalog = await fetchCatalog();
  const items = await planChecks(catalog, platforms);
  if (onProgress) {
    onProgress({ done: 0, total: items.length, message: `Checking ${items.length} artifacts…` });
  }
  const results = await runChecks(items, onProgress);
  const summary = summarize(results);
  const hashCompare = storeSnapshot(catalog, results, userDataDir);
  if (onProgress) {
    onProgress({
      done: results.length,
      total: items.length,
      message: "Writing the readable report…",
    });
  }
  const draft = { catalog, results, summary, hashCompare, trigger };
  const human = buildHumanReport(draft);
  const aiSummary = await summarizeIssues({ ...draft, human });
  const full = { ...draft, human, aiSummary };
  const snapshot = saveAndCommitSnapshot(full);
  return { ...full, snapshot };
}

module.exports = {
  DEFAULT_USER_DATA,
  resolveUserData,
  snapshotPath,
  readSnapshotFile,
  storeSnapshot,
  markPosted,
  shouldPostWatch,
  runSmokeTest,
};
