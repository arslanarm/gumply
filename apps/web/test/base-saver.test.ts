import { describe, expect, it, vi } from "vitest";
import type { BaseConfig } from "@gumply/core";
import { ApiRequestError, type SaveBaseResult } from "../src/api/client.js";
import { BaseSaver } from "../src/bases/base-saver.js";

/** #ups4ikpj (D22): a database view's save that meets a changed file keeps the user's change. */
const config = (column: string) => ({ views: [{ type: "table", name: "Table", order: [column] }] }) as unknown as BaseConfig;
const answer = (version: string, saved: BaseConfig, backup?: string) =>
  ({ meta: { updated: version }, config: saved, ...(backup ? { conflictBackup: backup } : {}) }) as unknown as SaveBaseResult;
const conflict = () => new ApiRequestError(409, "changed on disk");

function saver(send: (config: BaseConfig, options: { expectedUpdated: string; force: boolean }) => Promise<SaveBaseResult>) {
  const events: string[] = [];
  const instance = new BaseSaver("v1", {
    send,
    onSaved: (result, pending) => events.push(`saved ${result.meta.updated}${pending ? " (more)" : ""}`),
    onConflict: () => events.push("conflict"),
    onError: () => events.push("error"),
    isConflict: (error) => error instanceof ApiRequestError && error.status === 409,
  });
  return { instance, events };
}

describe("database view saves (#ups4ikpj)", () => {
  it("saves one at a time, each conditional on the version the last one wrote", async () => {
    const send = vi.fn(async (_c: BaseConfig, { expectedUpdated }: { expectedUpdated: string }) => answer(expectedUpdated === "v1" ? "v2" : "v3", _c));
    const { instance, events } = saver(send);
    await instance.save(config("a"));
    await instance.save(config("b"));
    expect(send.mock.calls.map((call) => call[1])).toEqual([
      { expectedUpdated: "v1", force: false },
      { expectedUpdated: "v2", force: false },
    ]);
    expect(events).toEqual(["saved v2", "saved v3"]);
    expect(instance.isDirty()).toBe(false);
  });

  it("two changes before the first is sent: only the newest is written", async () => {
    const send = vi.fn(async (c: BaseConfig) => answer("v2", c));
    const { instance } = saver(send);
    await Promise.all([instance.save(config("a")), instance.save(config("b"))]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toEqual(config("b"));
  });

  it("a 409 keeps the change and waits: nothing is reloaded or dropped", async () => {
    const send = vi.fn(async () => {
      throw conflict();
    });
    const { instance, events } = saver(send);
    await instance.save(config("mine"));
    expect(events).toEqual(["conflict"]);
    expect(instance.inConflict()).toBe(true);
    expect(instance.isDirty()).toBe(true);
  });

  it("while in conflict, a newer change replaces the held one and isn't sent", async () => {
    const send = vi.fn<(c: BaseConfig, o: { expectedUpdated: string; force: boolean }) => Promise<SaveBaseResult>>(async () => {
      throw conflict();
    });
    const { instance } = saver(send);
    await instance.save(config("first"));
    await instance.save(config("second"));
    expect(send).toHaveBeenCalledTimes(1);

    send.mockImplementation(async (c) => answer("v9", c, ".gumply/conflicts/Tasks.base"));
    await instance.keepMine();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0]).toEqual(config("second"));
    expect(send.mock.calls[1]![1]).toEqual({ expectedUpdated: "v1", force: true });
    expect(instance.isDirty()).toBe(false);
  });

  it("Keep mine reports the backup with the save; later saves are ordinary again", async () => {
    let fail = true;
    const send = vi.fn(async (c: BaseConfig, { force }: { force: boolean }) => {
      if (fail) {
        fail = false;
        throw conflict();
      }
      return answer(force ? "v5" : "v6", c, force ? ".gumply/conflicts/x.base" : undefined);
    });
    const saved: SaveBaseResult[] = [];
    const instance = new BaseSaver("v1", {
      send,
      onSaved: (result) => saved.push(result),
      onConflict: () => undefined,
      onError: () => undefined,
      isConflict: (error) => error instanceof ApiRequestError && error.status === 409,
    });
    await instance.save(config("mine"));
    await instance.keepMine();
    expect(saved[0]!.conflictBackup).toBe(".gumply/conflicts/x.base");
    await instance.save(config("next"));
    expect(send.mock.calls[2]![1]).toEqual({ expectedUpdated: "v5", force: false });
  });

  it("another failure drops the change (the view shows the file again)", async () => {
    const { instance, events } = saver(async () => {
      throw new ApiRequestError(500, "boom");
    });
    await instance.save(config("x"));
    expect(events).toEqual(["error"]);
    expect(instance.isDirty()).toBe(false);
  });

  it("the version follows an outside reload only when nothing of the user's is pending; discard drops the held change", async () => {
    const send = vi.fn(async () => {
      throw conflict();
    });
    const { instance } = saver(send);
    await instance.save(config("x"));
    instance.setVersion("v7");
    await instance.discard();
    expect(instance.isDirty()).toBe(false);
    instance.setVersion("v8");
    send.mockImplementation(async () => answer("v9", config("y")) as never);
    await instance.save(config("y"));
    expect((send.mock.calls.at(-1) as unknown as [BaseConfig, { expectedUpdated: string }])[1].expectedUpdated).toBe("v8");
  });
});
