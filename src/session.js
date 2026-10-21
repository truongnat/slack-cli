import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchBrowser, firstPage, assertHeadedAvailable, resolveBrowser } from './browser.js';
import {
  resolveChromeSource,
  snapshotCookies,
  chromeSourceSummary,
} from './chrome.js';
import {
  clientProfileDir,
  readConfig,
  readSession,
  setActiveClient,
  upsertClientMeta,
  validateClientName,
  withClientLock,
  writeSession,
  ensureClientDir,
  clientSessionPath,
} from './config.js';
import { SlackApi, isAuthError } from './api.js';
import {
  AuthError,
  CliError,
  NetworkError,
  NotFoundError,
  cookieDomainMatches,
  debug as logDebug,
  formatDate,
  formatDuration,
  normalizeName,
  progress,
  sleep,
  uniqueBy,
} from './util.js';

const SLACK_HOME_URL = 'https://app.slack.com/client';
const HEADLESS_IMPORT_TIMEOUT_MS = 60_000;
const HEADLESS_REFRESH_TIMEOUT_MS = 45_000;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

export function filterSlackCookies(cookies) {
  const now = Date.now() / 1000;
  return cookies.filter((cookie) => {
    if (!cookie || !cookie.name) return false;
    if (!cookieDomainMatches(cookie.domain, 'slack.com')) return false;
    if (cookie.expires && cookie.expires > 0 && cookie.expires < now) return false;
    return true;
  });
}

export function dCookieFromCookies(cookies) {
  return cookies.find((cookie) => cookie.name === 'd') || null;
}

export function cookieHeaderFromCookies(cookies) {
  const byName = new Map();
  for (const cookie of cookies || []) {
    if (!cookie?.name) continue;
    const domain = String(cookie.domain || '');
    const current = byName.get(cookie.name);
    if (!current || domain.length > String(current.domain || '').length) {
      byName.set(cookie.name, cookie);
    }
  }
  return [...byName.values()].map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

export function cookieExpiresAt(cookies) {
  const d = dCookieFromCookies(cookies);
  if (!d || !d.expires || d.expires < 0) return null;
  return new Date(d.expires * 1000).toISOString();
}

function seedableCookies(cookies) {
  const now = Date.now() / 1000;
  return cookies
    .filter((cookie) => cookie?.name && cookie?.domain)
    .filter((cookie) => !(cookie.expires && cookie.expires > 0 && cookie.expires < now))
    .map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || '/',
      expires: cookie.expires,
      httpOnly: Boolean(cookie.httpOnly),
      secure: Boolean(cookie.secure),
      ...(['Strict', 'Lax', 'None'].includes(cookie.sameSite) ? { sameSite: cookie.sameSite } : {}),
      ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
    }));
}

