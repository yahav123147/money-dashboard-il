// Tax engines: annual taxable income -> estimated tax, per entity type.
// Every figure comes from config/tax-brackets.json — no rate, threshold or
// credit value lives in this file. The engine reports what it deliberately
// does NOT compute in `notes`; silence is how estimates become lies.
//
// Scope, stated plainly:
// - Income-tax advances (מקדמות) cover income tax only. National-insurance
//   advances are a separate track paid to ביטוח לאומי — the caller must not
//   fold them into the advance-rate figure, only display them alongside.
// - Section 47א (52% of the NI contribution deductible from taxable income)
//   is NOT implemented: the figure was not researched to this project's
//   sourcing standard. Omitting it overstates tax slightly — the safe
//   direction for advance planning — and the note says so.

// Progressive brackets + surtax on annual income from personal exertion.
export function bracketIncomeTax(annual, cfg) {
  const a = Number(annual);
  if (!Number.isFinite(a) || a <= 0) return 0;
  let tax = 0;
  let prev = 0;
  for (const b of cfg.incomeTax.brackets) {
    const cap = b.upToAnnual == null ? Infinity : b.upToAnnual;
    if (a > prev) tax += (Math.min(a, cap) - prev) * b.rate;
    prev = cap;
    if (a <= cap) break;
  }
  const s = cfg.incomeTax.surtax;
  if (s && a > s.annualThreshold) tax += (a - s.annualThreshold) * s.rate;
  return Math.round(tax * 100) / 100;
}

// Self-employed national + health insurance for ONE month of income.
// Two tiers, a minimum floor for earners, and a ceiling above which income
// is exempt. Returns the NI/health split because the two behave differently
// downstream (47א applies to NI only, if it is ever implemented).
export function selfEmployedBtlMonthly(monthly, cfg) {
  const n = cfg.nationalInsurance.selfEmployed;
  const m0 = Number(monthly);
  if (!Number.isFinite(m0) || m0 <= 0) {
    return { nationalInsurance: 0, healthInsurance: 0, combined: 0 };
  }
  const m = Math.max(m0, n.minimumMonthlyIncome);
  const capped = Math.min(m, n.full.upToMonthly);
  const reducedPart = Math.min(capped, n.reduced.upToMonthly);
  const fullPart = Math.max(0, capped - n.reduced.upToMonthly);
  const ni = reducedPart * n.reduced.nationalInsurance + fullPart * n.full.nationalInsurance;
  const health = reducedPart * n.reduced.healthInsurance + fullPart * n.full.healthInsurance;
  return { nationalInsurance: ni, healthInsurance: health, combined: ni + health };
}

// The one entry point callers use.
// estimateTax(entityType, annualTaxable, cfg, {creditPoints}) ->
//   { incomeTax, nationalInsurance, healthInsurance, combinedBtl, total,
//     creditPointsUsed, notes: string[] }
export function estimateTax(entityType, annualTaxable, cfg, { creditPoints = null } = {}) {
  const notes = [];
  const a = Math.max(0, Number(annualTaxable) || 0);

  if (entityType === 'company') {
    const incomeTax = Math.round(a * cfg.company.corporateTaxRate);
    notes.push('מס חברות בלבד. משיכת הרווח כדיבידנד ממוסה בנפרד (25%/30%) ואינה כלולה כאן.');
    return {
      incomeTax, nationalInsurance: 0, healthInsurance: 0, combinedBtl: 0,
      total: incomeTax, creditPointsUsed: null, notes,
    };
  }

  // Individual (patur/murshe): brackets − credits, plus self-employed BTL.
  let points = creditPoints;
  if (points == null) {
    points = cfg.creditPoint.minimumResidentPoints;
    notes.push(`לא הוגדרו נקודות זיכוי — חושב לפי מינימום תושב ${points}. ייתכן שמגיע לך יותר (אישה, ילדים, שירות ועוד) — עדכן ב-/setup.`);
  }
  const gross = bracketIncomeTax(a, cfg);
  const credit = points * cfg.creditPoint.annual;
  const incomeTax = Math.round(Math.max(0, gross - credit));
  if (gross > 0 && gross <= credit) {
    notes.push('נקודות הזיכוי מכסות את כל מס ההכנסה בהכנסה הזו.');
  }

  const btlMonthly = selfEmployedBtlMonthly(a / 12, cfg);
  const nationalInsurance = Math.round(btlMonthly.nationalInsurance * 12);
  const healthInsurance = Math.round(btlMonthly.healthInsurance * 12);
  const combinedBtl = nationalInsurance + healthInsurance;

  notes.push('ניכוי 52% מדמי הביטוח הלאומי מההכנסה החייבת (סעיף 47א) אינו מחושב — ההערכה מחמירה מעט. רו"ח מיישם אותו בדוח.');
  notes.push('דמי ביטוח לאומי נגבים במקדמות נפרדות של ביטוח לאומי — הם אינם חלק ממקדמות מס ההכנסה.');

  return {
    incomeTax, nationalInsurance, healthInsurance, combinedBtl,
    total: incomeTax + combinedBtl, creditPointsUsed: points, notes,
  };
}
