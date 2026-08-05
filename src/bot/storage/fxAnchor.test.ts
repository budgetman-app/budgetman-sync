import { anchorFxAmount, assignFxAnchors, type FibiAuth } from "./fxAnchor.js";

// Isracard's provisional ILS for a €20 charge, purchased 2026-07-03.
const fxIncoming = {
  originalCurrency: "EUR",
  chargedAmount: -61.14, // ₪61.14
  matchDate: "2026-07-03",
};

describe("anchorFxAmount", () => {
  it("(a) anchors to the lone in-window FIBI auth and reports the ratio", () => {
    const auths: FibiAuth[] = [{ amountMinor: -6358, date: "2026-07-03" }];
    const res = anchorFxAmount(fxIncoming, auths);
    expect(res.amountMinor).toBe(-6358); // FIBI's re-quoted ILS
    expect(res.consumedIndex).toBe(0);
    expect(res.outcome).toBe("anchored");
    // ratio = 63.58 / 61.14 ≈ 1.0399 (the ~4% spread we're instrumenting)
    expect(res.ratio!.toFixed(4)).toBe("1.0399");
    expect(res.candidateMinor).toBe(-6358);
  });

  it("(b) does NOT anchor when two in-window auths are ambiguous (both implausible)", () => {
    const auths: FibiAuth[] = [
      { amountMinor: -9000, date: "2026-07-02" }, // ratio 1.47, out of band, far
      { amountMinor: -3000, date: "2026-07-04" }, // ratio 0.49, out of band, far
    ];
    const res = anchorFxAmount(fxIncoming, auths);
    expect(res.amountMinor).toBe(-6114); // unchanged Isracard estimate
    expect(res.consumedIndex).toBeNull();
    expect(res.outcome).toBe("ambiguous-skipped");
    expect(res.ratio).not.toBeNull(); // nearest candidate's ratio is still reported
  });

  it("(c) never anchors a domestic (ILS) charge", () => {
    const auths: FibiAuth[] = [{ amountMinor: -6358, date: "2026-07-03" }];
    const res = anchorFxAmount(
      { originalCurrency: "ILS", chargedAmount: -130, matchDate: "2026-07-03" },
      auths,
    );
    expect(res.amountMinor).toBe(-13000);
    expect(res.consumedIndex).toBeNull();
    expect(res.outcome).toBe("not-fx");
  });

  it("reports no-candidate when the only auth is outside the ±4 day window", () => {
    const auths: FibiAuth[] = [{ amountMinor: -6358, date: "2026-07-20" }];
    const res = anchorFxAmount(fxIncoming, auths);
    expect(res.amountMinor).toBe(-6114);
    expect(res.consumedIndex).toBeNull();
    expect(res.outcome).toBe("no-candidate");
    expect(res.ratio).toBeNull();
  });

  it("prefers a single in-band candidate over a marginally-NEARER out-of-band one", () => {
    const auths: FibiAuth[] = [
      { amountMinor: -6358, date: "2026-07-03" }, // ratio 1.0399 in-band, Δ244
      { amountMinor: -5900, date: "2026-07-03" }, // ratio 0.9650 out-of-band, Δ214 (nearer)
    ];
    const res = anchorFxAmount(fxIncoming, auths);
    expect(res.consumedIndex).toBe(0); // the in-band one, despite -5900 being nearer
    expect(res.amountMinor).toBe(-6358);
    expect(res.outcome).toBe("anchored");
  });

  it("with several in-band candidates, falls back to nearest absolute; out-of-band never chosen", () => {
    const auths: FibiAuth[] = [
      { amountMinor: -6358, date: "2026-07-03" }, // 1.0399 in-band, Δ244
      { amountMinor: -6200, date: "2026-07-03" }, // 1.0140 in-band, Δ86 (nearest)
      { amountMinor: -9000, date: "2026-07-03" }, // 1.4720 out-of-band
    ];
    const res = anchorFxAmount(fxIncoming, auths);
    expect(res.amountMinor).toBe(-6200); // documented ordering: nearest among in-band
    expect(res.consumedIndex).toBe(1);
    expect(res.candidateMinor).not.toBe(-9000); // out-of-band never chosen
  });

  it("does not anchor when the nearest is outside the 15% tolerance", () => {
    const auths: FibiAuth[] = [
      { amountMinor: -8000, date: "2026-07-03" }, // ratio 1.308 out, Δ~31%
      { amountMinor: -9000, date: "2026-07-03" }, // ratio 1.472 out
    ];
    const res = anchorFxAmount(fxIncoming, auths);
    expect(res.consumedIndex).toBeNull();
    expect(res.amountMinor).toBe(-6114);
    expect(res.outcome).toBe("ambiguous-skipped");
  });

  it("breaks an equal-distance pair toward the plausible-spread (in-band) candidate", () => {
    // Symmetric around ₪61.14: the below-cost one is implausible (ratio < 1),
    // the above-cost one matches FIBI's positive spread -> band picks it.
    const auths: FibiAuth[] = [
      { amountMinor: -6000, date: "2026-07-03" }, // ratio 0.9814 out-of-band, Δ114
      { amountMinor: -6228, date: "2026-07-03" }, // ratio 1.0186 in-band, Δ114
    ];
    const res = anchorFxAmount(fxIncoming, auths);
    expect(res.consumedIndex).toBe(1);
    expect(res.amountMinor).toBe(-6228);
  });
});

