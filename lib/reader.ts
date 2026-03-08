export type SpokenWord = {
  word: string;
  start: number;
  end: number;
};

export type DisplayTokenKind = "word" | "space" | "punct";

export type DisplayToken = {
  value: string;
  kind: DisplayTokenKind;
  normalized: string;
  wordIndex: number | null;
  blockIndex: number;
};

export type TimedWord = {
  tokenIndex: number;
  wordIndex: number;
  blockIndex: number;
  chunkIndex: number;
  start: number;
  end: number;
  articleStart: number;
  articleEnd: number;
  normalized: string;
  interpolated: boolean;
};

export type ReaderBlock = {
  index: number;
  tokenStart: number;
  tokenEnd: number;
  wordStart: number;
  wordEnd: number;
  text: string;
};

export type ChunkTrackQuality = {
  coverage: number;
  interpolatedWordCount: number;
};

export type ChunkTrack = {
  displayTokens: DisplayToken[];
  timedWords: TimedWord[];
  blocks: ReaderBlock[];
  durationSeconds: number;
  quality: ChunkTrackQuality;
};

export type LegacyReadingToken = {
  value: string;
  isWord: boolean;
  start: number | null;
  end: number | null;
};

export type SavedChunkTrack = {
  displayTokens?: DisplayToken[];
  timedWords?: TimedWord[];
  blocks?: ReaderBlock[];
  durationSeconds?: number;
  quality?: ChunkTrackQuality;
  tokens?: LegacyReadingToken[];
};

export type HydratedDisplayToken = DisplayToken & {
  globalTokenIndex: number;
  globalWordIndex: number | null;
  globalBlockIndex: number;
};

export type HydratedTimedWord = TimedWord & {
  globalIndex: number;
  globalTokenIndex: number;
  globalBlockIndex: number;
};

export type HydratedReaderBlock = ReaderBlock & {
  globalIndex: number;
};

export type HydratedReaderTrack = {
  displayTokens: HydratedDisplayToken[];
  timedWords: HydratedTimedWord[];
  blocks: HydratedReaderBlock[];
  totalDuration: number;
};

type SourceWord = {
  tokenIndex: number;
  wordIndex: number;
  normalized: string;
};

type NormalizedSpokenWord = SpokenWord & {
  normalized: string;
};

type Anchor = {
  sourceWordIndex: number;
  spokenWordIndex: number;
};

type TimingAssignment = {
  start: number;
  end: number;
  interpolated: boolean;
  normalized: string;
};

type WorkingDisplayToken = Omit<DisplayToken, "blockIndex">;

const TOKEN_PATTERN = /(\n{2,}|\s+|[^\s]+)/g;
const DEFAULT_BLOCK_HEIGHT = 156;
const BLOCK_TARGET_WORDS = 36;
const BLOCK_MAX_WORDS = 52;

export function normalizeWord(value: string) {
  return value
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, "");
}

export function estimateBlockHeight(block: ReaderBlock) {
  const words = Math.max(1, block.wordEnd - block.wordStart + 1);
  return Math.max(112, Math.min(220, words * 3.4 + 84));
}

export function tokenizeDisplayTokens(text: string): DisplayToken[] {
  const workingTokens = (text.match(TOKEN_PATTERN) ?? []).map<WorkingDisplayToken>((value) => {
    const normalized = normalizeWord(value);

    return {
      value,
      kind: /^\s+$/.test(value) ? "space" : normalized.length > 0 ? "word" : "punct",
      normalized,
      wordIndex: null,
    };
  });

  let wordIndex = 0;

  const displayTokens = workingTokens.map<DisplayToken>((token) => {
    if (token.kind !== "word") {
      return { ...token, blockIndex: 0 };
    }

    const nextToken = {
      ...token,
      wordIndex,
      blockIndex: 0,
    };
    wordIndex += 1;
    return nextToken;
  });

  const blocks = buildBlocks(displayTokens);

  for (const block of blocks) {
    for (let tokenIndex = block.tokenStart; tokenIndex <= block.tokenEnd; tokenIndex += 1) {
      if (displayTokens[tokenIndex]) {
        displayTokens[tokenIndex] = {
          ...displayTokens[tokenIndex],
          blockIndex: block.index,
        };
      }
    }
  }

  return displayTokens;
}

