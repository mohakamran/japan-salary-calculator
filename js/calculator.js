/**
 * Japan Salary Calculator — calculation engine.
 *
 * Pure functions only: no DOM access, no hard-coded rates. Every rate and
 * threshold comes from the config object (see js/config.js), so the same
 * engine runs in the browser and in Node tests.
 *
 * All amounts returned are ANNUAL yen unless the name says otherwise.
 * Monthly figures are annual ÷ 12, so monthly × 12 always equals annual.
 */
(function (root, factory) {
  const engine = factory();
  if (typeof module === 'object' && module.exports) module.exports = engine;
  else root.JPCalculator = engine;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------------------- helpers ---------------------------- */

  const floorTo = (value, unit) => Math.floor(value / unit) * unit;

  /** First row of an ascending `upTo` table that contains `value`. */
  function findRow(table, value) {
    return table.find((row) => value <= row.upTo) || table[table.length - 1];
  }

  function lookupAmount(table, value) {
    return findRow(table, value).amount;
  }

  /** 給与所得控除 from a config table (fixed, or salary × rate + plus). */
  function salaryIncomeDeduction(table, salary) {
    const row = findRow(table, salary);
    const deduction = row.fixed !== undefined ? row.fixed : Math.floor(salary * row.rate + row.plus);
    return Math.min(deduction, salary); // salary income cannot go negative
  }

  /** 標準報酬月額 from the grade table. */
  function standardMonthly(grades, monthlyPay) {
    let standard = grades[0][1];
    for (const [lower, value] of grades) {
      if (monthlyPay >= lower) standard = value;
      else break;
    }
    return standard;
  }

  /* ------------------------ social insurance ----------------------- */

  function calcSocialInsurance(inp, cfg, gross) {
    const si = cfg.socialInsurance;
    const share = si.employeeShare;
    const age = inp.age;

    const healthRate = inp.healthRate;
    const hasHealth = age < si.healthMaxAge;
    const hasCare = hasHealth && age >= si.care.fromAge && age < si.care.untilAge;
    const hasPension = age < si.pension.maxAge;

    const healthStandard = standardMonthly(si.grades, gross.monthlyBase);
    const pensionStandard = Math.min(si.pension.maxStandard, Math.max(si.pension.minStandard, healthStandard));

    // Bonus: split into equal payments, each rounded down to the standard bonus amount.
    const payments = gross.bonus > 0 ? si.bonus.paymentsPerYear : 0;
    const perPayment = payments ? floorTo(gross.bonus / payments, si.bonus.roundDown) : 0;
    const healthBonusBase = Math.min(perPayment * payments, si.bonus.healthCapPerYear);
    const pensionBonusPerPayment = Math.min(perPayment, si.bonus.pensionCapPerPayment);

    // Employee share, rounded to the yen per payroll run.
    const part = (standard, rate) => Math.round(standard * rate * share);
    const annualFrom = (rate, monthlyStd, bonusBase) => part(monthlyStd, rate) * 12 + part(bonusBase, rate);

    const health = hasHealth ? annualFrom(healthRate, healthStandard, healthBonusBase) : 0;
    const care = hasCare ? annualFrom(si.care.rate, healthStandard, healthBonusBase) : 0;
    const childSupport = hasHealth ? annualFrom(si.childSupportRate, healthStandard, healthBonusBase) : 0;
    const pension = hasPension
      ? part(pensionStandard, si.pension.rate) * 12 + part(pensionBonusPerPayment, si.pension.rate) * payments
      : 0;
    const employment = Math.round(gross.annual * si.employmentInsurance.employeeRate);

    return {
      health, care, childSupport, pension, employment,
      total: health + care + childSupport + pension + employment,
      healthStandard, pensionStandard,
      applies: { health: hasHealth, care: hasCare, pension: hasPension },
      rates: {
        health: hasHealth ? healthRate * share : 0,
        care: hasCare ? si.care.rate * share : 0,
        childSupport: hasHealth ? si.childSupportRate * share : 0,
        pension: hasPension ? si.pension.rate * share : 0,
        employment: si.employmentInsurance.employeeRate,
      },
    };
  }

  /* ---------------------- shared personal deductions ---------------------- */

  function personalDeductions(tableSet, inp, totalIncome) {
    const basic = lookupAmount(tableSet.basicDeduction, totalIncome);
    const spouse = inp.spouse ? lookupAmount(tableSet.spouseDeduction, totalIncome) : 0;
    const dependents =
      inp.dependentsGeneral * tableSet.dependentDeduction.general +
      inp.dependentsSpecific * tableSet.dependentDeduction.specific;
    return { basic, spouse, dependents };
  }

  /* ---------------------------- income tax ---------------------------- */

  function calcIncomeTax(inp, cfg, grossAnnual, socialTotal) {
    const t = cfg.incomeTax;
    const salaryDeduction = salaryIncomeDeduction(t.salaryIncomeDeduction, grossAnnual);
    const salaryIncome = grossAnnual - salaryDeduction;
    const personal = personalDeductions(t, inp, salaryIncome);

    const totalDeductions = socialTotal + personal.basic + personal.spouse + personal.dependents + inp.otherDeductions;
    const taxableIncome = floorTo(Math.max(0, salaryIncome - totalDeductions), t.taxableIncomeRoundDown);

    const bracket = findRow(t.brackets, taxableIncome);
    const baseTax = Math.max(0, Math.floor(taxableIncome * bracket.rate - bracket.deduct));
    const total = floorTo(baseTax * (1 + t.reconstructionSurtax), t.taxRoundDown);

    return {
      salaryDeduction, salaryIncome,
      basicDeduction: personal.basic,
      spouseDeduction: personal.spouse,
      dependentDeduction: personal.dependents,
      socialInsuranceDeduction: socialTotal,
      otherDeductions: inp.otherDeductions,
      taxableIncome,
      marginalRate: taxableIncome > 0 ? bracket.rate : 0,
      baseTax,
      surtax: total - baseTax,
      total,
    };
  }

  /* --------------------------- resident tax --------------------------- */

  function calcResidentTax(inp, cfg, grossAnnual, socialTotal) {
    const r = cfg.residentTax;
    const salaryDeduction = salaryIncomeDeduction(r.salaryIncomeDeduction, grossAnnual);
    const salaryIncome = grossAnnual - salaryDeduction;
    const household = (inp.spouse ? 1 : 0) + inp.dependentsGeneral + inp.dependentsSpecific;

    const base = {
      salaryDeduction, salaryIncome,
      basicDeduction: 0, spouseDeduction: 0, dependentDeduction: 0,
      taxableIncome: 0, incomeLevy: 0, adjustment: 0, perCapita: 0, total: 0,
      included: inp.includeResidentTax, exempt: false,
    };
    if (!inp.includeResidentTax) return base;

    const ex = r.exemption;
    const limitFor = (dependentAdd) => ex.base * (1 + household) + ex.add + (household > 0 ? dependentAdd : 0);
    const exemptIncomeLevy = salaryIncome <= limitFor(ex.dependentAddIncomeLevy);
    const exemptPerCapita = salaryIncome <= limitFor(ex.dependentAddPerCapita);

    const personal = personalDeductions(r, inp, salaryIncome);
    const totalDeductions = socialTotal + personal.basic + personal.spouse + personal.dependents + inp.otherDeductions;
    const taxableIncome = floorTo(Math.max(0, salaryIncome - totalDeductions), r.taxableIncomeRoundDown);

    // 調整控除
    const a = r.adjustmentDeduction;
    const diff = a.diff.basic
      + (personal.spouse > 0 ? a.diff.spouse : 0)
      + inp.dependentsGeneral * a.diff.general
      + inp.dependentsSpecific * a.diff.specific;
    let adjustment = 0;
    if (salaryIncome <= a.maxTotalIncome && taxableIncome > 0) {
      adjustment = taxableIncome <= a.threshold
        ? Math.min(diff, taxableIncome) * a.rate
        : Math.max(diff - (taxableIncome - a.threshold), a.minimumBase) * a.rate;
    }

    const gross = Math.floor(taxableIncome * r.incomeLevyRate);
    adjustment = Math.min(Math.floor(adjustment), gross);
    const incomeLevy = exemptIncomeLevy ? 0 : floorTo(gross - adjustment, r.taxRoundDown);
    const perCapita = exemptPerCapita ? 0 : r.perCapitaLevy;

    return Object.assign(base, {
      basicDeduction: personal.basic,
      spouseDeduction: personal.spouse,
      dependentDeduction: personal.dependents,
      taxableIncome,
      incomeLevy,
      adjustment: exemptIncomeLevy ? 0 : adjustment,
      perCapita,
      total: incomeLevy + perCapita,
      exempt: exemptIncomeLevy && exemptPerCapita,
    });
  }

  /* ----------------------------- budget ----------------------------- */

  function calcBudget(cfg, expenses, netAnnual) {
    const items = cfg.expenses.categories.map((cat) => ({
      key: cat.key,
      essential: cat.essential,
      monthly: Math.max(0, Number(expenses[cat.key]) || 0),
    }));
    const monthlyTotal = items.reduce((sum, it) => sum + it.monthly, 0);
    const essentialMonthly = items.filter((it) => it.essential).reduce((sum, it) => sum + it.monthly, 0);
    const netMonthly = netAnnual / 12;
    const savingsMonthly = netMonthly - monthlyTotal;

    return {
      items,
      monthlyTotal,
      annualTotal: monthlyTotal * 12,
      essentialMonthly,
      discretionaryMonthly: monthlyTotal - essentialMonthly,
      leftAfterEssentialsMonthly: netMonthly - essentialMonthly,
      savingsMonthly,
      savingsAnnual: netAnnual - monthlyTotal * 12,
      savingsRate: netMonthly > 0 ? savingsMonthly / netMonthly : 0,
    };
  }

  /* ---------------------------- main entry ---------------------------- */

  /**
   * Normalise raw inputs and fill defaults.
   *  salaryPeriod 'monthly': annual gross = amount × 12 + bonus
   *  salaryPeriod 'annual' : annual gross = amount (bonus is INCLUDED in it, Japanese 年収 convention)
   */
  function normalizeInputs(raw, cfg) {
    const si = cfg.socialInsurance;
    const prefecture = raw.prefecture || si.defaultPrefecture;
    const healthRate = prefecture === 'custom'
      ? Number(raw.customHealthRate) || 0
      : si.healthRatesByPrefecture[prefecture] ?? si.healthRatesByPrefecture[si.defaultPrefecture];
    const int = (v) => Math.max(0, Math.floor(Number(v) || 0));

    return {
      salaryAmount: Math.max(0, Number(raw.salaryAmount) || 0),
      salaryPeriod: raw.salaryPeriod === 'monthly' ? 'monthly' : 'annual',
      bonus: Math.max(0, Number(raw.bonus) || 0),
      age: raw.age === undefined || raw.age === '' ? 30 : int(raw.age),
      prefecture,
      healthRate,
      spouse: Boolean(raw.spouse),
      dependentsGeneral: int(raw.dependentsGeneral),
      dependentsSpecific: int(raw.dependentsSpecific),
      otherDeductions: Math.max(0, Number(raw.otherDeductions) || 0),
      includeResidentTax: raw.includeResidentTax !== false,
      expenses: raw.expenses || cfg.expenses.presets[cfg.expenses.defaultPreset],
    };
  }

  function calculate(rawInputs, cfg) {
    const inp = normalizeInputs(rawInputs, cfg);

    const annual = inp.salaryPeriod === 'monthly' ? inp.salaryAmount * 12 + inp.bonus : inp.salaryAmount;
    const bonus = Math.min(inp.bonus, annual);
    const gross = { annual, bonus, monthlyBase: (annual - bonus) / 12, monthlyAverage: annual / 12 };

    const social = calcSocialInsurance(inp, cfg, gross);
    const incomeTax = calcIncomeTax(inp, cfg, annual, social.total);
    const residentTax = calcResidentTax(inp, cfg, annual, social.total);

    const taxes = incomeTax.total + residentTax.total;
    const deductions = taxes + social.total;
    const net = annual - deductions;
    const pct = (v) => (annual > 0 ? v / annual : 0);

    const notes = [];
    if (gross.monthlyBase < cfg.socialInsurance.enrollmentNoticeBelowMonthly) notes.push('lowIncomeEnrollment');
    if (!social.applies.health) notes.push('lateStageElderly');
    if (inp.age >= cfg.socialInsurance.care.untilAge && social.applies.health) notes.push('careViaPension');
    if (!social.applies.pension) notes.push('noPension');
    if (bonus > 0) notes.push('bonusAveraged');
    if (!inp.includeResidentTax) notes.push('residentTaxExcluded');
    if (residentTax.exempt) notes.push('residentTaxExempt');

    return {
      inputs: inp,
      gross,
      socialInsurance: social,
      incomeTax,
      residentTax,
      totals: {
        taxes,
        socialInsurance: social.total,
        deductions,
        net,
        deductionRate: pct(deductions),
        taxRate: pct(taxes),
        socialRate: pct(social.total),
      },
      percentOfGross: pct,
      budget: calcBudget(cfg, inp.expenses, net),
      notes,
    };
  }

  /**
   * Run the calculation across a range of annual salaries with the same
   * personal settings (bonus kept as the same share of gross).
   */
  function sweep(rawInputs, cfg, from, to, step) {
    const inp = normalizeInputs(rawInputs, cfg);
    const baseAnnual = inp.salaryPeriod === 'monthly' ? inp.salaryAmount * 12 + inp.bonus : inp.salaryAmount;
    const bonusShare = baseAnnual > 0 ? Math.min(inp.bonus, baseAnnual) / baseAnnual : 0;
    const points = [];
    for (let annual = from; annual <= to; annual += step) {
      const r = calculate(Object.assign({}, rawInputs, {
        salaryPeriod: 'annual', salaryAmount: annual, bonus: Math.round(annual * bonusShare),
      }), cfg);
      points.push({ gross: annual, net: r.totals.net, deductionRate: r.totals.deductionRate, taxRate: r.totals.taxRate, socialRate: r.totals.socialRate });
    }
    return points;
  }

  return {
    calculate,
    sweep,
    normalizeInputs,
    // exposed for tests / transparency
    _internal: { salaryIncomeDeduction, standardMonthly, lookupAmount, findRow },
  };
});
