#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { stdin } from 'node:process';
import { Command } from 'commander';
import {
  readConfig,
  resolveClientName,
  setActiveClient,
  removeClientDir,
  removeClientMeta,
  clientSessionPath,
  validateClientName,
  readSession,
} from './config.js';
import {
  SessionManager,
  formatSessionStatus,
  resolveWorkspaceFromSession,
} from './session.js';
import { resolveBrowser, installBundledChromium } from './browser.js';
import { downloadSlackFile, uploadFileToUrl } from './api.js';
import {
  AuthError,
  CliError,
  NetworkError,
  NotFoundError,
  UsageError,
  confirmAction,
  formatBytes,
  formatDate,
  formatTimestamp,
  isPlainObject,
  oneLine,
  parseJsonInput,
  parsePositiveInt,
  printJson,
  progress,
  readStdin,
  renderKeyValues,
  renderTable,
  reportError,
  resolveTimeout,
  writeOut,
} from './util.js';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const ALLOWED_CONVERSATION_TYPES = new Set(['public_channel', 'private_channel', 'mpim', 'im']);
const ALLOWED_FILE_TYPES = new Set([
  'all',
  'spaces',
  'snippets',
  'images',
  'gifs',
  'zips',
  'pdfs',
  'documents',
  'spreadsheets',
  'presentations',
  'audio',
  'videos',
]);

function addRuntimeOptions(command) {
  return command
    .option('-c, --client <name>', 'client profile to use (defaults to the active client)')
    .option('-w, --workspace <ref>', 'workspace ID, domain, name, or URL')
    .option('--json', 'print JSON output')
    .option('--debug', 'print debug information');
}

function addClientOptions(command) {
  return command
    .option('-c, --client <name>', 'client profile to use (defaults to the active client)')
    .option('--json', 'print JSON output')
    .option('--debug', 'print debug information');
}

function addBasicOptions(command) {
  return command
    .option('--json', 'print JSON output')
    .option('--debug', 'print debug information');
}

function addDestructiveOption(command) {
  return command.option('-y, --yes', 'skip the confirmation prompt');
}

function handle(handler) {
  return async (...args) => {
    const command = args.at(-1);
    const options = args.length >= 2 ? args[args.length - 2] : command?.opts() ?? {};
    try {
      await handler(...args);
    } catch (error) {
      process.exitCode = reportError(error, {
        json: Boolean(options?.json),
        debug: Boolean(options?.debug),
      });
    }
  };
}

function publicWorkspace(workspace) {
  return {
    id: workspace.id,
    name: workspace.name,
    domain: workspace.domain,
    url: workspace.url,
    userId: workspace.userId,
    userName: workspace.userName,
    enterpriseId: workspace.enterpriseId ?? null,
  };
}

function publicWorkspaces(workspaces) {
  return (workspaces ?? []).map(publicWorkspace);
}

function sessionSummary(clientName, session) {
  return {
    ok: true,
    client: clientName,
    activeWorkspaceId: session.activeWorkspaceId,
    workspaces: publicWorkspaces(session.workspaces),
    cookieExpiresAt: session.cookieExpiresAt,
    sessionFile: clientSessionPath(clientName),
    source: session.source ?? null,
    lastRefreshedAt: session.lastRefreshedAt,
  };
}

function printWorkspacesTable(session) {
  const rows = (session.workspaces ?? []).map((workspace) => [
    workspace.id === session.activeWorkspaceId ? '*' : '',
    workspace.id,
    workspace.name,
    workspace.domain ?? '',
    workspace.userName ?? workspace.userId ?? '',
  ]);
  writeOut(renderTable(['ACTIVE', 'ID', 'NAME', 'DOMAIN', 'USER'], rows));
}

function printSessionReady(clientName, session, options, title = 'Session ready') {
  if (options.json) {
    printJson(sessionSummary(clientName, session));
    return;
  }
  writeOut(`${title}: client "${clientName}".`);
  writeOut('');
  printWorkspacesTable(session);
}

function resolveClientOrThrow(options, { requireSession = false } = {}) {
  const config = readConfig();
  const requested = options.client || process.env.SLACK_CLI_CLIENT;
  const name = resolveClientName(config, requested);
  if (!name) {
    throw new AuthError('No Slack clients are configured.', {
      code: 'no_clients',
      hint: 'Run `slack-cli setup` to import your Chrome session, or `slack-cli login`.',
    });
  }
  const manager = new SessionManager(name, { debug: Boolean(options.debug) });
  if (requireSession) manager.requireSession();
  return { config, clientName: name, manager };
}

async function connectRuntime(options) {
  const { config, clientName, manager } = resolveClientOrThrow(options, { requireSession: true });
  const runtime = await manager.connect({
    workspaceRef: options.workspace || undefined,
  });
  return { config, clientName, manager, runtime };
}

async function ensureBrowser({ install = false } = {}) {
  try {
    return resolveBrowser();
  } catch (error) {
    if (!install) throw error;
    progress('No Chrome/Chromium found; installing Playwright Chromium...');
    await installBundledChromium();
    return resolveBrowser();
  }
}

function shouldOfferLogin(error) {
  const codes = new Set([
    'chrome_not_found',
    'chrome_profile_not_found',
    'chrome_cookies_not_found',
    'no_slack_session',
    'cookie_decryption_failed',
    'not_authenticated',
    'session_rejected',
    'workspace_token_rejected',
    'missing_session_cookie',
  ]);
  return error instanceof AuthError || codes.has(error.code);
}

async function importOrLoginClient({
  options,
  name,
  source,
  chromeProfile,
  loginOnly = false,
  installBrowser = false,
  cleanNew = true,
}) {
  validateClientName(name);
  const existed = Boolean(readConfig().clients[name]);
  await ensureBrowser({ install: installBrowser });
  const manager = new SessionManager(name, { debug: Boolean(options.debug) });
  let completed = false;
  try {
    let session;
    if (loginOnly) {
      session = await manager.login({
        timeoutMs: resolveTimeout(options.timeout, 600),
      });
    } else {
      try {
        session = await manager.importFromChrome({
          source,
          chromeProfile,
          timeoutMs: resolveTimeout(options.timeout, 60),
        });
      } catch (error) {
        if (!shouldOfferLogin(error) || options.json || !stdin.isTTY) throw error;
        const accepted = await confirmAction(
          `${error.message} Sign in to Slack with a browser now?`,
          { defaultValue: true },
        );
        if (!accepted) throw error;
        session = await manager.login({
          timeoutMs: resolveTimeout(options.timeout, 600),
        });
      }
    }
    setActiveClient(name);
    completed = true;
    return session;
  } finally {
    if (!completed && cleanNew && !existed) {
      removeClientDir(name);
    }
  }
}

function describeChannel(channel) {
  if (!channel) return 'channel';
  if (channel.type === 'im') {
    if (/^[DUW][A-Z0-9]{5,}$/.test(channel.name || '')) return `DM ${channel.id}`;
    return `DM with @${channel.name}`;
  }
  if (channel.type === 'mpim') return `group DM ${channel.name}`;
  if (/^[CDG][A-Z0-9]{5,}$/.test(channel.name || '')) return `channel ${channel.id}`;
  return `#${channel.name}`;
}

function messageUser(message, resolver) {
  if (message.user) {
    const user = resolver.userMap?.get(message.user);
    if (user) return resolver.displayUser(message.user);
  }
  if (message.username) return message.username;
  if (message.bot_id) return `bot:${message.bot_id}`;
  return message.user || 'unknown';
}

function messageText(message) {
  let text = message.text || '';
  if (!text && message.files?.length) text = `[${message.files.length} file(s)]`;
  if (!text && message.attachments?.length) text = `[${message.attachments.length} attachment(s)]`;
  if (!text) text = `[${message.subtype || 'no text'}]`;
  return text;
}

