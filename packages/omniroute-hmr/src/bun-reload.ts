/**
 * Module hot reload under bun.
 *
 * ## Why this exists
 *
 * rlm is launched as `bun cordis-shell.mjs`. Both reload engines it had —
 * `@deepseek-ai/cordis-plugin-hmr` and `rlm-hmr`'s own node path — walk Node's
 * internal ESM `loadCache`, which only exists under `node --expose-internals`.
 * Under bun both were inert: every edit was noticed ("HMR: … changed") and then
 * dropped ("loader.internal unavailable — cannot reload"), so an edit reached a
 * running rlm only through a restart. For a program whose point is to change
 * itself while it runs, that is the property missing.
 *
 * Bun has what is needed, just spelled differently, and both halves were
 * measured before this was written:
 *
 * - `delete require.cache[path]` evicts an ES module, and the next
 *   `import(path)` evaluates the file again. Modules still in the cache are
 *   shared, so evicting only the file that changed keeps every singleton it
 *   imports (theme, settings, loggers) the one the process already has.
 * - `Bun.Transpiler#scanImports` lists a file's static imports with type-only
 *   imports already erased, and `Bun.resolveSync` maps `./x.js` to `./x.ts` the
 *   same way the runtime does. That is the dependency graph the node path reads
 *   out of `loadCache`, built from the files instead.
 *
 * One thing bun does not have: putting a saved entry back into
 * `require.cache` after a failed import does not restore it — the failure is
 * remembered until the file changes. So there is no cache rollback here.
 * Instead a batch is transpiled *before* anything is evicted; a file that does
 * not parse leaves the cache, the fibers and the live objects untouched, and
 * the next save that parses is picked up normally.
 *
 * ## Two ways a change reaches running code
 *
 * **Fiber swap** — the documented mechanism (cordis.yml, "Hot reload,
 * accurately"): evict the changed modules and everything between them and a
 * row's entry, import the entry again, `registry.delete(old)` and
 * `registry.plugin(new, oldFiber._config)`. Used for rows whose swap cannot
 * reach a live session.
 *
 * It cannot be used for every row. Cordis re-runs every fiber that injects a
 * service whose provider changed (`Registry.notify` → `_refresh` → a new
 * epoch), so swapping `config`, `session`, `tools`, `refine` or `agent`
 * restarts `renderer`, and restarting `renderer` calls `InteractiveMode.stop()`
 * and disposes the runtime: the user's session ends. The same is true for
 * `interactive-mode.ts` and `agent-session.ts`, which no row imports
 * statically at all — the renderer `import()`s the interactive graph when it
 * starts, so a swap would not even reach the instance that is on screen.
 *
 * **Patch in place** — for everything a swap would lose or cannot reach: the
 * changed file is imported again, and every class it exports has its methods,
 * getters and static methods copied onto the class object the running process
 * already holds. Live instances look methods up through that prototype, so the
 * next call runs the new code, with the instance's state untouched. Nothing is
 * disposed and nothing restarts.
 *
 * Limits of patching, stated rather than hidden:
 * - Constructor-time state is not re-run. When the new code reads a field the
 *   old class never mentioned, instances built before the reload keep running
 *   the methods they were built with (decided per call, see `guarded`); only
 *   instances created afterwards — or ones that later gain the field — run the
 *   new code. A handler bound in the constructor as an arrow function or with
 *   `.bind` is fixed at construction and never changes.
 * - A module is evaluated again, so its module-level `let`/`Map`/`Set` start
 *   fresh for the new code while the old closures keep theirs.
 * - Plain functions cannot be patched into modules that already imported them.
 *   When a changed file exports functions, the modules that import it are
 *   evaluated again too (up to `importerDepth` levels) so the classes in them —
 *   whose methods call those functions — are patched against the new copy.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";

type Loader = "ts" | "tsx" | "js" | "jsx";

const LOADER_BY_EXT: Record<string, Loader> = {
	".ts": "ts",
	".mts": "ts",
	".cts": "ts",
	".tsx": "tsx",
	".js": "js",
	".mjs": "js",
	".cjs": "js",
	".jsx": "jsx",
};

/** True when running under bun, where this path applies. */
export const isBun = (): boolean => typeof (globalThis as any).Bun !== "undefined";

