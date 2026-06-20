/* ── State ── */
let portfolio    = [];
let quotes       = {};
let sparklines   = {};
let sentiments   = {};
let sortCol      = null;
let sortDir      = 1;
let countdownInt = null;
let countdown    = 300;
let firstLoad    = true;
let sentimentFetch = false;
const INTERVAL   = 300; // 5 minutes

/* ── Boot ── */
window.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('btn-refresh').addEventListener('click', triggerRefresh);
  document.getElementById('btn-load').addEventListener('click', pickFile);
  document.getElementById('csv-path').addEventListener('click', pickFile);
  document.querySelectorAll('thead th[data-col]').forEach(th =>
    th.addEventListener('click', () => onSort(th.dataset.col))
  );

  initModal();
  updateMarketStatus();
  setInterval(updateMarketStatus, 30_000);

  // Auto-load from localStorage if a CSV was previously uploaded
  const saved = localStorage.getItem('portfolioCSV');
  if (saved) {
    const rows = parseCSV(saved);
    if (rows.length) {
      portfolio = rows;
      document.getElementById('csv-path').textContent = localStorage.getItem('csvName') || 'portfolio.csv';
      hideError();
      await refresh();
      startAutoRefresh();
    }
  }
});

/* ── CSV ── */
function pickFile() {
  const input  = document.createElement('input');
  input.type   = 'file';
  input.accept = '.csv';
  input.onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async ev => loadCSV(ev.target.result, file.name);
    reader.readAsText(file);
  };
  input.click();
}

async function loadCSV(csvText, fileName) {
  const rows = parseCSV(csvText);
  if (!rows.length) { showError('No valid positions found in CSV.'); return; }
  portfolio  = rows;
  sparklines = {};
  sentiments = {};
  firstLoad  = true;
  localStorage.setItem('portfolioCSV', csvText);
  localStorage.setItem('csvName', fileName || 'portfolio.csv');
  document.getElementById('csv-path').textContent = fileName || 'portfolio.csv';
  document.getElementById('csv-path').title = fileName || '';
  hideError();
  await refresh();
  startAutoRefresh();
}

function parseCSV(text) {
  const clean = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = clean.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = splitCSVLine(lines[0]).map(h => h.toLowerCase().trim());
  const isRJ = headers.includes('symbol/cusip');
  if (isRJ) {
    const iT = headers.indexOf('symbol/cusip');
    const iS = headers.indexOf('quantity');
    const iC = headers.indexOf('amount invested / unit');
    const iType = headers.indexOf('product type');
    return lines.slice(1)
      .map(l => splitCSVLine(l))
      .filter(p => (p[iType]||'').toLowerCase().includes('stock') && /^[A-Za-z]{1,5}$/.test((p[iT]||'').trim()))
      .map(p => ({ ticker: p[iT].trim().toUpperCase(), shares: parseNum(p[iS]), avg_cost: parseNum(p[iC]) }))
      .filter(p => p.shares > 0);
  }
  const iT = headers.indexOf('ticker'), iS = headers.indexOf('shares'), iC = headers.indexOf('avg_cost');
  if (iT < 0 || iS < 0 || iC < 0) { showError('CSV needs: ticker, shares, avg_cost'); return []; }
  return lines.slice(1)
    .map(l => splitCSVLine(l)).filter(p => p[iT])
    .map(p => ({ ticker: p[iT].trim().toUpperCase(), shares: parseNum(p[iS]), avg_cost: parseNum(p[iC]) }));
}

function splitCSVLine(line) {
  const res = []; let cur = '', inQ = false;
  for (const c of line) {
    if (c === '"') inQ = !inQ;
    else if (c === ',' && !inQ) { res.push(cur); cur = ''; }
    else cur += c;
  }
  res.push(cur); return res;
}

function parseNum(s) {
  if (!s) return 0;
  const neg = s.includes('(');
  const n = parseFloat(s.replace(/[^0-9.]/g, ''));
  return neg ? -n : (n || 0);
}

/* ── Refresh ── */
async function triggerRefresh() {
  countdown = INTERVAL; updateRing();
  await refresh();
}