export function buildChunkTrack(text: string, spokenWords: SpokenWord[], chunkIndex: number): ChunkTrack {
  const displayTokens = tokenizeDisplayTokens(text);
  const blocks = buildBlocks(displayTokens);
  const sourceWords = extractSourceWords(displayTokens);
  const normalizedSpokenWords = spokenWords
    .map((word) => ({ ...word, normalized: normalizeWord(word.word) }))
    .filter((word) => word.normalized.length > 0);

  if (sourceWords.length === 0) {
    return {
      displayTokens,
      timedWords: [],
      blocks,
      durationSeconds: 0,
      quality: {
        coverage: 0,
        interpolatedWordCount: 0,
      },
    };
  }

  if (normalizedSpokenWords.length === 0) {
    const timedWords = sourceWords.map<TimedWord>((word) => ({
      tokenIndex: word.tokenIndex,
      wordIndex: word.wordIndex,
      blockIndex: displayTokens[word.tokenIndex].blockIndex,
      chunkIndex,
      start: 0,
      end: 0,
      articleStart: 0,
      articleEnd: 0,
      normalized: word.normalized,
      interpolated: true,
    }));

    return {
      displayTokens,
      timedWords,
      blocks,
      durationSeconds: 0,
      quality: {
        coverage: 0,
        interpolatedWordCount: timedWords.length,
      },
    };
  }

  const anchors = buildAnchors(sourceWords, normalizedSpokenWords);
  const assignments = assignTimings(sourceWords, normalizedSpokenWords, anchors);
  const normalizedAssignments = normalizeAssignments(assignments);
  let directMatchCount = 0;
  let interpolatedWordCount = 0;

  const timedWords = sourceWords.map<TimedWord>((word, index) => {
    const assignment = normalizedAssignments[index];

    if (!assignment.interpolated) {
      directMatchCount += 1;
    } else {
      interpolatedWordCount += 1;
    }

    return {
      tokenIndex: word.tokenIndex,
      wordIndex: word.wordIndex,
      blockIndex: displayTokens[word.tokenIndex].blockIndex,
      chunkIndex,
      start: assignment.start,
      end: assignment.end,
      articleStart: assignment.start,
      articleEnd: assignment.end,
      normalized: assignment.normalized,
      interpolated: assignment.interpolated,
    };
  });

  return {
    displayTokens,
    timedWords,
    blocks,
    durationSeconds: Math.max(
      timedWords.at(-1)?.end ?? 0,
      normalizedSpokenWords.at(-1)?.end ?? 0,
    ),
    quality: {
      coverage: directMatchCount / sourceWords.length,
      interpolatedWordCount,
    },
  };
}

export function inflateSavedChunkTrack(savedChunk: SavedChunkTrack, chunkIndex: number): ChunkTrack {
  if (savedChunk.displayTokens && savedChunk.timedWords && savedChunk.blocks) {
    return {
      displayTokens: savedChunk.displayTokens,
      timedWords: savedChunk.timedWords.map((word) => ({
        ...word,
        chunkIndex,
      })),
      blocks: savedChunk.blocks,
      durationSeconds:
        savedChunk.durationSeconds ??
        savedChunk.timedWords.at(-1)?.end ??
        0,
      quality: savedChunk.quality ?? {
        coverage: 1,
        interpolatedWordCount: savedChunk.timedWords.filter((word) => word.interpolated).length,
      },
    };
  }

  const legacyTokens = savedChunk.tokens ?? [];
  const displayTokens = legacyTokens.map<DisplayToken>((token, index) => ({
    value: token.value,
    kind: /^\s+$/.test(token.value) ? "space" : token.isWord ? "word" : "punct",
    normalized: token.isWord ? normalizeWord(token.value) : "",
    wordIndex: token.isWord ? legacyTokens.slice(0, index).filter((item) => item.isWord).length : null,
    blockIndex: 0,
  }));
  const blocks = buildBlocks(displayTokens);

  for (const block of blocks) {
    for (let tokenIndex = block.tokenStart; tokenIndex <= block.tokenEnd; tokenIndex += 1) {
      displayTokens[tokenIndex] = {
        ...displayTokens[tokenIndex],
        blockIndex: block.index,
      };
    }
  }

  const timedWords = legacyTokens
    .map((token, tokenIndex) => ({ token, tokenIndex }))
    .filter(({ token }) => token.isWord && token.start !== null && token.end !== null)
    .map<TimedWord>(({ token, tokenIndex }, index) => ({
      tokenIndex,
      wordIndex: displayTokens[tokenIndex].wordIndex ?? index,
      blockIndex: displayTokens[tokenIndex].blockIndex,
      chunkIndex,
      start: token.start ?? 0,
      end: token.end ?? token.start ?? 0,
      articleStart: token.start ?? 0,
      articleEnd: token.end ?? token.start ?? 0,
      normalized: normalizeWord(token.value),
      interpolated: false,
    }));

  const normalizedTimedWords = normalizeTimedWords(timedWords);

  return {
    displayTokens,
    timedWords: normalizedTimedWords,
    blocks,
    durationSeconds:
      savedChunk.durationSeconds ??
      normalizedTimedWords.at(-1)?.end ??
      0,
    quality: {
      coverage: normalizedTimedWords.length === 0 ? 0 : 1,
      interpolatedWordCount: 0,
    },
  };
}