async function extractSlackCookiesFromChrome(sourceInfo, { debug = false } = {}) {
  if (sourceInfo.slackCookieRows === 0) {
    throw new AuthError(`Chrome profile "${sourceInfo.profile}" has no Slack cookies.`, {
      code: 'no_slack_session',
      hint: 'Open https://app.slack.com in Chrome, sign in, then retry. Or run `slack-cli login` to sign in with a dedicated browser.',
    });
  }

  const browser = resolveBrowser({ preferSystem: true });
  const relativeCookiesPath = path.relative(sourceInfo.profileDir, sourceInfo.cookiesPath);
  const attempts = [
    {
      name: 'system-keyring',
      ignoreDefaultArgs: ['--password-store=basic', '--use-mock-keychain'],
      args: [],
    },
    {
      name: 'basic-store',
      ignoreDefaultArgs: undefined,
      args: [],
    },
  ];

  let best = [];
  let bestAttempt = null;
  let lastError = null;

  for (const attempt of attempts) {
    let tempRoot;
    try {
      tempRoot = await mkdtemp(path.join(os.tmpdir(), 'slack-cli-chrome-'));
      const stagedProfile = path.join(tempRoot, 'profile');
      const stagedCookies = path.join(stagedProfile, 'Default', relativeCookiesPath);
      await mkdir(path.dirname(stagedCookies), { recursive: true, mode: 0o700 });
      await copyFile(sourceInfo.localStatePath, path.join(stagedProfile, 'Local State'));
      await snapshotCookies(sourceInfo.cookiesPath, stagedCookies);

      const context = await launchBrowser(stagedProfile, {
        headless: true,
        executablePath: browser.executablePath,
        ignoreDefaultArgs: attempt.ignoreDefaultArgs,
        args: attempt.args,
      });
      try {
        const cookies = filterSlackCookies(await context.cookies());
        logDebug(debug, `cookie import attempt ${attempt.name}: ${cookies.length} Slack cookie(s)`);
        if (cookies.length > best.length) {
          best = cookies;
          bestAttempt = attempt.name;
        }
      } finally {
        await context.close().catch(() => {});
      }
    } catch (error) {
      lastError = error;
      logDebug(debug, `cookie import attempt ${attempt.name} failed: ${error.message}`);
    } finally {
      if (tempRoot) await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
    if (dCookieFromCookies(best)) break;
  }

  if (!dCookieFromCookies(best)) {
    if (sourceInfo.slackCookieRows > 0) {
      throw new AuthError(
        `Found ${sourceInfo.slackCookieRows} Slack cookie row(s) in Chrome, but could not unlock an authenticated session.`,
        {
          code: 'cookie_decryption_failed',
          hint: 'Make sure Chrome is unlocked with the same desktop user, close Chrome if needed, then retry. If it still fails, run `slack-cli login`.',
          cause: lastError,
        },
      );
    }
    throw new AuthError(`No Slack login was found in Chrome profile "${sourceInfo.profile}".`, {
      code: 'no_slack_session',
      hint: 'Open https://app.slack.com in Chrome and sign in, then retry `slack-cli setup`. Or use `slack-cli login`.',
      cause: lastError,
    });
  }

  logDebug(debug, `using cookies from ${bestAttempt} (${best.length} cookies)`);
  return best;
}

async function clearSlackStorage(context, page, workspaceUrls = []) {
  const origins = new Set(['https://app.slack.com', 'https://slack.com']);
  for (const url of workspaceUrls) {
    try {
      origins.add(new URL(url).origin);
    } catch {
      // Ignore malformed workspace URLs from older sessions.
    }
  }
  let cdp;
  try {
    cdp = await context.newCDPSession(page);
  } catch {
    return;
  }
  for (const origin of origins) {
    try {
      await cdp.send('Storage.clearDataForOrigin', {
        origin,
        storageTypes: 'local_storage,indexeddb,cache_storage,service_workers,websql',
      });
    } catch {
      // Storage clearing is best-effort and depends on the browser version.
    }
  }
}

async function navigateToSlack(page, url, timeoutMs, debug) {
  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: Math.min(timeoutMs, 60_000),
    });
  } catch (error) {
    const message = String(error.message || error);
    if (/Timeout/i.test(message)) {
      logDebug(debug, 'initial Slack navigation timed out; continuing to wait for the client');
      return;
    }
    if (/net::ERR|NS_ERROR|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED/i.test(message)) {
      throw new NetworkError(`Could not open Slack: ${message}`, {
        hint: 'Check your network, proxy, or VPN and retry.',
        cause: error,
      });
    }
    if (/Target page, context or browser has been closed/i.test(message)) {
      throw new AuthError('The browser was closed before Slack finished loading.', {
        code: 'login_cancelled',
      });
    }
    throw new CliError(`Could not open Slack: ${message}`, { code: 'navigation_failed', cause: error });
  }
}

async function readPageBootState(page) {
  return page.evaluate(() => {
    const result = {
      url: location.href,
      title: document.title,
      teams: [],
      tokens: [],
      lastActiveTeamId: null,
      signedOut: false,
    };
    try {
      const raw = localStorage.getItem('localConfig_v2');
      if (raw) {
        const config = JSON.parse(raw);
        result.lastActiveTeamId = config?.lastActiveTeamId ?? null;
        for (const team of Object.values(config?.teams ?? {})) {
          if (!team || typeof team !== 'object') continue;
          const entry = {
            id: team.id ?? null,
            name: team.name ?? null,
            domain: team.domain ?? null,
            token: team.token ?? null,
          };
          result.teams.push(entry);
          if (entry.token) result.tokens.push(entry.token);
        }
      }
      if (result.tokens.length === 0) {
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index);
          const value = localStorage.getItem(key);
          if (!value || !value.includes('xoxc-')) continue;
          const matches = value.match(/xoxc-[A-Za-z0-9-]+/g) || [];
          result.tokens.push(...matches);
        }
      }
      const pathAndHash = `${location.pathname}${location.hash}`;
      result.signedOut = /signin|sign-in|get-started/i.test(pathAndHash);
    } catch (error) {
      result.error = String(error);
    }
    result.tokens = [...new Set(result.tokens)].filter((token) => token.startsWith('xoxc-'));
    return result;
  });
}

