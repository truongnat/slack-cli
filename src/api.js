import { createReadStream, createWriteStream } from 'node:fs';
import { rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  CliError,
  NetworkError,
  formatDuration,
  sleep,
} from './util.js';

const AUTH_ERROR_CODES = new Set([
  'invalid_auth',
  'not_authed',
  'token_revoked',
  'token_expired',
  'account_inactive',
  'org_login_required',
]);

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';

export class SlackApiError extends CliError {
  constructor(method, code, data = {}, { hint } = {}) {
    super(`Slack API ${method} failed: ${code}`, { code, hint });
    this.name = 'SlackApiError';
    this.method = method;
    this.slackError = code;
    this.data = data;
  }
}

export function isAuthError(error) {
  return error instanceof SlackApiError && AUTH_ERROR_CODES.has(error.code);
}

export class SlackApi {
  constructor({
    token,
    cookieHeader,
    dCookie,
    userAgent = DEFAULT_USER_AGENT,
    baseUrl = 'https://slack.com/api',
    timeoutMs = 30000,
    maxRateRetries = 3,
    debug = false,
  }) {
    if (!token) throw new CliError('A Slack token is required.', { code: 'missing_token' });
    this.token = token;
    this.cookieHeader = cookieHeader || (dCookie ? `d=${dCookie}` : '');
    this.userAgent = userAgent || DEFAULT_USER_AGENT;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.maxRateRetries = maxRateRetries;
    this.debug = debug;
  }

