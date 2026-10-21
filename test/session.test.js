import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cookieExpiresAt,
  cookieHeaderFromCookies,
  dCookieFromCookies,
  filterSlackCookies,
  resolveWorkspaceFromSession,
} from '../src/session.js';
import { NotFoundError } from '../src/util.js';

const workspaces = [
  {
    id: 'T0AAAAAAA',
    name: 'Acme Corporation',
    domain: 'acme',
    url: 'https://acme.slack.com/',
    token: 'xoxc-a',
  },
  {
    id: 'T0BBBBBBB',
    name: 'Example Inc',
    domain: 'example',
    url: 'https://example.slack.com/',
    token: 'xoxc-b',
  },
];

const live = Math.floor(Date.now() / 1000) + 3600;

const cookies = [
  { name: 'd', value: 'xoxd-secret', domain: '.slack.com', expires: live },
  { name: 'd-s', value: '80', domain: '.slack.com', expires: live },
  { name: 'd', value: 'xoxd-app', domain: 'app.slack.com', expires: live },
  { name: 'other', value: 'nope', domain: '.example.com', expires: live },
  { name: 'expired', value: 'old', domain: '.slack.com', expires: 1 },
  { name: 'session', value: 'keep', domain: '.slack.com', expires: 0 },
];

test('filterSlackCookies keeps live Slack cookies only', () => {
  const names = filterSlackCookies(cookies).map((cookie) => cookie.name);
  assert.deepEqual(names, ['d', 'd-s', 'd', 'session']);
});

test('dCookieFromCookies returns the first d cookie', () => {
  assert.equal(dCookieFromCookies(cookies).value, 'xoxd-secret');
  assert.equal(dCookieFromCookies([]), null);
});

test('cookieHeaderFromCookies prefers the most specific domain per name', () => {
  const header = cookieHeaderFromCookies(cookies);
  assert.match(header, /(?:^|; )d=xoxd-app(?:;|$)/);
  assert.match(header, /d-s=80/);
  assert.doesNotMatch(header, /xoxd-secret/);
});

test('cookieHeaderFromCookies skips nameless entries', () => {
  assert.equal(cookieHeaderFromCookies([null, {}, { value: 'x' }]), '');
});

test('cookieExpiresAt uses the d cookie expiry', () => {
  const iso = cookieExpiresAt(cookies);
  assert.equal(new Date(iso).getTime(), live * 1000);
  assert.equal(cookieExpiresAt([{ name: 'd', value: 'x' }]), null);
  assert.equal(cookieExpiresAt([{ name: 'd', value: 'x', expires: -1 }]), null);
});

test('resolveWorkspaceFromSession resolves ID, domain, URL, and name', () => {
  const session = { activeWorkspaceId: 'T0AAAAAAA', workspaces };
  assert.equal(resolveWorkspaceFromSession(session, 'T0BBBBBBB').id, 'T0BBBBBBB');
  assert.equal(resolveWorkspaceFromSession(session, 't0bbbbbbb').id, 'T0BBBBBBB');
  assert.equal(resolveWorkspaceFromSession(session, 'example').id, 'T0BBBBBBB');
  assert.equal(resolveWorkspaceFromSession(session, 'https://example.slack.com/').id, 'T0BBBBBBB');
  assert.equal(resolveWorkspaceFromSession(session, 'Example Inc').id, 'T0BBBBBBB');
  assert.equal(resolveWorkspaceFromSession(session).id, 'T0AAAAAAA');
});

test('resolveWorkspaceFromSession honors SLACK_CLI_WORKSPACE', () => {
  const previous = process.env.SLACK_CLI_WORKSPACE;
  process.env.SLACK_CLI_WORKSPACE = 'example';
  try {
    const session = { activeWorkspaceId: 'T0AAAAAAA', workspaces };
    assert.equal(resolveWorkspaceFromSession(session).id, 'T0BBBBBBB');
  } finally {
    if (previous === undefined) delete process.env.SLACK_CLI_WORKSPACE;
    else process.env.SLACK_CLI_WORKSPACE = previous;
  }
});

test('resolveWorkspaceFromSession reports unknown refs and empty sessions', () => {
  const session = { activeWorkspaceId: 'T0AAAAAAA', workspaces };
  assert.throws(() => resolveWorkspaceFromSession(session, 'missing'), NotFoundError);
  assert.throws(() => resolveWorkspaceFromSession({ workspaces: [] }, null), /no workspaces/);
});
