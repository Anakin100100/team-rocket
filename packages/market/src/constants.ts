// Fixed market rules (plan.md §5–6). Code decides bounds; agents decide within them.

export const RFQ_STATES = [
  "QUOTING",
  "EVALUATING",
  "NEGOTIATING",
  "AWARDED",
  "CLOSED",
  "FAILED",
] as const;
export type RfqState = (typeof RFQ_STATES)[number];
export const TERMINAL_STATES: ReadonlySet<RfqState> = new Set([
  "CLOSED",
  "FAILED",
]);

export type CandidateStatus =
  | "invited"
  | "quoted"
  | "declined"
  | "countered"
  | "final"
  | "awarded"
  | "accepted"
  | "declined_award";

// ISO 3166-1 alpha-3, as used by TED.
export const EU_EEA_COUNTRIES = [
  "AUT",
  "BEL",
  "BGR",
  "HRV",
  "CYP",
  "CZE",
  "DNK",
  "EST",
  "FIN",
  "FRA",
  "DEU",
  "GRC",
  "HUN",
  "IRL",
  "ITA",
  "LVA",
  "LTU",
  "LUX",
  "MLT",
  "NLD",
  "POL",
  "PRT",
  "ROU",
  "SVK",
  "SVN",
  "ESP",
  "SWE",
  "ISL",
  "LIE",
  "NOR",
];
export const NATO_COUNTRIES = [
  "ALB",
  "BEL",
  "BGR",
  "CAN",
  "HRV",
  "CZE",
  "DNK",
  "EST",
  "FIN",
  "FRA",
  "DEU",
  "GRC",
  "HUN",
  "ISL",
  "ITA",
  "LVA",
  "LTU",
  "LUX",
  "MNE",
  "NLD",
  "MKD",
  "NOR",
  "POL",
  "PRT",
  "ROU",
  "SVK",
  "SVN",
  "ESP",
  "SWE",
  "TUR",
  "GBR",
  "USA",
];

export const MAX_CANDIDATES = 6;
// Supply is restricted to suppliers with at least one defence/security award
// (CPV division 35), which also stands in for the clearance requirement.
export const DEFENCE_DIVISION = "35";
export const BUDGET_MATCH_RANGE = { min: 0.2, max: 5 } as const;

export const DEFAULT_BUDGET_TOLERANCE = 1.1;
export const DEFAULT_QUOTING_WINDOW_SECONDS = 45;
export const DEFAULT_NEGOTIATION_WINDOW_SECONDS = 30;
export const DEFAULT_REQUIRED_DELIVERY_DAYS = 90;

export const COUNTER_PRICE_BOUNDS = { min: 0.85, max: 1 } as const;
export const MIN_QUOTES_TO_NEGOTIATE = 2;
// Open deals in the matched CPV above which a supplier should decline (capacity).
export const CAPACITY_LIMIT = 2;

export const SCORE_WEIGHTS = {
  price: 60,
  leadTime: 25,
  trackRecord: 15,
} as const;
// Wins at which the track-record part maxes out (log scaled).
export const TRACK_RECORD_CAP_WINS = 10;
