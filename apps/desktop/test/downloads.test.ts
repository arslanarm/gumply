import { describe, expect, it } from "vitest";
import { isAppDownload, suggestedName } from "../src/downloads";

const APP = "http://127.0.0.1:41234";

describe("desktop downloads (#yewapn9k)", () => {
  it("allows only blob URLs made by the app's own origin", () => {
    expect(isAppDownload(`blob:${APP}/4f1c2a9e-1111-4222-8333-944455556666`, APP)).toBe(true);
    expect(isAppDownload("blob:http://127.0.0.1:9999/4f1c2a9e", APP)).toBe(false);
    expect(isAppDownload("blob:https://evil.example/4f1c2a9e", APP)).toBe(false);
    expect(isAppDownload(`${APP}/api/files/report.pdf`, APP)).toBe(false);
    expect(isAppDownload("https://example.com/setup.exe", APP)).toBe(false);
    expect(isAppDownload("data:image/png;base64,AAAA", APP)).toBe(false);
    expect(isAppDownload("file:///etc/passwd", APP)).toBe(false);
    expect(isAppDownload("blob:null/4f1c2a9e", APP)).toBe(false);
    expect(isAppDownload(`blob:${APP}/x`, "")).toBe(false);
  });

  it("suggests a plain file name", () => {
    expect(suggestedName("Kanban.png")).toBe("Kanban.png");
    expect(suggestedName("../../etc/passwd")).toBe(".. .. etc passwd");
    expect(suggestedName("a/b\\c.svg")).toBe("a b c.svg");
    expect(suggestedName("..")).toBe("Gumply export");
    expect(suggestedName("")).toBe("Gumply export");
  });
});
