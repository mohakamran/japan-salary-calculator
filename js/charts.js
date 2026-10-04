/**
 * Lightweight, dependency-free charts (HTML + inline SVG).
 * Each renderer takes a container element and plain data; colours come from
 * CSS custom properties so light/dark themes work automatically.
 */
(function (root) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';

  /* ----------------------------- tooltip ----------------------------- */
  const Tooltip = {
    el: null,
    show(html, x, y) {
      if (!this.el) this.el = document.getElementById('tooltip');
      const el = this.el;
      el.innerHTML = html;
      el.hidden = false;
      const pad = 12;
      const { width, height } = el.getBoundingClientRect();
      let left = x + pad;
      let top = y - height - pad;
      if (left + width > window.innerWidth - 8) left = x - width - pad;
      if (top < 8) top = y + pad;
      el.style.left = Math.max(8, left) + 'px';
      el.style.top = top + 'px';
    },
    hide() { if (this.el) this.el.hidden = true; },
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function bindTooltip(el, getHtml) {
    const show = (e) => {
      const rect = el.getBoundingClientRect();
      const x = e && e.clientX !== undefined ? e.clientX : rect.left + rect.width / 2;
      const y = e && e.clientY !== undefined ? e.clientY : rect.top;
      Tooltip.show(getHtml(), x, y);
    };
    el.addEventListener('pointermove', show);
    el.addEventListener('pointerleave', () => Tooltip.hide());
    el.addEventListener('focus', () => show());
    el.addEventListener('blur', () => Tooltip.hide());
  }

  /* ----------------------- stacked "flow" bar ----------------------- */
  /**
   * segments: [{ key, label, value, color (css var), pct, displayValue }]
   */
  function renderFlow(container, segments, opts) {
    container.textContent = '';
    const total = segments.reduce((s, x) => s + Math.max(0, x.value), 0) || 1;

    const bar = document.createElement('div');
    bar.className = 'flow-bar';
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', segments.map((s) => `${s.label}: ${s.displayValue} (${s.pctText})`).join(', '));

    segments.forEach((s) => {
      if (s.value <= 0) return;
      const seg = document.createElement('div');
      seg.className = 'flow-seg';
      seg.style.flexGrow = String(s.value / total);
      seg.style.flexBasis = '0';
      seg.style.background = `var(${s.color})`;
      seg.tabIndex = 0;
      bindTooltip(seg, () => `<strong>${escapeHtml(s.label)}</strong>${escapeHtml(s.displayValue)} · ${escapeHtml(s.pctText)}`);
      bar.appendChild(seg);
    });
    container.appendChild(bar);

    const legend = document.createElement('div');
    legend.className = 'flow-legend';
    segments.forEach((s) => {
      const item = document.createElement('div');
      item.className = 'legend-item';
      item.innerHTML =
        `<span class="legend-label"><span class="swatch" style="background:var(${s.color})"></span>${escapeHtml(s.label)}</span>` +
        `<span class="legend-value">${escapeHtml(s.displayValue)}</span>` +
        `<span class="legend-pct">${escapeHtml(s.pctText)}</span>`;
      legend.appendChild(item);
    });
    container.appendChild(legend);

    if (opts && opts.warning) {
      const w = document.createElement('p');
      w.className = 'flow-warning';
      w.setAttribute('role', 'status');
      w.textContent = opts.warning;
      container.appendChild(w);
    }
  }

  /* -------------------------- bar list -------------------------- */
  /** rows: [{ label, value, displayValue, discretionary, tip }] */
  function renderBarList(container, rows, legend) {
    container.textContent = '';
    const max = Math.max(1, ...rows.map((r) => r.value));
    rows.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'bar-row';
      row.tabIndex = 0;
      row.innerHTML =
        `<span class="bar-label">${escapeHtml(r.label)}</span>` +
        `<span class="bar-track"><span class="bar-fill${r.discretionary ? ' is-discretionary' : ''}" style="width:${(r.value / max) * 100}%"></span></span>` +
        `<span class="bar-value">${escapeHtml(r.displayValue)}</span>`;
      bindTooltip(row, () => r.tip);
      container.appendChild(row);
    });
    if (legend) {
      const lg = document.createElement('div');
      lg.className = 'bar-legend';
      lg.innerHTML = legend.map((l) => `<span><span class="swatch ${l.cls}"></span>${escapeHtml(l.label)}</span>`).join('');
      container.appendChild(lg);
    }
  }

  /* -------------------------- line chart -------------------------- */
  /**
   * points: [{ x, y, tip }]   (y as fraction 0..1)
   * marker: { x, y, label }
   */
  function renderCurve(container, points, marker, fmt) {
    container.textContent = '';
    if (!points.length) return;

    const W = 720, H = 300;
    const m = { top: 24, right: 20, bottom: 34, left: 44 };
    const iw = W - m.left - m.right;
    const ih = H - m.top - m.bottom;

    const xMin = points[0].x, xMax = points[points.length - 1].x;
    const yMaxRaw = Math.max(...points.map((p) => p.y), marker ? marker.y : 0);
    const yMax = Math.min(1, Math.ceil((yMaxRaw + 0.03) * 20) / 20);
    const sx = (x) => m.left + ((x - xMin) / (xMax - xMin)) * iw;
    const sy = (y) => m.top + ih - (y / yMax) * ih;

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', fmt.ariaLabel);
    const el = (name, attrs, parent) => {
      const n = document.createElementNS(SVG_NS, name);
      for (const k in attrs) n.setAttribute(k, attrs[k]);
      (parent || svg).appendChild(n);
      return n;
    };

    // grid + y axis
    const axis = el('g', { class: 'axis' });
    const yStep = yMax > 0.3 ? 0.1 : 0.05;
    for (let y = 0; y <= yMax + 1e-9; y += yStep) {
      el('line', { class: 'gridline', x1: m.left, x2: W - m.right, y1: sy(y), y2: sy(y) }, axis);
      const tx = el('text', { x: m.left - 8, y: sy(y) + 4, 'text-anchor': 'end' }, axis);
      tx.textContent = Math.round(y * 100) + '%';
    }
    // x axis ticks
    const span = xMax - xMin;
    const xStep = span > 20e6 ? 5e6 : span > 10e6 ? 2.5e6 : 1e6;
    for (let x = Math.ceil(xMin / xStep) * xStep; x <= xMax; x += xStep) {
      const tx = el('text', { x: sx(x), y: H - 10, 'text-anchor': 'middle' }, axis);
      tx.textContent = fmt.xTick(x);
    }

    const d = points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join('');
    el('path', { class: 'area', d: `${d}L${sx(xMax)},${sy(0)}L${sx(xMin)},${sy(0)}Z` });
    el('path', { class: 'line', d });

    // "you" marker
    if (marker && marker.x >= xMin && marker.x <= xMax) {
      const mx = sx(marker.x), my = sy(marker.y);
      el('line', { class: 'crosshair', x1: mx, x2: mx, y1: my, y2: m.top + ih });
      el('circle', { class: 'you-dot', cx: mx, cy: my, r: 6 });
      const anchor = mx > W - 120 ? 'end' : mx < 120 ? 'start' : 'middle';
      const lbl = el('text', { class: 'you-label', x: mx, y: my - 12, 'text-anchor': anchor });
      lbl.textContent = marker.label;
    }

    // hover layer
    const cross = el('line', { class: 'crosshair', y1: m.top, y2: m.top + ih, visibility: 'hidden' });
    const dot = el('circle', { class: 'hover-dot', r: 5, visibility: 'hidden' });
    const hit = el('rect', { class: 'hit', x: m.left, y: m.top, width: iw, height: ih, tabindex: 0 });

    let focusIndex = -1;
    const showAt = (i, clientX, clientY) => {
      const p = points[i];
      const cx = sx(p.x), cy = sy(p.y);
      cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', cx); dot.setAttribute('cy', cy); dot.setAttribute('visibility', 'visible');
      if (clientX === undefined) {
        const r = svg.getBoundingClientRect();
        clientX = r.left + (cx / W) * r.width;
        clientY = r.top + (cy / H) * r.height;
      }
      Tooltip.show(p.tip, clientX, clientY);
    };
    const hideHover = () => {
      cross.setAttribute('visibility', 'hidden');
      dot.setAttribute('visibility', 'hidden');
      Tooltip.hide();
    };
    hit.addEventListener('pointermove', (e) => {
      const r = svg.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * W;
      const val = xMin + ((x - m.left) / iw) * (xMax - xMin);
      let best = 0;
      points.forEach((p, i) => { if (Math.abs(p.x - val) < Math.abs(points[best].x - val)) best = i; });
      focusIndex = best;
      showAt(best, e.clientX, e.clientY);
    });
    hit.addEventListener('pointerleave', hideHover);
    hit.addEventListener('blur', hideHover);
    hit.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      if (focusIndex < 0) {
        focusIndex = marker ? points.reduce((b, p, i) => (Math.abs(p.x - marker.x) < Math.abs(points[b].x - marker.x) ? i : b), 0) : 0;
      } else {
        focusIndex = Math.max(0, Math.min(points.length - 1, focusIndex + (e.key === 'ArrowRight' ? 1 : -1)));
      }
      showAt(focusIndex);
    });

    container.appendChild(svg);
  }

  root.Charts = { renderFlow, renderBarList, renderCurve, Tooltip, escapeHtml };
})(typeof self !== 'undefined' ? self : this);
