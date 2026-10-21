# slack-cli

**Tiếng Việt** | [English](README.md)

CLI dùng Slack từ terminal bằng chính session đăng nhập có sẵn trong Chrome. Không cần tạo Slack App, không cần OAuth: CLI đọc cookie phiên web và token `xoxc-` từ profile Chrome, rồi gọi Slack Web API trực tiếp.

Công cụ này dùng cho mục đích cá nhân/nội bộ, chạy local, không publish lên npm. Chỉ dùng với tài khoản và workspace bạn có quyền truy cập.

## Yêu cầu

- Node.js >= 20.10 (đã test với Node 26 trên Linux).
- Chrome/Chromium đã đăng nhập Slack, hoặc dùng `--install-browser` để tải Playwright Chromium.
- `sqlite3` CLI (tùy chọn): giúp snapshot cookie an toàn và chọn đúng Chrome profile. Nếu không có, CLI copy trực tiếp file Cookies cùng các sidecar.
- Linux/macOS/Windows đều có đường dẫn mặc định cho Chrome, nhưng mới được test kỹ trên Linux.

## Cài đặt

```bash
cd slack-cli
npm install
node bin/slack-cli.js --help
```

Tạo lệnh `slack-cli` toàn cục (tùy chọn):

```bash
npm link
slack-cli --help
```

Các ví dụ bên dưới dùng `slack-cli`. Nếu chưa `npm link`, thay bằng `node bin/slack-cli.js`.

## Bắt đầu nhanh

```bash
# 1. Import session Slack từ Chrome
slack-cli setup

# 2. Xem và chọn workspace
slack-cli workspace list
slack-cli workspace use my-workspace

# 3. Đọc dữ liệu
slack-cli conversations list
slack-cli conversations history general --limit 20

# 4. Gửi tin nhắn (DM bằng @username)
slack-cli messages send @alice "Hello từ slack-cli"
```

`setup` sẽ:

1. Tìm Chrome user data dir và profile có nhiều cookie Slack nhất.
2. Snapshot database cookie sang profile riêng của client; profile Chrome gốc không bị sửa.
3. Mở Chrome headless, vào Slack, đọc cookie `d` và các token `xoxc-` trong `localStorage`.
4. Gọi `auth.test` cho từng workspace rồi lưu session vào `~/.config/slack-cli/clients/default/session.json` (mode `0600`).

Nếu import thất bại và terminal đang tương tác, CLI hỏi có mở browser để đăng nhập lại không. Có thể chủ động đăng nhập:

```bash
slack-cli setup --login
slack-cli login
```

Chọn Chrome profile cụ thể:

```bash
slack-cli setup --source "$HOME/.config/google-chrome" --chrome-profile "Profile 1"
slack-cli setup --chrome-profile Default
```

Cài browser nếu máy chưa có Chrome/Chromium:

```bash
slack-cli setup --install-browser
```

## Cách hoạt động

- **Client** là một session + browser profile riêng, lưu tại `~/.config/slack-cli/clients/<name>/`. Một client có thể chứa nhiều workspace.
- **Workspace** là một team Slack. Chọn bằng ID (`T...`), domain (`my-workspace`), tên, hoặc URL. Có thể chọn tạm cho từng lệnh bằng `-w`.
- Chrome headless chỉ được dùng khi import, refresh token hoặc login. Mỗi lệnh thông thường gọi thẳng Slack Web API qua HTTPS với token `xoxc` + header cookie, không mở browser.
- Khi Slack trả lỗi auth (`invalid_auth`, `token_revoked`, `not_authed`...), CLI tự phục hồi theo thứ tự:
  1. Refresh token từ browser profile đã lưu (headless).
  2. Re-import session từ Chrome gốc nếu client được tạo bằng import.
  3. Báo bạn chạy `slack-cli auth repair --login` nếu vẫn thất bại.
- Tắt tự phục hồi bằng `SLACK_CLI_AUTO_REPAIR=0`.

## Client và workspace

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

Các lệnh thao tác dữ liệu nhận các option chung:

```
-c, --client <name>      client sử dụng; mặc định là client đang active
-w, --workspace <ref>    workspace ID / domain / tên / URL
--json                   in JSON
--debug                  in log debug ra stderr
```

Ví dụ chọn workspace chỉ cho một lệnh:

```bash
slack-cli conversations list -w my-workspace
slack-cli messages send general "hello" -w other-workspace
```

Biến môi trường:

