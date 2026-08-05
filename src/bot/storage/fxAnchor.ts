// FX amount anchoring (budgetman, opt-in via `actual.anchorFxToFibi`).
//
// An Isracard FX pending charge carries Isracard's PROVISIONAL ILS estimate
// (e.g. €20 -> ₪61.14). FIBI's auth hold for the same charge shows a DIFFERENT,
// re-quoting ILS (e.g. ₪63.58). Both are provisional and move until settlement.
// To keep Actual's working balance tracking FIBI's current balance, we override
// the Isracard row's ILS `chargedAmount` with FIBI's auth amount — matched by
// date window + amount. Only the ILS figure changes; originalAmount/currency/
// merchant stay, so the FX-stable pending<->settled collapse is unaffected.
//
// Pure and side-effect-free so the matching is unit-testable without a browser.

/** A FIBI FX auth-hold used purely as an amount source (integer minor units). */
export interface FibiAuth {
  amountMinor: number;
  date: string; // YYYY-MM-DD
}

export interface FxAnchorInput {
  originalCurrency: string;
  chargedAmount: number; // ILS (provisional), as scraped
  matchDate: string; // YYYY-MM-DD (purchase/key date)
}

export type FxAnchorOutcome =
  | "anchored"
  | "ambiguous-skipped"
  | "no-candidate"
  | "not-fx";

export interface FxAnchorResult {
  /** The ILS amount to use (integer minor units): FIBI's when anchored, else the
   * incoming Isracard estimate. */
  amountMinor: number;
  /** Index into the passed `fibiAuths` that was consumed, or null if none. */
  consumedIndex: number | null;
  /** Why this decision was made — for observability. */
  outcome: FxAnchorOutcome;
  /** fibiILS/isracardILS for the chosen (or, when skipped, the nearest
   * considered) candidate; null when there was no candidate / not FX. Lets the
   * caller log the FX spread and confirm the ~4% hypothesis. */
  ratio: number | null;
  /** The FIBI ILS (minor units) of the chosen/nearest candidate, for logging. */
  candidateMinor: number | null;
}

/** Match window between the FIBI auth date and the Isracard purchase date. */
export const FX_ANCHOR_WINDOW_DAYS = 4;
/** When more than one auth is in-window, the nearest by |amount| must be this
 * close (fraction of the Isracard ILS) to anchor confidently. */
export const FX_ANCHOR_TOLERANCE = 0.15;

// --- Disambiguation signal ordering (multi-candidate) ----------------------
// Hypothesis (to confirm from box logs): FIBI's FX auth ILS runs a consistent
// ~4% ABOVE Isracard's provisional ILS (FIBI's conversion spread), i.e.
// ratio = fibiILS/isracardILS ≈ 1.04.
//
// TODAY the PRIMARY disambiguator is nearest-absolute-amount (with the
// tolerance + strictly-nearest guard). The FX-ratio band below is a SECONDARY
// signal: among several in-window candidates, if exactly ONE has a plausible FX
// ratio we take it even if another is marginally nearer in absolute terms.
//
// The band starts WIDE; tighten it around the observed median once we have data.
// TO PROMOTE THE RATIO TO THE PRIMARY KEY LATER: this is the one place to edit —
// select by |ratio - EXPECTED_MEDIAN| instead of by absolute `dist` in the
// multi-candidate block, and narrow [LOW, HIGH]. No other change needed.
export const FX_RATIO_EXPECTED_LOW = 1.0;
export const FX_RATIO_EXPECTED_HIGH = 1.1;
export const FX_RATIO_EXPECTED_MEDIAN = 1.04; // working hypothesis, not yet used as the key

function daysBetween(a: string, b: string): number {
  const da = Date.parse(`${a}T00:00:00Z`);
  const db = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(da) || Number.isNaN(db)) return Number.POSITIVE_INFINITY;
  return Math.abs(da - db) / 86_400_000;
}

interface Candidate {
  i: number;
  auth: FibiAuth;
  dist: number; // |fibi| - |isracard| distance in minor units
  ratio: number; // |fibi| / |isracard|
}

