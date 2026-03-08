import { ChunkTrackQuality, DisplayToken, LegacyReadingToken, ReaderBlock, TimedWord } from "./reader";
import { TtsVoice } from "./tts";

export type SavedChunk = {
  audioBlob: Blob;
  displayTokens?: DisplayToken[];
  timedWords?: TimedWord[];
  blocks?: ReaderBlock[];
  durationSeconds?: number;
  quality?: ChunkTrackQuality;
  tokens?: LegacyReadingToken[];
};

export type LibraryEntry = {
  id: string;
  title: string;
  text: string;
  voice: TtsVoice;
  createdAt: string;
  chunks: SavedChunk[];
  durationSeconds?: number;
  progressSeconds?: number;
};

export type LibraryListItem = {
  id: string;
  title: string;
  voice: TtsVoice;
  createdAt: string;
  charCount: number;
  durationSeconds?: number;
};

export function deriveTitle(text: string): string {
  const firstLine = text.split(/\n/)[0].trim();
  if (firstLine.length <= 80) return firstLine;
  return firstLine.slice(0, 77) + "...";
}
