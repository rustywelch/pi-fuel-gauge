/**
 * Repo state - one read-only inventory of every git checkout under a root.
 *
 * ~/Dev holds about a hundred directories: real repositories, purpose-built
 * worktrees (corti-platform-cadfix2, worktrees/...), and plain untracked copies
 * that policy forbids. Deciding from directory names is wrong, so this proves
 * each directory with `git rev-parse` and then reports branch, ahead/behind,
 * dirty count, last commit, worktrees, and duplicate origin remotes.
 *
 * It serves the Pi AGENTS.md session-hygiene rules: verify branch and commit
 * before work, pull --ff-only when behind, prune merged worktrees, never keep
 * untracked copies. The tool only reads: it never pulls, checks out, prunes,
 * deletes, or fetches unless fetch=true. Merged-branch hints come from
 * `git branch --merged` style queries only.
 *
 * Parsing, classification, table layout, and truncation live in
 * lib/repo-state.mjs so they are unit-tested without git.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	buildRepo,
	formatRepoReport,
	truncateReport,
} from "../lib/repo-state.mjs";

const MAX_CHARS = 60_000;
const MAX_DEPTH = 3;
const GIT_TIMEOUT_MS = 20_000;
const FETCH_TIMEOUT_MS = 90_000;
const CONCURRENCY = 6;

// Directories that never contain a top-level checkout worth reporting.
const SKIP_DIRS = new Set([
	"node_modules", ".git", ".cache", ".venv", "venv", "dist", "build", "out",
	"target", "__pycache__", ".next", ".turbo", "Library", "Caches",
]);

const RepoStateParams = Type.Object({
	root: Type.Optional(Type.String({ description: "Directory to scan. Defaults to the working directory" })),
	fetch: Type.Optional(Type.Boolean({ description: "Run `git fetch` first so ahead/behind reflect the remotes. Defaults to false" })),
	group: Type.Optional(Type.String({ description: "Only report repos whose name starts with this prefix, for example corti" })),
	detail: Type.Optional(Type.Boolean({ description: "Add per-repo worktree list and merged-branch hints. Defaults to false" })),
});

type GitResult = { stdout: string; code: number; stderr: string };

function git(cwd: string, args: string[], signal?: AbortSignal, timeout = GIT_TIMEOUT_MS): Promise<GitResult> {
	return new Promise((resolvePromise) => {
		execFile("git", args, { cwd, signal, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
			const code = (err as NodeJS.ErrnoException & { code?: number })?.code;
			resolvePromise({
				stdout: typeof stdout === "string" ? stdout : "",
				code: typeof code === "number" ? code : err ? 1 : 0,
				stderr: typeof stderr === "string" ? stderr : "",
			});
		});
	});
}

/** Run git where a directory is the worktree root; `git -C` keeps the call simple. */
function gitAt(path: string, args: string[], signal?: AbortSignal, timeout?: number): Promise<GitResult> {
	return git(path, ["-C", path, ...args], signal, timeout);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		for (;;) {
			const i = next++;
			if (i >= items.length) return;
			out[i] = await fn(items[i]);
		}
	});
	await Promise.all(workers);
	return out;
}

type Found = { path: string; name: string; commonDir: string };

/**
 * Prove each directory with `git rev-parse` instead of guessing from names.
 * A directory that is a worktree root is reported and not descended into, so
 * nested repositories and build trees do not multiply the scan.
 */
async function findRepoRoots(
	root: string,
	group: string | undefined,
	signal: AbortSignal | undefined,
): Promise<{ repos: Found[]; dirsChecked: number }> {
	const repos: Found[] = [];
	const queue: { path: string; depth: number }[] = [{ path: root, depth: 0 }];
	let dirsChecked = 0;

	while (queue.length > 0) {
		const { path, depth } = queue.shift() as { path: string; depth: number };
		dirsChecked += 1;

		const probe = await gitAt(path, ["rev-parse", "--is-inside-work-tree", "--show-toplevel", "--git-common-dir"], signal);
		if (probe.code === 0) {
			const [, toplevel, commonDir] = probe.stdout.split("\n");
			if (resolve(toplevel.trim()) === path) {
				const name = path.split("/").pop() || path;
				if (!group || name.toLowerCase().startsWith(group.toLowerCase())) {
					repos.push({ path, name, commonDir: resolve(path, commonDir.trim()) });
				}
			}
			continue; // Inside a checkout (root or nested): do not walk its files.
		}

		if (depth >= MAX_DEPTH) continue;
		let entries;
		try {
			entries = await readdir(path, { withFileTypes: true });
		} catch {
			continue; // Unreadable directory: skip it.
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (SKIP_DIRS.has(entry.name)) continue;
			if (entry.name.startsWith(".") && entry.name !== ".") continue;
			const child = join(path, entry.name);
			queue.push({ path: child, depth: depth + 1 });
		}
	}

	return { repos, dirsChecked };
}

