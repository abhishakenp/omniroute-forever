#!/usr/bin/env bun
/**
 * omniroute — the host.
 *
 * ## The contract
 *
 * **This file should never need to be edited again.** Everything OmniRoute does
 * is a row in `cordis.yml`; this file is only what has to exist before there is
 * anywhere to put a row. It holds no policy, no capability, and no knowledge of
 * routing, providers or SQLite. It does three things:
 *
 * 1. **Create the root Context and mount the Loader.** There is no context to
 *    load a plugin into until someone makes one.
 * 2. **Mount one `cordis-plugin-include` on the composition.** The composition
 *    is a row in nothing; it is the file every row comes from.
 * 3. **Poll that file forever, and refresh on change.** The dead man's switch:
 *    the row that does the real watching is itself a row, so an edit that
 *    removes it would otherwise leave nobody reading the file it was removed
 *    from. `refresh()` is transactional and short-circuits on unchanged
 *    content, so this costs nothing.
 *
 * ## Why there is no module-hook step
 *
 * `iris.mjs` registers `tsx` before the first row is imported, because Node
 * cannot `import()` a `.ts` file on its own. This process is Bun, which can —
 * so the hook step has nothing to do and is not here. That is the *only*
 * difference between the two hosts, and it is why this one is shorter.
 *
 * Run: `bun omniroute.mjs [--config cordis.yml] [--port 20131]`
 */
import { existsSync, readFileSync, watchFile } from 'node:fs'
import { isAbsolute, join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const boot = JSON.parse(readFileSync(join(here, 'boot.json'), 'utf8'))
const die = (message) => {
  // The one place a bare write is right: this runs before any logger exists,
  // and the alternative to saying it here is not saying it.
  console.error('[omniroute]', message)
  process.exit(1)
}

const flagIndex = process.argv.indexOf('--config')
const configured = flagIndex !== -1 ? process.argv[flagIndex + 1] : undefined
const composition = configured
  ? isAbsolute(configured)
    ? configured
    : resolve(process.cwd(), configured)
  : join(here, boot.config)
if (!existsSync(composition)) die(`no composition at ${composition}`)

const { Context } = await import('@deepseek-ai/cordis')
const ctx = new Context()
ctx.baseUrl = pathToFileURL(here + '/').href
await ctx.plugin((await import('@deepseek-ai/cordis-plugin-loader')).default)
const entry = ctx.loader.resolve(
  await ctx.loader.create({
    name: '@deepseek-ai/cordis-plugin-include',
    // Bare specifiers inside the composition resolve against the composition's
    // own directory, so a config passed by absolute path still finds packages
    // the same way `cordis.yml` does.
    config: { path: pathToFileURL(composition).href, enableLogs: false },
  }),
)
watchFile(composition, { interval: boot.poll }, (curr, prev) => {
  if (curr.mtimeMs === prev.mtimeMs && curr.ino === prev.ino) return
  Promise.resolve((entry.subtree ?? entry).refresh?.()).catch(() => {})
})
