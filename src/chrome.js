import { execFile } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { CliError } from './util.js';

const execFileAsync = promisify(execFile);

export function chromeDataDirCandidates() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return [
      path.join(home, 'Library/Application Support/Google/Chrome'),
      path.join(home, 'Library/Application Support/Chromium'),
    ];
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData/Local');
    return [
      path.join(localAppData, 'Google/Chrome/User Data'),
      path.join(localAppData, 'Chromium/User Data'),
    ];
  }
  return [
    path.join(home, '.config/google-chrome'),
    path.join(home, '.config/google-chrome-beta'),
    path.join(home, '.config/chromium'),
    path.join(home, '.var/app/com.google.Chrome/config/google-chrome'),
    path.join(home, '.var/app/org.chromium.Chromium/config/chromium'),
    path.join(home, 'snap/chromium/common/chromium'),
  ];
}

export function detectChromeDataDir(explicit) {
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!existsSync(resolved)) {
      throw new CliError(`Chrome data path does not exist: ${resolved}`, { code: 'chrome_not_found' });
    }
    return resolved;
  }
  if (process.env.SLACK_CLI_CHROME_DATA) {
    const resolved = path.resolve(process.env.SLACK_CLI_CHROME_DATA);
    if (!existsSync(resolved)) {
      throw new CliError(`SLACK_CLI_CHROME_DATA does not exist: ${resolved}`, { code: 'chrome_not_found' });
    }
    return resolved;
  }
  const found = chromeDataDirCandidates().find((candidate) => existsSync(path.join(candidate, 'Local State')));
  if (!found) {
    throw new CliError('Could not find a Chrome profile on this machine.', {
      code: 'chrome_not_found',
      hint: 'Pass --source <chrome-user-data-dir>, or use `slack-cli login` instead.',
    });
  }
  return found;
}

function readLocalState(dataDir) {
  const file = path.join(dataDir, 'Local State');
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function listChromeProfiles(dataDir) {
  const localState = readLocalState(dataDir);
  const lastUsed = localState?.profile?.last_used ?? null;
  const infoCache = localState?.profile?.info_cache ?? {};
  const names = new Set(Object.keys(infoCache));
  try {
    for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'Default' || /^Profile \d+$/.test(entry.name)) names.add(entry.name);
    }
  } catch {
    // Ignore unreadable Chrome directories and keep info_cache entries.
  }
  const profiles = [];
  for (const dir of names) {
    if (dir === 'System Profile' || dir === 'Guest Profile') continue;
    const profileDir = path.join(dataDir, dir);
    if (!existsSync(profileDir)) continue;
    const cookiesPath = findCookiesPath(profileDir);
    profiles.push({
      dir,
      profileDir,
      displayName: infoCache[dir]?.name || dir,
      isLastUsed: dir === lastUsed,
      cookiesPath,
    });
  }
  profiles.sort((a, b) => {
    if (a.isLastUsed !== b.isLastUsed) return a.isLastUsed ? -1 : 1;
    if (a.dir === 'Default') return -1;
    if (b.dir === 'Default') return 1;
    return a.dir.localeCompare(b.dir);
  });
  return { profiles, lastUsed };
}

