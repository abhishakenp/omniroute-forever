/**
 * @omniroute/convex-login — Convex authentication and project setup.
 *
 * This row handles the "is Convex set up?" question so the adapter row doesn't
 * have to. It:
 *
 * 1. Checks whether `bunx convex` is authenticated (reads `~/.convex/config.json`).
 * 2. If not, runs `bunx convex dev --once` to set up a project.
 * 3. Publishes the deployment URL and API key as `ctx.convexConfig` so the
 *    adapter row can read them without re-running the setup.
 *
 * ## Why a separate row
 *
 * The adapter row (`@omniroute/db-convex`) needs a deployment URL and API key.
 * Getting those is a setup concern, not a database concern — and a composition
 * that uses the SQLite adapter should not pay for Convex setup. So this row is
 * optional: load it only when using the Convex adapter.
 *
 * ## Hot-swappable
 *
 * Like every other row, this is hot-swappable. Editing the config and
 * reloading picks up the new deployment URL without restarting the gateway.
 */
import { Service, type Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

declare module "@deepseek-ai/cordis" {
  interface Context {
    convexConfig: ConvexLoginService;
  }
}

export const name = "omniroute-convex-login";

export interface Config {
  /**
   * Path to the Convex config directory.
   *
   * Default: `~/.convex`. The `bunx convex` CLI stores its auth token here.
   */
  configDir: string;
  /**
   * The Convex deployment URL.
   *
   * If set, this row uses it directly instead of running `bunx convex dev`.
   * Useful for production deployments where the URL is known.
   */
  deploymentUrl: string;
  /**
   * The Convex API key.
   *
   * If set, this row uses it directly. Optional — public deployments don't
   * need one.
   */
  apiKey: string;
  /**
   * Whether to run `bunx convex dev --once` to set up a project if not
   * authenticated.
   *
   * On by default for dev. Turn off in production where the URL and key are
   * provided via config.
   */
  autoSetup: boolean;
}

export const Config: Schema<Config> = Schema.object({
  configDir: Schema.string()
    .default("")
    .description("Path to Convex config directory. Empty = ~/.convex."),
  deploymentUrl: Schema.string()
    .default("")
    .description("Convex deployment URL. If set, skips auto-setup."),
  apiKey: Schema.string()
    .default("")
    .description("Convex API key. Optional for public deployments."),
  autoSetup: Schema.boolean()
    .default(true)
    .description("Run bunx convex dev --once if not authenticated."),
}) as unknown as Schema<Config>;

export class ConvexLoginService extends Service {
  static provide = "convexConfig" as const;
  static Config = Config;

  declare config: Config;

  private _deploymentUrl: string | null = null;
  private _apiKey: string | null = null;
  private _authenticated = false;

  constructor(ctx: Context, config: Config) {
    super(ctx, undefined as any);
    this.config = config;
  }

  async [Service.init]() {
    const configDir = this.config.configDir || join(process.env.HOME ?? "", ".convex");

    // If deploymentUrl is provided in config, use it directly.
    if (this.config.deploymentUrl) {
      this._deploymentUrl = this.config.deploymentUrl;
      this._apiKey = this.config.apiKey || null;
      this._authenticated = true;
      this.ctx.logger?.info(`[omniroute-convex-login] using configured deployment: ${this._deploymentUrl}`);
      return;
    }

    // Check if Convex is authenticated.
    const authed = this.checkAuth(configDir);
    if (authed) {
      this._authenticated = true;
      this.ctx.logger?.info("[omniroute-convex-login] Convex is authenticated");
    } else if (this.config.autoSetup) {
      // Run `bunx convex dev --once` to set up a project.
      this.ctx.logger?.info("[omniroute-convex-login] not authenticated — running setup");
      await this.runSetup();
    } else {
      this.ctx.logger?.warn("[omniroute-convex-login] not authenticated and autoSetup is off");
    }
  }

  /** Whether Convex is authenticated and ready to use. */
  isAuthenticated(): boolean {
    return this._authenticated;
  }

  /** The deployment URL, or null if not set up. */
  getDeploymentUrl(): string | null {
    return this._deploymentUrl;
  }

  /** The API key, or null if not needed. */
  getApiKey(): string | null {
    return this._apiKey;
  }

  /** Check if `~/.convex/config.json` has an access token. */
  private checkAuth(configDir: string): boolean {
    try {
      const configFile = join(configDir, "config.json");
      if (!existsSync(configFile)) return false;
      const config = JSON.parse(readFileSync(configFile, "utf8"));
      return !!config.accessToken;
    } catch {
      return false;
    }
  }

  /** Run `bunx convex dev --once` to set up a Convex project. */
  private async runSetup(): Promise<void> {
    try {
      // Run `bunx convex dev --once` in the project root (where convex/ is).
      // This creates a new Convex project if one doesn't exist, deploys the
      // schema and functions, and writes the deployment URL to .env.local.
      const projectRoot = process.cwd();
      const result = spawnSync("bunx", ["convex", "dev", "--once", "--typecheck", "disable"], {
        cwd: projectRoot,
        stdio: "pipe",
        timeout: 120_000,
        env: { ...process.env },
      });

      if (result.status !== 0) {
        const stderr = result.stderr?.toString() ?? "";
        this.ctx.logger?.warn(`[omniroute-convex-login] setup exited ${result.status}: ${stderr}`);
        // Even if setup fails, try to read the deployment URL from .env.local.
      }

      // Read the deployment URL from .env.local (written by `convex dev`).
      const envFile = join(projectRoot, ".env.local");
      if (existsSync(envFile)) {
        const envContent = readFileSync(envFile, "utf8");
        const match = envContent.match(/CONVEX_URL\s*=\s*(.+)/);
        if (match) {
          this._deploymentUrl = match[1].trim().replace(/^["']|["']$/g, "");
          this._authenticated = true;
          this.ctx.logger?.info(`[omniroute-convex-login] setup complete — deployment: ${this._deploymentUrl}`);
        }
      }
    } catch (err) {
      this.ctx.logger?.error(`[omniroute-convex-login] setup failed: ${err}`);
    }
  }
}

export default ConvexLoginService;
