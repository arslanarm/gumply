/**
 * Parts of the UI that are not needed to show the first page, loaded on demand
 * (#evh35bn7). The graph (react-force-graph, d3) is the big one; the dialogs
 * are small but only ever open on request.
 *
 * Each part can be preloaded: the graph when the pointer or focus reaches the
 * Graph row or the "Local graph" toggle, and everything once the app is idle
 * after startup, so opening them later does not wait for the network.
 */
import { lazy, Suspense, useState, type ComponentProps, type ComponentType, type ReactNode } from "react";
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
  const preload = () => {
    pending ??= load().then(
      (component) => {
        loaded = component;
        return component;
      },
      (error: unknown) => {
        // Let a later attempt retry instead of caching the failure.
        pending = null;
        throw error;
      },
    );
    return pending;
  };
  const Lazy = lazy(() => preload().then((component) => ({ default: component })));
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

/** Renders a part, with `fallback` only while its code is still loading. */
function Part<P extends object>({ part, fallback, props }: { part: LazyPart<P>; fallback: ReactNode; props: P }) {
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

/** The global graph; shows the same "Loading graph…" state while its code loads. */
export function GraphView(props: GraphViewProps) {
  return (
    <Part
      part={graphViewPart}
      props={props}
      fallback={
        <section className="graph-view" aria-label="Graph" aria-busy="true">
          <header className="graph-header">
            <div>
              <h2>Graph</h2>
              <p className="graph-subtitle">How your pages connect</p>
            </div>
          </header>
          <div className="graph-body">
            <div className="graph-state graph-state-loading" data-testid="graph-loading">
              <p>Loading graph…</p>
            </div>
          </div>
        </section>
      }
    />
  );
}

/** The per-page graph panel; the panel frame shows at once so the layout does not jump. */
export function LocalGraphPanel(props: LocalGraphPanelProps) {
  return (
    <Part
      part={localGraphPart}
      props={props}
      fallback={
        <aside className="local-graph" aria-label="Local graph" aria-busy="true">
          <header className="local-graph-header">
            <h2>Local graph</h2>
          </header>
          <div className="local-graph-body">
            <p className="graph-panel-note">Loading…</p>
          </div>
        </aside>
      }
    />
  );
}

export function ShortcutsDialog(props: ShortcutsDialogProps) {
  return <Part part={shortcutsPart} props={props} fallback={null} />;
}

export function MoveDialog(props: MoveDialogProps) {
  return <Part part={movePart} props={props} fallback={null} />;
}