async function refresh() {
  if (!portfolio.length) return;
  if (firstLoad) showLoading(true);
  const tickers = portfolio.map(p => p.ticker).join(',');
  const res = await apiFetch(`/api/quotes?tickers=${encodeURIComponent(tickers)}`);
  showLoading(false);
  if (!res.ok) { showError('Fetch failed: ' + res.error); return; }
  hideError();
  const prev = { ...quotes };
  quotes = res.quotes;
  if (firstLoad) { buildTable(); buildTiles(); fetchMarket(); firstLoad = false; }
  else           { updateTableCells(); updateTiles(); }
  renderSummary();
  renderHeroBanner();
  renderMovers();
  if (Object.keys(sparklines).length === 0) fetchSparklines();
  if (!sentimentFetch) fetchSentiments();
  document.getElementById('last-updated').textContent =
    new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/* ── Tab switching ── */
function showTab(tab) {
  document.getElementById('home-page').classList.toggle('hidden', tab !== 'home');
  document.getElementById('overview-page').classList.toggle('hidden', tab !== 'overview');
  document.getElementById('tab-home').classList.toggle('active', tab === 'home');
  document.getElementById('tab-overview').classList.toggle('active', tab === 'overview');
}

/* ── Holdings Tiles ── */
const TILE_THRESHOLD = 750_000;

function majorHoldings() {
  return sortedRows().filter(r => !isNaN(r.mktValue) && r.mktValue >= TILE_THRESHOLD)
    .sort((a, b) => b.mktValue - a.mktValue);
}

function buildTiles() {
  const grid = document.getElementById('tiles-grid');
  const rows = majorHoldings();
  if (!rows.length) {
    grid.innerHTML = '<div style="color:var(--dim);font-size:13px;padding:40px 0">No positions above $750K yet.</div>';
    return;
  }
  grid.innerHTML = rows.map(r => tileHTML(r)).join('');
  grid.querySelectorAll('.holding-tile').forEach(el =>
    el.addEventListener('click', () => openModal(el.dataset.ticker))
  );
  // Render sparklines already in cache
  rows.forEach(r => {
    if (sparklines[r.ticker]) renderTileSparkline(r.ticker, sparklines[r.ticker]);
  });
}

function updateTiles() {
  const rows = majorHoldings();
  const grid = document.getElementById('tiles-grid');
  // Rebuild if tile count changed
  const existing = grid.querySelectorAll('.holding-tile').length;
  if (existing !== rows.length) { buildTiles(); return; }
  rows.forEach(r => {
    const tile = grid.querySelector(`.holding-tile[data-ticker="${r.ticker}"]`);
    if (!tile) return;
    const dc = dirClass(r.change);
    tile.className = `holding-tile tile-${dc}`;
    tile.querySelector('.tile-price').textContent = r.price ? fmt$(r.price) : '—';
    const pill = tile.querySelector('.tile-change-pill');
    pill.className = `tile-change-pill ${dc}`;
    pill.textContent = r.changePct != null ? (r.changePct >= 0 ? '+' : '') + r.changePct.toFixed(2) + '%' : '—';
    tile.querySelector('.tile-day-gain').textContent =
      isNaN(r.dayGain) ? '—' : (r.dayGain >= 0 ? '+' : '') + fmt$(r.dayGain);
    tile.querySelector('.tile-day-gain').className = `tile-stat-val ${dc}`;
    tile.querySelector('.tile-mkt-val').textContent = fmt$(r.mktValue);
    const pc = dirClass(r.pnl);
    tile.querySelector('.tile-pnl').textContent =
      isNaN(r.pnl) ? '—' : (r.pnl >= 0 ? '+' : '') + fmt$(r.pnl);
    tile.querySelector('.tile-pnl').className = `tile-stat-val ${pc}`;
    tile.querySelector('.tile-return').textContent =
      isNaN(r.pnlPct) ? '—' : (r.pnlPct >= 0 ? '+' : '') + r.pnlPct.toFixed(1) + '%';
    tile.querySelector('.tile-return').className = `tile-stat-val ${pc}`;
  });
}

function tileHTML(r) {
  const dc  = dirClass(r.change);
  const pc  = dirClass(r.pnl);
  const pct = r.changePct != null ? (r.changePct >= 0 ? '+' : '') + r.changePct.toFixed(2) + '%' : '—';
  return `
    <div class="holding-tile tile-${dc}" data-ticker="${r.ticker}">
      <div class="tile-header">
        <div class="tile-badge ${dc}">${r.ticker.slice(0, 4)}</div>
        <span class="tile-change-pill ${dc}">${pct}</span>
      </div>
      <div class="tile-ticker">${r.ticker}</div>
      <div class="tile-name">${r.shortName || '—'}</div>
      <div class="tile-price">${r.price ? fmt$(r.price) : '—'}</div>
      <div class="tile-stats">
        <div>
          <div class="tile-stat-label">Day Gain</div>
          <div class="tile-stat-val ${dc} tile-day-gain">${isNaN(r.dayGain) ? '—' : (r.dayGain >= 0 ? '+' : '') + fmt$(r.dayGain)}</div>
        </div>
        <div>
          <div class="tile-stat-label">Mkt Value</div>
          <div class="tile-stat-val neutral tile-mkt-val">${fmt$(r.mktValue)}</div>
        </div>
        <div>
          <div class="tile-stat-label">Total Gain</div>
          <div class="tile-stat-val ${pc} tile-pnl">${isNaN(r.pnl) ? '—' : (r.pnl >= 0 ? '+' : '') + fmt$(r.pnl)}</div>
        </div>
        <div>
          <div class="tile-stat-label">Return</div>
          <div class="tile-stat-val ${pc} tile-return">${isNaN(r.pnlPct) ? '—' : (r.pnlPct >= 0 ? '+' : '') + r.pnlPct.toFixed(1) + '%'}</div>
        </div>
      </div>
      <div class="tile-spark" id="tile-spark-${r.ticker}">
        <span style="font-size:10px;color:var(--dim)">Loading chart…</span>
      </div>
    </div>`;
}

function renderTileSparkline(ticker, closes) {
  const el = document.getElementById(`tile-spark-${ticker}`);
  if (!el) return;
  const W = 240, H = 48, P = 3;
  const min = Math.min(...closes), max = Math.max(...closes);
  const range = max - min || 1;
  const dir   = closes[closes.length - 1] >= closes[0] ? 'up' : 'down';
  const xs = closes.map((_, i) => P + (i / (closes.length - 1)) * (W - P * 2));
  const ys = closes.map(c => P + (1 - (c - min) / range) * (H - P * 2));
  const pts  = xs.map((x, i) => `${x},${ys[i]}`).join(' ');
  const fill = `${pts} ${W - P},${H - P} ${P},${H - P}`;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" style="display:block">
    <polygon class="spark-fill ${dir}" points="${fill}"/>
    <polyline class="spark-line ${dir}" points="${pts}"/>
  </svg>`;
}

function startAutoRefresh() {
  clearInterval(countdownInt);
  countdown = INTERVAL; updateRing();
  countdownInt = setInterval(() => {
    countdown--;
    updateRing();
    if (countdown <= 0) { countdown = INTERVAL; refresh(); }
  }, 1000);
}

function updateRing() {
  const circ = 75.4;
  document.getElementById('ring-fill').style.strokeDashoffset = circ * (1 - countdown / INTERVAL);
  const mins = Math.floor(countdown / 60);
  const secs = countdown % 60;
  document.getElementById('ring-label').textContent = mins > 0
    ? `${mins}m`
    : `${secs}s`;
}

/* ── Build table (first load / sort) ── */
function buildTable() {
  const tbody = document.getElementById('table-body');
  tbody.innerHTML = '';
  sortedRows().forEach(row => {
    const tr = document.createElement('tr');
    tr.dataset.ticker = row.ticker;
    tr.dataset.price  = row.price || '';
    tr.innerHTML = rowHTML(row);
    tr.addEventListener('click', () => openModal(row.ticker));
    tbody.appendChild(tr);
    if (sparklines[row.ticker]) setTimeout(() => renderSparkline(row.ticker, sparklines[row.ticker]), 0);
    if (sentiments[row.ticker]) setTimeout(() => renderSentiment(row.ticker, sentiments[row.ticker]), 0);
  });
}

/* ── In-place cell update (subsequent refreshes) ── */
function updateTableCells() {
  const totalValue = calcTotalValue();
  portfolio.forEach(pos => {
    const tr = document.querySelector(`tr[data-ticker="${pos.ticker}"]`);
    if (!tr) return;
    const q      = quotes[pos.ticker] || {};
    const price  = q.price ?? NaN;
    const mv     = pos.shares * price;
    const cb      = pos.shares * pos.avg_cost;
    const pnl     = mv - cb;
    const pnlPct  = cb ? (pnl / cb) * 100 : NaN;
    const weight  = totalValue ? (mv / totalValue) * 100 : NaN;
    const dayGain = isNaN(price) ? NaN : pos.shares * (q.change || 0);
    const dc      = dirClass(q.change);
    const pc      = dirClass(pnl);
    const dgc     = dirClass(dayGain);
    const barW    = isNaN(weight) ? 0 : Math.max(2, weight * 2.5);
    const cells   = tr.querySelectorAll('td');

    const oldPrice = parseFloat(tr.dataset.price);
    if (oldPrice && price && price !== oldPrice) {
      tr.classList.remove('flash-up', 'flash-down');
      void tr.offsetWidth;
      tr.classList.add(price > oldPrice ? 'flash-up' : 'flash-down');
    }
    tr.dataset.price = price;

    // cols: 0=symbol 1=spark 2=sentiment 3=price 4=change 5=changePct 6=shares 7=dayGain 8=mktVal 9=pnl 10=pnlPct 11=weight
    cells[3].textContent  = price ? fmt$(price) : '—';
    cells[4].className    = `num ${dc}`;
    cells[4].textContent  = q.change != null ? (q.change >= 0 ? '+' : '') + fmt$(q.change) : '—';
    cells[5].innerHTML    = `<span class="pill ${dc}">${q.changePct != null ? (q.changePct >= 0 ? '+' : '') + q.changePct.toFixed(2) + '%' : '—'}</span>`;
    cells[7].className    = `num ${dgc}`;
    cells[7].textContent  = isNaN(dayGain) ? '—' : (dayGain >= 0 ? '+' : '') + fmt$(dayGain);
    cells[8].textContent  = fmt$(mv);
    cells[9].className    = `num ${pc}`;
    cells[9].textContent  = isNaN(pnl) ? '—' : (pnl >= 0 ? '+' : '') + fmt$(pnl);
    cells[10].innerHTML   = `<span class="pill ${pc}">${isNaN(pnlPct) ? '—' : (pnlPct >= 0 ? '+' : '') + pnlPct.toFixed(2) + '%'}</span>`;
    cells[11].innerHTML   = `<div class="weight-wrap"><div class="weight-bar" style="width:${barW}px"></div><span>${isNaN(weight) ? '—' : weight.toFixed(1) + '%'}</span></div>`;
  });
}

function sortedRows() {
  const totalValue = calcTotalValue();
  let rows = portfolio.map(pos => {
    const q      = quotes[pos.ticker] || {};
    const price  = q.price ?? NaN;
    const mv     = pos.shares * price;
    const cb     = pos.shares * pos.avg_cost;
    const pnl    = mv - cb;
    const pnlPct = cb ? (pnl / cb) * 100 : NaN;
    const weight  = totalValue ? (mv / totalValue) * 100 : NaN;
    const dayGain = isNaN(price) ? NaN : pos.shares * (q.change || 0);
    return { ...pos, ...q, mktValue: mv, costBasis: cb, pnl, pnlPct, weight, dayGain };
  });
  if (sortCol) {
    rows.sort((a, b) => {
      const av = a[sortCol], bv = b[sortCol];
      if (typeof av === 'string') return av.localeCompare(bv) * sortDir;
      return ((av ?? -Infinity) - (bv ?? -Infinity)) * sortDir;
    });
  }
  return rows;
}

function badgeText(ticker) {
  return ticker.length <= 2 ? ticker : ticker.slice(0, 2);
}

function rowHTML(row) {
  const dc   = dirClass(row.change);
  const pc   = dirClass(row.pnl);
  const barW = isNaN(row.weight) ? 0 : Math.max(2, row.weight * 2.5);
  return `
    <td>
      <div class="ticker-wrap">
        <div class="ticker-badge">${badgeText(row.ticker)}</div>
        <div>
          <div class="ticker-sym">${row.ticker}</div>
          <div class="ticker-name">${row.shortName || '—'}</div>
        </div>
      </div>
    </td>
    <td class="sparkline-cell" id="spark-${row.ticker}"><span class="spark-loading">…</span></td>
    <td class="sentiment-cell" id="sent-${row.ticker}"><span class="sentiment-na">…</span></td>
    <td class="num">${row.price ? fmt$(row.price) : '—'}</td>
    <td class="num ${dc}">${row.change != null ? (row.change >= 0 ? '+' : '') + fmt$(row.change) : '—'}</td>
    <td class="num"><span class="pill ${dc}">${row.changePct != null ? (row.changePct >= 0 ? '+' : '') + row.changePct.toFixed(2) + '%' : '—'}</span></td>
    <td class="num">${row.shares.toLocaleString()}</td>
    <td class="num ${dirClass(row.dayGain)}">${isNaN(row.dayGain) ? '—' : (row.dayGain >= 0 ? '+' : '') + fmt$(row.dayGain)}</td>
    <td class="num">${fmt$(row.mktValue)}</td>
    <td class="num ${pc}">${isNaN(row.pnl) ? '—' : (row.pnl >= 0 ? '+' : '') + fmt$(row.pnl)}</td>
    <td class="num"><span class="pill ${pc}">${isNaN(row.pnlPct) ? '—' : (row.pnlPct >= 0 ? '+' : '') + row.pnlPct.toFixed(2) + '%'}</span></td>
    <td class="num">
      <div class="weight-wrap">
        <div class="weight-bar" style="width:${barW}px"></div>
        <span>${isNaN(row.weight) ? '—' : row.weight.toFixed(1) + '%'}</span>
      </div>
    </td>`;
}

/* ── Summary bar ── */
function renderSummary() {
  let totalValue = 0, totalCost = 0, dayGain = 0, valid = 0;
  portfolio.forEach(pos => {
    const q = quotes[pos.ticker] || {};
    if (!q.price) return;
    valid++;
    totalValue += pos.shares * q.price;
    totalCost  += pos.shares * pos.avg_cost;
    dayGain    += pos.shares * (q.change || 0);
  });
  const pnl       = totalValue - totalCost;
  const pnlPct    = totalCost ? (pnl / totalCost) * 100 : 0;
  const dayPct    = totalValue ? (dayGain / (totalValue - dayGain)) * 100 : 0;
  const dc        = dirClass(pnl);
  const dd        = dirClass(dayGain);

  // Total value — split dollars and cents
  const valStr = totalValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const [dollars, cents] = valStr.split('.');
  document.getElementById('total-value').innerHTML =
    `$${dollars}<span class="cents">.${cents}</span>`;

  const pnlStr = (pnl >= 0 ? '+' : '') + fmt$(pnl);
  const pctStr = (pnlPct >= 0 ? '+' : '') + pnlPct.toFixed(2) + '%';
  const pnlEl  = document.getElementById('total-pnl');
  pnlEl.textContent  = pnlStr;
  pnlEl.className    = dc;
  const pctEl  = document.getElementById('total-pct');
  pctEl.textContent  = pctStr;
  pctEl.className    = dc;

  const dayEl  = document.getElementById('day-pnl');
  dayEl.textContent  = (dayGain >= 0 ? '+' : '') + fmt$(dayGain);
  dayEl.className    = `stat-value ${dd}`;
  document.getElementById('day-pct').textContent =
    (dayPct >= 0 ? '+' : '') + dayPct.toFixed(2) + '% today';

  document.getElementById('total-cost').textContent    = fmt$(totalCost);
  document.getElementById('position-count').textContent = valid;
  document.getElementById('position-sub').textContent   =
    `of ${portfolio.length} positions loaded`;
}

/* ── Hero Banner ── */
let marketData = null;

async function fetchMarket() {
  const res = await apiFetch('/api/market');
  if (res.ok) { marketData = res.indices; renderHeroBanner(); }
}

function renderHeroBanner() {
  // Portfolio section
  let totalValue = 0, totalCost = 0, dayGain = 0;
  portfolio.forEach(pos => {
    const q = quotes[pos.ticker] || {};
    if (!q.price) return;
    totalValue += pos.shares * q.price;
    totalCost  += pos.shares * pos.avg_cost;
    dayGain    += pos.shares * (q.change || 0);
  });
  const pnl    = totalValue - totalCost;
  const pnlPct = totalCost ? (pnl / totalCost) * 100 : 0;
  const dayPct = totalValue ? (dayGain / (totalValue - dayGain)) * 100 : 0;
  const dc = dirClass(dayGain);
  const pc = dirClass(pnl);

  const valStr  = totalValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  document.getElementById('hero-value').textContent = '$' + valStr;

  const heroSub = document.getElementById('hero-sub');
  heroSub.innerHTML = `<span class="${dc}">${dayGain >= 0 ? '+' : ''}${fmt$(dayGain)} today (${dayPct >= 0 ? '+' : ''}${dayPct.toFixed(2)}%)</span>`;

  const dgEl = document.getElementById('hero-day-gain');
  dgEl.textContent  = (dayGain >= 0 ? '+' : '') + fmt$(dayGain);
  dgEl.className    = `hero-stat-val ${dc}`;
  document.getElementById('hero-day-pct').textContent = (dayPct >= 0 ? '+' : '') + dayPct.toFixed(2) + '% today';

  const trEl = document.getElementById('hero-total-return');
  trEl.textContent = (pnlPct >= 0 ? '+' : '') + pnlPct.toFixed(2) + '%';
  trEl.className   = `hero-stat-val ${pc}`;
  document.getElementById('hero-total-pnl').textContent = (pnl >= 0 ? '+' : '') + fmt$(pnl) + ' all time';

  // Index section
  if (!marketData) return;
  const idMap = { 'DJIA': 'idx-DJIA', 'NASDAQ': 'idx-NASDAQ', 'S&P 500': 'idx-SP500', 'VIX': 'idx-VIX' };
  marketData.forEach(idx => {
    const el = document.getElementById(idMap[idx.label]);
    if (!el || idx.error) return;
    const dc2 = idx.change >= 0 ? 'up' : 'down';
    el.querySelector('.hero-idx-val').textContent =
      idx.label === 'VIX'
        ? idx.price.toFixed(2)
        : idx.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const chgEl = el.querySelector('.hero-idx-chg');
    chgEl.textContent = `${idx.change >= 0 ? '+' : ''}${idx.change.toFixed(2)} (${idx.pct >= 0 ? '+' : ''}${idx.pct.toFixed(2)}%)`;
    chgEl.className   = `hero-idx-chg ${dc2}`;
  });
}

/* ── Top movers ── */
function renderMovers() {
  const list = document.getElementById('movers-list');
  const ranked = portfolio
    .map(pos => ({ ticker: pos.ticker, pct: quotes[pos.ticker]?.changePct }))
    .filter(x => x.pct != null)
    .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))
    .slice(0, 5);

  list.innerHTML = ranked.map(m => `
    <div class="mover-row">
      <span class="mover-ticker">${m.ticker}</span>
      <span class="mover-pct ${dirClass(m.pct)}">${m.pct >= 0 ? '+' : ''}${m.pct.toFixed(2)}%</span>
    </div>`).join('');
}

function calcTotalValue() {
  return portfolio.reduce((s, p) => {
    const q = quotes[p.ticker];
    return s + (q?.price ? p.shares * q.price : 0);
  }, 0);
}

/* ── Sparklines ── */
async function fetchSparklines() {
  await Promise.allSettled(portfolio.map(async pos => {
    const res = await apiFetch(`/api/sparkline?ticker=${encodeURIComponent(pos.ticker)}`);
    if (res.ok && res.closes?.length > 1) {
      sparklines[pos.ticker] = res.closes;
      renderSparkline(pos.ticker, res.closes);
      renderTileSparkline(pos.ticker, res.closes);
    } else {
      const el = document.getElementById(`spark-${pos.ticker}`);
      if (el) el.innerHTML = '<span class="spark-loading" style="color:var(--line2)">—</span>';
      const tel = document.getElementById(`tile-spark-${pos.ticker}`);
      if (tel) tel.innerHTML = '';
    }
  }));
}

function renderSparkline(ticker, closes) {
  const el = document.getElementById(`spark-${ticker}`);
  if (!el) return;
  const W = 90, H = 32, P = 3;
  const min = Math.min(...closes), max = Math.max(...closes);
  const range = max - min || 1;
  const dir   = closes[closes.length - 1] >= closes[0] ? 'up' : 'down';
  const xs = closes.map((_, i) => P + (i / (closes.length - 1)) * (W - P * 2));
  const ys = closes.map(c => P + (1 - (c - min) / range) * (H - P * 2));
  const pts = xs.map((x, i) => `${x},${ys[i]}`).join(' ');
  const last = { x: xs[xs.length - 1], y: ys[ys.length - 1] };
  const fill = `${pts} ${W - P},${H - P} ${P},${H - P}`;
  el.innerHTML = `
    <div class="sparkline-wrap">
      <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
        <polygon class="spark-fill ${dir}" points="${fill}"/>
        <polyline class="spark-line ${dir}" points="${pts}"/>
        <circle  class="spark-dot  ${dir}" cx="${last.x}" cy="${last.y}"/>
      </svg>
    </div>`;
}

/* ── Sentiment ── */
async function fetchSentiments() {
  sentimentFetch = true;
  for (const pos of portfolio) {
    const res = await apiFetch(`/api/sentiment?ticker=${encodeURIComponent(pos.ticker)}`);
    if (res.ok && res.total > 0) {
      sentiments[pos.ticker] = res;
      renderSentiment(pos.ticker, res);
    } else {
      const el = document.getElementById(`sent-${pos.ticker}`);
      if (el) el.innerHTML = '<span class="sentiment-na">—</span>';
    }
    await new Promise(r => setTimeout(r, 150));
  }
  sentimentFetch = false;
}

function renderSentiment(ticker, data) {
  const el = document.getElementById(`sent-${ticker}`);
  if (!el) return;
  if (!data.total) { el.innerHTML = '<span class="sentiment-na">—</span>'; return; }
  const bull = data.score, bear = 100 - bull;
  const label = bull >= 60 ? 'Bullish' : bull <= 40 ? 'Bearish' : 'Neutral';
  const snippets = (data.snippets || []).slice(0, 3)
    .map(s => `<div class="tooltip-msg">${escHtml(s)}</div>`).join('');
  el.innerHTML = `
    <div class="sentiment-wrap has-tooltip">
      <div class="sentiment-nums">
        <span class="up" style="font-size:9px">▲ ${bull}%</span>
        <span class="down" style="font-size:9px">${bear}% ▼</span>
      </div>
      <div class="sentiment-bar-track">
        <div class="sentiment-bar-fill" style="width:${bull}%"></div>
      </div>
      <div class="sentiment-meta">${data.total} signals · ${label}</div>
      ${snippets ? `<div class="tooltip">
        <div class="tooltip-title">StockTwits · ${data.msgCount || ''} messages</div>
        ${snippets}
      </div>` : ''}
    </div>`;
}

/* ── Sort ── */
function onSort(col) {
  sortDir = sortCol === col ? sortDir * -1 : 1;
  sortCol = col;
  document.querySelectorAll('thead th').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.col === col)
      th.classList.add(sortDir === 1 ? 'sort-asc' : 'sort-desc');
  });
  if (Object.keys(quotes).length) buildTable();
}

/* ── Market status ── */
function updateMarketStatus() {
  const et   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const min  = et.getHours() * 60 + et.getMinutes();
  const day  = et.getDay();
  const open = day >= 1 && day <= 5 && min >= 570 && min < 960;
  const timeStr = et.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' ET';

  const dot   = document.getElementById('market-dot');
  const label = document.getElementById('market-label');
  dot.className   = 'market-dot' + (open ? ' open' : '');
  label.textContent = open ? `Open · ${timeStr}` : `Closed · ${timeStr}`;
  label.className   = open ? 'market-open-label' : '';

  document.getElementById('market-status').innerHTML = open
    ? '<span class="market-open">● Market Open</span>'
    : '<span class="market-closed">● Market Closed</span>';
}

/* ── Modal ── */
let modalTicker  = null;
let modalRange   = '1D';
let chartCandles = null;

function initModal() {
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-backdrop').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-backdrop')) closeModal();
  });
  document.querySelectorAll('.modal-tab').forEach(btn =>
    btn.addEventListener('click', () => setModalRange(btn.dataset.range))
  );
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
}

async function openModal(ticker) {
  modalTicker = ticker;
  modalRange  = '1D';
  const q   = quotes[ticker] || {};
  const pos = portfolio.find(p => p.ticker === ticker) || {};

  // Header
  document.getElementById('modal-badge').textContent  = ticker.slice(0, 2);
  document.getElementById('modal-ticker').textContent = ticker;
  document.getElementById('modal-name').textContent   = q.shortName || nameCache[ticker] || '';
  document.getElementById('modal-price').textContent  = q.price ? fmt$(q.price) : '—';

  const pill = document.getElementById('modal-change-pill');
  pill.textContent = q.changePct != null
    ? (q.changePct >= 0 ? '+' : '') + q.changePct.toFixed(2) + '%'
    : '—';
  pill.className = 'pill ' + dirClass(q.changePct);

  // Stats
  const mv  = pos.shares * q.price;
  const cb  = pos.shares * pos.avg_cost;
  const pnl = mv - cb;
  document.getElementById('ms-open').textContent   = fmt$(q.open);
  document.getElementById('ms-high').textContent   = fmt$(q.high);
  document.getElementById('ms-low').textContent    = fmt$(q.low);
  document.getElementById('ms-prev').textContent   = fmt$(q.prevClose);
  document.getElementById('ms-shares').textContent = pos.shares ? pos.shares.toLocaleString() : '—';
  document.getElementById('ms-cost').textContent   = fmt$(pos.avg_cost);
  document.getElementById('ms-value').textContent  = fmt$(mv);
  const gainEl   = document.getElementById('ms-gain');
  gainEl.textContent = isNaN(pnl) ? '—' : (pnl >= 0 ? '+' : '') + fmt$(pnl);
  gainEl.className   = 'mstat-val ' + dirClass(pnl);
  const retEl    = document.getElementById('ms-return');
  const retPct   = cb ? (pnl / cb) * 100 : NaN;
  retEl.textContent  = isNaN(retPct) ? '—' : (retPct >= 0 ? '+' : '') + retPct.toFixed(2) + '%';
  retEl.className    = 'mstat-val ' + dirClass(retPct);

  // Set active tab
  document.querySelectorAll('.modal-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.range === '1D')
  );

  document.getElementById('modal-backdrop').classList.remove('hidden');
  document.getElementById('modal-news-list').innerHTML   = '<div class="news-loading">Loading…</div>';
  document.getElementById('modal-reddit-list').innerHTML = '<div class="news-loading">Loading…</div>';
  document.getElementById('modal-reddit-score').textContent = '';
  document.getElementById('modal-reddit-score').className   = 'reddit-score-badge';
  document.getElementById('modal-chart').innerHTML = '';

  await Promise.all([
    loadModalData(ticker, '1D'),
    loadRedditSentiment(ticker),
  ]);
}

function closeModal() {
  document.getElementById('modal-backdrop').classList.add('hidden');
  modalTicker = null;
}

async function setModalRange(range) {
  if (!modalTicker) return;
  modalRange = range;
  document.querySelectorAll('.modal-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.range === range)
  );
  await loadModalData(modalTicker, range); // chart + news only; Reddit stays
}

async function loadModalData(ticker, range) {
  showChartLoading(true);
  const res = await apiFetch(`/api/detail?ticker=${encodeURIComponent(ticker)}&range=${range}`);
  showChartLoading(false);
  if (!res.ok) { renderChartError(res.error); return; }
  console.log('[chart] candles ok:', !!res.candles, 'points:', res.candles?.c?.length);
  if (res.candles?.c?.length > 1) renderModalChart(res.candles, range);
  else renderChartError(res.candles ? 'Not enough data for this range' : 'No chart data available');
  renderNews(res.news || []);
}

function showChartLoading(on) {
  document.getElementById('modal-chart-loading').classList.toggle('hidden', !on);
}

/* ── SVG Chart ── */
function renderModalChart(candles, range) {
  const wrap = document.getElementById('modal-chart');
  // Fixed logical canvas — SVG scales to fill container via width="100%"
  const W   = 760;
  const H   = 180;
  const PAD = { top: 12, right: 56, bottom: 24, left: 12 };
  const cW     = W - PAD.left - PAD.right;
  const cH     = H - PAD.top  - PAD.bottom;

  const closes = candles.c;
  const times  = candles.t;
  const highs  = candles.h;
  const lows   = candles.l;
  const n      = closes.length;
  if (!n) { renderChartError('No data for this range'); return; }

  const minP  = Math.min(...lows)   * 0.999;
  const maxP  = Math.max(...highs)  * 1.001;
  const range2= maxP - minP;
  const isUp  = closes[n - 1] >= closes[0];
  const color = isUp ? '#22c55e' : '#f85149';
  const fillC = isUp ? 'rgba(34,197,94,.1)' : 'rgba(248,81,73,.1)';

  const xOf = i => PAD.left + (i / (n - 1)) * cW;
  const yOf = p => PAD.top  + (1 - (p - minP) / range2) * cH;

  // Build path
  const pts  = closes.map((c, i) => `${xOf(i).toFixed(1)},${yOf(c).toFixed(1)}`).join(' ');
  const fillPath = `M${PAD.left},${yOf(closes[0]).toFixed(1)} ` +
    closes.map((c, i) => `L${xOf(i).toFixed(1)},${yOf(c).toFixed(1)}`).join(' ') +
    ` L${xOf(n - 1).toFixed(1)},${(PAD.top + cH).toFixed(1)} L${PAD.left},${(PAD.top + cH).toFixed(1)} Z`;

  // Y-axis labels (4 ticks)
  const yTicks = [0, 0.33, 0.66, 1].map(t => minP + t * range2);
  const yLabels = yTicks.map(p => `
    <text x="${W - PAD.right + 6}" y="${(yOf(p) + 3).toFixed(1)}"
      font-size="9" fill="#2a4060" font-family="monospace">${p.toFixed(2)}</text>
    <line x1="${PAD.left}" y1="${yOf(p).toFixed(1)}" x2="${W - PAD.right}" y2="${yOf(p).toFixed(1)}"
      stroke="#0f1d2a" stroke-width="0.5"/>`).join('');

  // X-axis time labels (5 ticks)
  const xIdxs  = [0, .25, .5, .75, 1].map(t => Math.round(t * (n - 1)));
  const xLabels = xIdxs.map(i => {
    const d   = new Date(times[i] * 1000);
    const lbl = range === '1D'
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    return `<text x="${xOf(i).toFixed(1)}" y="${H - 4}" font-size="9" fill="#2a4060"
      text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}"
      font-family="monospace">${lbl}</text>`;
  }).join('');

  // Hover data encoded in a data attribute for crosshair
  const hoverData = closes.map((c, i) => `${xOf(i).toFixed(1)}|${c.toFixed(2)}`).join(',');

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}"
      style="cursor:crosshair"
      data-hover="${hoverData}"
      data-padleft="${PAD.left}" data-cw="${cW}" data-n="${n}">
      ${yLabels}
      ${xLabels}
      <path d="${fillPath}" fill="${fillC}" stroke="none"/>
      <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5"
        stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${xOf(n - 1).toFixed(1)}" cy="${yOf(closes[n - 1]).toFixed(1)}"
        r="3" fill="${color}"/>
    </svg>`;

  setupCrosshair(wrap.querySelector('svg'));
}

