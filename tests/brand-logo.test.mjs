import test from 'node:test';
import assert from 'node:assert/strict';
import { BRAND_LOGO_COMBOS, pickBrandLogo } from '../public/app.js';

test('brand logo: every combo is 2-3 emojis and unique', () => {
  assert.ok(BRAND_LOGO_COMBOS.length >= 8);
  assert.equal(new Set(BRAND_LOGO_COMBOS).size, BRAND_LOGO_COMBOS.length);
  for (const c of BRAND_LOGO_COMBOS) {
    const n = (c.match(/\p{Extended_Pictographic}/gu) || []).length;
    assert.ok(n >= 2 && n <= 3, `${c} has ${n} emojis`);
  }
});

test('brand logo: never repeats the previous load, handles any rand value', () => {
  for (const prev of [null, ...BRAND_LOGO_COMBOS]) {
    for (const r of [0, 0.25, 0.5, 0.999999, 1]) {
      const pick = pickBrandLogo(prev, () => r);
      assert.ok(BRAND_LOGO_COMBOS.includes(pick));
      assert.notEqual(pick, prev);
    }
  }
});