function inBand(c: Candidate): boolean {
  return c.ratio >= FX_RATIO_EXPECTED_LOW && c.ratio <= FX_RATIO_EXPECTED_HIGH;
}

/**
 * Decide the ILS amount for one Isracard pending charge, optionally anchoring it
 * to a FIBI FX auth hold. Only FX (non-ILS) charges anchor. Selection:
 *  - candidates = FIBI auths within FX_ANCHOR_WINDOW_DAYS of the purchase date;
 *  - exactly one candidate -> anchor to it (a lone auth in a 4-day window is very
 *    likely the same charge);
 *  - several candidates -> if exactly ONE is in the plausible FX-ratio band, take
 *    it (secondary signal); otherwise anchor to the nearest by |amount| when it
 *    is within FX_ANCHOR_TOLERANCE AND strictly nearest; else skip (ambiguous).
 * Never anchors a domestic (ILS) charge. Caller passes only pending charges. The
 * result carries the ratio + outcome for observability.
 */
export function anchorFxAmount(
  incoming: FxAnchorInput,
  fibiAuths: FibiAuth[],
): FxAnchorResult {
  const incomingMinor = Math.round(incoming.chargedAmount * 100);
  const skip = (
    outcome: FxAnchorOutcome,
    ratio: number | null = null,
    candidateMinor: number | null = null,
  ): FxAnchorResult => ({
    amountMinor: incomingMinor,
    consumedIndex: null,
    outcome,
    ratio,
    candidateMinor,
  });
  const anchorTo = (c: Candidate): FxAnchorResult => ({
    amountMinor: c.auth.amountMinor,
    consumedIndex: c.i,
    outcome: "anchored",
    ratio: c.ratio,
    candidateMinor: c.auth.amountMinor,
  });

  if (!incoming.originalCurrency || incoming.originalCurrency === "ILS") {
    return skip("not-fx");
  }

  const mag = Math.abs(incomingMinor);
  const candidates: Candidate[] = fibiAuths
    .map((a, i) => ({
      i,
      auth: a,
      dist: Math.abs(Math.abs(a.amountMinor) - mag),
      ratio: mag > 0 ? Math.abs(a.amountMinor) / mag : Number.POSITIVE_INFINITY,
    }))
    .filter(
      (c) =>
        daysBetween(c.auth.date, incoming.matchDate) <= FX_ANCHOR_WINDOW_DAYS,
    );

  if (candidates.length === 0) return skip("no-candidate");
  if (candidates.length === 1) return anchorTo(candidates[0]);

  // Secondary signal: a single plausible FX-ratio candidate wins outright.
  const banded = candidates.filter(inBand);
  if (banded.length === 1) return anchorTo(banded[0]);

  // Primary signal (today): nearest absolute amount, guarded.
  const sorted = [...candidates].sort((x, y) => x.dist - y.dist);
  const [best, second] = sorted;
  const withinTolerance = mag > 0 && best.dist / mag <= FX_ANCHOR_TOLERANCE;
  const strictlyNearest = best.dist < second.dist;

  if (withinTolerance && strictlyNearest) return anchorTo(best);
  return skip("ambiguous-skipped", best.ratio, best.auth.amountMinor);
}

/** One charge's assignment in a batch match (see {@link assignFxAnchors}). */
export interface FxAnchorAssignment {
  /** ILS to use (minor units): the matched FIBI auth's when anchored, else the
   * incoming Isracard estimate. */
  amountMinor: number;
  /** Index into `fibiAuths` consumed by this charge, or null if unanchored. */
  consumedAuthIndex: number | null;
  outcome: FxAnchorOutcome;
  /** fibiILS/isracardILS of the chosen (or, when unanchored, nearest in-window)
   * candidate; null when there was none / not FX. */
  ratio: number | null;
  /** FIBI ILS (minor units) of the chosen/nearest candidate, for logging. */
  candidateMinor: number | null;
}

