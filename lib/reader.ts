export type SpokenWord = {
  word: string;
  start: number;
  end: number;
};

export type ReadingToken = {
  value: string;
  isWord: boolean;
  start: number | null;
  end: number | null;
};

const tokenPattern = /(\s+|[^\s]+)/g;

export function normalizeWord(value: string) {
  return value
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, "");
}

export function tokenizeText(text: string): ReadingToken[] {
  const parts = text.match(tokenPattern) ?? [];

  return parts.map((value) => ({
    value,
    isWord: !/^\s+$/.test(value),
    start: null,
    end: null,
  }));
}

const LOOKAHEAD = 4;

/**
 * Align Whisper word timestamps to the original text tokens using a
 * two-pointer approach with bounded lookahead. This keeps the alignment
 * roughly in sync even when Whisper drops, merges, or hallucinates words.
 *
 * After the main pass, any word tokens that didn't get direct timing are
 * filled in by interpolating from their nearest timed neighbours.
 */
export function alignWordsToText(text: string, words: SpokenWord[]): ReadingToken[] {
  const tokens = tokenizeText(text);

  // Extract only word tokens with their indices into the full token array
  const wordTokens: { index: number; normalized: string }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].isWord) {
      wordTokens.push({ index: i, normalized: normalizeWord(tokens[i].value) });
    }
  }

  if (wordTokens.length === 0 || words.length === 0) return tokens;

  let wp = 0; // whisper pointer
  let tp = 0; // text-token pointer

  while (wp < words.length && tp < wordTokens.length) {
    const whisper = normalizeWord(words[wp].word);

    if (!whisper) {
      wp++;
      continue;
    }

    const textNorm = wordTokens[tp].normalized;

    // Exact match — assign and advance both
    if (whisper === textNorm) {
      const idx = wordTokens[tp].index;
      tokens[idx] = { ...tokens[idx], start: words[wp].start, end: words[wp].end };
      wp++;
      tp++;
      continue;
    }

    // Look ahead in text tokens for a match to this whisper word
    let foundInText = -1;
    for (let i = 1; i <= LOOKAHEAD && tp + i < wordTokens.length; i++) {
      if (wordTokens[tp + i].normalized === whisper) {
        foundInText = i;
        break;
      }
    }

    // Look ahead in whisper words for a match to this text token
    let foundInWhisper = -1;
    for (let i = 1; i <= LOOKAHEAD && wp + i < words.length; i++) {
      if (normalizeWord(words[wp + i].word) === textNorm) {
        foundInWhisper = i;
        break;
      }
    }

    if (foundInText >= 0 && (foundInWhisper < 0 || foundInText <= foundInWhisper)) {
      // Whisper word matches a text token a few ahead — skip text tokens to it
      tp += foundInText;
      const idx = wordTokens[tp].index;
      tokens[idx] = { ...tokens[idx], start: words[wp].start, end: words[wp].end };
      wp++;
      tp++;
    } else if (foundInWhisper >= 0) {
      // Text token matches a whisper word a few ahead — skip whisper words to it
      wp += foundInWhisper;
      const idx = wordTokens[tp].index;
      tokens[idx] = { ...tokens[idx], start: words[wp].start, end: words[wp].end };
      wp++;
      tp++;
    } else {
      // No nearby match — assume positional correspondence
      const idx = wordTokens[tp].index;
      tokens[idx] = { ...tokens[idx], start: words[wp].start, end: words[wp].end };
      wp++;
      tp++;
    }
  }

  // Interpolate timing for any word tokens that didn't get assigned
  interpolateTimings(tokens);

  return tokens;
}

/**
 * Fill in missing timings by linearly interpolating between the nearest
 * timed neighbours. This ensures every word token has a start/end so
 * the highlight can smoothly track through the entire text.
 */
function interpolateTimings(tokens: ReadingToken[]) {
  // Collect indices of word tokens
  const wordIndices: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].isWord) wordIndices.push(i);
  }

  // Find runs of untimed word tokens and interpolate
  let i = 0;
  while (i < wordIndices.length) {
    const idx = wordIndices[i];
    if (tokens[idx].start !== null) {
      i++;
      continue;
    }

    // Find the extent of this untimed run
    let runEnd = i;
    while (runEnd < wordIndices.length && tokens[wordIndices[runEnd]].start === null) {
      runEnd++;
    }

    // Find the timed neighbour before and after
    const prevTimed = i > 0 ? tokens[wordIndices[i - 1]] : null;
    const nextTimed = runEnd < wordIndices.length ? tokens[wordIndices[runEnd]] : null;

    const startTime = prevTimed?.end ?? nextTimed?.start ?? 0;
    const endTime = nextTimed?.start ?? prevTimed?.end ?? 0;
    const count = runEnd - i;
    const duration = (endTime - startTime) / count;

    for (let j = 0; j < count; j++) {
      const wi = wordIndices[i + j];
      tokens[wi] = {
        ...tokens[wi],
        start: startTime + j * duration,
        end: startTime + (j + 1) * duration,
      };
    }

    i = runEnd;
  }
}

export function findActiveTokenIndex(tokens: ReadingToken[], currentTime: number) {
  let lastCompletedIndex = -1;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (!token.isWord || token.start === null || token.end === null) {
      continue;
    }

    if (currentTime >= token.start && currentTime <= token.end) {
      return index;
    }

    if (currentTime > token.end) {
      lastCompletedIndex = index;
      continue;
    }

    break;
  }

  return lastCompletedIndex;
}
