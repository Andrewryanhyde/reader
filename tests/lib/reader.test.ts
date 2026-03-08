import { describe, expect, it } from "vitest";
import {
  buildChunkTrack,
  hydrateChunkTracks,
  inflateSavedChunkTrack,
  tokenizeDisplayTokens,
} from "@/lib/reader";

describe("lib/reader", () => {
  it("tokenizes text and assigns paragraph-separated blocks", () => {
    const tokens = tokenizeDisplayTokens("Hello world.\n\nSecond paragraph.");

    expect(tokens.filter((token) => token.kind === "word")).toHaveLength(4);
    expect(tokens[0].blockIndex).toBe(0);
    expect(tokens.at(-1)?.blockIndex).toBe(1);
  });

  it("builds a chunk track with aligned spoken words", () => {
    const track = buildChunkTrack(
      "Hello world.",
      [
        { word: "Hello", start: 0, end: 0.4 },
        { word: "world", start: 0.45, end: 0.9 },
      ],
      0,
    );

    expect(track.timedWords).toHaveLength(2);
    expect(track.quality.coverage).toBe(1);
    expect(track.quality.interpolatedWordCount).toBe(0);
    expect(track.durationSeconds).toBe(0.9);
    expect(track.timedWords[1]).toMatchObject({
      normalized: "world",
      interpolated: false,
      articleEnd: 0.9,
    });
  });

  it("inflates legacy saved chunks and hydrates global offsets across chunks", () => {
    const firstChunk = inflateSavedChunkTrack(
      {
        tokens: [
          { value: "Hello", isWord: true, start: 0, end: 0.4 },
          { value: " ", isWord: false, start: null, end: null },
          { value: "world.", isWord: true, start: 0.5, end: 0.9 },
        ],
      },
      0,
    );

    const secondChunk = buildChunkTrack(
      "Second chunk.",
      [
        { word: "Second", start: 0, end: 0.35 },
        { word: "chunk", start: 0.4, end: 0.8 },
      ],
      1,
    );

    const hydrated = hydrateChunkTracks([firstChunk, secondChunk]);

    expect(firstChunk.quality.coverage).toBe(1);
    expect(hydrated.totalDuration).toBeCloseTo(1.7);
    expect(hydrated.timedWords[2]).toMatchObject({
      globalIndex: 2,
      chunkIndex: 1,
      articleStart: 0.9,
      articleEnd: 1.25,
    });
    expect(hydrated.displayTokens[0].globalWordIndex).toBe(0);
    expect(hydrated.displayTokens.at(-1)?.globalBlockIndex).toBeGreaterThanOrEqual(1);
  });
});