/**
 * Batch-match a set of FX charges to a shared pool of FIBI auth holds with a
 * GLOBAL best-pair assignment, instead of anchoring charge-by-charge in list
 * order. Per-charge greedy is order-dependent and mis-assigns when two FX
 * charges compete for one hold: e.g. a ₪63.58 hold is within tolerance of both
 * Google (₪57.58, 10.4%) and Upstash (₪61.21, 3.9%); whichever charge is seen
 * first claims it. This assigns each hold to the charge it fits BEST.
 *
 * Algorithm: form every in-window (charge, auth) pair; keep the "confident" ones
 * (in the FX-ratio band, OR within tolerance, OR the charge's lone in-window
 * auth); then greedily consume pairs preferring in-band first, then nearest by
 * |amount|. Each charge and each auth is used at most once. A charge whose only
 * confident hold is taken by a closer charge is left unanchored (it keeps
 * Isracard's amount) — correct for an already-settled charge whose real auth has
 * been released, so it no longer owns any live hold. Pure/testable.
 */
export function assignFxAnchors(
  charges: FxAnchorInput[],
  fibiAuths: FibiAuth[],
): FxAnchorAssignment[] {
  const results: FxAnchorAssignment[] = charges.map((c) => ({
    amountMinor: Math.round(c.chargedAmount * 100),
    consumedAuthIndex: null,
    outcome:
      !c.originalCurrency || c.originalCurrency === "ILS"
        ? "not-fx"
        : "no-candidate",
    ratio: null,
    candidateMinor: null,
  }));

  interface Pair {
    ci: number;
    ai: number;
    dist: number;
    ratio: number;
    inBand: boolean;
    confident: boolean;
  }
  const pairs: Pair[] = [];
  charges.forEach((c, ci) => {
    if (results[ci].outcome === "not-fx") return;
    const mag = Math.abs(Math.round(c.chargedAmount * 100));
    const inWindow = fibiAuths
      .map((a, ai) => ({ a, ai }))
      .filter(
        ({ a }) => daysBetween(a.date, c.matchDate) <= FX_ANCHOR_WINDOW_DAYS,
      );
    const lone = inWindow.length === 1;
    for (const { a, ai } of inWindow) {
      const dist = Math.abs(Math.abs(a.amountMinor) - mag);
      const ratio =
        mag > 0 ? Math.abs(a.amountMinor) / mag : Number.POSITIVE_INFINITY;
      const inBand =
        ratio >= FX_RATIO_EXPECTED_LOW && ratio <= FX_RATIO_EXPECTED_HIGH;
      const withinTol = mag > 0 && dist / mag <= FX_ANCHOR_TOLERANCE;
      pairs.push({
        ci,
        ai,
        dist,
        ratio,
        inBand,
        confident: lone || inBand || withinTol,
      });
    }
  });

  // Greedy global assignment: in-band pairs first (the ~4% FX spread is the
  // strong signal), then nearest by |amount|. Each charge/auth consumed once.
  const usedCharge = new Set<number>();
  const usedAuth = new Set<number>();
  for (const p of pairs
    .filter((p) => p.confident)
    .sort((x, y) => Number(y.inBand) - Number(x.inBand) || x.dist - y.dist)) {
    if (usedCharge.has(p.ci) || usedAuth.has(p.ai)) continue;
    usedCharge.add(p.ci);
    usedAuth.add(p.ai);
    results[p.ci] = {
      amountMinor: fibiAuths[p.ai].amountMinor,
      consumedAuthIndex: p.ai,
      outcome: "anchored",
      ratio: p.ratio,
      candidateMinor: fibiAuths[p.ai].amountMinor,
    };
  }

  // Unanchored FX charges: surface the nearest in-window candidate for the log.
  charges.forEach((_, ci) => {
    if (results[ci].outcome !== "no-candidate") return;
    const near = pairs
      .filter((p) => p.ci === ci)
      .sort((a, b) => a.dist - b.dist)[0];
    if (near) {
      results[ci].outcome = "ambiguous-skipped";
      results[ci].ratio = near.ratio;
      results[ci].candidateMinor = fibiAuths[near.ai].amountMinor;
    }
  });

  return results;
}
