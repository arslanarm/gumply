import { rmSync } from 'node:fs';
import { removeRunSettingsBaseline } from './vault-settings';

/**
 * Global teardown: remove the per-run vault that `support/env.ts` created.
 * A vault passed in via `GUMPLY_VAULT` belongs to the caller and is left alone.
 */
export default function globalTeardown(): void {
  removeRunSettingsBaseline();
  const vault = process.env.GUMPLY_VAULT;
  if (process.env.GUMPLY_E2E_VAULT_OWNED !== '1' || !vault) return;
  rmSync(vault, { recursive: true, force: true });
}