async function pollPage(context, page, {
  interactive = false,
  timeoutMs = HEADLESS_IMPORT_TIMEOUT_MS,
  debug = false,
} = {}) {
  const started = Date.now();
  let state = null;
  let signedOutSince = null;
  let lastError = null;

  while (Date.now() - started < timeoutMs) {
    const pages = context.pages().filter((candidate) => !candidate.isClosed());
    if (pages.length === 0) {
      throw new AuthError('The browser was closed before Slack authentication completed.', {
        code: 'login_cancelled',
      });
    }
    const slackPages = pages.filter((candidate) => {
      try {
        return new URL(candidate.url()).hostname.endsWith('slack.com');
      } catch {
        return false;
      }
    });
    const candidates = slackPages.length > 0 ? slackPages : [page];
    for (const candidate of candidates) {
      try {
        const candidateState = await readPageBootState(candidate);
        if (candidateState.tokens.length > 0) {
          state = candidateState;
          break;
        }
        state = candidateState;
      } catch (error) {
        lastError = error;
      }
    }
    if (state?.tokens?.length) break;

    if (state?.signedOut) {
      if (!signedOutSince) signedOutSince = Date.now();
      if (!interactive && Date.now() - signedOutSince > 3000) break;
    } else {
      signedOutSince = null;
    }
    logDebug(debug, `waiting for Slack authentication (${Math.round((Date.now() - started) / 1000)}s)`);
    await sleep(1000);
  }

  if (!state?.tokens?.length) {
    if (interactive) {
      throw new AuthError(`Slack login was not completed within ${formatDuration(timeoutMs)}.`, {
        code: 'login_timeout',
        hint: 'Run `slack-cli login` again and finish the sign-in flow in the browser.',
        cause: lastError,
      });
    }
    throw new AuthError('Slack requires a fresh login.', {
      code: 'not_authenticated',
      hint: 'Run `slack-cli auth repair --login` (or `slack-cli login`) to sign in again in a browser.',
      cause: lastError,
    });
  }

  await sleep(500);
  const rawCookies = await context.cookies();
  const cookies = filterSlackCookies(rawCookies);
  if (!dCookieFromCookies(cookies)) {
    throw new AuthError('Slack loaded, but the session cookie (d) is missing.', {
      code: 'missing_session_cookie',
      hint: 'Run `slack-cli login` and sign in again.',
    });
  }
  const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => undefined);
  return { ...state, cookies, userAgent };
}

async function validateWorkspaceTokens(boot, { debug = false } = {}) {
  const cookieHeader = cookieHeaderFromCookies(boot.cookies);
  const workspaces = [];
  const failures = [];
  for (const token of boot.tokens) {
    try {
      const api = new SlackApi({
        token,
        cookieHeader,
        userAgent: boot.userAgent,
        debug,
      });
      const auth = await api.authTest();
      const meta = boot.teams.find((team) => team.token === token || team.id === auth.team_id) || {};
      let domain = meta.domain;
      if (!domain && auth.url) {
        try {
          domain = new URL(auth.url).hostname.split('.')[0];
        } catch {
          domain = null;
        }
      }
      workspaces.push({
        id: auth.team_id,
        name: auth.team || meta.name || auth.team_id,
        domain: domain || null,
        url: auth.url || (domain ? `https://${domain}.slack.com/` : null),
        userId: auth.user_id,
        userName: auth.user,
        enterpriseId: auth.enterprise_id ?? null,
        token,
      });
    } catch (error) {
      if (!isAuthError(error)) throw error;
      failures.push(error.code);
      logDebug(debug, `token for a workspace was rejected: ${error.code}`);
    }
  }

  const unique = uniqueBy(workspaces, (workspace) => workspace.id);
  if (unique.length === 0) {
    throw new AuthError(
      `Slack rejected the stored workspace token${failures.length ? ` (${failures[0]})` : ''}.`,
      {
        code: 'workspace_token_rejected',
        hint: 'Run `slack-cli auth repair --login` to create a fresh session.',
      },
    );
  }
  return unique;
}

