// Fixed market rules (plan.md §4). Code decides bounds; agents decide within them.

export type Side = "buyer" | "supplier";
export type ActorKind = Side | "observer";
export type PostingState = "open" | "filled" | "withdrawn";
export type MatchState = "open" | "agreed" | "abandoned" | "superseded";

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

export const DEFENCE_DIVISION = "35";
// Matches opened per posting (plan.md §4.2).
export const MAX_MATCHES = 6;
// Buyer walk-away = published value × this, when the listing has none sealed.
export const WALK_AWAY_FACTOR = 1.1;
// Thread floor = max(offer floor, this × the demand's published value).
export const THREAD_FLOOR_ANCHOR = 0.6;
// Proposals per side in one thread (the supplier's opening ask counts).
export const MAX_PROPOSALS_PER_SIDE = 3;
// The one message both sides get when they overstep their own sealed limit.
export const OUTSIDE_LIMIT = "outside your limit";

export const WAIT_MAX_SECONDS = 20;
export const WAIT_POLL_MS = 1000;
export const MAX_CITES = 5;
