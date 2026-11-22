import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain .mjs build script, no types
import { inspectRuntime, runtimeLength } from "../scripts/appimage-runtime.mjs";

/** #4ckqijua: a minimal 64-bit little-endian ELF whose section headers end at `size`, holding `text`, then a squashfs-like tail. */
function appImage(text: string, tail = ""): Buffer {
  const size = 4096;
  const buffer = Buffer.alloc(size + tail.length);
  buffer.writeUInt32BE(0x7f454c46, 0);
  buffer[4] = 2; // 64-bit
  buffer[5] = 1; // little-endian
  const shentsize = 64;
  const shnum = 4;
  buffer.writeBigUInt64LE(BigInt(size - shentsize * shnum), 0x28);
  buffer.writeUInt16LE(shentsize, 0x3a);
  buffer.writeUInt16LE(shnum, 0x3c);
  buffer.write(text, 256, "latin1");
  buffer.write(tail, size, "latin1");
  return buffer;
}

describe("the AppImage runtime check (inspect-installers)", () => {
  it("passes the static type-2 runtime and fails the legacy libfuse2 one", () => {
    expect(inspectRuntime(appImage("AppImage runtime version: https://github.com/AppImage/type2-runtime/commit/dd6cebe fusermount"))).toMatchObject({
      ok: true,
      needsLibfuse2: false,
      type2: true,
    });
    expect(inspectRuntime(appImage("dlopen libfuse.so.2 Version: effcebc"))).toMatchObject({ ok: false, needsLibfuse2: true });
    expect(inspectRuntime(appImage("some other runtime")).ok).toBe(false);
  });

  it("reads only the runtime: text in the squashfs image after it doesn't count", () => {
    const buffer = appImage("type2-runtime", "a file in the app that mentions libfuse.so.2");
    expect(runtimeLength(buffer)).toBe(4096);
    expect(inspectRuntime(buffer).ok).toBe(true);
  });

  it("isn't fooled by a file that isn't an ELF", () => {
    expect(inspectRuntime(Buffer.from("#!/bin/sh\necho type2-runtime\n")).ok).toBe(false);
  });
});
