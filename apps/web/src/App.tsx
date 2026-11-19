import { APP_NAME, type HealthResponse } from "@gumply/core";
import { useEffect, useState } from "react";

type Status = "checking" | "ok" | "offline";

/**
 * Placeholder shell for M0. @dev-ui owns this file from M1b on and will replace
 * it with the real layout, sidebar and editor.
 */
export function App() {
  const [status, setStatus] = useState<Status>("checking");
  const [vaultPath, setVaultPath] = useState<string>("");

  useEffect(() => {
    let cancelled = false;

    fetch("/api/health")
      .then((response) => (response.ok ? response.json() : Promise.reject(response)))
      .then((health: HealthResponse) => {
        if (cancelled) return;
        setVaultPath(health.vaultPath);
        setStatus("ok");
      })
      .catch(() => {
        if (!cancelled) setStatus("offline");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="shell">
      <header className="topbar">
        <span className="logo">◈</span>
        <h1>{APP_NAME}</h1>
        <span className={`status status-${status}`}>
          {status === "checking" ? "connecting…" : status === "ok" ? "server online" : "server offline"}
        </span>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <p className="sidebar-title">Pages</p>
          <p className="placeholder">The page tree lands with M1b.</p>
        </aside>

        <main className="content">
          <h2>Local-first notes with a graph</h2>
          <p>
            Scaffold is running. Pages, the block editor, wikilinks, backlinks and the graph view are
            built on top of this shell.
          </p>
          <ul>
            <li>
              API: <code>http://localhost:8787/api/health</code>
            </li>
            <li>
              Vault: <code>{vaultPath || "—"}</code>
            </li>
          </ul>
        </main>
      </div>
    </div>
  );
}
