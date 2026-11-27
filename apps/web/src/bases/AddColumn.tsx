import { useEffect, useRef, useState } from "react";
import { isValidPropertyKey, type PropertyInfo, type PropertyType, type SelectKind } from "@gumply/core";
import { api } from "../api/client.js";
import { Icon } from "../components/Icon.js";
import { useT } from "../i18n/index.js";
import { PropertyTypeIcon } from "../components/PropertiesBlock.js";
import { Popover } from "./Popover.js";

/**
 * #7prbquxu (spec/database-tables §4): "+" at the end of an owned database's header. A name and a type
 * add `<key>` to the view's columns. The type goes into types.json only when the key has none yet; a key
 * already typed elsewhere in the vault keeps its type, and the panel says so. Select and Multi-select (@lead,
 * spec §4) make the column a Select of this database, with no options yet: they come from the values typed
 * in its cells.
 */
export const COLUMN_TYPES: readonly PropertyType[] = ["text", "number", "checkbox", "date", "datetime", "multitext"];
type AddType = PropertyType | SelectKind;
/** The "+" list, in the spec's order: List last, after the two Select kinds. */
const ADD_TYPES: readonly AddType[] = ["text", "number", "checkbox", "date", "datetime", "select", "multiselect", "multitext"];
const isSelectKind = (type: AddType): type is SelectKind => type === "select" || type === "multiselect";

export function AddColumn(props: {
  anchor: HTMLElement | null;
  /** The keys the view already shows (as written in the file). */
  shown: readonly string[];
  onClose: () => void;
  /** `setType`: write the type to types.json (the key has none yet). A Select kind is this base's own. */
  onAdd: (key: string, type: PropertyType | SelectKind, setType: boolean) => Promise<void>;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [type, setType] = useState<AddType>("text");
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
  const chosen: AddType = known ? known.type : type;

  // #qchedmun (R3): the type is passed in, so Enter on a type button adds that type (not a state not applied yet).
  const add = async (as: AddType = chosen) => {
    if (!key || error || busy || vault === null) return;
    setBusy(true);
    try {
      await props.onAdd(key, known ? chosen : as, !known);
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
        {ADD_TYPES.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={option === chosen}
            className={option === chosen ? "is-current" : ""}
            data-testid={`base-add-column-type-${option}`}
            disabled={Boolean(known)}
            onClick={() => setType(option)}
            onKeyDown={(event) => {
              // #qchedmun (R3): Enter on a type picks it and adds the property, as Enter in the name field adds.
              // Space only picks it (the button's own click).
              if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
              event.preventDefault();
              setType(option);
              void add(option);
            }}
          >
            {isSelectKind(option) ? <Icon name={option === "select" ? "chevronDown" : "tag"} size={14} /> : <PropertyTypeIcon type={option} size={14} />}
            {isSelectKind(option) ? t(option === "select" ? "bases.selectType" : "bases.multiselectType") : t(`properties.types.${option}`)}
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
