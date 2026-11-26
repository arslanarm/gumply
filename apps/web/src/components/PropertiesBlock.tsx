import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  isTagsKey,
  isValidPropertyKey,
  PAGE_LOOK_KEYS,
  propertyValueMatches,
  PROPERTY_TYPES,
  type PropertiesPatch,
  type Property,
  type PropertyInfo,
  type PropertyType,
  type PropertyValue,
} from "@gumply/core";
import { api } from "../api/client.js";
import { useWikiLinkEnvironment } from "../editor/wikilink/link-store.js";
import { useT } from "../i18n/index.js";
import { DatePicker } from "./DatePicker.js";
import { Icon, type IconName } from "./Icon.js";
import { hasWikilink, LinkedText } from "./PropertyLinks.js";

/** v0.7 A (D34): a page's frontmatter properties, under its title. */
export interface PropertiesBlockProps {
  properties: readonly Property[];
  /** Save a change; resolves false when it failed (the app shows why). */
  onChange: (patch: PropertiesPatch) => Promise<boolean>;
  /** Change a key's type vault-wide. */
  onSetType: (key: string, type: PropertyType) => Promise<void>;
}

/** The icon of a property type (also for database view columns, #sg36ng2d). */
export function PropertyTypeIcon({ type, size = 15 }: { type: PropertyType; size?: number }) {
  return <Icon name={TYPE_ICONS[type]} size={size} />;
}

const TYPE_ICONS: Record<PropertyType, IconName> = {
  text: "text",
  multitext: "list",
  number: "hash",
  checkbox: "checkSquare",
  date: "calendar",
  datetime: "clock",
  tags: "tag",
  aliases: "link",
};

/**
 * The value a new property of this type starts with: empty (`key:`, as
 * Obsidian writes it; a list then grows as a block list), a checkbox off.
 */
function initialValue(type: PropertyType): PropertyValue {
  return type === "checkbox" ? false : null;
}

