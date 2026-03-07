import { ReadingToken } from "./reader";
import { TtsVoice } from "./tts";

export type SavedChunk = {
  audioBlob: Blob;
  tokens: ReadingToken[];
};

export type LibraryEntry = {
  id: string;
  title: string;
  text: string;
  voice: TtsVoice;
  createdAt: string;
  chunks: SavedChunk[];
};

export type LibraryListItem = {
  id: string;
  title: string;
  voice: TtsVoice;
  createdAt: string;
  charCount: number;
};

export function deriveTitle(text: string): string {
  const firstLine = text.split(/\n/)[0].trim();
  if (firstLine.length <= 80) return firstLine;
  return firstLine.slice(0, 77) + "...";
}
