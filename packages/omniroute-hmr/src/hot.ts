/**
 * Hot handover for rows: what must not blink across a swap.
 *
 * Cordis swaps a row by disposing the old fiber and starting the new one. Its
 * `ctx.effect` disposers are the only cleanup that runs (Cordis 4.0.2 never
 * calls `[Service.stop]`, `[Service.dispose]` or `[Symbol.dispose]` — probe:
 * `{symbolDispose: 0, effectDisposer: 1}`). A socket, a child process, a watch
 * or a timer closed in that disposer and reopened by the successor blinks: a
 * port refuses connections, a child dies, a watch misses the event in between.
 *
 * `adopt` is the zero-gap version, the Erlang/Vite pattern in one call:
 *
 *   const server = adopt(ctx, "integration:server", () => listen(20130), (s) => s.close());
 *
 * The first generation creates the resource. A later generation with the same
 * key gets the SAME object back. Release runs only when the last owner is gone
 * and no successor adopted it within `graceMs` — so a swap (dispose, then init)
 * never releases it, and a row that is really removed releases it once. The
 * release function is always the newest one given, so a patch to the cleanup
 * code applies.
 *
 * `hotData` is the plain-data half (Vite's `import.meta.hot.data`): a mutable
 * object per key that outlives every generation, for values a row wants its
 * successor to start from (counters, caches, the last reconciled list).
 *
 * Both live on `globalThis`, so they survive this module being evaluated again.
 * Keys are the caller's; prefix them with the row id.
 */

type Held = {
	value: unknown;
	release: (value: any) => unknown;
	owners: number;
	timer?: ReturnType<typeof setTimeout>;
	graceMs: number;
};

const held = (): Map<string, Held> => ((globalThis as any).__rlmHotHeld ??= new Map());
const data = (): Map<string, Record<string, unknown>> => ((globalThis as any).__rlmHotData ??= new Map());

/** Only the parts of a Cordis Context this needs. */
export interface EffectHost {
	effect(fn: () => () => void, label?: string): unknown;
}

/**
 * Get or create a resource that outlives swaps of the row holding it.
 * @param ctx the row's context — ownership ends with its fiber.
 * @param key stable across generations, e.g. "integration:server:20130".
 * @param create called once, by the first owner.
 * @param release called once, when no owner remains after `graceMs`.
 * @param graceMs how long an orphaned resource waits for a successor. Default 3000.
 */
export const adopt = <T>(
	ctx: EffectHost,
	key: string,
	create: () => T,
	release: (value: T) => unknown,
	graceMs = 3000,
): T => {
	const store = held();
	let h = store.get(key);
	if (h) {
		if (h.timer) clearTimeout(h.timer);
		h.timer = undefined;
		h.owners++;
	} else {
		h = { value: create(), release, owners: 1, graceMs };
		store.set(key, h);
	}
	h.release = release;
	h.graceMs = graceMs;
	const mine = h;
	ctx.effect(() => () => {
		mine.owners--;
		if (mine.owners > 0) return;
		if (mine.timer) clearTimeout(mine.timer);
		mine.timer = setTimeout(() => {
			if (mine.owners > 0 || store.get(key) !== mine) return;
			store.delete(key);
			try {
				void Promise.resolve(mine.release(mine.value)).catch(() => {});
			} catch {}
		}, mine.graceMs);
		(mine.timer as any).unref?.();
	}, `hot:${key}`);
	return h.value as T;
};

/** Is a resource held under `key` right now (owned, or waiting for a successor)? */
export const isHeld = (key: string): boolean => held().has(key);

/** Release a held resource now, whoever owns it. For explicit shutdown paths. */
export const releaseNow = (key: string): void => {
	const h = held().get(key);
	if (!h) return;
	held().delete(key);
	if (h.timer) clearTimeout(h.timer);
	try {
		void Promise.resolve(h.release(h.value)).catch(() => {});
	} catch {}
};

/** Mutable data that every generation of a row shares. */
export const hotData = <T extends Record<string, unknown> = Record<string, unknown>>(key: string): T => {
	const store = data();
	let d = store.get(key);
	if (!d) store.set(key, (d = {}));
	return d as T;
};

/**
 * An interval that keeps ticking across swaps and always calls the newest
 * callback: the timer is adopted (never cleared by a swap), the callback is
 * replaced by each generation.
 */
export const adoptInterval = (ctx: EffectHost, key: string, ms: number, tick: () => unknown): void => {
	const slot = adopt(
		ctx,
		key,
		() => {
			const s: { tick: () => unknown; timer?: ReturnType<typeof setInterval> } = { tick };
			s.timer = setInterval(() => {
				try {
					void Promise.resolve(s.tick()).catch(() => {});
				} catch {}
			}, ms);
			(s.timer as any).unref?.();
			return s;
		},
		(s) => clearInterval(s.timer),
	);
	slot.tick = tick;
};
