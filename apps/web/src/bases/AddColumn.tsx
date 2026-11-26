import { useEffect, useRef, useState } from "react";
import { isValidPropertyKey, type PropertyInfo, type PropertyType } from "@gumply/core";
import { api } from "../api/client.js";
import { useT } from "../i18n/index.js";
import { PropertyTypeIcon } from "../components/PropertiesBlock.js";
import { Popover } from "./Popover.js";

/**
 * #7prbquxu (spec/database-tables §4): "+" at the end of an owned database's header. A name and a type
 * add `<key>` to the view's columns. The type goes into types.json only when the key has none yet; a key
 * already typed elsewhere in the vault keeps its type, and the panel says so. Select and Multi-select come
 * in phase 3.
 */
export const COLUMN_TYPES: readonly PropertyType[] = ["text", "number", "checkbox", "date", "datetime", "multitext"];

export function AddColumn(props: {
  anchor: HTMLElement | null;
  /** The keys the view already shows (as written in the file). */
  shown: readonly string[];
  onClose: () => void;
  /** `setType`: write the type to types.json (the key has none yet). */
  onAdd: (key: string, type: PropertyType, setType: boolean) => Promise<void>;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [type, setType] = useState<PropertyType>("text");
  const [vault, setVault] = useState<Map<string, PropertyInfo> | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let live = true;
    api
      .listProperties()
      .then((list) => live && setVault(new Map(list.map((info) => [info.key, info]))))
      .catch(() => live && setVault(new Map()));
    // The popover is placed (and shown) in its own layout pass; focus once it can take it.
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      live = false;
      cancelAnimationFrame(frame);
    };
  }, []);

  const key = name.trim();
  const known = key ? vault?.get(key) : undefined;
  const error = !key
    ? null
    : !isValidPropertyKey(key)
      ? t("properties.invalidName")
      : props.shown.includes(key)
        ? t("bases.columnExists", { name: key })
        : null;
  // A key already typed elsewhere keeps its type; the list shows it, and the note says why.
  const chosen = known ? known.type : type;

  const add = async () => {
    if (!key || error || busy || vault === null) return;
    setBusy(true);
    try {
      await props.onAdd(key, chosen, !known);
      props.onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover anchor={props.anchor} onClose={props.onClose} label={t("bases.addColumn")} testId="base-add-column" className="is-menu is-add-column">
      <input
        ref={inputRef}
        className="base-input"
        data-testid="base-add-column-name"
        placeholder={t("bases.columnName")}
        aria-label={t("bases.columnName")}
        aria-invalid={error ? true : undefined}
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter") {
            event.preventDefault();
            void add();
          }
        }}
      />
      {error ? (
        <div className="base-add-column-note is-error" role="alert" data-testid="base-add-column-error">
          {error}
        </div>
      ) : known ? (
        <div className="base-add-column-note" data-testid="base-add-column-known">
          {t("bases.typeElsewhere", { name: key, type: t(`properties.types.${known.type}`) })}
        </div>
      ) : null}
      <div className="base-panel-title">{t("properties.type")}</div>
      <div role="radiogroup" aria-label={t("properties.type")}>
        {COLUMN_TYPES.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={option === chosen}
            className={option === chosen ? "is-current" : ""}
            data-testid={`base-add-column-type-${option}`}
            disabled={Boolean(known)}
            onClick={() => setType(option)}
          >
            <PropertyTypeIcon type={option} size={14} />
            {t(`properties.types.${option}`)}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="button-primary base-add-column-submit"
        data-testid="base-add-column-submit"
        disabled={!key || Boolean(error) || busy || vault === null}
        onClick={() => void add()}
      >
        {t("bases.addColumnSubmit")}
      </button>
    </Popover>
  );
}