function chooseActiveWorkspace(workspaces, { preferredId, previousSession, bootLastActiveId } = {}) {
  const ids = new Set(workspaces.map((workspace) => workspace.id));
  if (preferredId && ids.has(preferredId)) return preferredId;
  if (previousSession?.activeWorkspaceId && ids.has(previousSession.activeWorkspaceId)) {
    return previousSession.activeWorkspaceId;
  }
  if (bootLastActiveId && ids.has(bootLastActiveId)) return bootLastActiveId;
  return workspaces[0]?.id ?? null;
}

async function persistSessionFromBoot({
  clientName,
  boot,
  previousSession = null,
  preferredActiveId,
  source = null,
  sourceMetaPatch = {},
  operation = 'refresh',
  debug = false,
}) {
  const workspaces = await validateWorkspaceTokens(boot, { debug });
  const activeWorkspaceId = chooseActiveWorkspace(workspaces, {
    preferredId: preferredActiveId,
    previousSession,
    bootLastActiveId: boot.lastActiveTeamId,
  });
  const now = new Date().toISOString();
  const session = {
    version: 1,
    client: clientName,
    source: source ? chromeSourceSummary(source) : previousSession?.source ?? null,
    importedAt: previousSession?.importedAt ?? now,
    updatedAt: now,
    lastRefreshedAt: now,
    workspaces,
    activeWorkspaceId,
    cookies: boot.cookies,
    cookieExpiresAt: cookieExpiresAt(boot.cookies),
    userAgent: boot.userAgent ?? previousSession?.userAgent ?? null,
    lastUrl: boot.url ?? null,
  };
  writeSession(clientName, session);

  upsertClientMeta(clientName, {
    ...sourceMetaPatch,
    ...(source ? { source: chromeSourceSummary(source) } : {}),
    ...(operation === 'import' ? { lastImportedAt: now } : {}),
    ...(operation === 'login' ? { lastLoginAt: now } : {}),
    lastSessionAt: now,
  });
  const config = readConfig();
  if (!config.activeClient) setActiveClient(clientName);

  return session;
}

export async function importClientSession({
  clientName,
  source,
  chromeProfile,
  timeoutMs = HEADLESS_IMPORT_TIMEOUT_MS,
  debug = false,
} = {}) {
  validateClientName(clientName);
  ensureClientDir(clientName);
  const sourceInfo = await resolveChromeSource({ source, profile: chromeProfile, debug });
  progress(`Importing Slack cookies from Chrome profile "${sourceInfo.profile}"...`);

  return withClientLock(clientName, async () => {
    const importedCookies = await extractSlackCookiesFromChrome(sourceInfo, { debug });
    const previousSession = readSession(clientName);
    const executable = resolveBrowser({ preferSystem: true });
    progress(`Opening Slack with ${importedCookies.length} imported cookie(s)...`);

    const context = await launchBrowser(clientProfileDir(clientName), {
      headless: true,
      executablePath: executable.executablePath,
    });
    try {
      const page = await firstPage(context);
      await context.clearCookies();
      await clearSlackStorage(context, page, previousSession?.workspaces?.map((workspace) => workspace.url));
      await context.addCookies(seedableCookies(importedCookies));
      await navigateToSlack(page, previousSession?.lastUrl || SLACK_HOME_URL, timeoutMs, debug);
      const boot = await pollPage(context, page, { interactive: false, timeoutMs, debug });
      const session = await persistSessionFromBoot({
        clientName,
        boot,
        previousSession,
        source: sourceInfo,
        sourceMetaPatch: {
          chromeProfile: sourceInfo.profile,
        },
        operation: 'import',
        debug,
      });
      progress(`Imported ${session.workspaces.length} workspace(s) from Chrome.`);
      return session;
    } finally {
      await context.close().catch(() => {});
    }
  }, { debug });
}