/** Collect the raw porcelain text for one repository; no command here mutates state. */
async function collectRepo(found: Found, fetch: boolean, detail: boolean, signal: AbortSignal | undefined) {
	const raw: Record<string, string> = {};
	const problems: string[] = [];

	if (fetch) {
		const fetched = await gitAt(found.path, ["fetch", "--quiet"], signal, FETCH_TIMEOUT_MS);
		if (fetched.code !== 0) problems.push(`fetch failed: ${fetched.stderr.trim() || `exit ${fetched.code}`}`);
	}

	const status = await gitAt(found.path, ["status", "--porcelain=v2", "-b", "--branch"], signal);
	if (status.code !== 0) problems.push(`status failed: ${status.stderr.trim() || `exit ${status.code}`}`);
	raw.status = status.stdout;

	// Empty repo (no commits yet) makes git log fail; the row simply has no head.
	raw.head = (await gitAt(found.path, ["log", "-1", "--format=%h|%cs|%s"], signal)).stdout;
	raw.remote = (await gitAt(found.path, ["remote", "get-url", "origin"], signal)).stdout.trim();
	raw.worktrees = (await gitAt(found.path, ["worktree", "list", "--porcelain"], signal)).stdout;
	if (detail) raw.merged = (await gitAt(found.path, ["branch", "--merged"], signal)).stdout;

	return buildRepo({
		path: found.path,
		name: found.name,
		commonDir: found.commonDir,
		isWorktreeCopy: found.commonDir !== join(found.path, ".git"),
		raw,
		error: problems.length > 0 ? problems.join("; ") : null,
	});
}

/** Full report to a temp file only when the inline text had to be cut. */
async function saveFullReport(text: string): Promise<string | undefined> {
	try {
		const dir = await mkdtemp(join(tmpdir(), "pi-repo-state-"));
		const file = join(dir, "report.txt");
		await writeFile(file, text, "utf8");
		return file;
	} catch {
		return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "repo_state",
		label: "Repo state",
		description:
			"Read-only git inventory of every repository under a root directory. One fixed-width table with branch, " +
			"ahead/behind, dirty count, last commit, and state (clean, dirty, behind, ahead, diverged, detached, " +
			"no-remote), plus a summary line, a list of duplicate checkouts sharing an origin remote, and with " +
			"detail=true the worktree list and merged-branch hints. Use it to find stale or disposable checkouts. " +
			"It never pulls, checks out, prunes, or deletes; pass fetch=true only when remote freshness matters.",
		promptSnippet: "Read-only git state (branch, ahead/behind, dirty, worktrees) for every repo under a root",
		parameters: RepoStateParams,
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const requested = params.root || ctx.cwd || process.cwd();
			const absolute = isAbsolute(requested) ? resolve(requested) : resolve(ctx.cwd || process.cwd(), requested);
			const group = params.group?.trim() || undefined;
			const fetch = params.fetch === true;
			const detail = params.detail === true;

			// git reports real paths, so resolve symlinks (macOS /tmp, linked Dev dirs) before comparing.
			let root = absolute;
			try {
				root = await realpath(absolute);
			} catch {
				return {
					content: [{ type: "text" as const, text: `Not scanning: ${absolute} is not a readable directory.` }],
					details: { root: absolute, fetch, detail, group: group ?? null },
				};
			}

			const { repos, dirsChecked } = await findRepoRoots(root, group, signal);
			const rows = await mapLimit(repos, CONCURRENCY, (found) => collectRepo(found, fetch, detail, signal));
			rows.sort((a, b) => a.name.localeCompare(b.name));

			const report = formatRepoReport(rows, { root, fetch, detail, dirsChecked });
			const first = truncateReport(report, MAX_CHARS);
			let text = first.text;
			let fullPath: string | undefined;
			if (first.truncated) {
				fullPath = await saveFullReport(report);
				text = truncateReport(report, MAX_CHARS, fullPath).text;
			}

			return {
				content: [{ type: "text" as const, text }],
				details: { root, fetch, detail, group: group ?? null, dirsChecked, repos: rows.length, truncated: first.truncated, fullPath: fullPath ?? null },
			};
		},
	});
}
