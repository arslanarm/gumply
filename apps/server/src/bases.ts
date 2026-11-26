/**
 * Database views (D34, spec/api-bases, #sg36ng2d): run a `.base` view over
 * the vault's pages on the server.
 *
 * Values and types come from the properties index (v1.12, #qw4pcm2h):
 * `listWithProperties()` parses each file once and caches it by the
 * in-memory mtime, so a warm query reads no file; `propertyTypeMap()` is
 * types.json merged with the inferred types, as a page's properties show them.
 */
import {
  runBaseView,
  typedProperties,
  type BaseSourceRow,
  type BaseViewResult,
  type FileInfo,
  WIKILINK_INNER,
  WIKILINK_TARGET,
  wikilinkTargetPart,
} from "@gumply/core";
import { notFound } from "./errors.js";
import type { VaultStore } from "./vault-store.js";

export class BaseQueries {
  constructor(private readonly store: VaultStore) {}

  async run(baseId: string, options: { view?: string; thisId?: string; now?: number } = {}): Promise<BaseViewResult> {
    const document = this.store.getBase(baseId);
    if (document.error) throw notFound(`This base can't be read: ${document.error}`);
    const [withProperties, typeMap, infos, stored] = await Promise.all([
      this.store.listWithProperties(),
      this.store.propertyTypeMap(),
      this.store.listProperties(),
      this.store.storedPropertyTypes(),
    ]);
    const types = new Map<string, string>(typeMap);
    // #bg7c9bzk (#faqr8pj9's #10): a key typed in types.json that no page uses yet (a column just added as Number)
    // keeps that type, rather than reading as text.
    for (const [key, type] of Object.entries(stored)) if (!types.has(key)) types.set(key, type);
    const propertiesOf = new Map(withProperties.map((meta) => [meta.id, meta.properties ?? []]));
    // #g95wkd9y: a base's link columns need the link index complete.
    await this.store.whenIndexed();
    const index = this.store.baseIndex();

    const byPath = new Map<string, FileInfo>();
    const rows: BaseSourceRow[] = index.map((entry) => {
      const file: FileInfo = {
        path: entry.path,
        title: entry.meta.title,
        ctime: Date.parse(entry.meta.created) || 0,
        mtime: Math.floor(entry.fileMtimeMs),
        tags: entry.meta.tags,
        links: entry.links,
        props: typedProperties(
          (propertiesOf.get(entry.meta.id) ?? []).map((property) => [property.key, property.value] as [string, unknown]),
          types,
        ),
      };
      byPath.set(entry.path.toLowerCase(), file);
      return {
        id: entry.meta.id,
        kind: entry.meta.kind ?? "page",
        title: entry.meta.title,
        ...(entry.meta.icon ? { icon: entry.meta.icon } : {}),
        updated: entry.meta.updated,
        file,
      };
    });

    // `this`: the page the base is embedded in, else the base file itself.
    const basePath = this.store.vaultPathOf(document.meta.id) ?? document.meta.id;
    const thisPath = options.thisId ? this.store.vaultPathOf(options.thisId) : null;
    const thisFile: FileInfo = (thisPath ? byPath.get(thisPath.toLowerCase()) : undefined) ?? {
      path: basePath,
      title: document.meta.title,
      ctime: Date.parse(document.meta.created) || 0,
      mtime: Date.parse(document.meta.updated) || 0,
      tags: [],
      links: [],
      props: new Map(),
    };

    const titles = new Map<string, string>();
    for (const row of rows) {
      titles.set(row.title.toLowerCase(), row.file.path);
      const name = row.file.path.slice(row.file.path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
      if (!titles.has(name.toLowerCase())) titles.set(name.toLowerCase(), row.file.path);
    }

    const result = runBaseView({
      config: document.config,
      view: options.view,
      rows,
      thisFile,
      types,
      now: options.now,
      resolveLink: (target) => {
        const clean = wikilinkTargetPart(target.replace(/^\[\[|\]\]$/g, "")).split("#")[0]!.trim();
        return titles.get(clean.toLowerCase()) ?? null;
      },
    });
    // #8k4ssrkb: a cover written as a wikilink resolves from its row's page.
    const view = document.config.views.find((item) => item.name === result.view);
    const imageId = typeof view?.image === "string" ? (view.image.includes(".") ? view.image : `note.${view.image}`) : null;
    if (imageId) {
      const pathOf = new Map(rows.map((row) => [row.id, row.file.path]));
      for (const row of result.rows) {
        let value = row.values[imageId];
        if (Array.isArray(value)) value = value[0] ?? null;
        const link = typeof value === "string" ? new RegExp(String.raw`^!?\[\[(${WIKILINK_TARGET}+)${WIKILINK_INNER}*\]\]$`).exec(value.trim())?.[1]?.trim() : undefined;
        if (link) row.files = { [link]: this.store.fileIndex.resolve(link, pathOf.get(row.id) ?? null) };
      }
    }
    result.properties = infos
      .map((info) => ({ id: `note.${info.key}`, type: info.type, count: info.count }))
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
    return result;
  }
}
