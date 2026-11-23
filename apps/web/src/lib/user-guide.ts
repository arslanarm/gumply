/**
 * The user guide on GitHub (#6ka8s7mf): `docs/guide/<en|ru>/README.md`, by
 * the app's language. Cmd+K → "Open the user guide" (#snuin2ja) opens it; the
 * desktop's Help → User Guide uses the same URL (apps/desktop/src/urls.ts,
 * kept equal by a unit test).
 */
export const USER_GUIDE_BASE = "https://github.com/arslanarm/gumply/blob/main/docs/guide";

export function userGuideUrl(language: string): string {
  const folder = language === "ru" ? "ru" : "en";
  return `${USER_GUIDE_BASE}/${folder}/README.md`;
}
