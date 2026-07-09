import { env } from "../env.js";

const API_BASE = "https://txline-dev.txodds.com";

// GameState values that indicate a finished match
const FINISHED_STATES: (string | number)[] = ["F", "FET", "FPE", 5, 10, 13];

export interface Fixture {
  FixtureId: number;
  Participant1: string;
  Participant2: string;
  Participant1IsHome: boolean;
  Competition: string;
  CompetitionId: number;
  StartTime: number;
}

interface ScoreEntry {
  GameState: string | number;
  Stats: Record<string, number>;
  Seq: number;
}

function txlineHeaders() {
  return {
    "Authorization": `Bearer ${env.TXLINE_JWT}`,
    "X-Api-Token": env.TXLINE_API_TOKEN,
  };
}

// Fetch all upcoming fixtures from today onwards
export async function getFixtures(): Promise<Fixture[]> {
  const epochDay = Math.floor(Date.now() / 86400000);
  const res = await fetch(
    `${API_BASE}/api/fixtures/snapshot?startEpochDay=${epochDay}`,
    { headers: txlineHeaders() },
  );
  if (!res.ok) throw new Error(`TxLINE fixtures error: ${res.status}`);
  const data = await res.json() as Fixture[];
  // Only return fixtures that haven't started yet
  return data.filter((f) => f.StartTime > Date.now());
}

// Fetch the score history for a specific fixture
export async function getScore(fixtureId: number): Promise<ScoreEntry[]> {
  const res = await fetch(
    `${API_BASE}/api/scores/snapshot/${fixtureId}`,
    { headers: txlineHeaders() },
  );
  if (!res.ok) throw new Error(`TxLINE scores error: ${res.status}`);
  return res.json() as Promise<ScoreEntry[]>;
}

// Determine the outcome of a finished match.
// YES = Participant1 (home) wins, NO = draw or away win.
// Returns null if the match hasn't finished yet.
export function determineOutcome(scores: ScoreEntry[]): "yes" | "no" | null {
  if (!scores.length) return null;

  // Get the most recent score entry
  const latest = scores.reduce((a, b) => (b.Seq > a.Seq ? b : a));

  if (!FINISHED_STATES.includes(latest.GameState)) return null;

  const homeGoals = latest.Stats?.["1"] ?? 0;
  const awayGoals = latest.Stats?.["2"] ?? 0;

  return homeGoals > awayGoals ? "yes" : "no";
}