function messageRows(messages, resolver) {
  return [...messages]
    .sort((left, right) => Number(left.ts) - Number(right.ts))
    .map((message) => {
      let text = messageText(message);
      if (message.reply_count) text += ` [thread: ${message.reply_count}]`;
      if (message.files?.length && message.text) text += ` [files: ${message.files.length}]`;
      return [message.ts, formatTimestamp(message.ts), messageUser(message, resolver), text];
    });
}

function printMessages(messages, resolver) {
  if (messages.length === 0) {
    writeOut('No messages.');
    return;
  }
  writeOut(renderTable(['TS', 'TIME', 'USER', 'MESSAGE'], messageRows(messages, resolver), { maxCellWidth: 70 }));
}

function parseConversationTypes(value) {
  const types = String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (types.length === 0) throw new UsageError('--types requires at least one type.');
  for (const type of types) {
    if (!ALLOWED_CONVERSATION_TYPES.has(type)) {
      throw new UsageError(`Unknown conversation type "${type}". Use: ${[...ALLOWED_CONVERSATION_TYPES].join(', ')}.`);
    }
  }
  return types.join(',');
}

function parseFileTypes(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const types = String(value)
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (types.length === 0) throw new UsageError('--types requires at least one type.');
  for (const type of types) {
    if (!ALLOWED_FILE_TYPES.has(type)) {
      throw new UsageError(`Unknown file type "${type}". Use: ${[...ALLOWED_FILE_TYPES].join(', ')}.`);
    }
  }
  return types.join(',');
}

function safeFileName(file) {
  const raw = file?.name || file?.title || `slack-file-${file?.id ?? 'download'}`;
  const base = path.basename(String(raw).replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f]/g, '')
    .trim();
  if (!base || base === '.' || base === '..') return `slack-file-${file?.id ?? 'download'}`;
  return base;
}

