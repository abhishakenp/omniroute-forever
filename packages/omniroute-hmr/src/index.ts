/**
 * @omniroute/hmr — the reload bridge. Vendored from rlm's packages/rlm-hmr
 * (Bun module reload, in-place class patching, after-patch hook, headless
 * follow). Keep the two in step; the only OmniRoute changes are the epoch-file
 * default (follow.ts), the service/row names, and resourceRoots: [] in cordis.yml.
 *
 * The reload engine used to live in cordis-shell.mjs, which is the one file in
 * the process that cannot reload itself. That is not a stylistic complaint: it
 * had two costs the plugin form does not have.
 *
 *   The watch roots were derived once, at boot, from `readdirSync(packages)`.
 *   A package created afterwards was never watched, so the first edit to a
 *   newly added plugin did nothing and looked like a broken reloader.
 *
 *   The reload policy — debounce, ignore rules, what counts as source — was
 *   frozen for the life of the process. Changing how reloading works meant
 *   restarting the thing whose job is to avoid restarts.
 *
 * As a fiber both go away. One recursive watcher over `packages/` sees
 * directories that appear later, so a package added at runtime is watched from
 * the moment it exists. And this file lives under that same tree, so editing
 * the reloader reloads the reloader: the swap disposes these watchers
 * through ctx.effect() and the new module opens its own.
 *
 * Module reload itself is now the official @deepseek-ai/cordis-plugin-hmr's
 * job — the same plugin DSH declares in its own base composition. This plugin
 * does the two things that one does not:
 *
 *   It watches the agent's resource directories. Skills, extensions, prompts
 *   and workflows live outside the repo (under ~/.rlm/agent), are not modules,
 *   and so are invisible to a module reloader — but a session reads them at
 *   startup and must re-derive when they change.
 *
 *   It translates. The official plugin announces `hmr/reload` and `hmr/change`;
 *   a live AgentSession listens for `rlm/hmr-reload` and `rlm/resources-changed`.
 *
 * When the official plugin is absent this plugin reloads modules itself:
 *
 *   Under node without --expose-internals there is no module graph to read,
 *   and nothing can be reloaded; that is logged, not hidden.
 *
 *   Under bun — which is how rlm is launched — `bunReload` does it with bun's
 *   own tools: patch-in-place for classes the running session holds, fiber
 *   swap for rows whose restart cannot reach a live session. That was missing
 *   until 2026-09-25: every edit was noticed and then dropped. See
 *   `./bun-reload.ts` for the mechanism and its limits.
 *
 * Running sessions are never interrupted: the chat, its runtime and the
 * SDK's subagents live on the host Surface, not on the rows that draw them, so
 * swapping `renderer`, `print`, `sdk` or `modes` re-attaches instead of ending
 * anything. Rows listed in `config.pinned` are still only patched.
 *
 * Patching changes behaviour, not state an instance already computed. After
 * every patch pass, each live object built by a patched class — every provided
 * service, plus anything opted in with `registerLive(obj)` — gets
 * `obj[Symbol.for("rlm.hmr.patched")]({ paths })` if it defines it, running the
 * new code on the old instance so it can re-derive init-time state with zero
 * downtime (build the new state, swap it in, then tear the old down). The
 * contract is `HMR_PATCHED` in `./bun-reload.ts`; rlm-guard is the first user.
 */
