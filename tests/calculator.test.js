/**
 * Calculation tests — run with:  node --test tests/
 * No dependencies; uses Node's built-in test runner (Node 18+).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const CFG = require('../js/config.js');
const { calculate, sweep, _internal } = require('../js/calculator.js');

const annual = (amount, extra = {}) => calculate(Object.assign({ salaryAmount: amount, salaryPeriod: 'annual', age: 30 }, extra), CFG);

test('¥5,000,000 single, age 30, Tokyo — hand-verified figures', () => {
  const r = annual(5000000);
  // monthly 416,667 → standard monthly remuneration ¥410,000
  assert.equal(r.socialInsurance.healthStandard, 410000);
  assert.equal(r.socialInsurance.health, 20193 * 12);       // 410,000 × 9.85% ÷ 2
  assert.equal(r.socialInsurance.pension, 37515 * 12);      // 410,000 × 18.3% ÷ 2
  assert.equal(r.socialInsurance.childSupport, 472 * 12);   // 410,000 × 0.23% ÷ 2
  assert.equal(r.socialInsurance.employment, 25000);        // 5,000,000 × 0.5%
  assert.equal(r.socialInsurance.care, 0);
  // income tax: 3,560,000 − 723,160 − 1,040,000 → 1,796,000 × 5% × 1.021
  assert.equal(r.incomeTax.salaryIncome, 3560000);
  assert.equal(r.incomeTax.taxableIncome, 1796000);
  assert.equal(r.incomeTax.total, 91600);
  // resident tax: 3,560,000 − 723,160 − 430,000 → 2,406,000 × 10% − 2,500 + 5,000
  assert.equal(r.residentTax.taxableIncome, 2406000);
  assert.equal(r.residentTax.total, 243100);
  assert.equal(r.totals.net, 5000000 - 723160 - 91600 - 243100);
});

test('¥8,000,000 — pension capped at ¥650,000 standard; 20% bracket', () => {
  const r = annual(8000000);
  assert.equal(r.socialInsurance.healthStandard, 680000);
  assert.equal(r.socialInsurance.pensionStandard, 650000);
  assert.equal(r.socialInsurance.pension, 59475 * 12);
  assert.equal(r.incomeTax.basicDeduction, 670000);
  assert.equal(r.incomeTax.taxableIncome, 4265000);
  assert.equal(r.incomeTax.total, 434400);
  assert.equal(r.residentTax.total, 453000);
});

test('monthly and annual input give identical results', () => {
  const m = calculate({ salaryAmount: 400000, salaryPeriod: 'monthly', age: 30 }, CFG);
  const a = annual(4800000);
  assert.deepEqual(m.totals, a.totals);

  const mb = calculate({ salaryAmount: 300000, salaryPeriod: 'monthly', bonus: 1000000, age: 30 }, CFG);
  const ab = annual(4600000, { bonus: 1000000 });
  assert.deepEqual(mb.totals, ab.totals);
  assert.equal(mb.gross.monthlyBase, 300000);
});

test('internal consistency across salary levels', () => {
  let prevNet = -Infinity;
  for (let gross = 1000000; gross <= 50000000; gross += 250000) {
    for (const extra of [{}, { bonus: Math.round(gross * 0.2) }, { age: 45, spouse: true, dependentsGeneral: 1 }]) {
      const r = annual(gross, extra);
      const si = r.socialInsurance;
      const T = r.totals;
      assert.equal(si.total, si.health + si.care + si.childSupport + si.pension + si.employment, `SI sum @${gross}`);
      assert.equal(T.taxes, r.incomeTax.total + r.residentTax.total);
      assert.equal(T.deductions, T.taxes + T.socialInsurance);
      assert.equal(T.net, gross - T.deductions);
      assert.ok(Math.abs(T.deductionRate - (T.taxRate + T.socialRate)) < 1e-12);
      for (const v of [si.health, si.pension, si.employment, r.incomeTax.total, r.residentTax.total]) {
        assert.ok(v >= 0 && Number.isFinite(v), `non-negative @${gross}`);
      }
      assert.ok(T.net > 0 && T.net < gross);

      const B = r.budget;
      assert.ok(Math.abs(B.savingsMonthly * 12 - B.savingsAnnual) < 1e-6, 'monthly × 12 = annual savings');
      assert.ok(Math.abs(B.savingsMonthly - (T.net / 12 - B.monthlyTotal)) < 1e-6);
      assert.equal(B.monthlyTotal, B.essentialMonthly + B.discretionaryMonthly);
      assert.equal(B.annualTotal, B.monthlyTotal * 12);
    }
    const net = annual(gross).totals.net;
    assert.ok(net > prevNet, `take-home rises with gross (@${gross})`);
    prevNet = net;
  }
});

test('salary income deduction tables are continuous at bracket edges', () => {
  for (const table of [CFG.incomeTax.salaryIncomeDeduction, CFG.residentTax.salaryIncomeDeduction]) {
    for (const row of table.slice(0, -1)) {
      const at = _internal.salaryIncomeDeduction(table, row.upTo);
      const after = _internal.salaryIncomeDeduction(table, row.upTo + 1);
      assert.ok(Math.abs(after - at) <= 1, `jump at ${row.upTo}: ${at} → ${after}`);
    }
  }
});

test('2026 “¥1.78M wall”: no income tax at ¥1,780,000 salary', () => {
  assert.equal(annual(1780000).incomeTax.total, 0);
  assert.equal(annual(1780000).incomeTax.salaryDeduction, 740000);
});

test('age rules: care 40–64, no pension from 70, no health from 75', () => {
  assert.equal(annual(5000000, { age: 39 }).socialInsurance.care, 0);
  assert.ok(annual(5000000, { age: 40 }).socialInsurance.care > 0);
  assert.equal(annual(5000000, { age: 65 }).socialInsurance.care, 0);
  assert.equal(annual(5000000, { age: 70 }).socialInsurance.pension, 0);
  const r75 = annual(5000000, { age: 75 });
  assert.equal(r75.socialInsurance.health, 0);
  assert.ok(r75.notes.includes('lateStageElderly'));
});

test('dependents and spouse reduce both taxes', () => {
  const base = annual(6000000);
  const fam = annual(6000000, { spouse: true, dependentsGeneral: 1, dependentsSpecific: 1 });
  assert.ok(fam.incomeTax.total < base.incomeTax.total);
  assert.ok(fam.residentTax.total < base.residentTax.total);
  assert.equal(fam.incomeTax.spouseDeduction, 380000);
  assert.equal(fam.incomeTax.dependentDeduction, 380000 + 630000);
});

test('resident tax can be excluded (first year in Japan)', () => {
  const r = annual(5000000, { includeResidentTax: false });
  assert.equal(r.residentTax.total, 0);
  assert.equal(r.totals.net, annual(5000000).totals.net + 243100);
});

test('custom health rate and prefecture selection', () => {
  const custom = annual(5000000, { prefecture: 'custom', customHealthRate: 0.08 });
  assert.equal(custom.socialInsurance.health, Math.round(410000 * 0.08 * 0.5) * 12);
  const osaka = annual(5000000, { prefecture: 'osaka' });
  assert.ok(osaka.socialInsurance.health > annual(5000000).socialInsurance.health);
});

test('bonus social insurance uses standard bonus and pension cap', () => {
  const r = annual(20000000, { bonus: 6000000 }); // 2 × ¥3M bonuses
  const pensionPerBonus = Math.round(1500000 * 0.183 * 0.5);
  assert.equal(r.socialInsurance.pension, 59475 * 12 + pensionPerBonus * 2);
  const healthBonusBase = 5730000; // annual cap
  assert.equal(r.socialInsurance.health, Math.round(1150000 * 0.0985 * 0.5) * 12 + Math.round(healthBonusBase * 0.0985 * 0.5));
});

test('very low income is exempt from resident tax', () => {
  const r = annual(1000000);
  assert.equal(r.residentTax.total, 0);
  assert.ok(r.notes.includes('residentTaxExempt'));
  assert.ok(r.notes.includes('lowIncomeEnrollment'));
});

test('standard monthly remuneration lookup edges', () => {
  const g = CFG.socialInsurance.grades;
  assert.equal(_internal.standardMonthly(g, 0), 58000);
  assert.equal(_internal.standardMonthly(g, 62999), 58000);
  assert.equal(_internal.standardMonthly(g, 63000), 68000);
  assert.equal(_internal.standardMonthly(g, 5000000), 1390000);
});

test('sweep returns monotonic gross and sane rates', () => {
  const pts = sweep({ salaryAmount: 5000000, salaryPeriod: 'annual', age: 30 }, CFG, 2000000, 20000000, 500000);
  assert.equal(pts.length, 37);
  pts.forEach((p) => assert.ok(p.deductionRate > 0.1 && p.deductionRate < 0.5));
});

test('printable summary for multiple salary levels', () => {
  const rows = [3e6, 4e6, 5e6, 6e6, 8e6, 10e6, 15e6].map((g) => {
    const r = annual(g);
    return { gross: g, incomeTax: r.incomeTax.total, residentTax: r.residentTax.total, social: r.totals.socialInsurance, net: r.totals.net, netMonthly: Math.round(r.totals.net / 12), rate: (r.totals.deductionRate * 100).toFixed(1) + '%' };
  });
  console.table(rows);
});
