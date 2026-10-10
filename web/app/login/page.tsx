"use client";

// Password screen (SPEC 8.1): one password field, button "Unlock".
// Styling follows the SPEC 10 tokens; accent is used only on Unlock.
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

const WRONG_PASSWORD_MESSAGE = "Wrong password. Try again.";
const RATE_LIMIT_MESSAGE = "Too many attempts. Try again in 10 minutes.";
const GENERIC_ERROR_MESSAGE = "Something went wrong. Try again.";

const inputClasses =
  "w-full rounded-[6px] border border-[#2a2a30] bg-[#0b0b0d] px-3 py-2 " +
  "text-[#f2f2f4] placeholder-[#9a9aa3] " +
  "focus:outline-2 focus:outline-offset-2 focus:outline-[#e8e8ea]";

const buttonClasses =
  "w-full rounded-[6px] bg-[#ff7a1a] px-3 py-2 font-medium text-[#0b0b0d] " +
  "hover:bg-[#ff9a4d] disabled:opacity-60 " +
  "focus:outline-2 focus:outline-offset-2 focus:outline-[#e8e8ea]";

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (response.ok) {
        // Client navigation carries the fresh session cookie; refresh()
        // drops any RSC payload cached while logged out.
        router.push("/");
        router.refresh();
        return;
      }
      setError(
        response.status === 429
          ? RATE_LIMIT_MESSAGE
          : response.status === 401
            ? WRONG_PASSWORD_MESSAGE
            : GENERIC_ERROR_MESSAGE,
      );
      setPassword("");
    } catch {
      setError(GENERIC_ERROR_MESSAGE);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[#0b0b0d] px-4 text-[#f2f2f4]">
      <div className="w-full max-w-sm rounded-[8px] border border-[#2a2a30] bg-[#121215] p-8 shadow-[0_6px_16px_rgba(0,0,0,0.3)]">
        <h1 className="text-xl font-semibold">Tapedeck</h1>
        <p className="mt-1 text-sm text-[#9a9aa3]">Enter your password to continue.</p>
        <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4" noValidate>
          <label className="flex flex-col gap-1.5 text-sm text-[#9a9aa3]">
            Password
            <input
              type="password"
              name="password"
              aria-label="Password"
              autoComplete="current-password"
              autoFocus
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className={inputClasses}
              placeholder="Your password"
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-[#ff6f66]">
              {error}
            </p>
          )}
          <button type="submit" disabled={submitting} className={buttonClasses}>
            {submitting ? "Unlocking" : "Unlock"}
          </button>
        </form>
      </div>
    </main>
  );
}
