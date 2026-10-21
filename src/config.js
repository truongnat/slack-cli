import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { CliError, NotFoundError, sleep } from './util.js';

const CONFIG_VERSION = 1;
const SESSION_VERSION = 1;
const CLIENT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function getSlackHome() {
  if (process.env.SLACK_CLI_HOME) return path.resolve(process.env.SLACK_CLI_HOME);
  const configRoot = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configRoot, 'slack-cli');
}

export function configPath() {
  return path.join(getSlackHome(), 'config.json');
}

export function clientsDir() {
  return path.join(getSlackHome(), 'clients');
}

export function clientDir(name) {
  return path.join(clientsDir(), name);
}

export function clientProfileDir(name) {
  return path.join(clientDir(name), 'profile');
}

export function clientSessionPath(name) {
  return path.join(clientDir(name), 'session.json');
}

export function clientLockPath(name) {
  return path.join(clientDir(name), '.lock');
}

export function ensureSlackHome() {
  mkdirSync(getSlackHome(), { recursive: true, mode: 0o700 });
}

export function ensureClientDir(name) {
  validateClientName(name);
  const dir = clientDir(name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  mkdirSync(clientProfileDir(name), { recursive: true, mode: 0o700 });
  return dir;
}

export function validateClientName(name) {
  if (!CLIENT_NAME_PATTERN.test(String(name ?? ''))) {
    throw new CliError(
      `Invalid client name "${name}". Use letters, numbers, dots, underscores, or dashes (max 64 chars).`,
      { code: 'invalid_client' },
    );
  }
  return name;
}

function emptyConfig() {
  return { version: CONFIG_VERSION, activeClient: null, clients: {} };
}

export function readConfig() {
  const file = configPath();
  if (!existsSync(file)) return emptyConfig();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new CliError(`Cannot read ${file}: ${error.message}`, { code: 'invalid_config' });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError(`Invalid config file: ${file}`, { code: 'invalid_config' });
  }
  return {
    version: CONFIG_VERSION,
    activeClient: parsed.activeClient ?? null,
    clients: parsed.clients && typeof parsed.clients === 'object' ? parsed.clients : {},
  };
}

export function writeConfig(config) {
  ensureSlackHome();
  atomicWriteJson(configPath(), {
    version: CONFIG_VERSION,
    activeClient: config.activeClient ?? null,
    clients: config.clients ?? {},
  });
}

export function listClientNames() {
  return Object.keys(readConfig().clients);
}

export function resolveClientName(config, requested) {
  const names = Object.keys(config.clients);
  if (names.length === 0) return null;
  if (requested) {
    if (!config.clients[requested]) {
      throw new NotFoundError(`Unknown client "${requested}". Available clients: ${names.join(', ')}.`, {
        hint: 'Run `slack-cli client list` to see configured clients.',
      });
    }
    return requested;
  }
  if (config.activeClient && config.clients[config.activeClient]) return config.activeClient;
  if (config.clients.default) return 'default';
  return names[0];
}

export function upsertClientMeta(name, patch = {}) {
  validateClientName(name);
  const config = readConfig();
  const current = config.clients[name] ?? { name, createdAt: new Date().toISOString() };
  config.clients[name] = { ...current, ...patch, name };
  writeConfig(config);
  return config.clients[name];
}

export function updateClientMeta(name, updater) {
  const config = readConfig();
  const current = config.clients[name];
  if (!current) throw new NotFoundError(`Unknown client "${name}".`);
  config.clients[name] = updater({ ...current }) ?? current;
  writeConfig(config);
  return config.clients[name];
}

export function setActiveClient(name) {
  const config = readConfig();
  if (name && !config.clients[name]) throw new NotFoundError(`Unknown client "${name}".`);
  config.activeClient = name ?? null;
  writeConfig(config);
}

export function removeClientMeta(name) {
  const config = readConfig();
  delete config.clients[name];
  if (config.activeClient === name) {
    config.activeClient = Object.keys(config.clients)[0] ?? null;
  }
  writeConfig(config);
  return config;
}

export function removeClientDir(name) {
  rmSync(clientDir(name), { recursive: true, force: true });
}

export function readSession(name) {
  const file = clientSessionPath(name);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.workspaces)) return null;
    return parsed;
  } catch (error) {
    throw new CliError(`Cannot read session file ${file}: ${error.message}`, {
      code: 'invalid_session',
      hint: 'Run `slack-cli setup` or `slack-cli login` to create a new session.',
    });
  }
}

export function writeSession(name, session) {
  ensureClientDir(name);
  atomicWriteJson(clientSessionPath(name), {
    ...session,
    version: SESSION_VERSION,
    client: name,
    savedAt: new Date().toISOString(),
  });
}

function atomicWriteJson(file, value) {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
    chmodSync(file, 0o600);
  } finally {
    if (existsSync(temp)) rmSync(temp, { force: true });
  }
}

export async function withClientLock(name, fn, { timeoutMs = 90000, debug = false } = {}) {
  validateClientName(name);
  ensureClientDir(name);
  const release = await acquireLock(name, { timeoutMs, debug });
  try {
    return await fn();
  } finally {
    await release();
  }
}

async function acquireLock(name, { timeoutMs, debug }) {
  const file = clientLockPath(name);
  const token = randomBytes(8).toString('hex');
  const startedAt = Date.now();
  let waitedLogged = false;
  while (true) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }));
      } finally {
        closeSync(fd);
      }
      return async () => {
        try {
          const content = JSON.parse(readFileSync(file, 'utf8'));
          if (content.token === token) unlinkSync(file);
        } catch {
          // Another process may have cleaned a stale lock already.
        }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }

    const stale = isLockStale(file);
    if (stale) {
      try {
        unlinkSync(file);
        continue;
      } catch {
        // Fall through to waiting.
      }
    }

    if (Date.now() - startedAt > timeoutMs) {
      throw new CliError(
        'Another slack-cli process is already using this client profile.',
        { code: 'client_busy', hint: `If no command is running, remove ${file} and retry.` },
      );
    }
    if (debug && !waitedLogged) {
      process.stderr.write('Waiting for another slack-cli process to release the client profile...\n');
      waitedLogged = true;
    }
    await sleep(200);
  }
}

function isLockStale(file) {
  try {
    const stats = statSync(file);
    const age = Date.now() - stats.mtimeMs;
    if (age > 10 * 60 * 1000) return true;
    const content = JSON.parse(readFileSync(file, 'utf8'));
    if (!content.pid) return age > 30_000;
    try {
      process.kill(content.pid, 0);
      return false;
    } catch (error) {
      return error.code === 'ESRCH';
    }
  } catch {
    return false;
  }
}

export function storageInfo() {
  return {
    home: getSlackHome(),
    configFile: configPath(),
  };
}
