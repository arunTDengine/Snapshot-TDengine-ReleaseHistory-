"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { summarizeIssues } = require("./ai-summary");
const { buildHumanReport, triggerLabel } = require("./report");

const FEISHU_API = "https://open.feishu.cn/open-apis";
const DEFAULT_CHAT_ID = "oc_c76fed0770f5f882333a2add92a7f6d8";
const DEFAULT_CHAT_NAME = "Smoke Test Results";
const DEFAULT_ENV_FILE = path.join(os.homedir(), "na-customer-reports", ".env");

let cachedToken = { value: "", expiresAt: 0 };

function stripQuotes(value) {
  const text = String(value || "").trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function parseEnvFile(filePath) {
  const env = {};
  if (!fs.existsSync(filePath)) return env;
  for (const raw of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    env[line.slice(0, eq).trim()] = stripQuotes(line.slice(eq + 1));
  }
  return env;
}

function loadConfig() {
  const fileEnv = parseEnvFile(process.env.FEISHU_ENV_FILE || DEFAULT_ENV_FILE);
  const appId = process.env.FEISHU_APP_ID || fileEnv.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET || fileEnv.FEISHU_APP_SECRET;
  const chatId =
    process.env.FEISHU_SMOKETEST_CHAT_ID ||
    fileEnv.FEISHU_SMOKETEST_CHAT_ID ||
    DEFAULT_CHAT_ID;
  if (!appId || !appSecret) {
    throw new Error(
      `Feishu credentials not found. Add FEISHU_APP_ID and FEISHU_APP_SECRET to ${DEFAULT_ENV_FILE}`
    );
  }
  return { appId, appSecret, chatId, chatName: DEFAULT_CHAT_NAME };
}

async function fetchJson(url, options = {}) {
  const resp = await fetch(url, options);
  const text = await resp.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Feishu HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  return payload;
}

async function getTenantToken(cfg) {
  if (cachedToken.value && Date.now() < cachedToken.expiresAt) {
    return cachedToken.value;
  }
  const payload = await fetchJson(`${FEISHU_API}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
  });
  if (!payload.tenant_access_token) {
    throw new Error(payload.msg || "Could not get Feishu tenant token");
  }
  cachedToken = {
    value: payload.tenant_access_token,
    expiresAt: Date.now() + Math.max(30, (payload.expire || 7200) - 120) * 1000,
  };
  return cachedToken.value;
}

function escapeMd(text) {
  return String(text || "").replace(/([\\*_\[\]~`])/g, "\\$1");
}

function platformLine(summary, key) {
  const slot = summary.platforms[key];
  if (!slot) return `${key}: not checked`;
  return `${key}: ${slot.pass}/${slot.total} pass · ${slot.fail} fail`;
}

function buildCard(report) {
  const { catalog, summary } = report;
  const failed = summary.failed > 0;
  const human = report.human || buildHumanReport(report);
  const failureLines = (summary.failures || []).slice(0, 12).map((item) => {
    return `- [${escapeMd(item.platform)}] ${escapeMd(item.component)} ${escapeMd(item.name)}: ${escapeMd(item.detail)}`;
  });
  if ((summary.failures || []).length > 12) {
    failureLines.push(`- …and ${summary.failures.length - 12} more`);
  }

  const footer = [
    "",
    platformLine(summary, "linux"),
    platformLine(summary, "windows"),
    platformLine(summary, "docker"),
    "",
    failed ? `**Failures (${summary.failed})**` : "**All artifacts are available.**",
    ...failureLines,
  ].join("\n");

  const elements = [];
  if (report.aiSummary) {
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: `**In plain English**\n${report.aiSummary}`,
      },
    });
    elements.push({ tag: "hr" });
  }
  elements.push({
    tag: "div",
    text: { tag: "lark_md", content: `${human.markdown}\n${footer}` },
  });
  elements.push({ tag: "hr" });
  elements.push({
    tag: "note",
    elements: [
      {
        tag: "plain_text",
        content: `Posted from TDengine All-in-One Smoketest · ${triggerLabel(report.trigger)} · times in PT`,
      },
    ],
  });

  const titleCore = failed
    ? `${summary.failed} failed`
    : `${summary.passed}/${summary.total} passed`;

  return {
    config: { wide_screen_mode: true },
    header: {
      template: failed ? "red" : "green",
      title: {
        tag: "plain_text",
        content: `All-in-One · ${catalog.channel || "live"} · ${titleCore}`.replace(/\s+/g, " ").trim(),
      },
    },
    elements,
  };
}

async function sendReport(report) {
  if (!report || !report.catalog || !report.summary) {
    throw new Error("Run a smoke test before sending to Feishu.");
  }
  const human = report.human || buildHumanReport(report);
  const aiSummary = report.aiSummary || (await summarizeIssues({ ...report, human }));
  const cfg = loadConfig();
  const token = await getTenantToken(cfg);
  const payload = await fetchJson(
    `${FEISHU_API}/im/v1/messages?receive_id_type=chat_id`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        receive_id: cfg.chatId,
        msg_type: "interactive",
        content: JSON.stringify(buildCard({ ...report, human, aiSummary })),
      }),
    }
  );
  if (payload.code !== 0) {
    throw new Error(payload.msg || `Feishu send failed (code ${payload.code})`);
  }
  return {
    chatName: cfg.chatName,
    chatId: cfg.chatId,
    messageId: payload.data && payload.data.message_id,
    aiSummary,
  };
}

module.exports = {
  DEFAULT_CHAT_ID,
  DEFAULT_CHAT_NAME,
  loadConfig,
  buildCard,
  sendReport,
};
