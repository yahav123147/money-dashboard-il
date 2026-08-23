// In-app onboarding: validate the wizard's answers, store secrets, write config.
// Pure logic lives here so it can be tested without HTTP. The route in
// app/api/setup/route.js is a thin wrapper.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { saveSecret as defaultSaveSecret, getSecret as defaultGetSecret } from './secrets.mjs';

export const ENTITY_TYPES = {
  patur: { vatRate: 1.0 },
  murshe: { vatRate: 1.18 },
  company: { vatRate: 1.18 },
};

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, j) => writeFileSync(p, JSON.stringify(j, null, 2) + '\n');

function numOrNull(v, { min, max, label }) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label}: מספר בין ${min} ל-${max}`);
  return n;
}

export function validate(body) {
  const b = body || {};
  if (!ENTITY_TYPES[b.entityType]) throw new Error('בחר סוג עסק: עוסק פטור / עוסק מורשה / חברה');
  const advanceRatePct = numOrNull(b.advanceRatePct, { min: 0, max: 50, label: 'שיעור מקדמה' });
  const creditPoints = b.entityType === 'company' ? null
    : numOrNull(b.creditPoints, { min: 0, max: 20, label: 'נקודות זיכוי' });
  const flagThresholdIls = numOrNull(b.flagThresholdIls, { min: 0, max: 10_000_000, label: 'סף התראה' }) ?? 5000;
  // VAT reporting: 1 / 2 months, or null = decide by turnover. Not for patur.
  let vatPeriodMonths = null;
  if (b.entityType !== 'patur' && b.vatPeriodMonths != null && b.vatPeriodMonths !== '' && b.vatPeriodMonths !== 'auto') {
    const n = Number(b.vatPeriodMonths);
    if (n !== 1 && n !== 2) throw new Error('תדירות מע"מ: חודשי, דו-חודשי או אוטומטי');
    vatPeriodMonths = n;
  }
  const vatDueDay = numOrNull(b.vatDueDay, { min: 1, max: 28, label: 'יום דיווח מע"מ' }) ?? 15;

  const f = b.financy || {};
  const financy = { clientId: String(f.clientId || '').trim(), clientSecret: String(f.clientSecret || '').trim(), userId: String(f.userId || '').trim() };
  const financyGiven = financy.clientId || financy.clientSecret || financy.userId;
  if (financyGiven && !(financy.clientId && financy.clientSecret && financy.userId)) {
    throw new Error('Financy: צריך את שלושת המפתחות (client id, client secret, user id)');
  }
  const c = b.cardcom || {};
  const cardcom = { apiName: String(c.apiName || '').trim(), apiPassword: String(c.apiPassword || '').trim() };
  const cardcomGiven = cardcom.apiName || cardcom.apiPassword;
  if (cardcomGiven && !(cardcom.apiName && cardcom.apiPassword)) {
    throw new Error('קארדקום: צריך שם משתמש API וסיסמה');
  }
  const productFieldId = numOrNull(c.productFieldId, { min: 1, max: 999, label: 'שדה מוצר' }) ?? 24;

  return {
    entityType: b.entityType,
    advanceRatePct, creditPoints, flagThresholdIls, vatPeriodMonths, vatDueDay,
    financy: financyGiven ? financy : null,
    cardcom: cardcomGiven ? { ...cardcom, productFieldId } : null,
  };
}

// Writes config + secrets. Returns what was stored (never the secret values).
export function applySetup(body, { root, saveSecret = defaultSaveSecret } = {}) {
  const a = validate(body);
  const sPath = join(root, 'config', 'settings.json');
  const s = readJson(sPath);
  s.entityType = a.entityType;
  s.vatRate = ENTITY_TYPES[a.entityType].vatRate;
  s.advanceRatePct = a.advanceRatePct;
  s.creditPoints = a.creditPoints;
  s.flagThresholdIls = a.flagThresholdIls;
  s.vatPeriodMonths = a.vatPeriodMonths;
  s.vatDueDay = a.vatDueDay;
  writeJson(sPath, s);

  const stored = { financy: null, cardcom: null };
  if (a.financy) {
    stored.financy = saveSecret('FINANCY_CLIENT_ID', a.financy.clientId);
    saveSecret('FINANCY_CLIENT_SECRET', a.financy.clientSecret);
    saveSecret('FINANCY_USER_ID', a.financy.userId);
  }
  const cPath = join(root, 'config', 'cardcom.json');
  const c = readJson(cPath);
  if (a.cardcom) {
    stored.cardcom = saveSecret('CARDCOM_API_NAME', a.cardcom.apiName);
    saveSecret('CARDCOM_API_PASSWORD', a.cardcom.apiPassword);
    c.enabled = true;
    c.productFieldId = a.cardcom.productFieldId;
  } else {
    c.enabled = false;
  }
  writeJson(cPath, c);
  return { entityType: a.entityType, stored, cardcomEnabled: c.enabled };
}

// What the dashboard needs to decide "show wizard or show data".
export function setupStatus({ root, getSecret = defaultGetSecret } = {}) {
  const s = readJson(join(root, 'config', 'settings.json'));
  let cardcom = { enabled: false };
  try { cardcom = readJson(join(root, 'config', 'cardcom.json')); } catch { /* optional */ }
  return {
    configured: !!s.entityType,
    entityType: s.entityType || null,
    advanceRatePct: s.advanceRatePct ?? null,
    creditPoints: s.creditPoints ?? null,
    flagThresholdIls: s.flagThresholdIls ?? 5000,
    vatPeriodMonths: s.vatPeriodMonths ?? null,
    vatDueDay: s.vatDueDay ?? 15,
    hasFinancy: !!(getSecret('FINANCY_CLIENT_ID') && getSecret('FINANCY_CLIENT_SECRET') && getSecret('FINANCY_USER_ID')),
    hasCardcom: !!(getSecret('CARDCOM_API_NAME') && getSecret('CARDCOM_API_PASSWORD')),
    cardcomEnabled: !!cardcom.enabled,
    productFieldId: cardcom.productFieldId ?? 24,
  };
}
