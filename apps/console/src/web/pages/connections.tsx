import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, ExternalLink, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Page } from "@/components/layout";
import { Badge, StatusDot } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Confirm } from "@/components/ui/confirm";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import {
  ApiError,
  disconnectGoogle,
  getChatGptFlow,
  saveGoogleClient,
  startChatGptConnect,
  startGoogleConnect,
  useConnections,
  useInvalidate,
  type Connections,
  type GoogleAccount,
} from "@/lib/api";

type ServiceAccess = "readonly" | "full";
type ServicePick = { id: string; access: ServiceAccess };

const CALLBACK_PATH = "/api/connections/google/callback";
const FULL_BY_DEFAULT = new Set(["gmail", "calendar"]);

export function ConnectionsPage() {
  const { data, isLoading } = useConnections();
  const invalidate = useInvalidate();
  const [wizard, setWizard] = useState<{ label?: string; scopes?: string[] } | null>(null);

  // The OAuth callback lands back here with ?connected= or ?error=.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const connected = searchParams.get("connected");
    const problem = searchParams.get("error");
    if (!connected && !problem) return;
    if (connected) toast.success(`Google account “${connected}” connected`);
    if (problem) toast.error(problem);
    invalidate("connections");
    setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams, invalidate]);

  if (isLoading || !data) {
    return (
      <Page title="Connections">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </Page>
    );
  }

  return (
    <Page
      title="Connections"
      description="Model provider sign-in and the Google accounts the agent can use through the gws CLI."
    >
      <ChatGptCard chatgpt={data.chatgpt} />
      <GoogleSection google={data.google} openWizard={(preset) => setWizard(preset ?? {})} />
      {wizard && (
        <GoogleWizard
          google={data.google}
          preset={wizard}
          onClose={() => setWizard(null)}
        />
      )}
    </Page>
  );
}

// -- ChatGPT subscription ---------------------------------------------------

function ChatGptCard({ chatgpt }: { chatgpt: Connections["chatgpt"] }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-muted-foreground">Model provider</h2>
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="flex items-center gap-2">
            <StatusDot ok={chatgpt.connected} />
            ChatGPT subscription
            {chatgpt.selected !== "chatgpt-subscription" && (
              <Badge variant="outline">not the selected provider</Badge>
            )}
          </CardTitle>
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            {chatgpt.connected ? "Reconnect" : "Connect"}
          </Button>
        </CardHeader>
        <CardContent className="text-muted-foreground">
          {chatgpt.connected ? (
            <>
              Connected as <span className="font-mono text-xs">{chatgpt.accountId}</span>
              {chatgpt.updatedAt && ` · tokens refreshed ${new Date(chatgpt.updatedAt).toLocaleString()}`}
            </>
          ) : (
            "Sign in with your ChatGPT account to use the subscription provider. The OpenAI API key (Secrets page) is separate."
          )}
        </CardContent>
      </Card>
      {open && <ChatGptDialog onClose={() => setOpen(false)} />}
    </section>
  );
}

