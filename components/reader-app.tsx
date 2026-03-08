"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { calculateReadingCost, estimateDurationFromCharCount } from "@/lib/costs";
import { FocusReader } from "@/components/focus-reader";
import { ChunkTrack, hydrateChunkTracks, inflateSavedChunkTrack } from "@/lib/reader";
import { DEFAULT_VOICE, TTS_VOICES, TtsVoice } from "@/lib/tts";
import { LibraryListItem, SavedChunk, deriveTitle } from "@/lib/library";
import {
  deleteEntry as deleteLibraryEntry,
  getEntry as getLibraryEntry,
  listEntries as listLibraryEntries,
  saveEntry as saveLibraryStoreEntry,
  updateEntryDuration,
  updateEntryProgress,
} from "@/lib/library-store";

const PLACEHOLDER = "Paste an article, meeting notes, or anything you want read aloud...";

type AudioChunk = {
  audioBlob: Blob;
  audioUrl: string;
  duration: number;
  track: ChunkTrack;
};

type ReaderResponseChunk = {
  audioBase64: string;
  blocks?: ChunkTrack["blocks"];
  chunkIndex: number;
  displayTokens?: ChunkTrack["displayTokens"];
  durationSeconds?: number;
  error?: string;
  mimeType: string;
  quality?: ChunkTrack["quality"];
  timedWords?: ChunkTrack["timedWords"];
  totalChunks: number;
};

function base64ToBlob(base64: string, mimeType: string) {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new Blob([bytes], { type: mimeType });
}

function probeDuration(url: string): Promise<number> {
  return new Promise((resolve) => {
    const audio = new Audio();
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      resolve(Number.isFinite(audio.duration) ? audio.duration : 0);
      audio.src = "";
    };
    audio.onerror = () => resolve(0);
    audio.src = url;
  });
}

