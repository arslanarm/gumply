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

interface PartBoundaryProps {
  children: ReactNode;
  /** Shown instead of the part when its code could not load (or it crashed). */
  renderError: (retry: () => void) => ReactNode;
}

/**
 * Keeps a failed chunk load (server stopped, offline) from blanking the whole
 * app: the part shows a calm message with "Try again", which remounts it and
 * fetches its code again.
 */
class PartBoundary extends ReactComponent<PartBoundaryProps, { failed: boolean; attempt: number }> {
  override state = { failed: false, attempt: 0 };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    console.error("[gumply] could not show part:", error);
  }

  retry = () => this.setState((state) => ({ failed: false, attempt: state.attempt + 1 }));

  override render() {
    if (this.state.failed) return this.props.renderError(this.retry);
    return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
  }
}

const LOAD_ERROR_HINT = "Check that Gumply is still running, then try again.";

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
  renderError: (retry: () => void) => ReactNode;
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

type GraphViewProps = ComponentProps<typeof import("./graph/GraphView.js").GraphView>;
type LocalGraphPanelProps = ComponentProps<typeof import("./graph/LocalGraphPanel.js").LocalGraphPanel>;
type ShortcutsDialogProps = ComponentProps<typeof import("./components/ShortcutsDialog.js").ShortcutsDialog>;
type MoveDialogProps = ComponentProps<typeof import("./components/MoveDialog.js").MoveDialog>;

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
    <section className="graph-view" aria-label="Graph" aria-busy={busy ? "true" : undefined}>
      <header className="graph-header">
        <div>
          <h2>Graph</h2>
          <p className="graph-subtitle">How your pages connect</p>
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
            <p>Loading graph…</p>
          </div>
        </GraphShell>
      }
      renderError={(retry) => (
        <GraphShell>
          <div className="empty-state" data-testid="graph-error">
            <span className="empty-state-icon" aria-hidden="true">
              <Icon name="monitor" size={26} />
            </span>
            <h2>Could not load the graph.</h2>
            <p>{LOAD_ERROR_HINT}</p>
            <button type="button" className="button-primary" onClick={retry}>
              Try again
            </button>
          </div>
        </GraphShell>
      )}
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
    <aside className="local-graph" aria-label="Local graph" aria-busy={busy ? "true" : undefined}>
      <header className="local-graph-header">
        <h2>Local graph</h2>
        <div className="local-graph-actions">
          <button
            type="button"
            className="icon-button"
            data-testid="local-graph-close"
            aria-label="Close local graph"
            data-tooltip="Close local graph"
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
          <p className="graph-panel-note">Loading…</p>
        </LocalGraphShell>
      }
      renderError={(retry) => (
        <LocalGraphShell onClose={props.onClose}>
          <div className="graph-panel-state" data-testid="local-graph-error">
            <p>Could not load the local graph.</p>
            <p>{LOAD_ERROR_HINT}</p>
            <button type="button" className="button-secondary" onClick={retry}>
              Try again
            </button>
          </div>
        </LocalGraphShell>
      )}
    />
  );
}

/** Small modal shown when a dialog's code could not load. */
function DialogLoadError({ onClose, retry }: { onClose: () => void; retry: () => void }) {
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
      >
        <h2 id="part-error-title">Could not open this.</h2>
        <p>{LOAD_ERROR_HINT}</p>
        <div className="modal-actions">
          <button type="button" className="button-secondary" onClick={onClose}>
            Close
          </button>
          <button type="button" className="button-primary" onClick={retry} autoFocus>
            Try again
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
      renderError={(retry) => <DialogLoadError onClose={props.onClose} retry={retry} />}
    />
  );
}

export function MoveDialog(props: MoveDialogProps) {
  return (
    <Part
      part={movePart}
      props={props}
      fallback={null}
      renderError={(retry) => <DialogLoadError onClose={props.onCancel} retry={retry} />}
    />
  );
}