function resolveDownloadPath(outputPath, defaultName) {
  if (!outputPath) return path.resolve(defaultName);
  const target = path.resolve(outputPath);
  let isDirectory = false;
  try {
    isDirectory = statSync(target).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (isDirectory || /[\\/]$/.test(outputPath)) return path.join(target, defaultName);
  return target;
}

async function collectMessageText(textParts, options) {
  let text = (textParts ?? []).join(' ').trim();
  if (!text && (options.stdin || !stdin.isTTY)) {
    text = (await readStdin()).trimEnd();
  }
  return text;
}

async function optionalJsonArray(value, label) {
  if (value === undefined || value === null) return undefined;
  const parsed = await parseJsonInput(value, label);
  if (!Array.isArray(parsed)) throw new UsageError(`${label} must be a JSON array.`);
  return parsed;
}

function parseParamPairs(pairs) {
  const params = {};
  for (const pair of pairs ?? []) {
    const index = String(pair).indexOf('=');
    if (index < 1) throw new UsageError(`Invalid --param "${pair}". Use key=value.`);
    const key = String(pair).slice(0, index);
    const raw = String(pair).slice(index + 1);
    let value = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
    params[key] = value;
  }
  return params;
}

function collectOption(value, previous) {
  return [...previous, value];
}

async function runChannelHistory(channelRef, options) {
  const { runtime } = await connectRuntime(options);
  const resolver = runtime.newResolver();
  const channel = await resolver.resolveChannel(channelRef);
  const limit = parsePositiveInt(options.limit, '--limit', { min: 1, max: 1000, fallback: 20 });
  const response = await runtime.call('conversations.history', {
    channel: channel.id,
    limit,
    ...(options.oldest ? { oldest: options.oldest } : {}),
    ...(options.latest ? { latest: options.latest } : {}),
  });
  if (options.json) {
    printJson(response);
    return;
  }
  await resolver.loadUsers();
  writeOut(`${describeChannel(channel)} (${channel.id})`);
  printMessages(response.messages ?? [], resolver);
}

async function runChannelThread(channelRef, threadTs, options) {
  const { runtime } = await connectRuntime(options);
  const resolver = runtime.newResolver();
  const channel = await resolver.resolveChannel(channelRef);
  const limit = parsePositiveInt(options.limit, '--limit', { min: 1, max: 1000, fallback: 100 });
  const response = await runtime.call('conversations.replies', {
    channel: channel.id,
    ts: threadTs,
    limit,
    ...(options.oldest ? { oldest: options.oldest } : {}),
    ...(options.latest ? { latest: options.latest } : {}),
  });
  if (options.json) {
    printJson(response);
    return;
  }
  await resolver.loadUsers();
  writeOut(`Thread in ${describeChannel(channel)} (${channel.id}) at ts=${threadTs}`);
  printMessages(response.messages ?? [], resolver);
}

async function runSendMessage(channelRef, textParts, options, { threadTs } = {}) {
  const { runtime } = await connectRuntime(options);
  const resolver = runtime.newResolver();
  const channel = await resolver.resolveChannel(channelRef);
  const text = await collectMessageText(textParts, options);
  const blocks = await optionalJsonArray(options.blocks, 'blocks');
  const attachments = await optionalJsonArray(options.attachments, 'attachments');
  if (!text && !blocks?.length && !attachments?.length) {
    throw new UsageError('Message text is required (or provide --blocks/--attachments).');
  }
  const response = await runtime.call('chat.postMessage', {
    channel: channel.id,
    ...(text ? { text } : {}),
    ...(blocks ? { blocks: JSON.stringify(blocks) } : {}),
    ...(attachments ? { attachments: JSON.stringify(attachments) } : {}),
    ...(threadTs ? { thread_ts: threadTs } : {}),
    ...(threadTs && options.broadcast ? { reply_broadcast: true } : {}),
  });
  if (options.json) {
    printJson(response);
    return;
  }
  const where = threadTs ? `thread ${threadTs} in ${describeChannel(channel)}` : describeChannel(channel);
  writeOut(`Sent to ${where} (ts=${response.ts}).`);
}

function createCli() {
  const program = new Command();

  program
    .name('slack-cli')
    .description(
      'Automate Slack using your real Chrome login. Choose a client (browser profile), '
      + 'choose a workspace, then read and interact with Slack from the terminal.',
    )
    .version(packageJson.version)
    .showHelpAfterError()
    .addHelpText('after', `
Examples:
  slack-cli setup                                   Import your Chrome Slack session
  slack-cli setup --chrome-profile "Profile 1"      Pick a specific Chrome profile
  slack-cli login                                   Open a browser to sign in
  slack-cli auth repair --login                     Refresh, re-import, or re-login
  slack-cli client list                             List browser sessions (clients)
  slack-cli workspace list                          List workspaces
  slack-cli workspace use my-workspace              Select a workspace
  slack-cli conversations list --types public_channel,private_channel
  slack-cli conversations history general --limit 20
  slack-cli messages send general "Deploy finished"
  slack-cli messages send @alice "Ping" --thread 1729412345.123456
  slack-cli messages react general 1729412345.123456 thumbsup
  slack-cli users list
  slack-cli files list --channel general
  slack-cli files upload general ./report.pdf --comment "Report attached"
  slack-cli files download F0123ABCD
  slack-cli messages reactions general 1729412345.123456
  slack-cli api conversations.list '{"types":"public_channel","limit":5}'

Global options such as --client, --workspace, and --json go after the command.
Run "slack-cli <command> --help" for command-specific options.`);

  const setup = program
    .command('setup')
    .description('Import the current Chrome login session and prepare a client profile')
    .option('--name <name>', 'client profile name', 'default')
    .option('--source <dir>', 'Chrome user data directory (auto-detected by default)')
    .option('--chrome-profile <name>', 'Chrome profile directory such as Default or "Profile 1"')
    .option('--login', 'skip Chrome import and sign in with a browser instead')
    .option('--install-browser', 'install Playwright Chromium if no browser is available')
    .option('--timeout <seconds>', 'timeout for import/login steps');
  addBasicOptions(setup);
  setup.action(handle(async (options, command) => {
    const name = options.name || 'default';
    const session = await importOrLoginClient({
      options,
      name,
      source: options.source,
      chromeProfile: options.chromeProfile,
      loginOnly: Boolean(options.login),
      installBrowser: Boolean(options.installBrowser),
    });
    printSessionReady(name, session, options, 'Setup complete');
    if (!options.json) {
      writeOut('');
      writeOut('Next: `slack-cli conversations list` or `slack-cli messages send <channel> <text>`.');
    }
  }));

  const login = program
    .command('login')
    .description('Open a browser and sign in to Slack, saving a fresh session')
    .argument('[workspaceUrl]', 'optional Slack workspace URL to open')
    .option('--fresh', 'clear the saved Slack cookies/storage before signing in')
    .option('--timeout <seconds>', 'login timeout in seconds');
  addClientOptions(login);
  login.action(handle(async (workspaceUrl, options) => {
    const config = readConfig();
    const requested = options.client || process.env.SLACK_CLI_CLIENT;
    let clientName;
    if (requested) {
      validateClientName(requested);
      clientName = requested;
    } else {
      clientName = config.activeClient && config.clients[config.activeClient]
        ? config.activeClient
        : Object.keys(config.clients)[0] || 'default';
    }
    await ensureBrowser();
    const manager = new SessionManager(clientName, { debug: Boolean(options.debug) });
    const session = await manager.login({
      workspaceUrl,
      fresh: Boolean(options.fresh),
      timeoutMs: resolveTimeout(options.timeout, 600),
    });
    setActiveClient(clientName);
    printSessionReady(clientName, session, options, 'Login complete');
  }));

  const auth = program.command('auth').description('Inspect and repair the Slack session');

  const authStatus = auth
    .command('status')
    .description('Check whether the saved Slack session is valid');
  addRuntimeOptions(authStatus);
  const authStatusHandler = handle(async (options) => {
    const { clientName, manager } = resolveClientOrThrow(options, { requireSession: true });
    const status = await manager.status({ workspaceRef: options.workspace || undefined });
    const payload = {
      ok: status.valid,
      client: clientName,
      valid: status.valid,
      error: status.error ?? null,
      workspace: publicWorkspace(status.workspace),
      activeWorkspaceId: status.session.activeWorkspaceId,
      workspaceCount: status.session.workspaces?.length ?? 0,
      cookieExpiresAt: status.session.cookieExpiresAt ?? null,
      sessionFile: status.sessionPath,
      source: status.session.source ?? null,
      lastRefreshedAt: status.session.lastRefreshedAt ?? null,
    };
    if (options.json) {
      printJson(payload);
    } else {
      writeOut(`Client: ${clientName}`);
      writeOut(renderKeyValues(formatSessionStatus(status)));
      if (!status.valid) {
        process.stderr.write('Run `slack-cli auth repair --login` to refresh or sign in again.\n');
      }
    }
    if (!status.valid) process.exitCode = 3;
  });
  authStatus.action(authStatusHandler);

  const authRefresh = auth
    .command('refresh')
    .description('Reload workspace tokens from the saved browser profile (headless)')
    .option('--timeout <seconds>', 'refresh timeout in seconds');
  addClientOptions(authRefresh);
  authRefresh.action(handle(async (options) => {
    const { clientName, manager } = resolveClientOrThrow(options, { requireSession: true });
    const session = await manager.refresh({
      timeoutMs: resolveTimeout(options.timeout, 45),
    });
    printSessionReady(clientName, session, options, 'Session refreshed');
  }));

  const authRepair = auth
    .command('repair')
    .description('Refresh tokens, re-import Chrome cookies, or sign in again')
    .option('--login', 'open a browser and sign in if automatic recovery fails')
    .option('--timeout <seconds>', 'timeout for each browser step');
  addClientOptions(authRepair);
  authRepair.action(handle(async (options) => {
    const { clientName, manager } = resolveClientOrThrow(options, { requireSession: true });
    let session = null;
    let lastError = null;

    try {
      progress('Refreshing tokens from the saved browser profile...');
      session = await manager.refresh({ timeoutMs: resolveTimeout(options.timeout, 45) });
    } catch (error) {
      lastError = error;
      progress(`Profile refresh failed: ${error.message}`);
    }

    if (!session) {
      const meta = readConfig().clients[clientName];
      const source = meta?.source;
      if (source?.dataDir) {
        try {
          progress('Re-importing the Slack session from Chrome...');
          session = await manager.importFromChrome({
            source: source.dataDir,
            chromeProfile: source.profile,
            timeoutMs: resolveTimeout(options.timeout, 60),
          });
        } catch (error) {
          lastError = error;
          progress(`Chrome re-import failed: ${error.message}`);
        }
      }
    }

    if (!session) {
      let loginNow = Boolean(options.login);
      if (!loginNow && stdin.isTTY && !options.json) {
        loginNow = await confirmAction(
          'Automatic session repair failed. Sign in to Slack with a browser now?',
          { defaultValue: true },
        );
      }
      if (!loginNow) {
        throw new AuthError('The Slack session could not be repaired automatically.', {
          code: 'repair_failed',
          hint: 'Run `slack-cli auth repair --login` to sign in again in a browser.',
          cause: lastError,
        });
      }
      await ensureBrowser();
      session = await manager.login({
        fresh: true,
        timeoutMs: resolveTimeout(options.timeout, 600),
      });
    }

    setActiveClient(clientName);
    printSessionReady(clientName, session, options, 'Session repaired');
  }));

  const status = program
    .command('status')
    .description('Alias for `slack-cli auth status`');
  addRuntimeOptions(status);
  status.action(authStatusHandler);

  const client = program.command('client').description('Manage browser sessions (clients)');

  const clientList = client
    .command('list')
    .description('List configured clients and their workspaces');
  addBasicOptions(clientList);
  clientList.action(handle(async (options) => {
    const config = readConfig();
    const names = Object.keys(config.clients);
    const effectiveActive = names.length > 0 ? resolveClientName(config, null) : null;
    const clients = names.map((name) => {
      const meta = config.clients[name] ?? {};
      let session = null;
      try {
        session = readSession(name);
      } catch {
        session = null;
      }
      const activeWorkspace = session?.workspaces?.find((workspace) => workspace.id === session.activeWorkspaceId);
      return {
        name,
        active: name === effectiveActive,
        workspaceCount: session?.workspaces?.length ?? 0,
        activeWorkspaceId: session?.activeWorkspaceId ?? null,
        activeWorkspaceName: activeWorkspace?.name ?? null,
        source: meta.source ?? session?.source ?? null,
        lastImportedAt: meta.lastImportedAt ?? null,
        lastLoginAt: meta.lastLoginAt ?? null,
        profile: clientSessionPath(name).replace(/session\.json$/, 'profile'),
      };
    });
    if (options.json) {
      printJson({ ok: true, activeClient: effectiveActive, clients });
      return;
    }
    if (clients.length === 0) {
      writeOut('No clients configured. Run `slack-cli setup`.');
      return;
    }
    writeOut(renderTable(
      ['ACTIVE', 'CLIENT', 'WORKSPACES', 'ACTIVE WORKSPACE', 'SOURCE', 'LAST IMPORT/LOGIN'],
      clients.map((entry) => [
        entry.active ? '*' : '',
        entry.name,
        entry.workspaceCount,
        entry.activeWorkspaceName || entry.activeWorkspaceId || '-',
        entry.source ? entry.source.profile : 'login only',
        formatDate(entry.lastImportedAt || entry.lastLoginAt),
      ]),
    ));
  }));

  const clientAdd = client
    .command('add <name>')
    .description('Create a client by importing a Chrome session or signing in')
    .option('--source <dir>', 'Chrome user data directory')
    .option('--chrome-profile <name>', 'Chrome profile directory')
    .option('--login', 'skip import and sign in with a browser')
    .option('--install-browser', 'install Playwright Chromium if no browser is available')
    .option('--timeout <seconds>', 'timeout for import/login steps')
    .option('--force', 'replace the client if it already exists');
  addBasicOptions(clientAdd);
  clientAdd.action(handle(async (name, options) => {
    const existing = readConfig().clients[name];
    if (existing && !options.force) {
      throw new UsageError(`Client "${name}" already exists. Use --force to re-import, or \`slack-cli setup --name ${name}\`.`, {
        hint: 'Run `slack-cli client use <name>` to switch to it.',
      });
    }
    const session = await importOrLoginClient({
      options,
      name,
      source: options.source,
      chromeProfile: options.chromeProfile,
      loginOnly: Boolean(options.login),
      installBrowser: Boolean(options.installBrowser),
    });
    printSessionReady(name, session, options, 'Client added');
  }));

  const clientUse = client
    .command('use <name>')
    .description('Select the active client');
  addBasicOptions(clientUse);
  clientUse.action(handle(async (name, options) => {
    const config = readConfig();
    if (!config.clients[name]) {
      throw new NotFoundError(`Unknown client "${name}". Available: ${Object.keys(config.clients).join(', ') || 'none'}.`);
    }
    validateClientName(name);
    setActiveClient(name);
    let activeWorkspaceId = null;
    try {
      activeWorkspaceId = readSession(name)?.activeWorkspaceId ?? null;
    } catch {
      activeWorkspaceId = null;
    }
    if (options.json) {
      printJson({ ok: true, client: name, activeWorkspaceId });
      return;
    }
    writeOut(`Active client: ${name}${activeWorkspaceId ? ` (workspace ${activeWorkspaceId})` : ''}`);
  }));

  const clientCurrent = client
    .command('current')
    .description('Show the active client');
  addBasicOptions(clientCurrent);
  clientCurrent.action(handle(async (options) => {
    const config = readConfig();
    const name = resolveClientName(config, null);
    let activeWorkspaceId = null;
    if (name) {
      try {
        activeWorkspaceId = readSession(name)?.activeWorkspaceId ?? null;
      } catch {
        activeWorkspaceId = null;
      }
    }
    if (options.json) {
      printJson({ ok: true, client: name, activeWorkspaceId });
      return;
    }
    writeOut(name ? `Active client: ${name}` : 'No active client. Run `slack-cli setup`.');
  }));

  const clientRemove = client
    .command('remove <name>')
    .description('Delete a client and its dedicated browser profile');
  addBasicOptions(clientRemove);
  addDestructiveOption(clientRemove);
  clientRemove.action(handle(async (name, options) => {
    const config = readConfig();
    if (!config.clients[name]) throw new NotFoundError(`Unknown client "${name}".`);
    const confirmed = await confirmAction(
      `Remove client "${name}" and its browser profile?`,
      { yes: Boolean(options.yes) },
    );
    if (!confirmed) {
      writeOut('Cancelled.');
      return;
    }
    removeClientDir(name);
    removeClientMeta(name);
    if (options.json) {
      printJson({ ok: true, removed: name });
      return;
    }
    writeOut(`Removed client "${name}".`);
  }));

  const workspace = program
    .command('workspace')
    .alias('ws')
    .description('Manage Slack workspaces');

  const workspaceList = workspace
    .command('list')
    .description('List workspaces in the active client');
  addClientOptions(workspaceList);
  workspaceList.action(handle(async (options) => {
    const { clientName, manager } = resolveClientOrThrow(options, { requireSession: true });
    const { session, workspaces } = manager.listWorkspaces();
    if (options.json) {
      printJson(sessionSummary(clientName, session));
      return;
    }
    writeOut(`Workspaces for client "${clientName}" (${workspaces.length}):`);
    printWorkspacesTable(session);
  }));

  const workspaceUse = workspace
    .command('use <ref>')
    .description('Select the active workspace by ID, domain, name, or URL');
  addClientOptions(workspaceUse);
  workspaceUse.action(handle(async (ref, options) => {
    const { manager } = resolveClientOrThrow(options, { requireSession: true });
    const selected = manager.useWorkspace(ref);
    if (options.json) {
      printJson({ ok: true, activeWorkspaceId: selected.id, workspace: publicWorkspace(selected) });
      return;
    }
    writeOut(`Active workspace: ${selected.name} (${selected.domain || selected.id})`);
  }));

  const workspaceCurrent = workspace
    .command('current')
    .description('Show the active workspace');
  addClientOptions(workspaceCurrent);
  workspaceCurrent.action(handle(async (options) => {
    const { manager } = resolveClientOrThrow(options, { requireSession: true });
    const session = manager.requireSession();
    const current = resolveWorkspaceFromSession(session, options.workspace || undefined);
    if (options.json) {
      printJson({ ok: true, workspace: publicWorkspace(current), activeWorkspaceId: session.activeWorkspaceId });
      return;
    }
    writeOut(renderKeyValues([
      ['Workspace', `${current.name} (${current.domain || current.id})`],
      ['Team ID', current.id],
      ['URL', current.url ?? '-'],
      ['User', current.userName ? `${current.userName} (${current.userId})` : current.userId],
    ]));
  }));

  const workspaceInfo = workspace
    .command('info [ref]')
    .description('Show workspace details (API-verified)');
  addRuntimeOptions(workspaceInfo);
  workspaceInfo.action(handle(async (ref, options) => {
    const { runtime } = await connectRuntime({
      ...options,
      workspace: ref || options.workspace,
    });
    let team = null;
    try {
      team = (await runtime.call('team.info')).team;
    } catch (error) {
      if (error instanceof NetworkError) throw error;
    }
    if (options.json) {
      printJson({ ok: true, workspace: publicWorkspace(runtime.workspace), team });
      return;
    }
    writeOut(renderKeyValues([
      ['Workspace', `${runtime.workspace.name} (${runtime.workspace.domain || runtime.workspace.id})`],
      ['Team ID', runtime.workspace.id],
      ['Domain', runtime.workspace.domain ?? '-'],
      ['URL', runtime.workspace.url ?? '-'],
      ['User', runtime.workspace.userName ? `${runtime.workspace.userName} (${runtime.workspace.userId})` : runtime.workspace.userId],
      ['Enterprise ID', runtime.workspace.enterpriseId ?? '-'],
      ['Team name', team?.name ?? '-'],
      ['Email domain', team?.email_domain ?? '-'],
    ]));
  }));

  const conversations = program
    .command('conversations')
    .alias('channels')
    .description('List and inspect channels, private channels, and DMs');

  const conversationsList = conversations
    .command('list')
    .description('List conversations you are a member of')
    .option('--types <types>', 'comma-separated: public_channel,private_channel,mpim,im', 'public_channel,private_channel,mpim,im')
    .option('--limit <n>', 'number of conversations to return', '100')
    .option('--all', 'paginate through all conversations')
    .option('--cursor <cursor>', 'pagination cursor')
    .option('--include-archived', 'include archived conversations');
  addRuntimeOptions(conversationsList);
  conversationsList.action(handle(async (options) => {
    const { runtime } = await connectRuntime(options);
    const types = parseConversationTypes(options.types);
    const limit = parsePositiveInt(options.limit, '--limit', { min: 1, max: 1000, fallback: 100 });
    let channels = [];
    let response;
    if (options.all) {
      let cursor;
      do {
        response = await runtime.call('conversations.list', {
          types,
          limit: 200,
          exclude_archived: !options.includeArchived,
          ...(cursor ? { cursor } : {}),
        });
        channels.push(...(response.channels ?? []));
        cursor = response.response_metadata?.next_cursor || undefined;
      } while (cursor && channels.length < 20_000);
      response = { ok: true, channels };
    } else {
      response = await runtime.call('conversations.list', {
        types,
        limit,
        exclude_archived: !options.includeArchived,
        ...(options.cursor ? { cursor: options.cursor } : {}),
      });
      channels = response.channels ?? [];
    }
    if (options.json) {
      printJson(response);
      return;
    }
    if (channels.length === 0) {
      writeOut('No conversations found.');
      return;
    }
    const resolver = runtime.newResolver();
    if (channels.some((entry) => entry.is_im)) await resolver.loadUsers();
    const rows = channels.map((entry) => {
      let name;
      let type;
      if (entry.is_im) {
        type = 'dm';
        name = `@${resolver.displayUser(entry.user)}`;
      } else if (entry.is_mpim) {
        type = 'group dm';
        name = entry.name || entry.id;
      } else {
        type = entry.is_private ? 'private' : 'channel';
        name = `#${entry.name || entry.id}`;
      }
      const purpose = entry.purpose?.value || entry.topic?.value || '';
      return [type, entry.id, name, entry.num_members ?? '', oneLine(purpose, 50)];
    });
    writeOut(renderTable(['TYPE', 'ID', 'NAME', 'MEMBERS', 'TOPIC/PURPOSE'], rows));
  }));

  const conversationsHistory = conversations
    .command('history <channel>')
    .description('Read recent messages from a channel or DM')
    .option('--limit <n>', 'number of messages', '20')
    .option('--oldest <ts>', 'oldest message timestamp')
    .option('--latest <ts>', 'latest message timestamp');
  addRuntimeOptions(conversationsHistory);
  conversationsHistory.action(handle(async (channelRef, options) => {
    await runChannelHistory(channelRef, options);
  }));

  const conversationsThread = conversations
    .command('thread <channel> <threadTs>')
    .description('Read a thread')
    .option('--limit <n>', 'number of replies', '100')
    .option('--oldest <ts>', 'oldest reply timestamp')
    .option('--latest <ts>', 'latest reply timestamp');
  addRuntimeOptions(conversationsThread);
  conversationsThread.action(handle(async (channelRef, threadTs, options) => {
    await runChannelThread(channelRef, threadTs, options);
  }));

  const conversationsInfo = conversations
    .command('info <channel>')
    .description('Show details about a conversation');
  addRuntimeOptions(conversationsInfo);
  conversationsInfo.action(handle(async (channelRef, options) => {
    const { runtime } = await connectRuntime(options);
    const resolver = runtime.newResolver();
    const channel = await resolver.resolveChannel(channelRef);
    const response = await runtime.call('conversations.info', {
      channel: channel.id,
      include_num_members: true,
    });
    if (options.json) {
      printJson(response);
      return;
    }
    const info = response.channel;
    writeOut(renderKeyValues([
      ['Name', info.name ? `#${info.name}` : info.id],
      ['ID', info.id],
      ['Type', info.is_im ? 'DM' : info.is_mpim ? 'group DM' : info.is_private ? 'private channel' : 'channel'],
      ['Members', info.num_members ?? '-'],
      ['Archived', info.is_archived ? 'yes' : 'no'],
      ['Topic', info.topic?.value || '-'],
      ['Purpose', info.purpose?.value || '-'],
      ['Created', info.created ? formatDate(new Date(info.created * 1000)) : '-'],
    ]));
  }));

  const conversationsMembers = conversations
    .command('members <channel>')
    .description('List members of a conversation')
    .option('--limit <n>', 'number of members', '100')
    .option('--all', 'paginate through all members');
  addRuntimeOptions(conversationsMembers);
  conversationsMembers.action(handle(async (channelRef, options) => {
    const { runtime } = await connectRuntime(options);
    const resolver = runtime.newResolver();
    const channel = await resolver.resolveChannel(channelRef);
    const limit = parsePositiveInt(options.limit, '--limit', { min: 1, max: 1000, fallback: 100 });
    let response;
    if (options.all) {
      const members = [];
      let cursor;
      do {
        response = await runtime.call('conversations.members', {
          channel: channel.id,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        members.push(...(response.members ?? []));
        cursor = response.response_metadata?.next_cursor || undefined;
      } while (cursor && members.length < 20_000);
      response = { ok: true, members };
    } else {
      response = await runtime.call('conversations.members', { channel: channel.id, limit });
    }
    if (options.json) {
      printJson(response);
      return;
    }
    const memberIds = response.members ?? [];
    if (memberIds.length === 0) {
      writeOut('No members found.');
      return;
    }
    await resolver.loadUsers();
    const rows = memberIds.map((id) => {
      const user = resolver.userMap?.get(id);
      return [id, user?.name ?? '', user?.profile?.display_name || user?.real_name || (user ? '' : 'unknown')];
    });
    writeOut(renderTable(['USER ID', 'USERNAME', 'DISPLAY NAME'], rows));
  }));

  const conversationsOpen = conversations
    .command('open <user>')
    .description('Open (or find) the DM channel with a user');
  addRuntimeOptions(conversationsOpen);
  conversationsOpen.action(handle(async (userRef, options) => {
    const { runtime } = await connectRuntime(options);
    const resolver = runtime.newResolver();
    const user = await resolver.resolveUser(userRef);
    const response = await runtime.call('conversations.open', { users: user.id });
    if (options.json) {
      printJson(response);
      return;
    }
    writeOut(`Opened DM with @${user.name} (${response.channel.id}).`);
  }));

  const conversationsJoin = conversations
    .command('join <channel>')
    .description('Join a channel');
  addRuntimeOptions(conversationsJoin);
  conversationsJoin.action(handle(async (channelRef, options) => {
    const { runtime } = await connectRuntime(options);
    const resolver = runtime.newResolver();
    const channel = await resolver.resolveChannel(channelRef);
    const response = await runtime.call('conversations.join', { channel: channel.id });
    if (options.json) {
      printJson(response);
      return;
    }
    writeOut(`Joined ${describeChannel(channel)}.`);
  }));

  const conversationsLeave = conversations
    .command('leave <channel>')
    .description('Leave a channel');
  addRuntimeOptions(conversationsLeave);
  addDestructiveOption(conversationsLeave);
  conversationsLeave.action(handle(async (channelRef, options) => {
    const { runtime } = await connectRuntime(options);
    const resolver = runtime.newResolver();
    const channel = await resolver.resolveChannel(channelRef);
    const confirmed = await confirmAction(
      `Leave ${describeChannel(channel)}?`,
      { yes: Boolean(options.yes) },
    );
    if (!confirmed) {
      writeOut('Cancelled.');
      return;
    }
    const response = await runtime.call('conversations.leave', { channel: channel.id });
    if (options.json) {
      printJson(response);
      return;
    }
    writeOut(`Left ${describeChannel(channel)}.`);
  }));

  const conversationsMark = conversations
    .command('mark <channel> [ts]')
    .description('Mark a conversation as read');
  addRuntimeOptions(conversationsMark);
  conversationsMark.action(handle(async (channelRef, ts, options) => {
    const { runtime } = await connectRuntime(options);
    const resolver = runtime.newResolver();
    const channel = await resolver.resolveChannel(channelRef);
    const response = await runtime.call('conversations.mark', {
      channel: channel.id,
      ...(ts ? { ts } : {}),
    });
    if (options.json) {
      printJson(response);
      return;
    }
    writeOut(`Marked ${describeChannel(channel)} as read.`);
  }));

  const messages = program
    .command('messages')
    .alias('msg')
    .description('Send and interact with messages');

  const messagesSend = messages
    .command('send <channel> [text...]')
    .description('Send a message to a channel or user (@name)')
    .option('--thread <ts>', 'reply in a thread')
    .option('--broadcast', 'also send a thread reply to the channel')
    .option('--blocks <json>', 'JSON array of Block Kit blocks (@file or - for stdin)')
    .option('--attachments <json>', 'JSON array of legacy attachments (@file or - for stdin)')
    .option('--stdin', 'read message text from stdin');
  addRuntimeOptions(messagesSend);
  messagesSend.action(handle(async (channelRef, textParts, options) => {
    await runSendMessage(channelRef, textParts, options, { threadTs: options.thread });
  }));

  const messagesReply = messages
    .command('reply <channel> <threadTs> [text...]')
    .description('Reply in a message thread')
    .option('--broadcast', 'also send the reply to the channel')
    .option('--blocks <json>', 'JSON array of Block Kit blocks (@file or - for stdin)')
    .option('--attachments <json>', 'JSON array of legacy attachments (@file or - for stdin)')
    .option('--stdin', 'read message text from stdin');
  addRuntimeOptions(messagesReply);
  messagesReply.action(handle(async (channelRef, threadTs, textParts, options) => {
    await runSendMessage(channelRef, textParts, options, { threadTs });
  }));

  const messagesEdit = messages
    .command('edit <channel> <ts> [text...]')
    .description('Edit one of your messages')
    .option('--blocks <json>', 'JSON array of Block Kit blocks (@file or - for stdin)')
    .option('--stdin', 'read message text from stdin');
  addRuntimeOptions(messagesEdit);
  messagesEdit.action(handle(async (channelRef, ts, textParts, options) => {
    const { runtime } = await connectRuntime(options);
    const resolver = runtime.newResolver();
    const channel = await resolver.resolveChannel(channelRef);
    const text = await collectMessageText(textParts, options);
    const blocks = await optionalJsonArray(options.blocks, 'blocks');
    if (!text && !blocks?.length) throw new UsageError('Message text or --blocks is required.');
    const response = await runtime.call('chat.update', {
      channel: channel.id,
      ts,
      ...(text ? { text } : {}),
      ...(blocks ? { blocks: JSON.stringify(blocks) } : {}),
    });
    if (options.json) {
      printJson(response);
      return;
    }
    writeOut(`Updated message ${response.ts ?? ts} in ${describeChannel(channel)}.`);
  }));

  const messagesDelete = messages
    .command('delete <channel> <ts>')
    .description('Delete a message');
  addRuntimeOptions(messagesDelete);
  addDestructiveOption(messagesDelete);
  messagesDelete.action(handle(async (channelRef, ts, options) => {
    const { runtime } = await connectRuntime(options);
    const resolver = runtime.newResolver();
    const channel = await resolver.resolveChannel(channelRef);
    const confirmed = await confirmAction(
      `Delete message ${ts} in ${describeChannel(channel)}?`,
      { yes: Boolean(options.yes) },
    );
    if (!confirmed) {
      writeOut('Cancelled.');
      return;
    }
    const response = await runtime.call('chat.delete', { channel: channel.id, ts });
    if (options.json) {
      printJson(response);
      return;
    }
    writeOut(`Deleted message ${ts} in ${describeChannel(channel)}.`);
  }));

  const addReaction = (command, { remove }) => {
    command
      .argument('<channel>')
      .argument('<ts>')
      .argument('<emoji>');
    addRuntimeOptions(command);
    command.action(handle(async (channelRef, ts, emoji, options) => {
      const { runtime } = await connectRuntime(options);
      const resolver = runtime.newResolver();
      const channel = await resolver.resolveChannel(channelRef);
      const name = String(emoji).replace(/^:|:$/g, '').trim();
      if (!name || /\s/.test(name)) throw new UsageError('Emoji must be a Slack reaction name, e.g. thumbsup or :thumbsup:.');
      const response = await runtime.call(remove ? 'reactions.remove' : 'reactions.add', {
        channel: channel.id,
        timestamp: ts,
        name,
      });
      if (options.json) {
        printJson(response);
        return;
      }
      writeOut(`${remove ? 'Removed' : 'Added'} :${name}: ${remove ? 'from' : 'to'} message ${ts} in ${describeChannel(channel)}.`);
    }));
  };
  addReaction(
    messages.command('react').description('Add an emoji reaction to a message'),
    { remove: false },
  );
  addReaction(
    messages.command('unreact').description('Remove an emoji reaction from a message'),
    { remove: true },
  );

  const messagesReactions = messages
    .command('reactions <channel> <ts>')
    .description('List reactions on a message');
  addRuntimeOptions(messagesReactions);
  messagesReactions.action(handle(async (channelRef, ts, options) => {
    const { runtime } = await connectRuntime(options);
    const resolver = runtime.newResolver();
    const channel = await resolver.resolveChannel(channelRef);
    const response = await runtime.call('reactions.get', {
      channel: channel.id,
      timestamp: ts,
      full: true,
    });
    if (options.json) {
      printJson(response);
      return;
    }
    const reactions = response.message?.reactions ?? [];
    if (reactions.length === 0) {
      writeOut('No reactions.');
      return;
    }
    await resolver.loadUsers();
    const rows = reactions.map((reaction) => [
      `:${reaction.name}:`,
      reaction.count ?? reaction.users?.length ?? 0,
      (reaction.users ?? []).map((id) => resolver.displayUser(id)).join(', '),
    ]);
    writeOut(`${describeChannel(channel)} message ${ts}`);
    writeOut(renderTable(['EMOJI', 'COUNT', 'USERS'], rows, { maxCellWidth: 80 }));
  }));

  const pinAction = (command, { remove }) => {
    command
      .argument('<channel>')
      .argument('<ts>');
    addRuntimeOptions(command);
    command.action(handle(async (channelRef, ts, options) => {
      const { runtime } = await connectRuntime(options);
      const resolver = runtime.newResolver();
      const channel = await resolver.resolveChannel(channelRef);
      const response = await runtime.call(remove ? 'pins.remove' : 'pins.add', {
        channel: channel.id,
        timestamp: ts,
      });
      if (options.json) {
        printJson(response);
        return;
      }
      writeOut(`${remove ? 'Unpinned' : 'Pinned'} message ${ts} in ${describeChannel(channel)}.`);
    }));
  };
  pinAction(messages.command('pin').description('Pin a message'), { remove: false });
  pinAction(messages.command('unpin').description('Unpin a message'), { remove: true });

  const messagesPins = messages
    .command('pins <channel>')
    .description('List pinned items in a channel');
  addRuntimeOptions(messagesPins);
  messagesPins.action(handle(async (channelRef, options) => {
    const { runtime } = await connectRuntime(options);
    const resolver = runtime.newResolver();
    const channel = await resolver.resolveChannel(channelRef);
    const response = await runtime.call('pins.list', { channel: channel.id });
    if (options.json) {
      printJson(response);
      return;
    }
    const items = response.items ?? [];
    if (items.length === 0) {
      writeOut('No pinned items.');
      return;
    }
    await resolver.loadUsers();
    const rows = items.map((item) => [
      item.type,
      item.created ? formatDate(new Date(item.created * 1000)) : '',
      item.user ? resolver.displayUser(item.user) : '',
      oneLine(item.message?.text || item.file?.title || item.file?.name || item.comment?.comment || '', 70),
    ]);
    writeOut(renderTable(['TYPE', 'CREATED', 'USER', 'ITEM'], rows));
  }));

  const messagesPermalink = messages
    .command('permalink <channel> <ts>')
    .description('Get the permalink for a message');
  addRuntimeOptions(messagesPermalink);
  messagesPermalink.action(handle(async (channelRef, ts, options) => {
    const { runtime } = await connectRuntime(options);
    const resolver = runtime.newResolver();
    const channel = await resolver.resolveChannel(channelRef);
    const response = await runtime.call('chat.getPermalink', { channel: channel.id, message_ts: ts });
    if (options.json) {
      printJson(response);
      return;
    }
    writeOut(response.permalink);
  }));

  const messagesSearch = messages
    .command('search <query...>')
    .description('Search Slack messages')
    .option('--count <n>', 'number of matches', '20')
    .option('--sort <sort>', 'score or timestamp', 'score');
  addRuntimeOptions(messagesSearch);
  messagesSearch.action(handle(async (queryParts, options) => {
    const { runtime } = await connectRuntime(options);
    const query = queryParts.join(' ').trim();
    if (!query) throw new UsageError('A search query is required.');
    const count = parsePositiveInt(options.count, '--count', { min: 1, max: 100, fallback: 20 });
    if (!['score', 'timestamp'].includes(options.sort)) {
      throw new UsageError('--sort must be "score" or "timestamp".');
    }
    const response = await runtime.call('search.messages', {
      query,
      count,
      sort: options.sort,
    });
    if (options.json) {
      printJson(response);
      return;
    }
    const resolver = runtime.newResolver();
    await resolver.loadUsers();
    const matches = response.messages?.matches ?? [];
    if (matches.length === 0) {
      writeOut('No matches.');
      return;
    }
    const rows = matches.map((match) => [
      match.channel?.name ? `#${match.channel.name}` : match.channel?.id ?? '',
      formatTimestamp(match.ts),
      match.user ? resolver.displayUser(match.user) : match.username ?? '',
      oneLine(match.text, 80),
    ]);
    writeOut(renderTable(['CHANNEL', 'TIME', 'USER', 'MATCH'], rows, { maxCellWidth: 80 }));
    writeOut(`${response.messages?.total ?? matches.length} total match(es).`);
  }));

  const messagesHistory = messages
    .command('history <channel>')
    .description('Alias for `conversations history`')
    .option('--limit <n>', 'number of messages', '20')
    .option('--oldest <ts>', 'oldest message timestamp')
    .option('--latest <ts>', 'latest message timestamp');
  addRuntimeOptions(messagesHistory);
  messagesHistory.action(handle(async (channelRef, options) => {
    await runChannelHistory(channelRef, options);
  }));

  const messagesThread = messages
    .command('thread <channel> <threadTs>')
    .description('Alias for `conversations thread`')
    .option('--limit <n>', 'number of replies', '100')
    .option('--oldest <ts>', 'oldest reply timestamp')
    .option('--latest <ts>', 'latest reply timestamp');
  addRuntimeOptions(messagesThread);
  messagesThread.action(handle(async (channelRef, threadTs, options) => {
    await runChannelThread(channelRef, threadTs, options);
  }));

  const users = program.command('users').description('Inspect workspace users');

  const usersList = users
    .command('list')
    .description('List users in the workspace')
    .option('--limit <n>', 'number of users', '100')
    .option('--all', 'paginate through all users')
    .option('--include-deleted', 'include deactivated users');
  addRuntimeOptions(usersList);
  usersList.action(handle(async (options) => {
    const { runtime } = await connectRuntime(options);
    const limit = parsePositiveInt(options.limit, '--limit', { min: 1, max: 1000, fallback: 100 });
    let members = [];
    let response;
    if (options.all) {
      let cursor;
      do {
        response = await runtime.call('users.list', { limit: 200, ...(cursor ? { cursor } : {}) });
        members.push(...(response.members ?? []));
        cursor = response.response_metadata?.next_cursor || undefined;
      } while (cursor && members.length < 20_000);
      response = { ok: true, members };
    } else {
      response = await runtime.call('users.list', { limit });
      members = response.members ?? [];
    }
    if (options.json) {
      printJson(response);
      return;
    }
    const visible = members.filter((member) => options.includeDeleted || !member.deleted);
    if (visible.length === 0) {
      writeOut('No users found.');
      return;
    }
    const rows = visible.map((member) => [
      member.id,
      member.name,
      member.profile?.display_name || member.real_name || '',
      member.profile?.email ?? '',
      member.is_bot ? 'bot' : member.deleted ? 'deleted' : '',
    ]);
    writeOut(renderTable(['ID', 'USERNAME', 'DISPLAY NAME', 'EMAIL', 'FLAGS'], rows, { maxCellWidth: 50 }));
  }));

  const usersInfo = users
    .command('info <user>')
    .description('Show a user profile');
  addRuntimeOptions(usersInfo);
  usersInfo.action(handle(async (userRef, options) => {
    const { runtime } = await connectRuntime(options);
    const resolver = runtime.newResolver();
    const user = await resolver.resolveUser(userRef);
    const response = await runtime.call('users.info', { user: user.id });
    if (options.json) {
      printJson(response);
      return;
    }
    const info = response.user;
    writeOut(renderKeyValues([
      ['ID', info.id],
      ['Username', info.name],
      ['Display name', info.profile?.display_name || '-'],
      ['Real name', info.real_name || info.profile?.real_name || '-'],
      ['Title', info.profile?.title || '-'],
      ['Email', info.profile?.email || '-'],
      ['Status', info.deleted ? 'deleted' : info.is_bot ? 'bot' : 'active'],
      ['Timezone', info.tz_label ? `${info.tz_label} (${info.tz})` : info.tz || '-'],
    ]));
  }));

  const usersMe = users
    .command('me')
    .description('Show the authenticated user');
  addRuntimeOptions(usersMe);
  usersMe.action(handle(async (options) => {
    const { runtime } = await connectRuntime(options);
    if (!runtime.workspace.userId) throw new CliError('The current Slack user is unknown; refresh the session.');
    const response = await runtime.call('users.info', { user: runtime.workspace.userId });
    if (options.json) {
      printJson(response);
      return;
    }
    const info = response.user;
    writeOut(renderKeyValues([
      ['Workspace', runtime.workspace.name],
      ['User', `${info.profile?.display_name || info.real_name || info.name} (@${info.name})`],
      ['User ID', info.id],
      ['Email', info.profile?.email || '-'],
    ]));
  }));

  const usersPresence = users
    .command('presence <user>')
    .description('Show a user presence status');
  addRuntimeOptions(usersPresence);
  usersPresence.action(handle(async (userRef, options) => {
    const { runtime } = await connectRuntime(options);
    const resolver = runtime.newResolver();
    const user = await resolver.resolveUser(userRef);
    const response = await runtime.call('users.getPresence', { user: user.id });
    if (options.json) {
      printJson(response);
      return;
    }
    writeOut(renderKeyValues([
      ['User', `${user.name} (${user.id})`],
      ['Presence', response.presence ?? '-'],
      ['Online', response.online === undefined ? '-' : response.online ? 'yes' : 'no'],
      ['Auto away', response.auto_away === undefined ? '-' : response.auto_away ? 'yes' : 'no'],
      ['Manual away', response.manual_away === undefined ? '-' : response.manual_away ? 'yes' : 'no'],
    ]));
  }));

  const files = program.command('files').description('List, upload, download, and inspect files');

  const filesList = files
    .command('list')
    .description('List files visible to you')
    .option('--channel <ref>', 'only files shared in a channel')
    .option('--user <ref>', 'only files uploaded by a user')
    .option('--types <types>', 'comma-separated file types, e.g. images,pdfs')
    .option('--limit <n>', 'number of files per page', '20')
    .option('--page <n>', 'page number', '1')
    .option('--all', 'paginate through all files (max 20k)');
  addRuntimeOptions(filesList);
  filesList.action(handle(async (options) => {
    const { runtime } = await connectRuntime(options);
    const resolver = runtime.newResolver();
    const filters = {};
    if (options.channel) {
      const channel = await resolver.resolveChannel(options.channel);
      filters.channel = channel.id;
    }
    if (options.user) {
      const user = await resolver.resolveUser(options.user);
      filters.user = user.id;
    }
    const types = parseFileTypes(options.types);
    if (types) filters.types = types;

    let response;
    let items = [];
    if (options.all) {
      let page = 1;
      let pages = 1;
      do {
        response = await runtime.call('files.list', { count: 200, page, ...filters });
        items.push(...(response.files ?? []));
        pages = response.paging?.pages ?? 0;
        page += 1;
      } while (page <= pages && items.length < 20_000);
      response = { ok: true, files: items };
    } else {
      const limit = parsePositiveInt(options.limit, '--limit', { min: 1, max: 1000, fallback: 20 });
      const page = parsePositiveInt(options.page, '--page', { min: 1, fallback: 1 });
      response = await runtime.call('files.list', { count: limit, page, ...filters });
      items = response.files ?? [];
    }

    if (options.json) {
      printJson(response);
      return;
    }
    if (items.length === 0) {
      writeOut('No files found.');
      return;
    }
    if (items.some((file) => file.user)) await resolver.loadUsers();
    const rows = items.map((file) => [
      file.id,
      oneLine(file.name || file.title || file.id, 50),
      file.filetype || file.pretty_type || '-',
      formatBytes(file.size),
      file.user ? resolver.displayUser(file.user) : '-',
      file.created ? formatDate(new Date(file.created * 1000)) : '-',
    ]);
    writeOut(renderTable(['ID', 'NAME', 'TYPE', 'SIZE', 'USER', 'CREATED'], rows, { maxCellWidth: 50 }));
  }));

  const filesUpload = files
    .command('upload <channel> <path...>')
    .description('Upload one or more files to a channel or DM')
    .option('--title <title>', 'file title (single file only)')
    .option('--comment <text>', 'message to post with the file')
    .option('--thread <ts>', 'upload into a thread');
  addRuntimeOptions(filesUpload);
  filesUpload.action(handle(async (channelRef, filePaths, options) => {
    if (!filePaths.length) throw new UsageError('At least one file path is required.');
    if (options.title && filePaths.length > 1) {
      throw new UsageError('--title can only be used with a single file.');
    }
    const { runtime } = await connectRuntime(options);
    const resolver = runtime.newResolver();
    const channel = await resolver.resolveChannel(channelRef);
    const uploaded = [];
    for (const filePath of filePaths) {
      const absolute = path.resolve(filePath);
      let info;
      try {
        info = statSync(absolute);
      } catch (error) {
        throw new UsageError(`Cannot read ${filePath}: ${error.message}`);
      }
      if (!info.isFile()) throw new UsageError(`Not a file: ${filePath}`);
      const upload = await runtime.call('files.getUploadURLExternal', {
        filename: path.basename(absolute),
        length: info.size,
      });
      await uploadFileToUrl(upload.upload_url, absolute, info.size);
      uploaded.push({ id: upload.file_id, title: options.title || path.basename(absolute) });
    }
    const response = await runtime.call('files.completeUploadExternal', {
      files: JSON.stringify(uploaded),
      channel_id: channel.id,
      ...(options.comment ? { initial_comment: options.comment } : {}),
      ...(options.thread ? { thread_ts: options.thread } : {}),
    });
    if (options.json) {
      printJson(response);
      return;
    }
    writeOut(`Uploaded ${uploaded.length} file(s) to ${describeChannel(channel)}.`);
  }));

  const filesDownload = files
    .command('download <file> [path]')
    .description('Download a file by ID')
    .option('--force', 'overwrite the destination if it exists');
  addRuntimeOptions(filesDownload);
  filesDownload.action(handle(async (fileRef, outputPath, options) => {
    const { runtime } = await connectRuntime(options);
    const response = await runtime.call('files.info', { file: fileRef });
    const file = response.file;
    const url = file?.url_private_download || file?.url_private;
    if (!url) {
      throw new CliError(`File ${fileRef} has no download URL.`, {
        code: 'no_download_url',
        hint: 'The file may be external, deleted, or not accessible to this workspace.',
      });
    }
    const name = safeFileName(file);
    const destination = resolveDownloadPath(outputPath, name);
    if (existsSync(destination) && !options.force) {
      throw new UsageError(`Destination already exists: ${destination}. Pass --force to overwrite.`);
    }
    const downloaded = await downloadSlackFile(url, destination, {
      cookieHeader: runtime.api.cookieHeader,
      userAgent: runtime.api.userAgent,
    });
    if (options.json) {
      printJson({
        ok: true,
        file: {
          id: file.id,
          name: file.name,
          title: file.title,
          size: file.size,
          filetype: file.filetype,
          created: file.created,
          user: file.user,
        },
        path: destination,
        bytes: downloaded.bytes,
      });
      return;
    }
    writeOut(`Saved ${name} (${formatBytes(downloaded.bytes)}) to ${destination}.`);
  }));

  const filesDelete = files
    .command('delete <file>')
    .description('Delete a file (requires --yes)');
  addRuntimeOptions(filesDelete);
  addDestructiveOption(filesDelete);
  filesDelete.action(handle(async (fileRef, options) => {
    const confirmed = await confirmAction(
      `Delete Slack file ${fileRef}? This cannot be undone.`,
      { yes: Boolean(options.yes) },
    );
    if (!confirmed) {
      writeOut('Cancelled.');
      return;
    }
    const { runtime } = await connectRuntime(options);
    const response = await runtime.call('files.delete', { file: fileRef });
    if (options.json) {
      printJson(response);
      return;
    }
    writeOut(`Deleted file ${fileRef}.`);
  }));

  const filesInfo = files
    .command('info <file>')
    .description('Show metadata for a file');
  addRuntimeOptions(filesInfo);
  filesInfo.action(handle(async (fileId, options) => {
    const { runtime } = await connectRuntime(options);
    const response = await runtime.call('files.info', { file: fileId });
    if (options.json) {
      printJson(response);
      return;
    }
    const file = response.file;
    writeOut(renderKeyValues([
      ['ID', file.id],
      ['Name', file.name ?? '-'],
      ['Title', file.title ?? '-'],
      ['Type', file.filetype ?? file.mimetype ?? '-'],
      ['Size', file.size === undefined || file.size === null ? '-' : `${formatBytes(file.size)} (${file.size} bytes)`],
      ['User', file.user ?? '-'],
      ['Created', file.created ? formatDate(new Date(file.created * 1000)) : '-'],
      ['URL', file.permalink ?? file.url_private ?? '-'],
    ]));
  }));

  const api = program
    .command('api <method> [params]')
    .description('Call any Slack Web API method directly (raw JSON output)')
    .option('--body <json>', 'JSON object with parameters (@file or - for stdin)')
    .option('--param <key=value>', 'additional parameter; repeatable', collectOption, []);
  addRuntimeOptions(api);
  api.action(handle(async (method, paramsArg, options) => {
    const { runtime } = await connectRuntime(options);
    if (paramsArg && options.body) {
      throw new UsageError('Pass parameters as either the positional JSON argument or --body, not both.');
    }
    let params = {};
    if (paramsArg) {
      params = await parseJsonInput(paramsArg, 'params');
    } else if (options.body) {
      params = await parseJsonInput(options.body, 'body');
    }
    if (!isPlainObject(params)) throw new UsageError('Parameters must be a JSON object.');
    params = { ...params, ...parseParamPairs(options.param) };
    const response = await runtime.call(method, params);
    printJson(response);
  }));

  return program;
}

export async function main(argv = process.argv) {
  const program = createCli();
  await program.parseAsync(argv);
}

export { createCli };