function setupCrosshair(svg) {
  const crosshair = document.getElementById('modal-crosshair');
  const lineV     = crosshair.querySelector('.crosshair-line-v');
  const label     = document.getElementById('crosshair-label');
  const VB_W      = 760; // must match renderModalChart W

  svg.addEventListener('mousemove', e => {
    const rect     = svg.getBoundingClientRect();
    const mx       = e.clientX - rect.left;            // pixel x in rendered SVG
    const scale    = rect.width / VB_W;                // pixels per viewBox unit
    const hoverPts = svg.dataset.hover.split(',').map(s => s.split('|').map(Number));

    // Find closest point (compare in pixel space)
    let best = hoverPts[0], bestDist = Infinity;
    hoverPts.forEach(([vbX, price]) => {
      const d = Math.abs(vbX * scale - mx);
      if (d < bestDist) { bestDist = d; best = [vbX, price]; }
    });

    const pxLeft = best[0] * scale;
    crosshair.classList.remove('hidden');
    lineV.style.left   = pxLeft + 'px';
    label.style.left   = pxLeft + 'px';
    label.textContent  = '$' + best[1].toFixed(2);
  });

  svg.addEventListener('mouseleave', () => crosshair.classList.add('hidden'));
}

function renderChartError(msg) {
  document.getElementById('modal-chart').innerHTML =
    `<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:12px;color:var(--dim)">${msg}</div>`;
}

