# slack-cli

**English** | [Tiếng Việt](README.vi.md)

A terminal CLI for Slack that reuses the login session already present in Chrome. No Slack App and no OAuth: the CLI reads the web session cookies and `xoxc-` tokens from the Chrome profile, then calls the Slack Web API directly.

This tool is for personal/internal use and runs locally; it is not published to npm. Only use it with accounts and workspaces you are authorized to access.

## Requirements

- Node.js >= 20.10 (tested with Node 26 on Linux).
- Chrome/Chromium already signed in to Slack, or use `--install-browser` to download Playwright Chromium.
- `sqlite3` CLI (optional): enables safer cookie snapshots and better Chrome profile selection. Without it, the CLI copies the Cookies database and its sidecar files directly.
- Linux/macOS/Windows have default Chrome paths, but only Linux has been thoroughly tested.

## Installation

```bash
cd slack-cli
npm install
node bin/slack-cli.js --help
```

Create a global `slack-cli` command (optional):

```bash
npm link
slack-cli --help
```

The examples below use `slack-cli`. Without `npm link`, replace it with `node bin/slack-cli.js`.

## Quick start

```bash
# 1. Import the Slack session from Chrome
slack-cli setup

# 2. List and select a workspace
slack-cli workspace list
slack-cli workspace use my-workspace

# 3. Read data
slack-cli conversations list
slack-cli conversations history general --limit 20

# 4. Send a message (DM by @username)
slack-cli messages send @alice "Hello from slack-cli"
```

`setup` will:

1. Locate the Chrome user data dir and the profile with the most Slack cookies.
2. Snapshot the cookie database into the client's own profile; the original Chrome profile is not modified.
3. Launch headless Chrome, open Slack, and read the `d` cookie and `xoxc-` tokens from `localStorage`.
4. Call `auth.test` for each workspace and save the session to `~/.config/slack-cli/clients/default/session.json` (mode `0600`).

If the import fails and the terminal is interactive, the CLI offers to open a browser for a fresh login. You can also start one explicitly:

```bash
slack-cli setup --login
slack-cli login
```

Select a specific Chrome profile:

```bash
slack-cli setup --source "$HOME/.config/google-chrome" --chrome-profile "Profile 1"
slack-cli setup --chrome-profile Default
```

Install a browser when Chrome/Chromium is not available:

```bash
slack-cli setup --install-browser
```

## How it works

- **Client** is an isolated session + browser profile stored in `~/.config/slack-cli/clients/<name>/`. A client can hold multiple workspaces.
- **Workspace** is a Slack team. Select one by ID (`T...`), domain (`my-workspace`), name, or URL. Use `-w` to select one for a single command.
- Headless Chrome is only used for import, token refresh, or login. Regular commands call the Slack Web API directly over HTTPS with the `xoxc` token + cookie header; no browser is launched.
- When Slack returns an auth error (`invalid_auth`, `token_revoked`, `not_authed`, ...), the CLI recovers automatically in this order:
  1. Refresh the token from the saved browser profile (headless).
  2. Re-import the session from the original Chrome profile if the client was created by import.
  3. Ask you to run `slack-cli auth repair --login` if that still fails.
- Disable auto-recovery with `SLACK_CLI_AUTO_REPAIR=0`.

## Clients and workspaces

```bash
slack-cli client list
slack-cli client current
slack-cli client add work --chrome-profile "Profile 2"
slack-cli client use work
slack-cli client remove work

slack-cli workspace list
slack-cli workspace current
slack-cli workspace use my-workspace
slack-cli workspace info my-workspace
```

Data commands accept these common options:

```
-c, --client <name>      client to use; defaults to the active client
-w, --workspace <ref>    workspace ID / domain / name / URL
--json                   print JSON
--debug                  print debug logs to stderr
```

Select a workspace for a single command:

```bash
slack-cli conversations list -w my-workspace
slack-cli messages send general "hello" -w other-workspace
```

Environment variables:

| Variable | Meaning |
| --- | --- |
| `SLACK_CLI_HOME` | config/session directory; defaults to `$XDG_CONFIG_HOME/slack-cli` or `~/.config/slack-cli` |
| `SLACK_CLI_CLIENT` | default client |
| `SLACK_CLI_WORKSPACE` | default workspace |
| `SLACK_CLI_CHROME_DATA` | default Chrome user data dir |
| `SLACK_CLI_CHROME_PATH` | explicit Chrome/Chromium executable path |
| `SLACK_CLI_AUTO_REPAIR` | set to `0` to disable session auto-recovery |