| Biến | Ý nghĩa |
| --- | --- |
| `SLACK_CLI_HOME` | thư mục config/session; mặc định `$XDG_CONFIG_HOME/slack-cli` hoặc `~/.config/slack-cli` |
| `SLACK_CLI_CLIENT` | client mặc định |
| `SLACK_CLI_WORKSPACE` | workspace mặc định |
| `SLACK_CLI_CHROME_DATA` | Chrome user data dir mặc định |
| `SLACK_CLI_CHROME_PATH` | đường dẫn Chrome/Chromium thủ công |
| `SLACK_CLI_AUTO_REPAIR` | đặt `0` để tắt tự phục hồi session |

## Lệnh

### Session

```bash
slack-cli setup [--name default] [--source DIR] [--chrome-profile NAME] [--login] [--install-browser] [--timeout 60]
slack-cli login [workspaceUrl] [--fresh] [--timeout 600]
slack-cli auth status [--workspace REF]
slack-cli auth refresh [--timeout 45]
slack-cli auth repair [--login] [--timeout 60]
slack-cli status
```

- `--fresh` xóa cookie và storage cũ trước khi đăng nhập.
- `auth status` trả exit code `3` nếu session không hợp lệ.
- `auth repair` lần lượt thử refresh profile, re-import Chrome, rồi login.

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

`<channel>` nhận `#general`, `general`, ID `C...`/`D...`/`G...`, hoặc `@user` cho DM. Alias: `channels` cho `conversations`, `msg` cho `messages`.

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

- `text...` có thể viết trực tiếp. Nếu nội dung bắt đầu bằng `-` hoặc có nhiều dòng, dùng `--stdin`.
- `--blocks` và `--attachments` nhận JSON trực tiếp, `@file`, hoặc `-` để đọc từ stdin.
- Emoji nhận tên Slack, có hoặc không có dấu hai chấm: `thumbsup`, `:thumbsup:`, `white_check_mark`.
- `messages history` và `messages thread` là alias của `conversations history` và `conversations thread`.

Ví dụ:

```bash
slack-cli messages send general "Deploy xong" --thread 1792564984.010709 --broadcast
echo "nội dung nhiều dòng" | slack-cli messages send @alice --stdin
slack-cli messages send general --blocks @blocks.json
```

### Users

```bash
slack-cli users list [--limit 100] [--all] [--include-deleted]
slack-cli users info <user>
slack-cli users me
slack-cli users presence <user>
```

`<user>` nhận `@username`, username, display name, email, hoặc ID `U...`/`W...`.

### Files

```bash
slack-cli files list [--channel REF] [--user REF] [--types images,pdfs] [--limit 20] [--page 1] [--all]
slack-cli files upload <channel> <path...> [--title TITLE] [--comment TEXT] [--thread TS]
slack-cli files download <fileId> [path] [--force]
slack-cli files info <fileId>
slack-cli files delete <fileId> [--yes]
```

- `--types` nhận: `all`, `spaces`, `snippets`, `images`, `gifs`, `zips`, `pdfs`, `documents`, `spreadsheets`, `presentations`, `audio`, `videos`.
- `files download` tải file private bằng cookie phiên Slack. CLI chỉ chấp nhận URL `https://*.slack.com` và kiểm tra cả từng redirect.
- Mặc định không ghi đè file đích; dùng `--force`.
- `files delete` xóa vĩnh viễn; thêm `--yes` khi chạy non-interactive.
- Upload nhiều file trong một lệnh; `--title` chỉ dùng được với một file.

### Raw API

Gọi bất kỳ method Slack Web API nào. Output luôn là JSON:

```bash
slack-cli api conversations.list '{"types":"public_channel","limit":5}'
slack-cli api conversations.history '{"channel":"C01234567","limit":10}'
slack-cli api search.messages --body @query.json
slack-cli api chat.postMessage --param channel=C01234567 --param text="hello"
```

`--param key=value` có thể lặp lại. Chỉ nên dùng khi lệnh có sẵn chưa đáp ứng nhu cầu.

### Output và exit code

- `--json`: JSON ra stdout; lỗi cũng ở dạng JSON (`{"ok":false,"error":{...}}`) ra stderr.
- `--debug`: log chi tiết ra stderr.
- Exit code: `0` thành công, `1` lỗi chung/network, `2` usage, `3` auth, `4` not found.

## Phân trang và giới hạn

| Lệnh | Hành vi |
| --- | --- |
| `conversations list` | `--limit` (max 1000) + `--cursor`, hoặc `--all` (200/trang, tối đa 20.000) |
| `conversations members` | `--limit` + `--all` (200/trang, tối đa 20.000) |
| `users list` | `--limit` + `--all` (200/trang, tối đa 20.000) |
| `files list` | `--limit`/`--page`, hoặc `--all` (200/trang, tối đa 20.000) |
| `conversations history` | một trang, `--limit` max 1000; không có `--cursor`/`--all` |
| `conversations thread` | một trang, `--limit` max 1000 |
| `messages search` | một trang, `--count` max 100 |

