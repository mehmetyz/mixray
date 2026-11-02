"use client";

import { useSyncExternalStore } from "react";
import type { ProjectRecord } from "./types";

const STORAGE_KEY = "mixray.projects";
const STORAGE_EVENT = "mixray.projects-changed";

const NO_PROJECTS: readonly ProjectRecord[] = [];

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function isObjectRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function isProjectRecord(item: unknown): item is ProjectRecord {
  if (!isObjectRecord(item)) return false;
  const id = item["id"];
  const title = item["title"];
  const kind = item["kind"];
  const duration = item["duration"];
  const createdAt = item["createdAt"];
  const updatedAt = item["updatedAt"];

  return (
    typeof id === "string" &&
    typeof title === "string" &&
    (kind === "audio" || kind === "video") &&
    typeof duration === "number" &&
    typeof createdAt === "number" &&
    typeof updatedAt === "number"
  );
}

function notifySubscribers(): void {
  if (!isBrowser()) return;
  window.dispatchEvent(new CustomEvent(STORAGE_EVENT));
}

let cachedRaw: string | null = null;
let cachedProjects: readonly ProjectRecord[] = NO_PROJECTS;

/**
 * The saved list. The same array comes back until storage changes, which is what
 * `useSyncExternalStore` needs to avoid rendering forever.
 */
export function getProjects(): readonly ProjectRecord[] {
  if (!isBrowser()) return NO_PROJECTS;

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === cachedRaw) return cachedProjects;
    cachedRaw = raw;
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    cachedProjects = Array.isArray(parsed) ? parsed.filter(isProjectRecord) : NO_PROJECTS;
  } catch {
    cachedProjects = NO_PROJECTS;
  }
  return cachedProjects;
}

/** Retrieve a single project by clip ID */
export function getProject(id: string): ProjectRecord | null {
  const projects = getProjects();
  return projects.find((p) => p.id === id) ?? null;
}

/** Add a new project or replace an existing one */
export function saveProject(project: ProjectRecord): void {
  if (!isBrowser()) return;

  const projects = getProjects();
  const index = projects.findIndex((p) => p.id === project.id);

  let updated: readonly ProjectRecord[];
  if (index >= 0) {
    updated = projects.map((item, at) => (at === index ? { ...item, ...project, updatedAt: Date.now() } : item));
  } else {
    updated = [project, ...projects];
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    notifySubscribers();
  } catch (error) {
    console.error("Failed to save project to localStorage:", error);
  }
}

/** Notes a sound this browser asked for, on clips that keep such a list. */
export function rememberSound(id: string, soundId: string): void {
  const soundIds = getProject(id)?.soundIds;
  if (soundIds === undefined || soundIds.includes(soundId)) return;
  updateProject(id, { soundIds: [...soundIds, soundId] });
}

/** Update specific fields on an existing project */
export function updateProject(id: string, patch: Partial<ProjectRecord>): void {
  if (!isBrowser()) return;

  const projects = getProjects();
  const index = projects.findIndex((p) => p.id === id);
  if (index === -1) return;

  const current = projects[index];
  if (!current) return;

  const updatedItem: ProjectRecord = {
    ...current,
    ...patch,
    id: current.id,
    updatedAt: Date.now(),
  };

  const updated = [...projects];
  updated[index] = updatedItem;

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    notifySubscribers();
  } catch (error) {
    console.error("Failed to update project in localStorage:", error);
  }
}

/** Removes a clip from this list. The engine still deletes the clip itself after seven days. */
export function deleteProject(id: string): boolean {
  if (!isBrowser()) return false;

  const projects = getProjects();
  if (!projects.some((p) => p.id === id)) return false;

  const filtered = projects.filter((p) => p.id !== id);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
    notifySubscribers();
    return true;
  } catch (error) {
    console.error("Failed to delete project from localStorage:", error);
    return false;
  }
}

/**
 * Subscribe to project list changes (across tabs and within the current window).
 */
export function subscribeProjects(listener: () => void): () => void {
  if (!isBrowser()) return () => {};

  const handleCustom = () => listener();
  const handleStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener();
  };

  window.addEventListener(STORAGE_EVENT, handleCustom);
  window.addEventListener("storage", handleStorage);

  return () => {
    window.removeEventListener(STORAGE_EVENT, handleCustom);
    window.removeEventListener("storage", handleStorage);
  };
}

function getServerProjects(): readonly ProjectRecord[] {
  return NO_PROJECTS;
}

/** The saved list, empty during server rendering so the first client render matches it. */
export function useProjects(): readonly ProjectRecord[] {
  return useSyncExternalStore(subscribeProjects, getProjects, getServerProjects);
}

export function useProject(id: string): ProjectRecord | null {
  return useSyncExternalStore(
    subscribeProjects,
    () => getProject(id),
    () => null,
  );
}