export function hydrateChunkTracks(chunks: ChunkTrack[]): HydratedReaderTrack {
  const displayTokens: HydratedDisplayToken[] = [];
  const timedWords: HydratedTimedWord[] = [];
  const blocks: HydratedReaderBlock[] = [];

  let tokenOffset = 0;
  let wordOffset = 0;
  let blockOffset = 0;
  let articleOffset = 0;

  for (const chunk of chunks) {
    for (let index = 0; index < chunk.displayTokens.length; index += 1) {
      const token = chunk.displayTokens[index];
      displayTokens.push({
        ...token,
        globalTokenIndex: tokenOffset + index,
        globalWordIndex: token.wordIndex === null ? null : wordOffset + token.wordIndex,
        globalBlockIndex: blockOffset + token.blockIndex,
      });
    }

    for (let index = 0; index < chunk.timedWords.length; index += 1) {
      const word = chunk.timedWords[index];
      timedWords.push({
        ...word,
        globalIndex: wordOffset + word.wordIndex,
        globalTokenIndex: tokenOffset + word.tokenIndex,
        globalBlockIndex: blockOffset + word.blockIndex,
        articleStart: articleOffset + word.start,
        articleEnd: articleOffset + word.end,
      });
    }

    for (const block of chunk.blocks) {
      blocks.push({
        ...block,
        index: blockOffset + block.index,
        globalIndex: blockOffset + block.index,
        tokenStart: tokenOffset + block.tokenStart,
        tokenEnd: tokenOffset + block.tokenEnd,
        wordStart: wordOffset + block.wordStart,
        wordEnd: wordOffset + block.wordEnd,
      });
    }

    tokenOffset += chunk.displayTokens.length;
    wordOffset += chunk.timedWords.length;
    blockOffset += chunk.blocks.length;
    articleOffset += chunk.durationSeconds;
  }

  return {
    displayTokens,
    timedWords,
    blocks,
    totalDuration: articleOffset,
  };
}

export function findActiveTimedWordIndex(timedWords: HydratedTimedWord[], articleTime: number) {
  if (timedWords.length === 0) {
    return -1;
  }

  if (articleTime <= timedWords[0].articleStart) {
    return 0;
  }

  let low = 0;
  let high = timedWords.length - 1;
  let result = -1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const word = timedWords[mid];

    if (articleTime < word.articleStart) {
      high = mid - 1;
      continue;
    }

    result = mid;
    low = mid + 1;
  }

  return result;
}

export function getEstimatedBlockHeight(block: ReaderBlock) {
  return estimateBlockHeight(block) || DEFAULT_BLOCK_HEIGHT;
}

