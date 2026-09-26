/**
 * @rlm/hmr/official — the upstream module-reload plugin, mounted only when
 * somebody is watching.
 *
 * ## Why there is a wrapper at all
 *
 * `@deepseek-ai/cordis-plugin-hmr` is the row that costs the most to start and
 * is worth the least to a fifteen-second `--print` child: chokidar cannot
 * resolve `fsevents` in this repo, so it falls back to one `fs.watch` per file
 * and holds ~1,283 descriptors over `packages/` — every README, CHANGELOG,
 * PNG and `.pyc` — all of them stat'd and opened inside `[Service.init]`,
 * before the first token is asked for. Nothing edits a file during a one-shot
 * answer.
 *
 * It is also a package, not a file in this repo, so it cannot be taught to ask
 * whether anybody is watching. Every other expensive row in this composition
 * answers that question itself at its own use site (see `./live.ts` for why
 * that replaced `inject: ['rlmLive']`). This row is the one that cannot, so
 * the question is asked *around* it instead: the wrapper is a normal row that
 * always mounts and costs nothing, and the plugin underneath it is mounted as
 * a child fiber only once the composition has settled and the verdict is
 * known.
 *
 * The alternative was to leave this one row on `inject`, and it is not
 * acceptable: `inject: ['rlmLive']` is exactly what makes deleting the
 * headless row turn hot reload off instead of on. One row keeping the old
 * mechanism would keep the old bug for that row.
 *
 * ## What is preserved
 *
 * - **The service name.** The upstream class calls `super(ctx, 'hmr')`, so the
 *   child fiber still provides `hmr`, and `rlm-hmr`'s `isBridging` probe —
 *   `!!this.ctx.get('hmr')` — keeps working unchanged. That probe is
 *   deliberately evaluated late, at event time, which is what lets it notice
 *   the child arriving after it did.
 * - **The config.** Whatever `cordis.yml` writes here is handed to the plugin
 *   verbatim and validated by its own schema, which supplies the defaults.
 * - **The module cost.** The import is dynamic and inside the gate, so an
 *   unwatched run does not parse chokidar, picomatch and `@babel/code-frame`
 *   at all. Under `inject` it did: the loader must import a row's module to
 *   discover the plugin object, even for a row whose fiber then parks for
 *   ever. This is strictly cheaper than what it replaces.
 */
import { whenWatched } from "./live.ts";

export const name = "rlm-hmr-official";

/** Nothing. The gate waits on the loader itself, from inside. */
export const inject = [] as const;

/**
 * Passed straight through to `@deepseek-ai/cordis-plugin-hmr`.
 *
 * Deliberately loose: the upstream `Config` extends chokidar's options, its
 * schema fills in every default, and mirroring the full list here would be one
 * more thing to keep in step with a package this repo does not own.
 */
export interface OfficialHmrConfig {
	/** Directories to watch, relative to the composition. Upstream default `['.']`. */
	root?: string[];
	/** Globs never watched. Upstream default `['**\/node_modules', '**\/.*', 'cache', 'data']`. */
	ignored?: string[];
	/** Milliseconds to gather a burst of changes into one reload. Upstream default 100. */
	debounce?: number;
	/** Anything else chokidar accepts. */
	[key: string]: unknown;
}

export const configFields = [
	{
		key: "root",
		type: "string[]",
		default: ["packages"],
		description:
			"Directories whose files are watched for module changes, relative to the repository. Every file under these is opened, so this is the setting that decides what hot reload costs.",
	},
	{
		key: "ignored",
		type: "string[]",
		default: ["**/node_modules", "**/dist", "**/.*"],
		description: "Globs never watched, however deep under a root they are.",
	},
	{
		key: "debounce",
		type: "number",
		default: 100,
		description: "Milliseconds to gather a burst of edits into a single reload.",
	},
];

export const apply = (ctx: any, config: OfficialHmrConfig = {}) => {
	whenWatched(ctx, "hmr", () => {
		// The upstream constructor throws outright when the internal ESM loader
		// is unreachable — `--expose-internals` absent, or running under bun. As
		// a loader row that surfaced as a FAILED fiber; here it would be an
		// unexplained child failure, so it is said instead. `rlm-hmr` covers this
		// case by reloading modules itself.
		if (!ctx.loader?.internal) {
			ctx.logger?.warn?.(
				"hmr: node's internal ESM loader is unreachable, so the official module-reload plugin " +
					"was not mounted (start node with --expose-internals). rlm-hmr will reload modules itself.",
			);
			return;
		}

		let fiber: { dispose?: () => unknown } | undefined;
		let abandoned = false;

		// Dynamic so an unwatched run never parses the module. The disposer has
		// to be returned synchronously, so it closes over a flag the import
		// settles against rather than awaiting it.
		void (async () => {
			try {
				const Hmr = (await import("@deepseek-ai/cordis-plugin-hmr")).default;
				if (abandoned) return;
				fiber = ctx.plugin(Hmr, config);
				ctx.logger?.info?.("hmr: module reload mounted (somebody is watching)");
			} catch (error) {
				ctx.logger?.error?.(`hmr: could not mount the official module-reload plugin: ${error}`);
			}
		})();

		return () => {
			abandoned = true;
			try {
				fiber?.dispose?.();
			} catch {
				/* already gone */
			}
			fiber = undefined;
		};
	});
};

export default apply;
