// #4ckqijua: what an AppImage's runtime (the ELF stub in front of its
// squashfs image) needs to start. The legacy runtime dlopens libfuse.so.2,
// which Ubuntu 22.04+ doesn't ship, so the AppImage doesn't start at all
// there. The static type-2 runtime (electron-builder `toolsets.appimage`
// "1.0.3") has libfuse3 built in and only needs the `fusermount` helper,
// which the default `fuse3` package provides.

/** Where the runtime ends and the squashfs image begins: the end of its ELF section headers. */
export function runtimeLength(buffer) {
  if (buffer.length < 64 || buffer.readUInt32BE(0) !== 0x7f454c46) return null; // "\x7fELF"
  const is64 = buffer[4] === 2;
  const little = buffer[5] === 1;
  const u16 = (offset) => (little ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset));
  const u32 = (offset) => (little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset));
  const u64 = (offset) => Number(little ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset));
  const shoff = is64 ? u64(0x28) : u32(0x20);
  const shentsize = is64 ? u16(0x3a) : u16(0x2e);
  const shnum = is64 ? u16(0x3c) : u16(0x30);
  const end = shoff + shentsize * shnum;
  return end > 0 && end <= buffer.length ? end : null;
}

/**
 * The runtime's verdict from its own bytes: `needsLibfuse2` when it references
 * `libfuse.so.2`; `type2` when it is the AppImage type2-runtime (its
 * `--appimage-version` banner names the repository).
 */
export function inspectRuntime(buffer) {
  const length = runtimeLength(buffer);
  if (length === null) return { ok: false, detail: "not an ELF AppImage runtime" };
  const runtime = buffer.subarray(0, length).toString("latin1");
  const needsLibfuse2 = runtime.includes("libfuse.so.2");
  const type2 = runtime.includes("type2-runtime");
  return {
    ok: !needsLibfuse2 && type2,
    needsLibfuse2,
    type2,
    detail: needsLibfuse2 ? "needs libfuse.so.2 (legacy runtime)" : type2 ? "static type2-runtime, no libfuse2" : "unknown runtime",
  };
}
