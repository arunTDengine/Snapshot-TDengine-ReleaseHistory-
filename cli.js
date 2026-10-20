#!/usr/bin/env node
"use strict";

const os = require("os");

const { fetchCatalog } = require("./engine");
const { buildHumanReport } = require("./report");
const { formatPst } = require("./time");
const {
  runSmokeTest,
  readSnapshotFile,
  markPosted,
  shouldPostWatch,
  resolveUserData,
} = require("./runner");
const { sendReport } = require("./feishu");

function logLine(message) {
  const stamp = formatPst(new Date(), { seconds: true });
  console.log(`[${stamp}] ${message}`);
}

function usage() {
  console.log(`Usage: node cli.js <command>

Commands:
  daily      Run the full smoke test and post to Feishu (7:00 AM PT job)
  watch      Run only if the catalog looks like a new drop, then post
  once       Run the full smoke test and print the report (no Feishu)
  preview    Rebuild the readable report from the last stored snapshot
  catalog    Print the live channel and versions
`);
}

function previewFromStore() {
  const stored = readSnapshotFile();
  if (!stored || !stored.latest) {
    throw new Error("No snapshot yet. Run a smoke test first.");
  }
  const latest = stored.latest;
  return buildHumanReport({
    catalog: {
      fetched_at: latest.savedAt,
      channel: latest.channel,
      components: latest.components,
    },
    summary: {
      passed: (latest.items || []).filter((item) => item.ok).length,
      failed: latest.failed || 0,
      total: (latest.items || []).length,
      failures: latest.failures || [],
      platforms: {},
    },
    trigger: "preview",
  });
}

async function catalogOnly() {
  const catalog = await fetchCatalog();
  console.log(
    [
      `Checked ${formatPst(catalog.fetched_at)}`,
      `Channel ${catalog.channel}`,
      `TSDB ${catalog.components.tsdb} · IDMP ${catalog.components.idmp} · TDgpt ${catalog.components.tdgpt} · TDmodel ${catalog.components.tdmodel}`,
    ].join("\n")
  );
}

async function catalogLooksNew() {
  const catalog = await fetchCatalog();
  const stored = readSnapshotFile();
  if (!stored || !stored.latest) return { fresh: true, catalog };
  const prev = stored.latest;
  const channelMoved = prev.channel !== catalog.channel;
  const versionsMoved = JSON.stringify(prev.components || {}) !== JSON.stringify(catalog.components || {});
  return { fresh: channelMoved || versionsMoved, catalog, channelMoved, versionsMoved };
}

async function runAndMaybePost(trigger) {
  if (trigger === "watch") {
    const peek = await catalogLooksNew();
    if (!peek.fresh) {
      logLine(
        `Catalog still ${peek.catalog.channel} / TSDB ${peek.catalog.components.tsdb}. No new drop.`
      );
      return { posted: false, skipped: true };
    }
    logLine(
      `Catalog moved to ${peek.catalog.channel} / TSDB ${peek.catalog.components.tsdb}. Running smoke test.`
    );
  }
  logLine(`Starting ${trigger} smoke test`);
  const report = await runSmokeTest({ trigger });
  const believedNew = Boolean(report.hashCompare && report.hashCompare.release && report.hashCompare.release.believedNew);
  logLine(`${report.human.headline} · ${report.human.smoke}`);
  if (report.snapshot && report.snapshot.mdPath) {
    logLine(`Saved snapshot ${report.snapshot.stamp}${report.snapshot.committed ? " and committed" : ""}${report.snapshot.pushed ? " / pushed" : ""}`);
  }
  if (trigger === "watch" && !shouldPostWatch(report.hashCompare)) {
    logLine("No new drop since the last Feishu post. Skipping send.");
    return { posted: false, report };
  }
  if (trigger === "once") {
    console.log(report.aiSummary || report.human.plain);
    return { posted: false, report };
  }
  const sent = await sendReport(report);
  markPosted(undefined, report.hashCompare, trigger);
  logLine(`Posted to Feishu ${sent.chatName} (${sent.messageId || "ok"})`);
  return { posted: true, report };
}

async function main() {
  const command = (process.argv[2] || "").toLowerCase();
  if (!command || command === "-h" || command === "--help") {
    usage();
    process.exit(command ? 0 : 1);
  }
  logLine(`Data dir ${resolveUserData()} host ${os.hostname()}`);
  if (command === "catalog") {
    await catalogOnly();
    return;
  }
  if (command === "preview") {
    console.log(previewFromStore().plain);
    return;
  }
  if (command === "daily" || command === "watch" || command === "once") {
    await runAndMaybePost(command);
    return;
  }
  usage();
  process.exit(1);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
