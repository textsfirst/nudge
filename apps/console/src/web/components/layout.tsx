import {
  Cable,
  FileText,
  KeyRound,
  LayoutDashboard,
  MessagesSquare,
  Moon,
  Settings2,
  Sun,
} from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import { StatusDot } from "@/components/ui/badge";
import { useStatus } from "@/lib/api";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/threads", label: "Threads", icon: MessagesSquare },
  { to: "/files", label: "Files", icon: FileText },
  { to: "/connections", label: "Connections", icon: Cable },
  { to: "/settings", label: "Settings", icon: Settings2 },
  { to: "/secrets", label: "Secrets", icon: KeyRound },
];

function toggleTheme() {
  const dark = document.documentElement.classList.toggle("dark");
  localStorage.theme = dark ? "dark" : "light";
}

export function Layout() {
  const status = useStatus();
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-52 shrink-0 flex-col border-r border-border px-3 py-4">
        <div className="flex items-center gap-2 px-2 pb-4">
          <span className="flex size-6 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
            N
          </span>
          <span className="text-sm font-semibold tracking-tight">Nudge Console</span>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                  isActive && "bg-accent font-medium text-foreground",
                )
              }
            >
              <Icon className="size-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center justify-between border-t border-border px-2 pt-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <StatusDot
              ok={(status.data?.serverUp && status.data?.serverHealthy) ?? false}
            />
            {status.data?.serverUp && status.data?.serverHealthy
              ? "Server up"
              : status.data?.serverUp
                ? "Server unhealthy"
                : "Server down"}
          </div>
          <button
            type="button"
            onClick={toggleTheme}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Toggle theme"
          >
            <Sun className="size-4 dark:hidden" />
            <Moon className="hidden size-4 dark:block" />
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}

/** Shared page chrome: title row + content width cap. */
export function Page({
  title,
  description,
  actions,
  children,
  wide = false,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={cn("mx-auto flex flex-col gap-5 p-6", wide ? "max-w-6xl" : "max-w-4xl")}>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>
      {children}
    </div>
  );
}
