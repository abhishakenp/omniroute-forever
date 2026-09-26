/**
 * "Is anybody watching?", asked by the row that would pay for the answer.
 *
 * ## Why this is not an `inject`
 *
 * The first version of the headless row parked expensive rows by naming
 * `rlmLive` in their `inject`, and withholding that token when nobody was
 * watching. It worked, and it had one fault that outweighed everything it
 * bought: **the composition could no longer be reduced.** Delete the headless
 * row from `cordis.yml` and nothing provides `rlmLive` at all, so every row
 * that named it waits for ever — hot reload and the renderer silently off, in
 * a composition that never mentions headlessness. Removing the row turned rlm
 * off instead of returning it to stock, which is backwards: the absence of a
 * policy row has to mean the absence of the policy.
 *
 * So the question is asked at the use site instead. No row present →
 * `ctx.get("rlmHeadless")` is `undefined` → nobody has an opinion → the row
 * does what it always did. That is the same shape `rlm-pixel` already uses
 * for its warm index and `rlm-delegate` for its child flags.
 *
 * ## The race the old comment was right about
 *
 * The headless row's header argued that `inject` was the only race-free
 * mechanism available, and for a naive `ctx.get` inside `apply` that is
 * correct. Rows mount concurrently — the loader creates every entry in one
 * `Promise.allSettled` — and cordis refuses to hand out a service whose own
 * fiber is still LOADING: `ReflectService._getImpl` returns nothing unless
 * `impl.fiber.state === ACTIVE`. A row probing during its own `apply` can
 * therefore be told "nobody has an opinion" purely because the headless row
 * has not finished starting, and for `hmr` that answer costs ~1,283 file
 * watches which then have to be closed again. Opening first and asking later
 * wastes exactly what this exists to save.
 *
 * The fix is not to ask earlier. It is to **ask later, but before committing
 * anything.** `ctx.inject(deps, callback)` is not the static `inject`
 * property: it mounts a *child* fiber that parks until its dependencies are
 * satisfied, leaving the calling row ACTIVE throughout. Depend on the loader
 * with `{ await: true }` and that child cannot run until the loader tree has
 * no entry still importing or settling — that is `Loader[Service.check]`,
 * which answers `false` while `getTasks()` is non-empty. By the time the
 * callback runs every row has either reached ACTIVE or failed, so the probe
 * sees the headless row if there is one, and genuinely nothing if there is
 * not.
 *
 * Nothing is opened and then closed. It is not opened — the property `inject`
 * had, without the property that made the composition unreducible.
 *
 * ## Staying answerable afterwards
 *
 * `rlmHeadless.set(false)` is meant to bring hot reload up inside a running
 * rlm, and a probe taken once at boot would have quietly dropped that. So the
 * verdict is re-read whenever cordis announces a change to either name:
 * `rlmLive` moves when the verdict is switched by hand, and `rlmHeadless`
 * itself moves when the row is added to or removed from a running
 * composition. Both arrive as `internal/service`, which is how `rlm-delegate`
 * already re-attaches its prompt fragments.
 */

/** Names whose arrival or departure can change the answer. */
const WATCHED = new Set(["rlmHeadless", "rlmLive"]);

/**
 * The verdict, defaulting to "yes" when nobody is claiming otherwise.
 *
 * The `: true` branch is the whole requirement in one line: a composition with
 * no headless row is a composition where somebody is watching, because that is
 * what rlm did before the row existed.
 *
 * `live` rather than `!on`, and the fallback matters. They are not each
 * other's negation: headless became a fact about a *session* once one process
 * started holding many agents, so a headless worker that is attending one of
 * them is live. `live` is the predicate the headless row itself uses to decide
 * whether to hand out `rlmLive`, so reading it is what keeps the token and
 * this probe from ever disagreeing. `!on` is kept only for an older build of
 * that row that has no `live` — better a slightly stale answer than a crash.
 */
export const watching = (ctx: any): boolean => {
	const verdict = ctx?.get?.("rlmHeadless") as { live?: boolean; on?: boolean } | undefined;
	if (!verdict) return true;
	return typeof verdict.live === "boolean" ? verdict.live : !verdict.on;
};

/**
 * Run `open` while somebody is watching, and not before it is known whether
 * anybody is.
 *
 * `open` returns its own disposer, which is called if the verdict later turns
 * the other way. The whole gate is registered through `ctx.effect`, so a hot
 * reload of the calling row takes the listener — and whatever `open` returned
 * — away with it.
 *
 * `row` is only how this announces itself to `explain()`. It is the name a
 * person reads in "not started: …", so it should match the id in `cordis.yml`.
 */
export const whenWatched = (ctx: any, row: string, open: () => (() => void) | void): void => {
	let close: (() => void) | undefined;
	let running: boolean | undefined;
	/** Until the loader has settled, an absent verdict means "not yet", not "no". */
	let settled = false;

	const headless = () =>
		ctx?.get?.("rlmHeadless") as { deferred?: (row: string) => void; resumed?: (row: string) => void } | undefined;

	/** Telling the report what happened must never be able to fail the row. */
	const announce = (method: "deferred" | "resumed") => {
		try {
			headless()?.[method]?.(row);
		} catch {
			/* the row's job is the watcher, not the paperwork */
		}
	};

	const decide = () => {
		if (!settled) return;
		const live = watching(ctx);
		if (live === running) return;
		running = live;
		if (live) {
			close = open() ?? undefined;
			announce("resumed");
		} else {
			try {
				close?.();
			} catch {
				/* a disposer that throws must not strand the verdict */
			}
			close = undefined;
			announce("deferred");
		}
	};

	ctx.effect(() => {
		const off = ctx.on?.("internal/service", (key: string) => {
			if (WATCHED.has(key)) decide();
		});
		return () => {
			try {
				off?.();
			} catch {}
			try {
				close?.();
			} catch {}
			close = undefined;
			running = undefined;
			announce("resumed");
		};
	}, `${row}: live gate`);

	// A composition with no loader — a unit test mounting this row by hand — has
	// nothing to wait for and nothing to race with, so it is answered at once
	// rather than left parked for ever.
	// OmniRoute copy: there is no `rlmHeadless` row in this composition, so
	// there is no verdict to wait for — and `inject({ loader: { await: true } })`
	// never fires here (measured: the include's loader does not report settled
	// while the gateway row holds a live Bun.serve), which left the watcher
	// uninstalled for the life of the process. Answer at once; edits made while
	// rows are still mounting are covered by catchUpBoot().
	settled = true;
	decide();
};
