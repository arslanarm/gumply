// Render the app icon (build/icon.png, 1024×1024) from the brand glyph used in
// the app's top bar. Run once after changing the design: node scripts/make-icon.mjs
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "build", "icon.png");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 512 512">
  <rect x="32" y="32" width="448" height="448" rx="104" fill="#4f46e5"/>
  <g transform="translate(96 96) scale(13.333)" fill="none" stroke="#ffffff" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 2 22 12 12 22 2 12z"/>
    <path d="M12 8v8M8 12h8"/>
  </g>
</svg>`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
await page.locator("svg").screenshot({ path: out, omitBackground: true });
await browser.close();
console.log(`wrote ${out}`);
