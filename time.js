"use strict";

const TIMEZONE = "America/Los_Angeles";

function asDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatPst(value, { seconds = false } = {}) {
  const date = asDate(value);
  if (!date) return "unknown";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: seconds ? "2-digit" : undefined,
    timeZoneName: "short",
  }).format(date);
}

function formatPstClock(value) {
  const date = asDate(value);
  if (!date) return "unknown";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function formatChannel(channel) {
  const text = String(channel || "").trim();
  const match = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) return text || "unknown";
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
  return `${text} (${label} drop)`;
}

module.exports = {
  TIMEZONE,
  asDate,
  formatPst,
  formatPstClock,
  formatChannel,
};