Khi cần lấy sâu hơn 1000 tin nhắn, dùng `--oldest`/`--latest` để lùi dần, hoặc gọi thẳng `api conversations.history` / `api conversations.replies` với cursor.

Ví dụ lấy 1000 tin gần nhất:

```bash
slack-cli conversations history general --limit 1000 --json > general.json
```

## Slack Free và giới hạn 90 ngày

CLI không lưu trữ hay lập chỉ mục tin nhắn local. Mỗi lệnh gọi Slack API bằng đúng session web của bạn, nên dữ liệu nhận được phụ thuộc vào cách Slack áp dụng retention cho từng loại conversation và endpoint. Kết quả trace trên các workspace hiện có:

| Nguồn | Tin cũ hơn 90 ngày | Ghi chú |
| --- | --- | --- |
| `conversations.history` channel | Bị chặn | Trả `messages: []`, `is_limited: true` |
| `search.messages` trong channel | Bị chặn | 0 match dù query đúng text cũ |
| `conversations.history` DM | Đọc được | Tin DM cũ vẫn trả bình thường |
| `search.messages` không giới hạn channel | Đọc được với DM | Query `before:YYYY-MM-DD` trả tin DM cũ |
| `pins.list` (`messages pins`) | Đọc được | Tin pin cũ vẫn trả full text, files, `thread_ts` |
| `conversations.replies` (`messages thread`) | Đọc được | Nếu biết `thread_ts` (thường lấy từ pin), trả toàn bộ reply cũ |
| `files.info` / `files download` | Tùy file | File còn trong hạn lưu trữ thì tải được; file quá cũ trả `hidden_by_limit` |
| `files.list` với mốc thời gian cũ | Bị chặn | Trả `files: []` dù `paging.total` vẫn lớn |

Các host API khác nhau (`slack.com`, `<workspace>.slack.com`, `app.slack.com`) cho kết quả giống nhau. Vì vậy:

- Không có cách lấy **toàn bộ lịch sử channel** cũ hơn 90 ngày khi Slack đã chặn `conversations.history` và search. CLI không thể vượt giới hạn này.
- Vẫn lấy được **DM cũ** qua `conversations history --latest` hoặc `messages search "before:..."`.
- Vẫn lấy được **tin đã pin** và **thread của tin pin**, kể cả cũ hơn 90 ngày.
- File cũ chỉ tải được nếu biết file ID và file chưa bị ẩn; `files list` không liệt kê file cũ.

Đây là hành vi API tại thời điểm trace; Slack có thể thay đổi. Không phải cách khôi phục đầy đủ lịch sử.

Ví dụ lấy dữ liệu cũ còn truy cập được:

```bash
# 1. Pin cũ kèm full JSON (text, files, thread_ts)
slack-cli messages pins <channel> -w <workspace> --json > pins.json

# 2. Đọc thread cũ bằng thread_ts lấy từ pins.json
slack-cli messages thread <channel> <thread_ts> -w <workspace> --limit 100

# 3. Tìm DM cũ trước mốc 90 ngày
slack-cli messages search "before:2026-07-23" -w <workspace> --count 100

# 4. Hoặc lấy history DM với --latest
slack-cli conversations history <dm_id> --latest <epoch_seconds> --limit 100 -w <workspace>

# 5. File cũ nếu biết ID (lấy từ pins.json)
slack-cli files info <file_id> -w <workspace>
slack-cli files download <file_id> -w <workspace>
```

Mốc thời gian chỉ là ví dụ. `search` nên dùng `before:YYYY-MM-DD`; `--latest` dùng epoch seconds.

Lưu ý: output `--json` của search/pins/DM có thể chứa dữ liệu nhạy cảm (mật khẩu, token trong tin nhắn). Bảo vệ file JSON và không chia sẻ log.

Gợi ý export trong window hiện tại cho channel:

```bash
mkdir -p archive
slack-cli conversations list --all --json > archive/conversations.json
slack-cli conversations history general --limit 1000 --json > archive/general-page1.json
slack-cli conversations history general --limit 1000 --latest <oldest_ts_cua_trang_truoc> --json > archive/general-page2.json
```

CLI chưa có lệnh export tự động quét toàn bộ workspace; có thể viết script quanh `--json` hoặc `api` nếu cần.

## Bảo mật