function ChatGptDialog({ onClose }: { onClose: () => void }) {
  const invalidate = useInvalidate();
  const [flow, setFlow] = useState<{ flowId: string; verificationUrl: string; userCode: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    startChatGptConnect()
      .then(setFlow)
      .catch((problem: unknown) =>
        setError(problem instanceof ApiError ? problem.message : String(problem)),
      );
  }, []);

  useEffect(() => {
    if (!flow) return;
    const timer = setInterval(() => {
      getChatGptFlow(flow.flowId)
        .then((state) => {
          if (state.status === "done") {
            clearInterval(timer);
            toast.success(`ChatGPT connected (account ${state.accountId})`);
            invalidate("connections");
            onClose();
          } else if (state.status === "error") {
            clearInterval(timer);
            setError(state.error ?? "Sign-in failed.");
          }
        })
        .catch(() => undefined);
    }, 2_000);
    return () => clearInterval(timer);
  }, [flow, invalidate, onClose]);

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogTitle>Connect ChatGPT</DialogTitle>
        <DialogDescription>
          Open the link on any device, sign in, and enter the code. This page finishes by itself.
        </DialogDescription>
        {error ? (
          <p className="mt-4 text-sm text-destructive">{error}</p>
        ) : !flow ? (
          <p className="mt-4 text-sm text-muted-foreground">Starting sign-in…</p>
        ) : (
          <div className="mt-4 flex flex-col gap-3">
            <CopyRow label="Sign-in link" value={flow.verificationUrl} link />
            <CopyRow label="Code" value={flow.userCode} mono />
            <p className="text-xs text-muted-foreground">Waiting for authorization…</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// -- Google accounts --------------------------------------------------------

function GoogleSection({
  google,
  openWizard,
}: {
  google: Connections["google"];
  openWizard: (preset?: { label?: string; scopes?: string[] }) => void;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">Google accounts</h2>
        <Button size="sm" onClick={() => openWizard()}>
          <Plus /> Add account
        </Button>
      </div>

      {!google.gws.installed && (
        <Card className="border-warning/40">
          <CardContent className="pt-3 text-muted-foreground">
            The <span className="font-mono text-xs">gws</span> CLI is not installed on this machine,
            so the agent cannot reach Google yet (connecting accounts still works). Install it with{" "}
            <span className="font-mono text-xs">brew install googleworkspace-cli</span> or{" "}
            <span className="font-mono text-xs">npm i -g @googleworkspace/cli</span>, or set{" "}
            <span className="font-mono text-xs">google.gws_path</span> in the config.
          </CardContent>
        </Card>
      )}

      {google.clientConfigured && (
        <p className="text-xs text-muted-foreground">
          OAuth client <span className="font-mono">{truncate(google.clientId ?? "", 40)}</span>
          {google.gws.installed && google.gws.version && (
            <> · gws {google.gws.version}</>
          )}
          {google.defaultAccount && <> · default account: {google.defaultAccount}</>}
        </p>
      )}

      {google.accounts.length === 0 ? (
        <Card>
          <CardContent className="pt-3 text-muted-foreground">
            No Google accounts connected yet. “Add account” walks through the one-time Google Cloud
            setup and signs an account in — Gmail, Calendar, Drive and more become available to the
            agent, per account, with the access you choose.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {google.accounts.map((account) => (
            <GoogleAccountCard
              key={account.label}
              account={account}
              services={google.services}
              onEditScopes={() => openWizard({ label: account.label, scopes: account.scopes })}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function GoogleAccountCard({
  account,
  services,
  onEditScopes,
}: {
  account: GoogleAccount;
  services: Connections["google"]["services"];
  onEditScopes: () => void;
}) {
  const invalidate = useInvalidate();
  const grants = useMemo(() => describeScopes(account.scopes, services), [account.scopes, services]);

  const reconnect = () => {
    startGoogleConnect({ label: account.label, services: scopesToPicks(account.scopes) })
      .then(({ authUrl }) => {
        window.location.href = authUrl;
      })
      .catch((problem: unknown) =>
        toast.error(problem instanceof ApiError ? problem.message : String(problem)),
      );
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2">
          <StatusDot ok={account.status === "ok"} />
          {account.label}
          {account.status === "expired" && <Badge variant="destructive">reconnect needed</Badge>}
          {account.status === "unreachable" && <Badge variant="warning">Google unreachable</Badge>}
          {account.status === "missing" && <Badge variant="destructive">credentials missing</Badge>}
        </CardTitle>
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" aria-label="Reconnect" title="Reconnect" onClick={reconnect}>
            <RefreshCw />
          </Button>
          <Confirm
            title={`Disconnect ${account.label}?`}
            description={`Revokes Nudge's access to ${account.email} and deletes its stored tokens.`}
            actionLabel="Disconnect"
            onConfirm={() => {
              void disconnectGoogle(account.label)
                .then(() => {
                  invalidate("connections");
                  toast.success(`${account.label} disconnected`);
                })
                .catch((problem: unknown) =>
                  toast.error(problem instanceof ApiError ? problem.message : String(problem)),
                );
            }}
          >
            <Button
              size="icon"
              variant="ghost"
              aria-label="Disconnect"
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 />
            </Button>
          </Confirm>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p className="text-muted-foreground">{account.email}</p>
        <div className="flex flex-wrap gap-1">
          {grants.map((grant) => (
            <Badge key={grant} variant="outline">
              {grant}
            </Badge>
          ))}
        </div>
        <button
          type="button"
          onClick={onEditScopes}
          className="self-start text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          Edit access…
        </button>
      </CardContent>
    </Card>
  );
}

// -- add-account wizard -----------------------------------------------------

type WizardStep = "services" | "client" | "label";

function GoogleWizard({
  google,
  preset,
  onClose,
}: {
  google: Connections["google"];
  preset: { label?: string; scopes?: string[] };
  onClose: () => void;
}) {
  const invalidate = useInvalidate();
  const [step, setStep] = useState<WizardStep>("services");
  const [picks, setPicks] = useState<Map<string, ServiceAccess>>(() => {
    if (preset.scopes) {
      return new Map(scopesToPicks(preset.scopes).map((pick) => [pick.id, pick.access]));
    }
    return new Map([
      ["gmail", "full"],
      ["calendar", "full"],
    ]);
  });
  const [label, setLabel] = useState(preset.label ?? "");
  const [busy, setBusy] = useState(false);
  const labelLocked = preset.label !== undefined;

  const next = () => {
    if (step === "services") {
      if (picks.size === 0) {
        toast.error("Pick at least one service.");
        return;
      }
      setStep(google.clientConfigured ? "label" : "client");
    } else if (step === "client") {
      setStep("label");
    }
  };

  const connect = () => {
    setBusy(true);
    startGoogleConnect({
      label: label.trim(),
      services: [...picks.entries()].map(([id, access]) => ({ id, access })),
    })
      .then(({ authUrl }) => {
        // Full-tab navigation: Google brings the browser back to /connections.
        window.location.href = authUrl;
      })
      .catch((problem: unknown) => {
        setBusy(false);
        toast.error(problem instanceof ApiError ? problem.message : String(problem));
      });
  };

  return (
    <Dialog open onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogTitle>{labelLocked ? `Change access for ${preset.label}` : "Add a Google account"}</DialogTitle>
        {step === "services" && (
          <>
            <DialogDescription>
              What may the agent touch on this account? Read-only is enough for briefings; sending
              mail or creating events needs full access. You can change this any time.
            </DialogDescription>
            <div className="mt-4 flex flex-col divide-y divide-border rounded-lg border border-border">
              {google.services.map((service) => {
                const access = picks.get(service.id);
                return (
                  <div key={service.id} className="flex items-center justify-between gap-2 px-3 py-2">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={access !== undefined}
                        onChange={(event) => {
                          const nextPicks = new Map(picks);
                          if (event.target.checked) {
                            nextPicks.set(
                              service.id,
                              FULL_BY_DEFAULT.has(service.id) ? "full" : "readonly",
                            );
                          } else {
                            nextPicks.delete(service.id);
                          }
                          setPicks(nextPicks);
                        }}
                      />
                      {service.name}
                    </label>
                    {access !== undefined && (
                      <div className="flex rounded-md border border-border text-xs">
                        {(["readonly", "full"] as const).map((option) => (
                          <button
                            key={option}
                            type="button"
                            onClick={() => setPicks(new Map(picks).set(service.id, option))}
                            className={
                              access === option
                                ? "rounded-[5px] bg-accent px-2 py-1 font-medium"
                                : "px-2 py-1 text-muted-foreground"
                            }
                          >
                            {option === "readonly" ? "Read-only" : "Full"}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="mt-4 flex justify-end">
              <Button onClick={next}>Continue</Button>
            </div>
          </>
        )}

        {step === "client" && (
          <ClientSetupStep
            selectedServices={[...picks.keys()]}
            services={google.services}
            onDone={() => {
              invalidate("connections");
              setStep("label");
            }}
          />
        )}

        {step === "label" && (
          <>
            <DialogDescription>
              {labelLocked
                ? "Google will ask you to approve the new access."
                : "Name this account — you and the agent will refer to it by this label."}
            </DialogDescription>
            <div className="mt-4 flex flex-col gap-3">
              {!labelLocked && (
                <Input
                  value={label}
                  onChange={(event) => setLabel(event.target.value.toLowerCase())}
                  placeholder="personal, work, …"
                  className="w-48 font-mono"
                  autoFocus
                />
              )}
              <p className="text-xs text-muted-foreground">
                {[...picks.entries()]
                  .map(([id, access]) => {
                    const name = google.services.find((service) => service.id === id)?.name ?? id;
                    return `${name} (${access === "full" ? "full" : "read-only"})`;
                  })
                  .join(", ")}
              </p>
              <p className="text-xs text-muted-foreground">
                Signing in happens on Google in this tab. If the consent screen warns the app is
                unverified, choose Continue — it is your own Cloud project.
              </p>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setStep("services")}>
                Back
              </Button>
              <Button onClick={connect} disabled={busy || !/^[a-z][a-z0-9-]{0,23}$/.test(label.trim())}>
                Continue with Google <ExternalLink />
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** One-time Google Cloud walkthrough: project, consent screen, APIs, OAuth client. */
function ClientSetupStep({
  selectedServices,
  services,
  onDone,
}: {
  selectedServices: string[];
  services: Connections["google"]["services"];
  onDone: () => void;
}) {
  const [json, setJson] = useState("");
  const [busy, setBusy] = useState(false);
  const redirectUri = `${window.location.origin}${CALLBACK_PATH}`;

  const save = () => {
    setBusy(true);
    saveGoogleClient({ json })
      .then(() => {
        toast.success("OAuth client saved");
        onDone();
      })
      .catch((problem: unknown) =>
        toast.error(problem instanceof ApiError ? problem.message : String(problem)),
      )
      .finally(() => setBusy(false));
  };

  const steps: { text: React.ReactNode; href?: string; linkText?: string }[] = [
    {
      text: "Create (or pick) a Google Cloud project — it only hosts your private sign-in app.",
      href: "https://console.cloud.google.com/projectcreate",
      linkText: "Create project",
    },
    {
      text: (
        <>
          Set up the OAuth consent screen: audience <b>External</b>, add yourself as a test user,
          then <b>publish it to Production</b> — apps left in testing mode lose their sign-in every
          7 days.
        </>
      ),
      href: "https://console.cloud.google.com/auth/overview",
      linkText: "Consent screen",
    },
    {
      text: `Enable the APIs for the services you picked: ${
        selectedServices
          .map((id) => services.find((service) => service.id === id)?.name ?? id)
          .join(", ") || "—"
      }.`,
    },
    {
      text: (
        <>
          Create an OAuth client of type <b>Web application</b> and register this redirect URI
          (repeat for every address you open this console from):
        </>
      ),
      href: "https://console.cloud.google.com/auth/clients",
      linkText: "Credentials",
    },
  ];

  return (
    <>
      <DialogDescription>
        One-time setup: Nudge signs in through your own (free) Google Cloud app, so no third party
        ever sees your data.
      </DialogDescription>
      <ol className="mt-4 flex list-decimal flex-col gap-2.5 pl-5 text-sm">
        {steps.map((step, index) => (
          <li key={index}>
            <span>{step.text}</span>{" "}
            {step.href && (
              <a
                href={step.href}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 text-xs text-primary underline-offset-2 hover:underline"
              >
                {step.linkText} <ExternalLink className="size-3" />
              </a>
            )}
            {index === 2 && (
              <div className="mt-1 flex flex-wrap gap-2">
                {selectedServices.map((id) => {
                  const service = services.find((candidate) => candidate.id === id);
                  if (!service) return null;
                  return (
                    <a
                      key={id}
                      href={`https://console.cloud.google.com/apis/library/${service.api}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-0.5 text-xs text-primary underline-offset-2 hover:underline"
                    >
                      Enable {service.name} <ExternalLink className="size-3" />
                    </a>
                  );
                })}
              </div>
            )}
            {index === 3 && (
              <div className="mt-1">
                <CopyRow label="Redirect URI" value={redirectUri} mono />
              </div>
            )}
          </li>
        ))}
      </ol>
      <div className="mt-4 flex flex-col gap-2">
        <label className="text-xs text-muted-foreground" htmlFor="client-json">
          Paste the OAuth client’s JSON (or just {"{"}"client_id": "…", "client_secret": "…"{"}"})
        </label>
        <Textarea
          id="client-json"
          value={json}
          onChange={(event) => setJson(event.target.value)}
          className="h-24 font-mono text-xs"
          placeholder='{"web":{"client_id":"…","client_secret":"…"}}'
        />
      </div>
      <div className="mt-4 flex justify-end">
        <Button onClick={save} disabled={!json.trim() || busy}>
          Save & continue
        </Button>
      </div>
    </>
  );
}

// -- shared bits ------------------------------------------------------------

function CopyRow({
  label,
  value,
  mono,
  link,
}: {
  label: string;
  value: string;
  mono?: boolean;
  link?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 text-xs text-muted-foreground">{label}</span>
      {link ? (
        <a
          href={value}
          target="_blank"
          rel="noreferrer"
          className="min-w-0 flex-1 truncate text-sm text-primary underline-offset-2 hover:underline"
        >
          {value}
        </a>
      ) : (
        <span className={`min-w-0 flex-1 truncate text-sm ${mono ? "font-mono" : ""}`}>{value}</span>
      )}
      <Button
        size="icon"
        variant="ghost"
        aria-label={`Copy ${label}`}
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1_500);
          });
        }}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Map stored scopes back to service picks (for reconnect / edit access). */
function scopesToPicks(scopes: string[]): ServicePick[] {
  const picks: ServicePick[] = [];
  for (const scope of scopes) {
    if (scope.endsWith("readonly")) {
      const id = serviceIdForScope(scope);
      if (id) picks.push({ id, access: "readonly" });
    } else {
      const id = serviceIdForScope(scope);
      if (id) picks.push({ id, access: "full" });
    }
  }
  return picks;
}

function serviceIdForScope(scope: string): string | undefined {
  const map: Record<string, string> = {
    "gmail.readonly": "gmail",
    "gmail.modify": "gmail",
    "calendar.readonly": "calendar",
    calendar: "calendar",
    "drive.readonly": "drive",
    drive: "drive",
    "documents.readonly": "docs",
    documents: "docs",
    "spreadsheets.readonly": "sheets",
    spreadsheets: "sheets",
    "contacts.readonly": "contacts",
    contacts: "contacts",
    "tasks.readonly": "tasks",
    tasks: "tasks",
  };
  const tail = scope.split("/").at(-1) ?? "";
  return map[tail];
}

function describeScopes(
  scopes: string[],
  services: Connections["google"]["services"],
): string[] {
  const labels: string[] = [];
  for (const pick of scopesToPicks(scopes)) {
    const name = services.find((service) => service.id === pick.id)?.name ?? pick.id;
    labels.push(pick.access === "readonly" ? `${name} · read-only` : name);
  }
  return labels.length > 0 ? labels : ["no services granted"];
}