function formatTime(seconds: number) {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = Math.floor(safeSeconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

function formatCost(item: LibraryListItem) {
  const duration = item.durationSeconds ?? estimateDurationFromCharCount(item.charCount);
  const cost = calculateReadingCost("x".repeat(item.charCount), duration);
  if (cost.totalCost < 0.005) return "<$0.01";
  return `$${cost.totalCost.toFixed(2)}`;
}

type ReaderAppProps = {
  initialEntryId?: string | null;
  passwordProtected?: boolean;
};

export function ReaderApp({ initialEntryId = null, passwordProtected = false }: ReaderAppProps) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [selectedVoice, setSelectedVoice] = useState<TtsVoice>(DEFAULT_VOICE);
  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRenderedText, setLastRenderedText] = useState("");
  const [lastRenderedVoice, setLastRenderedVoice] = useState<TtsVoice>(DEFAULT_VOICE);
  const [playbackRate, setPlaybackRate] = useState(1.25);

  const [chunks, setChunks] = useState<AudioChunk[]>([]);
  const [currentChunkIndex, setCurrentChunkIndex] = useState(0);
  const [totalChunks, setTotalChunks] = useState(0);
  const [chunkCurrentTime, setChunkCurrentTime] = useState(0);

  const [library, setLibrary] = useState<LibraryListItem[]>([]);
  const [isLibraryLoading, setIsLibraryLoading] = useState(true);
  const [isRestoringEntry, setIsRestoringEntry] = useState(Boolean(initialEntryId));
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null);
  const [isAutoSaving, setIsAutoSaving] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const progressRef = useRef<HTMLInputElement | null>(null);
  const chunksRef = useRef<AudioChunk[]>([]);
  const currentChunkIndexRef = useRef(0);
  const waitingForNextChunkRef = useRef(false);
  const playRequestIdRef = useRef(0);
  const lastSavedProgressRef = useRef(0);
  const initialEntryIdRef = useRef(initialEntryId);

  useEffect(() => {
    chunksRef.current = chunks;
  }, [chunks]);

  useEffect(() => {
    currentChunkIndexRef.current = currentChunkIndex;
  }, [currentChunkIndex]);

  const fetchLibrary = useCallback(async () => {
    setIsLibraryLoading(true);

    try {
      setLibrary(await listLibraryEntries());
    } catch {
      setError("Could not open browser storage.");
    } finally {
      setIsLibraryLoading(false);
    }
  }, []);

  const normalizedInputText = text.trim();
  const charCount = text.length;
  const audioIsStale =
    Boolean(lastRenderedText) &&
    (lastRenderedText !== normalizedInputText || lastRenderedVoice !== selectedVoice);
  const hasAudio = chunks.length > 0 && !audioIsStale;
  const hasText = normalizedInputText.length > 0;
  const costEstimate = useMemo(() => calculateReadingCost(text, null), [text]);

  const title = useMemo(() => {
    if (lastRenderedText) {
      return deriveTitle(lastRenderedText);
    }

    if (hasText) {
      return deriveTitle(text);
    }

    return "";
  }, [hasText, lastRenderedText, text]);

  const chunkDurations = useMemo(() => chunks.map((chunk) => chunk.duration), [chunks]);
  const totalDuration = useMemo(() => chunkDurations.reduce((sum, duration) => sum + duration, 0), [chunkDurations]);
  const chunkStartTimes = useMemo(() => {
    const starts: number[] = [];
    let total = 0;

    for (const duration of chunkDurations) {
      starts.push(total);
      total += duration;
    }

    return starts;
  }, [chunkDurations]);

  const overallTime = useMemo(() => {
    if (chunks.length === 0) {
      return 0;
    }

    return (chunkStartTimes[currentChunkIndex] ?? 0) + chunkCurrentTime;
  }, [chunkCurrentTime, chunkStartTimes, chunks.length, currentChunkIndex]);

  const hydratedTrack = useMemo(() => {
    if (chunks.length === 0) {
      return null;
    }

    return hydrateChunkTracks(
      chunks.map((chunk) => ({
        ...chunk.track,
        durationSeconds: chunk.duration || chunk.track.durationSeconds,
      })),
    );
  }, [chunks]);

  useEffect(() => {
    if (!activeEntryId || overallTime === 0) {
      return;
    }

    if (Math.abs(overallTime - lastSavedProgressRef.current) < 5) {
      return;
    }

    lastSavedProgressRef.current = overallTime;
    void updateEntryProgress(activeEntryId, overallTime).catch(() => {});
  }, [activeEntryId, overallTime]);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate]);

  useEffect(() => {
    if (!activeEntryId && initialEntryIdRef.current) {
      return;
    }

    const url = new URL(window.location.href);

    if (activeEntryId) {
      url.searchParams.set("entry", activeEntryId);
    } else {
      url.searchParams.delete("entry");
    }

    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;

    if (nextUrl !== currentUrl) {
      window.history.replaceState(null, "", nextUrl);
    }
  }, [activeEntryId]);

  function invalidatePlayRequests() {
    playRequestIdRef.current += 1;
  }

  async function safePlayAudio() {
    const audio = audioRef.current;

    if (!audio) {
      return;
    }

    const requestId = playRequestIdRef.current + 1;
    playRequestIdRef.current = requestId;

    try {
      await audio.play();
    } catch (caughtError) {
      if (playRequestIdRef.current !== requestId) {
        return;
      }

      if (caughtError instanceof DOMException && caughtError.name === "AbortError") {
        return;
      }

      setIsPlaying(false);
      setError("Could not start playback.");
    }
  }

  const playChunk = useCallback((index: number) => {
    const chunk = chunksRef.current[index];
    const audio = audioRef.current;

    if (!chunk || !audio) {
      return;
    }

    audio.src = chunk.audioUrl;
    audio.playbackRate = playbackRate;
    audio.currentTime = 0;
    void safePlayAudio();
  }, [playbackRate]);

  useEffect(() => {
    if (waitingForNextChunkRef.current && chunks[currentChunkIndexRef.current]) {
      waitingForNextChunkRef.current = false;
      playChunk(currentChunkIndexRef.current);
    }
  }, [chunks, playChunk]);

  useEffect(() => {
    return () => {
      invalidatePlayRequests();
      chunksRef.current.forEach((chunk) => URL.revokeObjectURL(chunk.audioUrl));
    };
  }, []);

  function handleLoadedMetadata() {
    const audio = audioRef.current;

    if (!audio || !Number.isFinite(audio.duration)) {
      return;
    }

    const chunkIndex = currentChunkIndexRef.current;

    setChunks((previousChunks) => {
      if (!previousChunks[chunkIndex]) {
        return previousChunks;
      }

      if (previousChunks[chunkIndex].duration === audio.duration) {
        return previousChunks;
      }

      const nextChunks = [...previousChunks];
      nextChunks[chunkIndex] = {
        ...nextChunks[chunkIndex],
        duration: audio.duration,
      };
      chunksRef.current = nextChunks;
      return nextChunks;
    });
  }

  function handleTimeUpdate() {
    const audio = audioRef.current;

    if (!audio) {
      return;
    }

    setChunkCurrentTime(audio.currentTime);
  }

  function handleChunkEnded() {
    invalidatePlayRequests();
    const nextChunkIndex = currentChunkIndexRef.current + 1;

    setCurrentChunkIndex(nextChunkIndex);
    currentChunkIndexRef.current = nextChunkIndex;
    setChunkCurrentTime(0);

    if (chunksRef.current[nextChunkIndex]) {
      playChunk(nextChunkIndex);
      return;
    }

    if (nextChunkIndex < (totalChunks || Number.POSITIVE_INFINITY)) {
      waitingForNextChunkRef.current = true;
      return;
    }

    setIsPlaying(false);
    setCurrentChunkIndex(0);
    currentChunkIndexRef.current = 0;
    setChunkCurrentTime(0);
  }

  function handleSeek(event: React.ChangeEvent<HTMLInputElement>) {
    const nextOverallTime = Number(event.target.value);

    if (chunks.length === 0) {
      return;
    }

    let nextChunkIndex = 0;
    let chunkTime = nextOverallTime;

    for (let index = 0; index < chunks.length; index += 1) {
      if (chunkTime < chunks[index].duration || index === chunks.length - 1) {
        nextChunkIndex = index;
        break;
      }

      chunkTime -= chunks[index].duration;
    }

    if (nextChunkIndex !== currentChunkIndex) {
      setCurrentChunkIndex(nextChunkIndex);
      currentChunkIndexRef.current = nextChunkIndex;
    }

    const audio = audioRef.current;
    const chunk = chunks[nextChunkIndex];

    if (audio && chunk) {
      if (audio.src !== chunk.audioUrl) {
        audio.src = chunk.audioUrl;
      }

      audio.playbackRate = playbackRate;
      audio.currentTime = Math.max(0, Math.min(chunkTime, Math.max(0, chunk.duration - 0.01)));

      if (isPlaying) {
        void safePlayAudio();
      }
    }

    setChunkCurrentTime(chunkTime);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedText = normalizedInputText;

    if (!trimmedText) {
      setError("Paste something first.");
      return;
    }

    chunksRef.current.forEach((chunk) => URL.revokeObjectURL(chunk.audioUrl));

    setError(null);
    setIsLoading(true);
    setIsStreaming(false);
    setCurrentChunkIndex(0);
    currentChunkIndexRef.current = 0;
    setChunks([]);
    chunksRef.current = [];
    setTotalChunks(0);
    setActiveEntryId(null);
    setChunkCurrentTime(0);
    waitingForNextChunkRef.current = false;
    invalidatePlayRequests();

    try {
      const response = await fetch("/api/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: trimmedText, voice: selectedVoice, mode: "read" }),
      });

      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => ({}));
        throw new Error((payload as { error?: string }).error ?? "Could not generate audio.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let firstChunkPlayed = false;
      const savedChunks: SavedChunk[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }

          const data = JSON.parse(line) as ReaderResponseChunk;

          if (data.error) {
            throw new Error(data.error);
          }

          const blob = base64ToBlob(data.audioBase64, data.mimeType);
          const audioUrl = URL.createObjectURL(blob);
          const track: ChunkTrack = {
            displayTokens: data.displayTokens ?? [],
            timedWords: data.timedWords ?? [],
            blocks: data.blocks ?? [],
            durationSeconds: data.durationSeconds ?? 0,
            quality: data.quality ?? {
              coverage: 0,
              interpolatedWordCount: 0,
            },
          };

          const duration =
            track.durationSeconds > 0 ? track.durationSeconds : await probeDuration(audioUrl);
          const newChunk: AudioChunk = {
            audioBlob: blob,
            audioUrl,
            duration,
            track,
          };

          savedChunks.push({
            audioBlob: blob,
            displayTokens: track.displayTokens,
            timedWords: track.timedWords,
            blocks: track.blocks,
            durationSeconds: duration,
            quality: track.quality,
          });

          setTotalChunks(data.totalChunks);
          setChunks((previousChunks) => {
            const nextChunks = [...previousChunks, newChunk];
            chunksRef.current = nextChunks;
            return nextChunks;
          });

          if (!firstChunkPlayed) {
            firstChunkPlayed = true;
            setIsLoading(false);
            setIsStreaming(data.totalChunks > 1);
            setLastRenderedText(trimmedText);
            setLastRenderedVoice(selectedVoice);
            playChunk(0);
          }
        }
      }

      setIsStreaming(false);

      if (savedChunks.length > 0) {
        setIsAutoSaving(true);
        const savedEntryId = await saveLibraryEntry(
          trimmedText,
          selectedVoice,
          savedChunks,
          chunksRef.current.reduce((sum, chunk) => sum + chunk.duration, 0),
        );

        if (savedEntryId) {
          setActiveEntryId(savedEntryId);
          await fetchLibrary();
        }

        setIsAutoSaving(false);
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not generate audio.");
    } finally {
      setIsAutoSaving(false);
      setIsLoading(false);
      setIsStreaming(false);
    }
  }

  function togglePlayback() {
    const audio = audioRef.current;

    if (!audio) {
      return;
    }

    if (audio.paused) {
      if (!audio.src && chunks[0]) {
        playChunk(currentChunkIndex);
      } else if (audio.ended) {
        audio.currentTime = 0;
        void safePlayAudio();
      } else {
        void safePlayAudio();
      }

      return;
    }

    invalidatePlayRequests();
    audio.pause();
  }

  function handleNew() {
    invalidatePlayRequests();
    audioRef.current?.pause();
    audioRef.current?.removeAttribute("src");
    audioRef.current?.load();

    chunksRef.current.forEach((chunk) => URL.revokeObjectURL(chunk.audioUrl));
    chunksRef.current = [];
    waitingForNextChunkRef.current = false;

    setText("");
    setSelectedVoice(DEFAULT_VOICE);
    setError(null);
    setIsLoading(false);
    setIsStreaming(false);
    setIsPlaying(false);
    setLastRenderedText("");
    setLastRenderedVoice(DEFAULT_VOICE);
    setChunks([]);
    setCurrentChunkIndex(0);
    currentChunkIndexRef.current = 0;
    setTotalChunks(0);
    setActiveEntryId(null);
    setChunkCurrentTime(0);
  }

  async function saveLibraryEntry(
    textToSave: string,
    voiceToSave: TtsVoice,
    savedChunks: SavedChunk[],
    durationSeconds?: number,
  ) {
    try {
      const entry = await saveLibraryStoreEntry({
        text: textToSave,
        voice: voiceToSave,
        chunks: savedChunks,
        durationSeconds,
      });

      return entry.id;
    } catch {
      setError("Could not save to library.");
      return null;
    }
  }

  const handleLoadEntry = useCallback(async (id: string) => {
    invalidatePlayRequests();
    audioRef.current?.pause();
    chunksRef.current.forEach((chunk) => URL.revokeObjectURL(chunk.audioUrl));

    try {
      const entry = await getLibraryEntry(id);
      if (!entry) {
        throw new Error("Not found");
      }

      const loadedChunks: AudioChunk[] = await Promise.all(
        entry.chunks.map(async (savedChunk, chunkIndex) => {
          const audioUrl = URL.createObjectURL(savedChunk.audioBlob);
          const track = inflateSavedChunkTrack(savedChunk, chunkIndex);
          const duration =
            savedChunk.durationSeconds ??
            (track.durationSeconds || await probeDuration(audioUrl));

          return {
            audioBlob: savedChunk.audioBlob,
            audioUrl,
            duration,
            track: {
              ...track,
              durationSeconds: duration,
            },
          };
        }),
      );

      const savedProgress = entry.progressSeconds ?? 0;
      let targetChunkIndex = 0;
      let timeInChunk = savedProgress;

      for (let index = 0; index < loadedChunks.length; index += 1) {
        if (timeInChunk < loadedChunks[index].duration || index === loadedChunks.length - 1) {
          targetChunkIndex = index;
          break;
        }

        timeInChunk -= loadedChunks[index].duration;
      }

      setText(entry.text);
      setSelectedVoice(entry.voice);
      setLastRenderedText(entry.text);
      setLastRenderedVoice(entry.voice);
      setChunks(loadedChunks);
      chunksRef.current = loadedChunks;
      setCurrentChunkIndex(targetChunkIndex);
      currentChunkIndexRef.current = targetChunkIndex;
      setTotalChunks(loadedChunks.length);
      setActiveEntryId(id);
      setError(null);
      setIsPlaying(false);
      setChunkCurrentTime(timeInChunk);
      setSidebarOpen(false);
      lastSavedProgressRef.current = savedProgress;

      if (!entry.durationSeconds) {
        const actualDuration = loadedChunks.reduce((sum, chunk) => sum + chunk.duration, 0);

        if (actualDuration > 0) {
          void updateEntryDuration(id, actualDuration)
            .then(() => fetchLibrary())
            .catch(() => {});
        }
      }

      if (audioRef.current && loadedChunks[targetChunkIndex]) {
        audioRef.current.src = loadedChunks[targetChunkIndex].audioUrl;
        audioRef.current.playbackRate = playbackRate;
        audioRef.current.currentTime = Math.max(0, timeInChunk);
      }
    } catch {
      setError("Could not load article.");
    }
  }, [fetchLibrary, playbackRate]);

  useEffect(() => {
    const entryId = initialEntryId ?? (window.location.hash.slice(1) || null);
    initialEntryIdRef.current = entryId;
    setIsRestoringEntry(Boolean(entryId));

    void Promise.all([
      fetchLibrary(),
      entryId ? handleLoadEntry(entryId).catch(() => {}) : Promise.resolve(),
    ]).finally(() => {
      initialEntryIdRef.current = null;
      setIsRestoringEntry(false);
    });
  }, [fetchLibrary, handleLoadEntry, initialEntryId]);

  async function handleDeleteEntry(id: string) {
    try {
      await deleteLibraryEntry(id);

      if (activeEntryId === id) {
        setActiveEntryId(null);
      }

      await fetchLibrary();
    } catch {
      setError("Could not delete article.");
    }
  }

  async function handleSignOut() {
    setError(null);
    setIsSigningOut(true);

    try {
      const response = await fetch("/api/auth", { method: "DELETE" });
      if (!response.ok) {
        throw new Error("Could not sign out.");
      }

      router.refresh();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not sign out.");
    } finally {
      setIsSigningOut(false);
    }
  }

  const showPlayer = hasAudio || isLoading || isRestoringEntry;
  const focusPlaceholderText = isLoading
    ? "Generating audio and timing track..."
    : "Restoring saved article...";

  return (
    <div className="flex h-screen overflow-hidden">
      <aside
        className={`fixed inset-y-0 left-0 z-30 flex w-72 flex-col border-r border-border bg-[#f5f0e8] transition-transform duration-200 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        } lg:relative lg:translate-x-0`}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-4">
          <h2 className="text-sm font-medium">Library</h2>
          <button
            onClick={() => setSidebarOpen(false)}
            className="text-muted hover:text-foreground lg:hidden"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 4l10 10M14 4L4 14" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {isLibraryLoading ? (
            <p className="px-4 py-8 text-center text-xs text-muted">
              Loading library...
            </p>
          ) : library.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs text-muted">
              No saved articles yet
            </p>
          ) : (
            <ul className="py-2">
              {library.map((item) => (
                <li
                  key={item.id}
                  className={`group flex items-start gap-2 px-4 py-3 transition ${
                    activeEntryId === item.id ? "bg-white/70" : "hover:bg-white/40"
                  }`}
                >
                  <button
                    onClick={() => handleLoadEntry(item.id)}
                    className="flex-1 text-left"
                  >
                    <p className="text-sm font-medium leading-snug text-foreground line-clamp-2">
                      {item.title}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      {item.voice} &middot;{" "}
                      {new Date(item.createdAt).toLocaleDateString()} &middot;{" "}
                      {formatTime(item.durationSeconds ?? estimateDurationFromCharCount(item.charCount))} &middot;{" "}
                      {formatCost(item)}
                    </p>
                  </button>
                  <button
                    onClick={() => handleDeleteEntry(item.id)}
                    className="mt-0.5 shrink-0 text-muted opacity-0 transition hover:text-red-500 group-hover:opacity-100"
                    title="Delete"
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                      <path d="M3 3l8 8M11 3l-8 8" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/20 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <main className="flex w-full min-h-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-border px-5 py-3 sm:px-8">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition hover:text-foreground lg:hidden"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M2 4.5h14M2 9h14M2 13.5h14" />
            </svg>
          </button>

          <h1 className="font-serif text-xl tracking-tight">Reader</h1>

          <div className="ml-auto flex items-center gap-2">
            {hasAudio && (
              <button
                type="button"
                onClick={handleNew}
                className="flex h-8 items-center rounded-lg border border-border bg-white px-3 text-xs font-medium text-foreground transition hover:bg-foreground/5"
              >
                New
              </button>
            )}
            {passwordProtected && (
              <button
                className="flex h-8 items-center rounded-lg border border-border bg-white px-3 text-xs font-medium text-foreground transition hover:bg-foreground/5 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={isSigningOut}
                onClick={handleSignOut}
                type="button"
              >
                {isSigningOut ? "..." : "Lock"}
              </button>
            )}
          </div>
        </header>

        <audio
          ref={audioRef}
          className="hidden"
          onPlay={() => setIsPlaying(true)}
          onPause={() => {
            setIsPlaying(false);

            if (activeEntryId) {
              const currentTime = (chunkStartTimes[currentChunkIndexRef.current] ?? 0) + (audioRef.current?.currentTime ?? 0);
              lastSavedProgressRef.current = currentTime;
              void updateEntryProgress(activeEntryId, currentTime).catch(() => {});
            }
          }}
          onEnded={handleChunkEnded}
          onLoadedMetadata={handleLoadedMetadata}
          onTimeUpdate={handleTimeUpdate}
        />

        {showPlayer ? (
          <div className="flex min-h-0 flex-1 flex-col" style={{ paddingBottom: "5.5rem" }}>
            <FocusReader
              audioRef={audioRef}
              chunkStartTimes={chunkStartTimes}
              currentChunkIndexRef={currentChunkIndexRef}
              isPlaying={isPlaying}
              key={activeEntryId ?? lastRenderedText ?? text ?? "focus-reader"}
              placeholderText={focusPlaceholderText}
              title={title}
              track={hydratedTrack}
            />

            <div className="fixed bottom-0 left-0 right-0 z-10 border-t border-border bg-[#faf6f0]/95 backdrop-blur-sm lg:left-72">
              <div className="relative h-1 w-full bg-border">
                <div
                  className="absolute inset-y-0 left-0 bg-foreground/70 transition-[width] duration-150"
                  style={{
                    width: totalDuration > 0 ? `${(overallTime / totalDuration) * 100}%` : "0%",
                  }}
                />
                <input
                  ref={progressRef}
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  disabled={!hasAudio || totalDuration === 0}
                  max={totalDuration || 1}
                  min={0}
                  onChange={handleSeek}
                  step={0.1}
                  type="range"
                  value={overallTime}
                />
              </div>

              <div className="flex items-center gap-4 px-5 py-3 sm:px-8">
                <span className="w-24 text-xs tabular-nums text-muted">
                  {formatTime(overallTime / playbackRate)} / {formatTime(totalDuration / playbackRate)}
                </span>

                <div className="flex flex-1 items-center justify-center gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      if (!audioRef.current) {
                        return;
                      }

                      const nextTime = Math.max(0, audioRef.current.currentTime - 15);
                      audioRef.current.currentTime = nextTime;
                      setChunkCurrentTime(nextTime);
                    }}
                    disabled={!hasAudio}
                    className="flex h-9 w-9 items-center justify-center rounded-full text-muted transition hover:text-foreground disabled:opacity-30"
                    title="Rewind 15s"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 4v6h6" />
                      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                    </svg>
                  </button>

                  {isLoading ? (
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-foreground text-white">
                      <svg className="animate-spin" width="20" height="20" viewBox="0 0 24 24" fill="none">
                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
                      </svg>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={togglePlayback}
                      disabled={!hasAudio}
                      className="flex h-12 w-12 items-center justify-center rounded-full bg-foreground text-white transition hover:bg-foreground/85 disabled:opacity-40"
                    >
                      {isPlaying ? (
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                          <rect x="4" y="3" width="4.5" height="14" rx="1" />
                          <rect x="11.5" y="3" width="4.5" height="14" rx="1" />
                        </svg>
                      ) : (
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                          <path d="M5 3.5v13l11-6.5z" />
                        </svg>
                      )}
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => {
                      if (!audioRef.current || !chunks[currentChunkIndex]) {
                        return;
                      }

                      const nextTime = Math.min(
                        chunks[currentChunkIndex].duration,
                        audioRef.current.currentTime + 15,
                      );
                      audioRef.current.currentTime = nextTime;
                      setChunkCurrentTime(nextTime);
                    }}
                    disabled={!hasAudio}
                    className="flex h-9 w-9 items-center justify-center rounded-full text-muted transition hover:text-foreground disabled:opacity-30"
                    title="Forward 15s"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M23 4v6h-6" />
                      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                    </svg>
                  </button>
                </div>

                <div className="flex w-24 items-center justify-end gap-2">
                  {isStreaming && (
                    <span className="text-xs text-accent">
                      {chunks.length}/{totalChunks}
                    </span>
                  )}
                  {isAutoSaving && (
                    <span className="text-xs text-muted">Saving...</span>
                  )}
                  {!isAutoSaving && activeEntryId && !isStreaming && (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="#16a34a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2 7.5l3 3 7-7" />
                    </svg>
                  )}
                  <select
                    value={playbackRate}
                    onChange={(event) => setPlaybackRate(Number(event.target.value))}
                    className="h-7 rounded border border-border bg-transparent px-1 text-xs text-foreground outline-none"
                  >
                    {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((rate) => (
                      <option key={rate} value={rate}>
                        {rate}x
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center px-5 py-12 sm:py-20">
            <div className="mb-8 text-center">
              <h2 className="font-serif text-3xl tracking-tight sm:text-4xl">
                What would you like to listen to?
              </h2>
              <p className="mt-2 text-sm text-muted">
                Paste text, pick a voice, and press Generate.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={PLACEHOLDER}
                className="min-h-[180px] w-full resize-y rounded-xl border border-border bg-white px-5 py-4 font-serif text-[1.05rem] leading-7 text-foreground outline-none transition placeholder:font-sans focus:border-accent focus:ring-2 focus:ring-accent/20"
              />

              <div className="flex flex-wrap items-center gap-3">
                <select
                  value={selectedVoice}
                  onChange={(event) => setSelectedVoice(event.target.value as TtsVoice)}
                  className="h-10 rounded-lg border border-border bg-white px-3 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
                >
                  {TTS_VOICES.map((voice) => (
                    <option key={voice.id} value={voice.id}>
                      {voice.name} — {voice.tone}
                    </option>
                  ))}
                </select>

                <button
                  type="submit"
                  disabled={isLoading || !hasText}
                  className="flex h-10 items-center gap-2 rounded-lg bg-foreground px-5 text-sm font-medium text-white transition hover:bg-foreground/85 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {isLoading && (
                    <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
                    </svg>
                  )}
                  {isLoading ? "Generating..." : "Generate"}
                </button>

                <span className="ml-auto text-xs text-muted">
                  {charCount.toLocaleString()} chars
                  {hasText && (
                    <> · ~{formatTime(costEstimate.durationSeconds)}</>
                  )}
                </span>
              </div>

              {error && (
                <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
                  {error}
                </p>
              )}
            </form>

            {!hasText && (
              <div className="mt-12 flex flex-col items-center text-center text-muted">
                <svg width="48" height="48" viewBox="0 0 48 48" fill="none" className="mb-4 opacity-20">
                  <circle cx="24" cy="24" r="20" stroke="currentColor" strokeWidth="2" />
                  <path d="M20 16v16l12-8z" fill="currentColor" opacity="0.3" />
                </svg>
                <p className="text-sm">Your personal text-to-speech player</p>
              </div>
            )}
          </div>
        )}

        {showPlayer && error && (
          <div className="fixed left-1/2 top-16 z-20 -translate-x-1/2">
            <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700 shadow-lg">
              {error}
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
