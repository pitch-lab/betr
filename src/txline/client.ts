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

// Get the latest finished score entry, or null if match not finished
export function getFinishedScore(scores: ScoreEntry[]): ScoreEntry | null {
  if (!scores.length) return null;
  const latest = scores.reduce((a, b) => (b.Seq > a.Seq ? b : a));
  if (!FINISHED_STATES.includes(latest.GameState)) return null;
  return latest;
}

// Legacy helper — kept for backwards compat
export function determineOutcome(scores: ScoreEntry[]): "yes" | "no" | null {
  const latest = getFinishedScore(scores);
  if (!latest) return null;
  const homeGoals = latest.Stats?.["1"] ?? 0;
  const awayGoals = latest.Stats?.["2"] ?? 0;
  return homeGoals > awayGoals ? "yes" : "no";
}

// Resolve any market type from final scores
// Stat keys: 1=home goals, 2=away goals, 3=home yellows, 4=away yellows,
//            5=home reds, 6=away reds, 7=home corners, 8=away corners
//            1001/1002=H1 goals home/away
export function resolveMarketType(
  scores: ScoreEntry[],
  marketType: string,
  threshold?: number | null,
  targetTeam?: number | null,
): "yes" | "no" | null {
  const latest = getFinishedScore(scores);
  if (!latest) return null;

  const stat = (key: string) => latest.Stats?.[key] ?? 0;

  switch (marketType) {
    case "winner": {
      const home = stat("1");
      const away = stat("2");
      return home > away ? "yes" : "no";
    }
    case "over_under_goals": {
      const total = stat("1") + stat("2");
      return total > (threshold ?? 2) ? "yes" : "no";
    }
    case "both_score": {
      return stat("1") > 0 && stat("2") > 0 ? "yes" : "no";
    }
    case "clean_sheet": {
      // targetTeam 1 = "will home keep a clean sheet?" → away goals === 0
      // targetTeam 2 = "will away keep a clean sheet?" → home goals === 0
      const goalsAgainst = (targetTeam ?? 1) === 1 ? stat("2") : stat("1");
      return goalsAgainst === 0 ? "yes" : "no";
    }
    case "ht_winner": {
      const homeH1 = stat("1001");
      const awayH1 = stat("1002");
      return homeH1 > awayH1 ? "yes" : "no";
    }
    case "over_under_corners": {
      const total = stat("7") + stat("8");
      return total > (threshold ?? 9) ? "yes" : "no";
    }
    case "over_under_cards": {
      const total = stat("3") + stat("4");
      return total > (threshold ?? 3) ? "yes" : "no";
    }
    default:
      return null;
  }
}
