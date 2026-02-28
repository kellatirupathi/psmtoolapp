import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchAppConfig } from "./api/client";
import { AssignmentsPage } from "./pages/AssignmentsPage";
import { AssessmentsPage } from "./pages/AssessmentsPage";
import { DocumentationPage } from "./pages/DocumentationPage";
import { DrilldownPage } from "./pages/DrilldownPage";
import { InterviewPage } from "./pages/InterviewPage";
import { SettingsPage } from "./pages/SettingsPage";
import type { AiProvider, AppConfig } from "./types";
import "./App.css";

const fallbackConfig: AppConfig = {
  appName: "",
  version: "Integrated Pipeline v2.0",
  productOptions: [
    "Intensive",
    "Academy",
    "External",
    "Academy Edge",
    "Nxtwave Edge",
    "NIAT",
    "Intensive Offline",
    "Experienced Hiring",
  ],
  pages: ["Interview analyser", "Drilldown", "Assessments", "Assignments"],
  interviewModules: ["Interview_analyser", "Video_uploader"],
  desktopDownloadUrl: "",
};

type RouteMeta = {
  key: "interview" | "drilldown" | "assessments" | "assignments" | "settings";
  label: string;
  path: string;
};

const APP_ROUTES: RouteMeta[] = [
  { key: "interview", label: "Interview analyser", path: "/interview-analyser" },
  { key: "drilldown", label: "Drilldown", path: "/drilldown" },
  { key: "assessments", label: "Assessments", path: "/assessments" },
  { key: "assignments", label: "Assignments", path: "/assignments" },
  { key: "settings", label: "Settings", path: "/settings" },
];

const DEFAULT_ROUTE: RouteMeta = APP_ROUTES[0];

const normalizePath = (path: string): string => {
  const stripped = path.replace(/\/+$/, "");
  return stripped === "" ? "/" : stripped.toLowerCase();
};

const getRouteByPath = (path: string): RouteMeta | null => {
  const normalized = normalizePath(path);
  return APP_ROUTES.find((route) => route.path === normalized) ?? null;
};

const providerToQueryValue = (provider: AiProvider): string => {
  return provider === "openai" ? "openapi" : "mistralapi";
};

const queryValueToProvider = (value: string | null): AiProvider => {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "openapi" || normalized === "openai" ? "openai" : "mistral";
};

const isVideoModule = (moduleValue: string): boolean => {
  const normalized = moduleValue.trim().toLowerCase().replace(/_/g, "-");
  return normalized === "video-uploader";
};

const moduleToQueryValue = (moduleValue: string): string => {
  return isVideoModule(moduleValue) ? "video-uploader" : "interview-analyser";
};

const getInterviewModuleFromQuery = (search: string, modules: string[]): string => {
  const moduleOptions = modules.length > 0 ? modules : fallbackConfig.interviewModules;
  const preferred = new URLSearchParams(search).get("module");
  const normalizedPreferred = String(preferred ?? "").trim().toLowerCase();

  if (normalizedPreferred === "video-uploader") {
    return moduleOptions.find((option) => isVideoModule(option)) ?? moduleOptions[0];
  }

  if (normalizedPreferred === "interview-analyser" || normalizedPreferred === "interview-analyzer") {
    return moduleOptions.find((option) => !isVideoModule(option)) ?? moduleOptions[0];
  }

  return moduleOptions[0];
};

