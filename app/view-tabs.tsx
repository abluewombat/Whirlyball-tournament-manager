"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type ViewTab = {
  id: string;
  label: string;
  badge?: number;
  content: ReactNode;
};

export function ViewTabs({
  tabs,
  initialView,
  ariaLabel
}: {
  tabs: ViewTab[];
  initialView?: string;
  ariaLabel: string;
}) {
  const defaultView = tabs.some((tab) => tab.id === initialView) ? initialView as string : tabs[0]?.id || "";
  const [activeView, setActiveView] = useState(defaultView);

  useEffect(() => {
    function syncFromHistory() {
      const view = new URLSearchParams(window.location.search).get("view");
      if (view && tabs.some((tab) => tab.id === view)) setActiveView(view);
    }
    window.addEventListener("popstate", syncFromHistory);
    return () => window.removeEventListener("popstate", syncFromHistory);
  }, [tabs]);

  function selectView(view: string) {
    setActiveView(view);
    const url = new URL(window.location.href);
    url.searchParams.set("view", view);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const activeTab = tabs.find((tab) => tab.id === activeView) || tabs[0];
  if (!activeTab) return null;

  return (
    <>
      <nav className="view-tabs" aria-label={ariaLabel} role="tablist">
        {tabs.map((tab) => (
          <button
            aria-controls={`view-panel-${tab.id}`}
            aria-selected={tab.id === activeTab.id}
            className={tab.id === activeTab.id ? "active" : ""}
            id={`view-tab-${tab.id}`}
            key={tab.id}
            onClick={() => selectView(tab.id)}
            role="tab"
            type="button"
          >
            {tab.label}
            {tab.badge !== undefined ? <span className="view-tab-badge">{tab.badge}</span> : null}
          </button>
        ))}
      </nav>
      <div aria-labelledby={`view-tab-${activeTab.id}`} id={`view-panel-${activeTab.id}`} role="tabpanel">
        {activeTab.content}
      </div>
    </>
  );
}

const dashboardViewContext = createContext("");

export function DashboardTabs({
  tabs,
  initialView,
  ariaLabel,
  children
}: {
  tabs: Omit<ViewTab, "content">[];
  initialView?: string;
  ariaLabel: string;
  children: ReactNode;
}) {
  const defaultView = tabs.some((tab) => tab.id === initialView) ? initialView as string : tabs[0]?.id || "";
  const [activeView, setActiveView] = useState(defaultView);

  function selectView(view: string) {
    setActiveView(view);
    const url = new URL(window.location.href);
    url.searchParams.set("view", view);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <dashboardViewContext.Provider value={activeView}>
      <nav className="view-tabs" aria-label={ariaLabel} role="tablist">
        {tabs.map((tab) => (
          <button
            aria-selected={tab.id === activeView}
            className={tab.id === activeView ? "active" : ""}
            key={tab.id}
            onClick={() => selectView(tab.id)}
            role="tab"
            type="button"
          >
            {tab.label}
            {tab.badge !== undefined ? <span className="view-tab-badge">{tab.badge}</span> : null}
          </button>
        ))}
      </nav>
      {children}
    </dashboardViewContext.Provider>
  );
}

export function DashboardPanel({ id, children }: { id: string; children: ReactNode }) {
  const activeView = useContext(dashboardViewContext);
  return activeView === id ? <div role="tabpanel">{children}</div> : null;
}