  async call(method, params = {}) {
    if (!/^[a-z][a-z0-9._]*$/i.test(method)) {
      throw new CliError(`Invalid Slack API method: ${method}`, { code: 'invalid_method' });
    }
    let attempt = 0;
    while (true) {
      const started = Date.now();
      let response;
      try {
        response = await fetch(`${this.baseUrl}/${method}`, {
          method: 'POST',
          headers: this.headers(),
          body: encodeParams({ ...params, token: this.token }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        if (error.name === 'TimeoutError' || error.name === 'AbortError') {
          throw new NetworkError(`Slack API ${method} timed out after ${formatDuration(this.timeoutMs)}.`, {
            hint: 'Check your network connection and retry.',
          });
        }
        throw new NetworkError(`Could not reach Slack (${method}): ${error.message}`, {
          hint: 'Check your network connection, proxy, or VPN and retry.',
          cause: error,
        });
      }

      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      if (response.status === 429) {
        if (attempt >= this.maxRateRetries) {
          throw new SlackApiError(method, 'ratelimited', {}, {
            hint: 'Slack is rate limiting this session. Wait a minute and retry.',
          });
        }
        const waitMs = Math.min(60_000, retryAfter ?? (1000 * (attempt + 1)));
        if (this.debug) {
          process.stderr.write(`debug: ${method} rate limited, retrying in ${formatDuration(waitMs)}\n`);
        }
        await sleep(waitMs);
        attempt += 1;
        continue;
      }

      const text = await response.text();
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new SlackApiError(method, `http_${response.status}`, { body: text.slice(0, 500) });
      }

      if (this.debug) {
        process.stderr.write(`debug: ${method} ${response.status} (${Date.now() - started}ms)\n`);
      }

      if (!response.ok) {
        const slackError = data?.error || `http_${response.status}`;
        throw new SlackApiError(method, slackError, data);
      }

      if (data.ok === false) {
        if (data.error === 'ratelimited' && attempt < this.maxRateRetries) {
          const waitMs = Math.min(60_000, retryAfter ?? (1000 * (attempt + 1)));
          await sleep(waitMs);
          attempt += 1;
          continue;
        }
        throw new SlackApiError(method, data.error || 'unknown_error', data, {
          hint: slackErrorHint(data.error),
        });
      }
      return data;
    }
  }

  async authTest() {
    return this.call('auth.test');
  }

  async uploadFiles({ channelId, files, comment, threadTs } = {}) {
    if (!Array.isArray(files) || files.length === 0) {
      throw new CliError('At least one file is required.', { code: 'no_files' });
    }
    const completed = [];
    for (const file of files) {
      const filePath = path.resolve(file.path);
      const info = await stat(filePath);
      if (!info.isFile()) throw new CliError(`Not a file: ${filePath}`, { code: 'not_a_file' });
      const filename = path.basename(filePath);
      const upload = await this.call('files.getUploadURLExternal', {
        filename,
        length: info.size,
      });
      await uploadFileToUrl(upload.upload_url, filePath, info.size);
      completed.push({ id: upload.file_id, title: file.title || filename });
    }
    return this.call('files.completeUploadExternal', {
      files: JSON.stringify(completed),
      channel_id: channelId,
      ...(comment ? { initial_comment: comment } : {}),
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
  }

  headers() {
    const headers = {
      'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
      accept: 'application/json',
      'user-agent': this.userAgent,
      origin: 'https://app.slack.com',
      referer: 'https://app.slack.com/',
    };
    if (this.cookieHeader) headers.cookie = this.cookieHeader;
    return headers;
  }
}

export async function uploadFileToUrl(uploadUrl, filePath, size) {
  let parsed;
  try {
    parsed = new URL(uploadUrl);
  } catch {
    parsed = null;
  }
  if (!parsed || !isSlackHostUrl(parsed)) {
    throw new CliError('Slack returned an unexpected upload URL.', { code: 'invalid_upload_url' });
  }
  let response;
  try {
    response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(size),
      },
      body: createReadStream(filePath),
      duplex: 'half',
      signal: AbortSignal.timeout(5 * 60 * 1000),
    });
  } catch (error) {
    throw new NetworkError(`File upload failed: ${error.message}`, { code: 'upload_failed', cause: error });
  }
  if (!response.ok) {
    throw new CliError(`File upload failed with HTTP ${response.status}.`, {
      code: 'upload_failed',
      hint: 'Try uploading a smaller file or retry.',
    });
  }
}

export async function downloadSlackFile(fileUrl, destinationPath, {
  cookieHeader = '',
  userAgent = DEFAULT_USER_AGENT,
  timeoutMs = 5 * 60 * 1000,
} = {}) {
  let target;
  try {
    target = new URL(fileUrl);
  } catch {
    throw new CliError('Slack returned an invalid file URL.', { code: 'invalid_file_url' });
  }

  let redirects = 0;
  let response;
  while (true) {
    if (!isSlackHostUrl(target)) {
      throw new CliError('Slack returned an unexpected file URL.', { code: 'invalid_file_url' });
    }
    try {
      response = await fetch(target, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          ...(cookieHeader ? { cookie: cookieHeader } : {}),
          'user-agent': userAgent || DEFAULT_USER_AGENT,
          accept: '*/*',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        throw new NetworkError(`File download timed out after ${formatDuration(timeoutMs)}.`, {
          code: 'download_failed',
        });
      }
      throw new NetworkError(`File download failed: ${error.message}`, {
        code: 'download_failed',
        cause: error,
      });
    }

    if (!DOWNLOAD_REDIRECTS.has(response.status)) break;
    const location = response.headers.get('location');
    if (response.body) await response.body.cancel().catch(() => {});
    if (!location) {
      throw new CliError('Slack file redirect did not include a location.', { code: 'invalid_file_url' });
    }
    if (redirects >= 5) {
      throw new CliError('Slack file download redirected too many times.', { code: 'download_failed' });
    }
    redirects += 1;
    try {
      target = new URL(location, target);
    } catch {
      throw new CliError('Slack returned an invalid file redirect.', { code: 'invalid_file_url' });
    }
  }

  if (!response.ok) {
    if (response.body) await response.body.cancel().catch(() => {});
    const hint = response.status === 403
      ? 'The Slack session may not have access to this file, or its cookie expired.'
      : response.status === 404
        ? 'The file may have been deleted or moved.'
        : undefined;
    throw new CliError(`Slack file download failed with HTTP ${response.status}.`, {
      code: 'download_failed',
      hint,
    });
  }

  const tempPath = path.join(
    path.dirname(destinationPath),
    `.${path.basename(destinationPath)}.${process.pid}.${randomBytes(4).toString('hex')}.part`,
  );
  try {
    if (response.body) {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(tempPath, { mode: 0o600 }));
    } else {
      await writeFile(tempPath, Buffer.alloc(0), { mode: 0o600 });
    }
    const info = await stat(tempPath);
    await rename(tempPath, destinationPath);
    return { bytes: info.size, url: target.toString() };
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw new NetworkError(`Could not save the downloaded file: ${error.message}`, {
      code: 'download_failed',
      cause: error,
    });
  }
}

const DOWNLOAD_REDIRECTS = new Set([301, 302, 303, 307, 308]);

function isSlackHostUrl(url) {
  if (!(url instanceof URL) || url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return host === 'slack.com' || host.endsWith('.slack.com');
}

function encodeParams(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.set(key, encodeValue(value));
  }
  return search.toString();
}

function encodeValue(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (Array.isArray(value) && value.every((item) => ['string', 'number', 'boolean'].includes(typeof item))) {
    return value.join(',');
  }
  return JSON.stringify(value);
}

function parseRetryAfter(header) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = new Date(header);
  if (!Number.isNaN(date.getTime())) return Math.max(0, date.getTime() - Date.now());
  return null;
}

function slackErrorHint(error) {
  if (error === 'missing_scope') return 'This Slack app/token lacks the required OAuth scope for that action.';
  if (error === 'not_in_channel') return 'Join the channel first with `slack-cli conversations join <channel>`.';
  if (error === 'channel_not_found') return 'Check the channel name or ID, or pass a channel you are a member of.';
  if (error === 'user_not_found') return 'Check the user name or ID.';
  if (error === 'is_archived') return 'The channel is archived.';
  if (error === 'cant_update_message') return 'Only the original author can edit this message.';
  if (error === 'cant_delete_message') return 'You cannot delete this message.';
  if (error === 'message_not_found') return 'Check the message timestamp (ts).';
  return undefined;
}