/**
 * The static import graph of the repo's own source, built from the files.
 *
 * Scans are cached per path and mtime, so a reload pass re-reads only the files
 * that changed since the last one.
 */
export class ImportGraph {
	private scans = new Map<string, { mtimeMs: number; deps: string[] }>();
	private transpilers = new Map<Loader, any>();

	private readonly root: string;

	/** `root` may arrive with a trailing separator (a composition's baseUrl does). */
	constructor(root: string) {
		this.root = resolve(root);
	}

	/** Repo source, not a dependency and not something bun cannot parse. */
	tracks(path: string): boolean {
		return (
			path.startsWith(this.root + sep) &&
			!path.includes(`${sep}node_modules${sep}`) &&
			extname(path) in LOADER_BY_EXT
		);
	}

	private transpiler(loader: Loader) {
		let t = this.transpilers.get(loader);
		if (!t) {
			t = new (globalThis as any).Bun.Transpiler({ loader });
			this.transpilers.set(loader, t);
		}
		return t;
	}

	/**
	 * Parse without evaluating. Returns the error text, or null when the file
	 * would load. Used before anything is evicted.
	 */
	check(path: string): string | null {
		try {
			const loader = LOADER_BY_EXT[extname(path)] ?? "ts";
			this.transpiler(loader).transformSync(readFileSync(path, "utf8"));
			return null;
		} catch (e: any) {
			return String(e?.message ?? e);
		}
	}

	/** Absolute paths of the repo files this file statically imports. */
	depsOf(path: string): string[] {
		let mtimeMs = 0;
		try {
			mtimeMs = statSync(path).mtimeMs;
		} catch {
			return [];
		}
		const hit = this.scans.get(path);
		if (hit && hit.mtimeMs === mtimeMs) return hit.deps;
		const deps: string[] = [];
		try {
			const loader = LOADER_BY_EXT[extname(path)] ?? "ts";
			const imports = this.transpiler(loader).scanImports(readFileSync(path, "utf8")) as Array<{
				kind: string;
				path: string;
			}>;
			for (const imp of imports) {
				// OmniRoute copy: dynamic `import()` counts. The gateway row imports
				// thinGateway.ts, parseChatBody.ts and the route modules dynamically
				// (the store must open first), so without these edges a change to the
				// router re-evaluated only itself and never reached the live gateway.
				if (imp.kind !== "import-statement" && imp.kind !== "require-call" && imp.kind !== "dynamic-import")
					continue;
				try {
					const resolved = (globalThis as any).Bun.resolveSync(imp.path, dirname(path)) as string;
					if (this.tracks(resolved)) deps.push(resolved);
				} catch {}
			}
		} catch {}
		this.scans.set(path, { mtimeMs, deps });
		return deps;
	}

	/** importer → [imported] over the given modules, reversed to imported → importers. */
	importersOver(modules: Iterable<string>): Map<string, Set<string>> {
		const reverse = new Map<string, Set<string>>();
		const loaded = new Set(modules);
		for (const m of loaded) {
			for (const dep of this.depsOf(m)) {
				if (!loaded.has(dep)) continue;
				let set = reverse.get(dep);
				if (!set) reverse.set(dep, (set = new Set()));
				set.add(m);
			}
		}
		return reverse;
	}
}

/** Every module that reaches one of `start` through static imports, `start` included. */
export const ancestors = (start: Iterable<string>, reverse: Map<string, Set<string>>): Set<string> => {
	const seen = new Set<string>();
	const queue = [...start];
	while (queue.length) {
		const m = queue.pop()!;
		if (seen.has(m)) continue;
		seen.add(m);
		for (const up of reverse.get(m) ?? []) queue.push(up);
	}
	return seen;
};