/* ── News ── */
function renderNews(news) {
  const list = document.getElementById('modal-news-list');
  if (!news.length) { list.innerHTML = '<div class="no-news">No recent news found.</div>'; return; }
  list.innerHTML = news.map(n => {
    const ago = timeAgo(n.datetime * 1000);
    return `<div class="news-item" onclick="openLink('${n.url}')">
      <div class="news-headline">${escHtml(n.headline)}</div>
      <div class="news-meta">
        <span>${escHtml(n.source)}</span>
        <span>${ago}</span>
      </div>
    </div>`;
  }).join('');
}

async function loadRedditSentiment(ticker) {
  // Use cached table sentiment if available, otherwise fetch fresh
  const cached = sentiments[ticker];
  if (cached?.posts?.length) { renderRedditPosts(cached); return; }

  const res = await apiFetch(`/api/reddit?ticker=${encodeURIComponent(ticker)}`);
  if (res.ok) {
    sentiments[ticker] = res;
    renderSentiment(ticker, res); // update table cell too
    renderRedditPosts(res);
  } else {
    document.getElementById('modal-reddit-list').innerHTML =
      '<div class="no-news">No Reddit data available.</div>';
  }
}

function renderRedditPosts(data) {
  const badge = document.getElementById('modal-reddit-score');
  if (data.score != null) {
    const bull = data.score, bear = 100 - bull;
    const dir  = bull >= 60 ? 'up' : bull <= 40 ? 'down' : 'flat';
    const lbl  = bull >= 60 ? `${bull}% Bullish` : bull <= 40 ? `${bear}% Bearish` : 'Neutral';
    badge.textContent = lbl;
    badge.className   = `reddit-score-badge ${dir}`;
  }

  const list = document.getElementById('modal-reddit-list');
  if (!data.posts?.length) {
    list.innerHTML = '<div class="no-news">No scored posts found this week.</div>'; return;
  }

  list.innerHTML = data.posts.map(p => {
    const ago = timeAgo(p.created * 1000);
    return `<div class="reddit-item" onclick="openLink('${p.url}')">
      <div class="reddit-title">
        <span class="sentiment-tag ${p.sentiment}">${p.sentiment}</span>
        ${escHtml(p.title)}
      </div>
      <div class="reddit-meta">
        <span class="reddit-sub">r/${p.sub}</span>
        <span class="reddit-ups">▲ ${(p.ups || 0).toLocaleString()}</span>
        <span>${ago}</span>
      </div>
    </div>`;
  }).join('');
}

function openLink(url) {
  window.open(url, '_blank');
}

function timeAgo(ms) {
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60000);
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/* ── Helpers ── */
async function apiFetch(path) {
  try { return await (await fetch(path)).json(); }
  catch (e) { return { ok: false, error: e.message }; }
}
function showLoading(on) { document.getElementById('loading-overlay').classList.toggle('hidden', !on); }
function showError(msg)  { const b = document.getElementById('error-banner'); b.textContent = '⚠ ' + msg; b.classList.remove('hidden'); }
function hideError()     { document.getElementById('error-banner').classList.add('hidden'); }
function dirClass(v)     { return v == null || isNaN(v) ? 'neutral' : v > 0 ? 'up' : v < 0 ? 'down' : 'neutral'; }
function fmt$(n)         { return n == null || isNaN(n) ? '—' : '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function escHtml(s)      { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