- `session.json` chứa token `xoxc-` và cookie phiên (`d`), tương đương quyền đăng nhập Slack của bạn. File được ghi với mode `0600`, thư mục client `0700`. Không chia sẻ, không commit, không copy sang máy khác nếu không cần.
- Browser profile trong `clients/<name>/profile` cũng chứa cookie và storage; bảo vệ tương tự.
- CLI không gửi dữ liệu tới server nào khác ngoài `*.slack.com`. Download file kiểm tra host và redirect để tránh SSRF.
- Token web `xoxc` là API không chính thức. Việc sử dụng có thể vi phạm điều khoản của Slack và token có thể bị thu hồi khi đổi mật khẩu, đăng xuất hoặc admin thay đổi chính sách. Chỉ dùng cho tài khoản của bạn và mục đích hợp pháp.
- Không chạy đồng thời nhiều lệnh trên cùng một client. CLI dùng lock file tại `clients/<name>/.lock`; nếu bị kẹt, kiểm tra process trước khi xóa lock.
- Trên Linux, Chrome có thể mã hóa cookie bằng keyring. Khi import, CLI thử lần lượt chế độ system keyring và basic store trên một bản copy profile; nếu không giải mã được, dùng `slack-cli login` hoặc `slack-cli auth repair --login`.

## Cấu trúc dữ liệu local

```
~/.config/slack-cli/
├── config.json                 # client active, metadata
└── clients/
    └── default/
        ├── session.json        # token, cookie, workspace, user agent (0600)
        ├── .lock               # khóa khi import/refresh/login
        └── profile/            # browser profile riêng (cookie, storage)
```

Đổi vị trí lưu bằng `SLACK_CLI_HOME=/path/to/dir`.

## Troubleshooting

**`chrome_not_found` / `chrome_profile_not_found`**

Chỉ định nguồn thủ công:

```bash
slack-cli setup --source "$HOME/.config/google-chrome"
slack-cli setup --source "$HOME/.config/google-chrome" --chrome-profile "Profile 1"
```

Hoặc bỏ qua Chrome và đăng nhập trực tiếp:

```bash
slack-cli setup --login
```

**`cookie_decryption_failed`**

Mở khóa keyring/desktop session của user hiện tại, đóng Chrome nếu cần rồi thử lại. Nếu vẫn lỗi:

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

Một process khác đang dùng cùng client. Chờ lệnh kia xong; nếu chắc chắn không còn process, xóa `~/.config/slack-cli/clients/<name>/.lock`.

**Không thấy tin nhắn / history rỗng**

- Kiểm tra đã join channel chưa, hoặc channel là private mà tài khoản không có quyền.
- Kiểm tra workspace/plan và cửa sổ retention (xem mục Slack Free).
- Thử `-w <workspace>` đúng workspace và `--debug` để xem lỗi auth/network.

**Không mở được browser khi login**

`login` cần graphical session (DISPLAY/WAYLAND_DISPLAY). Trên server/SSH, dùng `setup` để import cookie từ Chrome hoặc chạy login từ desktop.

## Giới hạn đã biết

- Chưa có lệnh export/sync toàn bộ workspace, chưa có cache local.
- `conversations history` và `thread` chỉ lấy một trang; thread quá 1000 reply cần gọi API trực tiếp với cursor.
- `messages search` tối đa 100 kết quả, không phân trang.
- Đã test kỹ trên Linux; macOS/Windows mới có đường dẫn mặc định, chưa kiểm chứng end-to-end.
- Phụ thuộc vào token web không chính thức; Slack có thể thay đổi API hoặc thu hồi token bất kỳ lúc nào.
- Không hỗ trợ Slack Enterprise Grid đầy đủ (chọn org/enterprise, nhiều team trong một enterprise có thể cần kiểm tra thêm).

## Skill cho agent

Skill cho CLI nằm tại `.agents/skills/slack-cli/SKILL.md`, mô tả workflow đọc/ghi an toàn, giới hạn retention và cách phục hồi session cho AI agent. Gọi bằng `/slack-cli`.

## Phát triển

```bash
npm test
```

41 test hiện có cover: util/format, config + lock, session/cookie/workspace resolution, API encoding/retry/auth/upload/download.

Cấu trúc mã nguồn:

```
bin/slack-cli.js    entry point
src/cli.js          định nghĩa toàn bộ command
src/session.js      import/refresh/login, session, resolver, runtime, auto-recovery
src/api.js          Slack Web API client, upload/download
src/chrome.js       phát hiện Chrome, snapshot cookie
src/browser.js      tìm Chrome/Chromium, launch Playwright
src/config.js       config, session file, client lock
src/util.js         format, table, JSON, error
```
