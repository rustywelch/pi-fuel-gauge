# pi-fuel-gauge

Four extensions for the [pi coding agent](https://pi.dev).

## Install

```bash
pi install npm:@rustywelch/pi-fuel-gauge
```

Pin a version with `@1.4.0`. Try it for one session without installing:

```bash
pi -e npm:@rustywelch/pi-fuel-gauge
```

## context-awareness

Pi shows context usage in its footer, but the model never sees it. This extension tells the model how
full its context window is on every request, and lets it compact itself at a sensible moment.

- **A context note on every model request**, including each step of a multi-tool run: tokens used,
  window size, percent, and the distance to Pi's auto-compaction (read from your compaction settings,
  including per-model overrides). The note is added only to the request and never saved to the session,
  so it does not fill the transcript or break prompt caching.
- **Compaction thresholds.** At 75%, the note prepares for compaction with targeted reads and saved
  findings. At 80%, it requires immediate compaction before another tool call, even when the current
  task is unfinished. This leaves enough context for the model to summarize the session reliably.
- **Self-compaction.** From 75% full, the note suggests compacting at a clean boundary: task finished,
  tests green, notes saved. At the 80% hard limit, unfinished state goes into `keep` and the immediate
  continuation goes into `next_step`. The `compact_now` tool queues Pi's own compaction, ends the turn,
  and sends one automatic resume message when compaction finishes, so the model continues on its own.
- **Resume verification.** Before compaction it records the working directory, Git branch, HEAD,
  upstream tracking ref, and dirty paths. The automatic resume labels that checkpoint as historical
  and requires fresh verification of Git plus task-critical permissions, CI, deployments, and APIs
  before the model edits or writes anything.
- **Guards:** no compaction below 75% full, except that the 80% hard limit overrides the configured
  minimum and cooldown; at most five automatic resumes per session, and no resume if compaction fails.
- **Extras:** a `context_status` tool, a `/context-note` command that shows the note the model will see
  next, and `/compact-now` to run the same focused compaction yourself without the automatic resume.

Set `PI_COMPACT_MIN_PERCENT=0` to test self-compaction in a short session.

## search

Pi ships with read, bash, edit, and write, so every search costs a shell round trip. This adds one
`search` tool with two modes: `content` greps for a pattern inside files, and `files` lists files that
match a name glob. It uses ripgrep when it is installed and falls back to grep and find otherwise.

## computer-use

One `computer` tool that drives the macOS desktop, defaulting to the Corti One app (set `PI_COMPUTER_APP` for another).
`open_app`, `screenshot` (the app window, returned as an image whose coordinates match click coordinates, or `fullscreen`),
`ui_tree` (the accessibility tree with a click center for every labeled element, including the web content inside
WebView apps), `click`, `double_click`, `right_click`, `move`, `drag`, `scroll`, `type`, `key` (`cmd+s`, `return`),
`list_windows`, `wait` and `permissions`. Prefer `ui_tree` to guessing positions from pixels.

Screenshots use `screencapture`. Input and the tree come from a small Swift helper (`extensions/computer-use/cu.swift`),
compiled on first use into `~/.cache/pi-computer-use/cu` (needs Xcode command line tools). Grant the app that runs Pi
Accessibility and Screen Recording in System Settings > Privacy & Security; the `permissions` action reports both.
The tool description tells the model to stop at sign-in prompts and confirm before irreversible clicks.

## ios-simulator

One `ios_simulator` tool for driving the iOS Simulator, the same loop Claude and ChatGPT use: build, launch,
look, act, look again.

- **Through `xcrun simctl` (ships with Xcode):** `list`, `boot`, `show` (opens the Simulator window, or Device Hub on Xcode 27, so you can watch and drive the device yourself, for example to enter credentials), `shutdown`, `launch` (installs a built `.app`
  first when you give `app_path`), `terminate`, `open_url`, and `screenshot`, which comes back as an image the
  model can see.
- **Through [AXe](https://github.com/cameroncooke/AXe) (`brew install cameroncooke/axe/axe`):** `tap` (by coordinates, accessibility label or id), `swipe`,
  `type`, `button`, and `describe_ui`, which returns the accessibility tree with element frames so the model
  can aim taps instead of guessing from pixels. `simctl` cannot inject touch input, which is why AXe is needed.
  Without it the other actions still work and the input actions say how to install it.

Coordinates are device points, origin top-left. You need an installed iOS runtime (`xcodebuild -downloadPlatform iOS`).

## repo-state

One `repo_state` tool that inventories every Git checkout under a root directory (default: the working directory) in one
table, so you can see what is dirty, what is behind its remote, and which plain copies exist. It exists for a `~/Dev` with
~90 entries: real repositories, purpose-built worktrees (`corti-platform-cadfix2`, `worktrees/`), and untracked copies that
session hygiene forbids keeping. Directory names never decide: each directory is probed with `git rev-parse`, then read with
cheap porcelain commands (`git status --porcelain=v2 -b`, `git log -1`, `git worktree list --porcelain`, `git branch --merged`).

- **Fixed-width table**: repo, branch, ahead, behind, dirty count, last commit, updated date, and a state (`clean`, `dirty`,
  `behind`, `ahead`, `diverged`, `detached`, `no-remote`, `error`), plus a summary line with the counts per state.
- **Parameters:** `root` (directory to scan), `fetch` (run `git fetch` first so ahead/behind is current; off by default),
  `group` (only repos whose name starts with a prefix, for example `corti`), `detail` (add the worktree list and merged-branch
  hints per repo).
- **Duplicates:** every origin remote found in more than one place is listed, tagged `(linked worktree)` when the checkouts share
  one `.git` directory, and flagged when several separate `.git` checkouts point at the same origin. That is the untracked-copy
  problem the brain protocol forbids, surfaced for you to resolve.
- **Read only:** it never pulls, checks out, prunes, or deletes. `fetch=true` is the only call that touches a remote. Suggested
  next steps (`pull --ff-only`, prune a merged worktree) are printed as hints for you to run.
- Large reports are truncated in the transcript and the full text is saved to a temp file whose path is printed.

## License

MIT
