/**
 * Hot reload for processes nobody is watching.
 *
 * A headless rlm — the drive sweep, a pool worker, a daemon worker nobody is
 * attached to — does not open rlm-hmr's recursive watcher over `packages/`,
 * because under bun that is ~1,283 file watches per process (see `./live.ts`).
 * Until this existed that meant a headless process ran its boot code for ever.
 * rlm-guard showed what that costs: the protected list was changed and every
 * interactive rlm re-derived it, while a headless sweep kept writing its boot
 * snapshot of `cordis.yml` back over every edit.
 *
 * So a watched process, which already sees every change, writes each debounced
 * batch to one small file, and an unwatched one polls that file — one `stat`
 * every `intervalMs` — and runs the same reload pipeline on what it names.
 * Each process still decides for itself what it has loaded and how to reload
 * it; the file only carries "these paths changed".
 *
 * The limit, stated: a change made while no watched rlm is running is not
 * broadcast. A headless process started after it reads the file fresh anyway;
 * one already running learns it at the next broadcast that names the file, or
 * on restart.
 */
import { mkdirSync, renameSync, statSync, unwatchFile, watchFile, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// OmniRoute copy: the epoch file lives with the gateway's data, never in rlm's
// agent dir — sharing it would make rlm and OmniRoute replay each other's edits.
export const defaultEpochFile = (): string =>
	join(process.env.DATA_DIR || join(homedir(), ".omniroute"), "hmr-epoch.json");

interface Epoch {
	at: number;
	pid: number;
	urls: string[];
}

/** Record a batch. Atomic (write + rename), so a reader never sees half a file. */
export const broadcast = (urls: string[], file = defaultEpochFile()): void => {
	if (!urls.length) return;
	try {
		mkdirSync(dirname(file), { recursive: true });
		const tmp = `${file}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify({ at: Date.now(), pid: process.pid, urls } satisfies Epoch));
		renameSync(tmp, file);
	} catch {
		/* best effort: the watched process has already reloaded itself */
	}
};

const mtimeOf = (url: string): number => {
	try {
		return statSync(url.startsWith("file:") ? fileURLToPath(url) : url).mtimeMs;
	} catch {
		return -1;
	}
};

/**
 * Poll `file`; call `onUrls` with each broadcast's paths whose content this
 * process has not already been told about (keyed by path + mtime, so several
 * watched processes broadcasting the same save reload it once). `active()` is
 * asked per event: a watched process has its own watcher and ignores the file.
 */
export const follow = (
	onUrls: (urls: string[]) => void,
	active: () => boolean,
	options: { file?: string; intervalMs?: number } = {},
): (() => void) => {
	const file = options.file ?? defaultEpochFile();
	const seen = new Map<string, number>();
	const listener = () => {
		if (!active()) return;
		let epoch: Epoch;
		try {
			epoch = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			return;
		}
		if (epoch.pid === process.pid || !Array.isArray(epoch.urls)) return;
		const fresh = epoch.urls.filter((url) => {
			const m = mtimeOf(url);
			if (seen.get(url) === m) return false;
			seen.set(url, m);
			return true;
		});
		if (fresh.length) onUrls(fresh);
	};
	watchFile(file, { interval: options.intervalMs ?? 2000 }, listener);
	// `watchFile` only reports changes after it starts. A batch broadcast while
	// this process was booting would be missed, so read the current epoch once:
	// if it was written after this process started, apply it.
	const bootAt = Date.now() - process.uptime() * 1000;
	const initial = setTimeout(() => {
		try {
			const epoch = JSON.parse(readFileSync(file, "utf8")) as Epoch;
			if (epoch.at >= bootAt) listener();
		} catch {}
	}, 0);
	(initial as any).unref?.();
	return () => {
		clearTimeout(initial);
		unwatchFile(file, listener);
	};
};