export async function refreshClientSession({
  clientName,
  timeoutMs = HEADLESS_REFRESH_TIMEOUT_MS,
  debug = false,
} = {}) {
  validateClientName(clientName);
  const previousSession = readSession(clientName);
  if (!previousSession) {
    throw new AuthError(`No saved session for client "${clientName}".`, {
      code: 'no_session',
      hint: 'Run `slack-cli setup` or `slack-cli login`.',
    });
  }
  return withClientLock(clientName, async () => {
    const executable = resolveBrowser({ preferSystem: true });
    const context = await launchBrowser(clientProfileDir(clientName), {
      headless: true,
      executablePath: executable.executablePath,
    });
    try {
      const page = await firstPage(context);
      if (previousSession.cookies?.length) {
        await context.addCookies(seedableCookies(previousSession.cookies));
      }
      await navigateToSlack(page, previousSession.lastUrl || SLACK_HOME_URL, timeoutMs, debug);
      const boot = await pollPage(context, page, { interactive: false, timeoutMs, debug });
      const session = await persistSessionFromBoot({
        clientName,
        boot,
        previousSession,
        operation: 'refresh',
        debug,
      });
      return session;
    } finally {
      await context.close().catch(() => {});
    }
  }, { debug });
}

export async function loginClient({
  clientName,
  workspaceUrl,
  fresh = false,
  timeoutMs = LOGIN_TIMEOUT_MS,
  debug = false,
} = {}) {
  validateClientName(clientName);
  assertHeadedAvailable();
  ensureClientDir(clientName);
  const previousSession = readSession(clientName);

  return withClientLock(clientName, async () => {
    const executable = resolveBrowser({ preferSystem: true });
    const context = await launchBrowser(clientProfileDir(clientName), {
      headless: false,
      executablePath: executable.executablePath,
    });
    try {
      const page = await firstPage(context);
      if (fresh) {
        await context.clearCookies();
        await clearSlackStorage(context, page, previousSession?.workspaces?.map((workspace) => workspace.url));
      } else if (previousSession?.cookies?.length) {
        await context.addCookies(seedableCookies(previousSession.cookies));
      }
      const target = workspaceUrl
        || previousSession?.workspaces?.find((workspace) => workspace.id === previousSession.activeWorkspaceId)?.url
        || SLACK_HOME_URL;
      await navigateToSlack(page, target, timeoutMs, debug);
      process.stderr.write('A browser window is open. Sign in to Slack there; this command continues automatically.\n');
      const boot = await pollPage(context, page, { interactive: true, timeoutMs, debug });
      const session = await persistSessionFromBoot({
        clientName,
        boot,
        previousSession,
        preferredActiveId: previousSession?.activeWorkspaceId,
        operation: 'login',
        debug,
      });
      progress(`Login complete. ${session.workspaces.length} workspace(s) available.`);
      return session;
    } finally {
      await context.close().catch(() => {});
    }
  }, { debug });
}

function makeApi(session, workspace, debug) {
  return new SlackApi({
    token: workspace.token,
    cookieHeader: cookieHeaderFromCookies(session.cookies),
    userAgent: session.userAgent,
    debug,
  });
}

function applyAuth(workspace, auth) {
  let domain = workspace.domain;
  if (auth.url) {
    try {
      domain = new URL(auth.url).hostname.split('.')[0];
    } catch {
      // Keep the stored domain if Slack returns an unparsable URL.
    }
  }
  return {
    ...workspace,
    id: auth.team_id,
    name: auth.team || workspace.name,
    domain: domain || workspace.domain,
    url: auth.url || workspace.url,
    userId: auth.user_id,
    userName: auth.user,
    enterpriseId: auth.enterprise_id ?? workspace.enterpriseId ?? null,
  };
}

