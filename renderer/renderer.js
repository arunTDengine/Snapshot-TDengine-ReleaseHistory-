"use strict";

const $ = (id) => document.getElementById(id);

let catalog = null;
let lastReport = null;
let busy = false;

function setStatus(text) {
  $("status").textContent = text;
}

function setBar(done, total) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  $("bar").style.width = `${pct}%`;
}

function platforms() {
  const selected = [];
  if ($("p-linux").checked) selected.push("linux");
  if ($("p-windows").checked) selected.push("windows");
  if ($("p-docker").checked) selected.push("docker");
  return selected;
}

function renderCatalog(data) {
  catalog = data;
  const c = data.components || {};
  $("v-channel").textContent = data.channel || "—";
  $("v-tsdb").textContent = c.tsdb || "—";
  $("v-idmp").textContent = c.idmp || "—";
  $("v-tdgpt").textContent = c.tdgpt || "—";
  $("v-tdmodel").textContent = c.tdmodel || "—";
  $("live-line").textContent = `Live catalog · downloads.tdengine.com · fetched ${data.fetched_at ? new Date(data.fetched_at).toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit", timeZoneName: "short" }) : "unknown"} · daily brief 7:00 AM PT`;
}

function renderRows(results) {
  const body = $("rows");
  body.innerHTML = "";
  if (!results.length) {
    body.innerHTML = `<tr class="empty"><td colspan="8">No artifacts matched the selected platforms.</td></tr>`;
    return;
  }
  for (const item of results) {
    const tr = document.createElement("tr");
    if (!item.ok) tr.className = "row-fail";
    tr.innerHTML = `
      <td>${item.platform}</td>
      <td>${item.component}</td>
      <td title="${item.url}">${item.name}</td>
      <td><span class="badge ${item.ok ? "pass" : "fail"}">${item.ok ? "PASS" : "FAIL"}</span></td>
      <td>${item.http ?? ""}</td>
      <td>${item.size || ""}</td>
      <td title="${item.sha256 || item.contentMd5 || ""}">${shortHash(item)}</td>
      <td title="${item.detail}">${item.detail}</td>
    `;
    body.appendChild(tr);
  }
}

function renderSummary(summary) {
  for (const key of ["linux", "windows", "docker"]) {
    const slot = summary.platforms[key];
    $(`s-${key}`).textContent = slot ? `${slot.pass}/${slot.total} pass · ${slot.fail} fail` : "—";
  }
  $("s-total").textContent = `${summary.passed}/${summary.total} pass · ${summary.failed} fail`;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

function shortHash(item) {
  const value = item.sha256 || item.contentMd5 || "";
  if (!value) return "";
  return value.slice(0, 12);
}

function renderHashCompare(human) {
  const panel = $("hash-panel");
  const body = $("hash-body");
  if (!human) {
    body.innerHTML = `<p>No previous run is stored yet. This check becomes the baseline the next report is compared with.</p>`;
    panel.hidden = false;
    return;
  }
  body.innerHTML = human.html || `<pre>${esc(human.plain || "")}</pre>`;
  panel.hidden = false;
}

function renderAiSummary(text) {
  const panel = $("ai-panel");
  const body = $("ai-body");
  if (!text) {
    panel.hidden = true;
    body.textContent = "";
    return;
  }
  body.textContent = text;
  panel.hidden = false;
}

async function refreshCatalog() {
  setStatus("Fetching current All-in-One catalog…");
  try {
    const data = await window.aio.fetchCatalog();
    renderCatalog(data);
    setStatus("Ready. Press Run smoke tests to check the latest published packages.");
  } catch (err) {
    $("live-line").textContent = "Could not reach the download center.";
    setStatus(String(err.message || err));
  }
}

async function runTests() {
  if (busy) return;
  const selected = platforms();
  if (!selected.length) {
    setStatus("Select Linux, Windows, or Docker.");
    return;
  }
  busy = true;
  $("run-btn").disabled = true;
  $("feishu-btn").disabled = true;
  $("rows").innerHTML = `<tr class="empty"><td colspan="8">Fetching the latest catalog, then checking artifacts…</td></tr>`;
  renderAiSummary("");
  $("hash-panel").hidden = true;
  setBar(0, 1);
  const stop = window.aio.onProgress((progress) => {
    setBar(progress.done || 0, progress.total || 1);
    setStatus(progress.message);
  });
  try {
    const report = await window.aio.runChecks(selected);
    lastReport = report;
    renderCatalog(report.catalog);
    renderRows(report.results);
    renderSummary(report.summary);
    renderHashCompare(report.human);
    renderAiSummary(report.aiSummary);
    setBar(report.summary.total, report.summary.total);
    setStatus(
      `Done against live catalog ${report.catalog.channel}. ${report.summary.passed} passed, ${report.summary.failed} failed.`
    );
  } catch (err) {
    setStatus(String(err.message || err));
  } finally {
    stop();
    busy = false;
    $("run-btn").disabled = false;
    $("feishu-btn").disabled = !lastReport;
  }
}

$("refresh-btn").addEventListener("click", refreshCatalog);
$("run-btn").addEventListener("click", runTests);
$("copy-btn").addEventListener("click", async () => {
  if (!lastReport) {
    setStatus("Run a test first.");
    return;
  }
  await window.aio.copyReport(lastReport.email);
  setStatus("Failure report copied to clipboard.");
});
$("save-btn").addEventListener("click", async () => {
  if (!lastReport) {
    setStatus("Run a test first.");
    return;
  }
  const path = await window.aio.saveReport(lastReport);
  if (path) setStatus(`Saved ${path}`);
});
$("feishu-btn").addEventListener("click", async () => {
  if (!lastReport) {
    setStatus("Run a test first.");
    return;
  }
  $("feishu-btn").disabled = true;
  setStatus("Sending report to Feishu · Smoke Test Results…");
  try {
    const sent = await window.aio.sendFeishu(lastReport);
    if (sent.aiSummary) {
      lastReport.aiSummary = sent.aiSummary;
      renderAiSummary(sent.aiSummary);
    }
    setStatus(`Posted to Feishu chat ${sent.chatName}, including the AI summary.`);
  } catch (err) {
    setStatus(String(err.message || err));
  } finally {
    $("feishu-btn").disabled = false;
  }
});

window.addEventListener("focus", () => {
  if (!busy) refreshCatalog();
});

refreshCatalog();
