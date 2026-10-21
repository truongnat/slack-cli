import { readFileSync } from 'node:fs';
import { stdin, stderr, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

export class CliError extends Error {
  constructor(message, { code = 'error', hint, exitCode = 1, cause } = {}) {
    super(message, { cause });
    this.name = 'CliError';
    this.code = code;
    this.hint = hint;
    this.exitCode = exitCode;
  }
}

export class UsageError extends CliError {
  constructor(message, opts = {}) {
    super(message, { code: 'usage', exitCode: 2, ...opts });
    this.name = 'UsageError';
  }
}

export class AuthError extends CliError {
  constructor(message, opts = {}) {
    super(message, { code: 'auth_required', exitCode: 3, ...opts });
    this.name = 'AuthError';
  }
}

export class NotFoundError extends CliError {
  constructor(message, opts = {}) {
    super(message, { code: 'not_found', exitCode: 4, ...opts });
    this.name = 'NotFoundError';
  }
}

export class NetworkError extends CliError {
  constructor(message, opts = {}) {
    super(message, { code: 'network_error', ...opts });
    this.name = 'NetworkError';
  }
}

export function writeOut(text = '') {
  stdout.write(String(text).endsWith('\n') ? String(text) : `${text}\n`);
}

export function writeErr(text = '') {
  stderr.write(String(text).endsWith('\n') ? String(text) : `${text}\n`);
}

export function progress(message) {
  if (stderr.isTTY) writeErr(message);
}

export function debug(enabled, message) {
  if (enabled) writeErr(`debug: ${message}`);
}

export function printJson(value) {
  writeOut(JSON.stringify(value, null, 2));
}

export function reportError(error, { json = false, debug: debugEnabled = false } = {}) {
  const code = error.code || 'error';
  const exitCode = error.exitCode || 1;
  if (json) {
    writeErr(JSON.stringify({
      ok: false,
      error: {
        code,
        message: error.message,
        ...(error.hint ? { hint: error.hint } : {}),
      },
    }));
  } else {
    writeErr(`error: ${error.message}`);
    if (error.hint) writeErr(`hint: ${error.hint}`);
    if (debugEnabled && error.stack) writeErr(error.stack);
  }
  return exitCode;
}

export function normalizeName(value) {
  return String(value ?? '').trim().replace(/^[#@]/, '').toLowerCase();
}

export function slackTsToDate(ts) {
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000);
}

export function formatTimestamp(ts, { withDate = true } = {}) {
  const date = slackTsToDate(ts);
  if (!date) return String(ts);
  const pad = (n) => String(n).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  if (!withDate) return time;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

export function formatDate(value) {
  if (!value) return '-';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let size = bytes;
  let index = -1;
  do {
    size /= 1024;
    index += 1;
  } while (size >= 1024 && index < units.length - 1);
  return `${size >= 10 ? Math.round(size) : size.toFixed(1)} ${units[index]}`;
}

export function oneLine(text, max = 160) {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

export function truncateMiddle(text, max = 40) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  const half = Math.floor((max - 1) / 2);
  return `${value.slice(0, half)}…${value.slice(-half)}`;
}

export function renderTable(headers, rows, { maxCellWidth = 60 } = {}) {
  if (rows.length === 0) return '';
  const normalizedRows = rows.map((row) => row.map((cell) => {
    const text = String(cell ?? '').replace(/\r?\n/g, ' ');
    return text.length > maxCellWidth ? `${text.slice(0, maxCellWidth - 1)}…` : text;
  }));
  const widths = headers.map((header, index) => Math.min(
    maxCellWidth,
    Math.max(
      String(header).length,
      ...normalizedRows.map((row) => String(row[index] ?? '').length),
    ),
  ));
  const formatRow = (row) => row
    .map((cell, index) => String(cell ?? '').padEnd(widths[index]))
    .join('  ')
    .trimEnd();
  const lines = [formatRow(headers), widths.map((width) => '-'.repeat(width)).join('  ')];
  for (const row of normalizedRows) lines.push(formatRow(row));
  return lines.join('\n');
}

export function renderKeyValues(entries) {
  const visible = entries.filter(([, value]) => value !== undefined && value !== null);
  if (visible.length === 0) return '';
  const width = Math.max(...visible.map(([key]) => String(key).length));
  return visible.map(([key, value]) => `${String(key).padEnd(width)} : ${value}`).join('\n');
}

export async function confirmAction(message, { yes = false, defaultValue = false } = {}) {
  if (yes) return true;
  if (!stdin.isTTY) {
    throw new UsageError(`${message} Pass --yes to skip the confirmation prompt.`);
  }
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const suffix = defaultValue ? '[Y/n]' : '[y/N]';
    const answer = (await rl.question(`${message} ${suffix} `)).trim().toLowerCase();
    if (!answer) return defaultValue;
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

export async function readStdin() {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export async function parseJsonInput(value, label = 'JSON') {
  let raw = value;
  if (raw === '-') raw = await readStdin();
  else if (typeof raw === 'string' && raw.startsWith('@')) raw = readFileSync(raw.slice(1), 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new UsageError(`Invalid ${label}: ${error.message}`);
  }
}

export function parsePositiveInt(value, label, { min = 1, max = Number.MAX_SAFE_INTEGER, fallback } = {}) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw new UsageError(`${label} is required.`);
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new UsageError(`${label} must be an integer between ${min} and ${max}.`);
  }
  return number;
}

export function cookieDomainMatches(domain, root) {
  const normalized = String(domain ?? '').replace(/^\./, '').toLowerCase();
  return normalized === root || normalized.endsWith(`.${root}`);
}

export function uniqueBy(items, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveTimeout(value, fallbackSeconds, label = 'timeout') {
  if (value === undefined || value === null) return fallbackSeconds * 1000;
  return parsePositiveInt(value, label, { min: 1, max: 3600 }) * 1000;
}

export function relativeTimeFromNow(value) {
  if (!value) return '-';
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return String(value);
  const delta = Date.now() - timestamp;
  if (delta < 0) return formatDate(value);
  return `${formatDuration(delta)} ago`;
}

export function closestMatch(value, candidates, limit = 5) {
  const needle = normalizeName(value);
  return candidates
    .filter((candidate) => normalizeName(candidate).includes(needle) || needle.includes(normalizeName(candidate)))
    .slice(0, limit);
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
