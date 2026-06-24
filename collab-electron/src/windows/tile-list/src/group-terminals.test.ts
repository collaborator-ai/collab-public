import { describe, expect, test } from "bun:test";
import { groupTerminals } from "./group-terminals";
import type { TileEntry } from "./group-terminals";

function term(id: string, cwd: string): TileEntry {
  return { id, type: "term", title: id, description: cwd, status: "running" };
}

describe("groupTerminals", () => {
  test("nests a terminal under the folder containing its cwd", () => {
    const groups = groupTerminals(
      ["/home/me/proj"],
      [term("t1", "/home/me/proj/src")],
    );
    expect(groups).toEqual([
      { folder: "/home/me/proj", terminals: [term("t1", "/home/me/proj/src")] },
    ]);
  });

  test("matches a terminal whose cwd is exactly the folder path", () => {
    const groups = groupTerminals(
      ["/home/me/proj"],
      [term("t1", "/home/me/proj")],
    );
    expect(groups[0].terminals.map((t) => t.id)).toEqual(["t1"]);
  });

  test("nested folders: terminal lands under the deepest match, listed once", () => {
    const groups = groupTerminals(
      ["/home/me/proj", "/home/me/proj/pkg"],
      [term("t1", "/home/me/proj/pkg/lib")],
    );
    const proj = groups.find((g) => g.folder === "/home/me/proj");
    const pkg = groups.find((g) => g.folder === "/home/me/proj/pkg");
    expect(proj?.terminals).toEqual([]);
    expect(pkg?.terminals.map((t) => t.id)).toEqual(["t1"]);
  });

  test("excludes non-terminal tiles", () => {
    const note: TileEntry = {
      id: "n1",
      type: "note",
      title: "n1",
      description: "/home/me/proj/notes.md",
      status: null,
    };
    const groups = groupTerminals(["/home/me/proj"], [note]);
    expect(groups[0].terminals).toEqual([]);
  });

  test("excludes terminals whose cwd is outside every folder", () => {
    const groups = groupTerminals(
      ["/home/me/proj"],
      [term("t1", "/var/tmp")],
    );
    expect(groups[0].terminals).toEqual([]);
  });

  test("returns one group per folder in input order, empty folders included", () => {
    const groups = groupTerminals(
      ["/a", "/b"],
      [term("t1", "/b/x")],
    );
    expect(groups.map((g) => g.folder)).toEqual(["/a", "/b"]);
    expect(groups[0].terminals).toEqual([]);
    expect(groups[1].terminals.map((t) => t.id)).toEqual(["t1"]);
  });

  test("preserves tile order within a group", () => {
    const groups = groupTerminals(
      ["/a"],
      [term("t1", "/a/x"), term("t2", "/a/y"), term("t3", "/a/z")],
    );
    expect(groups[0].terminals.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
  });
});