## Commands

### Session

```bash
slack-cli setup [--name default] [--source DIR] [--chrome-profile NAME] [--login] [--install-browser] [--timeout 60]
slack-cli login [workspaceUrl] [--fresh] [--timeout 600]
slack-cli auth status [--workspace REF]
slack-cli auth refresh [--timeout 45]
slack-cli auth repair [--login] [--timeout 60]
slack-cli status
```

- `--fresh` clears old cookies and storage before logging in.
- `auth status` exits with code `3` when the session is invalid.
- `auth repair` tries profile refresh, Chrome re-import, then login, in that order.

### Conversations / channels

```bash
slack-cli conversations list [--types public_channel,private_channel,mpim,im] [--limit 100] [--all] [--cursor CURSOR] [--include-archived]
slack-cli conversations history <channel> [--limit 20] [--oldest TS] [--latest TS]
slack-cli conversations thread <channel> <threadTs> [--limit 100] [--oldest TS] [--latest TS]
slack-cli conversations info <channel>
slack-cli conversations members <channel> [--limit 100] [--all]
slack-cli conversations open <user>
slack-cli conversations join <channel>
slack-cli conversations leave <channel> [--yes]
slack-cli conversations mark <channel> [ts]
```

`<channel>` accepts `#general`, `general`, an ID (`C...`/`D...`/`G...`), or `@user` for a DM. Aliases: `channels` for `conversations`, `msg` for `messages`.

### Messages

```bash
slack-cli messages send <channel> [text...] [--thread TS] [--broadcast] [--blocks JSON] [--attachments JSON] [--stdin]
slack-cli messages reply <channel> <threadTs> [text...] [--broadcast] [--blocks JSON] [--attachments JSON] [--stdin]
slack-cli messages edit <channel> <ts> [text...] [--blocks JSON] [--stdin]
slack-cli messages delete <channel> <ts> [--yes]
slack-cli messages react <channel> <ts> <emoji>
slack-cli messages unreact <channel> <ts> <emoji>
slack-cli messages reactions <channel> <ts>
slack-cli messages pin <channel> <ts>
slack-cli messages unpin <channel> <ts>
slack-cli messages pins <channel>
slack-cli messages permalink <channel> <ts>
slack-cli messages search <query...> [--count 20] [--sort score|timestamp]
```

- `text...` can be passed directly. If the content starts with `-` or spans multiple lines, use `--stdin`.
- `--blocks` and `--attachments` accept inline JSON, `@file`, or `-` to read from stdin.
- Emoji accepts Slack names, with or without colons: `thumbsup`, `:thumbsup:`, `white_check_mark`.
- `messages history` and `messages thread` are aliases for `conversations history` and `conversations thread`.

Examples:

```bash
slack-cli messages send general "Deployed" --thread 1792564984.010709 --broadcast
echo "multi-line content" | slack-cli messages send @alice --stdin
slack-cli messages send general --blocks @blocks.json
```

### Users

```bash
slack-cli users list [--limit 100] [--all] [--include-deleted]
slack-cli users info <user>
slack-cli users me
slack-cli users presence <user>
```

`<user>` accepts `@username`, username, display name, email, or a `U...`/`W...` ID.

### Files

```bash
slack-cli files list [--channel REF] [--user REF] [--types images,pdfs] [--limit 20] [--page 1] [--all]
slack-cli files upload <channel> <path...> [--title TITLE] [--comment TEXT] [--thread TS]
slack-cli files download <fileId> [path] [--force]
slack-cli files info <fileId>
slack-cli files delete <fileId> [--yes]
```

- `--types` accepts: `all`, `spaces`, `snippets`, `images`, `gifs`, `zips`, `pdfs`, `documents`, `spreadsheets`, `presentations`, `audio`, `videos`.
- `files download` downloads private files using the Slack session cookie. The CLI only accepts `https://*.slack.com` URLs and validates every redirect.
- Existing destination files are not overwritten by default; use `--force`.
- `files delete` is permanent; add `--yes` in non-interactive use.
- Upload multiple files in one command; `--title` only works with a single file.

### Raw API

Call any Slack Web API method. Output is always JSON:

```bash
slack-cli api conversations.list '{"types":"public_channel","limit":5}'
slack-cli api conversations.history '{"channel":"C01234567","limit":10}'
slack-cli api search.messages --body @query.json
slack-cli api chat.postMessage --param channel=C01234567 --param text="hello"
```

`--param key=value` can be repeated. Prefer the built-in commands; use this only when they don't cover your case.

### Output and exit codes

- `--json`: JSON on stdout; errors are also JSON (`{"ok":false,"error":{...}}`) on stderr.
- `--debug`: verbose logs on stderr.
- Exit codes: `0` success, `1` general/network error, `2` usage, `3` auth, `4` not found.

## Pagination and limits

| Command | Behavior |
| --- | --- |
| `conversations list` | `--limit` (max 1000) + `--cursor`, or `--all` (200/page, up to 20,000) |
| `conversations members` | `--limit` + `--all` (200/page, up to 20,000) |
| `users list` | `--limit` + `--all` (200/page, up to 20,000) |
| `files list` | `--limit`/`--page`, or `--all` (200/page, up to 20,000) |
| `conversations history` | single page, `--limit` max 1000; no `--cursor`/`--all` |
| `conversations thread` | single page, `--limit` max 1000 |
| `messages search` | single page, `--count` max 100 |

To page deeper than 1000 messages, walk backwards with `--oldest`/`--latest`, or call `api conversations.history` / `api conversations.replies` directly with a cursor.

Fetch the latest 1000 messages:

```bash
slack-cli conversations history general --limit 1000 --json > general.json
```

## Slack Free and the 90-day limit

The CLI does not archive or index messages locally. Every command calls the Slack API with your web session, so results depend on how Slack applies retention to each conversation type and endpoint. Trace results from the existing workspaces:

| Source | Messages older than 90 days | Notes |
| --- | --- | --- |
| `conversations.history` channel | Blocked | Returns `messages: []`, `is_limited: true` |
| `search.messages` within a channel | Blocked | 0 matches even for exact old text |
| `conversations.history` DM | Available | Old DM messages are still returned normally |
| `search.messages` without a channel filter | Available for DMs | `before:YYYY-MM-DD` queries return old DM messages |
| `pins.list` (`messages pins`) | Available | Old pinned messages still return full text, files, `thread_ts` |
| `conversations.replies` (`messages thread`) | Available | If you know the `thread_ts` (usually from a pin), all old replies are returned |
| `files.info` / `files download` | File-dependent | Files still within retention can be downloaded; older files return `hidden_by_limit` |
| `files.list` with an old timestamp range | Blocked | Returns `files: []` even though `paging.total` stays large |

Different API hosts (`slack.com`, `<workspace>.slack.com`, `app.slack.com`) return identical results. Therefore:

- There is no way to retrieve the **full channel history** older than 90 days once Slack blocks `conversations.history` and search. The CLI cannot work around this.
- **Old DMs** remain available through `conversations history --latest` or `messages search "before:..."`.
- **Pinned messages** and **threads on pinned messages** remain available, even older than 90 days.
- Old files are downloadable only if you know the file ID and the file has not been hidden; `files list` does not list old files.

This reflects API behavior at trace time; Slack may change it. It is not a way to fully restore history.

Examples of retrieving old data that is still accessible:

```bash
# 1. Old pins with full JSON (text, files, thread_ts)
slack-cli messages pins <channel> -w <workspace> --json > pins.json

# 2. Read an old thread using thread_ts from pins.json
slack-cli messages thread <channel> <thread_ts> -w <workspace> --limit 100

# 3. Find old DMs before the 90-day cutoff
slack-cli messages search "before:2026-07-23" -w <workspace> --count 100

# 4. Or fetch DM history with --latest
slack-cli conversations history <dm_id> --latest <epoch_seconds> --limit 100 -w <workspace>

# 5. Old files if you know the ID (from pins.json)
slack-cli files info <file_id> -w <workspace>
slack-cli files download <file_id> -w <workspace>
```

The cutoff is only an example. `search` should use `before:YYYY-MM-DD`; `--latest` uses epoch seconds.

Note: `--json` output from search/pins/DMs may contain sensitive data (passwords, tokens in messages). Protect the JSON files and do not share logs.

Suggested export for the current retention window:

```bash
mkdir -p archive
slack-cli conversations list --all --json > archive/conversations.json
slack-cli conversations history general --limit 1000 --json > archive/general-page1.json
slack-cli conversations history general --limit 1000 --latest <oldest_ts_from_previous_page> --json > archive/general-page2.json
```

The CLI has no automatic workspace-wide export; write a script around `--json` or `api` if needed.

## Security

- `session.json` contains the `xoxc-` token and session cookie (`d`), equivalent to your Slack login. The file is written with mode `0600`, client directories `0700`. Do not share, commit, or copy it to another machine unless necessary.
- The browser profile in `clients/<name>/profile` also contains cookies and storage; protect it the same way.
- The CLI only sends data to `*.slack.com`. File downloads validate the host and every redirect to prevent SSRF.
- The web `xoxc` token uses an unofficial API. Using it may violate Slack's terms, and the token may be revoked when you change your password, sign out, or an admin changes policy. Use it only with your own account and for legitimate purposes.
- Do not run multiple commands concurrently against the same client. The CLI uses a lock file at `clients/<name>/.lock`; if it gets stuck, check for a running process before deleting the lock.
- On Linux, Chrome may encrypt cookies with a keyring. During import the CLI tries both the system keyring and the basic store on a copy of the profile; if decryption fails, use `slack-cli login` or `slack-cli auth repair --login`.

## Local data layout

```
~/.config/slack-cli/
├── config.json                 # active client, metadata
└── clients/
    └── default/
        ├── session.json        # token, cookie, workspaces, user agent (0600)
        ├── .lock               # held during import/refresh/login
        └── profile/            # isolated browser profile (cookies, storage)
```

Change the location with `SLACK_CLI_HOME=/path/to/dir`.

## Troubleshooting

**`chrome_not_found` / `chrome_profile_not_found`**

Specify the source explicitly:

```bash
slack-cli setup --source "$HOME/.config/google-chrome"
slack-cli setup --source "$HOME/.config/google-chrome" --chrome-profile "Profile 1"
```

Or skip Chrome and log in directly:

```bash
slack-cli setup --login
```

**`cookie_decryption_failed`**

Unlock the current user's keyring/desktop session, close Chrome if necessary, and retry. If it still fails:

```bash
slack-cli auth repair --login
```

**`invalid_auth` / `token_revoked` / `not_authed`**

```bash
slack-cli auth status
slack-cli auth refresh
slack-cli auth repair --login
```

**`client_busy`**

Another process is using the same client. Wait for it to finish; if you are sure no process remains, delete `~/.config/slack-cli/clients/<name>/.lock`.

**No messages / empty history**

- Check that you have joined the channel, or that your account has access to the private channel.
- Check the workspace plan and retention window (see Slack Free).
- Try the correct `-w <workspace>` and `--debug` to surface auth/network errors.

**Browser does not open during login**

`login` requires a graphical session (DISPLAY/WAYLAND_DISPLAY). On a server/SSH, use `setup` to import cookies from Chrome or run login from a desktop.

## Known limitations

- No workspace-wide export/sync command and no local cache.
- `conversations history` and `thread` fetch a single page; threads with more than 1000 replies require calling the API directly with a cursor.
- `messages search` returns at most 100 results and does not paginate.
- Thoroughly tested on Linux; macOS/Windows paths exist but are not verified end-to-end.
- Depends on an unofficial web token; Slack may change the API or revoke tokens at any time.
- Slack Enterprise Grid is not fully supported (org/enterprise selection; multiple teams in one enterprise may need extra work).

## Agent skill

The agent skill for this CLI lives at `.agents/skills/slack-cli/SKILL.md`. It documents safe read/write workflows, retention caveats, and session recovery for AI agents. Invoke it as `/slack-cli`.

## Development

```bash
npm test
```

The current 41 tests cover: util/format, config + lock, session/cookie/workspace resolution, API encoding/retry/auth/upload/download.

Source layout:

```
bin/slack-cli.js    entry point
src/cli.js          all command definitions
src/session.js      import/refresh/login, session, resolver, runtime, auto-recovery
src/api.js          Slack Web API client, upload/download
src/chrome.js       Chrome detection, cookie snapshot
src/browser.js      Chrome/Chromium resolution, Playwright launch
src/config.js       config, session files, client lock
src/util.js         formatting, tables, JSON, errors
```