describe("assignFxAnchors (global best-pair)", () => {
  // The live regression: a single ₪63.58 FIBI hold sits within tolerance of BOTH
  // Google (₪57.58, 10.4%) and Upstash (₪61.21, 3.9%). Per-charge greedy in list
  // order let Google (seen first) grab it; the hold actually belongs to Upstash.
  const google = {
    originalCurrency: "EUR",
    chargedAmount: -57.58,
    matchDate: "2026-08-01",
  };
  const upstash = {
    originalCurrency: "USD",
    chargedAmount: -61.21,
    matchDate: "2026-08-03",
  };

  it("assigns the shared ₪63.58 hold to the nearer charge (Upstash), not the first-listed (Google)", () => {
    const auths: FibiAuth[] = [
      { amountMinor: 340, date: "2026-08-02" },
      { amountMinor: -340, date: "2026-08-02" },
      { amountMinor: -6358, date: "2026-08-03" }, // the contested hold
    ];
    const [g, u] = assignFxAnchors([google, upstash], auths);
    // Upstash wins the ₪63.58 hold (in-band 1.039, nearest).
    expect(u.amountMinor).toBe(-6358);
    expect(u.outcome).toBe("anchored");
    // Google gets nothing (its real auth already released on settlement).
    expect(g.consumedAuthIndex).toBeNull();
    expect(g.amountMinor).toBe(-5758); // keeps Isracard's settled amount
  });

  it("is order-independent — Upstash still wins when it is listed first", () => {
    const auths: FibiAuth[] = [{ amountMinor: -6358, date: "2026-08-03" }];
    const [u, g] = assignFxAnchors([upstash, google], auths);
    expect(u.amountMinor).toBe(-6358);
    expect(g.consumedAuthIndex).toBeNull();
  });

  it("never assigns one hold to two charges", () => {
    const auths: FibiAuth[] = [{ amountMinor: -6358, date: "2026-08-03" }];
    const res = assignFxAnchors([google, upstash], auths);
    const consumed = res
      .map((r) => r.consumedAuthIndex)
      .filter((i) => i !== null);
    expect(consumed).toEqual([...new Set(consumed)]); // no duplicate index
    expect(consumed).toHaveLength(1);
  });

  it("gives each charge its own hold when both are genuinely in flight", () => {
    const auths: FibiAuth[] = [
      { amountMinor: -6358, date: "2026-08-03" }, // Upstash
      { amountMinor: -5990, date: "2026-08-01" }, // Google, ratio 1.040 in-band
    ];
    const [g, u] = assignFxAnchors([google, upstash], auths);
    expect(u.amountMinor).toBe(-6358);
    expect(g.amountMinor).toBe(-5990);
  });

  it("leaves an ILS (domestic) charge untouched", () => {
    const ils = {
      originalCurrency: "ILS",
      chargedAmount: -100,
      matchDate: "2026-08-03",
    };
    const [r] = assignFxAnchors(
      [ils],
      [{ amountMinor: -10500, date: "2026-08-03" }],
    );
    expect(r.outcome).toBe("not-fx");
    expect(r.consumedAuthIndex).toBeNull();
  });

  it("skips a charge with no in-window hold", () => {
    const [r] = assignFxAnchors(
      [upstash],
      [{ amountMinor: -6358, date: "2026-07-01" }],
    );
    expect(r.outcome).toBe("no-candidate");
    expect(r.amountMinor).toBe(-6121);
  });
});