/** Everything `entry` reaches through static imports, `entry` included. */
export const closureOf = (entry: string, graph: ImportGraph, loaded: Set<string>): Set<string> => {
	const seen = new Set<string>();
	const queue = [entry];
	while (queue.length) {
		const m = queue.pop()!;
		if (seen.has(m) || !loaded.has(m)) continue;
		seen.add(m);
		for (const dep of graph.depsOf(m)) queue.push(dep);
	}
	return seen;
};

/**
 * The fiber itself, not the thenable `registry.plugin()` hands back.
 *
 * Cordis returns `Object.create(fiber)` with an own `then`, and the loader
 * stores that as `entry.fiber`. Services record the raw fiber as their
 * provider, so comparing against the wrapper never matches — which is how a
 * swap of `agent` was once judged safe while `renderer` injects `rlmAgent`.
 */
export const rawFiber = (f: any): any => (f && Object.hasOwn(f, "then") ? Object.getPrototypeOf(f) : f);

/**
 * Every fiber cordis would restart if `fiber` were replaced: each one that
 * injects a service provided from inside it (its own fiber or a child fiber it
 * mounted), and so on down. `Registry.notify` computed ahead of time.
 */
export const dependentFibers = (registry: { values(): Iterable<any> }, fiber: any): Set<any> => {
	const root = rawFiber(fiber);
	const within = (f: any, ancestor: any) => {
		for (let cur = rawFiber(f); cur; ) {
			if (cur === ancestor) return true;
			const next = cur.parent?.fiber;
			if (!next || next === cur) return false;
			cur = next;
		}
		return false;
	};
	const reached = new Set<any>();
	const queue = [root];
	while (queue.length) {
		const source = queue.pop();
		for (const runtime of registry.values()) {
			for (const g of runtime.fibers ?? []) {
				if (g === root || reached.has(g)) continue;
				for (const name of Object.keys(g.inject ?? {})) {
					const impl = g._store?.[name];
					if (impl?.fiber && within(impl.fiber, source)) {
						reached.add(g);
						queue.push(g);
						break;
					}
				}
			}
		}
	}
	return reached;
};