export default function App() {
  const [locationState, setLocationState] = useState(() => ({
    pathname: normalizePath(window.location.pathname),
    search: window.location.search,
    hash: window.location.hash,
  }));

  const isDocumentationRoute =
    locationState.pathname === "/documentation" || locationState.hash === "#/documentation";
  const currentRoute = useMemo(() => getRouteByPath(locationState.pathname), [locationState.pathname]);
  const activeRoute = currentRoute ?? DEFAULT_ROUTE;

  const [config, setConfig] = useState<AppConfig>(fallbackConfig);
  const [selectedProduct, setSelectedProduct] = useState<string>(fallbackConfig.productOptions[0]);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const isDesktopRuntime = useMemo(() => {
    if (typeof window !== "undefined" && window.location.protocol === "file:") {
      return true;
    }

    if (typeof navigator !== "undefined" && /electron/i.test(navigator.userAgent)) {
      return true;
    }

    return false;
  }, []);
  const desktopDownloadUrl = useMemo(() => {
    const configured = config.desktopDownloadUrl?.trim();
    if (configured) return configured;
    return process.env.REACT_APP_DESKTOP_DOWNLOAD_URL?.trim() || "";
  }, [config.desktopDownloadUrl]);

  const navigateTo = useCallback((path: string, params?: URLSearchParams, replace = false): void => {
    const normalized = normalizePath(path);
    const query = params && params.toString().trim().length > 0 ? `?${params.toString()}` : "";
    const targetUrl = `${normalized}${query}`;
    const method = replace ? "replaceState" : "pushState";
    window.history[method]({}, "", targetUrl);
    setLocationState({
      pathname: normalized,
      search: query,
      hash: window.location.hash,
    });
  }, []);

  useEffect(() => {
    const onPopState = (): void => {
      setLocationState({
        pathname: normalizePath(window.location.pathname),
        search: window.location.search,
        hash: window.location.hash,
      });
    };

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const selectedProvider = useMemo(
    () => queryValueToProvider(new URLSearchParams(locationState.search).get("api")),
    [locationState.search],
  );

  const selectedInterviewModule = useMemo(
    () => getInterviewModuleFromQuery(locationState.search, config.interviewModules),
    [config.interviewModules, locationState.search],
  );

  useEffect(() => {
    if (isDocumentationRoute) {
      return;
    }

    const params = new URLSearchParams(locationState.search);
    const canonicalApi = providerToQueryValue(selectedProvider);
    let shouldReplace = currentRoute === null;

    if (params.get("api") !== canonicalApi) {
      params.set("api", canonicalApi);
      shouldReplace = true;
    }

    if (activeRoute.key === "interview") {
      const canonicalModule = moduleToQueryValue(selectedInterviewModule);
      if (params.get("module") !== canonicalModule) {
        params.set("module", canonicalModule);
        shouldReplace = true;
      }
    } else if (params.has("module")) {
      params.delete("module");
      shouldReplace = true;
    }

    if (shouldReplace) {
      navigateTo(activeRoute.path, params, true);
    }
  }, [
    activeRoute.key,
    activeRoute.path,
    currentRoute,
    isDocumentationRoute,
    locationState.search,
    navigateTo,
    selectedInterviewModule,
    selectedProvider,
  ]);

  useEffect(() => {
    if (isDocumentationRoute) {
      return;
    }

    const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

    const loadConfig = async (): Promise<void> => {
      const maxAttempts = 2;
      try {
        setLoadingConfig(true);
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          try {
            const remoteConfig = await fetchAppConfig();
            setConfig(remoteConfig);
            setSelectedProduct((prev) => (
              remoteConfig.productOptions.includes(prev) ? prev : remoteConfig.productOptions[0]
            ));
            return;
          } catch (error) {
            if (attempt >= maxAttempts) {
              throw error;
            }
            await wait(2500);
          }
        }
      } catch {
        setConfig(fallbackConfig);
      } finally {
        setLoadingConfig(false);
      }
    };

    void loadConfig();
  }, [isDocumentationRoute]);

  const handleNavigateRoute = useCallback((route: RouteMeta): void => {
    const params = new URLSearchParams();
    params.set("api", providerToQueryValue(selectedProvider));

    if (route.key === "interview") {
      params.set("module", moduleToQueryValue(selectedInterviewModule));
    }

    navigateTo(route.path, params);
  }, [navigateTo, selectedInterviewModule, selectedProvider]);

  const handleProviderChange = useCallback((provider: AiProvider): void => {
    if (isDocumentationRoute) {
      return;
    }

    const params = new URLSearchParams(locationState.search);
    params.set("api", providerToQueryValue(provider));

    if (activeRoute.key === "interview") {
      params.set("module", moduleToQueryValue(selectedInterviewModule));
      navigateTo("/interview-analyser", params);
      return;
    }

    params.delete("module");
    navigateTo(activeRoute.path, params);
  }, [
    activeRoute.key,
    activeRoute.path,
    isDocumentationRoute,
    locationState.search,
    navigateTo,
    selectedInterviewModule,
  ]);

  const handleInterviewModuleChange = useCallback((moduleValue: string): void => {
    const params = new URLSearchParams(locationState.search);
    params.set("api", providerToQueryValue(selectedProvider));
    params.set("module", moduleToQueryValue(moduleValue));
    navigateTo("/interview-analyser", params);
  }, [locationState.search, navigateTo, selectedProvider]);

  const handleOpenDocumentation = useCallback((): void => {
    navigateTo("/documentation");
  }, [navigateTo]);

  const pageContent = useMemo(() => {
    if (activeRoute.key === "settings") {
      return <SettingsPage />;
    }

    if (activeRoute.key === "drilldown") {
      return (
        <DrilldownPage
          product={selectedProduct}
          provider={selectedProvider}
          onProviderChange={handleProviderChange}
        />
      );
    }

    if (activeRoute.key === "assessments") {
      return (
        <AssessmentsPage
          product={selectedProduct}
          provider={selectedProvider}
          onProviderChange={handleProviderChange}
        />
      );
    }

    if (activeRoute.key === "assignments") {
      return (
        <AssignmentsPage
          product={selectedProduct}
          provider={selectedProvider}
          onProviderChange={handleProviderChange}
        />
      );
    }

    return (
      <InterviewPage
        product={selectedProduct}
        modules={config.interviewModules}
        selectedModule={selectedInterviewModule}
        onModuleChange={handleInterviewModuleChange}
        provider={selectedProvider}
        onProviderChange={handleProviderChange}
      />
    );
  }, [
    activeRoute.key,
    config.interviewModules,
    handleInterviewModuleChange,
    handleProviderChange,
    selectedInterviewModule,
    selectedProduct,
    selectedProvider,
  ]);

  if (isDocumentationRoute) {
    return <DocumentationPage />;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <h1>Psm Analyser Tool</h1>

        <label className="sidebar-label" htmlFor="product-select">
          Product
        </label>
        <select
          id="product-select"
          className="sidebar-select"
          value={selectedProduct}
          onChange={(event) => setSelectedProduct(event.target.value)}
        >
          {config.productOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>

        <hr className="sidebar-divider" />

        <div className="nav-buttons">
          {APP_ROUTES.map((route) => (
            <button
              key={route.key}
              className={activeRoute.key === route.key ? "nav-button active" : "nav-button"}
              onClick={() => handleNavigateRoute(route)}
            >
              {route.label}
            </button>
          ))}
        </div>

        <div className="sidebar-bottom">
          {!isDesktopRuntime &&
            (desktopDownloadUrl ? (
              <a
                className="doc-link-button"
                href={desktopDownloadUrl}
                download
              >
                Download Desktop App
              </a>
            ) : loadingConfig ? (
              <span className="doc-link-button disabled">Checking Desktop Download...</span>
            ) : (
              <span className="doc-link-button disabled">Desktop Download Unavailable</span>
            ))}
          {isDesktopRuntime ? (
            <button
              type="button"
              className="doc-link-button"
              onClick={handleOpenDocumentation}
            >
              Documentation
            </button>
          ) : (
            <a
              className="doc-link-button"
              href="/documentation"
              target="_blank"
              rel="noreferrer noopener"
            >
              Documentation
            </a>
          )}
          <div className="sidebar-footer">{config.version}</div>
        </div>
      </aside>

      <main className="main-content">
        <header className="page-header">
          <div>
            <h2>{config.appName}</h2>
            <p>
              Page: <strong>{activeRoute.label}</strong>
              {activeRoute.key !== "settings" && (
                <>
                  {" "}
                  | Product: <strong>{selectedProduct}</strong> | API:{" "}
                  <strong>{selectedProvider === "openai" ? "OpenAI" : "Mistral"}</strong>
                </>
              )}
            </p>
          </div>
          {loadingConfig && <div className="loading-chip">Loading config...</div>}
        </header>

        {pageContent}
      </main>
    </div>
  );
}
