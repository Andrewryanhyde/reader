"use client";

import { MutableRefObject, RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  findActiveTimedWordIndex,
  getEstimatedBlockHeight,
  HydratedDisplayToken,
  HydratedReaderTrack,
} from "@/lib/reader";

const BLOCK_OVERSCAN = 2;
const FOCUS_BAND_TOP = 0.5;
const SCROLL_LERP = 0.13;

type Sentence = {
  wordStart: number;
  wordEnd: number;
};

type FocusReaderProps = {
  audioRef: RefObject<HTMLAudioElement | null>;
  chunkStartTimes: number[];
  currentChunkIndexRef: MutableRefObject<number>;
  isPlaying: boolean;
  placeholderText: string;
  title: string;
  track: HydratedReaderTrack | null;
};

function buildSentences(tokens: HydratedDisplayToken[]): Sentence[] {
  const sentences: Sentence[] = [];
  let sentenceStart: number | null = null;
  let lastWordIndex: number | null = null;

  for (const token of tokens) {
    if (token.globalWordIndex !== null) {
      if (sentenceStart === null) {
        sentenceStart = token.globalWordIndex;
      }
      lastWordIndex = token.globalWordIndex;
    }

    if (
      token.kind === "word" &&
      /[.!?]["'\u201D\u2019)]*$/.test(token.value) &&
      sentenceStart !== null &&
      lastWordIndex !== null
    ) {
      sentences.push({ wordStart: sentenceStart, wordEnd: lastWordIndex });
      sentenceStart = null;
      lastWordIndex = null;
    }
  }

  if (sentenceStart !== null && lastWordIndex !== null) {
    sentences.push({ wordStart: sentenceStart, wordEnd: lastWordIndex });
  }

  return sentences;
}

function findSentence(sentences: Sentence[], wordIndex: number): Sentence | null {
  for (const sentence of sentences) {
    if (wordIndex >= sentence.wordStart && wordIndex <= sentence.wordEnd) {
      return sentence;
    }
    if (sentence.wordStart > wordIndex) break;
  }
  return null;
}

export function FocusReader({
  audioRef,
  chunkStartTimes,
  currentChunkIndexRef,
  isPlaying,
  placeholderText,
  title,
  track,
}: FocusReaderProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const blockRefs = useRef(new Map<number, HTMLDivElement>());
  const wordRefs = useRef(new Map<number, HTMLSpanElement>());
  const rafRef = useRef<number | null>(null);
  const [activeBlockIndex, setActiveBlockIndex] = useState(0);
  const [activeWordIndex, setActiveWordIndex] = useState(-1);
  const [measuredHeights, setMeasuredHeights] = useState<Record<number, number>>({});

  const blocks = useMemo(() => track?.blocks ?? [], [track]);
  const visibleStart = Math.max(0, activeBlockIndex - BLOCK_OVERSCAN);
  const visibleEnd = Math.min(blocks.length - 1, activeBlockIndex + BLOCK_OVERSCAN);

  const visibleBlocks = useMemo(() => {
    if (!track || blocks.length === 0) return [];
    return blocks.slice(visibleStart, visibleEnd + 1);
  }, [blocks, track, visibleEnd, visibleStart]);

  const sentences = useMemo(() => {
    if (!track) return [];
    return buildSentences(track.displayTokens);
  }, [track]);

  const activeSentence = useMemo(() => {
    if (activeWordIndex < 0) return null;
    return findSentence(sentences, activeWordIndex);
  }, [sentences, activeWordIndex]);

  const topSpacerHeight = useMemo(() => {
    if (!track) return 0;
    let total = 0;
    for (let index = 0; index < visibleStart; index += 1) {
      total += measuredHeights[index] ?? getEstimatedBlockHeight(track.blocks[index]);
    }
    return total;
  }, [measuredHeights, track, visibleStart]);

  const bottomSpacerHeight = useMemo(() => {
    if (!track) return 0;
    let total = 0;
    for (let index = visibleEnd + 1; index < track.blocks.length; index += 1) {
      total += measuredHeights[index] ?? getEstimatedBlockHeight(track.blocks[index]);
    }
    return total;
  }, [measuredHeights, track, visibleEnd]);

  const registerBlockRef = useCallback((blockIndex: number, node: HTMLDivElement | null) => {
    if (node) {
      blockRefs.current.set(blockIndex, node);
      const measuredHeight = node.getBoundingClientRect().height;
      setMeasuredHeights((prev) => {
        if (prev[blockIndex] === measuredHeight) return prev;
        return { ...prev, [blockIndex]: measuredHeight };
      });
    } else {
      blockRefs.current.delete(blockIndex);
    }
  }, []);

  const registerWordRef = useCallback((wordIndex: number, node: HTMLSpanElement | null) => {
    if (node) {
      wordRefs.current.set(wordIndex, node);
    } else {
      wordRefs.current.delete(wordIndex);
    }
  }, []);

  const scrollToWord = useCallback((wordIndex: number, smooth: boolean) => {
    const container = containerRef.current;
    const wordEl = wordRefs.current.get(wordIndex);
    if (!container || !wordEl) return;

    const containerRect = container.getBoundingClientRect();
    const wordRect = wordEl.getBoundingClientRect();

    const wordCenterInViewport = wordRect.top + wordRect.height / 2 - containerRect.top;
    const targetPosition = container.clientHeight * FOCUS_BAND_TOP;
    const delta = wordCenterInViewport - targetPosition;

    if (Math.abs(delta) < 2) return;

    if (smooth) {
      container.scrollTop += delta * SCROLL_LERP;
    } else {
      container.scrollTop += delta;
    }
  }, []);

  const syncToAudioClock = useCallback((smooth: boolean) => {
    if (!track || track.timedWords.length === 0) return;

    const audio = audioRef.current;
    const articleTime =
      (chunkStartTimes[currentChunkIndexRef.current] ?? 0) + (audio?.currentTime ?? 0);
    const fallbackIndex =
      articleTime <= track.timedWords[0].articleStart ? 0 : track.timedWords.length - 1;
    const nextTimedWordIndex = findActiveTimedWordIndex(track.timedWords, articleTime);
    const nextWord = track.timedWords[nextTimedWordIndex >= 0 ? nextTimedWordIndex : fallbackIndex];
    const nextWordIndex = nextWord?.globalIndex ?? -1;
    const nextBlockIndex = nextWord?.globalBlockIndex ?? 0;

    if (nextWordIndex >= 0) {
      scrollToWord(nextWordIndex, smooth);
      setActiveWordIndex((current) => (current === nextWordIndex ? current : nextWordIndex));
      setActiveBlockIndex((current) => (current === nextBlockIndex ? current : nextBlockIndex));
    }
  }, [audioRef, chunkStartTimes, currentChunkIndexRef, scrollToWord, track]);

  // Initial sync when track loads
  useEffect(() => {
    const frame = requestAnimationFrame(() => syncToAudioClock(false));
    return () => cancelAnimationFrame(frame);
  }, [syncToAudioClock, track]);

  // Re-scroll when visible blocks change (virtualization re-renders)
  // Double-raf ensures the DOM has settled after block mount
  useEffect(() => {
    if (activeWordIndex < 0) return;
    let cancelled = false;
    requestAnimationFrame(() => {
      if (cancelled) return;
      scrollToWord(activeWordIndex, false);
      requestAnimationFrame(() => {
        if (cancelled) return;
        scrollToWord(activeWordIndex, false);
      });
    });
    return () => { cancelled = true; };
  }, [activeWordIndex, scrollToWord, visibleBlocks]);

  // Animation loop during playback
  useEffect(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    if (!track || !isPlaying) {
      const frame = requestAnimationFrame(() => syncToAudioClock(false));
      return () => cancelAnimationFrame(frame);
    }

    const tick = () => {
      syncToAudioClock(true);
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [isPlaying, syncToAudioClock, track]);

  const hasTrack = Boolean(track && track.blocks.length > 0);

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      {title && (
        <div className="shrink-0 px-5 pt-6 sm:px-10 lg:px-16">
          <h2 className="mx-auto max-w-3xl font-serif text-2xl font-medium leading-snug tracking-tight text-foreground sm:text-3xl">
            {title}
          </h2>
        </div>
      )}

      <div className="relative mt-4 min-h-0 flex-1 overflow-hidden">
        <div className="pointer-events-none absolute inset-x-0 top-0 z-0 h-[18%] bg-gradient-to-b from-background via-background/70 to-transparent" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-0 h-[26%] bg-gradient-to-t from-background via-background/72 to-transparent" />

        <div
          ref={containerRef}
          className="reading-scroll relative z-10 h-full overflow-y-auto px-5 py-10 sm:px-10 lg:px-16"
        >
          <div className="relative mx-auto max-w-3xl" style={{ paddingTop: '45vh', paddingBottom: '45vh' }}>
            {!hasTrack ? (
              <div className="py-24 font-serif text-xl leading-[2] text-foreground/70">
                {placeholderText}
              </div>
            ) : (
              <>
                {topSpacerHeight > 0 && <div style={{ height: `${topSpacerHeight}px` }} />}

                {visibleBlocks.map((block) => (
                  <div
                    key={block.globalIndex}
                    ref={(node) => registerBlockRef(block.globalIndex, node)}
                    className={[
                      "focus-block relative z-10 py-6 font-serif text-[1.35rem] leading-[2.05] tracking-[0.005em] transition-[opacity,color,filter] duration-150 sm:text-[1.6rem] sm:leading-[2.1]",
                      block.globalIndex === activeBlockIndex
                        ? "opacity-100 text-foreground"
                        : "opacity-[0.74] text-foreground/75",
                    ].join(" ")}
                  >
                    {(track?.displayTokens.slice(block.tokenStart, block.tokenEnd + 1) ?? []).map(
                      (token) => {
                        if (token.globalWordIndex === null) {
                          return <span key={token.globalTokenIndex}>{token.value}</span>;
                        }

                        const isActive = token.globalWordIndex === activeWordIndex;
                        const isInSentence =
                          activeSentence !== null &&
                          token.globalWordIndex >= activeSentence.wordStart &&
                          token.globalWordIndex <= activeSentence.wordEnd;
                        const isSpoken =
                          !isInSentence &&
                          block.globalIndex === activeBlockIndex &&
                          token.globalWordIndex !== null &&
                          token.globalWordIndex < activeWordIndex;

                        return (
                          <span
                            key={token.globalTokenIndex}
                            ref={(node) => registerWordRef(token.globalWordIndex ?? -1, node)}
                            className={[
                              "focus-word rounded-[0.25em] px-[0.08em] py-[0.04em]",
                              isActive
                                ? "focus-word--active"
                                : isInSentence
                                  ? "focus-word--sentence"
                                  : isSpoken
                                    ? "focus-word--spoken"
                                    : "",
                            ].join(" ")}
                          >
                            {token.value}
                          </span>
                        );
                      },
                    )}
                  </div>
                ))}

                {bottomSpacerHeight > 0 && <div style={{ height: `${bottomSpacerHeight}px` }} />}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
