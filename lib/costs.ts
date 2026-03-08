const TTS_INPUT_COST_PER_MILLION_TOKENS = 0.6;
const TTS_AUDIO_COST_PER_MINUTE = 0.015;
const WHISPER_COST_PER_MINUTE = 0.006;
const CHARACTERS_PER_TOKEN_ESTIMATE = 4;
const WORDS_PER_MINUTE_ESTIMATE = 170;

export type ReadingCostEstimate = {
  inputTokensEstimate: number;
  durationSeconds: number;
  durationMinutes: number;
  ttsInputCost: number;
  ttsAudioCost: number;
  alignmentCost: number;
  totalCost: number;
  usesEstimatedDuration: boolean;
};

export function estimateInputTokens(text: string) {
  return Math.max(1, Math.ceil(text.trim().length / CHARACTERS_PER_TOKEN_ESTIMATE));
}

export function estimateDurationSeconds(text: string) {
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;

  if (!wordCount) {
    return 0;
  }

  return (wordCount / WORDS_PER_MINUTE_ESTIMATE) * 60;
}

const AVERAGE_WORD_LENGTH = 5;

export function estimateDurationFromCharCount(charCount: number) {
  if (charCount <= 0) return 0;
  const wordCount = charCount / AVERAGE_WORD_LENGTH;
  return (wordCount / WORDS_PER_MINUTE_ESTIMATE) * 60;
}

export function calculateReadingCost(text: string, durationSeconds?: number | null): ReadingCostEstimate {
  const inputTokensEstimate = estimateInputTokens(text);
  const resolvedDurationSeconds =
    typeof durationSeconds === "number" && Number.isFinite(durationSeconds) && durationSeconds > 0
      ? durationSeconds
      : estimateDurationSeconds(text);
  const durationMinutes = resolvedDurationSeconds / 60;
  const ttsInputCost = (inputTokensEstimate / 1_000_000) * TTS_INPUT_COST_PER_MILLION_TOKENS;
  const ttsAudioCost = durationMinutes * TTS_AUDIO_COST_PER_MINUTE;
  const alignmentCost = durationMinutes * WHISPER_COST_PER_MINUTE;

  return {
    inputTokensEstimate,
    durationSeconds: resolvedDurationSeconds,
    durationMinutes,
    ttsInputCost,
    ttsAudioCost,
    alignmentCost,
    totalCost: ttsInputCost + ttsAudioCost + alignmentCost,
    usesEstimatedDuration: !(typeof durationSeconds === "number" && Number.isFinite(durationSeconds) && durationSeconds > 0),
  };
}
