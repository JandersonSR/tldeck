# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/). Versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added
- **Send to agents:** a paper-plane button on My queue issues and on Activity post-its sends the item to the agents with your instruction. Haiku triage without tools (repository, kind, risk, priority, acceptance criteria, or a question back to you), a priority queue and a dispatcher that starts the usual task flow when a slot is free. Only what you sent runs (`deck_agent_requests`). Optional plan auto-approval for low-risk, non-production work. Activities move to *Doing* and get the PR link. New `AGENT_MODEL_TRIAGE`, `AGENT_MODEL_TASK_HIGH`, `DISPATCH_INTERVAL_SEC`.
- **Kit mode:** task runs load the uxtech-kit `claude/CLAUDE.md` and `claude/agents/*.md` subagents (`--append-system-prompt`, `--agents`) while staying isolated (`AGENT_KIT_MODE`).
- **Alerts everywhere:** one alert hub for agents and activities with a native desktop notification on the machine running the deck (Windows toast, macOS, Linux; works with the browser closed; `AGENT_BOARD_DESKTOP`, `AGENT_BOARD_TOAST_APPID`), ntfy on the phone and the screen (`GET /api/alerts`), with quiet hours and de-duplication. *Settings → Notifications* shows the channels and sends a test.
- **Activities** (`G W`): your week as post-its, one column per day (Mon–Sun), with the open ones from earlier weeks on top. Each activity has a date, optional start time, optional deadline in hours (e.g. done within 4 h, counted from the start time or from *Start*), priority, color and notes. Priority activities get 2 reminders the day before and one every hour on the date (and after it, while overdue) until marked done; a deadline in hours alerts when it runs out. Reminders show as a toast and a desktop notification, and go to the ntfy topic when `AGENT_BOARD_NTFY` is set (`ACTIVITY_NOTIFY_HOURS` sets the hours). Stored in `deck_activities`.
- **Share on the deploy panel:** in PRs and deploys, *Show on the deploy panel* marks an issue (and its PRs) so the shared `pr-deploy-panel` shows it next to its own issues, read-only and kept up to date by the deck. New *On the deploy panel* tab.
- **Slack** as the team chat, instead of Discord: daily, blockers and mentions (thread answers count as answered). One chat at a time (`CHAT_PROVIDER`).
- **Jira Cloud and Linear**, read-only: issues assigned to you in your queue, and PRs that mention an issue key grouped under that issue in PRs and deploys, with its title, state and deploy date (a Jira date field or Linear's due date). Track an issue by key or link.
- Chat and trackers are adapters (`sources/chat.ts`, `sources/trackers.ts`); GitHub Issues and Projects keep working as before.
- **Issabel/Asterisk on Infra:** a read-only collector for the PBX (`integrations/issabel-monitor`: Python standard library, systemd, runs as `asterisk`) checks the Asterisk service; recordings saved vs lost (MixMonitor `Cannot open` errors and answered calls in the CDR whose file is missing or empty, with the success rate of the last hour); calls coming in and going out (answered, not answered, busy, failed, and no inbound calls in business hours); trunks and extensions (AMI, read-only); server CPU and memory; disk space and inodes of each partition; MySQL/MariaDB health (service, response time, last CDR) and astdb locks; write permission on today's recordings folder; log errors; the CLI socket and the `asterisk_perm` audit events. The new `issabel` provider (`ISSABEL_URL`, `ISSABEL_TOKEN`, `ISSABEL_NAME`) shows one card per area with each item; critical items open the automatic incident, and a silent collector is itself critical. `--simulate` reproduces the 26/11 recording failure in `/tmp`.

### Fixed
- **Infra / DigitalOcean rate limit:** the provider follows the `ratelimit-*` headers. After a 429, or with fewer than 150 requests left in the hour, it stops calling until the reset and the Infra screen keeps the last reading with a warning instead of the error. It reads less: droplet metrics every 5 min (was every poll), app health every 2 min (was 1), lists at most once a minute. With many droplets/apps, every interval stretches to stay within ~1,500 requests/hour (4× slower when the token is almost out because of other users).
- Slack, Linear and Jira tokens are masked like the other secrets.
- **Infra filters:** one tab per active provider (with its resource count and read health), filter by name, state (several at once) and kind, and sort by state, name, CPU or memory. Alerts and the timeline follow the chosen provider.
- **What runs each app:** Heroku dynos per process type (how many are up, size) and DigitalOcean App Platform components (instance size and count).
- **Agents by tool:** Claude Code and Cursor apart (All · Claude Code · Cursor, with counts) on the board and the task view. The demo has a Cursor session too.
- **Queue screen** (`G Q`): tickets, bugs, fixes, tasks and other items assigned to you or mentioning you, one tab per type in priority order, with filters by text, origin and unanswered mentions, three sort orders, and *Open incident* on any issue. *My queue* on Today links to it (*See all*).
- **DigitalOcean app CPU and memory** (with `monitoring:read`), read at most every 5 minutes; without the scope the provider shows *partial* and the cards show sizes instead.

### Changed
- DigitalOcean deployments are fetched again only when an app's deploy changes (fewer requests against the 5,000/hour limit).
- **Code and data in English.** Comments, test names, log and error messages, agent prompts and the interface's source texts are now in English; the Portuguese interface comes from `i18n-pt.ts`. Fixed server errors are still shown in Portuguese when that is the language chosen.
- **Collections renamed** from `painel_*` to `deck_*` (`painel_sessoes` → `deck_runs`, `painel_avaliacoes` → `deck_evals`, …). The first start renames them in place, in SQLite and MongoDB; nothing is copied or lost. If both an old and a new collection hold data, the old one is left untouched and a warning is logged.
- **`CONTENT_LANG`** (`en` by default, or `pt-BR`) sets the language of what the deck writes by itself: agent answers, the PENDING review and draft PR bodies, alert titles and incident timelines. It replaces `INFRA_LANG`, which is still accepted. The CI pre-review defaults to English too (`language: pt-BR` to keep Portuguese).
- Review prompt version `r2` and task prompt version `t2` (precision and recall are measured per version).

### Added
- **Infra in real time:** DigitalOcean, Heroku, Azure and Grafana read with read-only tokens. Resource status with CPU and memory history, firing alerts (sustained thresholds plus provider alerts), the deploy that may have caused each alert, and a timeline of status changes, alerts and deploys.
- **Incident from an alert:** critical production alerts open a SEV2 incident (at most 5 per hour, can be turned off) and are marked mitigated when the alert clears; any alert becomes an incident in one click.
- **DORA with real deploys:** production deploys from the providers drive deploy frequency, and time to restore counts until mitigation.
- Infra items in the Attention block and an Infra check in Settings.
- **"In production" deploy status:** a PR merged into a production branch (`DEPLOY_PROD_BRANCHES`, default `production,production-*`) becomes *In production*; an issue with every PR delivered and at least one in production does too. *Merged* and *In production* can also be set by hand. A card in production leaves automatic tracking (setting it back to automatic resumes it).

### Fixed
- **Cursor on Windows:** sessions never showed up. Cursor runs hooks through Windows PowerShell 5.1, which puts a UTF-8 BOM in front of stdin (the JSON failed to parse and the hook quit silently) and reads the UTF-8 payload as Windows-1252 (accents arrived as `Ã©`). Both are undone in `lib/encoding.js`; the `/C:/…` workspace path is normalized too.
- **DigitalOcean with a custom-scope token:** a part the token cannot read (e.g. droplets with an `app:read`-only token) no longer fails the whole provider. The rest is read and the provider shows *partial* with the missing scope; it only fails when nothing is readable.

## [0.4.0] - 2026-11-16

### Changed
- **New name: TLDeck** (formerly Agent Board). Environment variables, the data folder and the request header keep the old names for compatibility.
- README rewritten around the problem, a one-minute demo and a "Why not X?" comparison.
- Node.js 22.13 or newer is required (Node 20 reached end of life).

### Added
- **Local SQLite storage by default**; MongoDB becomes optional (`MONGO_URI`).
- **Demo mode** (`npm run demo`): the whole board with fictitious data in English or Portuguese, no integration needed.
- **Background sessions** from Claude Code's agent view (`claude agents`): state, logs, attach command and stop.
- **Staff view:** DORA metrics, incidents with blameless postmortems, team decisions, knowledge concentration (bus factor), product stages with critical path, and a fixed evaluation set measuring what the AI review misses.
- Integration tests on a real database (SQLite always, MongoDB in CI), SQLite × MongoDB parity tests and Playwright end-to-end tests.
- LICENSE, CONTRIBUTING, SECURITY, ROADMAP, issue and pull request templates.

## [0.3.0] - 2026-11-16

### Added
- AI review quality (keep/discard findings, precision per prompt version), team flow metrics, end-to-end tasks from issue to draft PR, CI and an opt-in reusable AI pre-review workflow.
- Interface and README in English and Portuguese.
- Filters by person, team and repository.

## [0.2.0]

### Added
- TypeScript monorepo (Fastify + React): team daily, blockers, queue, pending reviews, PR and deploy tracking, background PR reviews by Claude.

## [0.1.0]

### Added
- Local board for Claude Code and Cursor sessions through hooks (single-file JavaScript server).

[Unreleased]: https://github.com/JandersonSR/tldeck/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/JandersonSR/tldeck/releases/tag/v0.4.0