import { Service } from "@deepseek-ai/cordis";
import { watch as fsWatch, existsSync, realpathSync, statSync, type FSWatcher } from "node:fs";
import { join, relative, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { watching, whenWatched } from "./live.ts";
import { broadcast, follow } from "./follow.ts";
import {
	ImportGraph,
	ancestors,
	closureOf,
	dependentFibers,
	exportsFunctions,
	isBun,
	liveObjects,
	notifyPatched,
	patchInPlace,
	patchNamespace,
} from "./bun-reload.ts";

/**
 * Called on every live instance of a row's class just before a swap disposes
 * it (SURFACE, zero-restart Case 3). The old instance's class has already been
 * patched with the new code, so this runs the NEW handover on the OLD instance:
 * it moves whatever must outlive the swap onto the host Surface, where the next
 * generation finds it. A process whose chat started before a row kept its state
 * on the Surface is migrated this way on its first swap. HANDOVER (Case 2)
 * generalises this into hot data for every row.
 */
const HMR_HANDOVER = Symbol.for("rlm.hmr.handover");

const require_ = createRequire(import.meta.url);

/**
 * Rows a bun reload never swaps, and never swaps anything that would restart.
 *
 * Empty since 2026-09-26 (worker SURFACE, zero-restart design Case 3). It used
 * to be `renderer`, `print`, `sdk`, `modes`, because swapping them ended the
 * session on screen: the chat, its runtime and the SDK's subagents lived on the
 * row instances. They now live on the host-owned Surface
 * (packages/rlm-host/src/surface.ts), the rows attach to it on init, and the
 * shell awaits `surface.lifetime` rather than any row — so a swap re-attaches
 * instead of ending anything, and these rows get real swaps like any other.
 *
 * `config.pinned` still lists rows to hold back, for a row that cannot yet hand
 * its state over. HANDOVER (Cases 2 and 4) owns this file after SURFACE.
 */
const DEFAULT_PINNED: string[] = [];

export interface RlmHmrConfig {
	/** Directories to watch, relative to the repo root. Default: ["packages"]. */
	roots?: string[];
	/** Substrings and suffixes that disqualify a path from triggering a reload. */
	ignored?: string[];
	/**
	 * Directories holding runtime resources — skills, extensions, prompts,
	 * themes. Anything that changes here is announced to live sessions, which
	 * re-derive from it without restarting.
	 *
	 * Defaults to the resource subdirectories of the project's and the user's
	 * agent directories, never the agent directory itself: a running session
	 * writes its transcript, artifacts and lock files there, and watching the
	 * parent turns the session's own output into a reload trigger, which
	 * produces more output.
	 */
	resourceRoots?: string[];
	/** Milliseconds to batch rapid saves into one reload pass. Default 100. */
	debounce?: number;
	/** Log every decision. Also enabled by RLM_HMR_VERBOSE=1. */
	verbose?: boolean;
	/**
	 * "bridge" defers module reload to @deepseek-ai/cordis-plugin-hmr;
	 * "standalone" reloads modules here; "auto" (default) bridges when the
	 * official plugin is present and falls back when it is not.
	 */
	mode?: "auto" | "bridge" | "standalone";
	/** Where watched processes broadcast change batches for unwatched ones. Default ~/.rlm/agent/hmr-epoch.json. */
	epochFile?: string;
	/**
	 * Bun only. Row ids that must never restart because of a reload — directly,
	 * or because a row they inject was swapped. Default: none (see
	 * DEFAULT_PINNED). See `./bun-reload.ts`.
	 */
	pinned?: string[];
	/**
	 * Bun only. How many levels of importers are evaluated again when a changed
	 * file exports plain functions, so the classes calling them get patched
	 * against the new copy. Default 2.
	 */
	importerDepth?: number;
	/** Bun only. Upper bound on modules evaluated again in one pass. Default 60. */
	maxReEvaluated?: number;
}

/** Paths whose contents end up inside the built system prompt. */
const PROMPT_SHAPED = ["/skills/", "/prompts/", "/refinement/", "/themes/"];

/**
 * The subdirectories of an agent directory that actually hold resources.
 *
 * Deliberately not the agent directory itself: sessions, session-artifacts,
 * logs and lock files live beside these and are written by the running
 * session, so watching the parent makes a session reload in response to its
 * own transcript — and each reload writes more of one.
 */
const RESOURCE_DIRS = ["skills", "extensions", "prompts", "themes", "workflows"];

/** file:// URL → path, tolerant of anything that is not one. */
function urlToPathSafe(url: string): string {
	try {
		return url.startsWith("file:") ? fileURLToPath(url) : url;
	} catch {
		return url;
	}
}

const DEFAULT_IGNORED = [
	// Session state written by the running agent. Never a resource change.
	"/sessions/",
	"/session-artifacts/",
	"/logs/",
	".lock",
	".jsonl",
	".tmp",
	"/node_modules/",
	"/dist/",
	"/.cache",
	"/.tsbuildinfo",
	".test.ts",
	".test.js",
	".map",
	".d.ts",
];

export class RlmHmrService extends Service {
	static inject = [] as const;
	static provide = "omniHmr" as const;

	declare config: RlmHmrConfig;

	private root = process.cwd();
	private resourceRoots: string[] = [];
	private mode: "auto" | "bridge" | "standalone" = "auto";
	private reloadCount = 0;
	private resourceEvents = 0;
	private lastReloaded: string[] = [];

	constructor(ctx: any, config: RlmHmrConfig = {}) {
		super(ctx, undefined as any);
		this.config = config;
	}

	/**
	 * One line of reload news for the prompt tray (rlm-tui coalesces bursts
	 * into its single transient notice). Never printed: see log().
	 */
	private announce(text: string, level: "info" | "warn" = "info") {
		try {
			(globalThis as any).__rlmTui?.announce?.(text, { level });
		} catch {}
	}

	private log(...args: unknown[]) {
		try {
			const sink = (globalThis as any).__rlmLog;
			// OmniRoute has no rlm log sink: its stdout is the daemon log
			// (~/.omniroute/logs/omniroute.log), so reload news goes there.
			if (sink) sink("info", "hmr", String(args[0] ?? "").replace(/^\[rlm\] /, ""));
			else console.log(String(args[0] ?? "").replace(/^\[rlm\] /, "[omniroute-hmr] "));
		} catch {}
		if (this.config.verbose || process.env.RLM_HMR_VERBOSE) console.error(...args);
	}

	async [Service.init]() {
		this.root = this.ctx.baseUrl ? fileURLToPath(this.ctx.baseUrl) : process.cwd();
		this.resourceRoots = (
			this.config.resourceRoots ??
			[join(this.root, ".rlm", "agent"), join(homedir(), ".rlm", "agent")].flatMap((base) =>
				RESOURCE_DIRS.map((sub) => join(base, sub)),
			)
		).filter((d) => existsSync(d));

		this.mode = this.config.mode ?? "auto";
		if (this.mode !== "standalone") this.installBridge();
		if (this.mode === "standalone" && !this.ctx.loader?.internal) {
			this.ctx.logger?.warn?.(
				"rlm-hmr: no official hmr plugin and no loader.internal — module reload is inert " +
					"(start node with --expose-internals, or add an hmr row to cordis.yml)",
			);
		}

		// Gated, not injected. This row used to carry `inject: ['rlmLive']` in
		// `cordis.yml`, which parked it whenever the headless row withheld that
		// token — and parked it for ever when the headless row was removed from
		// the composition altogether, because then nobody provided the token at
		// all. Asking at the use site instead means no headless row is no
		// opinion, and no opinion is "watch, the way rlm always did". See
		// `./live.ts` for why this is race-free without `inject`.
		// Unwatched, this process follows the batches a watched one broadcasts
		// instead of opening its own watchers. Asked per event, so a process
		// that becomes watched stops following and uses its own watcher.
		this.ctx.effect(() =>
			follow(
				(urls) => {
					this.log(`[rlm] HMR: following ${urls.length} broadcast change(s) (unwatched process ${process.pid})`);
					this.partialReload(urls).catch((e) => this.log(`[rlm] HMR: followed reload failed: ${e?.message ?? e}`));
				},
				() => !watching(this.ctx),
				{ file: this.config.epochFile },
			),
		);
		// An unwatched process catches up on boot-time edits too (it has no watcher
		// that could have seen them, and a broadcast may not have happened).
		const catchUpTimer = setTimeout(() => {
			if (!watching(this.ctx)) this.catchUpBoot();
		}, 1000);
		(catchUpTimer as any).unref?.();
		this.ctx.effect(() => () => clearTimeout(catchUpTimer), "rlm-hmr boot catch-up timer");

		whenWatched(this.ctx, "rlm-hmr", () => {
			const watchers = this.install();
			// Edits saved while this process was booting, before any watcher existed.
			this.catchUpBoot();
			return () => {
				for (const w of watchers) {
					try {
						w.close();
					} catch {}
				}
			};
		});

		const what =
			this.mode === "bridge"
				? "bridging @deepseek-ai/cordis-plugin-hmr"
				: `mode=${this.mode}, watching ${(this.config.roots ?? ["packages"]).join(", ")}`;
		this.log(`[rlm] rlm-hmr: ${what}; resources: ${this.resourceRoots.join(", ") || "none"}`);
		this.ctx.logger?.info?.(`rlm-hmr: ${what} (root=${this.root})`);
	}

	/**
	 * Translate the official plugin's announcements into the ones a live
	 * session listens for. Registered through ctx.effect so a reload of this
	 * plugin does not leave a second translator behind.
	 */
	private installBridge() {
		this.ctx.effect(() => {
			const ctx: any = this.ctx;
			const onReload = (reloads: any) => {
				const count = reloads?.size ?? reloads?.length ?? 0;
				this.reloadCount++;
				this.log(`[rlm] rlm-hmr: official hmr reloaded ${count} plugin(s)`);
				try {
					ctx.emit("rlm/hmr-reload", { reloaded: [...(reloads?.keys?.() ?? [])] });
				} catch {}
			};
			// A file the official plugin watched but could not treat as a module:
			// for us that is a resource, and a session may need to re-read it.
			const onChange = (url: string) => this.announceResourceChange([urlToPathSafe(url)]);
			ctx.on("hmr/reload", onReload);
			ctx.on("hmr/change", onChange);
			return () => {
				try {
					ctx.off?.("hmr/reload", onReload);
					ctx.off?.("hmr/change", onChange);
				} catch {}
			};
		});
	}

	/**
	 * One recursive watcher per configured root.
	 *
	 * Recursive is the whole point: a package directory created after boot is
	 * inside an already-watched tree, so it needs no new watcher and no restart.
	 */
	/**
	 * Reload loaded source that changed after this process started. The watchers
	 * come up seconds into boot; an edit saved before them was never seen, so the
	 * process ran the old code until the file changed again. Module load times are
	 * not recorded, so "changed since boot" is the test — a file loaded after its
	 * edit is evaluated once more, which is harmless.
	 */
	private catchUpBoot() {
		const bootAt = Date.now() - process.uptime() * 1000;
		const ignored = [...DEFAULT_IGNORED, ...(this.config.ignored ?? [])];
		const urls: string[] = [];
		for (const p of Object.keys(require_.cache)) {
			if (!p.startsWith(this.root + sep) || !p.includes(`${sep}src${sep}`)) continue;
			if (!p.endsWith(".ts") && !p.endsWith(".js")) continue;
			if (ignored.some((frag) => p.includes(frag) || p.endsWith(frag))) continue;
			let mtime: number;
			try {
				mtime = statSync(p).mtimeMs;
			} catch {
				continue;
			}
			if (mtime > bootAt) urls.push(pathToFileURL(p).href);
		}
		if (!urls.length) return;
		this.log(`[rlm] HMR: ${urls.length} file(s) changed while this process booted — reloading`);
		this.partialReload(urls).catch((e) => this.log(`[rlm] HMR: boot catch-up failed: ${e?.message ?? e}`));
	}

	private install(): FSWatcher[] {
		const watchers: FSWatcher[] = [];
		const debounceMs = this.config.debounce ?? 100;
		const ignored = [...DEFAULT_IGNORED, ...(this.config.ignored ?? [])];

		let timer: NodeJS.Timeout | null = null;
		const stashed = new Set<string>();

		const onChange = (absolute: string) => {
			if (!absolute.endsWith(".ts") && !absolute.endsWith(".js")) return;
			if (ignored.some((frag) => absolute.includes(frag) || absolute.endsWith(frag))) return;
			// Only source under a package's src/ is plugin code.
			if (!absolute.includes(`${sep}src${sep}`)) return;

			this.log(`[rlm] HMR: ${relative(this.root, absolute)} changed`);
			stashed.add(pathToFileURL(absolute).href);
			// Source that feeds the prompt (prompt templates, skill definitions,
			// refinement text) must invalidate the built prompt as well as
			// reloading the module that holds it.
			if (PROMPT_SHAPED.some((frag) => absolute.includes(frag))) {
				try {
					(this.ctx as any).emit("rlm/prompt-changed", { path: absolute });
				} catch {}
			}

			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = null;
				const batch = [...stashed];
				stashed.clear();
				// Tell processes nobody is watching (drive, pool/daemon workers),
				// which have no watcher of their own — see ./follow.ts.
				broadcast(batch, this.config.epochFile);
				if (this.isBridging) {
					// The official plugin owns module reload; it saw this too.
					this.log(`[rlm] rlm-hmr: ${batch.length} change(s) deferred to the official hmr plugin`);
					return;
				}
				this.partialReload(batch).catch((e) =>
					(this.log(`[rlm] HMR: partialReload failed: ${e?.message ?? e}`),
					this.announce(`⚠ reload failed: ${e?.message ?? e}`, "warn")),
				);
			}, debounceMs);
		};

		for (const rel of this.mode === "bridge" ? [] : this.config.roots ?? ["packages"]) {
			const dir = join(this.root, rel);
			if (!existsSync(dir)) continue;
			try {
				watchers.push(
					fsWatch(dir, { recursive: true }, (_event, filename) => {
						if (filename) onChange(join(dir, filename.toString()));
					}),
				);
			} catch (e: any) {
				this.log(`[rlm] HMR: cannot watch ${dir}: ${e?.message ?? e}`);
			}
		}

		// Resource directories. Nothing here is a module, so nothing is
		// re-imported; the change is announced and live sessions re-derive from
		// it. This is what makes a skill added at runtime reach a running agent.
		let resourceTimer: NodeJS.Timeout | null = null;
		const resourceChanges = new Set<string>();
		const onResourceChange = (absolute: string) => {
			if (ignored.some((frag) => absolute.includes(frag) || absolute.endsWith(frag))) return;
			resourceChanges.add(absolute);
			if (resourceTimer) clearTimeout(resourceTimer);
			resourceTimer = setTimeout(() => {
				resourceTimer = null;
				const batch = [...resourceChanges];
				resourceChanges.clear();
				this.announceResourceChange(batch);
			}, debounceMs);
		};

		for (const dir of this.resourceRoots) {
			try {
				watchers.push(
					fsWatch(dir, { recursive: true }, (_event, filename) => {
						if (filename) onResourceChange(join(dir, filename.toString()));
					}),
				);
				this.log(`[rlm] HMR: watching resources in ${dir}`);
			} catch (e: any) {
				this.log(`[rlm] HMR: cannot watch ${dir}: ${e?.message ?? e}`);
			}
		}
		return watchers;
	}

	/**
	 * Tell live sessions that something they read at startup has changed.
	 *
	 * `rlm/resources-changed` makes a session re-derive skills, extensions and
	 * tools; `rlm/prompt-changed` additionally invalidates the built system
	 * prompt. Both are advisory — a session applies them between turns, never
	 * during one.
	 */
	private announceResourceChange(paths: string[]) {
		if (paths.length === 0) return;
		const ctx: any = this.ctx;
		const names = paths.map((p) => relative(this.root, p)).slice(0, 3).join(", ");
		this.log(`[rlm] HMR: resources changed (${names})`);
		this.announce(`↻ ${names} changed`);
		this.resourceEvents++;
		try {
			ctx.emit("rlm/resources-changed", { paths, reason: `resources changed: ${names}` });
		} catch {}
		if (paths.some((p) => PROMPT_SHAPED.some((frag) => p.includes(frag)))) {
			try {
				ctx.emit("rlm/prompt-changed", { path: paths[0] });
			} catch {}
		}
	}

	/**
	 * Whether module reload belongs to the official plugin right now.
	 *
	 * Asked at the moment a change arrives rather than at startup: the official
	 * plugin's service only becomes visible once its watcher is ready, which is
	 * after this plugin's own init, so an init-time answer is a race. Both
	 * watchers may see the same file; only one acts on it.
	 */
	get isBridging(): boolean {
		if (this.mode === "bridge") return true;
		if (this.mode === "standalone") return false;
		try {
			return !!this.ctx.get?.("hmr");
		} catch {
			return false;
		}
	}

	/** How many reload passes this fiber has performed, and what it last swapped. */
	stats() {
		return {
			mode: this.mode,
			bridging: this.isBridging,
			reloads: this.reloadCount,
			resourceEvents: this.resourceEvents,
			lastReloaded: this.lastReloaded,
			root: this.root,
			resourceRoots: this.resourceRoots,
		};
	}

	// ─── Module graph ─────────────────────────────────────────────────────────

	private async resolveModuleURL(specifier: string, parentURL: string) {
		const internal = this.ctx.loader?.internal;
		if (!internal) return null;
		const attrs = {};
		switch (internal.version) {
			case "v1":
				return await internal.resolve(specifier, parentURL, attrs);
			case "v2":
				return internal.resolveSync(parentURL, { specifier, attributes: attrs });
			default:
				return null;
		}
	}

	private async getLinked(internal: any, url: string): Promise<string[]> {
		const job = internal.loadCache.get(url);
		if (!job) return [];
		const linked = await job.linked;
		if (!linked || !Array.isArray(linked)) return [];
		return Array.prototype.map.call(linked, (j: any) => j.url) as string[];
	}

	private async loadDependencies(internal: any, url: string, ignored = new Set<string>()) {
		const dependencies = new Set<string>();
		const traverse = async (u: string): Promise<void> => {
			if (ignored.has(u) || dependencies.has(u)) return;
			if (u.startsWith("node:") || u.includes("/node_modules/")) return;
			dependencies.add(u);
			const linked = await this.getLinked(internal, u);
			await Promise.all(linked.map(traverse));
		};
		await traverse(url);
		return dependencies;
	}

	// ─── Reload ───────────────────────────────────────────────────────────────

	/**
	 * Clear the changed modules from Node's caches, re-import them, and swap the
	 * affected plugins in the registry, keeping each old fiber's config. Any
	 * failure rolls the caches back and re-registers what was removed, so a
	 * syntax error in a plugin costs a failed reload rather than a dead process.
	 */
	async partialReload(stashedURLs: string[]) {
		const ctx: any = this.ctx;
		const loader = ctx.loader;
		if (!loader?.internal) {
			if (isBun()) {
				try {
					return await this.bunReload(stashedURLs);
				} catch (e: any) {
					// The reloader is itself hot-patched, so a broken intermediate
					// edit to it would otherwise stop it loading the next one.
					// `patchInPlace` depends on nothing in this class.
					this.log(`[rlm] HMR[bun]: reload pass failed (${e?.message ?? e}) — falling back to patch-only`);
					this.announce(`⚠ reload failed: ${e?.message ?? e}`, "warn");
					const paths = stashedURLs.map(urlToPathSafe);
					const patched = await patchInPlace(paths, require_.cache as any);
					const notified = patched.length ? await notifyPatched(ctx, paths) : [];
					this.log(
						`[rlm] HMR[bun]: patch-only fallback patched ${patched.join("; ") || "nothing"}` +
							(notified.length ? ` | re-derived ${notified.join(", ")}` : ""),
					);
					return;
				}
			}
			this.log("[rlm] HMR: loader.internal unavailable — cannot reload (need --expose-internals)");
			return;
		}
		const internal = loader.internal;

		const accepted = new Set(stashedURLs);
		const declined = new Set<string>();
		const isExcluded = (url: string) => url.startsWith("node:") || url.includes("/node_modules/");

		const pending: string[] = [];
		for (const url of stashedURLs) {
			for (const child of await this.getLinked(internal, url)) {
				if (accepted.has(child) || declined.has(child) || isExcluded(child)) continue;
				pending.push(child);
			}
		}

		while (pending.length) {
			let index = 0;
			let hasUpdate = false;
			while (index < pending.length) {
				const url = pending[index]!;
				const linked = await this.getLinked(internal, url);
				if (linked.length === 0) {
					pending.splice(index, 1);
					hasUpdate = true;
					declined.add(url);
					continue;
				}
				let isDeclined = true;
				let isAccepted = false;
				for (const child of linked) {
					if (declined.has(child) || isExcluded(child)) continue;
					if (accepted.has(child)) {
						isAccepted = true;
						break;
					}
					isDeclined = false;
					if (!pending.includes(child)) {
						hasUpdate = true;
						pending.push(child);
					}
				}
				if (isAccepted || isDeclined) {
					hasUpdate = true;
					pending.splice(index, 1);
					if (isAccepted) accepted.add(url);
					else declined.add(url);
				} else index++;
			}
			if (!hasUpdate) break;
		}
		for (const url of pending) declined.add(url);

		const nameMap: Record<string, Set<string>> = {};
		for (const entry of loader.entries()) {
			const baseUrl = entry.parent?.tree?.ctx?.baseUrl;
			if (!baseUrl) continue;
			(nameMap[baseUrl] ??= new Set()).add(entry.options.name);
		}

		const allPending = new Map<any, { plugin: any; url: string }>();
		for (const baseUrl in nameMap) {
			for (const name of nameMap[baseUrl]!) {
				try {
					const result: any = await this.resolveModuleURL(name, baseUrl);
					if (!result?.url || declined.has(result.url)) continue;
					const job = internal.loadCache.get(result.url);
					if (!job) continue;
					const plugin = loader.unwrapExports(job.module?.getNamespace?.());
					if (!plugin) continue;
					allPending.set(job, { plugin, url: result.url });
					declined.add(result.url);
				} catch {}
			}
		}

		const reloads = new Map<string, { plugin: any; runtime: any }>();
		for (const [, { plugin, url }] of allPending) {
			declined.delete(url);
			const deps = [...(await this.loadDependencies(internal, url, declined))];
			declined.add(url);
			if (!deps.some((dep) => accepted.has(dep))) continue;
			deps.forEach((dep) => accepted.add(dep));
			const runtime = ctx.registry.get(plugin);
			if (!runtime) continue;
			reloads.set(url, { plugin, runtime });
		}

		if (reloads.size === 0) {
			this.log(`[rlm] HMR: no plugins affected by ${stashedURLs.length} changed file(s)`);
			return;
		}
		this.log(`[rlm] HMR: ${reloads.size} plugin(s) to reload`);

		const esmBackup: Record<string, any> = {};
		const cjsBackup: Record<string, any> = {};
		for (const filename of accepted) {
			esmBackup[filename] = Map.prototype.get.call(internal.loadCache, filename);
			Map.prototype.delete.call(internal.loadCache, filename);
			try {
				const filepath = fileURLToPath(filename);
				if (require_.cache[filepath]) {
					cjsBackup[filepath] = require_.cache[filepath];
					delete require_.cache[filepath];
				}
			} catch {}
		}
		const rollback = () => {
			for (const filename in esmBackup) {
				Map.prototype.set.call(internal.loadCache, filename, esmBackup[filename]);
			}
			for (const filepath in cjsBackup) require_.cache[filepath] = cjsBackup[filepath];
		};

		const getOuterStack = () => [];
		const attempts: Record<string, any> = {};
		try {
			for (const [url] of reloads) {
				attempts[url] = loader.unwrapExports(await loader.import(url, getOuterStack));
			}
		} catch (e: any) {
			this.log(`[rlm] HMR: re-import failed: ${e?.message ?? e}`);
			rollback();
			return;
		}

		const reload = (plugin: any, runtime: any) => {
			if (!runtime) return;
			for (const oldFiber of runtime.fibers) {
				const fiber = oldFiber.parent.registry.plugin(plugin, oldFiber._config, getOuterStack);
				fiber.entry = oldFiber.entry;
				if (fiber.entry) fiber.entry.fiber = fiber;
			}
		};

		for (const [url, { plugin: oldPlugin, runtime }] of reloads) {
			const newPlugin = attempts[url];
			if (!newPlugin) continue;
			const path = url.replace(ctx.baseUrl, "");
			await this.handOver(oldPlugin, path);
			try {
				ctx.registry.delete(oldPlugin);
			} catch (e: any) {
				this.log(`[rlm] HMR: failed to dispose old plugin at ${path}: ${e?.message ?? e}`);
			}
			try {
				reload(newPlugin, runtime);
				this.log(`[rlm] HMR: reloaded plugin at ${path}`);
				this.announce(`↻ reloaded ${basenameOf(path)}`);
			} catch (e: any) {
				this.log(`[rlm] HMR: failed to reload plugin at ${path}: ${e?.message ?? e}`);
				this.announce(`⚠ ${basenameOf(path)} failed to reload`, "warn");
				rollback();
				for (const [url2, { plugin: oldPlugin2, runtime: runtime2 }] of reloads) {
					if (oldPlugin2 === oldPlugin) continue;
					try {
						ctx.registry.delete(attempts[url2]);
					} catch {}
					reload(oldPlugin2, runtime2);
				}
				return;
			}
		}

		this.reloadCount++;
		this.lastReloaded = [...reloads.keys()];
		ctx.emit("rlm/hmr-reload", { reloaded: this.lastReloaded });
	}

	// ─── Reload under bun ─────────────────────────────────────────────────────

	private graph?: ImportGraph;

	/** Loader entries that name a file in this repo, with the fiber they run as. */
	private rowEntries(): Array<{ id: string; path: string; fiber: any }> {
		const loader: any = this.ctx.loader;
		const rows: Array<{ id: string; path: string; fiber: any }> = [];
		for (const entry of loader?.entries?.() ?? []) {
			const name: string | undefined = entry.options?.name;
			const baseUrl: string | undefined = entry.parent?.tree?.ctx?.baseUrl;
			if (!name || !baseUrl || !name.startsWith(".") || !entry.fiber) continue;
			try {
				rows.push({ id: entry.options.id, path: fileURLToPath(new URL(name, baseUrl)), fiber: entry.fiber });
			} catch {}
		}
		return rows;
	}

	/**
	 * Restart loader entries whose fiber FAILED (state 3) when `changed` touches
	 * their module or its package. Files that do not parse are left alone — a
	 * retry would fail the same way. The retry is `Entry#refresh` on an entry
	 * with no fiber, the loader's own start path, after evicting the module's
	 * cached copy so the new source is what starts.
	 */
	async retryFailedRows(changed: string[], graph: ImportGraph, cache: Record<string, unknown>) {
		if (!changed.length) return;
		const loader: any = this.ctx.loader;
		// Real paths: a module cache keyed by /private/var/… never matches /var/….
		const real = (p: string) => {
			try {
				return realpathSync(p);
			} catch {
				return p;
			}
		};
		const pkgOf = (p: string) => /^(.*\/packages\/[^/]+)\//.exec(real(p))?.[1];
		const changedPkgs = new Set(changed.map(pkgOf).filter(Boolean));
		const retried: string[] = [];
		const stillFailed: string[] = [];
		for (const entry of loader?.entries?.() ?? []) {
			const fiber = entry.fiber;
			if (!fiber || fiber.state !== 3) continue;
			const name: string | undefined = entry.options?.name;
			const baseUrl: string | undefined = entry.parent?.tree?.ctx?.baseUrl;
			if (!name || !baseUrl) continue;
			let path: string;
			try {
				path = fileURLToPath(new URL(name, baseUrl));
			} catch {
				continue;
			}
			if (!changed.some((c) => real(c) === real(path)) && !changedPkgs.has(pkgOf(path))) continue;
			if (changed.some((p) => graph.check(p))) continue;
			for (const p of Object.keys(cache)) if (pkgOf(p) === pkgOf(path) || changed.some((c) => real(c) === real(p))) delete cache[p];
			try {
				// `_dispose`, not `fiber.dispose()`: it marks the entry as disposing,
				// which is what stops the loader's "a plugin was unloaded" hook from
				// writing `disabled: true` into the composition (loader lib ~:716).
				await entry._dispose(fiber).catch?.(() => {});
				await entry.init();
				if (entry.fiber?.state === 3) stillFailed.push(`${entry.options.id}: ${entry.fiber?._error?.message ?? "failed again"}`);
				else retried.push(entry.options.id);
			} catch (e: any) {
				stillFailed.push(`${entry.options.id}: ${e?.message ?? e}`);
			}
		}
		if (retried.length) {
			this.log(`[rlm] HMR[bun]: retried failed row(s) ${retried.join(", ")} — now running`);
			this.announce(`↻ ${retried.join(", ")} started after fix`);
		}
		if (stillFailed.length) this.log(`[rlm] HMR[bun]: retried failed row(s), still failing — ${stillFailed.join("; ")}`);
	}

	/**
	 * Row ids cordis would restart if `fiber` were replaced: every fiber that
	 * injects a service provided from inside it, and so on down. This is
	 * `Registry.notify` computed ahead of time rather than discovered.
	 */
	private restartReach(fiber: any): Set<string> {
		const ctx: any = this.ctx;
		const ids = new Set<string>();
		for (const g of dependentFibers(ctx.registry, fiber)) {
			try {
				const id = ctx.loader?.locate?.(g);
				if (id) ids.add(id);
			} catch {}
		}
		return ids;
	}

	/**
	 * Run `HMR_HANDOVER` on every live instance of `oldPlugin`'s class before it
	 * is disposed. A throw is logged and the swap goes ahead: the new generation
	 * starts from whatever is already on the Surface.
	 */
	private async handOver(oldPlugin: any, what: string) {
		const cls = typeof oldPlugin === "function" ? oldPlugin : undefined;
		if (!cls) return;
		let objects: object[] = [];
		try {
			objects = liveObjects(this.ctx);
		} catch {
			return;
		}
		for (const obj of objects) {
			let fn: unknown;
			try {
				if (!(obj instanceof cls)) continue;
				fn = (obj as any)[HMR_HANDOVER];
			} catch {
				continue;
			}
			if (typeof fn !== "function") continue;
			try {
				await fn.call(obj);
			} catch (e: any) {
				this.log(`[rlm] HMR: ${what} handover threw — swapping anyway: ${e?.message ?? e}`);
			}
		}
	}

	/**
	 * Reload under bun. See `./bun-reload.ts` for why there are two mechanisms.
	 *
	 * 1. Parse every changed file first. One that does not parse stops the pass
	 *    before anything is evicted, which is the rollback bun allows.
	 * 2. Patch in place: evaluate the changed files again (and, for files that
	 *    export functions, their importers) and copy each class's new methods
	 *    onto the class the process already holds.
	 * 3. Swap the rows that depend on a changed file and whose swap restarts
	 *    nothing pinned. Pinned-reaching rows keep running, patched.
	 */
	async bunReload(stashedURLs: string[]) {
		const ctx: any = this.ctx;
		const started = Date.now();
		const cache: Record<string, unknown> = require_.cache as any;
		const graph = (this.graph ??= new ImportGraph(this.root));
		const rel = (p: string) => relative(this.root, p);

		const changedAll = stashedURLs.map(urlToPathSafe).filter((p) => graph.tracks(p));
		const changed = changedAll.filter((p) => p in cache);
		// A row that FAILED at init is retried when its own source (or anything
		// in its package) changes. Before this nothing did: a failed row's module
		// is often not in the cache (so the pass stopped at "not loaded"), and a
		// swap only considered running rows — integration:FAILED stayed failed
		// after the fix that would have let it start.
		await this.retryFailedRows(changedAll, graph, cache);
		if (changed.length === 0) {
			const what = changedAll.length
				? `${changedAll.map(rel).join(", ")} not loaded in this process — the next import reads it fresh`
				: `${stashedURLs.length} change(s) outside the repo's tracked source — ignored`;
			this.log(`[rlm] HMR[bun]: ${what}`);
			return;
		}

		for (const p of changed) {
			const error = graph.check(p);
			if (error) {
				this.log(`[rlm] HMR[bun]: ${rel(p)} does not parse — nothing reloaded, running code untouched: ${error}`);
				this.announce(`⚠ ${basenameOf(p)} does not parse — kept running code`, "warn");
				return;
			}
		}

		const loaded = new Set(Object.keys(cache).filter((p) => graph.tracks(p)));
		const reverse = graph.importersOver(loaded);
		const affected = ancestors(changed, reverse);

		// ── Decide which rows can be swapped ─────────────────────────────────
		const pinned = new Set(this.config.pinned ?? DEFAULT_PINNED);
		const swaps: Array<{ id: string; path: string; fiber: any }> = [];
		const heldBack: string[] = [];
		for (const row of this.rowEntries()) {
			if (!affected.has(row.path)) continue;
			// Unknown reach is treated as reaching everything: hold the row back
			// and patch instead. A throw here must not stop the patch below — it
			// once did, when a half-finished edit to this file was patched in and
			// the reloader could then no longer load the edit that fixed it.
			let reach: Set<string>;
			try {
				reach = this.restartReach(row.fiber);
			} catch (e: any) {
				heldBack.push(`${row.id} (could not work out what it would restart: ${e?.message ?? e})`);
				continue;
			}
			// Loader ids are namespaced by tree ("95168bf2:renderer"); cordis.yml
			// and `pinned` name the row. Compared raw, nothing ever matched and
			// `agent` was swapped with `renderer` depending on it.
			const rowId = (id: string) => id.slice(id.lastIndexOf(":") + 1);
			const blocking = [row.id, ...reach].map(rowId).filter((id) => pinned.has(id));
			if (blocking.length) heldBack.push(`${row.id} (would restart ${blocking.join(", ")})`);
			else swaps.push(row);
		}
		const swapPaths = new Set(swaps.map((r) => r.path));

		// ── Patch in place ──────────────────────────────────────────────────
		// Which modules get evaluated again: the changed ones, plus importers of
		// any that export plain functions, since those bindings cannot be patched.
		const importOf = (p: string) => import(p) as Promise<Record<string, unknown>>;
		const before = new Map<string, Record<string, unknown>>();
		const reEval = new Set<string>(changed);
		for (const p of changed) before.set(p, await importOf(p));
		const maxDepth = this.config.importerDepth ?? 2;
		const maxCount = this.config.maxReEvaluated ?? 60;
		let frontier = changed.filter((p) => exportsFunctions(before.get(p)!));
		let capped = false;
		for (let depth = 0; depth < maxDepth && frontier.length && !capped; depth++) {
			const next: string[] = [];
			for (const p of frontier) {
				for (const imp of reverse.get(p) ?? []) {
					if (reEval.has(imp) || swapPaths.has(imp)) continue;
					if (reEval.size >= maxCount) {
						capped = true;
						break;
					}
					reEval.add(imp);
					const ns = await importOf(imp);
					before.set(imp, ns);
					if (exportsFunctions(ns)) next.push(imp);
				}
			}
			frontier = next;
		}
		if (capped) this.log(`[rlm] HMR[bun]: importer walk stopped at ${maxCount} modules (maxReEvaluated)`);

		for (const p of reEval) delete cache[p];
		const patched: string[] = [];
		const patchedPaths: string[] = [];
		const failed: string[] = [];
		for (const p of reEval) {
			try {
				const fresh = await importOf(p);
				const names = patchNamespace(before.get(p)!, fresh, p);
				if (names.length) {
					patched.push(`${rel(p)} [${names.join(", ")}]`);
					patchedPaths.push(p);
				}
			} catch (e: any) {
				failed.push(`${rel(p)}: ${e?.message ?? e}`);
			}
		}

		// ── Swap rows ────────────────────────────────────────────────────────
		const swapped: string[] = [];
		const swapStarted: any[][] = [];
		const getOuterStack = () => [];
		for (const row of swaps) {
			// The plugin the row is actually running, read off its fiber. Not the
			// cached namespace: a patch-only pass evaluates an entry file again
			// without swapping, so the cache can be a generation ahead of the
			// registry, and the registry is keyed by the callback it was given.
			const runtime = row.fiber?.runtime;
			const oldPlugin = runtime?.callback;
			if (!runtime || !oldPlugin || !ctx.registry.has(oldPlugin)) {
				failed.push(`${row.id}: no running plugin found for its module`);
				continue;
			}
			const closure = closureOf(row.path, graph, loaded);
			for (const p of closure) if (affected.has(p) && !reEval.has(p)) delete cache[p];
			let newPlugin: any;
			try {
				newPlugin = ctx.loader.unwrapExports(await importOf(row.path));
			} catch (e: any) {
				failed.push(`${row.id}: ${e?.message ?? e}`);
				continue;
			}
			if (!newPlugin || newPlugin === oldPlugin) continue;
			const oldFibers = [...runtime.fibers];
			const freshFibers: any[] = [];
			const replug = (plugin: any) => {
				for (const oldFiber of oldFibers) {
					const fiber = oldFiber.parent.registry.plugin(plugin, oldFiber._config, getOuterStack);
					fiber.entry = oldFiber.entry;
					if (fiber.entry) fiber.entry.fiber = fiber;
					freshFibers.push(fiber);
				}
			};
			swapStarted.push(freshFibers);
			await this.handOver(oldPlugin, row.id);
			try {
				ctx.registry.delete(oldPlugin);
			} catch (e: any) {
				this.log(`[rlm] HMR[bun]: failed to dispose ${row.id}: ${e?.message ?? e}`);
			}
			try {
				replug(newPlugin);
				swapped.push(row.id);
			} catch (e: any) {
				failed.push(`${row.id}: ${e?.message ?? e}`);
				try {
					ctx.registry.delete(newPlugin);
				} catch {}
				try {
					replug(oldPlugin);
				} catch {}
			}
		}

		// What `Entry.init` does after a plugin starts, and a swap bypasses it: a
		// fiber's startup is a loader task, so a row gated on
		// `inject({ loader: { await: true } })` — every `whenWatched` row,
		// rlm-hmr's own watchers included — sees "not settled" while it starts
		// and is only told otherwise by this notify. Without it a swapped row
		// came back with its gate shut: rlm-hmr swapped itself and stopped
		// watching.
		if (swapStarted.length) {
			await Promise.allSettled(swapStarted.flat().map((f) => f?.await?.()));
			try {
				if (!ctx.loader?.getTasks?.().length) ctx.reflect?.notify?.(["loader"]);
			} catch {}
		}

		// Patched instances still hold what their old code computed at init.
		// Tell them, so they can re-derive it — see HMR_PATCHED in bun-reload.ts.
		// After the swaps: a swapped row is a fresh instance and needs nothing.
		let rederived: string[] = [];
		if (patchedPaths.length) {
			try {
				rederived = await notifyPatched(ctx, patchedPaths);
			} catch (e: any) {
				failed.push(`re-derive: ${e?.message ?? e}`);
			}
		}

		const ms = Date.now() - started;
		const parts = [
			`${changed.map(rel).join(", ")} changed, ${reEval.size} evaluated again`,
			patched.length ? `patched ${patched.join("; ")}` : "no classes patched",
			rederived.length ? `re-derived ${rederived.join(", ")}` : "",
			swapped.length ? `swapped ${swapped.join(", ")}` : "",
			heldBack.length ? `held back ${heldBack.join("; ")}` : "",
			failed.length ? `FAILED ${failed.join("; ")}` : "",
		].filter(Boolean);
		this.log(`[rlm] HMR[bun]: ${parts.join(" | ")} (${ms}ms)`);
		if (failed.length) this.announce(`⚠ reload failed: ${failed.join("; ")}`, "warn");
		else if (patched.length || swapped.length) this.announce(`↻ reloaded ${changed.map(basenameOf).join(", ")}`);

		if (patched.length === 0 && swapped.length === 0) return;
		this.reloadCount++;
		this.lastReloaded = [...reEval, ...swaps.map((r) => r.path)].map((p) => pathToFileURL(p).href);
		// `rlm/hmr-reload` makes every live session re-derive its resources —
		// a full reload that restarts extensions. That is what a swapped row
		// needs (it may contribute tools or extensions). A patch-only pass has
		// already changed the running code and needs nothing from the session;
		// announcing it as a plugin reload turned every save into a resource
		// reload, and a burst of saves into a storm of them.
		try {
			if (swapped.length) ctx.emit("rlm/hmr-reload", { reloaded: this.lastReloaded });
			else ctx.emit("rlm/hmr-patched", { patched: this.lastReloaded });
		} catch {}
	}
}

export default RlmHmrService;
export const name = "omniroute-hmr";
export const inject = [] as const;
export { RlmHmrService as RlmHmr };

/** `packages/rlm-pixel/src/index.ts` → `rlm-pixel/index.ts`: short enough for the tray. */
function basenameOf(path: string): string {
	const parts = String(path).split(/[\\/]/).filter(Boolean);
	const file = parts.at(-1) ?? path;
	const pkg = parts.includes("src") ? parts[parts.lastIndexOf("src") - 1] : parts.at(-2);
	return pkg ? `${pkg}/${file}` : file;
}
