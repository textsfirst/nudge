import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster position="bottom-right" toastOptions={{ className: "font-sans" }} />
    </QueryClientProvider>
  </StrictMode>,
);
