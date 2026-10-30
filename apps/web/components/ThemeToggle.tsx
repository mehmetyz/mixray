"use client";

import { useSyncExternalStore } from "react";

export type ThemeMode = "dark" | "light";

const THEME_STORAGE_KEY = "mixray-theme";

function subscribeTheme(callback: () => void): () => void {
  window.addEventListener("mixray-theme-change", callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener("mixray-theme-change", callback);
    window.removeEventListener("storage", callback);
  };
}

function getThemeSnapshot(): ThemeMode {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

function getServerThemeSnapshot(): ThemeMode {
  return "dark";
}

function getTickSnapshot(): number {
  return document.documentElement.getAttribute("data-theme") === "light" ? 1 : 0;
}

function getServerTickSnapshot(): number {
  return 0;
}

export function useThemeListener(): number {
  return useSyncExternalStore(subscribeTheme, getTickSnapshot, getServerTickSnapshot);
}

export function useCurrentTheme(): ThemeMode {
  return useSyncExternalStore(subscribeTheme, getThemeSnapshot, getServerThemeSnapshot);
}

export function ThemeToggle() {
  const theme = useCurrentTheme();

  const toggleTheme = () => {
    const nextTheme: ThemeMode = theme === "dark" ? "light" : "dark";
    if (nextTheme === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
    try {
      localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    } catch {
      // Storage unavailable in private browsing
    }
    window.dispatchEvent(new Event("mixray-theme-change"));
  };

  return (
    <button
      type="button"
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
      onClick={toggleTheme}
      className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-line-2 bg-surface-2/80 px-2.5 py-1 text-xs font-medium text-text-2 transition hover:border-control hover:bg-surface-2 hover:text-text focus:outline-none"
    >
      {theme === "light" ? (
        <>
          <svg
            className="h-3.5 w-3.5 text-accent"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <circle cx="12" cy="12" r="4" />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"
            />
          </svg>
          <span className="hidden text-[11px] font-medium sm:inline">Light</span>
        </>
      ) : (
        <>
          <svg
            className="h-3.5 w-3.5 text-text-2"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
            />
          </svg>
          <span className="hidden text-[11px] font-medium sm:inline">Dark</span>
        </>
      )}
    </button>
  );
}

