/**
 * Parts of the UI that are not needed to show the first page, loaded on demand
 * (#evh35bn7). The graph (react-force-graph, d3) is the big one; the dialogs
 * are small but only ever open on request.
 *
 * Each part can be preloaded: the graph when the pointer or focus reaches the
 * Graph row or the "Local graph" toggle, and everything once the app is idle
 * after startup, so opening them later does not wait for the network.
 */
import {
  Component as ReactComponent,
  Fragment,
  lazy,
  Suspense,
  useEffect,
  useState,
  type ComponentProps,
  type ComponentType,
  type ReactNode,
} from "react";
import { Icon } from "./components/Icon.js";
// The graph styles stay in the main stylesheet: the layout grid for the local
// graph panel lives there, and the loading shells below use them too.
import "./graph/graph.css";
import { t } from "./i18n/index.js";

export interface LazyPart<P> {
  /** The real component once its code has loaded, else a suspending stand-in. */
  current: () => { Component: ComponentType<P>; ready: boolean };
  preload: () => Promise<unknown>;
}

export function lazyPart<P>(load: () => Promise<ComponentType<P>>): LazyPart<P> {
  let pending: Promise<ComponentType<P>> | null = null;
  let loaded: ComponentType<P> | null = null;
  const makeLazy = () => lazy(() => preload().then((component) => ({ default: component })));
  let Lazy = makeLazy();
  const preload = () => {
    pending ??= load().then(
      (component) => {
        loaded = component;
        return component;
      },
      (error: unknown) => {
        // Let a later attempt retry instead of caching the failure. React.lazy
        // remembers a rejection forever, so the next mount needs a new one.
        pending = null;
        Lazy = makeLazy();
        throw error;
      },
    );
    return pending;
  };
  return {
    // React.lazy suspends on its first render even when the code is already
    // there; once preloaded, render the component itself (no fallback frame).
    current: () =>
      loaded
        ? { Component: loaded, ready: true }
        : { Component: Lazy as unknown as ComponentType<P>, ready: false },
    preload,
  };
}

/**
 * Why a part's code could not load:
 * - "updated": the chunk is gone (404), e.g. a tab left open across
 *   `git pull && npm run build` changed the hashed file names. Only a reload
 *   fetches the new build.
 * - "unreachable": offline, server stopped, or anything else; trying again
 *   may work.
 */
export type LoadFailure = "updated" | "unreachable";

