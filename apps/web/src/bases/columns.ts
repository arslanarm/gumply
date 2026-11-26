import { propertyId, type BaseConfig, type BaseView } from "@gumply/core";

/**
 * #7prbquxu (spec/database-tables §4): a property renamed or deleted in an owned database changes its rows
 * and every place the base names it: each view's columns, sort and grouping, and the base's `properties`
 * settings. An id keeps the form it's written in (`status` or `note.status`).
 */

const matches = (written: string, key: string) => propertyId(written) === `note.${key}`;
const renamed = (written: string, to: string) => (written.startsWith("note.") ? `note.${to}` : to);

export function renameKeyInConfig(config: BaseConfig, from: string, to: string): BaseConfig {
  const view = (item: BaseView): BaseView => ({
    ...item,
    ...(Array.isArray(item.order) ? { order: item.order.map((id) => (matches(String(id), from) ? renamed(String(id), to) : id)) } : {}),
    ...(Array.isArray(item.sort)
      ? { sort: item.sort.map((sort) => (matches(String(sort.property), from) ? { ...sort, property: renamed(String(sort.property), to) } : sort)) }
      : {}),
    ...(item.groupBy && matches(String(item.groupBy.property), from) ? { groupBy: { ...item.groupBy, property: renamed(String(item.groupBy.property), to) } } : {}),
  });
  const next: BaseConfig = { ...config, views: config.views.map(view) };
  if (config.properties) {
    next.properties = Object.fromEntries(
      Object.entries(config.properties).map(([id, settings]) => [matches(id, from) ? renamed(id, to) : id, settings]),
    );
  }
  return next;
}

export function dropKeyFromConfig(config: BaseConfig, key: string): BaseConfig {
  const view = (item: BaseView): BaseView => {
    const next: BaseView = { ...item };
    if (Array.isArray(item.order)) next.order = item.order.filter((id) => !matches(String(id), key));
    if (Array.isArray(item.sort)) next.sort = item.sort.filter((sort) => !matches(String(sort.property), key));
    if (item.groupBy && matches(String(item.groupBy.property), key)) delete next.groupBy;
    return next;
  };
  const next: BaseConfig = { ...config, views: config.views.map(view) };
  if (config.properties) next.properties = Object.fromEntries(Object.entries(config.properties).filter(([id]) => !matches(id, key)));
  return next;
}
