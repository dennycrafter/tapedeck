"use client";

import { useCallback, useState, type CSSProperties, type FormEvent } from "react";
import type { ServiceResult } from "../api/setup/finish/finish";
import {
  GENERATED_SECRETS,
  GO_LIVE_STEPS,
  type OptionalVar,
} from "./setup-config";

/**
 * The Setup page body (SPEC 8.12). Shows variable NAMES and status dots
 * (never values), the go-live steps, three freshly generated secrets with
 * Copy buttons, and — once every required variable is set — the password box
 * with the "Finish setup" button.
 */

interface RequiredVar {
  name: string;
  present: boolean;
}

interface OptionalVarStatus extends OptionalVar {
  present: boolean;
}

interface SetupClientProps {
  required: RequiredVar[];
  optional: OptionalVarStatus[];
  allSet: boolean;
}

type FinishState =
  | { phase: "idle" | "submitting" }
  | { phase: "wrong-password" }
  | { phase: "already-finished" }
  | { phase: "failed"; services: ServiceResult[] }
  // Setup completed (tables + CORS done) but an optional service failed:
  // show what failed, let the owner continue manually (SPEC 8.12).
  | { phase: "completed-with-warnings"; services: ServiceResult[] };

// 32 random bytes as 64 hex characters (SPEC 8.12).
function generateSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const DOT_COLORS: Record<string, string> = {
  green: "#22c55e",
  red: "#ef4444",
  amber: "#f59e0b",
};

