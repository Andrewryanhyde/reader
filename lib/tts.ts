export const TTS_VOICES = [
  {
    id: "alloy",
    name: "Alloy",
    tone: "Balanced",
    description: "Neutral and versatile without sounding flat.",
  },
  {
    id: "ash",
    name: "Ash",
    tone: "Grounded",
    description: "Steady and focused with a calm cadence.",
  },
  {
    id: "ballad",
    name: "Ballad",
    tone: "Storytelling",
    description: "Soft and expressive for longer narrative reads.",
  },
  {
    id: "cedar",
    name: "Cedar",
    tone: "Warm",
    description: "Low-friction and easy to sit with for a while.",
  },
  {
    id: "coral",
    name: "Coral",
    tone: "Bright",
    description: "Clear and upbeat without sounding rushed.",
  },
  {
    id: "echo",
    name: "Echo",
    tone: "Crisp",
    description: "Defined diction that cuts through dense text.",
  },
  {
    id: "fable",
    name: "Fable",
    tone: "Gentle",
    description: "Smooth and slightly theatrical in a pleasant way.",
  },
  {
    id: "marin",
    name: "Marin",
    tone: "Silky",
    description: "The smoothest option here. Good default for easy listening.",
  },
  {
    id: "nova",
    name: "Nova",
    tone: "Light",
    description: "Clean and lively for short articles and notes.",
  },
  {
    id: "onyx",
    name: "Onyx",
    tone: "Deep",
    description: "Lower and more cinematic without being heavy.",
  },
  {
    id: "sage",
    name: "Sage",
    tone: "Measured",
    description: "Relaxed pacing that works well for concentration.",
  },
  {
    id: "shimmer",
    name: "Shimmer",
    tone: "Airy",
    description: "Lighter and softer, useful if harsher voices fatigue you.",
  },
  {
    id: "verse",
    name: "Verse",
    tone: "Articulate",
    description: "Clear, deliberate, and good for dense informational text.",
  },
] as const;

export type TtsVoice = (typeof TTS_VOICES)[number]["id"];

export const DEFAULT_VOICE: TtsVoice = "alloy";

export const PREVIEW_SAMPLE_TEXT =
  "This is a short voice sample for Reader. The pacing is steady, the words are clear, and the tone is easy to follow.";

export function isTtsVoice(value: string | undefined | null): value is TtsVoice {
  return TTS_VOICES.some((voice) => voice.id === value);
}
