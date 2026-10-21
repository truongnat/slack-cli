import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { CliError } from './util.js';

const execFileAsync = promisify(execFile);

export function assertHeadedAvailable() {
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new CliError('No graphical session is available for a browser login.', {
      code: 'no_display',
      hint: 'Run `slack-cli login` from a desktop terminal, or import cookies with `slack-cli setup`.',
    });
  }
}

export function resolveSystemChrome() {
  const envPath = process.env.SLACK_CLI_CHROME_PATH || process.env.CHROME_PATH;
  if (envPath && isExecutable(envPath)) return envPath;

  const candidates = [];
  if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else if (process.platform === 'win32') {
    for (const root of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) {
      if (!root) continue;
      candidates.push(
        path.join(root, 'Google/Chrome/Application/chrome.exe'),
        path.join(root, 'Chromium/Application/chrome.exe'),
      );
    }
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome-beta',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
      '/opt/google/chrome/chrome',
    );
  }

  const names = process.platform === 'win32'
    ? ['chrome.exe', 'chromium.exe']
    : ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'];
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    for (const name of names) candidates.push(path.join(dir, name));
  }

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate) && isExecutable(candidate)) return candidate;
  }
  return null;
}

export function resolveBundledChromium() {
  try {
    const candidate = chromium.executablePath();
    if (candidate && existsSync(candidate)) return candidate;
  } catch {
    // Playwright browsers may not be installed.
  }
  return null;
}

export function resolveBrowser({ preferSystem = true } = {}) {
  const system = resolveSystemChrome();
  const bundled = resolveBundledChromium();
  if (preferSystem && system) return { executablePath: system, kind: 'chrome' };
  if (bundled) return { executablePath: bundled, kind: 'chromium' };
  if (system) return { executablePath: system, kind: 'chrome' };
  throw new CliError('No Chrome or Chromium browser was found.', {
    code: 'browser_not_found',
    hint: 'Install Google Chrome, or run `slack-cli setup --install-browser` to download Playwright Chromium.',
  });
}

export async function installBundledChromium() {
  try {
    await execFileAsync('npx', ['--yes', 'playwright', 'install', 'chromium'], {
      stdio: 'inherit',
      timeout: 15 * 60 * 1000,
    });
  } catch (error) {
    throw new CliError(`Could not install Playwright Chromium: ${error.message}`, {
      code: 'browser_install_failed',
      hint: 'Install Google Chrome manually, or run `npx playwright install chromium` and retry.',
    });
  }
  const executable = resolveBundledChromium();
  if (!executable) {
    throw new CliError('Playwright Chromium was installed but no executable was found.', {
      code: 'browser_install_failed',
    });
  }
  return executable;
}

export async function launchBrowser(profileDir, {
  headless = true,
  executablePath,
  ignoreDefaultArgs,
  args = [],
  timeout = 60000,
} = {}) {
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const browserPath = executablePath || resolveBrowser().executablePath;
  const launchArgs = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    ...args,
  ];
  try {
    return await chromium.launchPersistentContext(profileDir, {
      executablePath: browserPath,
      headless,
      ignoreDefaultArgs,
      args: launchArgs,
      timeout,
      viewport: headless ? { width: 1280, height: 800 } : null,
      acceptDownloads: false,
    });
  } catch (error) {
    const message = String(error.message || error);
    let hint;
    if (/ProcessSingleton|already in use|SingletonLock/i.test(message)) {
      hint = 'Close any browser using this slack-cli profile, wait a few seconds, and retry.';
    } else if (/Missing X server|no DISPLAY|Target page, context or browser has been closed/i.test(message)) {
      hint = 'Run the login command from a graphical desktop session.';
    } else {
      hint = 'Run `slack-cli setup` to check your browser installation.';
    }
    throw new CliError(`Could not launch browser: ${message}`, {
      code: 'browser_launch_failed',
      hint,
      cause: error,
    });
  }
}

export async function firstPage(context) {
  const existing = context.pages().find((page) => !page.isClosed());
  return existing || context.newPage();
}

function isExecutable(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