function buildBlocks(displayTokens: DisplayToken[]): ReaderBlock[] {
  const blocks: ReaderBlock[] = [];

  if (displayTokens.length === 0) {
    return blocks;
  }

  let tokenStart = 0;
  let wordStart = findNextWordIndex(displayTokens, 0);
  let wordsInBlock = 0;
  let lastWordTokenIndex = -1;

  const pushBlock = (tokenEnd: number) => {
    if (tokenEnd < tokenStart) {
      tokenStart = tokenEnd + 1;
      return;
    }

    const blockTokens = displayTokens.slice(tokenStart, tokenEnd + 1);
    const blockWordStart = wordStart;
    const blockWordEnd = findLastWordIndex(blockTokens, blockWordStart);

    if (blockWordStart === null || blockWordEnd === null) {
      tokenStart = tokenEnd + 1;
      wordStart = findNextWordIndex(displayTokens, tokenStart);
      wordsInBlock = 0;
      lastWordTokenIndex = -1;
      return;
    }

    blocks.push({
      index: blocks.length,
      tokenStart,
      tokenEnd,
      wordStart: blockWordStart,
      wordEnd: blockWordEnd,
      text: blockTokens.map((token) => token.value).join(""),
    });

    tokenStart = tokenEnd + 1;
    wordStart = findNextWordIndex(displayTokens, tokenStart);
    wordsInBlock = 0;
    lastWordTokenIndex = -1;
  };

  for (let tokenIndex = 0; tokenIndex < displayTokens.length; tokenIndex += 1) {
    const token = displayTokens[tokenIndex];

    if (token.kind === "word") {
      wordsInBlock += 1;
      lastWordTokenIndex = tokenIndex;
    }

    const isLastToken = tokenIndex === displayTokens.length - 1;
    const hasHardBreak = token.kind === "space" && token.value.includes("\n\n");
    const hasSoftBreak =
      token.kind === "word" &&
      wordsInBlock >= BLOCK_TARGET_WORDS &&
      /[.!?;:]$/.test(token.value);
    const exceededMaxWords = wordsInBlock >= BLOCK_MAX_WORDS;

    if (hasHardBreak) {
      pushBlock(tokenIndex);
      continue;
    }

    if (hasSoftBreak || exceededMaxWords) {
      pushBlock(lastWordTokenIndex >= 0 ? lastWordTokenIndex : tokenIndex);
    } else if (isLastToken) {
      pushBlock(tokenIndex);
    }
  }

  if (blocks.length === 0) {
    return [
      {
        index: 0,
        tokenStart: 0,
        tokenEnd: displayTokens.length - 1,
        wordStart: 0,
        wordEnd: Math.max(0, displayTokens.filter((token) => token.wordIndex !== null).length - 1),
        text: displayTokens.map((token) => token.value).join(""),
      },
    ];
  }

  return blocks;
}

function extractSourceWords(displayTokens: DisplayToken[]): SourceWord[] {
  return displayTokens.flatMap((token, tokenIndex) => {
    if (token.wordIndex === null) {
      return [];
    }

    return [{
      tokenIndex,
      wordIndex: token.wordIndex,
      normalized: token.normalized,
    }];
  });
}

function buildAnchors(sourceWords: SourceWord[], spokenWords: NormalizedSpokenWord[]) {
  if (sourceWords.length === 0 || spokenWords.length === 0) {
    return [] as Anchor[];
  }

  const rows = sourceWords.length + 1;
  const cols = spokenWords.length + 1;
  const lengths = Array.from({ length: rows }, () => new Uint16Array(cols));

  for (let sourceIndex = sourceWords.length - 1; sourceIndex >= 0; sourceIndex -= 1) {
    for (let spokenIndex = spokenWords.length - 1; spokenIndex >= 0; spokenIndex -= 1) {
      if (sourceWords[sourceIndex].normalized === spokenWords[spokenIndex].normalized) {
        lengths[sourceIndex][spokenIndex] = lengths[sourceIndex + 1][spokenIndex + 1] + 1;
      } else {
        lengths[sourceIndex][spokenIndex] = Math.max(
          lengths[sourceIndex + 1][spokenIndex],
          lengths[sourceIndex][spokenIndex + 1],
        );
      }
    }
  }

  const anchors: Anchor[] = [];
  let sourceIndex = 0;
  let spokenIndex = 0;

  while (sourceIndex < sourceWords.length && spokenIndex < spokenWords.length) {
    if (sourceWords[sourceIndex].normalized === spokenWords[spokenIndex].normalized) {
      anchors.push({
        sourceWordIndex: sourceIndex,
        spokenWordIndex: spokenIndex,
      });
      sourceIndex += 1;
      spokenIndex += 1;
      continue;
    }

    if (lengths[sourceIndex + 1][spokenIndex] >= lengths[sourceIndex][spokenIndex + 1]) {
      sourceIndex += 1;
    } else {
      spokenIndex += 1;
    }
  }

  return anchors;
}

function assignTimings(
  sourceWords: SourceWord[],
  spokenWords: NormalizedSpokenWord[],
  anchors: Anchor[],
) {
  const assignments = Array.from<TimingAssignment | null>({ length: sourceWords.length }).fill(null);

  for (const anchor of anchors) {
    assignments[anchor.sourceWordIndex] = {
      start: spokenWords[anchor.spokenWordIndex].start,
      end: spokenWords[anchor.spokenWordIndex].end,
      interpolated: false,
      normalized: sourceWords[anchor.sourceWordIndex].normalized,
    };
  }

  let previousSourceIndex = -1;
  let previousSpokenIndex = -1;

  for (const anchor of [...anchors, { sourceWordIndex: sourceWords.length, spokenWordIndex: spokenWords.length }]) {
    const sourceGapStart = previousSourceIndex + 1;
    const sourceGapEnd = anchor.sourceWordIndex;
    const spokenGapStart = previousSpokenIndex + 1;
    const spokenGapEnd = anchor.spokenWordIndex;

    fillGapAssignments(
      sourceWords,
      spokenWords,
      assignments,
      sourceGapStart,
      sourceGapEnd,
      spokenGapStart,
      spokenGapEnd,
      previousSpokenIndex >= 0 ? spokenWords[previousSpokenIndex] : null,
      anchor.spokenWordIndex < spokenWords.length ? spokenWords[anchor.spokenWordIndex] : null,
    );

    previousSourceIndex = anchor.sourceWordIndex;
    previousSpokenIndex = anchor.spokenWordIndex;
  }

  return assignments.map((assignment, index) => assignment ?? {
    start: 0,
    end: 0,
    interpolated: true,
    normalized: sourceWords[index].normalized,
  });
}

