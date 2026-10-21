import { readConfig, resolveClientName } from './config.js';
import { AuthError } from './util.js';
import {
  SessionManager,
  SlackRuntime,
  SessionResolver,
  importClientSession,
  refreshClientSession,
  loginClient,
  resolveWorkspaceFromSession,
} from './session.js';

export { SlackApi, SlackApiError, isAuthError, uploadFileToUrl, downloadSlackFile } from './api.js';
export {
  SessionManager,
  SlackRuntime,
  SessionResolver,
  importClientSession,
  refreshClientSession,
  loginClient,
  resolveWorkspaceFromSession,
  filterSlackCookies,
  dCookieFromCookies,
  cookieHeaderFromCookies,
  cookieExpiresAt,
} from './session.js';
export {
  readConfig,
  writeConfig,
  readSession,
  writeSession,
  resolveClientName,
  getSlackHome,
} from './config.js';
export { resolveBrowser, installBundledChromium } from './browser.js';
export { resolveChromeSource } from './chrome.js';
export { main, createCli } from './cli.js';

export function sessionManager(clientName, { debug = false } = {}) {
  const config = readConfig();
  const name = resolveClientName(config, clientName);
  if (!name) {
    throw new AuthError('No Slack clients are configured.', {
      code: 'no_clients',
      hint: 'Run `slack-cli setup` to import your Chrome session, or `slack-cli login`.',
    });
  }
  return new SessionManager(name, { debug });
}

export async function connect({ client, workspace, debug = false, autoRepair = true } = {}) {
  const manager = sessionManager(client, { debug });
  return manager.connect({ workspaceRef: workspace, autoRepair });
}