export function findCookiesPath(profileDir) {
  for (const relative of ['Network/Cookies', 'Cookies']) {
    const candidate = path.join(profileDir, relative);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function countSlackCookieRows(cookiesPath) {
  if (!cookiesPath) return null;
  try {
    const { stdout } = await execFileAsync('sqlite3', [
      '-readonly',
      cookiesPath,
      "SELECT COUNT(*) FROM cookies WHERE host_key LIKE '%slack.com';",
    ], { timeout: 15000 });
    const parsed = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function resolveChromeSource({ source, profile, debug = false } = {}) {
  let explicitDataDir = source ? path.resolve(source) : null;
  let explicitProfile = profile ?? null;
  if (explicitDataDir && !existsSync(path.join(explicitDataDir, 'Local State'))) {
    const maybeCookies = findCookiesPath(explicitDataDir);
    if (maybeCookies) {
      explicitProfile = explicitProfile || path.basename(explicitDataDir);
      explicitDataDir = path.dirname(explicitDataDir);
    }
  }
  const dataDir = detectChromeDataDir(explicitDataDir);
  const { profiles, lastUsed } = listChromeProfiles(dataDir);
  if (profiles.length === 0) {
    throw new CliError(`No Chrome profiles found in ${dataDir}.`, {
      code: 'chrome_profile_not_found',
      hint: 'Open Chrome once, then retry.',
    });
  }

  const counts = await Promise.all(profiles.map(async (entry) => ({
    ...entry,
    slackCookieRows: await countSlackCookieRows(entry.cookiesPath),
  })));

  let selected;
  if (explicitProfile) {
    selected = counts.find((entry) => entry.dir === explicitProfile);
    if (!selected) {
      throw new CliError(
        `Chrome profile "${explicitProfile}" not found in ${dataDir}. Available profiles: ${counts.map((entry) => entry.dir).join(', ')}.`,
        { code: 'chrome_profile_not_found' },
      );
    }
  } else {
    const ranked = [...counts].sort((a, b) => {
      const aCount = a.slackCookieRows ?? -1;
      const bCount = b.slackCookieRows ?? -1;
      if (aCount !== bCount) return bCount - aCount;
      if (a.isLastUsed !== b.isLastUsed) return a.isLastUsed ? -1 : 1;
      return 0;
    });
    selected = ranked[0] ?? counts.find((entry) => entry.dir === lastUsed) ?? counts[0];
  }

  if (!selected.cookiesPath) {
    throw new CliError(`Chrome profile "${selected.dir}" has no Cookies database.`, {
      code: 'chrome_cookies_not_found',
      hint: 'Open Slack in Chrome and sign in, then retry.',
    });
  }

  if (debug) {
    process.stderr.write(`debug: Chrome source ${dataDir}, profile ${selected.dir}, Slack cookie rows: ${selected.slackCookieRows ?? 'unknown'}\n`);
  }

  return {
    dataDir,
    profile: selected.dir,
    profileDisplayName: selected.displayName,
    profileDir: selected.profileDir,
    cookiesPath: selected.cookiesPath,
    localStatePath: path.join(dataDir, 'Local State'),
    slackCookieRows: selected.slackCookieRows,
    profiles: counts.map(({ dir, displayName, isLastUsed, slackCookieRows }) => ({
      dir, displayName, isLastUsed, slackCookieRows,
    })),
  };
}

export async function snapshotCookies(sourceCookiesPath, destinationCookiesPath) {
  mkdirSync(path.dirname(destinationCookiesPath), { recursive: true, mode: 0o700 });
  rmSync(destinationCookiesPath, { force: true });
  try {
    const escaped = destinationCookiesPath.replace(/'/g, "''");
    await execFileAsync('sqlite3', [
      sourceCookiesPath,
      `.timeout 5000\n.backup '${escaped}'`,
    ], { timeout: 30000 });
    if (existsSync(destinationCookiesPath) && statSync(destinationCookiesPath).size > 0) {
      return { method: 'sqlite-backup' };
    }
  } catch {
    // Fall back to copying the database files for environments without sqlite3.
  }

  copyFileSync(sourceCookiesPath, destinationCookiesPath);
  for (const suffix of ['-journal', '-wal', '-shm']) {
    const sidecar = `${sourceCookiesPath}${suffix}`;
    if (existsSync(sidecar)) {
      try {
        copyFileSync(sidecar, `${destinationCookiesPath}${suffix}`);
      } catch {
        // Sidecars are best-effort; Chrome can usually recover the main database.
      }
    }
  }
  return { method: 'file-copy' };
}

export function chromeSourceSummary(source) {
  if (!source) return null;
  return {
    dataDir: source.dataDir,
    profile: source.profile,
    profileName: source.profileDisplayName,
  };
}