function fillGapAssignments(
  sourceWords: SourceWord[],
  spokenWords: NormalizedSpokenWord[],
  assignments: Array<TimingAssignment | null>,
  sourceGapStart: number,
  sourceGapEnd: number,
  spokenGapStart: number,
  spokenGapEnd: number,
  previousSpokenWord: NormalizedSpokenWord | null,
  nextSpokenWord: NormalizedSpokenWord | null,
) {
  const sourceGapLength = sourceGapEnd - sourceGapStart;
  const spokenGapLength = spokenGapEnd - spokenGapStart;

  if (sourceGapLength <= 0) {
    return;
  }

  if (spokenGapLength > 0) {
    for (let offset = 0; offset < sourceGapLength; offset += 1) {
      const spokenOffset = Math.min(
        spokenGapLength - 1,
        Math.floor(((offset + 0.5) * spokenGapLength) / sourceGapLength),
      );
      const spokenWord = spokenWords[spokenGapStart + spokenOffset];

      assignments[sourceGapStart + offset] = {
        start: spokenWord.start,
        end: spokenWord.end,
        interpolated: true,
        normalized: sourceWords[sourceGapStart + offset].normalized,
      };
    }

    return;
  }

  const startTime = previousSpokenWord?.end ?? nextSpokenWord?.start ?? 0;
  const endTime = nextSpokenWord?.start ?? previousSpokenWord?.end ?? startTime;
  const duration = Math.max(0, endTime - startTime);
  const sliceDuration = sourceGapLength > 0 ? duration / sourceGapLength : 0;

  for (let offset = 0; offset < sourceGapLength; offset += 1) {
    assignments[sourceGapStart + offset] = {
      start: startTime + offset * sliceDuration,
      end: startTime + (offset + 1) * sliceDuration,
      interpolated: true,
      normalized: sourceWords[sourceGapStart + offset].normalized,
    };
  }
}

function normalizeAssignments(assignments: TimingAssignment[]) {
  const normalized = assignments.map((assignment) => ({ ...assignment }));

  for (let index = 0; index < normalized.length; index += 1) {
    const next = normalized[index + 1];

    if (!next) {
      normalized[index].end = Math.max(normalized[index].start, normalized[index].end);
      continue;
    }

    normalized[index].end = Math.max(
      normalized[index].start,
      Math.min(next.start, normalized[index].end || next.start),
    );

    if (normalized[index].end < normalized[index].start) {
      normalized[index].end = normalized[index].start;
    }
  }

  return normalized;
}

function normalizeTimedWords(timedWords: TimedWord[]) {
  return timedWords.map((word, index) => {
    const nextWord = timedWords[index + 1];
    const normalizedEnd = nextWord
      ? Math.max(word.start, Math.min(word.end, nextWord.start))
      : Math.max(word.start, word.end);

    return {
      ...word,
      end: normalizedEnd,
      articleEnd: normalizedEnd,
    };
  });
}

function findNextWordIndex(displayTokens: DisplayToken[], startIndex: number) {
  for (let tokenIndex = startIndex; tokenIndex < displayTokens.length; tokenIndex += 1) {
    if (displayTokens[tokenIndex].wordIndex !== null) {
      return displayTokens[tokenIndex].wordIndex;
    }
  }

  return null;
}

function findLastWordIndex(displayTokens: DisplayToken[], fallbackWordIndex: number | null) {
  for (let tokenIndex = displayTokens.length - 1; tokenIndex >= 0; tokenIndex -= 1) {
    if (displayTokens[tokenIndex].wordIndex !== null) {
      return displayTokens[tokenIndex].wordIndex;
    }
  }

  return fallbackWordIndex;
}
