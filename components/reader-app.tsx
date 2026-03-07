"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { calculateReadingCost } from "@/lib/costs";
import { ReadingToken } from "@/lib/reader";
import { DEFAULT_VOICE, TTS_VOICES, TtsVoice } from "@/lib/tts";
import { LibraryListItem, SavedChunk, deriveTitle } from "@/lib/library";
import {
  deleteEntry as deleteLibraryEntry,
  getEntry as getLibraryEntry,
  listEntries as listLibraryEntries,
  saveEntry as saveLibraryStoreEntry,
} from "@/lib/library-store";

const PLACEHOLDER = "Paste an article, meeting notes, or anything you want read aloud...";

type AudioChunk = {
  audioUrl: string;
  audioBlob: Blob;
  tokens: ReadingToken[];
  duration: number;
};

function base64ToBlob(base64: string, mimeType: string) {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: mimeType });
}

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

type ReaderAppProps = {
  passwordProtected?: boolean;
};

export function ReaderApp({ passwordProtected = false }: ReaderAppProps) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [selectedVoice, setSelectedVoice] = useState<TtsVoice>(DEFAULT_VOICE);
  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRenderedText, setLastRenderedText] = useState("");
  const [lastRenderedVoice, setLastRenderedVoice] = useState<TtsVoice>(DEFAULT_VOICE);
  const [showCost, setShowCost] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1.25);

  // Chunk-based audio state
  const [chunks, setChunks] = useState<AudioChunk[]>([]);
  const [currentChunkIndex, setCurrentChunkIndex] = useState(0);
  const [totalChunks, setTotalChunks] = useState(0);

  // Progress tracking
  const [currentTime, setCurrentTime] = useState(0);
  const [chunkCurrentTime, setChunkCurrentTime] = useState(0);

  // Library state
  const [library, setLibrary] = useState<LibraryListItem[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isAutoSaving, setIsAutoSaving] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const chunksRef = useRef<AudioChunk[]>([]);
  const currentChunkIndexRef = useRef(0);
  const waitingForNextChunk = useRef(false);
  const playRequestIdRef = useRef(0);
  const progressRef = useRef<HTMLInputElement | null>(null);

  // Keep refs in sync
  useEffect(() => { chunksRef.current = chunks; }, [chunks]);
  useEffect(() => { currentChunkIndexRef.current = currentChunkIndex; }, [currentChunkIndex]);

  // Load library on mount
  useEffect(() => {
    void fetchLibrary();
  }, []);

  async function fetchLibrary() {
    try {
      setLibrary(await listLibraryEntries());
    } catch {
      setError("Could not open browser storage.");
    }
  }

  // Compute durations
  const chunkDurations = useMemo(() => chunks.map((c) => c.duration), [chunks]);
  const totalDuration = useMemo(() => chunkDurations.reduce((a, b) => a + b, 0), [chunkDurations]);
  const chunkStartTimes = useMemo(() => {
    const starts: number[] = [];
    let acc = 0;
    for (const d of chunkDurations) {
      starts.push(acc);
      acc += d;
    }
    return starts;
  }, [chunkDurations]);

  // Overall progress
  const overallTime = useMemo(() => {
    if (chunks.length === 0) return 0;
    return (chunkStartTimes[currentChunkIndex] ?? 0) + chunkCurrentTime;
  }, [chunks, currentChunkIndex, chunkCurrentTime, chunkStartTimes]);

  // Build flat token array from all received chunks
  const allTokens = useMemo(() => chunks.flatMap((c) => c.tokens), [chunks]);

  const normalizedInputText = text.trim();
  const charCount = text.length;
  const audioIsStale =
    Boolean(lastRenderedText) &&
    (lastRenderedText !== normalizedInputText || lastRenderedVoice !== selectedVoice);
  const hasAudio = chunks.length > 0 && !audioIsStale;
  const hasText = normalizedInputText.length > 0;
  const costEstimate = useMemo(() => calculateReadingCost(text, null), [text]);
  const canSave = hasAudio && !isStreaming && !isAutoSaving && !activeEntryId;

  const title = useMemo(() => {
    if (lastRenderedText) return deriveTitle(lastRenderedText);
    if (hasText) return deriveTitle(text);
    return "";
  }, [lastRenderedText, hasText, text]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = playbackRate;
  }, [playbackRate]);

  function invalidatePlayRequests() {
    playRequestIdRef.current += 1;
  }

  async function safePlayAudio() {
    const audio = audioRef.current;
    if (!audio) return;

    const requestId = playRequestIdRef.current + 1;
    playRequestIdRef.current = requestId;

    try {
      await audio.play();
    } catch (error) {
      if (playRequestIdRef.current !== requestId) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      setIsPlaying(false);
      setError("Could not start playback.");
    }
  }

  const playChunk = useCallback((index: number) => {
    const chunk = chunksRef.current[index];
    if (!chunk || !audioRef.current) return;
    audioRef.current.src = chunk.audioUrl;
    audioRef.current.playbackRate = playbackRate;
    audioRef.current.currentTime = 0;
    void safePlayAudio();
  }, [playbackRate]);

  useEffect(() => {
    if (waitingForNextChunk.current && chunks[currentChunkIndexRef.current]) {
      waitingForNextChunk.current = false;
      playChunk(currentChunkIndexRef.current);
    }
  }, [chunks, playChunk]);

  useEffect(() => {
    return () => {
      invalidatePlayRequests();
      chunksRef.current.forEach((c) => URL.revokeObjectURL(c.audioUrl));
    };
  }, []);

  // Update chunk durations when audio metadata loads
  function handleLoadedMetadata() {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.duration)) return;
    const idx = currentChunkIndexRef.current;
    setChunks((prev) => {
      if (prev[idx] && prev[idx].duration === 0) {
        const updated = [...prev];
        updated[idx] = { ...updated[idx], duration: audio.duration };
        chunksRef.current = updated;
        return updated;
      }
      return prev;
    });
  }

  function handleTimeUpdate() {
    const audio = audioRef.current;
    if (!audio) return;
    setChunkCurrentTime(audio.currentTime);
  }

  function handleChunkEnded() {
    invalidatePlayRequests();
    const nextIndex = currentChunkIndexRef.current + 1;
    setCurrentChunkIndex(nextIndex);
    currentChunkIndexRef.current = nextIndex;
    setChunkCurrentTime(0);

    if (chunksRef.current[nextIndex]) {
      playChunk(nextIndex);
    } else if (nextIndex < (totalChunks || Infinity)) {
      waitingForNextChunk.current = true;
    } else {
      setIsPlaying(false);
      setCurrentChunkIndex(0);
      currentChunkIndexRef.current = 0;
      setChunkCurrentTime(0);
    }
  }

  function handleSeek(e: React.ChangeEvent<HTMLInputElement>) {
    const seekTo = Number(e.target.value);
    if (!chunks.length) return;

    // Find which chunk this time falls in
    let targetChunk = 0;
    let timeInChunk = seekTo;
    for (let i = 0; i < chunks.length; i++) {
      if (timeInChunk < chunks[i].duration || i === chunks.length - 1) {
        targetChunk = i;
        break;
      }
      timeInChunk -= chunks[i].duration;
    }

    if (targetChunk !== currentChunkIndex) {
      setCurrentChunkIndex(targetChunk);
      currentChunkIndexRef.current = targetChunk;
      const chunk = chunks[targetChunk];
      if (audioRef.current && chunk) {
        audioRef.current.src = chunk.audioUrl;
        audioRef.current.playbackRate = playbackRate;
        audioRef.current.currentTime = Math.max(0, Math.min(timeInChunk, chunk.duration - 0.01));
        if (isPlaying) void safePlayAudio();
      }
    } else if (audioRef.current) {
      audioRef.current.currentTime = Math.max(0, Math.min(timeInChunk, chunks[targetChunk].duration - 0.01));
    }

    setChunkCurrentTime(timeInChunk);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedText = normalizedInputText;
    if (!trimmedText) {
      setError("Paste something first.");
      return;
    }

    chunksRef.current.forEach((c) => URL.revokeObjectURL(c.audioUrl));

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
    waitingForNextChunk.current = false;
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
      const generatedChunks: SavedChunk[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          const data = JSON.parse(line);
          if (data.error) throw new Error(data.error);

          const blob = base64ToBlob(data.audioBase64, data.mimeType);
          const audioUrl = URL.createObjectURL(blob);
          const newChunk: AudioChunk = {
            audioUrl,
            audioBlob: blob,
            tokens: data.tokens ?? [],
            duration: 0, // Will be set when audio loads
          };
          generatedChunks.push({
            audioBlob: blob,
            tokens: data.tokens ?? [],
          });

          setTotalChunks(data.totalChunks);
          setChunks((prev) => {
            const next = [...prev, newChunk];
            chunksRef.current = next;
            return next;
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
      if (generatedChunks.length > 0) {
        setIsAutoSaving(true);
        const savedId = await saveLibraryEntry(trimmedText, selectedVoice, generatedChunks);
        if (savedId) {
          setActiveEntryId(savedId);
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
    if (!audio) return;

    if (audio.paused) {
      if (!audio.src && chunks[0]) {
        playChunk(currentChunkIndex);
      } else if (audio.ended) {
        audio.currentTime = 0;
        void safePlayAudio();
      } else {
        void safePlayAudio();
      }
    } else {
      invalidatePlayRequests();
      audio.pause();
    }
  }

  function handleNew() {
    invalidatePlayRequests();
    audioRef.current?.pause();
    audioRef.current?.removeAttribute("src");
    audioRef.current?.load();

    chunksRef.current.forEach((c) => URL.revokeObjectURL(c.audioUrl));
    chunksRef.current = [];
    waitingForNextChunk.current = false;

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

  async function saveLibraryEntry(textToSave: string, voiceToSave: TtsVoice, savedChunks: SavedChunk[]) {
    setIsSaving(true);
    try {
      const entry = await saveLibraryStoreEntry({
        text: textToSave,
        voice: voiceToSave,
        chunks: savedChunks,
      });
      return entry.id;
    } catch {
      setError("Could not save to library.");
      return null;
    } finally {
      setIsSaving(false);
    }
  }

  async function handleSave() {
    if (!hasAudio || isSaving) return;
    const savedId = await saveLibraryEntry(
      lastRenderedText,
      lastRenderedVoice,
      chunks.map((c) => ({ audioBlob: c.audioBlob, tokens: c.tokens })),
    );
    if (savedId) {
      setActiveEntryId(savedId);
      await fetchLibrary();
    }
  }

  async function handleLoadEntry(id: string) {
    invalidatePlayRequests();
    audioRef.current?.pause();
    chunksRef.current.forEach((c) => URL.revokeObjectURL(c.audioUrl));

    try {
      const entry = await getLibraryEntry(id);
      if (!entry) throw new Error("Not found");

      const loadedChunks: AudioChunk[] = entry.chunks.map((c: SavedChunk) => ({
        audioUrl: URL.createObjectURL(c.audioBlob),
        audioBlob: c.audioBlob,
        tokens: c.tokens,
        duration: 0,
      }));

      setText(entry.text);
      setSelectedVoice(entry.voice);
      setLastRenderedText(entry.text);
      setLastRenderedVoice(entry.voice);
      setChunks(loadedChunks);
      chunksRef.current = loadedChunks;
      setCurrentChunkIndex(0);
      currentChunkIndexRef.current = 0;
      setTotalChunks(loadedChunks.length);
      setActiveEntryId(id);
      setError(null);
      setIsPlaying(false);
      setChunkCurrentTime(0);
      setSidebarOpen(false);

      if (audioRef.current && loadedChunks[0]) {
        audioRef.current.src = loadedChunks[0].audioUrl;
        audioRef.current.playbackRate = playbackRate;
        audioRef.current.currentTime = 0;
      }
    } catch {
      setError("Could not load article.");
    }
  }

  async function handleDeleteEntry(id: string) {
    try {
      await deleteLibraryEntry(id);
      if (activeEntryId === id) setActiveEntryId(null);
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
      if (!response.ok) throw new Error("Could not sign out.");
      router.refresh();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not sign out.");
    } finally {
      setIsSigningOut(false);
    }
  }

  // Show player mode when we have audio (not stale)
  const showPlayer = hasAudio || isLoading;

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
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
          {library.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs text-muted">
              No saved articles yet
            </p>
          ) : (
            <ul className="py-2">
              {library.map((item) => (
                <li
                  key={item.id}
                  className={`group flex items-start gap-2 px-4 py-3 transition ${
                    activeEntryId === item.id
                      ? "bg-white/70"
                      : "hover:bg-white/40"
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
                      {item.charCount.toLocaleString()} chars
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

      {/* Sidebar overlay on mobile */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/20 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Main content */}
      <main className="flex w-full flex-1 flex-col">
        {/* Top bar */}
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
            {library.length > 0 && (
              <button
                onClick={() => setSidebarOpen(!sidebarOpen)}
                className="hidden items-center gap-1.5 text-xs text-muted underline decoration-dotted underline-offset-2 transition hover:text-foreground lg:flex"
              >
                {library.length} saved
              </button>
            )}
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

        {/* Hidden audio element */}
        <audio
          ref={audioRef}
          className="hidden"
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={handleChunkEnded}
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
        />

        {showPlayer ? (
          /* ── Player Mode ── */
          <div className="flex flex-1 flex-col" style={{ paddingBottom: "5.5rem" }}>
            {/* Scrollable text */}
            <div className="reading-scroll flex-1 overflow-y-auto px-5 py-8 sm:px-12 sm:py-12 lg:px-20">
              <div className="mx-auto max-w-2xl">
                {title && (
                  <h2 className="mb-6 font-serif text-2xl font-medium leading-snug tracking-tight text-foreground sm:text-3xl">
                    {title}
                  </h2>
                )}
                <div className="font-serif text-lg leading-[1.9] tracking-[0.005em] text-foreground/80 whitespace-pre-wrap sm:text-xl sm:leading-[2]">
                  {lastRenderedText || text}
                </div>
              </div>
            </div>

            {/* ── Bottom Player Bar ── */}
            <div className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-[#faf6f0]/95 backdrop-blur-sm">
              {/* Progress bar */}
              <div className="relative h-1 w-full bg-border">
                <div
                  className="absolute inset-y-0 left-0 bg-foreground/70 transition-[width] duration-200"
                  style={{
                    width: totalDuration > 0 ? `${(overallTime / totalDuration) * 100}%` : "0%",
                  }}
                />
                <input
                  ref={progressRef}
                  type="range"
                  min={0}
                  max={totalDuration || 1}
                  step={0.1}
                  value={overallTime}
                  onChange={handleSeek}
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  disabled={!hasAudio || totalDuration === 0}
                />
              </div>

              <div className="flex items-center gap-4 px-5 py-3 sm:px-8">
                {/* Left: time */}
                <span className="w-20 text-xs tabular-nums text-muted">
                  {formatTime(overallTime)} / {formatTime(totalDuration)}
                </span>

                {/* Center: controls */}
                <div className="flex flex-1 items-center justify-center gap-3">
                  {/* Rewind 15s */}
                  <button
                    type="button"
                    onClick={() => {
                      if (audioRef.current) {
                        const newTime = Math.max(0, audioRef.current.currentTime - 15);
                        audioRef.current.currentTime = newTime;
                        setChunkCurrentTime(newTime);
                      }
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

                  {/* Play/Pause */}
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

                  {/* Forward 15s */}
                  <button
                    type="button"
                    onClick={() => {
                      if (audioRef.current && chunks[currentChunkIndex]) {
                        const newTime = Math.min(
                          chunks[currentChunkIndex].duration,
                          audioRef.current.currentTime + 15,
                        );
                        audioRef.current.currentTime = newTime;
                        setChunkCurrentTime(newTime);
                      }
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

                {/* Right: speed + status */}
                <div className="flex w-20 items-center justify-end gap-2">
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
                    onChange={(e) => setPlaybackRate(Number(e.target.value))}
                    className="h-7 rounded border border-border bg-transparent px-1 text-xs text-foreground outline-none"
                  >
                    {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((r) => (
                      <option key={r} value={r}>
                        {r}x
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* ── Input Mode ── */
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
                onChange={(e) => setText(e.target.value)}
                placeholder={PLACEHOLDER}
                className="min-h-[180px] w-full resize-y rounded-xl border border-border bg-white px-5 py-4 font-serif text-[1.05rem] leading-7 text-foreground outline-none transition placeholder:font-sans focus:border-accent focus:ring-2 focus:ring-accent/20"
              />

              <div className="flex flex-wrap items-center gap-3">
                <select
                  value={selectedVoice}
                  onChange={(e) => setSelectedVoice(e.target.value as TtsVoice)}
                  className="h-10 rounded-lg border border-border bg-white px-3 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
                >
                  {TTS_VOICES.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name} — {v.tone}
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
                </span>
              </div>

              {/* Cost toggle */}
              {hasText && (
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setShowCost(!showCost)}
                    className="text-xs text-muted underline decoration-dotted underline-offset-2 transition hover:text-foreground"
                  >
                    {showCost ? "hide estimate" : "~" + formatTime(costEstimate.durationSeconds) + " listen time"}
                  </button>
                  {showCost && (
                    <span className="text-xs text-muted">
                      ~${costEstimate.totalCost.toFixed(4)} cost
                    </span>
                  )}
                </div>
              )}

              {error && (
                <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
                  {error}
                </p>
              )}
            </form>

            {/* Empty state */}
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

        {/* Error in player mode */}
        {showPlayer && error && (
          <div className="fixed top-16 left-1/2 z-20 -translate-x-1/2">
            <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700 shadow-lg">
              {error}
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
