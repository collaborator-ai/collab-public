/**
 * Tests for pure navigation policy in tile-navigation.js.
 */
import { describe, test, expect } from "bun:test";
import { resolveTileNavigation } from "./tile-navigation.js";

describe("resolveTileNavigation", () => {
  test("no fullscreen: plain selection pans", () => {
    expect(
      resolveTileNavigation({
        fullscreenTileId: null,
        targetTileId: "a",
        focus: false,
      }),
    ).toEqual({ kind: "pan" });
  });

  test("no fullscreen: focusing selection pans and focuses", () => {
    expect(
      resolveTileNavigation({
        fullscreenTileId: null,
        targetTileId: "a",
        focus: true,
      }),
    ).toEqual({ kind: "pan-and-focus" });
  });

  test("fullscreen: selecting a different tile swaps the fullscreen view", () => {
    expect(
      resolveTileNavigation({
        fullscreenTileId: "a",
        targetTileId: "b",
        focus: false,
      }),
    ).toEqual({ kind: "swap-fullscreen" });
  });

  test("fullscreen swap happens regardless of focus intent", () => {
    expect(
      resolveTileNavigation({
        fullscreenTileId: "a",
        targetTileId: "b",
        focus: true,
      }),
    ).toEqual({ kind: "swap-fullscreen" });
  });

  test("fullscreen: selecting the already-fullscreen tile is a no-op", () => {
    expect(
      resolveTileNavigation({
        fullscreenTileId: "a",
        targetTileId: "a",
        focus: false,
      }),
    ).toEqual({ kind: "none" });
  });
});
