<p align="center"><a href="https://unicorn.tuuhub.com"><img src=".github/assets/hero.jpg" alt="hku-cli: HKU Moodle, email and library spaces from the terminal" width="100%"></a></p>

# hku-cli

**Moodle, forwarded HKU mail and HKU Library spaces from one command line.**

`hku-cli` keeps the full Moodle workflow from `moodle-cli`, reads forwarded university mail from a 163 mailbox over IMAP, sends through 163 SMTP, and adds live HKU Library space availability with guarded room-booking submission. It works as `hku` without breaking the original `moodle` executable.

[![npm version](https://img.shields.io/npm/v/hku-cli?logo=npm)](https://www.npmjs.com/package/hku-cli)
[![CI](https://github.com/Neutralmilkzzz/moodle-cli-hku/actions/workflows/ci.yml/badge.svg)](https://github.com/Neutralmilkzzz/moodle-cli-hku/actions/workflows/ci.yml)
[![Node.js 22.15+](https://img.shields.io/badge/Node.js-22.15%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Bun](https://img.shields.io/badge/Bun-supported-fbf0df?logo=bun&logoColor=black)](https://bun.sh/)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> The live layer of [unicorn](https://unicorn.tuuhub.com): live tools answer what is there now, unicorn answers what changed. Docs: [unicorn.tuuhub.com/docs/moodle](https://unicorn.tuuhub.com/docs/moodle).

## Quick links

- [Build and install](#build-and-install)
- [HKU mail](#hku-mail)
- [HKU Library booking](#hku-library-booking)
- [Moodle](#moodle-commands)
- [Study Boooooooooost](#study-boooooooooost)
- [Connect web AI through a private MCP server](#remote-mcp-for-web-ai)
- [Developer and agent reference](#for-developers-and-agents)
- [Contributing](#contributing)

## Build and install

Node.js 22.15+ is required for browser-cookie access. From this repository:

```bash
npm ci
npm run build
node dist/hku.js --help
```

The package exposes both `hku` and the backward-compatible `moodle` binary. Existing Moodle commands remain available directly and under the optional `moodle` prefix:

```bash
hku units
hku moodle units
```

HKU service sessions are stored in the OS credential vault and encrypted under `~/.config/hku-cli/state/`. Session tokens and cookies are never written to the repository.

### Forwarded HKU mail

HKU mail is forwarded to a 163 mailbox. The CLI reads that mailbox over IMAPS and sends with SMTPS using the 163 authorization code, not the account password:

```bash
hku mail login --username name@163.com
hku mail inbox --today --limit 100
hku mail inbox --unread --search "library"
hku mail inbox "booking" --body
hku mail read <uid>
hku mail attachments <uid>
hku mail attachment <uid> 0 --dest ./booking.pdf
```

Send with a preview or execute it explicitly:

```bash
hku mail send --to student@connect.hku.hk --subject "Study room" --body "See you at 10." --dry-run
hku mail send --to student@connect.hku.hk --subject "Study room" --body "See you at 10." --yes
```

`--body-file` reads a multiline body from disk, `--cc` may be repeated, and `--html` sends HTML. A non-interactive send requires `--yes`. Login prompts for the authorization code without echoing it. For automation, `HKU_MAIL_USERNAME` and `HKU_MAIL_AUTH_CODE` may be supplied through the environment. Host overrides are `HKU_MAIL_IMAP_HOST`, `HKU_MAIL_IMAP_PORT`, `HKU_MAIL_SMTP_HOST`, and `HKU_MAIL_SMTP_PORT`.

### HKU Library booking

List every bookable space type with the official live availability count:

```bash
hku library facilities
hku library facilities --library "Main Library" --available
```

Sign in once through HKU SSO, inspect the form, then submit a specific official slot:

```bash
hku library login
hku library status
hku library slots --location "Chi Wah Learning Commons" --type "Study Room" --date 2026-10-19
hku library book --room "Study Room 5" --floor CPD-1 --start 23:00 --end 23:45 --dry-run
hku library book --room "Study Room 5" --floor CPD-1 --start 23:00 --end 23:45 --accept-policy --yes
hku library bookings
hku library cancel --date 2026-10-24 --start 10:00 --end 11:00 --location "Chi Wah Learning Commons" --floor CPD-1 --room "Study Room 5" --dry-run
hku library keepalive
hku library keepalive install
hku library keepalive status
```

The session is stored encrypted under `~/.config/hku-cli/state/`; ordinary `slots`, `book` and `bookings` calls reuse it. `hku library keepalive install` adds a background job that touches the saved session every 30 minutes without opening SSO. `hku library login --force` is only needed when SSO itself has expired. The CLI can resolve a room and time from live availability, or accept an official `NewBooking.aspx` URL/facility ids. It re-reads the signed-in form, verifies the date and exact session, refuses ambiguous forms, checks My Booking Record before submitting to avoid duplicates, and verifies the success page. Cancellation accepts only one exact booking record and defaults to a dry run. The live Chi Wah booking and acknowledgement-email flow have been exercised with explicit reservations.

### HKU facility booking systems

The article `2026｜如何优雅地预约校园设施` covers four distinct booking paths. The CLI keeps their rules together and provides the deepest working workflow each system exposes:

```bash
hku facilities list
hku facilities open sports

# HKUFBS campus, CYMAC and FSCAC rooms
hku facilities hkufbs login
hku facilities hkufbs resources
hku facilities hkufbs slots --date 2026-10-24 --resource 2873 --duration 60
hku facilities hkufbs book --resource 2873 --date 2026-10-24 --start 09:00 --end 10:00 --dry-run

# CSE sports facilities
hku facilities cse login
hku facilities cse status
hku facilities cse home
hku facilities cse activities
hku facilities cse slots --activity Golf::1 --date 2026-10-20
hku facilities cse book --activity Golf::1 --date 2026-10-20 --venue SHB --room SHB1 --start 07:00 --dry-run

# Library Venue, DIL and LIC Classroom application forms
hku facilities prepare library-venue --date 2027-01-15
hku facilities prepare dil --date 2027-01-15 --purpose "Workshop" --attendees 25
hku facilities prepare lic-classroom --date 2027-01-15
```

HKUFBS uses the same encrypted-session pattern as HKUL. `slots` is read-only; `book` is a dry run unless `--yes`, `--accept-policy` and the exact live numeric `--confirm` resource id are supplied. The preflight re-checks the current opening, room notice period, duration limits, required UID/contact/participant fields, approval requirements and the site's cancellation/payment warnings. It never uses a real reservation as an endpoint probe.

CSE activity and calendar queries are public and read-only. The authenticated session is used only for a real booking; both CSE and HKUFBS submissions require `--dry-run` for a preview, then exact confirmation tokens and explicit policy acceptance for execution. CSE's `activity` data distinguishes individual and group booking windows, and its calendar exposes free (`A`), booked (`B`), confirmed (`C`) and unavailable (`U`) room-slot states.

The Library Venue requires at least eight weeks; DIL and LIC Classroom require at least ten working days. `facilities prepare` calculates those dates, emits the information needed by the official Microsoft Form, and optionally opens it with `--open`. Microsoft Forms requires the user's HKU Microsoft session, so the CLI intentionally does not submit those approval forms unattended.

## Moodle commands

Moodle commands keep the original CLI contract: courses, deadlines, grades, files, forums, assignments, quizzes, downloads, sync, coverage and the private MCP server. Use `hku auth login` for the Moodle browser session and `hku units` or `hku due` for the daily workflow.

## Moodle setup

### Start with your agent

Paste this into Codex, Claude Code, OpenClaw, Hermes Agent, or another agent that can use your terminal:

```text
Can you use https://github.com/Neutralmilkzzz/moodle-cli-hku/raw/main/ONBOARDING.md to help me set up hku-cli?
```

Your agent asks for your Moodle URL and opens your university's sign-in page when needed. Finish SSO in the browser while the agent waits; it verifies your account and sets up session renewal before reading Moodle. The same onboarding can deploy a private remote MCP server through your Cloudflare account.

### Install and sign in manually

For macOS arm64 or Linux x64, install the standalone binary with its bundled runtime:

```bash
curl -fsSL https://raw.githubusercontent.com/Neutralmilkzzz/moodle-cli-hku/main/install.sh | sh
moodle doctor
```

Or use Node.js 22.15+ (for SQLite browser stores) or Bun:

```bash
# npm
npm install -g hku-cli

# Bun
bun add --global hku-cli

hku --version
```

Run without a global install:

```bash
npx hku-cli --help
bunx --bun hku-cli --help
```

Sign in and open your dashboard:

```bash
moodle auth login
moodle
```

On first use, enter your Moodle site origin, such as `https://moodle.example.edu`. `moodle-cli` validates it and saves it to `~/.config/moodle-cli/config.yaml`. If the CLI cannot find an active session, it opens your university's sign-in page and waits for you to finish.

On macOS the cookie store sits behind Full Disk Access, which is granted to your terminal application rather than to the CLI. If `moodle doctor` reports that the store cannot be opened, either grant that access and restart the terminal, or hand the cookie over once:

```bash
moodle auth login --paste
```

The prompt does not echo, and the value is kept in the encrypted session cache, so this is a one-time step. Paste whatever the browser gives you: in the developer tools' Network tab, `Copy as cURL` on any request to the site carries the cookie, as does the `MoodleSession` value from the cookie panel.

Keep the session active on macOS with `hku auth keepalive install`. On Linux, schedule `hku auth keepalive --json` every 30 minutes with cron.

GitHub Releases also provide standalone binaries for macOS arm64 and Linux x64.

### Study Boooooooooost

Ask your agent in plain language or run the matching command:

| Student request | CLI command |
| --- | --- |
| “Give me a quick Moodle dashboard.” | `moodle` |
| “What is due in the next 14 days?” | `moodle due --days 14` |
| “Show my grades and feedback for UNIT.” | `moodle grades UNIT --mode graded --include-feedback` |
| “Find forum posts about the exam in UNIT.” | `moodle forums search "exam" --course UNIT` |
| “Download the slides from this Moodle link.” | `moodle download '<Moodle URL>' --dest './slides.pdf'` |

Unit arguments accept the site's code or name, an id or URL. No code format is assumed.

```bash
moodle UNIT
moodle UNIT 7
moodle UNIT "TASK"
moodle find "week 7 slides" UNIT
moodle dl "UNIT week 7 slides" --to ./downloads
moodle grades
moodle news UNIT
```

`moodle grades [UNIT]` returns marked items. Use `--mode summary` for per-unit counts and course totals or `--mode all` to add ungraded items, with `--types assign,quiz` to filter by Moodle module type (`assignment` is accepted as `assign`). Feedback is omitted unless `--include-feedback` is set. Details return at most 20 rows across units; `--limit` and `--offset` page through the filtered results. MCP uses the same options with underscores (`include_feedback`, `include_ungraded`); `--graded-only` remains an alias for graded mode.

Ambiguous references list candidates. JSON callers receive `error.code: "ambiguous"`;
At a terminal you pick the match from a list (arrow keys, or type to filter a long one). A bare number in a section reference matches
that number in the site's section name, so 7 never matches 17.

#### Paste Moodle links directly

The CLI recognizes course, forum, assignment, quiz, resource, page, folder, and grade-report URLs:

```bash
moodle 'https://moodle.example.edu/course/view.php?id=34637'
moodle 'https://moodle.example.edu/mod/forum/discuss.php?d=9001#p9101'
moodle download 'https://moodle.example.edu/mod/resource/view.php?id=91234' --dest './Week 03/slides.pdf'
```

You can paste the same links into your agent and ask it to inspect the page, find related material, or download the file.

#### Download course files

`moodle download` (alias `dl`) saves what the web page offers:

- one activity: a resource, every file in a folder, or an assignment's attached files (brief, datasets);
- a whole section: `moodle dl "UNIT week 5"` or a section URL such as `…/course/view.php?id=34637&section=5`, including child sections the page shows inside it;
- a single `pluginfile.php` link.

With no argument at a terminal, it walks unit → section → item the way the course page does: type to filter, Escape to go back a step. `moodle dl UNIT` starts at that unit's sections. Files land in the current directory or `--to DIR` (created when missing). A file already there is skipped, so rerunning a section after Ctrl+C or a dropped connection fetches only what is missing; `--force` downloads everything again. The same document linked twice is saved once, and two different files with one name get a ` (2)` suffix. `--dest` names the file when there is exactly one. Quote URLs in zsh, whose `?` is a glob.

#### Keep units in sync

`moodle sync` keeps one folder per unit in step with Moodle: resources, folder contents and assignment attachments, laid out by section. Pages and books are saved as single HTML files with their images embedded, so they read the same offline.

```bash
moodle sync --to ~/Units              # every unit, one subfolder each
moodle sync UNIT --to ~/Units         # just one
moodle sync --dry-run                 # what would change, nothing written
```

Each unit folder holds a `.moodle-sync.json` manifest, so a rerun asks Moodle only whether each file changed and usually downloads nothing. A changed file replaces your copy only when you have not edited it; an edited copy stays put and the new version lands beside it as `name (updated YYYY-MM-DD).ext`. Files removed from Moodle are reported and kept locally, and a file you delete stays deleted until Moodle changes it. Rename or move a unit folder freely: the manifest, not the folder name, says which unit it holds.

#### Submit assignment files

`moodle submit` uploads local files into an assignment through the same pages a browser
uses, then prints the receipt Moodle shows afterwards: status, files, due date and the
time it was checked. It is the only command that writes to Moodle.

```bash
moodle submit "UNIT TASK" essay.pdf --dry-run          # plan only: limits, statement, existing files
moodle submit "UNIT TASK" essay.pdf                    # upload as a draft; refused if the assignment has no draft stage
moodle submit "UNIT TASK" --final --accept-statement   # submit the draft for grading (cannot be undone)
```

Every run plans first and asks for confirmation; `--yes` skips the prompt for scripts.
`--replace` removes the files already in the submission, `--accept-statement` agrees to
the site's submission statement when one is required, and a file that is too large or of
the wrong type is refused before anything is uploaded. Some assignments have no draft
stage, so saving the files is the submission for grading; without `--final`, `submit`
refuses those (and any assignment whose pages do not show which kind it is) before
uploading anything. The plan reports `draft_stage`. `--replace` with no files is refused
rather than emptying the submission. In a group submission the plan names the `group`:
its files are shared, so an upload or `--replace` changes everyone's submission. When every
member has to submit, the receipt lists who Moodle is still `awaiting`.

### Take a quiz (beta)

`moodle quiz` starts an attempt, saves answers and submits it, replaying the forms a browser posts. It is beta: a Moodle update can break it, and it is deliberately CLI-only, never offered over MCP.

```bash
moodle quiz start UNIT "Practice quiz"        # or a quiz id or URL; resumes an attempt in progress
moodle quiz show <attempt> <quiz> --page 2
moodle quiz answer <attempt> <quiz> 1 b         # option letter, or "a,c" for several
moodle quiz answer <attempt> <quiz> 3 --from essay.md
moodle quiz finish <attempt> <quiz>             # "Submit all and finish"; Moodle does not allow undoing this
```

Before `quiz start` asks, it names the time limit (the timer starts at once and does not pause) and how many attempts are left. A quiz that moves forward only is refused an earlier page, and `quiz show --page` asks before opening the next page, because that locks the current one. Every write shows the beta and academic-integrity notice and asks for a yes; a pipe must pass `--yes`, and `--dry-run` shows the plan. Answers you send are your own submission under your institution's rules: use it only where the quiz allows it, and check the attempt in a browser before you finish. A quiz with an access password asks for it at the terminal (not echoed, never stored); scripts pass `--password`. A quiz that requires the Safe Exam Browser cannot be taken here, because Moodle checks the browser itself. Question types without a plain choice or text input are shown but must be answered in a browser.

### Remote MCP for web AI

A private remote MCP server lets a supported web AI client use Moodle when it cannot run the local CLI. You need a Cloudflare account.

```bash
moodle mcp deploy
moodle mcp status
```

`moodle mcp deploy` validates Moodle access, deploys a Cloudflare Worker, uploads an encrypted Moodle session, verifies readiness, and installs session renewal. The guided [`ONBOARDING.md`](ONBOARDING.md) asks whether you want this after local setup and helps connect your web AI client.

The MCP `get_file` tool accepts a resource activity ID, resource URL, or `pluginfile.php` URL and returns files up to 16 MiB directly as an embedded MCP resource. The Moodle session stays inside the local server or private Worker; clients do not need to fetch an authenticated Moodle URL themselves.

The remote server is read-only. The local server (`moodle mcp serve`) also offers `submit`, which needs the files on the same machine. It defaults to `dry_run: true`, so an agent has to show the plan and run it again with `dry_run: false` to upload; `final: true` submits for grading.

### Check your site

```bash
moodle coverage
```

Moodle sites differ: some disable web services, and themes, languages and course formats change the pages the CLI reads. The page readers ask the site for its own wording of the labels they look for, so a site in another language or one that renamed a label is read the same way. `moodle coverage` signs in with your session and runs each read-only command once against your own units, printing one line per command as it finishes. Nothing is created and submitting is never exercised, but Moodle logs the pages it opens as views, as it does when you browse them, and can mark forum posts read.

A command passes only when its answer agrees with what the site states elsewhere in structured form: an activity's name and files against the unit's contents, an assignment's due date against the calendar, a forum search against a discussion the forum is known to hold. Each passing line says what it was checked against. The other outcomes are: worked through a fallback, read but not understood (`?`), contradicts the site (`≠`), failed, or skipped for lack of a sample. Only activities you can open are sampled, a transient network error is retried once, and a check that hangs times out. Stock Moodle never lets the AJAX endpoint call some of the services the CLI tries first, such as the course contents; going around those is the normal path and is not reported as a fallback. It exits with code 3 when a command fails, contradicts the site, or reads a page it does not understand.

The first line names the moodle-cli release and whether it is the latest, checked live; a failure from an old release may already be fixed, so run `moodle update` before reporting one. `moodle coverage --json > coverage.json` gives the same report as JSON, with the CLI version and runtime, the Moodle release, theme and the services the site disables. It holds counts, ids and error messages, not your name or the titles of your units, so it can be attached to an issue when your school's Moodle misbehaves.

### Update

```bash
moodle update
```

`moodle update` upgrades the package with whichever installer put it there (npm, bun, or the standalone binary replacing itself), then runs `moodle mcp deploy` when a managed Worker exists and is behind the new release. `moodle update --check` only reports versions.

It installs the exact release it just checked rather than `latest`, so a lagging registry mirror fails loudly instead of installing an older build, and an npm install goes into the prefix that holds the running copy, whichever `npm` is first on `PATH`. A standalone download has to run and report the new version before it replaces the current binary; otherwise the old one stays. After installing, the update asks the replaced install for its version and only then redeploys the Worker.

The CLI checks npm once a day in the background and prints a one-line notice on stderr when a newer release exists. A deployed Worker performs the same daily check and tells connected MCP clients through the server instructions, because the Worker ships inside the package and only redeploys from your machine. Set `MOODLE_NO_UPDATE_CHECK=1` to disable the check; it is already off under `CI`.

## For developers and agents

### Command and output contract

Inspect the full machine-readable command tree:

```bash
moodle commands --json
```

Commands support:

- `--json` or `--yaml` for structured output; `--pretty` indents JSON
- `--table` for human-readable output
- `--fields units,total` to select envelope fields
- `-o, --output FILE` to write command output or a download receipt

The CLI prints tables in an interactive terminal and JSON when stdout goes to a pipe or file. In a terminal, a command missing its unit asks for it with a picker (`moodle activities` lists your units); pipes, `--json` and agent shells get the usage error with the usage line instead. Structured errors use one JSON object on stderr:

```json
{"ok":false,"error":{"code":"auth","message":"...","hint":"..."},"exit_code":3}
```

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Network, configuration, or unexpected error |
| 2 | Usage error |
| 3 | Authentication error |
| 4 | Course, activity, forum, or discussion not found |
| 5 | Moodle rejected the request |

### Agent skill

Install the generated skill bundle:

```bash
moodle skills add

# Direct alternatives
npx skills add https://github.com/Neutralmilkzzz/moodle-cli-hku
bunx --bun skills add https://github.com/Neutralmilkzzz/moodle-cli-hku
```

[`SKILL.md`](SKILL.md) routes agents to focused setup, coursework, forum, download, and maintenance guidance under [`references/`](references/).

### MCP lifecycle and protocol

```bash
moodle mcp deploy
moodle mcp status
moodle mcp login
moodle mcp connect
moodle mcp pair
moodle mcp remove
moodle mcp serve
moodle mcp bridge
```

The default client connection uses `moodle mcp bridge`, which keeps the Bearer token out of client configuration. Use `moodle mcp connect CLIENT --mode remote` for clients that support authenticated remote MCP headers.

### Connect claude.ai

claude.ai custom connectors authenticate with OAuth, so the deployed Worker is also a single-user OAuth 2.1 authorization server. Nothing is approved until you open a pairing window from your own computer:

```bash
moodle mcp pair
```

The command prints the connector URL and a one-time pairing code that is valid for ten minutes and one approval. Add the URL as a custom connector in Claude, sign in when Claude opens the approval page, and enter the code. Claude then keeps a rotating OAuth token instead of your Bearer token, and `/authorize` refuses every request while no pairing window is open.

The approval page also offers **Sign in with Moodle**. It opens Moodle in a remote browser in your own Cloudflare account (Browser Run); signing in there as the Worker's Moodle account approves the connector without a pairing code and renews the Worker's session at the same time. Any other Moodle account is refused.

### Set up without a local browser

From a cloud sandbox or any machine without a signed-in desktop browser:

```bash
moodle mcp deploy --remote-login --yes
```

Without a terminal, Cloudflare sign-in uses the OAuth device grant: the command prints a `dash.cloudflare.com` link, you approve it in any browser, and no API token is needed (`CLOUDFLARE_API_TOKEN` still works when set). It then deploys the Worker without a Moodle session and prints a sign-in link valid for ten minutes. Open it, sign in to Moodle in the remote browser, and the Worker is claimed for that account. Then add the printed endpoint as a custom connector: in the same browser the approval page already knows you, and elsewhere **Sign in with Moodle** does the same. If the link expires first, run `moodle mcp pair` on the same machine for a new one.

Until Moodle is signed in, and whenever the session expires, the connector stays connected and its tools answer with the sign-in link instead of data. Each sign-in uses about two minutes of Browser Run time; the Cloudflare free plan allows ten minutes a day.

Where the Moodle site enables its mobile app service, the Worker needs one sign-in only: whenever it receives a session, from the CLI or from a remote sign-in, it also asks Moodle for a mobile app token, keeps it encrypted next to the session, and uses it to open a fresh session whenever the old one expires. `moodle mcp status` and `/readyz` show which path the Worker is on (`renewal: mobile_token` or `sign_in`). Sites with the mobile service off, and site administrators, stay on the sign-in link. You can revoke the token at any time under **Preferences → Security keys** in Moodle.

Version `0.7.0` supports MCP `2026-07-28`, a stateless compatibility lane for `2025-11-25`, and the `2025-06-18` and `2025-03-26` revisions that current hosted clients negotiate.

### Configuration

| Variable | Purpose |
| --- | --- |
| `MOODLE_BASE_URL` | Set the Moodle site origin without writing a config file. |
| `MOODLE_CONFIG` | Use another YAML config file. |
| `MOODLE_TOKEN` | Provide a `MoodleSession` cookie value in a non-browser environment. |
| `MOODLE_SESSION` | Compatibility alias for `MOODLE_TOKEN`. |

For local use, save `base_url` in `~/.config/moodle-cli/config.yaml`. `MOODLE_URL` remains a deprecated fallback for `MOODLE_BASE_URL`.

### Build from source

The [development guide](docs/development.md) covers the code layout, test lanes, scripts, the Moodle lab and releases.

Node.js workflow:

```bash
npm ci
npm run check
npm test
npm run build
npm run pack:check
```

Bun workflow:

```bash
bun install
bunx tsc --noEmit
bunx vitest run
bun run build
bun run pack:check
```

### Private MCP operations

Each Worker is pinned to one Moodle account. Uploads for a different account are rejected; use a separate deployment for that account. Session cookies, sesskeys and account metadata are encrypted together. Existing remote records and local caches migrate when read. Local cache encryption keys and deployment credentials require OS-protected storage (Windows also supports DPAPI); macOS/Linux no longer silently create plaintext credential files. `--no-cache` bypasses cache reads and writes.

```bash
moodle mcp clients --json
moodle mcp revoke CLIENT_ID
moodle mcp revoke --all
moodle --yes mcp deploy --rotate-token
moodle --yes mcp deploy --rotate-key
moodle --yes mcp deploy --repair
```

The initial upgrade invalidates old OAuth grants; run `moodle mcp pair` again for hosted clients. Revocation closes pending authorizations and pairing windows as well as tokens. Token rotation immediately invalidates old static credentials and OAuth grants; local bridge configurations resolve the new token automatically. Native remote header clients must receive the new token. Key rotation migrates the active encrypted record, verifies it, then removes the previous key from the active configuration.

Deployment uses Cloudflare's atomic code/secrets operation, including Durable Object migrations. An update first verifies a compatible recovery release that supports the owner's static bridge; OAuth is temporarily unavailable in recovery mode. Rollback checks session schema, encryption-key identity and credential identity. It will not activate an incompatible pre-migration version or restore revoked credentials. `--repair` reconciles the live session revision after interrupted uploads.

Pending OAuth registrations expire after ten minutes and can be reclaimed without evicting approved clients. The approved client limit is 20. Credential-bearing requests have bounded redirects and timeouts; foreign redirect destinations never receive the Moodle cookie. Worker request bodies are limited to 64 KiB. Managed deployment disables request observability by default to avoid retaining authentication form bodies or query data in logs.

## Installation footprint and removal

| Install path | Files left locally |
| --- | --- |
| Installer | `~/.local/bin/moodle`; configuration and cache after first use |
| Manual binary | The chosen executable; configuration and cache after first use |
| npm global | npm global package/bin; configuration and cache after first use |
| Bun global | Bun global package/bin; configuration and cache after first use |
| npx | npm execution cache; configuration and cache after first use |
| bunx | Bun execution cache; configuration and cache after first use |

The CLI, local MCP server and bridge do not install Wrangler. Cloudflare management
uses Wrangler on PATH, or downloads the pinned version into
`~/.config/moodle-cli/tools/wrangler@VERSION`. A binary install needs Bun or Node/npm
only when managing Cloudflare. Worker payloads are included in the binary.
Background jobs are opt-in: Moodle keepalive, HKUL keepalive and managed MCP renewal.

`moodle uninstall --dry-run` previews cleanup. `moodle uninstall` removes local jobs;
`--remote` also removes the selected Worker; `--purge` removes local configuration/cache
after deployments have been removed. Finish with `npm rm -g hku-cli`,
`bun remove -g hku-cli`, or removal of the standalone executable. Package-manager
execution caches are managed by npm/Bun themselves.

## 0.8 structured output migration

CLI JSON and MCP use compact envelopes: `units`, `unit` plus `sections`, `due`, `item`,
`grades`, `news`, `thread`, `results`, or `file`. Empty strings and lists are omitted;
`total: 0` identifies an empty result. List rows use `type`, `unit_id`, `section_id`
and `name`. Dates include ISO offsets and epoch seconds. Unit detail defaults to a
section index; pass a section for activities. `--fields` selects envelope keys.

The 11 default MCP tools are home, due, units, unit, find, item, grades, news, thread,
search_forums and file; a local server adds submit, whose `submission` envelope is the
upload receipt. Old names remain callable through 0.8 with the new envelopes;
they are deprecated and omitted from default discovery to avoid duplicate catalog cost.
The local command tree remains available, including courses as an alias for units.
The unused projects/quiet aliases were removed. `--verbose` (`-v`) prints sanitized
request paths and timing; it never logs URL queries or credentials.

Run `npm run measure:mcp` to reproduce fixture payload measurements. See
[implementation evidence](docs/plans/optimization-implementation.md) for live checks,
measurement scope and remaining budget differences.

## Contributing

Bug reports from real Moodle sites help most: run `moodle coverage --json` and attach the output. See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, and [SECURITY.md](SECURITY.md) for vulnerabilities. Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Part of unicorn

unicorn is one project in two layers. The live tools answer what is there now; unicorn answers what changed.

| Project | Layer | What it does | Repo |
| --- | --- | --- | --- |
| unicorn | Memory | A Cloudflare Worker on your own account. Reads Moodle, Ed, Canvas, Gmail and feeds every hour, remembers what each said, and tells your AI agent what changed. | [TuuHub/unicorn](https://github.com/TuuHub/unicorn) |
| **hku-cli** (you are here) | **Live** | **HKU Moodle, mail and facility booking from the terminal and MCP.** | [Neutralmilkzzz/moodle-cli-hku](https://github.com/Neutralmilkzzz/moodle-cli-hku) |
| edstem-cli | Live | Ed Discussion from the terminal and MCP: units, threads, lessons, files, posting. | [bunizao/edstem-cli](https://github.com/bunizao/edstem-cli) |
| ontrack | Live | OnTrack / Doubtfire from the terminal: units, tasks, chats, submissions. CLI only, no MCP server. | [bunizao/ontrack-cli](https://github.com/bunizao/ontrack-cli) |

The three live tools share one command contract through [@bunizao/cli-kit](https://github.com/bunizao/cli-kit).
Docs for everything: [unicorn.tuuhub.com/docs](https://unicorn.tuuhub.com/docs). This project: [unicorn.tuuhub.com/docs/moodle](https://unicorn.tuuhub.com/docs/moodle). CLIs overview: [unicorn.tuuhub.com/cli](https://unicorn.tuuhub.com/cli).

## License

[MIT](LICENSE). You may use, copy, modify and redistribute this code, including in your own and commercial projects, without asking. Keep the copyright notice and the license text with any copy or substantial portion of it. A link back to this repository is appreciated but not required.
