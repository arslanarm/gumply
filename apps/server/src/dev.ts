/**
 * `npm run dev`'s server entry: the normal one, with this run's installation id
 * pinned and app state kept in a scratch folder (#xhdjpaev review), so a dev,
 * perf or hunt server never writes into the user's real app data (D47's
 * instance id). Values already set in the environment win.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.GUMPLY_INSTANCE_ID ??= "dev-server-0001";
process.env.XDG_STATE_HOME ??= join(tmpdir(), "gumply-dev-state");

await import("./index.js");
