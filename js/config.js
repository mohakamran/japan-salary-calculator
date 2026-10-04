/**
 * Japan Salary Calculator — centralized rates, thresholds and assumptions.
 *
 * EVERY number the calculation uses lives in this file. When Japanese tax or
 * social-insurance rules change, update the values here (and `meta`), then run
 * `node tests/calculator.test.js`. No other file should need to change.
 *
 * Conventions
 *  - Amounts are in yen (JPY). Rates are decimals (0.05 = 5%).
 *  - Bracket tables are ordered ascending; the last row uses `upTo: Infinity`.
 *  - "Total rate" means employer + employee; the employee pays `employeeShare` of it.
 */
(function (root, factory) {
  const config = factory();
  if (typeof module === 'object' && module.exports) module.exports = config;
  else root.JPTaxConfig = config;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  return {
    meta: {
      taxYear: 2026,
      lastReviewed: '2026-10-04',
      sources: [
        { label: 'NTA — Salary income deduction (No.1410)', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1410.htm' },
        { label: 'NTA — Income tax rates (No.2260)', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2260.htm' },
        { label: 'Kyokai Kenpo — FY2026 prefectural rates', url: 'https://www.kyoukaikenpo.or.jp/about/business/insurance_rate/rate_prefectures/r08' },
        { label: 'Japan Pension Service — Employees’ pension rates', url: 'https://www.nenkin.go.jp/service/kounen/hokenryo/ryogaku/ryogakuhyo/index.html' },
        { label: 'MHLW — FY2026 employment insurance rates', url: 'https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/0000108634.html' },
      ],
    },

    /* ------------------------------------------------------------------ */
    /* National income tax (所得税) — 2026 tax year (令和8年分)              */
    /* ------------------------------------------------------------------ */
    incomeTax: {
      // 給与所得控除. 2026–2027 include a temporary ¥50,000 top-up to the minimum (¥690,000 → ¥740,000).
      // Each row: deduction = fixed, or salary × rate + plus.
      salaryIncomeDeduction: [
        { upTo: 2200000, fixed: 740000 },
        { upTo: 3600000, rate: 0.30, plus: 80000 },
        { upTo: 6600000, rate: 0.20, plus: 440000 },
        { upTo: 8500000, rate: 0.10, plus: 1100000 },
        { upTo: Infinity, fixed: 1950000 },
      ],

      // 基礎控除 by total income (合計所得金額): ¥620,000 permanent + temporary 2026–2027 additions.
      basicDeduction: [
        { upTo: 4890000, amount: 1040000 },
        { upTo: 6550000, amount: 670000 },
        { upTo: 23500000, amount: 620000 },
        { upTo: 24000000, amount: 480000 },
        { upTo: 24500000, amount: 320000 },
        { upTo: 25000000, amount: 160000 },
        { upTo: Infinity, amount: 0 },
      ],

      // 配偶者控除 (spouse under 70 with low income), keyed by the taxpayer's total income.
      spouseDeduction: [
        { upTo: 9000000, amount: 380000 },
        { upTo: 9500000, amount: 260000 },
        { upTo: 10000000, amount: 130000 },
        { upTo: Infinity, amount: 0 },
      ],

      // 扶養控除 per dependent. general = ages 16–18 & 23–69, specific (特定扶養) = ages 19–22.
      dependentDeduction: { general: 380000, specific: 630000 },

      // Progressive brackets on taxable income: tax = taxable × rate − deduct.
      brackets: [
        { upTo: 1950000, rate: 0.05, deduct: 0 },
        { upTo: 3300000, rate: 0.10, deduct: 97500 },
        { upTo: 6950000, rate: 0.20, deduct: 427500 },
        { upTo: 9000000, rate: 0.23, deduct: 636000 },
        { upTo: 18000000, rate: 0.33, deduct: 1536000 },
        { upTo: 40000000, rate: 0.40, deduct: 2796000 },
        { upTo: Infinity, rate: 0.45, deduct: 4796000 },
      ],

      reconstructionSurtax: 0.021, // 復興特別所得税, through 2037
      taxableIncomeRoundDown: 1000,
      taxRoundDown: 100,
    },

    /* ------------------------------------------------------------------ */
    /* Resident tax (住民税) — FY2026 (令和8年度)                            */
    /* Resident tax is levied on the PREVIOUS year's income, so the tax    */
    /* withheld during June 2026–May 2027 follows 2025-income rules. The   */
    /* calculator assumes last year's salary was similar to this year's.   */
    /* ------------------------------------------------------------------ */
    residentTax: {
      salaryIncomeDeduction: [
        { upTo: 1900000, fixed: 650000 },
        { upTo: 3600000, rate: 0.30, plus: 80000 },
        { upTo: 6600000, rate: 0.20, plus: 440000 },
        { upTo: 8500000, rate: 0.10, plus: 1100000 },
        { upTo: Infinity, fixed: 1950000 },
      ],
      basicDeduction: [
        { upTo: 24000000, amount: 430000 },
        { upTo: 24500000, amount: 290000 },
        { upTo: 25000000, amount: 150000 },
        { upTo: Infinity, amount: 0 },
      ],
      spouseDeduction: [
        { upTo: 9000000, amount: 330000 },
        { upTo: 9500000, amount: 220000 },
        { upTo: 10000000, amount: 110000 },
        { upTo: Infinity, amount: 0 },
      ],
      dependentDeduction: { general: 330000, specific: 450000 },

      incomeLevyRate: 0.10, // 所得割: municipal 6% + prefectural 4% (standard rate; a few cities differ)
      perCapitaLevy: 5000,  // 均等割: municipal ¥3,000 + prefectural ¥1,000 + forest environment tax ¥1,000
      taxableIncomeRoundDown: 1000,
      taxRoundDown: 100,

      // 調整控除: offsets the gap between income-tax and resident-tax personal deductions.
      adjustmentDeduction: {
        rate: 0.05,
        threshold: 2000000,
        minimumBase: 50000,
        maxTotalIncome: 25000000,
        diff: { basic: 50000, spouse: 50000, general: 50000, specific: 180000 },
      },

      // Non-taxable thresholds (Tier-1 municipality standard; e.g. Tokyo 23 wards).
      // Limit = base × (1 + spouse/dependents) + add + (dependentAdd if any dependents).
      exemption: {
        base: 350000,
        add: 100000,
        dependentAddIncomeLevy: 320000,
        dependentAddPerCapita: 210000,
      },
    },

    /* ------------------------------------------------------------------ */
    /* Social insurance (社会保険) — rates from April 2026                    */
    /* ------------------------------------------------------------------ */
    socialInsurance: {
      employeeShare: 0.5,

      // Kyokai Kenpo (協会けんぽ) health insurance total rates by prefecture, FY2026 (from March 2026).
      // Company health-insurance societies (健保組合) set their own rates — users can enter a custom rate.
      healthRatesByPrefecture: {
        hokkaido: 0.1028, aomori: 0.0985, iwate: 0.0951, miyagi: 0.1010, akita: 0.1001,
        yamagata: 0.0975, fukushima: 0.0950, ibaraki: 0.0952, tochigi: 0.0982, gunma: 0.0968,
        saitama: 0.0967, chiba: 0.0973, tokyo: 0.0985, kanagawa: 0.0992, niigata: 0.0921,
        toyama: 0.0959, ishikawa: 0.0970, fukui: 0.0971, yamanashi: 0.0955, nagano: 0.0963,
        gifu: 0.0980, shizuoka: 0.0961, aichi: 0.0993, mie: 0.0977, shiga: 0.0988,
        kyoto: 0.0989, osaka: 0.1013, hyogo: 0.1012, nara: 0.0991, wakayama: 0.1006,
        tottori: 0.0986, shimane: 0.0994, okayama: 0.1005, hiroshima: 0.0978, yamaguchi: 0.1015,
        tokushima: 0.1024, kagawa: 0.1002, ehime: 0.0998, kochi: 0.1005, fukuoka: 0.1011,
        saga: 0.1055, nagasaki: 0.1006, kumamoto: 0.1008, oita: 0.1008, miyazaki: 0.0977,
        kagoshima: 0.1013, okinawa: 0.0944,
      },
      defaultPrefecture: 'tokyo',
      healthMaxAge: 75, // from 75, the Late-Stage Elderly system replaces employee health insurance

      care: { rate: 0.0162, fromAge: 40, untilAge: 65 }, // 介護保険 (age 40–64 via payroll)
      childSupportRate: 0.0023,                          // 子ども・子育て支援金, from April 2026

      pension: { rate: 0.183, maxAge: 70, minStandard: 88000, maxStandard: 650000 }, // 厚生年金

      employmentInsurance: { employeeRate: 0.005 }, // 雇用保険, general business FY2026 (5/1000)

      // Standard monthly remuneration grades (標準報酬月額), health insurance table.
      // Each row: [lower bound of monthly pay, standard amount]. Pension uses the same
      // table clamped to pension.minStandard … pension.maxStandard.
      grades: [
        [0, 58000], [63000, 68000], [73000, 78000], [83000, 88000], [93000, 98000],
        [101000, 104000], [107000, 110000], [114000, 118000], [122000, 126000], [130000, 134000],
        [138000, 142000], [146000, 150000], [155000, 160000], [165000, 170000], [175000, 180000],
        [185000, 190000], [195000, 200000], [210000, 220000], [230000, 240000], [250000, 260000],
        [270000, 280000], [290000, 300000], [310000, 320000], [330000, 340000], [350000, 360000],
        [370000, 380000], [395000, 410000], [425000, 440000], [455000, 470000], [485000, 500000],
        [515000, 530000], [545000, 560000], [575000, 590000], [605000, 620000], [635000, 650000],
        [665000, 680000], [695000, 710000], [730000, 750000], [770000, 790000], [810000, 830000],
        [855000, 880000], [905000, 930000], [955000, 980000], [1005000, 1030000], [1055000, 1090000],
        [1115000, 1150000], [1175000, 1210000], [1235000, 1270000], [1295000, 1330000], [1355000, 1390000],
      ],

      // Bonuses (賞与): contributions use the standard bonus amount (rounded down to ¥1,000).
      bonus: {
        paymentsPerYear: 2,           // assumption: summer + winter
        roundDown: 1000,
        pensionCapPerPayment: 1500000,
        healthCapPerYear: 5730000,
      },

      // Below this monthly pay many part-time workers are not enrolled in employee insurance.
      enrollmentNoticeBelowMonthly: 88000,
    },

    /* ------------------------------------------------------------------ */
    /* Living-cost estimates (monthly, single person) — rough guides only */
    /* ------------------------------------------------------------------ */
    expenses: {
      categories: [
        { key: 'rent', essential: true },
        { key: 'food', essential: true },
        { key: 'transport', essential: true },
        { key: 'utilities', essential: true },
        { key: 'phone', essential: true },
        { key: 'insurance', essential: true },
        { key: 'entertainment', essential: false },
        { key: 'shopping', essential: false },
        { key: 'other', essential: false },
      ],
      defaultPreset: 'tokyo',
      presets: {
        tokyo:    { rent: 85000, food: 45000, transport: 8000,  utilities: 12000, phone: 7000, insurance: 5000, entertainment: 20000, shopping: 15000, other: 10000 },
        bigCity:  { rent: 65000, food: 42000, transport: 7000,  utilities: 12000, phone: 7000, insurance: 5000, entertainment: 18000, shopping: 13000, other: 10000 },
        regional: { rent: 50000, food: 40000, transport: 15000, utilities: 13000, phone: 7000, insurance: 7000, entertainment: 15000, shopping: 12000, other: 10000 },
      },
    },

    /* ------------------------------------------------------------------ */
    /* Input validation limits                                            */
    /* ------------------------------------------------------------------ */
    limits: {
      maxAnnualGross: 500000000,
      minAge: 15,
      maxAge: 99,
      maxDependents: 10,
      maxHealthRate: 0.2,
      maxMonthlyExpense: 10000000,
    },
  };
});