const CHUNK_URL = /(https?:\/\/[^\s'"]+?\.(?:m?js|tsx?|jsx|css))(?:[?#][^\s'"]*)?/;

/** Classify a failed dynamic import by asking the server for the chunk again. */
export async function classifyLoadFailure(
  error: unknown,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): Promise<LoadFailure> {
  const message = error instanceof Error ? error.message : String(error);
  const url = CHUNK_URL.exec(message)?.[1];
  if (!url) return "unreachable";
  try {
    const response = await fetchImpl(url, { method: "HEAD", cache: "no-store" });
    return response.status === 404 ? "updated" : "unreachable";
  } catch {
    return "unreachable";
  }
}

/** What an error state can offer: try again, or reload for a new build. */
export interface PartFailure {
  updated: boolean;
  retry: () => void;
}

interface PartBoundaryProps {
  children: ReactNode;
  /** Shown instead of the part when its code could not load (or it crashed). */
  renderError: (failure: PartFailure) => ReactNode;
}

interface PartBoundaryState {
  failed: boolean;
  updated: boolean;
  attempt: number;
}

/**
 * Keeps a failed chunk load (server stopped, offline, new build) from blanking
 * the whole app (#fzfrkpta): the part shows a calm message instead. "Try
 * again" remounts it and fetches its code again; after an update the message
 * offers a reload.
 */
class PartBoundary extends ReactComponent<PartBoundaryProps, PartBoundaryState> {
  override state: PartBoundaryState = { failed: false, updated: false, attempt: 0 };

  static getDerivedStateFromError(): Partial<PartBoundaryState> {
    return { failed: true, updated: false };
  }

  override componentDidCatch(error: unknown) {
    console.error("[gumply] could not show part:", error);
    const attempt = this.state.attempt;
    void classifyLoadFailure(error).then((kind) => {
      if (kind === "updated" && this.state.failed && this.state.attempt === attempt) {
        this.setState({ updated: true });
      }
    });
  }

  retry = () => this.setState((state) => ({ failed: false, updated: false, attempt: state.attempt + 1 }));

  override render() {
    if (this.state.failed) return this.props.renderError({ updated: this.state.updated, retry: this.retry });
    return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
  }
}


function reloadApp(): void {
  window.location.reload();
}

/** The message and button(s) for a failed part, shared by every error state. */
function failureText(failure: PartFailure, what: "graph" | "localGraph" | "dialog") {
  return failure.updated
    ? { title: t("parts.updated"), hint: t("parts.updatedHint"), action: t("save.reload"), onAction: reloadApp }
    : { title: t(`parts.failed.${what}`), hint: t("parts.failedHint"), action: t("parts.tryAgain"), onAction: failure.retry };
}

/** Renders a part, with `fallback` only while its code is still loading. */
function Part<P extends object>({
  part,
  fallback,
  props,
  renderError,
}: {
  part: LazyPart<P>;
  fallback: ReactNode;
  props: P;
  renderError: (failure: PartFailure) => ReactNode;
}) {
  return (
    <PartBoundary renderError={renderError}>
      <PartBody part={part} fallback={fallback} props={props} />
    </PartBoundary>
  );
}

function PartBody<P extends object>({ part, fallback, props }: { part: LazyPart<P>; fallback: ReactNode; props: P }) {
  // Chosen once per mount: switching from the stand-in to the real component
  // later would change the element type and remount it (losing its state).
  const [{ Component, ready }] = useState(part.current);
  if (ready) return <Component {...props} />;
  return (
    <Suspense fallback={fallback}>
      <Component {...props} />
    </Suspense>
  );
}

const graphViewPart = lazyPart(() => import("./graph/GraphView.js").then((module) => module.GraphView));
const localGraphPart = lazyPart(() =>
  import("./graph/LocalGraphPanel.js").then((module) => module.LocalGraphPanel),
);
const shortcutsPart = lazyPart(() =>
  import("./components/ShortcutsDialog.js").then((module) => module.ShortcutsDialog),
);
const movePart = lazyPart(() => import("./components/MoveDialog.js").then((module) => module.MoveDialog));
const templatePart = lazyPart(() =>
  import("./components/TemplateGallery.js").then((module) => module.TemplateGallery),
);

type GraphViewProps = ComponentProps<typeof import("./graph/GraphView.js").GraphView>;
type LocalGraphPanelProps = ComponentProps<typeof import("./graph/LocalGraphPanel.js").LocalGraphPanel>;
type ShortcutsDialogProps = ComponentProps<typeof import("./components/ShortcutsDialog.js").ShortcutsDialog>;
type MoveDialogProps = ComponentProps<typeof import("./components/MoveDialog.js").MoveDialog>;
type TemplateGalleryProps = ComponentProps<typeof import("./components/TemplateGallery.js").TemplateGallery>;

/** Start loading the graph code (both views share most of it). */
export function preloadGraph(): void {
  void graphViewPart.preload().catch(() => undefined);
  void localGraphPart.preload().catch(() => undefined);
}

/** Load every on-demand part in the background once the app is idle. */
export function preloadWhenIdle(): () => void {
  const run = () => {
    preloadGraph();
    void shortcutsPart.preload().catch(() => undefined);
    void movePart.preload().catch(() => undefined);
    void templatePart.preload().catch(() => undefined);
  };
  const idle = (window as Window & { requestIdleCallback?: Window["requestIdleCallback"] }).requestIdleCallback;
  let idleId: number | null = null;
  // Give the first page a head start; then wait for an idle moment.
  const timer = window.setTimeout(() => {
    if (idle) idleId = idle(run, { timeout: 5000 });
    else run();
  }, 1500);
  return () => {
    window.clearTimeout(timer);
    if (idleId !== null) window.cancelIdleCallback?.(idleId);
  };
}

function GraphShell({ busy, children }: { busy?: boolean; children: ReactNode }) {
  return (
    <section className="graph-view" aria-label={t("graph.title")} aria-busy={busy ? "true" : undefined}>
      <header className="graph-header">
        <div>
          <h2>{t("graph.title")}</h2>
          <p className="graph-subtitle">{t("graph.subtitle")}</p>
        </div>
      </header>
      <div className="graph-body">{children}</div>
    </section>
  );
}

/** The global graph; shows the same "Loading graph…" state while its code loads. */
export function GraphView(props: GraphViewProps) {
  return (
    <Part
      part={graphViewPart}
      props={props}
      fallback={
        <GraphShell busy>
          <div className="graph-state graph-state-loading" data-testid="graph-loading">
            <p>{t("graph.loading")}</p>
          </div>
        </GraphShell>
      }
      renderError={(failure) => {
        const text = failureText(failure, "graph");
        return (
          <GraphShell>
            <div className="empty-state" data-testid="graph-error" data-failure={failure.updated ? "updated" : "unreachable"}>
              <span className="empty-state-icon" aria-hidden="true">
                <Icon name="monitor" size={26} />
              </span>
              <h2>{text.title}</h2>
              <p>{text.hint}</p>
              <button type="button" className="button-primary" onClick={text.onAction}>
                {text.action}
              </button>
            </div>
          </GraphShell>
        );
      }}
    />
  );
}

function LocalGraphShell({
  busy,
  onClose,
  children,
}: {
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <aside className="local-graph" aria-label={t("graph.localTitle")} aria-busy={busy ? "true" : undefined}>
      <header className="local-graph-header">
        <h2>{t("graph.localTitle")}</h2>
        <div className="local-graph-actions">
          <button
            type="button"
            className="icon-button"
            data-testid="local-graph-close"
            aria-label={t("graph.closeLocal")}
            data-tooltip={t("graph.closeLocal")}
            onClick={onClose}
          >
            ×
          </button>
        </div>
      </header>
      <div className="local-graph-body">{children}</div>
    </aside>
  );
}

/** The per-page graph panel; the panel frame shows at once so the layout does not jump. */
export function LocalGraphPanel(props: LocalGraphPanelProps) {
  return (
    <Part
      part={localGraphPart}
      props={props}
      fallback={
        <LocalGraphShell busy onClose={props.onClose}>
          <p className="graph-panel-note">{t("graph.localLoading")}</p>
        </LocalGraphShell>
      }
      renderError={(failure) => {
        const text = failureText(failure, "localGraph");
        return (
          <LocalGraphShell onClose={props.onClose}>
            <div
              className="graph-panel-state"
              data-testid="local-graph-error"
              data-failure={failure.updated ? "updated" : "unreachable"}
            >
              <p>{text.title}</p>
              <p>{text.hint}</p>
              <button type="button" className="button-secondary" onClick={text.onAction}>
                {text.action}
              </button>
            </div>
          </LocalGraphShell>
        );
      }}
    />
  );
}

/** Small modal shown when a dialog's code could not load. */
function DialogLoadError({ onClose, failure }: { onClose: () => void; failure: PartFailure }) {
  const text = failureText(failure, "dialog");
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="part-error-title"
        data-testid="dialog-load-error"
        data-failure={failure.updated ? "updated" : "unreachable"}
      >
        <h2 id="part-error-title">{failure.updated ? text.title : t("parts.openFailed")}</h2>
        <p>{text.hint}</p>
        <div className="modal-actions">
          <button type="button" className="button-secondary" onClick={onClose}>
            {t("common.close")}
          </button>
          <button type="button" className="button-primary" onClick={text.onAction} autoFocus>
            {text.action}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ShortcutsDialog(props: ShortcutsDialogProps) {
  return (
    <Part
      part={shortcutsPart}
      props={props}
      fallback={null}
      renderError={(failure) => <DialogLoadError onClose={props.onClose} failure={failure} />}
    />
  );
}

export function MoveDialog(props: MoveDialogProps) {
  return (
    <Part
      part={movePart}
      props={props}
      fallback={null}
      renderError={(failure) => <DialogLoadError onClose={props.onCancel} failure={failure} />}
    />
  );
}

export function TemplateGallery(props: TemplateGalleryProps) {
  return (
    <Part
      part={templatePart}
      props={props}
      fallback={null}
      renderError={(failure) => <DialogLoadError onClose={props.onCancel} failure={failure} />}
    />
  );
}
