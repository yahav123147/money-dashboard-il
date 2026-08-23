import test from 'node:test';
import assert from 'node:assert/strict';
import { hasHeadings } from '../lib/agent-run.mjs';

const H = ['### השורה התחתונה', '### מה נראה לא נכון', '### מה לתקן', '### שאלות לבעל העסק'];

test('hasHeadings: each heading on its own line, in order', () => {
  assert.equal(hasHeadings('### השורה התחתונה\nטקסט\n### מה נראה לא נכון\n- א\n### מה לתקן\n- ב\n### שאלות לבעל העסק\nאין.', H), true);
  assert.equal(hasHeadings('הכותרות הן ### השורה התחתונה ### מה נראה לא נכון ### מה לתקן ### שאלות לבעל העסק בשורה אחת', H), false, 'mentions are not headings');
  assert.equal(hasHeadings('### מה לתקן\n### השורה התחתונה\n### מה נראה לא נכון\n### שאלות לבעל העסק', H), false, 'wrong order');
  assert.equal(hasHeadings('### השורה התחתונה\n### מה נראה לא נכון\n### מה לתקן', H), false, 'missing one');
});
