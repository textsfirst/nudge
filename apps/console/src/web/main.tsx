import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { Toaster } from "sonner";
import { Layout } from "@/components/layout";
import { SettingsPage } from "@/pages/settings";
import { ActivityPage } from "@/pages/activity";
import { AgentsPage } from "@/pages/agents";
import { ConnectionsPage } from "@/pages/connections";
import { CostsPage } from "@/pages/costs";
import { FilesPage } from "@/pages/files";
import { OverviewPage } from "@/pages/overview";
import { SchedulePage } from "@/pages/schedule";
import { SecretsPage } from "@/pages/secrets";
import { SkillsPage } from "@/pages/skills";
import { ThreadDetailPage } from "@/pages/thread-detail";
import { ThreadsPage } from "@/pages/threads";
import { LoginPage } from "@/pages/login";
import { getAuthStatus, setUnauthorizedHandler } from "@/lib/api";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: "/", element: <OverviewPage /> },
      { path: "/threads", element: <ThreadsPage /> },
      { path: "/threads/:id", element: <ThreadDetailPage /> },
      { path: "/agents", element: <AgentsPage /> },
      { path: "/activity", element: <ActivityPage /> },
      { path: "/schedule", element: <SchedulePage /> },
      { path: "/costs", element: <CostsPage /> },
      { path: "/skills", element: <SkillsPage /> },
      { path: "/files", element: <FilesPage /> },
      { path: "/connections", element: <ConnectionsPage /> },
      { path: "/settings", element: <SettingsPage /> },
      { path: "/secrets", element: <SecretsPage /> },
    ],
  },
]);

function AuthenticatedConsole() {
  const [state, setState] = useState<"checking" | "authenticated" | "unauthenticated">("checking");
  const [startupError, setStartupError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setUnauthorizedHandler(() => {
      queryClient.clear();
      setState("unauthenticated");
    });
    getAuthStatus()
      .then((status) => {
        if (active) setState(status.authenticated ? "authenticated" : "unauthenticated");
      })
      .catch((error: unknown) => {
        if (active) {
          setStartupError(error instanceof Error ? error.message : String(error));
          setState("unauthenticated");
        }
      });
    return () => {
      active = false;
      setUnauthorizedHandler(null);
    };
  }, []);

  if (state === "checking") {
    return <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">Checking console access…</div>;
  }
  if (state === "unauthenticated") {
    return (
      <>
        <LoginPage
          onAuthenticated={() => {
            setStartupError(null);
            queryClient.clear();
            setState("authenticated");
          }}
        />
        {startupError && (
          <div className="fixed bottom-4 left-1/2 max-w-xl -translate-x-1/2 rounded-md border border-destructive/30 bg-background px-4 py-3 text-sm text-destructive shadow-lg">
            {startupError}
          </div>
        )}
      </>
    );
  }
  return <RouterProvider router={router} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthenticatedConsole />
      <Toaster position="bottom-right" toastOptions={{ className: "font-sans" }} />
    </QueryClientProvider>
  </StrictMode>,
);
