import { describe, expect, it } from "vitest";
import {
  buildChunkTrack,
  findActiveTimedWordIndex,
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

  it("assigns unique time ranges when multiple source words map to one spoken word", () => {
    // Whisper returns 1 spoken word for 3 source words
    const track = buildChunkTrack(
      "I am very happy today.",
      [
        { word: "I", start: 0, end: 0.2 },
        { word: "happy", start: 0.8, end: 1.2 },
        { word: "today", start: 1.3, end: 1.7 },
      ],
      0,
    );

    // "am" and "very" are not in the spoken words, so they sit in the gap
    // between the "I" anchor and the "happy" anchor. They should get unique
    // time windows so the binary search can land on each one individually.
    const hydrated = hydrateChunkTracks([track]);
    const starts = hydrated.timedWords.map((w) => w.articleStart);

    // Every word should have a distinct start time
    const uniqueStarts = new Set(starts);
    expect(uniqueStarts.size).toBe(starts.length);

    // Verify binary search can find each word individually
    for (let i = 0; i < hydrated.timedWords.length; i++) {
      const word = hydrated.timedWords[i];
      const midTime = (word.articleStart + word.articleEnd) / 2;
      const found = findActiveTimedWordIndex(hydrated.timedWords, midTime);
      expect(found).toBe(i);
    }
  });

  it("does not skip words when Whisper reports overlapping timestamps", () => {
    // Whisper sometimes gives consecutive words the same or overlapping start times
    const track = buildChunkTrack(
      "She quickly ran away.",
      [
        { word: "She", start: 0, end: 0.3 },
        { word: "quickly", start: 0.3, end: 0.3 },
        { word: "ran", start: 0.3, end: 0.6 },
        { word: "away", start: 0.7, end: 1.0 },
      ],
      0,
    );

    const hydrated = hydrateChunkTracks([track]);
    const starts = hydrated.timedWords.map((w) => w.articleStart);

    // Every word must have a strictly increasing start time
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]).toBeGreaterThan(starts[i - 1]);
    }

    // Binary search must be able to land on each word
    for (let i = 0; i < hydrated.timedWords.length; i++) {
      const word = hydrated.timedWords[i];
      const midTime = (word.articleStart + word.articleEnd) / 2;
      const found = findActiveTimedWordIndex(hydrated.timedWords, midTime);
      expect(found).toBe(i);
    }
  });
});
