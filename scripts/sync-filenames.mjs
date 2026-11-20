#!/usr/bin/env node
/**
 * D20 migration: rename vault files so every file name follows its page title.
 *
 *   npm run vault:sync-filenames            # dry run, prints the plan
 *   npm run vault:sync-filenames -- --apply # rename files and folders
 *
 * Uses GUMPLY_VAULT when set, otherwise the default `vault/` directory.
 * Only notes with an explicit `title:` are renamed (a note without one already
 * takes its title from its file name, and Obsidian links to it by that name).
 * Duplicate titles get ` 2`, ` 3`, … and re-running is a no-op.
 */
import { loadConfig } from "../apps/server/dist/config.js";
import { VaultStore } from "../apps/server/dist/vault-store.js";

const apply = process.argv.includes("--apply");
const { vaultPath } = loadConfig();

const store = new VaultStore(vaultPath);
await store.init();

const plans = await store.syncFilenames(apply);

if (plans.length === 0) {
  console.log(
    `Nothing to rename (${store.list().length} page(s) checked). ` +
      "Notes without a `title:` key keep their file names.",
  );
} else {
  for (const { from, to } of plans) console.log(`${from}.md  ->  ${to}.md`);
  console.log(
    apply
      ? `Renamed ${plans.length} page(s) in ${vaultPath}.`
      : `Dry run: ${plans.length} page(s) would be renamed. Re-run with --apply to write.`,
  );
}

store.stopWatching();
