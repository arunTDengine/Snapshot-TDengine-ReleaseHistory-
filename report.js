"use strict";

const { formatPst, formatChannel } = require("./time");

const COMPONENT_LABELS = {
  tsdb: "TSDB",
  idmp: "IDMP",
  tdgpt: "TDgpt",
  tdmodel: "TDmodel",
};

function escapeMd(text) {
  return String(text || "").replace(/([\\*_\[\]~`])/g, "\\$1");
}

function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"]/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  }[ch]));
}

function friendlyName(name) {
  const text = String(name || "");
  const rules = [
    [/tdgpt-venv-linux-x64/i, "TDgpt Python environment (Linux x64)"],
    [/tdgpt-venv-linux-arm64/i, "TDgpt Python environment (Linux arm64)"],
    [/tdgpt-venv-win/i, "TDgpt Python environment (Windows)"],
    [/tdgpt-win-x64\.exe/i, "TDgpt Windows installer"],
    [/TDengineSetup/i, "Windows All-in-One setup"],
    [/^install\.sh$/i, "Linux / macOS install script"],
    [/docker-compose-tdengine/i, "Docker Compose file"],
  ];
  for (const [pattern, label] of rules) {
    if (pattern.test(text)) return label;
  }
  return text;
}

function versionRows(_previous = {}, current = {}) {
  return Object.keys(COMPONENT_LABELS).map((key) => ({
    key,
    label: COMPONENT_LABELS[key],
    from: current[key] || "—",
    to: current[key] || "—",
    changed: false,
  }));
}

function triggerLabel(trigger) {
  if (trigger === "daily") return "Daily 7:00 AM PT brief";
  if (trigger === "watch") return "New-release watch";
  if (trigger === "manual") return "Manual run";
  if (trigger === "once") return "Current run";
  return trigger || "Current run";
}

function explainFailure(item) {
  const name = friendlyName(item.name);
  const detail = String(item.detail || "");
  if (/404/.test(detail) && /tdgpt-venv/i.test(item.name || "")) {
    return {
      what: `${name} is missing (HTTP 404)`,
      why: "The TDgpt product package can still be listed while this Python environment is not on the CDN. All-in-One installs that enable TDgpt will fail when they download it.",
    };
  }
  if (/404/.test(detail)) {
    return {
      what: `${name} is missing (HTTP 404)`,
      why: "The catalog points at this file, but the CDN does not have it. Installs that need it will fail until it is published.",
    };
  }
  if (/HTTP/.test(detail)) {
    return {
      what: `${name} returned ${detail}`,
      why: "The download center did not serve a clean 200. Treat this path as not customer-ready until it is reachable.",
    };
  }
  return {
    what: `${name} failed`,
    why: detail || "The smoke test could not confirm this file is downloadable.",
  };
}

function platformStatus(summary, platform) {
  const slot = summary.platforms && summary.platforms[platform];
  const label = platform === "linux" ? "Linux host" : platform === "windows" ? "Windows host" : "Docker All-in-One";
  if (!slot) return { label, text: "Not checked in this run." };
  if (slot.fail === 0) {
    return { label, text: `${slot.pass}/${slot.total} files reachable. Stable-channel installs on this path look publish-ready.` };
  }
  const failed = (summary.failures || [])
    .filter((item) => item.platform === platform)
    .map((item) => friendlyName(item.name));
  return {
    label,
    text: `${slot.pass}/${slot.total} reachable, ${slot.fail} failing (${failed.join(", ")}). Do not send customers to this path until those files are up.`,
  };
}

function buildHumanReport(report) {
  const catalog = report.catalog || {};
  const summary = report.summary || {};
  const components = catalog.components || {};
  const fetchedAt = formatPst(catalog.fetched_at);
  const versions = versionRows({}, components);
  const smoke = summary.failed
    ? `${summary.passed}/${summary.total} artifacts reachable · ${summary.failed} failing`
    : `${summary.passed}/${summary.total} artifacts reachable`;
  const headline = `All-in-One smoke · ${formatChannel(catalog.channel)}`;
  const shipped = [
    `Channel ${formatChannel(catalog.channel)}`,
    versions.map((row) => `${row.label} ${row.to}`).join(" · "),
  ];
  const failures = (summary.failures || []).map(explainFailure);
  const impacts = ["linux", "windows", "docker"].map((platform) => platformStatus(summary, platform));
  const takeaway = summary.failed
    ? "This drop is not fully published. Use the failing files above before sending a customer to the stable channel."
    : "This drop is on the CDN. Linux, Windows, and Docker All-in-One installs from the stable channel should work.";

  const lines = [
    headline,
    `Checked ${fetchedAt} · ${triggerLabel(report.trigger)}`,
    "",
    "What's live now",
    ...shipped.map((line) => `- ${line}`),
    "",
    "This run",
    `- ${smoke}`,
  ];
  if (!failures.length) {
    lines.push("- Every checked artifact returned a clean download.");
  } else {
    for (const item of failures) {
      lines.push(`- ${item.what}`);
      lines.push(`  ${item.why}`);
    }
  }
  lines.push("");
  lines.push("Customer takeaway");
  lines.push(`- ${takeaway}`);
  for (const item of impacts) lines.push(`- ${item.label}: ${item.text}`);

  const md = [
    `**${escapeMd(headline)}**`,
    `Checked ${escapeMd(fetchedAt)} · ${escapeMd(triggerLabel(report.trigger))}`,
    "",
    "**What's live now**",
    ...shipped.map((line) => `- ${escapeMd(line)}`),
    "",
    "**This run**",
    `- ${escapeMd(smoke)}`,
  ];
  if (!failures.length) {
    md.push("- Every checked artifact returned a clean download.");
  } else {
    for (const item of failures) {
      md.push(`- **${escapeMd(item.what)}**`);
      md.push(`  ${escapeMd(item.why)}`);
    }
  }
  md.push("");
  md.push("**Customer takeaway**");
  md.push(`- ${escapeMd(takeaway)}`);
  for (const item of impacts) md.push(`- **${escapeMd(item.label)}:** ${escapeMd(item.text)}`);

  const html = [
    `<p><strong>${escapeHtml(headline)}</strong></p>`,
    `<p>Checked ${escapeHtml(fetchedAt)} · ${escapeHtml(triggerLabel(report.trigger))}</p>`,
    `<p><strong>What's live now</strong></p><ul class="hash-list">`,
    ...shipped.map((line) => `<li>${escapeHtml(line)}</li>`),
    `</ul>`,
    `<p><strong>This run</strong></p><ul class="hash-list">`,
    `<li>${escapeHtml(smoke)}</li>`,
  ];
  if (!failures.length) {
    html.push("<li>Every checked artifact returned a clean download.</li>");
  } else {
    for (const item of failures) {
      html.push(`<li><strong>${escapeHtml(item.what)}</strong><br>${escapeHtml(item.why)}</li>`);
    }
  }
  html.push("</ul>");
  html.push(`<p><strong>Customer takeaway</strong></p><p>${escapeHtml(takeaway)}</p><ul class="hash-list">`);
  for (const item of impacts) {
    html.push(`<li><strong>${escapeHtml(item.label)}:</strong> ${escapeHtml(item.text)}</li>`);
  }
  html.push("</ul>");

  return {
    headline,
    fetchedAt,
    detectedAt: fetchedAt,
    publishedAt: null,
    smoke,
    shipped,
    markdown: md.join("\n"),
    html: html.join(""),
    plain: lines.join("\n"),
    versions,
    believedNew: false,
    takeaway,
  };
}

module.exports = {
  friendlyName,
  versionRows,
  triggerLabel,
  explainFailure,
  buildHumanReport,
};