export function resolveWorkspaceFromSession(session, ref) {
  const workspaces = session.workspaces ?? [];
  if (workspaces.length === 0) {
    throw new AuthError('The saved Slack session has no workspaces.', {
      code: 'no_workspaces',
      hint: 'Run `slack-cli login` to sign in again.',
    });
  }
  const requested = ref || process.env.SLACK_CLI_WORKSPACE || session.activeWorkspaceId;
  if (!requested) return workspaces[0];

  const needle = String(requested).trim();
  const lowered = needle.toLowerCase();
  let urlHost = null;
  try {
    if (needle.includes('://')) urlHost = new URL(needle).hostname.toLowerCase();
  } catch {
    urlHost = null;
  }

  const exactId = workspaces.find((workspace) => String(workspace.id).toLowerCase() === lowered);
  if (exactId) return exactId;

  const exactDomain = workspaces.find((workspace) => String(workspace.domain ?? '').toLowerCase() === lowered)
    || (urlHost ? workspaces.find((workspace) => String(workspace.domain ?? '').toLowerCase() === urlHost.split('.')[0]) : null);
  if (exactDomain) return exactDomain;

  const nameMatches = workspaces.filter((workspace) => normalizeName(workspace.name) === normalizeName(needle));
  if (nameMatches.length === 1) return nameMatches[0];
  if (nameMatches.length > 1) {
    throw new NotFoundError(
      `Workspace name "${needle}" is ambiguous. Use a workspace ID: ${nameMatches.map((workspace) => workspace.id).join(', ')}.`,
    );
  }

  const available = workspaces
    .map((workspace) => `${workspace.name} (${workspace.domain || workspace.id})`)
    .join(', ');
  throw new NotFoundError(`Workspace "${needle}" was not found. Available workspaces: ${available}.`);
}

export class SlackRuntime {
  constructor(manager, session, workspace, api) {
    this.manager = manager;
    this.session = session;
    this.workspace = workspace;
    this.api = api;
    this.debug = manager.debug;
  }

  get clientName() {
    return this.manager.clientName;
  }

  async call(method, params) {
    try {
      return await this.api.call(method, params);
    } catch (error) {
      if (!isAuthError(error)) throw error;
      progress('Slack rejected the current token; attempting automatic recovery...');
      const runtime = await this.manager.recover({ workspaceRef: this.workspace.id });
      this.session = runtime.session;
      this.workspace = runtime.workspace;
      this.api = runtime.api;
      return this.api.call(method, params);
    }
  }

  newResolver() {
    return new SessionResolver(this);
  }
}

export class SessionResolver {
  constructor(runtime) {
    this.runtime = runtime;
    this.users = null;
    this.conversations = null;
    this.userMap = null;
  }

