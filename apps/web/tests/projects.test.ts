import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { deleteProject, getProject, getProjects, saveProject, subscribeProjects, updateProject } from "../lib/projects/storage";
import type { ProjectRecord } from "../lib/projects/types";

const STORAGE_KEY = "mixray.projects";

const stored = new Map<string, string>();
const events = new EventTarget();
let storageFails = false;

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (storageFails) throw new Error("quota");
        stored.set(key, value);
      },
    },
    dispatchEvent: (event: Event) => events.dispatchEvent(event),
    addEventListener: (name: string, listener: EventListener) => events.addEventListener(name, listener),
    removeEventListener: (name: string, listener: EventListener) => events.removeEventListener(name, listener),
  },
});

function project(id: string, title = "A clip"): ProjectRecord {
  return { id, title, kind: "video", duration: 8, createdAt: 1, updatedAt: 1 };
}

beforeEach(() => {
  stored.clear();
  storageFails = false;
});

describe("the clip list in this browser", () => {
  it("starts empty", () => assert.deepEqual(getProjects(), []));

  it("lists the newest clip first", () => {
    saveProject(project("a"));
    saveProject(project("b"));
    assert.deepEqual(getProjects().map((item) => item.id), ["b", "a"]);
  });

  it("does not list one clip twice", () => {
    saveProject(project("a", "Old name"));
    saveProject(project("a", "New name"));
    assert.equal(getProjects().length, 1);
    assert.equal(getProject("a")?.title, "New name");
  });

  it("updates a clip without letting its id change", () => {
    saveProject(project("a"));
    updateProject("a", { id: "z", bpm: 96 });
    assert.equal(getProject("a")?.bpm, 96);
    assert.equal(getProject("z"), null);
  });

  it("ignores an update for a clip it does not have", () => {
    updateProject("absent", { bpm: 96 });
    assert.deepEqual(getProjects(), []);
  });

  it("removes a clip", () => {
    saveProject(project("a"));
    assert.equal(deleteProject("a"), true);
    assert.equal(deleteProject("a"), false);
    assert.deepEqual(getProjects(), []);
  });

  it("returns the same list until storage changes, or React renders forever", () => {
    saveProject(project("a"));
    assert.equal(getProjects(), getProjects());
  });

  it("survives broken storage instead of breaking the home page", () => {
    stored.set(STORAGE_KEY, "{not json");
    assert.deepEqual(getProjects(), []);
    stored.set(STORAGE_KEY, '{"not":"a list"}');
    assert.deepEqual(getProjects(), []);
  });

  it("drops records it cannot trust and keeps the others", () => {
    stored.set(STORAGE_KEY, JSON.stringify([project("a"), { id: "b" }, 3, { ...project("c"), kind: "movie" }]));
    assert.deepEqual(getProjects().map((item) => item.id), ["a"]);
  });

  it("does not throw when storage is full", (context) => {
    context.mock.method(console, "error", () => undefined);
    saveProject(project("a"));
    storageFails = true;
    saveProject(project("b"));
    updateProject("a", { bpm: 1 });
    assert.equal(deleteProject("a"), false);
    assert.deepEqual(getProjects().map((item) => item.id), ["a"]);
  });

  it("tells subscribers about a change and stops when asked", () => {
    let calls = 0;
    const unsubscribe = subscribeProjects(() => {
      calls += 1;
    });
    saveProject(project("a"));
    assert.equal(calls, 1);
    unsubscribe();
    saveProject(project("b"));
    assert.equal(calls, 1);
  });
});
