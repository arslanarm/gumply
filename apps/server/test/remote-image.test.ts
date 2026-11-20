import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  fetchRemoteImage,
  importAllowList,
  importRemoteImage,
  isPrivateAddress,
  nameFromUrl,
  sniffImage,
} from "../src/remote-image";

// A 1×1 PNG.
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c6360f80f0000010101005b0c1b6a0000000049454e44ae426082",
  "hex",
);
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "binary");

let server: Server;
let base: string;
let allow: Set<string>;
let hanging: Array<() => void> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    switch (url.pathname) {
      case "/photos/cat.png":
      case "/":
        res.writeHead(200, { "Content-Type": "image/png" }).end(PNG);
        return;
      case "/anim.gif":
        res.writeHead(200, { "Content-Type": "image/gif" }).end(GIF);
        return;
      case "/page.html":
        res.writeHead(200, { "Content-Type": "text/html" }).end("<html>hi</html>");
        return;
      case "/lying.png":
        res.writeHead(200, { "Content-Type": "image/png" }).end("<html><script>alert(1)</script></html>");
        return;
      case "/vector.svg":
        res.writeHead(200, { "Content-Type": "image/svg+xml" }).end('<svg xmlns="http://www.w3.org/2000/svg"/>');
        return;
      case "/gzipped.png":
        res.writeHead(200, { "Content-Type": "image/png", "Content-Encoding": "gzip" }).end(gzipSync(PNG));
        return;
      case "/huge-declared.png":
        res.writeHead(200, { "Content-Type": "image/png", "Content-Length": String(30 * 1024 * 1024) });
        res.write(PNG);
        // Never finishes on its own; the client must stop reading.
        hanging.push(() => res.destroy());
        return;
      case "/huge-streamed.png": {
        res.writeHead(200, { "Content-Type": "image/png" }); // chunked, no length
        res.write(PNG);
        const chunk = Buffer.alloc(64 * 1024);
        let sent = 0;
        const pump = () => {
          while (sent < 50 && res.write(chunk)) sent += 1;
          if (sent < 50) res.once("drain", pump);
          else res.end();
        };
        pump();
        return;
      }
      case "/slow.png":
        hanging.push(() => res.destroy());
        return; // never answers
      case "/missing.png":
        res.writeHead(404).end();
        return;
      case "/to-cat":
        res.writeHead(302, { Location: "/photos/cat.png" }).end();
        return;
      case "/to-private":
        res.writeHead(302, { Location: "http://127.0.0.1:1/secret.png" }).end();
        return;
      case "/to-file":
        res.writeHead(302, { Location: "file:///etc/passwd" }).end();
        return;
      case "/loop":
        res.writeHead(302, { Location: "/loop" }).end();
        return;
      default:
        res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  allow = importAllowList(`127.0.0.1:${port}`);
});

afterAll(async () => {
  for (const close of hanging) close();
  hanging = [];
  await new Promise((resolve) => server.close(resolve));
});

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});
async function vault() {
  const dir = await mkdtemp(join(tmpdir(), "gumply-import-"));
  dirs.push(dir);
  return dir;
}