  async loadUsers() {
    if (this.users) return this.users;
    const members = [];
    let cursor;
    do {
      const response = await this.runtime.call('users.list', {
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      members.push(...(response.members ?? []));
      cursor = response.response_metadata?.next_cursor || undefined;
    } while (cursor && members.length < 20_000);
    this.users = members;
    this.userMap = new Map(members.map((user) => [user.id, user]));
    return members;
  }

  async loadConversations() {
    if (this.conversations) return this.conversations;
    const channels = [];
    let cursor;
    do {
      const response = await this.runtime.call('conversations.list', {
        types: 'public_channel,private_channel,mpim,im',
        limit: 1000,
        exclude_archived: true,
        ...(cursor ? { cursor } : {}),
      });
      channels.push(...(response.channels ?? []));
      cursor = response.response_metadata?.next_cursor || undefined;
    } while (cursor && channels.length < 20_000);
    this.conversations = channels;
    return channels;
  }

  async user(id) {
    await this.loadUsers();
    return this.userMap.get(id) || null;
  }

  displayUser(id) {
    if (!id) return 'unknown';
    const user = this.userMap?.get(id);
    if (!user) return id;
    return user.profile?.display_name || user.real_name || user.name || id;
  }

  async resolveUser(ref) {
    const needle = String(ref ?? '').trim().replace(/^@/, '');
    if (!needle) throw new NotFoundError('A user is required.');
    const users = await this.loadUsers();
    if (/^[UW][A-Z0-9]{5,}$/.test(needle)) {
      const user = await this.user(needle);
      if (user) return user;
    }
    const lowered = needle.toLowerCase();
    const matches = users.filter((user) => {
      const candidates = [
        user.name,
        user.profile?.display_name,
        user.real_name,
        user.profile?.display_name_normalized,
        user.profile?.real_name_normalized,
        user.profile?.email,
      ].filter(Boolean).map((value) => String(value).toLowerCase());
      return candidates.includes(lowered);
    });
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new NotFoundError(
        `User "${needle}" is ambiguous. Matches: ${matches.map((user) => `${user.name} (${user.id})`).join(', ')}.`,
      );
    }
    throw new NotFoundError(`User "${needle}" was not found.`, {
      hint: 'Try the Slack username, display name, email, or user ID.',
    });
  }

  async resolveChannel(ref) {
    const raw = String(ref ?? '').trim();
    if (!raw) throw new NotFoundError('A channel is required.');
    if (/^[CDG][A-Z0-9]{5,}$/.test(raw)) {
      const id = raw;
      return {
        id,
        name: id,
        type: id.startsWith('D') ? 'im' : id.startsWith('G') ? 'mpim' : 'channel',
      };
    }
    if (raw.startsWith('@') || /^[UW][A-Z0-9]{5,}$/.test(raw)) {
      const user = await this.resolveUser(raw);
      const response = await this.runtime.call('conversations.open', { users: user.id });
      return {
        id: response.channel.id,
        name: this.displayUser(user.id),
        type: 'im',
        user: user.id,
      };
    }

    const name = normalizeName(raw);
    const conversations = await this.loadConversations();
    const matches = conversations.filter((conversation) => normalizeName(conversation.name) === name);
    if (matches.length === 1) return normalizeConversation(matches[0], this);
    if (matches.length > 1) {
      throw new NotFoundError(
        `Channel "#${name}" is ambiguous. Matches: ${matches.map((conversation) => conversation.id).join(', ')}.`,
      );
    }
    throw new NotFoundError(`Channel "#${name}" was not found.`, {
      hint: 'Use an exact channel name or channel ID, or run `slack-cli conversations list`.',
    });
  }
}

function normalizeConversation(conversation, resolver) {
  if (conversation.is_im) {
    return {
      id: conversation.id,
      name: resolver.displayUser(conversation.user),
      type: 'im',
      user: conversation.user,
      raw: conversation,
    };
  }
  return {
    id: conversation.id,
    name: conversation.name || conversation.id,
    type: conversation.is_mpim ? 'mpim' : conversation.is_private ? 'private' : 'channel',
    raw: conversation,
  };
}

export class SessionManager {
  constructor(clientName, { debug = false } = {}) {
    this.clientName = clientName;
    this.debug = debug;
  }

  requireSession() {
    const session = readSession(this.clientName);
    if (!session) {
      throw new AuthError(`No saved Slack session for client "${this.clientName}".`, {
        code: 'no_session',
        hint: 'Run `slack-cli setup` to import Chrome, or `slack-cli login` to sign in.',
      });
    }
    return session;
  }

  async connect({ workspaceRef, autoRepair = true } = {}) {
    const session = this.requireSession();
    const workspace = resolveWorkspaceFromSession(session, workspaceRef);
    try {
      const api = makeApi(session, workspace, this.debug);
      const auth = await api.authTest();
      return new SlackRuntime(this, session, applyAuth(workspace, auth), api);
    } catch (error) {
      if (!isAuthError(error)) throw error;
      if (!autoRepair || process.env.SLACK_CLI_AUTO_REPAIR === '0') {
        throw new AuthError(
          `The Slack session for "${workspace.name}" is no longer valid (${error.code}).`,
          {
            code: 'session_invalid',
            hint: 'Run `slack-cli auth repair --login` to refresh the session or sign in again.',
          },
        );
      }
      progress(`Slack session is invalid (${error.code}); attempting automatic recovery...`);
      return this.recover({ workspaceRef: workspace.id });
    }
  }