function Dot({ color }: { color: keyof typeof DOT_COLORS }) {
  return (
    <span
      aria-hidden
      className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
      style={{ background: DOT_COLORS[color] }}
    />
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (cause) {
      console.error("setup: clipboard write failed", cause);
    }
  }, [value]);

  return (
    <div className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-zinc-400">{label}</div>
        <div className="truncate font-mono text-sm text-zinc-200">{value}</div>
      </div>
      <button
        type="button"
        onClick={copy}
        className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:text-white"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

const STATUS_COLOR: Record<ServiceResult["status"], keyof typeof DOT_COLORS> = {
  OK: "green",
  NOT_SET: "amber",
  ERROR: "red",
};

function ServiceRow({ service }: { service: ServiceResult }) {
  return (
    <li className="flex items-start gap-2.5 py-1 text-sm">
      <span className="mt-1.5">
        <Dot color={STATUS_COLOR[service.status]} />
      </span>
      <span>
        <span className="font-medium text-zinc-200">{service.name}</span>{" "}
        <span className="text-zinc-400">{service.detail}</span>
      </span>
    </li>
  );
}

export default function SetupClient({ required, optional, allSet }: SetupClientProps) {
  const [secrets] = useState<string[]>(() => GENERATED_SECRETS.map(() => generateSecret()));
  const [password, setPassword] = useState("");
  const [state, setState] = useState<FinishState>({ phase: "idle" });

  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setState({ phase: "submitting" });
      try {
        const response = await fetch("/api/setup/finish", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password }),
        });
        const data: {
          ok?: boolean;
          error?: string;
          services?: ServiceResult[];
        } = await response.json().catch(() => ({}));

        if (response.status === 401) {
          setState({ phase: "wrong-password" });
          return;
        }
        if (response.status === 409) {
          setState({ phase: "already-finished" });
          return;
        }
        if (!response.ok || !data.ok) {
          setState({ phase: "failed", services: data.services ?? [] });
          return;
        }
        // Setup finished. If an optional service failed, show it (never hide
        // a failed check behind a redirect); otherwise go to login (SPEC 8.12).
        const services = data.services ?? [];
        if (services.some((service) => service.status === "ERROR")) {
          setState({ phase: "completed-with-warnings", services });
        } else {
          window.location.replace("/login");
        }
      } catch (cause) {
        console.error("setup: finish call failed", cause);
        setState({
          phase: "failed",
          services: [
            {
              name: "network",
              status: "ERROR",
              detail: "Could not reach the app to finish setup. Try again.",
            },
          ],
        });
      }
    },
    [password],
  );

  const darkCard: CSSProperties = { background: "#131316", borderColor: "#2a2a30" };

  return (
    <main className="flex min-h-dvh flex-col items-center px-4 py-12" style={{ background: "#0b0b0d" }}>
      <div className="w-full max-w-xl rounded-2xl border p-8" style={darkCard}>
        <h1 className="text-2xl font-semibold text-white">Almost ready</h1>
        <p className="mt-2 text-sm text-zinc-400">
          Tapedeck needs a few settings before it goes live. This page shows
          variable names only, never their values.
        </p>

        <ul className="mt-6 space-y-1">
          {required.map((variable) => (
            <li key={variable.name} className="flex items-center gap-2.5 py-1 text-sm">
              <Dot color={variable.present ? "green" : "red"} />
              <span className="font-mono text-zinc-200">{variable.name}</span>
              {!variable.present && (
                <span className="text-zinc-500">not set yet</span>
              )}
            </li>
          ))}
          {optional.map((variable) => (
            <li key={variable.name} className="flex items-start gap-2.5 py-1 text-sm">
              <span className="mt-1.5">
                <Dot color={variable.present ? "green" : "amber"} />
              </span>
              <span>
                <span className="font-mono text-zinc-200">{variable.name}</span>{" "}
                <span className="text-zinc-500">{variable.purpose}</span>
              </span>
            </li>
          ))}
        </ul>

        <h2 className="mt-8 text-sm font-semibold text-zinc-300">Go live, step by step</h2>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-zinc-400">
          {GO_LIVE_STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>

        {!allSet && (
          <section className="mt-8">
            <h2 className="text-sm font-semibold text-zinc-300">
              Three fresh secrets for step 5
            </h2>
            <p className="mt-2 text-sm text-zinc-500">
              Generated just now on this device. Copy each one into Vercel as
              its variable name.
            </p>
            <div className="mt-3 space-y-2">
              {GENERATED_SECRETS.map((secret, index) => (
                <CopyRow key={secret.name} label={secret.name} value={secrets[index]} />
              ))}
            </div>
          </section>
        )}

        {allSet && (
          <form onSubmit={submit} className="mt-8">
            <label htmlFor="setup-password" className="block text-sm font-medium text-zinc-300">
              Your password
            </label>
            <div className="mt-2 flex gap-2">
              <input
                id="setup-password"
                type="password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="h-10 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none focus:border-zinc-500"
                autoComplete="current-password"
              />
              <button
                type="submit"
                disabled={state.phase === "submitting"}
                className="h-10 rounded-lg bg-white px-4 text-sm font-semibold text-zinc-900 transition-opacity disabled:opacity-50"
              >
                {state.phase === "submitting" ? "Finishing…" : "Finish setup"}
              </button>
            </div>

            {state.phase === "wrong-password" && (
              <p className="mt-3 text-sm" style={{ color: DOT_COLORS.red }}>
                Wrong password.
              </p>
            )}
            {state.phase === "already-finished" && (
              <p className="mt-3 text-sm text-zinc-300">
                Setup is already finished.{" "}
                <a href="/login" className="underline hover:text-white">
                  Go to login
                </a>
              </p>
            )}
            {state.phase === "completed-with-warnings" && (
              <div className="mt-4">
                <p className="text-sm font-medium text-zinc-300">
                  Setup is finished. One or more optional services had problems:
                </p>
                <ul className="mt-2">
                  {state.services.map((service) => (
                    <ServiceRow key={service.name} service={service} />
                  ))}
                </ul>
                <a
                  href="/login"
                  className="mt-3 inline-block rounded-lg bg-white px-4 py-2 text-sm font-semibold text-zinc-900"
                >
                  Continue to login
                </a>
              </div>
            )}
            {state.phase === "failed" && state.services.length > 0 && (
              <div className="mt-4">
                <p className="text-sm font-medium text-zinc-300">
                  Finish setup could not complete. Fix the failing service and press the button again.
                </p>
                <ul className="mt-2">
                  {state.services.map((service) => (
                    <ServiceRow key={service.name} service={service} />
                  ))}
                </ul>
              </div>
            )}
          </form>
        )}
      </div>
    </main>
  );
}
