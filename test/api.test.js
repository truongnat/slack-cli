import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SlackApi,
  SlackApiError,
  downloadSlackFile,
  isAuthError,
  uploadFileToUrl,
} from '../src/api.js';
import { CliError } from '../src/util.js';

const originalFetch = globalThis.fetch;

function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function makeApi(overrides = {}) {
  return new SlackApi({
    token: 'xoxc-test-token',
    cookieHeader: 'd=xoxd-test; d-s=80',
    userAgent: 'test-agent',
    ...overrides,
  });
}

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('call posts form params with token and cookies', async () => {
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return jsonResponse({ ok: true, team: 'Test' });
  };

  const api = makeApi();
  const result = await api.call('auth.test');
  assert.equal(result.team, 'Test');
  assert.equal(captured.url, 'https://slack.com/api/auth.test');
  assert.equal(captured.init.headers.cookie, 'd=xoxd-test; d-s=80');
  assert.equal(captured.init.headers['user-agent'], 'test-agent');

  const body = new URLSearchParams(captured.init.body);
  assert.equal(body.get('token'), 'xoxc-test-token');
});

test('call encodes arrays and objects as expected', async () => {
  let body;
  globalThis.fetch = async (url, init) => {
    body = new URLSearchParams(init.body);
    return jsonResponse({ ok: true });
  };
  await makeApi().call('test.method', {
    text: 'hello',
    count: 3,
    enabled: false,
    names: ['a', 'b'],
    blocks: { type: 'section' },
    skipped: undefined,
  });
  assert.equal(body.get('text'), 'hello');
  assert.equal(body.get('count'), '3');
  assert.equal(body.get('enabled'), 'false');
  assert.equal(body.get('names'), 'a,b');
  assert.deepEqual(JSON.parse(body.get('blocks')), { type: 'section' });
  assert.equal(body.has('skipped'), false);
});

test('call retries 429 responses', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response('', { status: 429, headers: { 'retry-after': '0' } });
    }
    return jsonResponse({ ok: true, retried: true });
  };
  const result = await makeApi().call('conversations.list');
  assert.equal(result.retried, true);
  assert.equal(calls, 2);
});

test('call maps Slack errors and identifies auth failures', async () => {
  globalThis.fetch = async () => jsonResponse({ ok: false, error: 'token_revoked' });
  try {
    await makeApi().call('auth.test');
    assert.fail('expected an error');
  } catch (error) {
    assert.ok(error instanceof SlackApiError);
    assert.equal(error.code, 'token_revoked');
    assert.equal(error.method, 'auth.test');
    assert.equal(isAuthError(error), true);
  }

  globalThis.fetch = async () => jsonResponse({ ok: false, error: 'channel_not_found' });
  try {
    await makeApi().call('conversations.info');
  } catch (error) {
    assert.equal(isAuthError(error), false);
  }
});

test('call rejects invalid method names without a request', async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return jsonResponse({ ok: true });
  };
  await assert.rejects(makeApi().call('../evil', {}), CliError);
  assert.equal(called, false);
});

test('call wraps network failures in NetworkError', async () => {
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  await assert.rejects(
    makeApi().call('auth.test'),
    (error) => error.name === 'NetworkError' && /Could not reach Slack/.test(error.message),
  );
});

test('downloadSlackFile streams a Slack file with cookies', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'slack-cli-download-'));
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return new Response('hello world', {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    });
  };
  try {
    const destination = path.join(dir, 'hello.txt');
    const result = await downloadSlackFile(
      'https://files.slack.com/files-pri/T1-F1/download/hello.txt',
      destination,
      { cookieHeader: 'd=xoxd-test', userAgent: 'test-agent' },
    );
    assert.equal(readFileSync(destination, 'utf8'), 'hello world');
    assert.equal(result.bytes, 11);
    assert.equal(captured.init.headers.cookie, 'd=xoxd-test');
    assert.equal(captured.init.headers['user-agent'], 'test-agent');
    assert.equal(captured.init.redirect, 'manual');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('downloadSlackFile rejects non-Slack URLs and redirects', async () => {
  await assert.rejects(
    downloadSlackFile('https://example.com/file.txt', '/tmp/file.txt'),
    (error) => error instanceof CliError && error.code === 'invalid_file_url',
  );

  const dir = mkdtempSync(path.join(os.tmpdir(), 'slack-cli-download-'));
  globalThis.fetch = async () => new Response(null, {
    status: 302,
    headers: { location: 'https://example.com/file.txt' },
  });
  try {
    const destination = path.join(dir, 'redirected.txt');
    await assert.rejects(
      downloadSlackFile('https://files.slack.com/files-pri/T1-F1/download/file.txt', destination),
      (error) => error instanceof CliError && error.code === 'invalid_file_url',
    );
    assert.equal(existsSync(destination), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('downloadSlackFile reports access errors', async () => {
  globalThis.fetch = async () => new Response('', { status: 403 });
  await assert.rejects(
    downloadSlackFile('https://files.slack.com/files-pri/T1-F1/download/file.txt', '/tmp/file.txt'),
    (error) => error instanceof CliError
      && error.code === 'download_failed'
      && /HTTP 403/.test(error.message),
  );
});

test('uploadFileToUrl rejects non-Slack hosts', async () => {
  await assert.rejects(
    uploadFileToUrl('https://example.com/upload', '/tmp/file', 1),
    (error) => error instanceof CliError && error.code === 'invalid_upload_url',
  );
  await assert.rejects(
    uploadFileToUrl('http://files.slack.com/upload', '/tmp/file', 1),
    (error) => error instanceof CliError && error.code === 'invalid_upload_url',
  );
});
