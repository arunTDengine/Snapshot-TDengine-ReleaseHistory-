"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const ENV_FILES = [
  path.join(os.homedir(), "na-crm", ".env"),
  path.join(os.homedir(), "na-customer-reports", ".env"),
];

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
    const cleaned = line.startsWith("export ") ? line.slice(7) : line;
    const eq = cleaned.indexOf("=");
    if (eq < 1) continue;
    env[cleaned.slice(0, eq).trim()] = stripQuotes(cleaned.slice(eq + 1));
  }
  return env;
}

function loadAiConfig() {
  const fileEnv = {};
  for (const file of ENV_FILES) Object.assign(fileEnv, parseEnvFile(file));
  return {
    apiKey: process.env.OPENAI_API_KEY || fileEnv.OPENAI_API_KEY || "",
    model: process.env.AI_MODEL || fileEnv.AI_MODEL || "gpt-5-mini",
  };
}

const { buildHumanReport } = require("./report");

function fallbackSummary(report) {
  const human = report.human || buildHumanReport(report);
  return human.plain;
}

function buildPrompt(report) {
  const human = report.human || buildHumanReport(report);
  return [
    "You write All-in-One download-center briefs for TDengine sales engineers and support.",
    "The smoketest only checks that files exist on the CDN. It does not run installers.",
    "Rewrite the facts below as 4-6 short sentences about THIS run only.",
    "Rules:",
    "- Use only the Pacific times already written (PDT/PST). Never write ISO-8601 or Zulu times.",
    "- Name the live channel and the four component versions. Do not invent versions.",
    "- Do not compare with a previous run. Git history is the changelog.",
    "- If files failed, say what that means for a customer install.",
    "- End with the smoke score.",
    "No greeting, no heading, no bullet list. Sparse **bold** is ok.",
    "",
    human.plain,
  ].join("\n");
}

async function openaiSummary(report) {
  const { apiKey, model } = loadAiConfig();
  if (!apiKey) throw new Error("OPENAI_API_KEY missing");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: "You write plain-English TDengine All-in-One release briefs in Pacific Time.",
          },
          { role: "user", content: buildPrompt(report) },
        ],
      }),
    });
    const text = await resp.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`OpenAI HTTP ${resp.status}`);
    }
    if (!resp.ok) {
      throw new Error(payload.error?.message || `OpenAI HTTP ${resp.status}`);
    }
    const content = payload.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("empty model response");
    return content.slice(0, 2500);
  } finally {
    clearTimeout(timer);
  }
}

async function summarizeIssues(report) {
  if (!report?.catalog || !report?.summary) {
    throw new Error("No smoke-test report to summarize.");
  }
  try {
    return await openaiSummary(report);
  } catch (err) {
    console.error("AI summary fallback:", err.message || err);
    return fallbackSummary(report);
  }
}

module.exports = { summarizeIssues, fallbackSummary };
