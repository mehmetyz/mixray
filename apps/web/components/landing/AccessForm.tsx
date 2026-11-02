"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

type AccessFormProps = {
  hasAccess: boolean;
  next: string;
  linkFailed: boolean;
};

const PRIMARY =
  "flex h-11 shrink-0 cursor-pointer items-center justify-center rounded-icon bg-text px-5 text-sm font-semibold text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";

function messageFrom(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("message" in body)) return null;
  return typeof body.message === "string" ? body.message : null;
}

export function AccessForm({ hasAccess, next, linkFailed }: AccessFormProps) {
  const [key, setKey] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(
    linkFailed ? "The key in that link didn't work. Enter it here." : null,
  );

  if (hasAccess) {
    return (
      <Link href={next} className={`${PRIMARY} w-fit`}>
        Open the studio
      </Link>
    );
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key }),
      });
      if (response.ok) {
        window.location.assign(next);
        return;
      }
      setError(messageFrom(await response.json().catch(() => null)) ?? "That key didn't work. Check it and try again.");
    } catch {
      setError("Could not reach Mixray. Check the connection and try again.");
    }
    setBusy(false);
  };

  return (
    <form onSubmit={submit} className="max-w-md">
      <label htmlFor="access-key" className="block text-sm font-medium text-text">
        Access key
      </label>
      <div className="mt-2 flex gap-2">
        <input
          id="access-key"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(event) => setKey(event.target.value)}
          aria-describedby={error === null ? "access-note" : "access-error"}
          className="h-11 min-w-0 flex-1 rounded-icon border border-line-2 bg-inset px-3 text-sm text-text focus:border-control focus:outline-none"
        />
        <button type="submit" disabled={busy || key.trim().length === 0} className={PRIMARY}>
          {busy ? "Checking" : "Open Mixray"}
        </button>
      </div>
      {error !== null ? (
        <p id="access-error" role="alert" className="mt-2 text-sm text-text">
          {error}
        </p>
      ) : (
        <p id="access-note" className="mt-2 text-sm text-text-2">
          Judges: the access key is in the submission notes.
        </p>
      )}
    </form>
  );
}
