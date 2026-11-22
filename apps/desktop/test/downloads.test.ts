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

describe("G2 print downloads", () => {
  const token = "3f9a0c1d2e4b5a6978c0d1e2";
  it("takes only <Title>.<token>.gumply-print.html, and names the PDF", async () => {
    const { isPrintDownload, pdfName } = await import("../src/downloads");
    expect(isPrintDownload(`Trip plan.${token}.gumply-print.html`, token)).toBe(true);
    expect(pdfName(`Trip plan.${token}.gumply-print.html`, token)).toBe("Trip plan.pdf");
    expect(pdfName(`a:b.${token}.gumply-print.html`, token)).toBe("a b.pdf");
  });

  it("a marker name without this launch's token is a normal download", async () => {
    const { isPrintDownload } = await import("../src/downloads");
    // A vault attachment that happens to end in the marker.
    expect(isPrintDownload("x.gumply-print.html", token)).toBe(false);
    // Another launch's token, or a guessed one.
    expect(isPrintDownload("x.0123456789abcdef0123.gumply-print.html", token)).toBe(false);
    // No title before the token.
    expect(isPrintDownload(`.${token}.gumply-print.html`, token)).toBe(false);
    // An empty or malformed token never matches.
    expect(isPrintDownload("x..gumply-print.html", "")).toBe(false);
    expect(isPrintDownload("x.abc.gumply-print.html", "abc")).toBe(false);
  });
});