const isClass = (value: unknown): value is Function =>
	typeof value === "function" &&
	!!(value as any).prototype &&
	/^class[\s{]/.test(Function.prototype.toString.call(value));

const STATIC_SKIP = new Set<PropertyKey>(["length", "name", "prototype", "caller", "arguments"]);

/** Every `this.x` a class's source mentions. */
const thisRefs = (cls: Function): Set<string> => {
	const refs = new Set<string>();
	for (const m of Function.prototype.toString.call(cls).matchAll(/this\.([A-Za-z_$][\w$]*)/g)) refs.add(m[1]!);
	return refs;
};

/**
 * Fields the new code reads that the live class never did — state only the new
 * constructor sets up, so an instance built by the old one does not have it.
 *
 * Without this, a method that grew a field was patched onto instances that
 * lack it and threw on first use: `InProcessAgentConnection.dispose` read
 * `this.connectionOptions` on a connection made before the reload, `/quit`
 * threw half way through shutdown, and the TUI was left with the terminal
 * released and the process still alive.
 */
const newFields = (live: Function, next: Function): string[] => {
	const before = thisRefs(live);
	return [...thisRefs(next)].filter((f) => !before.has(f));
};

/**
 * A prototype member that runs the new code on instances that have everything
 * it reads, and the code the instance was built with on those that do not.
 * Decided per call and per instance, so nothing runs twice.
 */
const guarded = (
	desc: PropertyDescriptor,
	old: PropertyDescriptor | undefined,
	needs: string[],
): PropertyDescriptor => {
	const ready = (self: any) => self == null || needs.every((f) => f in Object(self));
	const pick = <K extends "value" | "get" | "set">(k: K) => {
		const fresh = desc[k] as any;
		const prior = old?.[k] as any;
		if (typeof fresh !== "function" || typeof prior !== "function") return fresh;
		return function (this: any, ...args: any[]) {
			return (ready(this) ? fresh : prior).apply(this, args);
		};
	};
	if ("value" in desc) return { ...desc, value: pick("value") };
	return { ...desc, get: pick("get"), set: pick("set") };
};

/**
 * Copy `next`'s behaviour onto `live`, the class the process already holds.
 *
 * Prototype members are replaced — they are behaviour — except that an
 * instance lacking a field the new code reads keeps the member it was built
 * with (see `newFields`). Static data is only added, never overwritten,
 * because it is state (counters, registries) that the running instances share.
 */
export const patchClass = (live: Function, next: Function): number => {
	if (live === next) return 0;
	let patched = 0;
	const proto = (next as any).prototype;
	const liveProto = (live as any).prototype;
	const needs = newFields(live, next);
	for (const key of Reflect.ownKeys(proto)) {
		if (key === "constructor") continue;
		const existing = Object.getOwnPropertyDescriptor(liveProto, key);
		if (existing && !existing.configurable) continue;
		const desc = Object.getOwnPropertyDescriptor(proto, key)!;
		// The hook is never guarded: it is where an old instance is brought up to
		// the new code — including setting up the very fields `needs` names — so
		// falling back to "the code it was built with" would mean never running.
		const guard = needs.length && key !== HMR_PATCHED;
		Object.defineProperty(liveProto, key, guard ? guarded(desc, existing, needs) : desc);
		patched++;
	}
	for (const key of Reflect.ownKeys(next)) {
		if (STATIC_SKIP.has(key)) continue;
		const desc = Object.getOwnPropertyDescriptor(next, key)!;
		const existing = Object.getOwnPropertyDescriptor(live, key);
		if (existing && !existing.configurable) continue;
		const behaviour = typeof desc.value === "function" || desc.get || desc.set;
		if (!behaviour && existing) continue;
		Object.defineProperty(live, key, desc);
		patched++;
	}
	return patched;
};

/**
 * Every class object each module has ever exported in this process, by path
 * and export name.
 *
 * Each reload evaluates a module again and so mints a new class object, and
 * instances of every earlier one can still be alive: the ones created before
 * the first reload hold the original, the ones a freshly imported module
 * created since hold a later one. Patching only the previous namespace would
 * update the latest generation and leave the objects on screen behind — which
 * is exactly what happened on the second edit before this existed.
 *
 * Kept on globalThis so it survives rlm-hmr reloading itself.
 */
type Generations = Map<string, Map<string, Set<Function>>>;
const generations = (): Generations =>
	((globalThis as any).__rlmHmrClassGenerations ??= new Map()) as Generations;

/**
 * Patch every class `next` exports onto every earlier generation of it, and
 * record `next` as one more. `live` is the namespace that was current before
 * this evaluation. Returns the export names patched.
 */
export const patchNamespace = (
	live: Record<string, unknown>,
	next: Record<string, unknown>,
	path = "",
): string[] => {
	const byName = generations().get(path) ?? new Map<string, Set<Function>>();
	if (path) generations().set(path, byName);
	const names: string[] = [];
	for (const key of Object.keys(next)) {
		const b = next[key];
		if (!isClass(b)) continue;
		const known = byName.get(key) ?? new Set<Function>();
		const a = live[key];
		if (isClass(a)) known.add(a);
		let patched = 0;
		for (const old of known) if (old !== b) patched += patchClass(old, b);
		known.add(b);
		if (path) byName.set(key, known);
		if (patched > 0) names.push(key);
	}
	return names;
};

/**
 * The last-resort reload: evaluate each loaded file again and patch its
 * classes, with no graph, no swaps and nothing from the reloader's own class.
 * Used when a full pass throws, so a broken edit to the reloader cannot stop it
 * loading the edit that fixes it. Returns "path [Class, …]" per patched file.
 */
export const patchInPlace = async (paths: string[], cache: Record<string, unknown>): Promise<string[]> => {
	const done: string[] = [];
	for (const p of paths) {
		if (!(p in cache)) continue;
		try {
			const before = (await import(p)) as Record<string, unknown>;
			delete cache[p];
			const names = patchNamespace(before, (await import(p)) as Record<string, unknown>, p);
			if (names.length) done.push(`${p} [${names.join(", ")}]`);
		} catch {}
	}
	return done;
};

/** Whether a namespace exports anything callable that is not a class. */
export const exportsFunctions = (ns: Record<string, unknown>): boolean =>
	Object.values(ns).some((v) => typeof v === "function" && !isClass(v));

export const exportsClasses = (ns: Record<string, unknown>): boolean => Object.values(ns).some(isClass);

/* ───────────────────────── after a patch: live instances ───────────────────────── */

/**
 * The hook a live object implements to re-derive what it computed once, from
 * code that has just changed under it.
 *
 * Patching replaces behaviour; it cannot redo work a constructor or
 * `[Service.init]` already did with the old code. rlm-guard is the case that
 * made this necessary: its protected list is resolved at init, so a reload that
 * removed `cordis.yml` from the list was patched into every running process —
 * and every one of them went on putting `cordis.yml` back.
 *
 * Contract, for anyone implementing it:
 *
 *   - `obj[Symbol.for("rlm.hmr.patched")](info)` is called after every patch
 *     pass that touched a class in `obj`'s prototype chain. `info.paths` are the
 *     absolute paths evaluated again. It may be async; it is awaited, one object
 *     at a time, and a throw is logged, never fatal.
 *   - It runs the NEW code on the OLD instance, and it is never guarded by
 *     `newFields`: it is where fields the new code needs get set up. Other
 *     members start running new code on that instance as soon as it has them.
 *   - Zero downtime is the implementer's job: build the replacement state
 *     first, then swap it in, then tear the old down. Never dispose first.
 *   - It must be idempotent — a burst of saves calls it once per pass.
 *
 * Who gets called: every service in the cordis registry (`ctx.reflect.store` —
 * all rows that `provide` something), plus anything that opted in with
 * `registerLive(obj)` (held weakly). A plain object nothing provides and nothing
 * registered — e.g. a kernel made before this existed — cannot be found.
 */
export const HMR_PATCHED: unique symbol = Symbol.for("rlm.hmr.patched") as any;

type LiveSet = Set<WeakRef<object>>;
const liveSet = (): LiveSet => ((globalThis as any).__rlmHmrLive ??= new Set()) as LiveSet;

/** Opt a non-service object in to `HMR_PATCHED` calls. Weak: it never keeps `obj` alive. */
export const registerLive = (obj: object): void => {
	liveSet().add(new WeakRef(obj));
};

/** Every class object recorded for `paths`, all generations. */
const classesOf = (paths: Iterable<string>): Set<Function> => {
	const out = new Set<Function>();
	for (const p of paths) for (const set of generations().get(p)?.values() ?? []) for (const c of set) out.add(c);
	return out;
};

const madeBy = (obj: object, classes: Set<Function>): boolean => {
	for (let p = Object.getPrototypeOf(obj); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
		if (classes.has(p.constructor)) return true;
	}
	return false;
};

/** Live objects reachable right now: provided services, then opted-in objects. */
export const liveObjects = (ctx: any): object[] => {
	const seen = new Set<object>();
	const store = ctx?.reflect?.store;
	if (store) {
		for (const key of Reflect.ownKeys(store)) {
			const value = store[key as any]?.value;
			if (value && typeof value === "object") seen.add(value);
		}
	}
	for (const ref of liveSet()) {
		const obj = ref.deref();
		if (obj) seen.add(obj);
		else liveSet().delete(ref);
	}
	return [...seen];
};

/**
 * Call `HMR_PATCHED` on every live object built by a class from `paths`.
 * Returns one line per object: `Name` on success, `Name: error` on a throw.
 */
export const notifyPatched = async (ctx: any, paths: string[]): Promise<string[]> => {
	const classes = classesOf(paths);
	if (!classes.size) return [];
	const done: string[] = [];
	for (const obj of liveObjects(ctx)) {
		const hook = (obj as any)[HMR_PATCHED];
		if (typeof hook !== "function" || !madeBy(obj, classes)) continue;
		const name = (obj as any).constructor?.name ?? "object";
		try {
			await hook.call(obj, { paths });
			done.push(name);
		} catch (e: any) {
			done.push(`${name}: ${e?.message ?? e}`);
		}
	}
	return done;
};