export function PropertiesBlock({ properties, onChange, onSetType }: PropertiesBlockProps) {
  const t = useT();
  const [adding, setAdding] = useState(false);
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Gumply writes `tags: []` on every page it creates; an empty tags list is
  // bookkeeping, not a property the user added (one they add starts as
  // `tags:` and shows).
  // The page cover and background (#385sexd6) are shown as the page's look.
  const shown = properties.filter(
    (property) =>
      !PAGE_LOOK_KEYS.includes(property.key) &&
      !(isTagsKey(property.key) && Array.isArray(property.value) && property.value.length === 0),
  );

  const save = async (patch: PropertiesPatch) => {
    setError(null);
    return onChange(patch);
  };

  return (
    <section className="properties" data-testid="properties-block" aria-label={t("properties.label")}>
      {shown.length > 0 ? (
        <div className="properties-rows" role="list">
          {shown.map((property) => (
            <PropertyRow
              key={property.key}
              property={property}
              renaming={renamingKey === property.key}
              menuOpen={menuKey === property.key}
              autoFocus={focusKey === property.key}
              existingKeys={properties.map((item) => item.key)}
              onOpenMenu={() => setMenuKey((current) => (current === property.key ? null : property.key))}
              onCloseMenu={() => setMenuKey(null)}
              onStartRename={() => {
                setMenuKey(null);
                setRenamingKey(property.key);
              }}
              onRename={async (to) => {
                setRenamingKey(null);
                if (to === property.key) return;
                if (!isValidPropertyKey(to)) return setError(t("properties.invalidName"));
                if (properties.some((item) => item.key === to)) return setError(t("properties.taken", { name: to }));
                await save({ rename: [{ from: property.key, to }] });
              }}
              onCancelRename={() => setRenamingKey(null)}
              onRemove={async () => {
                setMenuKey(null);
                await save({ remove: [property.key] });
              }}
              onSetType={async (type) => {
                setMenuKey(null);
                setError(null);
                await onSetType(property.key, type);
              }}
              onSave={(value) => save({ set: { [property.key]: value } })}
              onInvalid={(type) => setError(t("properties.invalid", { type: t(`properties.types.${type}`) }))}
            />
          ))}
        </div>
      ) : null}

      {adding ? (
        <AddProperty
          existing={shown.map((item) => item.key)}
          onCancel={() => setAdding(false)}
          onAdd={async (key, type) => {
            setAdding(false);
            if (!isValidPropertyKey(key)) return setError(t("properties.invalidName"));
            if (shown.some((item) => item.key === key)) return setError(t("properties.taken", { name: key }));
            if (await save({ set: { [key]: initialValue(type) } })) setFocusKey(key);
          }}
        />
      ) : (
        <button type="button" className="properties-add" data-testid="property-add" onClick={() => setAdding(true)}>
          <Icon name="plus" size={14} />
          {t("properties.add")}
        </button>
      )}

      {error ? (
        <p className="properties-error" role="alert" data-testid="property-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}

interface PropertyRowProps {
  property: Property;
  renaming: boolean;
  menuOpen: boolean;
  autoFocus: boolean;
  existingKeys: string[];
  onOpenMenu: () => void;
  onCloseMenu: () => void;
  onStartRename: () => void;
  onRename: (to: string) => void;
  onCancelRename: () => void;
  onRemove: () => void;
  onSetType: (type: PropertyType) => void;
  onSave: (value: PropertyValue) => Promise<boolean>;
  onInvalid: (type: PropertyType) => void;
}

function PropertyRow(props: PropertyRowProps) {
  const t = useT();
  const { property } = props;
  const menuRef = useRef<HTMLDivElement | null>(null);
  const issueId = useId();

  // Close the key menu on a click outside or Escape.
  useEffect(() => {
    if (!props.menuOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) props.onCloseMenu();
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") props.onCloseMenu();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [props.menuOpen, props.onCloseMenu]);

  return (
    <div className="property-row" role="listitem" data-testid={`property-row-${property.key}`}>
      <div className="property-key-cell" ref={menuRef}>
        {props.renaming ? (
          <RenameInput initial={property.key} onDone={props.onRename} onCancel={props.onCancelRename} />
        ) : (
          <button
            type="button"
            className="property-key"
            data-testid={`property-key-${property.key}`}
            aria-haspopup="menu"
            aria-expanded={props.menuOpen}
            aria-label={t("properties.keyMenu", { name: property.key })}
            onClick={props.onOpenMenu}
          >
            <PropertyTypeIcon type={property.type} />
            <span className="property-key-name">{property.key}</span>
          </button>
        )}
        {props.menuOpen ? (
          <div className="property-menu" role="menu" data-testid="property-menu">
            <button type="button" role="menuitem" data-testid="property-menu-rename" onClick={props.onStartRename}>
              <Icon name="pencil" size={14} />
              {t("properties.rename")}
            </button>
            <div className="property-menu-label">{t("properties.type")}</div>
            {PROPERTY_TYPES.filter((type) => !isTagsKey(property.key) || type === "tags").map((type) => (
              <button
                key={type}
                type="button"
                role="menuitemradio"
                aria-checked={type === property.type}
                className={type === property.type ? "is-current" : ""}
                data-testid={`property-type-${type}`}
                onClick={() => props.onSetType(type)}
              >
                <Icon name={TYPE_ICONS[type]} size={14} />
                {t(`properties.types.${type}`)}
              </button>
            ))}
            <div className="property-menu-separator" />
            <button type="button" role="menuitem" className="is-danger" data-testid="property-menu-remove" onClick={props.onRemove}>
              <Icon name="trash" size={14} />
              {t("properties.remove")}
            </button>
          </div>
        ) : null}
      </div>
      <div className="property-value" data-testid={`property-value-${property.key}`}>
        <PropertyValueEditor
          property={property}
          autoFocus={props.autoFocus}
          onSave={props.onSave}
          onInvalid={props.onInvalid}
          adornment={
            // #9j9cd5x4: the tags flags sit right after the chips (not at the far end of the row), and
            // both use the app's tooltip.
            property.issue?.kind === "tags-string" ? (
              // #6imze6ux: Obsidian reads nothing from a string with spaces or commas; one click makes it the list
              // Gumply shows. The icon and the button (the one focusable part) show the tooltip, and the button is
              // described by it for screen readers.
              <span className="property-issue" data-testid="property-issue-tags-string">
                <span
                  id={issueId}
                  className="property-mismatch"
                  role="img"
                  data-tooltip={t("properties.tagsString")}
                  aria-label={t("properties.tagsString")}
                >
                  <Icon name="alert" size={14} />
                </span>
                <button
                  type="button"
                  className="property-issue-fix"
                  data-testid="property-make-list"
                  data-tooltip={t("properties.tagsString")}
                  // Its own name: without it, Chrome adds the tooltip's ::after text to the name, so a
                  // screen reader would read the hint twice (name, then the description).
                  aria-label={t("properties.makeList")}
                  aria-describedby={issueId}
                  onClick={() => void props.onSave(property.issue!.tags)}
                >
                  {t("properties.makeList")}
                </button>
              </span>
            ) : property.issue?.kind === "tags-digits" ? (
              <span
                className="property-mismatch"
                role="img"
                data-testid="property-issue-tags-digits"
                data-tooltip={t("properties.tagsDigits")}
                aria-label={t("properties.tagsDigits")}
              >
                <Icon name="alert" size={14} />
              </span>
            ) : null
          }
        />
        {property.issue ? null : property.editable && !propertyValueMatches(property.type, property.value) ? (
          <span
            className="property-mismatch"
            role="img"
            data-testid="property-mismatch"
            title={t("properties.mismatch", { type: t(`properties.types.${property.type}`) })}
            aria-label={t("properties.mismatch", { type: t(`properties.types.${property.type}`) })}
          >
            <Icon name="alert" size={14} />
          </span>
        ) : null}
      </div>
    </div>
  );
}

function RenameInput({ initial, onDone, onCancel }: { initial: string; onDone: (value: string) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(initial);
  const done = useRef(false);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    if (value === null) onCancel();
    else onDone(value.trim());
  };
  return (
    <input
      className="property-key-input"
      data-testid="property-rename-input"
      autoFocus
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={(event) => event.target.select()}
      onBlur={() => finish(draft)}
      onKeyDown={(event) => {
        if (event.key === "Enter") finish(draft);
        else if (event.key === "Escape") finish(null);
      }}
    />
  );
}

interface ValueEditorProps {
  property: Property;
  autoFocus: boolean;
  onSave: (value: PropertyValue) => Promise<boolean>;
  onInvalid: (type: PropertyType) => void;
  /** Show `[[links]]` in chips as links (the properties block; not a database cell's editor). */
  links?: boolean;
  /** #9j9cd5x4: shown right after a list's chips (an issue flag), else after the value. */
  adornment?: ReactNode;
}

export interface PropertyValueEditorProps {
  property: Property;
  /** Save a new value; resolve false on failure (the editor shows the saved value again). */
  onSave: (value: PropertyValue) => Promise<boolean>;
  /** A value that doesn't fit the type (e.g. "lots" for a number). */
  onInvalid?: (type: PropertyType) => void;
  autoFocus?: boolean;
  /** No hover or padding chrome: fits a 32 px table cell (#sg36ng2d). */
  compact?: boolean;
  /** #9j9cd5x4: shown right after a list's chips (the tags issue flag), else after the value. */
  adornment?: ReactNode;
}

/** One property's value editor, by type: the header's, reusable in database views. */
export function PropertyValueEditor({ property, onSave, onInvalid, autoFocus = false, compact = false, adornment }: PropertyValueEditorProps) {
  return (
    <div className={`property-editor${compact ? " is-compact" : ""}`}>
      <ValueEditor property={property} autoFocus={autoFocus} onSave={onSave} onInvalid={onInvalid ?? (() => undefined)} links={!compact} adornment={adornment} />
    </div>
  );
}

function ValueEditor({ property, autoFocus, onSave, onInvalid, links, adornment }: ValueEditorProps) {
  const t = useT();
  if (!property.editable) {
    return (
      <>
        <code className="property-readonly" title={t("properties.readOnly")} data-testid="property-readonly">
          {String(property.value ?? "")}
        </code>
        {adornment}
      </>
    );
  }
  switch (property.type) {
    case "checkbox":
      return (
        <>
          <CheckboxEditor property={property} autoFocus={autoFocus} onSave={onSave} />
          {adornment}
        </>
      );
    case "date":
    case "datetime":
      return (
        <>
          <DateEditor property={property} autoFocus={autoFocus} onSave={onSave} />
          {adornment}
        </>
      );
    case "multitext":
    case "tags":
    case "aliases":
      return <ListEditor property={property} autoFocus={autoFocus} onSave={onSave} links={links} adornment={adornment} />;
    default:
      return (
        <>
          <TextEditor property={property} autoFocus={autoFocus} onSave={onSave} onInvalid={onInvalid} />
          {adornment}
        </>
      );
  }
}

/**
 * Shows a change at once and saves it; goes back to the saved value if the
 * save fails (the app shows why).
 */
function useOptimistic<T>(saved: T): [T, (next: T, save: () => Promise<boolean>) => void] {
  const [shown, setShown] = useState(saved);
  useEffect(() => setShown(saved), [saved]);
  const change = (next: T, save: () => Promise<boolean>) => {
    setShown(next);
    void save().then((ok) => {
      if (!ok) setShown(saved);
    });
  };
  return [shown, change];
}

function CheckboxEditor({ property, autoFocus, onSave }: Omit<ValueEditorProps, "onInvalid">) {
  const [checked, change] = useOptimistic(property.value === true);
  return (
    <input
      type="checkbox"
      className="property-checkbox"
      aria-label={property.key}
      checked={checked}
      autoFocus={autoFocus}
      onChange={(event) => {
        const next = event.target.checked;
        change(next, () => onSave(next));
      }}
    />
  );
}

function DateEditor({ property, autoFocus, onSave }: Omit<ValueEditorProps, "onInvalid">) {
  const raw = typeof property.value === "string" ? property.value : "";
  const [value, change] = useOptimistic(raw);
  // #93wnicas: the app's date format and picker; the file gets the same bytes the native input wrote.
  return (
    <DatePicker
      value={value}
      datetime={property.type === "datetime"}
      label={property.key}
      autoOpen={autoFocus}
      onChange={(next) => change(next, () => onSave(next))}
    />
  );
}

/**
 * The open page's links, for `[[…]]` in values (#vc4hivrr). The editor next
 * to the properties keeps this store current.
 */
function PropertyLinkedText({ text }: { text: string }) {
  const env = useWikiLinkEnvironment();
  return <LinkedText text={text} pages={env.pages} from={env.pageId} fileLinks={env.fileLinks} onOpen={env.openLink} openMissing />;
}

function TextEditor({ property, autoFocus, onSave, onInvalid }: ValueEditorProps) {
  const t = useT();
  const stored = property.value === null || property.value === undefined ? "" : String(property.value);
  const [draft, setDraft] = useState(stored);
  // #vc4hivrr: a value with `[[links]]` shows them as links until the field
  // is clicked or tabbed into (as in Obsidian); then it's the raw text.
  const [editing, setEditing] = useState(false);
  // A save (or an outside edit) brings a new value: show it.
  useEffect(() => setDraft(stored), [stored]);
  if (!editing && !autoFocus && property.type !== "number" && hasWikilink(draft)) {
    return (
      <div
        className="property-input property-linked"
        role="textbox"
        tabIndex={0}
        aria-label={t("properties.editValue", { property: property.key })}
        data-testid={`property-linked-${property.key}`}
        onClick={() => setEditing(true)}
        onFocus={() => setEditing(true)}
      >
        <PropertyLinkedText text={draft} />
      </div>
    );
  }
  const commit = () => {
    if (draft === stored) return;
    if (property.type === "number" && draft.trim() !== "" && !Number.isFinite(Number(draft.trim()))) {
      onInvalid("number");
      setDraft(stored);
      return;
    }
    void onSave(property.type === "number" && draft.trim() !== "" ? Number(draft.trim()) : draft);
  };
  return (
    <input
      className="property-input"
      aria-label={property.key}
      inputMode={property.type === "number" ? "decimal" : undefined}
      placeholder={t("properties.empty")}
      value={draft}
      autoFocus={autoFocus || editing}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        commit();
        setEditing(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") (event.target as HTMLInputElement).blur();
        else if (event.key === "Escape") {
          setDraft(stored);
          (event.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

function ListEditor({ property, autoFocus, onSave, links, adornment }: Omit<ValueEditorProps, "onInvalid">) {
  const t = useT();
  const saved = useMemo(
    () =>
      // #6imze6ux: a tags string with spaces or commas shows the tags Gumply reads from it (one chip each).
      property.issue?.kind === "tags-string"
        ? property.issue.tags
        : Array.isArray(property.value)
          ? property.value
          : property.value
            ? [String(property.value)]
            : [],
    [property.value, property.issue],
  );
  // Chips change at once (typing the next one before the save lands keeps both).
  const [items, change] = useOptimistic(saved);
  const [draft, setDraft] = useState("");
  const tags = property.type === "tags";
  // #6imze6ux: all-digit tags Obsidian doesn't count, shown muted.
  const notTags = new Set(property.issue?.kind === "tags-digits" ? property.issue.tags : []);
  const setItems = (next: string[]) => change(next, () => onSave(next));
  const add = () => {
    const parts = draft
      .split(",")
      .map((part) => (tags ? part.trim().replace(/^#/, "") : part.trim()))
      .filter((part, index, all) => part.length > 0 && !items.includes(part) && all.indexOf(part) === index);
    setDraft("");
    if (parts.length > 0) setItems([...items, ...parts]);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      add();
    } else if (event.key === "Backspace" && draft === "" && items.length > 0) {
      setItems(items.slice(0, -1));
    }
  };
  return (
    <div className="property-chips">
      {items.map((item) => (
        <span
          key={item}
          className={`property-chip${tags ? " is-tag" : ""}${notTags.has(item) ? " is-not-tag" : ""}`}
          data-testid={`property-chip-${item}`}
          title={notTags.has(item) ? t("properties.tagsDigits") : undefined}
        >
          {/* #jtck4izu: the label shrinks with an ellipsis, so a long value never runs off a narrow window. */}
          <span className="property-chip-label">{tags ? `#${item}` : links ? <PropertyLinkedText text={item} /> : item}</span>
          <button
            type="button"
            className="property-chip-remove"
            aria-label={t("properties.removeValue", { value: item })}
            onClick={() => setItems(items.filter((other) => other !== item))}
          >
            <Icon name="x" size={12} />
          </button>
        </span>
      ))}
      {adornment}
      <input
        className="property-chip-input"
        aria-label={property.key}
        placeholder={items.length === 0 ? t("properties.empty") : t("properties.addValue")}
        value={draft}
        autoFocus={autoFocus}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={add}
      />
    </div>
  );
}

function AddProperty({
  existing,
  onAdd,
  onCancel,
}: {
  existing: string[];
  onAdd: (key: string, type: PropertyType) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [known, setKnown] = useState<PropertyInfo[]>([]);
  const [active, setActive] = useState(0);
  const done = useRef(false);

  // Keys already used in the vault (D34: "suggests keys already used").
  useEffect(() => {
    let cancelled = false;
    api.listProperties().then(
      (list) => !cancelled && setKnown(list),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const name = query.trim();
  const suggestions = useMemo(() => {
    const lower = name.toLowerCase();
    return known
      .filter((info) => !existing.includes(info.key) && !PAGE_LOOK_KEYS.includes(info.key) && info.key.toLowerCase().includes(lower))
      .slice(0, 8);
  }, [known, existing, name]);
  const exact = suggestions.some((info) => info.key === name);
  const options: Array<{ key: string; type: PropertyType; create: boolean }> = [
    ...suggestions.map((info) => ({ key: info.key, type: info.type, create: false })),
    ...(name && !exact && !existing.includes(name) ? [{ key: name, type: "text" as PropertyType, create: true }] : []),
  ];
  useEffect(() => setActive(0), [name]);

  const choose = (index: number) => {
    const option = options[index];
    if (!option || done.current) return;
    done.current = true;
    onAdd(option.key, option.type);
  };

  return (
    <div className="properties-add-box">
      <input
        className="property-input properties-add-input"
        data-testid="property-add-input"
        autoFocus
        placeholder={t("properties.namePlaceholder")}
        value={query}
        role="combobox"
        aria-expanded={options.length > 0}
        aria-controls="property-suggestions"
        onChange={(event) => setQuery(event.target.value)}
        onBlur={() => {
          // Let a click on a suggestion land first.
          setTimeout(() => {
            if (!done.current) onCancel();
          }, 120);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((index) => Math.min(index + 1, options.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((index) => Math.max(index - 1, 0));
          } else if (event.key === "Enter") {
            event.preventDefault();
            choose(active);
          } else if (event.key === "Escape") {
            done.current = true;
            onCancel();
          }
        }}
      />
      {options.length > 0 ? (
        <ul className="properties-suggestions" id="property-suggestions" role="listbox">
          {options.map((option, index) => (
            <li key={`${option.create ? "new" : "key"}:${option.key}`} role="option" aria-selected={index === active}>
              <button
                type="button"
                className={index === active ? "is-active" : ""}
                data-testid={option.create ? "property-create" : `property-suggestion-${option.key}`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(index)}
              >
                <Icon name={option.create ? "plus" : TYPE_ICONS[option.type]} size={14} />
                <span>{option.create ? t("properties.create", { name: option.key }) : option.key}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
