import type { Weather } from "./types.ts";

/** Older or partially refreshed servers may omit blended weather strengths. */
export function weatherStrengths(weather?: Weather): { sun: number; rain: number; snow: number } {
  if (!weather) return { sun: 1, rain: 0, snow: 0 };
  const condition = weather.condition;
  const strength = (kind: "sun" | "rain" | "snow") => {
    const value = weather[kind];
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : condition === kind ? 1 : 0;
  };
  return { sun: strength("sun"), rain: strength("rain"), snow: strength("snow") };
}