  async recover({ workspaceRef } = {}) {
    const failures = [];
    try {
      const session = await refreshClientSession({
        clientName: this.clientName,
        debug: this.debug,
      });
      const workspace = resolveWorkspaceFromSession(session, workspaceRef);
      const api = makeApi(session, workspace, this.debug);
      const auth = await api.authTest();
      progress('Session refreshed from the saved browser profile.');
      return new SlackRuntime(this, session, applyAuth(workspace, auth), api);
    } catch (error) {
      failures.push(error);
      logDebug(this.debug, `session refresh failed: ${error.message}`);
    }

    const config = readConfig();
    const source = config.clients[this.clientName]?.source;
    if (source?.dataDir) {
      try {
        progress('Refreshing the Chrome login session instead...');
        const session = await importClientSession({
          clientName: this.clientName,
          source: source.dataDir,
          chromeProfile: source.profile,
          debug: this.debug,
        });
        const workspace = resolveWorkspaceFromSession(session, workspaceRef);
        const api = makeApi(session, workspace, this.debug);
        const auth = await api.authTest();
        progress('Chrome session re-imported successfully.');
        return new SlackRuntime(this, session, applyAuth(workspace, auth), api);
      } catch (error) {
        failures.push(error);
        logDebug(this.debug, `Chrome re-import failed: ${error.message}`);
      }
    }

    throw new AuthError('Slack authentication failed and automatic recovery did not succeed.', {
      code: 'session_expired',
      hint: 'Run `slack-cli auth repair --login` to sign in to Slack again in a browser.',
      cause: failures.at(-1),
    });
  }

  async status({ workspaceRef } = {}) {
    const session = this.requireSession();
    const workspace = resolveWorkspaceFromSession(session, workspaceRef);
    const api = makeApi(session, workspace, this.debug);
    try {
      const auth = await api.authTest();
      return {
        valid: true,
        session,
        workspace: applyAuth(workspace, auth),
        sessionPath: clientSessionPath(this.clientName),
      };
    } catch (error) {
      if (!isAuthError(error)) throw error;
      return {
        valid: false,
        session,
        workspace,
        error: error.code,
        sessionPath: clientSessionPath(this.clientName),
      };
    }
  }

  listWorkspaces() {
    const session = this.requireSession();
    return { session, workspaces: session.workspaces ?? [] };
  }

  useWorkspace(ref) {
    const session = this.requireSession();
    const workspace = resolveWorkspaceFromSession(session, ref);
    session.activeWorkspaceId = workspace.id;
    session.updatedAt = new Date().toISOString();
    writeSession(this.clientName, session);
    return workspace;
  }

  async refresh(options = {}) {
    return refreshClientSession({ clientName: this.clientName, debug: this.debug, ...options });
  }

  async importFromChrome(options = {}) {
    return importClientSession({ clientName: this.clientName, debug: this.debug, ...options });
  }

  async login(options = {}) {
    return loginClient({ clientName: this.clientName, debug: this.debug, ...options });
  }

  summarize(session) {
    return {
      client: this.clientName,
      activeWorkspaceId: session.activeWorkspaceId,
      workspaces: (session.workspaces ?? []).map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        domain: workspace.domain,
        url: workspace.url,
        userName: workspace.userName,
        userId: workspace.userId,
      })),
      cookieExpiresAt: session.cookieExpiresAt,
      lastRefreshedAt: session.lastRefreshedAt,
      source: session.source,
    };
  }
}

export function formatSessionStatus(status) {
  const { session, workspace } = status;
  const lines = [
    ['Workspace', `${workspace.name} (${workspace.domain || workspace.id})`],
    ['Team ID', workspace.id],
    ['User', workspace.userName ? `${workspace.userName} (${workspace.userId})` : workspace.userId],
    ['Session', status.valid ? 'valid' : `invalid (${status.error})`],
    ['Cookie expires', session.cookieExpiresAt ? formatDate(session.cookieExpiresAt) : 'session cookie / unknown'],
    ['Workspaces', String(session.workspaces?.length ?? 0)],
    ['Session file', status.sessionPath || clientSessionPath(session.client)],
    ['Last refresh', formatDate(session.lastRefreshedAt)],
    ['Chrome source', session.source ? `${session.source.profile} (${session.source.dataDir})` : 'none'],
  ];
  if (session.activeWorkspaceId) lines.splice(4, 0, ['Active workspace', session.activeWorkspaceId]);
  return lines;
}
