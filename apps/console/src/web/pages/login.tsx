import { useState, type FormEvent } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { ApiError, loginConsole } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export function LoginPage({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [capability, setCapability] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = capability.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      await loginConsole(value);
      setCapability("");
      onAuthenticated();
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Could not sign in to the console.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 p-6">
      <Card className="w-full max-w-md shadow-sm">
        <CardHeader className="items-center gap-3 pb-3 text-center">
          <span className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <KeyRound className="size-5" />
          </span>
          <div>
            <CardTitle className="text-lg">Unlock Nudge Console</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Paste the access code shown when the console first started.
            </p>
          </div>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={submit}>
            <div className="space-y-1.5">
              <label htmlFor="console-access-code" className="text-xs font-medium">
                Console access code
              </label>
              <Input
                id="console-access-code"
                type="password"
                value={capability}
                onChange={(event) => setCapability(event.target.value)}
                placeholder="Paste the 43-character code"
                autoComplete="current-password"
                autoFocus
                spellCheck={false}
                className="font-mono"
              />
            </div>
            {error && (
              <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={busy || capability.trim() === ""}>
              {busy && <Loader2 className="animate-spin" />}
              Unlock console
            </Button>
          </form>
          <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
            Lost the code? In the Nudge checkout, run <code className="font-mono text-foreground">pnpm console:auth</code> to show it or <code className="font-mono text-foreground">pnpm console:auth rotate</code> to replace it.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
