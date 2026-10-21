import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clientLockPath,
  clientSessionPath,
  configPath,
  getSlackHome,
  readConfig,
  readSession,
  removeClientDir,
  removeClientMeta,
  resolveClientName,
  setActiveClient,
  upsertClientMeta,
  validateClientName,
  withClientLock,
  writeConfig,
  writeSession,
} from '../src/config.js';
import { CliError, NotFoundError } from '../src/util.js';

let home;

before(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'slack-cli-test-'));
  process.env.SLACK_CLI_HOME = home;
});

after(() => {
  delete process.env.SLACK_CLI_HOME;
  rmSync(home, { recursive: true, force: true });
});

test('getSlackHome honors SLACK_CLI_HOME', () => {
  assert.equal(getSlackHome(), path.resolve(home));
  assert.equal(configPath(), path.join(home, 'config.json'));
});

test('validateClientName accepts safe names only', () => {
  assert.equal(validateClientName('default'), 'default');
  assert.equal(validateClientName('work.2_x-1'), 'work.2_x-1');
  for (const name of ['', ' space', '../escape', 'a/b', 'a'.repeat(65), null]) {
    assert.throws(() => validateClientName(name), CliError);
  }
});

test('readConfig returns an empty config when none exists', () => {
  assert.deepEqual(readConfig(), { version: 1, activeClient: null, clients: {} });
});

test('client metadata, active client, and removal round-trip', () => {
  upsertClientMeta('work', { source: { dataDir: '/chrome' } });
  upsertClientMeta('home');
  writeConfig({ ...readConfig(), activeClient: 'work' });

  assert.deepEqual(Object.keys(readConfig().clients).sort(), ['home', 'work']);
  assert.equal(resolveClientName(readConfig(), null), 'work');
  assert.equal(resolveClientName(readConfig(), 'home'), 'home');
  assert.throws(() => resolveClientName(readConfig(), 'nope'), NotFoundError);

  setActiveClient('home');
  assert.equal(readConfig().activeClient, 'home');

  removeClientMeta('home');
  assert.equal(resolveClientName(readConfig(), null), 'work');
  removeClientMeta('work');
  assert.equal(resolveClientName(readConfig(), null), null);
});

test('writeSession writes private JSON and readSession reads it', () => {
  const session = {
    client: 'work',
    cookieExpiresAt: '2027-01-01T00:00:00.000Z',
    workspaces: [{ id: 'T1', name: 'Test', token: 'xoxc-1' }],
    activeWorkspaceId: 'T1',
  };
  writeSession('work', session);
  const stored = readSession('work');
  assert.equal(stored.version, 1);
  assert.equal(stored.client, 'work');
  assert.equal(stored.workspaces[0].token, 'xoxc-1');
  assert.equal(stored.activeWorkspaceId, 'T1');
  assert.ok(stored.savedAt);

  const mode = statSync(clientSessionPath('work')).mode & 0o777;
  assert.equal(mode, 0o600);

  removeClientDir('work');
  assert.equal(readSession('work'), null);
});

test('readSession rejects malformed session files', () => {
  const name = 'broken';
  writeSession(name, { workspaces: [] });
  const file = clientSessionPath(name);
  writeFileSync(file, '{not json');
  assert.throws(() => readSession(name), CliError);
  removeClientDir(name);
});

test('withClientLock serializes access and cleans up the lock', async () => {
  const order = [];
  const first = withClientLock('locked', async () => {
    order.push('first-start');
    await new Promise((resolve) => setTimeout(resolve, 50));
    order.push('first-end');
  });
  const second = withClientLock('locked', async () => {
    order.push('second');
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second']);

  let releaseHolder;
  const holder = withClientLock('locked', () => new Promise((resolve) => {
    releaseHolder = resolve;
  }));
  for (let attempt = 0; attempt < 100 && !existsSync(clientLockPath('locked')); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await assert.rejects(
    withClientLock('locked', async () => {}, { timeoutMs: 50 }),
    (error) => error instanceof CliError && error.code === 'client_busy',
  );
  releaseHolder();
  await holder;
  removeClientDir('locked');
});

test('upsertClientMeta preserves creation time and name', () => {
  upsertClientMeta('meta', { note: 'one' });
  const created = readConfig().clients.meta.createdAt;
  upsertClientMeta('meta', { note: 'two' });
  const meta = readConfig().clients.meta;
  assert.equal(meta.note, 'two');
  assert.equal(meta.name, 'meta');
  assert.equal(meta.createdAt, created);
  removeClientMeta('meta');
  removeClientDir('meta');
});
