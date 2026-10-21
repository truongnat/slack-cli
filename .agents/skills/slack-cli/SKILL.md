---
name: slack-cli
description: Use the local slack-cli (Slack Web API via an imported Chrome web session) to inspect workspaces and channels, read/search/paginate messages and threads, send or edit messages, manage reactions and pins, list/upload/download files, and call raw Slack API methods. Trigger when a request involves Slack data or Slack actions such as listing channels, reading history, searching old messages, sending a DM, or repairing an expired Slack session.
---

# slack-cli

## Overview

`slack-cli` calls the Slack Web API using the user's existing Chrome login session (`xoxc-` token + `d` cookie). It does not use a Slack App or OAuth. The tool is local-only and must never be published.

Full docs: `README.md` (English) and `README.vi.md` (Vietnamese) in the repository root.

## Before running commands

The CLI may be linked globally, otherwise run it from the repository:

```bash
command -v slack-cli || echo "fallback: node bin/slack-cli.js"
slack-cli auth status
slack-cli workspace current
```

If `auth status` fails, see **Session repair** below. Do not start with `setup` unless the user asked to import/configure a session.

## Safety rules

- Never send, edit, delete, react, pin, join, leave, or delete files unless the user explicitly requested that exact action and target. Confirm the workspace, channel/user, thread, and content when any is ambiguous.
- Use `--json` for machine-readable output. Slack search/pins/DM output may contain passwords, tokens, or other secrets: write it to a file instead of dumping it into chat, and never commit it.
- Never print or copy `session.json`, cookies, `xoxc` tokens, or browser profile contents.
- Do not run commands concurrently against the same client; the CLI holds `clients/<name>/.lock`. If you hit `client_busy`, wait for the other process instead of deleting the lock.
- Use `--yes` only when the user explicitly authorized a destructive action and the command is non-interactive.
- Do not delete `.lock` unless you verified no CLI/browser process is running.
- Do not publish to npm or share data outside the user's machine.

## Common options

| Option | Meaning |
| --- | --- |
| `-c, --client <name>` | select a client (defaults to active) |
| `-w, --workspace <ref>` | select a workspace for one command (ID, domain, name, URL) |
| `--json` | JSON on stdout; errors as JSON on stderr |
| `--debug` | debug logs on stderr |
| `--yes` | skip a destructive-action confirmation |

Exit codes: `0` success, `1` general/network, `2` usage, `3` auth, `4` not found. A non-zero exit with `auth` means run `auth status`.

## Read workflows

### Workspaces and channels

```bash
slack-cli workspace list
slack-cli workspace info <workspace>
slack-cli conversations list --all
slack-cli conversations list --types public_channel,private_channel,im --limit 200
slack-cli conversations info <channel>
slack-cli conversations members <channel> --all
```

`<channel>` accepts `#general`, `general`, an ID (`C...`/`D...`/`G...`), or `@user` for a DM. Resolve names before writing if multiple workspaces could match.

### Messages, threads, search

```bash
slack-cli conversations history <channel> --limit 100
slack-cli conversations history <channel> --latest <epoch_seconds> --limit 100
slack-cli conversations thread <channel> <thread_ts> --limit 1000
slack-cli messages search "query" --count 100
slack-cli messages search "before:2026-07-23" --count 100
slack-cli messages pins <channel>
slack-cli messages permalink <channel> <ts>
```

- `history` and `thread` return a single page. Walk backwards with `--oldest`/`--latest`; for deeper pagination call `api conversations.history` or `api conversations.replies` with a cursor.
- `search` returns at most 100 results, one page. Use date-only `before:YYYY-MM-DD`; full ISO timestamps can return zero matches.
- For old data (Slack Free retention), see **Retention** below.

### Users

```bash
slack-cli users me
slack-cli users info @username
slack-cli users list --all
```

### Files

```bash
slack-cli files list --channel <channel> --all
slack-cli files info <fileId>
slack-cli files download <fileId> [path] --force
```

Downloads use the session cookie and only accept `https://*.slack.com` URLs. Do not overwrite an existing path without explicit permission (`--force`). Old files can return `hidden_by_limit`.

## Write workflows

Only after explicit user approval:

```bash
slack-cli messages send <channel> "text"
slack-cli messages send @user "text"
slack-cli messages reply <channel> <thread_ts> "text" [--broadcast]
slack-cli messages edit <channel> <ts> "text"
slack-cli messages delete <channel> <ts> --yes
slack-cli messages react <channel> <ts> thumbsup
slack-cli messages unreact <channel> <ts> thumbsup
slack-cli messages pin <channel> <ts>
slack-cli files upload <channel> <path...> [--comment "text"] [--thread <ts>]
slack-cli files delete <fileId> --yes
```

- Multi-line or leading `-` text: pipe via `--stdin`.
- `--blocks`/`--attachments` accept inline JSON, `@file`, or `-` (stdin).
- Re-read the command output to confirm `ok: true` and the returned `ts` before reporting success.

## Raw API

Use only when a built-in command does not cover the need:

```bash
slack-cli api conversations.list '{"types":"public_channel","limit":5}'
slack-cli api conversations.history '{"channel":"C01234567","limit":10}'
slack-cli api chat.postMessage --param channel=C01234567 --param text="hello"
```

Some endpoints reject web `xoxc` tokens (`reactions.list`, `team.preferences.list`, `team.billableInfo` return `not_allowed_token_type`). Prefer built-in commands.

## Session repair

Run only when auth fails or the user asks:

```bash
slack-cli auth status
slack-cli auth refresh
slack-cli auth repair
slack-cli auth repair --login   # opens a browser; needs a graphical session
```

Initial import: `slack-cli setup` (optionally `--chrome-profile`, `--source`, `--install-browser`). The original Chrome profile is not modified; the session is stored at `~/.config/slack-cli/clients/<name>/session.json` with mode `0600`.

Environment variables: `SLACK_CLI_HOME`, `SLACK_CLI_CLIENT`, `SLACK_CLI_WORKSPACE`, `SLACK_CLI_CHROME_DATA`, `SLACK_CLI_CHROME_PATH`, `SLACK_CLI_AUTO_REPAIR=0` (disable auto-recovery).

## Retention (Slack Free, 90 days)

The CLI has no local archive or index. With a free workspace, messages older than 90 days:

- Channel `conversations.history` and channel search are blocked (`messages: []`, `is_limited: true`, 0 search matches). There is no CLI workaround.
- DMs remain readable via `conversations history --latest` or `messages search "before:YYYY-MM-DD"`.
- Pinned messages (`messages pins`) and replies on pinned threads (`messages thread <channel> <thread_ts>`) remain readable.
- Old files are downloadable only when the file ID is known and the file is not `hidden_by_limit`; `files list` does not show old files.

Do not promise a full history export. Suggest the pin/DM workflow documented in the README.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| `invalid_auth`, `token_revoked`, `not_authed` | `auth status` → `auth refresh` → `auth repair --login` |
| `client_busy` | wait for the other process; verify before removing `.lock` |
| `chrome_not_found`, `chrome_profile_not_found` | `setup --source ... --chrome-profile ...` or `setup --login` |
| `cookie_decryption_failed` | unlock keyring/desktop session, then `auth repair --login` |
| Empty channel history | check membership/private access, workspace, and retention window |
| Browser does not open on login | needs DISPLAY/WAYLAND_DISPLAY; use `setup` on a desktop or import cookies |
