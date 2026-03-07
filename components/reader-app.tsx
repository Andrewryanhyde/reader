"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { calculateReadingCost } from "@/lib/costs";
import { findActiveTokenIndex, ReadingToken } from "@/lib/reader";
import { DEFAULT_VOICE, TTS_VOICES, TtsVoice } from "@/lib/tts";
import { LibraryListItem, SavedChunk } from "@/lib/library";
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
};

function base64ToBlob(base64: string, mimeType: string) {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: mimeType });
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
  const [currentTime, setCurrentTime] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [lastRenderedText, setLastRenderedText] = useState("");
  const [lastRenderedVoice, setLastRenderedVoice] = useState<TtsVoice>(DEFAULT_VOICE);
  const [showCost, setShowCost] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1.25);

  // Chunk-based audio state
  const [chunks, setChunks] = useState<AudioChunk[]>([]);
  const [currentChunkIndex, setCurrentChunkIndex] = useState(0);
  const [totalChunks, setTotalChunks] = useState(0);

  // Library state
  const [library, setLibrary] = useState<LibraryListItem[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isAutoSaving, setIsAutoSaving] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const readingContainerRef = useRef<HTMLDivElement | null>(null);
  const tokenRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const chunksRef = useRef<AudioChunk[]>([]);
  const currentChunkIndexRef = useRef(0);
  const waitingForNextChunk = useRef(false);
  const rafRef = useRef<number | null>(null);
  const playbackRateRef = useRef(1);
  const playRequestIdRef = useRef(0);

  // Keep refs in sync
  useEffect(() => { chunksRef.current = chunks; }, [chunks]);
  useEffect(() => { currentChunkIndexRef.current = currentChunkIndex; }, [currentChunkIndex]);
  useEffect(() => { playbackRateRef.current = playbackRate; }, [playbackRate]);

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

  // Build flat token array from all received chunks
  const allTokens = useMemo(() => chunks.flatMap((c) => c.tokens), [chunks]);

  const currentChunkTokenOffset = useMemo(() => {
    let offset = 0;
    for (let i = 0; i < currentChunkIndex; i++) {
      if (chunks[i]) offset += chunks[i].tokens.length;
    }
    return offset;
  }, [chunks, currentChunkIndex]);

  const localActiveIndex = useMemo(() => {
    const chunkTokens = chunks[currentChunkIndex]?.tokens ?? [];
    return findActiveTokenIndex(chunkTokens, currentTime);
  }, [chunks, currentChunkIndex, currentTime]);

  const globalActiveIndex = localActiveIndex >= 0
    ? currentChunkTokenOffset + localActiveIndex
    : -1;

  const normalizedInputText = text.trim();
  const charCount = text.length;
  const audioIsStale =
    Boolean(lastRenderedText) &&
    (lastRenderedText !== normalizedInputText || lastRenderedVoice !== selectedVoice);
  const hasAudio = chunks.length > 0 && !audioIsStale;
  const hasText = normalizedInputText.length > 0;
  const costEstimate = useMemo(() => calculateReadingCost(text, null), [text]);
  const canSave = hasAudio && !isStreaming && !isAutoSaving && !activeEntryId;
  const inputCollapsed = isPlaying && hasAudio;

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = playbackRate;
  }, [playbackRate]);

  const syncCurrentTime = useCallback(() => {
    const audio = audioRef.current;

    if (!audio) {
      rafRef.current = null;
      return;
    }

    const leadSeconds = Math.min(0.04 * playbackRateRef.current, 0.12);
    setCurrentTime(audio.currentTime + leadSeconds);

    if (!audio.paused && !audio.ended) {
      rafRef.current = requestAnimationFrame(syncCurrentTime);
    } else {
      rafRef.current = null;
    }
  }, []);

  function startTimeTracking() {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(syncCurrentTime);
  }

  function stopTimeTracking() {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }

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
    } catch (error) {
      if (playRequestIdRef.current !== requestId) {
        return;
      }

      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }

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
    if (!isPlaying || globalActiveIndex < 0) return;

    const container = readingContainerRef.current;
    const token = tokenRefs.current[globalActiveIndex];

    if (!container || !token) return;

    const maxScrollTop = container.scrollHeight - container.clientHeight;
    if (maxScrollTop <= 0) {
      return;
    }

    const targetCenterY = container.clientHeight * 0.3;
    const tokenCenterY = token.offsetTop + token.offsetHeight / 2;
    const nextScrollTop = Math.max(
      0,
      Math.min(maxScrollTop, tokenCenterY - targetCenterY),
    );

    if (Math.abs(container.scrollTop - nextScrollTop) < 10) {
      return;
    }

    container.scrollTo({
      top: nextScrollTop,
      behavior: "auto",
    });
  }, [globalActiveIndex, isPlaying]);

  useEffect(() => {
    return () => {
      invalidatePlayRequests();
      stopTimeTracking();
      chunksRef.current.forEach((c) => URL.revokeObjectURL(c.audioUrl));
    };
  }, []);

  function handleChunkEnded() {
    invalidatePlayRequests();
    stopTimeTracking();
    const nextIndex = currentChunkIndexRef.current + 1;
    setCurrentChunkIndex(nextIndex);
    currentChunkIndexRef.current = nextIndex;
    setCurrentTime(0);

    if (chunksRef.current[nextIndex]) {
      playChunk(nextIndex);
    } else if (nextIndex < (totalChunks || Infinity)) {
      waitingForNextChunk.current = true;
    } else {
      setIsPlaying(false);
      setCurrentTime(0);
      setCurrentChunkIndex(0);
      currentChunkIndexRef.current = 0;
    }
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
    setCurrentTime(0);
    setCurrentChunkIndex(0);
    currentChunkIndexRef.current = 0;
    setChunks([]);
    chunksRef.current = [];
    setTotalChunks(0);
    setActiveEntryId(null);
    waitingForNextChunk.current = false;
    invalidatePlayRequests();
    stopTimeTracking();

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
    stopTimeTracking();
    chunksRef.current.forEach((c) => URL.revokeObjectURL(c.audioUrl));
    chunksRef.current = [];
    tokenRefs.current = [];
    waitingForNextChunk.current = false;

    setText("");
    setSelectedVoice(DEFAULT_VOICE);
    setError(null);
    setIsLoading(false);
    setIsStreaming(false);
    setIsPlaying(false);
    setCurrentTime(0);
    setLastRenderedText("");
    setLastRenderedVoice(DEFAULT_VOICE);
    setChunks([]);
    setCurrentChunkIndex(0);
    currentChunkIndexRef.current = 0;
    setTotalChunks(0);
    setActiveEntryId(null);
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
      chunks.map((c) => ({
        audioBlob: c.audioBlob,
        tokens: c.tokens,
      })),
    );

    if (savedId) {
      setActiveEntryId(savedId);
      await fetchLibrary();
    }
  }

  async function handleLoadEntry(id: string) {
    // Stop current playback
    invalidatePlayRequests();
    audioRef.current?.pause();
    chunksRef.current.forEach((c) => URL.revokeObjectURL(c.audioUrl));

    try {
      const entry = await getLibraryEntry(id);

      if (!entry) {
        throw new Error("Not found");
      }

      const loadedChunks: AudioChunk[] = entry.chunks.map((c: SavedChunk) => {
        return {
          audioUrl: URL.createObjectURL(c.audioBlob),
          audioBlob: c.audioBlob,
          tokens: c.tokens,
        };
      });

      setText(entry.text);
      setSelectedVoice(entry.voice);
      setLastRenderedText(entry.text);
      setLastRenderedVoice(entry.voice);
      setChunks(loadedChunks);
      chunksRef.current = loadedChunks;
      setCurrentChunkIndex(0);
      currentChunkIndexRef.current = 0;
      setCurrentTime(0);
      setTotalChunks(loadedChunks.length);
      setActiveEntryId(id);
      setError(null);
      setIsPlaying(false);
      setSidebarOpen(false);
      stopTimeTracking();

      // Prime the first chunk without auto-playing.
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

  const displayTokens =
    allTokens.length > 0
      ? allTokens
      : hasText
        ? [{ value: text, isWord: false, start: null, end: null }]
        : [];

  return (
    <div className="flex min-h-screen lg:h-screen lg:overflow-hidden">
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
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-5 py-8 sm:py-12 lg:h-screen lg:min-h-0 lg:overflow-hidden">
        {/* Header */}
        <header className="mb-8 flex items-center gap-3">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-white text-muted transition hover:text-foreground lg:hidden"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M2 4h12M2 8h12M2 12h12" />
            </svg>
          </button>
          <div>
            <h1 className="font-serif text-3xl tracking-tight sm:text-4xl">
              Reader
            </h1>
            <p className="mt-1 text-sm text-muted">
              Paste text, pick a voice, listen along.
            </p>
          </div>
          <button
            type="button"
            onClick={handleNew}
            className="ml-auto flex h-9 items-center rounded-lg border border-border bg-white px-3 text-sm font-medium text-foreground transition hover:bg-foreground/5"
          >
            New
          </button>
          {passwordProtected && (
            <button
              className="flex h-9 items-center rounded-lg border border-border bg-white px-3 text-sm font-medium text-foreground transition hover:bg-foreground/5 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={isSigningOut}
              onClick={handleSignOut}
              type="button"
            >
              {isSigningOut ? "Signing out..." : "Lock"}
            </button>
          )}
          {library.length > 0 && (
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="hidden items-center gap-1.5 text-xs text-muted underline decoration-dotted underline-offset-2 transition hover:text-foreground lg:flex"
            >
              {library.length} saved
            </button>
          )}
        </header>

        {/* Input form */}
        <form onSubmit={handleSubmit} className="shrink-0 flex flex-col gap-4">
          <div
            className={[
              "overflow-hidden transition-[max-height,opacity,margin] duration-200 ease-out",
              inputCollapsed ? "pointer-events-none -mb-2 max-h-0 opacity-0" : "max-h-[320px] opacity-100",
            ].join(" ")}
          >
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={PLACEHOLDER}
              className="min-h-[160px] w-full resize-y rounded-xl border border-border bg-white px-4 py-3 font-serif text-[1.05rem] leading-7 text-foreground outline-none transition placeholder:font-sans focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
          </div>

          {inputCollapsed && (
            <div className="rounded-lg border border-border bg-white/70 px-4 py-2.5 text-xs text-muted">
              Input hidden during playback to keep the reading view clear. Pause to edit.
            </div>
          )}

          {/* Controls row */}
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

            {hasAudio && !audioIsStale ? (
              <button
                type="button"
                onClick={togglePlayback}
                className="flex h-10 items-center gap-1.5 rounded-lg bg-foreground px-5 text-sm font-medium text-white transition hover:bg-foreground/85"
              >
                {isPlaying ? (
                  <>
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                      <rect x="2" y="1" width="4" height="12" rx="1" />
                      <rect x="8" y="1" width="4" height="12" rx="1" />
                    </svg>
                    Pause
                  </>
                ) : (
                  <>
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                      <path d="M3 1.5v11l9-5.5z" />
                    </svg>
                    Play
                  </>
                )}
              </button>
            ) : (
              <button
                type="submit"
                disabled={isLoading || !hasText}
                className="h-10 rounded-lg bg-foreground px-5 text-sm font-medium text-white transition hover:bg-foreground/85 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isLoading ? "Generating..." : "Generate"}
              </button>
            )}

            {hasAudio && (
              <select
                value={playbackRate}
                onChange={(e) => setPlaybackRate(Number(e.target.value))}
                className="h-10 rounded-lg border border-border bg-white px-2 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
              >
                {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((r) => (
                  <option key={r} value={r}>
                    {r}x
                  </option>
                ))}
              </select>
            )}

            {canSave && (
              <button
                type="button"
                onClick={handleSave}
                disabled={isSaving}
                className="flex h-10 items-center gap-1.5 rounded-lg border border-border bg-white px-4 text-sm font-medium text-foreground transition hover:bg-foreground/5 disabled:opacity-40"
              >
                {isSaving ? "Saving..." : "Save"}
              </button>
            )}

            {isAutoSaving && (
              <span className="text-xs text-muted">Auto-saving...</span>
            )}

            {!isAutoSaving && activeEntryId && (
              <span className="text-xs text-green-600">Saved</span>
            )}

            <span className="ml-auto text-xs text-muted">
              {charCount.toLocaleString()} chars
              {isStreaming && (
                <span className="ml-2 text-accent">
                  {chunks.length}/{totalChunks} chunks
                </span>
              )}
            </span>
          </div>

          {/* Cost toggle */}
          {hasText && !inputCollapsed && (
            <button
              type="button"
              onClick={() => setShowCost(!showCost)}
              className="self-start text-xs text-muted underline decoration-dotted underline-offset-2 transition hover:text-foreground"
            >
              {showCost ? "hide cost estimate" : "cost estimate"}
            </button>
          )}

          {showCost && hasText && !inputCollapsed && (
            <div className="rounded-lg border border-border bg-white/60 px-4 py-3 text-xs text-muted">
              <span className="font-medium text-foreground">
                ~${costEstimate.totalCost.toFixed(4)}
              </span>
              {" "}(estimated){" — "}
              TTS ${costEstimate.ttsAudioCost.toFixed(4)} + alignment $
              {costEstimate.alignmentCost.toFixed(4)} + input $
              {costEstimate.ttsInputCost.toFixed(4)}
            </div>
          )}

          {error && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
              {error}
            </p>
          )}
        </form>

        {/* Hidden audio element */}
        <audio
          ref={audioRef}
          className="hidden"
          onPlay={() => {
            setIsPlaying(true);
            startTimeTracking();
          }}
          onPause={() => {
            setIsPlaying(false);
            stopTimeTracking();
          }}
          onEnded={handleChunkEnded}
          onSeeking={(e) => setCurrentTime(e.currentTarget.currentTime)}
          onSeeked={(e) => setCurrentTime(e.currentTarget.currentTime)}
          onRateChange={() => {
            if (audioRef.current && !audioRef.current.paused) {
              startTimeTracking();
            }
          }}
        />

        {/* Reading area */}
        {displayTokens.length > 0 && (
          <div className="mt-8 flex min-h-0 flex-1 flex-col">
            <div className="mb-3 flex items-center gap-2">
              <div
                className={`h-1.5 w-1.5 rounded-full ${
                  isPlaying
                    ? "bg-green-500 animate-pulse"
                    : isLoading
                      ? "bg-yellow-500 animate-pulse"
                      : hasAudio
                        ? "bg-accent"
                        : "bg-border"
                }`}
              />
              <span className="text-xs text-muted">
                {isLoading
                  ? "Generating first chunk..."
                  : isPlaying && isStreaming
                    ? "Playing (loading more...)"
                    : isAutoSaving
                      ? "Saving article..."
                    : isPlaying
                      ? "Playing"
                      : hasAudio
                        ? "Paused"
                        : "Paste text and press Read"}
              </span>
            </div>

            <div className="relative h-[min(60vh,38rem)] min-h-0 overflow-hidden rounded-2xl border border-border bg-white lg:h-full">
              <div className="pointer-events-none absolute inset-x-4 top-[30%] h-18 -translate-y-1/2 rounded-[1.25rem] border border-accent/8 bg-accent/6" />
              <div
                ref={readingContainerRef}
                className="reading-scroll h-full overflow-y-auto px-6 sm:px-10"
              >
                <div
                  aria-live="polite"
                  className="min-h-full py-24 font-serif text-xl leading-[2] tracking-[0.005em] text-foreground sm:py-28 sm:text-2xl sm:leading-[2.1]"
                >
                {displayTokens.map((token, index) => {
                  const isActive = index === globalActiveIndex;
                  const isInPreviousChunk = index < currentChunkTokenOffset;
                  const isSpoken =
                    isInPreviousChunk ||
                    (token.end !== null &&
                      globalActiveIndex >= 0 &&
                      index < globalActiveIndex);

                  return (
                    <span
                      key={`${index}-${token.value}`}
                      ref={(el) => {
                        tokenRefs.current[index] = el;
                      }}
                      className={[
                        "whitespace-pre-wrap transition-[background-color,color,box-shadow] duration-75 ease-out",
                        isActive
                          ? "rounded-lg bg-[#ffd76b] px-1.5 py-1 text-[#1b1400] shadow-[0_8px_24px_rgba(255,215,107,0.5)]"
                          : "",
                        isSpoken && !isActive ? "text-[rgba(0,0,0,0.3)]" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    >
                      {token.value}
                    </span>
                  );
                })}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Empty state */}
        {displayTokens.length === 0 && (
          <div className="mt-16 flex flex-1 flex-col items-center justify-center text-center text-muted">
            <svg width="48" height="48" viewBox="0 0 48 48" fill="none" className="mb-4 opacity-30">
              <rect x="8" y="6" width="32" height="36" rx="4" stroke="currentColor" strokeWidth="2" />
              <line x1="14" y1="16" x2="34" y2="16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <line x1="14" y1="22" x2="30" y2="22" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <line x1="14" y1="28" x2="26" y2="28" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <p className="text-sm">Paste something above to get started</p>
          </div>
        )}
      </main>
    </div>
  );
}
