/**
 * UI controller: reads the form, validates, calls JPCalculator.calculate()
 * and renders results. Contains no tax logic — see calculator.js / config.js.
 */
(function () {
  'use strict';

  const CFG = window.JPTaxConfig;
  const Calc = window.JPCalculator;
  const { t } = window.I18n;
  const { renderFlow, renderBarList, renderCurve, escapeHtml } = window.Charts;

  const STORAGE_KEY = 'jp-salary-calc-v1';
  const $ = (id) => document.getElementById(id);
  const form = $('calc-form');

  /* ------------------------------ state ------------------------------ */

  function defaultState() {
    const preset = CFG.expenses.defaultPreset;
    return {
      salary: '5000000',
      period: 'annual',
      bonus: '',
      age: '30',
      prefecture: CFG.socialInsurance.defaultPrefecture,
      customRate: '',
      spouse: false,
      depGeneral: '0',
      depSpecific: '0',
      other: '',
      resident: true,
      advancedOpen: false,
      preset,
      expenses: toStrings(CFG.expenses.presets[preset]),
      expensesCustom: false,
      view: 'monthly',
    };
  }

  function toStrings(obj) {
    const out = {};
    for (const k in obj) out[k] = String(obj[k]);
    return out;
  }

  const storage = {
    load() {
      try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (e) { return null; }
    },
    save(data) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) { /* storage unavailable */ }
    },
  };

  const saved = storage.load() || {};
  let state = Object.assign(defaultState(), saved.state || {});
  let lang = saved.lang || ((navigator.language || '').toLowerCase().startsWith('ja') ? 'ja' : 'en');
  let theme = saved.theme || null; // null = follow system
  let lastResult = null;

  function persist() {
    storage.save({ state, lang, theme });
  }

  /* ---------------------------- formatting ---------------------------- */

  const yen = (n) => (n < 0 ? '−¥' : '¥') + Math.abs(Math.round(n)).toLocaleString('ja-JP');
  const pct = (n, digits = 1) => (n * 100).toFixed(digits) + '%';
  const groupDigits = (n) => Math.round(n).toLocaleString('ja-JP');

  function shortYen(n) {
    if (lang === 'ja') return (n / 10000).toLocaleString('ja-JP', { maximumFractionDigits: 0 }) + '万';
    return '¥' + (n / 1e6).toLocaleString('en-US', { maximumFractionDigits: 1 }) + 'M';
  }

  /**
   * Parse a yen amount typed by the user. Accepts commas, ¥/円, full-width
   * digits, and the 万 / k / m shorthands ("500万", "5.5m", "300k").
   */
  function parseAmount(raw) {
    let s = String(raw ?? '')
      .replace(/[０-９．，]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/[\s,¥￥円]/g, '')
      .toLowerCase();
    if (s === '') return { empty: true, value: 0 };
    let mult = 1;
    if (/万$/.test(s)) { mult = 10000; s = s.slice(0, -1); }
    else if (/k$/.test(s)) { mult = 1000; s = s.slice(0, -1); }
    else if (/m$/.test(s)) { mult = 1e6; s = s.slice(0, -1); }
    if (!/^-?\d+(\.\d+)?$/.test(s)) return { invalid: true };
    return { value: Number(s) * mult };
  }

  /* ---------------------------- validation ---------------------------- */

  function validate() {
    const L = CFG.limits;
    const errors = {};

    const salary = parseAmount(state.salary);
    const bonus = parseAmount(state.bonus);
    const other = parseAmount(state.other);

    if (salary.empty) errors.salary = t('err.required');
    else if (salary.invalid) errors.salary = t('err.number');
    else if (salary.value <= 0) errors.salary = t('err.positive');
    else {
      const annual = state.period === 'monthly' ? salary.value * 12 : salary.value;
      if (annual > L.maxAnnualGross) errors.salary = t('err.tooLarge', { max: yen(L.maxAnnualGross) });
    }

    if (bonus.invalid) errors.bonus = t('err.number');
    else if (bonus.value < 0) errors.bonus = t('err.nonNegative');
    else if (!errors.salary && state.period === 'annual' && bonus.value > salary.value) errors.bonus = t('err.bonusTooLarge');
    else if (!errors.salary && state.period === 'monthly' && salary.value * 12 + bonus.value > L.maxAnnualGross) errors.bonus = t('err.tooLarge', { max: yen(L.maxAnnualGross) });

    const age = Number(state.age);
    if (state.age === '' || !Number.isInteger(age) || age < L.minAge || age > L.maxAge) errors.age = t('err.age', { min: L.minAge, max: L.maxAge });

    for (const key of ['depGeneral', 'depSpecific']) {
      const v = Number(state[key] === '' ? 0 : state[key]);
      if (!Number.isInteger(v) || v < 0 || v > L.maxDependents) errors[key] = t('err.dependents', { max: L.maxDependents });
    }

    if (other.invalid) errors.other = t('err.number');
    else if (other.value < 0) errors.other = t('err.nonNegative');

    let customRate = 0;
    if (state.prefecture === 'custom') {
      const r = parseAmount(state.customRate);
      if (r.empty || r.invalid || r.value <= 0 || r.value > L.maxHealthRate * 100) errors.customRate = t('err.rate', { max: L.maxHealthRate * 100 });
      else customRate = r.value / 100;
    }

    const expenses = {};
    for (const cat of CFG.expenses.categories) {
      const p = parseAmount(state.expenses[cat.key]);
      if (p.invalid || p.value < 0 || p.value > L.maxMonthlyExpense) errors['exp-' + cat.key] = t('err.expense', { max: yen(L.maxMonthlyExpense) });
      else expenses[cat.key] = p.value;
    }

    return {
      errors,
      ok: Object.keys(errors).length === 0,
      inputs: {
        salaryAmount: salary.value,
        salaryPeriod: state.period,
        bonus: bonus.value || 0,
        age,
        prefecture: state.prefecture,
        customHealthRate: customRate,
        spouse: state.spouse,
        dependentsGeneral: Number(state.depGeneral || 0),
        dependentsSpecific: Number(state.depSpecific || 0),
        otherDeductions: other.value || 0,
        includeResidentTax: state.resident,
        expenses,
      },
    };
  }

  function showErrors(errors) {
    form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
    form.querySelectorAll('.error').forEach((el) => { el.textContent = ''; });
    for (const id in errors) {
      const input = $(id);
      const msg = $(id + '-error');
      if (input) input.setAttribute('aria-invalid', 'true');
      if (msg) msg.textContent = errors[id];
    }
  }

  /* ------------------------------ form <-> state ------------------------------ */

  function buildStaticOptions() {
    const pref = $('prefecture');
    const rates = CFG.socialInsurance.healthRatesByPrefecture;
    pref.innerHTML = Object.keys(rates)
      .map((k) => `<option value="${k}">${escapeHtml(t('pref.' + k))} — ${(rates[k] * 100).toFixed(2)}%</option>`)
      .join('') + `<option value="custom">${escapeHtml(t('input.prefecture.custom'))}</option>`;

    const preset = $('preset');
    preset.innerHTML = Object.keys(CFG.expenses.presets)
      .map((k) => {
        const total = Object.values(CFG.expenses.presets[k]).reduce((a, b) => a + b, 0);
        return `<option value="${k}">${escapeHtml(t('adv.preset.' + k))} — ${yen(total)}</option>`;
      })
      .join('');

    $('expense-fields').innerHTML = CFG.expenses.categories
      .map((c) => `
        <div class="field">
          <label for="exp-${c.key}">${escapeHtml(t('exp.' + c.key))}</label>
          <div class="money-input">
            <span class="currency" aria-hidden="true">¥</span>
            <input id="exp-${c.key}" data-expense="${c.key}" type="text" inputmode="decimal" aria-describedby="exp-${c.key}-error" spellcheck="false">
          </div>
          <p class="error" id="exp-${c.key}-error" role="alert"></p>
        </div>`)
      .join('');
  }

  function formatField(value) {
    const p = parseAmount(value);
    return p.empty || p.invalid ? String(value ?? '') : groupDigits(p.value);
  }

  function writeForm() {
    $('salary').value = formatField(state.salary);
    form.querySelector(`input[name="period"][value="${state.period}"]`).checked = true;
    $('bonus').value = formatField(state.bonus);
    $('age').value = state.age;
    $('prefecture').value = state.prefecture;
    $('customRate').value = state.customRate;
    $('custom-rate-field').hidden = state.prefecture !== 'custom';
    $('spouse').checked = state.spouse;
    $('depGeneral').value = state.depGeneral;
    $('depSpecific').value = state.depSpecific;
    $('other').value = formatField(state.other);
    $('resident').checked = state.resident;
    $('preset').value = state.preset;
    for (const c of CFG.expenses.categories) $('exp-' + c.key).value = formatField(state.expenses[c.key]);
    document.querySelector(`input[name="view"][value="${state.view}"]`).checked = true;
    setAdvanced(state.advancedOpen, false);
    updatePeriodHints();
  }

  function updatePeriodHints() {
    const annual = state.period === 'annual';
    $('salary-hint').textContent = t(annual ? 'input.salary.hintAnnual' : 'input.salary.hintMonthly');
    $('bonus-hint').textContent = t(annual ? 'input.bonus.hintAnnual' : 'input.bonus.hintMonthly');
    const current = parseAmount(state.salary);
    document.querySelectorAll('.chip[data-amount]').forEach((chip) => {
      const pressed = annual && !current.invalid && Number(chip.dataset.amount) === current.value;
      chip.setAttribute('aria-pressed', String(pressed));
    });
  }

  function setAdvanced(open, animate = true) {
    state.advancedOpen = open;
    const body = $('advanced-body');
    if (!animate) body.style.transition = 'none';
    $('advanced-toggle').setAttribute('aria-expanded', String(open));
    body.classList.toggle('is-open', open);
    if (!animate) requestAnimationFrame(() => { body.style.transition = ''; });
  }

  /** Convert the salary field when switching monthly ⇄ annual so the result stays the same. */
  function switchPeriod(next) {
    if (next === state.period) return;
    const s = parseAmount(state.salary);
    const b = parseAmount(state.bonus);
    if (!s.empty && !s.invalid) {
      const bonus = b.invalid ? 0 : b.value;
      const converted = next === 'monthly' ? Math.max(0, (s.value - bonus) / 12) : s.value * 12 + bonus;
      state.salary = String(Math.round(converted));
      $('salary').value = formatField(state.salary);
    }
    state.period = next;
    updatePeriodHints();
  }

  /* ------------------------------ rendering ------------------------------ */

  function render() {
    const v = validate();
    showErrors(v.errors);
    const results = $('results');
    $('error-banner').hidden = v.ok;
    results.classList.toggle('is-stale', !v.ok);
    persist();
    if (!v.ok) return;

    const r = Calc.calculate(v.inputs, CFG);
    lastResult = r;
    const d = state.view === 'monthly' ? 12 : 1;
    const periodLabel = state.view === 'monthly' ? t('res.perMonth') : t('res.perYear');
    const T = r.totals;
    const B = r.budget;
    const savings = state.view === 'monthly' ? B.savingsMonthly : B.savingsAnnual;
    const pctGross = (x) => t('res.ofGross', { pct: pct(r.percentOfGross(x)) });

    // hero + stat cards
    $('hero-net').textContent = yen(T.net / d);
    $('hero-period').textContent = periodLabel;
    $('hero-sub').textContent = `${pctGross(T.net)} · ${t('res.gross')} ${yen(r.gross.annual / d)}`;
    $('hero-rate').textContent = pct(T.deductionRate);
    $('stat-gross').textContent = yen(r.gross.annual / d);
    $('stat-tax').textContent = yen(T.taxes / d);
    $('stat-tax-sub').textContent = pctGross(T.taxes);
    $('stat-si').textContent = yen(T.socialInsurance / d);
    $('stat-si-sub').textContent = pctGross(T.socialInsurance);
    $('stat-save').textContent = yen(savings);
    $('stat-save').classList.toggle('is-negative', savings < 0);
    $('stat-save-sub').textContent = t('res.savingsRate', { pct: pct(B.savingsRate) });
    const badge = state.expensesCustom ? t('budget.customBadge') : t('budget.estimateBadge');
    $('savings-badge').textContent = badge;
    $('budget-badge').textContent = badge;
    $('avg-note').hidden = !(state.view === 'monthly' && r.gross.bonus > 0);

    renderFlowChart(r, d);
    renderTable(r);
    renderBudget(r);
    renderCurveChart(v.inputs, r);
    renderCalcDetails(r);
    renderNotes(r);
    renderExpenseStatus();
  }

  function renderFlowChart(r, d) {
    const net = r.totals.net;
    const exp = r.budget.annualTotal;
    const shown = [
      { key: 'tax', label: t('res.taxes'), value: r.totals.taxes, color: '--c-tax' },
      { key: 'si', label: t('res.social'), value: r.totals.socialInsurance, color: '--c-si' },
      { key: 'exp', label: t('flow.expenses'), value: Math.min(exp, Math.max(0, net)), color: '--c-exp' },
      { key: 'save', label: t('flow.left'), value: Math.max(0, net - exp), color: '--c-save' },
    ].map((s) => Object.assign(s, { displayValue: yen(s.value / d), pctText: pct(r.percentOfGross(s.value)) }));
    const shortfall = exp > net ? t('flow.shortfall', { amount: yen((exp - net) / 12) }) : null;
    renderFlow($('flow-chart'), shown, { warning: shortfall });
  }

  function renderTable(r) {
    const si = r.socialInsurance;
    const row = (cls, label, annual, rate) => `
      <tr class="${cls}">
        <td>${label}</td>
        <td>${yen(annual / 12)}</td>
        <td>${yen(annual)}</td>
        <td>${pct(r.percentOfGross(annual))}</td>
        <td class="rate">${rate || ''}</td>
      </tr>`;
    const group = (label, swatch) => `<tr class="group-row"><th colspan="5"><span class="swatch ${swatch}" aria-hidden="true"></span>${label}</th></tr>`;
    const rateText = (x) => pct(x, 3).replace(/\.?0+%$/, '%');

    let html = `<thead><tr>
        <th scope="col">${t('table.item')}</th><th scope="col">${t('table.monthly')}</th>
        <th scope="col">${t('table.annual')}</th><th scope="col">${t('table.pct')}</th><th scope="col">${t('table.rate')}</th>
      </tr></thead><tbody>`;
    html += row('gross-row', t('table.grossRow'), r.gross.annual);

    html += group(t('table.taxGroup'), 'swatch--tax');
    html += row('item-row', t('item.incomeTax'), r.incomeTax.total, t('item.incomeTax.rate', { rate: pct(r.incomeTax.marginalRate, 0) }));
    html += r.residentTax.included
      ? row('item-row', t('item.residentTax'), r.residentTax.total, t('item.residentTax.rate'))
      : row('item-row muted', t('item.residentTax'), 0, t('calc.notIncluded'));
    html += row('subtotal', t('table.subtotal'), r.totals.taxes);

    html += group(t('table.siGroup'), 'swatch--si');
    if (si.applies.health) html += row('item-row', t('item.health'), si.health, rateText(si.rates.health));
    if (si.applies.care) html += row('item-row', t('item.care'), si.care, rateText(si.rates.care));
    if (si.applies.health) html += row('item-row', t('item.childSupport'), si.childSupport, rateText(si.rates.childSupport));
    if (si.applies.pension) html += row('item-row', t('item.pension'), si.pension, rateText(si.rates.pension));
    html += row('item-row', t('item.employment'), si.employment, rateText(si.rates.employment));
    html += row('subtotal', t('table.subtotal'), si.total);

    html += row('total-row', t('table.totalDeductions'), r.totals.deductions);
    html += row('net-row', t('table.net'), r.totals.net);
    html += '</tbody>';
    $('breakdown-table').innerHTML = html;
  }

  function renderBudget(r) {
    const B = r.budget;
    const item = (cls, label, value, hint) =>
      `<div class="${cls}"><dt>${escapeHtml(label)}${hint ? `<small>${escapeHtml(hint)}</small>` : ''}</dt><dd>${yen(value)}</dd></div>`;
    const sign = (v) => (v >= 0 ? 'is-positive' : 'is-negative');
    $('budget-list').innerHTML =
      item('is-key', t('budget.takeHome'), r.totals.net / 12) +
      item('is-minus', t('budget.essentials'), B.essentialMonthly) +
      item('is-key ' + sign(B.leftAfterEssentialsMonthly), t('budget.afterEssentials'), B.leftAfterEssentialsMonthly, t('budget.afterEssentials.hint')) +
      item('is-minus', t('budget.discretionary'), B.discretionaryMonthly) +
      item('is-key ' + sign(B.savingsMonthly), t('budget.savingsMonthly'), B.savingsMonthly) +
      item('', t('budget.totalExpenses'), B.monthlyTotal) +
      item(sign(B.savingsAnnual), t('budget.savingsAnnual'), B.savingsAnnual) +
      `<div class="${sign(B.savingsRate)}"><dt>${escapeHtml(t('budget.savingsRate'))}</dt><dd>${pct(B.savingsRate)}</dd></div>`;

    const net = r.totals.net / 12;
    renderBarList($('expense-chart'), B.items.map((it) => ({
      label: t('exp.' + it.key),
      value: it.monthly,
      displayValue: yen(it.monthly),
      discretionary: !it.essential,
      tip: `<strong>${escapeHtml(t('exp.' + it.key))}</strong>${yen(it.monthly)} ${escapeHtml(t('adv.monthly'))} · ${net > 0 ? escapeHtml(t('res.savingsRate', { pct: pct(it.monthly / net) })) : '—'}`,
    })), [
      { cls: 'swatch--exp', label: t('exp.essential') },
      { cls: 'swatch--exp-light', label: t('exp.discretionary') },
    ]);
  }

  function renderCurveChart(inputs, r) {
    const gross = r.gross.annual;
    const from = gross < 2e6 ? 1e6 : 2e6;
    const to = Math.min(100e6, gross > 14e6 ? Math.ceil((gross * 1.4) / 5e6) * 5e6 : 20e6);
    const step = Math.max(100000, Math.round((to - from) / 90 / 100000) * 100000);
    const pts = Calc.sweep(inputs, CFG, from, to, step).map((p) => ({
      x: p.gross,
      y: p.deductionRate,
      tip: `<strong>${t('curve.tipGross')} ${yen(p.gross)}</strong>${t('curve.tipNet')} ${yen(p.net)}<br>${t('curve.tipRate')} ${pct(p.deductionRate)}`,
    }));
    renderCurve($('curve-chart'), pts, { x: gross, y: r.totals.deductionRate, label: `${t('curve.you')} · ${pct(r.totals.deductionRate)}` }, {
      xTick: shortYen,
      ariaLabel: `${t('curve.series')}: ${pct(pts[0].y)} – ${pct(pts[pts.length - 1].y)}`,
    });
  }

  function renderCalcDetails(r) {
    const it = r.incomeTax, rt = r.residentTax, si = r.socialInsurance;
    const line = (label, value, cls = '') => `<div class="${cls}"><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`;
    const minus = (v) => (v ? '−' + yen(v) : yen(0));
    const block = (title, rows) => `<section class="calc-block"><h3>${escapeHtml(title)}</h3><dl>${rows}</dl></section>`;

    const itRows =
      line(t('res.gross'), yen(r.gross.annual)) +
      line(t('calc.salaryDeduction'), minus(it.salaryDeduction)) +
      line(t('calc.salaryIncome'), yen(it.salaryIncome)) +
      line(t('calc.siDeduction'), minus(it.socialInsuranceDeduction)) +
      line(t('calc.basic'), minus(it.basicDeduction)) +
      (it.spouseDeduction ? line(t('calc.spouse'), minus(it.spouseDeduction)) : '') +
      (it.dependentDeduction ? line(t('calc.dependents'), minus(it.dependentDeduction)) : '') +
      (it.otherDeductions ? line(t('calc.other'), minus(it.otherDeductions)) : '') +
      line(t('calc.taxable'), yen(it.taxableIncome)) +
      line(t('calc.baseTax'), yen(it.baseTax)) +
      line(t('calc.surtax'), yen(it.surtax)) +
      line(t('calc.total'), yen(it.total), 'calc-total');

    const rtRows = rt.included
      ? line(t('calc.salaryIncome'), yen(rt.salaryIncome)) +
        line(t('calc.siDeduction'), minus(si.total)) +
        line(t('calc.basic'), minus(rt.basicDeduction)) +
        (rt.spouseDeduction ? line(t('calc.spouse'), minus(rt.spouseDeduction)) : '') +
        (rt.dependentDeduction ? line(t('calc.dependents'), minus(rt.dependentDeduction)) : '') +
        (r.inputs.otherDeductions ? line(t('calc.other'), minus(r.inputs.otherDeductions)) : '') +
        line(t('calc.taxable'), yen(rt.taxableIncome)) +
        line(t('calc.adjustment'), minus(rt.adjustment)) +
        line(t('calc.incomeLevy'), yen(rt.incomeLevy)) +
        line(t('calc.perCapita'), yen(rt.perCapita)) +
        line(t('calc.total'), yen(rt.total), 'calc-total')
      : line(t('item.residentTax'), t('calc.notIncluded'), 'calc-total');

    const siRows =
      line(t('calc.healthStd'), yen(si.healthStandard)) +
      line(t('calc.pensionStd'), yen(si.pensionStandard)) +
      line(t('calc.healthRate'), pct(si.rates.health, 3)) +
      line(t('item.health'), yen(si.health)) +
      (si.applies.care ? line(t('item.care'), yen(si.care)) : '') +
      line(t('item.childSupport'), yen(si.childSupport)) +
      line(t('item.pension'), yen(si.pension)) +
      line(t('item.employment'), yen(si.employment)) +
      line(t('calc.total'), yen(si.total), 'calc-total');

    $('calc-details').innerHTML =
      block(t('calc.it', { year: CFG.meta.taxYear }), itRows) +
      block(t('calc.rt'), rtRows) +
      block(t('calc.si'), siRows);
  }

  function renderNotes(r) {
    const personal = r.notes.map((n) => `<li class="is-personal">${escapeHtml(t('note.' + n))}</li>`);
    const general = [1, 2, 3, 4, 5].map((i) => `<li>${escapeHtml(t('assume.' + i))}</li>`);
    $('notes-list').innerHTML = personal.concat(general).join('');
  }

  function renderExpenseStatus() {
    $('expense-status').textContent = state.expensesCustom
      ? t('adv.usingCustom')
      : t('adv.usingEstimate', { preset: t('adv.preset.' + state.preset) });
  }

  /* ------------------------------ i18n ------------------------------ */

  function applyLanguage() {
    window.I18n.setLang(lang);
    document.documentElement.lang = lang;
    document.title = t('app.title');
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-aria]').forEach((el) => el.setAttribute('aria-label', t(el.dataset.i18nAria)));
    document.querySelectorAll('[data-lang]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
    $('rates-badge').textContent = t('app.ratesYear', { year: CFG.meta.taxYear });
    $('footer-updated').textContent = t('footer.updated', { date: CFG.meta.lastReviewed });
    $('sources-list').innerHTML = CFG.meta.sources
      .map((s) => `<a href="${s.url}" target="_blank" rel="noopener">${escapeHtml(s.label)}</a>`)
      .join(' · ');

    buildStaticOptions();
    writeForm();
    render();
  }

  /* ------------------------------ theme ------------------------------ */

  function applyTheme() {
    if (theme) document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
  }

  function currentTheme() {
    return theme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }

  /* ------------------------------ events ------------------------------ */

  form.addEventListener('input', (e) => {
    const el = e.target;
    if (el.dataset.expense) {
      state.expenses[el.dataset.expense] = el.value;
      state.expensesCustom = true;
    } else if (el.name === 'period') {
      switchPeriod(el.value);
    } else {
      const map = {
        salary: 'salary', bonus: 'bonus', age: 'age', prefecture: 'prefecture', customRate: 'customRate',
        spouse: 'spouse', depGeneral: 'depGeneral', depSpecific: 'depSpecific', other: 'other', resident: 'resident',
      };
      const key = map[el.id];
      if (!key) return;
      state[key] = el.type === 'checkbox' ? el.checked : el.value;
      if (key === 'prefecture') $('custom-rate-field').hidden = el.value !== 'custom';
      if (key === 'salary' || key === 'bonus') updatePeriodHints();
    }
    render();
  });

  form.addEventListener('change', (e) => {
    if (e.target.id === 'preset') {
      state.preset = e.target.value;
      state.expenses = toStrings(CFG.expenses.presets[state.preset]);
      state.expensesCustom = false;
      for (const c of CFG.expenses.categories) $('exp-' + c.key).value = formatField(state.expenses[c.key]);
      render();
    }
  });

  // Reformat money fields with thousands separators when the user leaves them.
  form.addEventListener('focusout', (e) => {
    const el = e.target;
    if (el.matches('.money-input input') && el.id !== 'customRate') {
      const p = parseAmount(el.value);
      if (!p.empty && !p.invalid && p.value >= 0) el.value = groupDigits(p.value);
    }
  });

  form.addEventListener('submit', (e) => e.preventDefault());

  document.querySelectorAll('.chip[data-amount]').forEach((chip) => {
    chip.addEventListener('click', () => {
      if (state.period !== 'annual') {
        state.period = 'annual';
        form.querySelector('input[name="period"][value="annual"]').checked = true;
      }
      state.salary = chip.dataset.amount;
      const b = parseAmount(state.bonus);
      if (!b.invalid && b.value > Number(chip.dataset.amount)) state.bonus = '';
      $('salary').value = formatField(state.salary);
      $('bonus').value = formatField(state.bonus);
      updatePeriodHints();
      render();
    });
  });

  $('advanced-toggle').addEventListener('click', () => {
    setAdvanced(!state.advancedOpen);
    persist();
  });

  document.querySelectorAll('input[name="view"]').forEach((r) => r.addEventListener('change', () => {
    state.view = r.value;
    render();
  }));

  $('reset-btn').addEventListener('click', () => {
    const view = state.view;
    state = defaultState();
    state.view = view;
    writeForm();
    render();
    $('form-status').textContent = t('btn.reset.confirm');
    $('salary').focus();
  });

  document.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => {
    lang = b.dataset.lang;
    applyLanguage();
  }));

  $('theme-toggle').addEventListener('click', () => {
    theme = currentTheme() === 'dark' ? 'light' : 'dark';
    applyTheme();
    persist();
  });

  /* ------------------------------ init ------------------------------ */
  // Guard against stale saved state (e.g. a removed prefecture or category).
  if (state.prefecture !== 'custom' && !CFG.socialInsurance.healthRatesByPrefecture[state.prefecture]) state.prefecture = CFG.socialInsurance.defaultPrefecture;
  if (!CFG.expenses.presets[state.preset]) state.preset = CFG.expenses.defaultPreset;
  for (const c of CFG.expenses.categories) if (state.expenses[c.key] === undefined) state.expenses[c.key] = String(CFG.expenses.presets[state.preset][c.key] || 0);

  applyTheme();
  applyLanguage();
})();
