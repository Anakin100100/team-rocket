// Supplier price band, computed at invitation from the supplier's own award
// history (plan.md §6.3). The agent picks inside [low, high]; nothing below
// the floor is accepted.

const BAND_SPREAD = 0.15;
const BUDGET_CLIP = { min: 0.5, max: 1.5 } as const;

type SizeClass = "small" | "medium" | "large";

const sizeClass = (size: string | null): SizeClass => {
  if (size === "micro" || size === "small") {
    return "small";
  }
  if (size === "large") {
    return "large";
  }
  return "medium";
};

const BAND_SHIFT: Record<SizeClass, number> = {
  small: 0.95,
  medium: 1,
  large: 1.05,
};
const FLOOR_MARGIN: Record<SizeClass, number> = {
  small: 0.9,
  medium: 0.85,
  large: 0.8,
};

const roundEur = (value: number) => Math.round(value);

export interface PriceBand {
  low: number;
  high: number;
  floor: number;
}

export const priceBand = ({
  medianAwardEur,
  minAwardEur,
  budgetEur,
  size,
}: {
  medianAwardEur: number;
  minAwardEur: number | null;
  budgetEur: number | null;
  size: string | null;
}): PriceBand => {
  const base =
    budgetEur === null
      ? medianAwardEur
      : Math.min(
          Math.max(medianAwardEur, BUDGET_CLIP.min * budgetEur),
          BUDGET_CLIP.max * budgetEur
        );
  const sizeKey = sizeClass(size);
  const shift = BAND_SHIFT[sizeKey];
  const low = base * (1 - BAND_SPREAD) * shift;
  const high = base * (1 + BAND_SPREAD) * shift;
  // A floor above the band would make quoting impossible, so it never exceeds
  // the low end; a counter below it still forces the supplier to hold.
  const floor = Math.min((minAwardEur ?? low) * FLOOR_MARGIN[sizeKey], low);
  return { low: roundEur(low), high: roundEur(high), floor: roundEur(floor) };
};