describe("isPrivateAddress (SSRF)", () => {
  it("blocks loopback, private, link-local, metadata and mapped addresses", () => {
    for (const address of [
      "127.0.0.1",
      "127.8.9.10",
      "0.0.0.0",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "::1",
      "::",
      "[::1]",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:a9fe:a9fe",
      "fd00::1",
      "fe80::1",
      "not-an-ip",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it("allows public addresses", () => {
    for (const address of ["93.184.216.34", "1.1.1.1", "172.32.0.1", "2606:4700::6810:85e5"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });
});

describe("fetchRemoteImage guards", () => {
  it("refuses non-http schemes", async () => {
    for (const url of ["file:///etc/passwd", "ftp://x.test/a.png", "data:image/png;base64,AAAA", "javascript:alert(1)"]) {
      await expect(fetchRemoteImage(url), url).rejects.toMatchObject({
        status: 400,
        message: "Only http and https images can be saved.",
      });
    }
  });

  it("refuses private IP literals in every spelling", async () => {
    for (const url of [
      "http://127.0.0.1/x.png",
      "http://localhost.:1/x.png".replace("localhost.", "127.1"),
      "http://2130706433/x.png",
      "http://0x7f000001/x.png",
      "http://[::1]/x.png",
      "http://[::ffff:127.0.0.1]/x.png",
      "http://169.254.169.254/latest/meta-data",
      "http://0.0.0.0/x.png",
    ]) {
      await expect(fetchRemoteImage(url), url).rejects.toMatchObject({ status: 400 });
    }
  });

  it("refuses host names that resolve to a private address (checked at connect)", async () => {
    const port = new URL(base).port;
    const lookup = ((_host: string, _options: unknown, callback: (...args: unknown[]) => void) =>
      callback(null, [{ address: "127.0.0.1", family: 4 }])) as never;
    await expect(fetchRemoteImage(`http://images.example.test:${port}/photos/cat.png`, { lookup })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("private or local network"),
    });
  });

  it("re-checks every redirect hop: public → private and → file: are refused", async () => {
    await expect(fetchRemoteImage(`${base}/to-private`, { allow })).rejects.toMatchObject({ status: 400 });
    await expect(fetchRemoteImage(`${base}/to-file`, { allow })).rejects.toMatchObject({ status: 400 });
    await expect(fetchRemoteImage(`${base}/loop`, { allow })).rejects.toMatchObject({
      status: 422,
      message: "Too many redirects.",
    });
    // A normal redirect is followed.
    const ok = await fetchRemoteImage(`${base}/to-cat`, { allow });
    expect(ok.ext).toBe("png");
    expect(ok.url.pathname).toBe("/photos/cat.png");
  });

  it("needs an image Content-Type and image bytes; no SVG, no compressed bodies", async () => {
    await expect(fetchRemoteImage(`${base}/page.html`, { allow })).rejects.toMatchObject({ status: 422 });
    await expect(fetchRemoteImage(`${base}/lying.png`, { allow })).rejects.toMatchObject({ status: 422 });
    await expect(fetchRemoteImage(`${base}/vector.svg`, { allow })).rejects.toMatchObject({ status: 422 });
    await expect(fetchRemoteImage(`${base}/gzipped.png`, { allow })).rejects.toMatchObject({ status: 422 });
    await expect(fetchRemoteImage(`${base}/missing.png`, { allow })).rejects.toMatchObject({
      status: 422,
      message: "Couldn't download the image (HTTP 404).",
    });
  });

  it("enforces the size limit from Content-Length and while streaming", async () => {
    await expect(fetchRemoteImage(`${base}/huge-declared.png`, { allow })).rejects.toMatchObject({ status: 413 });
    await expect(
      fetchRemoteImage(`${base}/huge-streamed.png`, { allow, maxBytes: 1024 * 1024 }),
    ).rejects.toMatchObject({ status: 413 });
  });

  it("times out", async () => {
    const started = Date.now();
    await expect(fetchRemoteImage(`${base}/slow.png`, { allow, timeoutMs: 300 })).rejects.toMatchObject({
      status: 422,
    });
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("importRemoteImage", () => {
  it("saves into attachments/ with a sanitised, deduplicated name from the sniffed type", async () => {
    const dir = await vault();
    const first = await importRemoteImage(dir, `${base}/photos/cat.png?size=large`, { allow });
    expect(first).toMatchObject({ path: "attachments/cat.png", name: "cat.png", size: PNG.length });
    const second = await importRemoteImage(dir, `${base}/to-cat`, { allow });
    expect(second.name).toBe("cat-1.png");
    expect(await readFile(join(dir, "attachments", "cat.png"))).toEqual(PNG);

    // No file name in the URL; extension from the bytes.
    expect((await importRemoteImage(dir, `${base}/`, { allow })).name).toBe("image.png");
    expect((await importRemoteImage(dir, `${base}/anim.gif`, { allow })).name).toBe("anim.gif");
    expect((await readdir(join(dir, "attachments"))).sort()).toEqual(["anim.gif", "cat-1.png", "cat.png", "image.png"]);
  });

  it("never lets URL path tricks escape attachments/", () => {
    expect(nameFromUrl(new URL("http://x.test/a/..%2f..%2fevil.png"), "png")).toBe("evil.png");
    expect(nameFromUrl(new URL("http://x.test/%2e%2e%5cwin.jpg"), "jpg")).toBe("win.jpg");
    expect(nameFromUrl(new URL("http://x.test/photo.html"), "png")).toBe("photo.png");
    expect(nameFromUrl(new URL("http://x.test/"), "webp")).toBe("image.webp");
  });

  it("sniffs the supported raster types", () => {
    expect(sniffImage(PNG)).toBe("png");
    expect(sniffImage(GIF)).toBe("gif");
    expect(sniffImage(Buffer.from("ffd8ffe000104a464946000101", "hex"))).toBe("jpg");
    expect(sniffImage(Buffer.from("RIFF\x00\x00\x00\x00WEBPVP8 ", "binary"))).toBe("webp");
    expect(sniffImage(Buffer.from('<svg xmlns="x"/>      '))).toBeNull();
  });

  it("only accepts host:port pairs in the test allow list", () => {
    expect([...importAllowList("127.0.0.1:9000, bad, localhost:x ,LOCALHOST:1")]).toEqual([
      "127.0.0.1:9000",
      "localhost:1",
    ]);
  });
});
