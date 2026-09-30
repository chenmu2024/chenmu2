import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.149/build/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.149/build/pdf.worker.min.mjs';

const state = { older: null, newer: null, comparing: false };
const $ = (id) => document.getElementById(id);
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const fmtMoney = (v) => Number.isFinite(v) ? money.format(v) : '—';
const fmtPct = (v) => Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(1)}%` : '—';
const round = (n, d = 2) => Number(n.toFixed(d));
const toNumber = (s) => {
  const n = Number(String(s).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : undefined;
};

const MONEY_RE = /-?\$?\s*\d{1,3}(?:,\d{3})*(?:\.\d{2,4})/g;
const MATERIAL_RE = /\b(?:X\d{4,8}|[A-Z]{1,3}\d{3,8}|\d{5,8})\b/;
const FEE_RE = /service charge|service fee|environment(?:al)?(?: charge| fee)?|fuel(?: surcharge| fee)?|delivery(?: charge| fee)?|route charge|surcharge|admin(?:istrative)? fee|processing fee/i;
const SUMMARY_RE = /\b(?:subtotal|invoice total|total due|amount due|balance due|payment|credit|tax total|previous balance)\b/i;
const NOTICE_RE = /price adjustment|annual price|rate adjustment|pricing adjustment|price increase|service adjustment/i;

function fire(name, detail = {}) {
  window.dispatchEvent(new CustomEvent('invoicechecker:event', { detail: { name, ...detail } }));
}

function setFile(slot, file) {
  const card = $(`${slot}-card`);
  const name = $(`${slot}-name`);
  const icon = $(`${slot}-icon`);
  const err = $(`${slot}-error`);
  err.textContent = '';
  card.classList.remove('is-error');

  if (!file || (!(file.type === 'application/pdf') && !file.name.toLowerCase().endsWith('.pdf'))) {
    state[slot] = null;
    card.classList.add('is-error');
    err.textContent = 'Please choose a PDF file.';
    refreshCompareButton();
    return;
  }

  if (file.size > 15 * 1024 * 1024) {
    state[slot] = null;
    card.classList.add('is-error');
    err.textContent = 'Please use a PDF smaller than 15 MB.';
    refreshCompareButton();
    return;
  }

  state[slot] = file;
  name.textContent = file.name;
  icon.textContent = '✓';
  card.classList.add('has-file');
  fire('upload_selected', { slot, size: file.size });
  refreshCompareButton();
}

function refreshCompareButton() {
  $('compare-button').disabled = !(state.older && state.newer) || state.comparing;
}

['older', 'newer'].forEach((slot) => {
  $(`${slot}-file`).addEventListener('change', (e) => setFile(slot, e.target.files?.[0]));
  const card = $(`${slot}-card`);
  card.addEventListener('dragover', (e) => {
    e.preventDefault();
    card.classList.add('is-dragging');
  });
  card.addEventListener('dragleave', () => card.classList.remove('is-dragging'));
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    card.classList.remove('is-dragging');
    setFile(slot, e.dataTransfer.files?.[0]);
  });
});

async function extractPdf(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjsLib.getDocument({ data: bytes, isEvalSupported: false });
  const doc = await loadingTask.promise;
  const pages = [];
  const allLines = [];

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
    updateProgress(`Reading page ${pageNum} of ${doc.numPages}…`);
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    const tokens = [];

    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue;
      tokens.push({ text: item.str.trim(), x: item.transform[4], y: item.transform[5] });
    }

    tokens.sort((a, b) => Math.abs(a.y - b.y) > 2.5 ? b.y - a.y : a.x - b.x);
    const groups = [];
    for (const token of tokens) {
      const last = groups.at(-1);
      if (!last || Math.abs(last[0].y - token.y) > 2.5) groups.push([token]);
      else last.push(token);
    }

    const lines = groups.map((group) => {
      group.sort((a, b) => a.x - b.x);
      return group.map((t) => t.text).join(' ').replace(/\s+/g, ' ').trim();
    }).filter(Boolean);

    pages.push(lines);
    allLines.push(...lines);
  }

  if (allLines.length < 4) {
    throw new Error('This PDF has little or no selectable text. Please download the original digital invoice PDF instead of using a scan or photo.');
  }

  return { pages, lines: allLines, pageCount: doc.numPages };
}

function lastMoney(line) {
  const matches = [...line.matchAll(MONEY_RE)].map((m) => m[0]);
  return matches.length ? toNumber(matches.at(-1)) : undefined;
}

function moneyAfter(lines, regexes) {
  for (const line of lines) {
    if (!regexes.some((r) => r.test(line))) continue;
    const value = lastMoney(line);
    if (Number.isFinite(value)) return value;
  }
}

function parseDateString(value) {
  if (!value) return undefined;
  const mdY = value.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);
  if (mdY) {
    let year = Number(mdY[3]);
    if (year < 100) year += 2000;
    const date = new Date(year, Number(mdY[1]) - 1, Number(mdY[2]));
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  const long = new Date(value);
  return Number.isNaN(long.getTime()) ? undefined : long;
}

function parseDate(lines) {
  const patterns = [
    /invoice\s*date\s*[:#-]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i,
    /\bdate\s*[:#-]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i,
    /(\d{1,2}[\/-]\d{1,2}[\/-]\d{4})/
  ];
  for (const line of lines) {
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match) return match[1];
    }
  }
}

function parseInvoiceNumber(lines) {
  const patterns = [
    /invoice\s*(?:#|no\.?|number)?\s*[:#-]?\s*([A-Z0-9-]{5,})/i,
    /invoice\s+([A-Z0-9-]{6,})/i
  ];
  for (const line of lines) {
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match && !/date/i.test(match[1])) return match[1];
    }
  }
}

function classify(description) {
  const d = description.toLowerCase();
  if (/environment|env\.?\s*(?:chg|charge|fee)/.test(d)) return 'environmental_fee';
  if (/fuel/.test(d)) return 'fuel_fee';
  if (/delivery|route charge/.test(d)) return 'delivery_fee';
  if (/service charge|service fee/.test(d)) return 'service_fee';
  if (/surcharge|admin(?:istrative)? fee|processing fee/.test(d)) return 'other_surcharge';
  return 'rental_item';
}

function normalizeDescription(value) {
  return value.toLowerCase()
    .replace(/\b(?:freq|exch|qty|quantity|unit price|line total|tax)\b/gi, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseLine(line) {
  const lower = line.toLowerCase();
  if (SUMMARY_RE.test(lower) && !FEE_RE.test(lower)) return undefined;
  if (/\b(?:invoice|customer|account|sold to|bill to|ship to|route|page\s+\d+)\b/i.test(lower) && !FEE_RE.test(lower)) return undefined;

  const moneyMatches = [...line.matchAll(MONEY_RE)].map((m) => ({ text: m[0], value: toNumber(m[0]), index: m.index ?? 0 }));
  const isFee = FEE_RE.test(line);
  if (!moneyMatches.length || (moneyMatches.length < 2 && !isFee)) return undefined;

  const materialMatch = line.match(MATERIAL_RE);
  const materialCode = materialMatch?.[0];
  const last = moneyMatches.at(-1)?.value;
  const previous = moneyMatches.at(-2)?.value;
  let lineTotal = last;
  let unitPrice = moneyMatches.length >= 2 ? previous : undefined;
  let quantity;

  if (Number.isFinite(unitPrice) && unitPrice !== 0 && Number.isFinite(lineTotal)) {
    const inferred = lineTotal / unitPrice;
    if (inferred > 0 && inferred < 10000 && Math.abs(inferred - Math.round(inferred)) < 0.015) quantity = Math.round(inferred);
  }

  if (isFee && moneyMatches.length === 1) unitPrice = undefined;

  let description = line;
  for (const match of [...moneyMatches].reverse()) {
    description = description.slice(0, match.index) + ' ' + description.slice(match.index + match.text.length);
  }
  if (materialCode) description = description.replace(materialCode, ' ');
  description = description.replace(/\s+/g, ' ').trim();
  if (description.length < 2) return undefined;

  const lineType = classify(description);
  const confidence = materialCode && Number.isFinite(lineTotal) ? 0.96 : isFee && Number.isFinite(lineTotal) ? 0.93 : 0.80;
  return {
    materialCode,
    description,
    normalizedDescription: normalizeDescription(description),
    quantity,
    unitPrice,
    lineTotal,
    lineType,
    confidence,
    raw: line
  };
}

function stableKey(line) {
  if (line.materialCode) return `material:${line.materialCode.toLowerCase()}|${line.normalizedDescription.slice(0, 42)}`;
  return `type:${line.lineType}|${line.normalizedDescription.slice(0, 64)}`;
}

function aggregateLines(lines) {
  const groups = new Map();
  for (const line of lines) {
    const key = stableKey(line);
    const group = groups.get(key) || [];
    group.push(line);
    groups.set(key, group);
  }

  return [...groups.entries()].map(([key, group]) => {
    const unitPrices = group.map((x) => x.unitPrice).filter(Number.isFinite);
    const quantities = group.map((x) => x.quantity).filter(Number.isFinite);
    const totals = group.map((x) => x.lineTotal).filter(Number.isFinite);
    const uniquePrices = [...new Set(unitPrices.map((v) => round(v, 4)))];
    const representative = group[0];
    return {
      key,
      materialCode: representative.materialCode,
      description: representative.description,
      normalizedDescription: representative.normalizedDescription,
      lineType: representative.lineType,
      lineCount: group.length,
      quantity: quantities.length ? quantities.reduce((a, b) => a + b, 0) : undefined,
      unitPrice: uniquePrices.length === 1 ? uniquePrices[0] : undefined,
      lineTotal: totals.length ? round(totals.reduce((a, b) => a + b, 0), 4) : undefined,
      confidence: Math.min(...group.map((x) => x.confidence)),
      sourceLines: group
    };
  });
}

function detectNotices(lines) {
  return lines.filter((line) => NOTICE_RE.test(line)).slice(0, 3);
}

function parseInvoice(filename, pdf) {
  const { lines } = pdf;
  const raw = lines.join('\n');
  const vendor = /\bcintas\b/i.test(raw) ? 'Cintas' : 'Unknown';
  const invoiceDate = parseDate(lines);
  const invoiceNumber = parseInvoiceNumber(lines);
  const total = moneyAfter(lines, [/\btotal due\b/i, /\binvoice total\b/i, /^\s*total\s+/i, /\bamount due\b/i]);
  const parsedLines = lines.map(parseLine).filter(Boolean);
  const aggregated = aggregateLines(parsedLines);
  const notices = detectNotices(lines);
  const warnings = [];

  if (vendor === 'Unknown') warnings.push('The document was not confidently identified as a Cintas invoice.');
  if (!invoiceDate) warnings.push('Invoice date could not be identified with high confidence.');
  if (!invoiceNumber) warnings.push('Invoice number could not be identified with high confidence.');
  if (!Number.isFinite(total)) warnings.push('The printed invoice total could not be verified.');
  if (aggregated.length < 2) warnings.push('Only a small number of comparable line items could be extracted.');

  let score = 0.88;
  if (vendor === 'Unknown') score -= 0.14;
  if (!invoiceDate) score -= 0.04;
  if (!invoiceNumber) score -= 0.02;
  if (!Number.isFinite(total)) score -= 0.08;
  if (aggregated.length < 2) score -= 0.10;

  return {
    filename,
    vendor,
    invoiceDate,
    invoiceDateObject: parseDateString(invoiceDate),
    invoiceNumber,
    total,
    lines: aggregated,
    confidence: Math.max(0.55, Math.min(0.99, score)),
    warnings,
    notices,
    pageCount: pdf.pageCount
  };
}

function percentChange(oldValue, newValue) {
  return oldValue && Number.isFinite(oldValue) && Number.isFinite(newValue)
    ? round(((newValue - oldValue) / oldValue) * 100, 1)
    : undefined;
}

function chooseOrder(first, second) {
  if (first.invoiceDateObject && second.invoiceDateObject && first.invoiceDateObject > second.invoiceDateObject) {
    return { older: second, newer: first, autoSwapped: true };
  }
  return { older: first, newer: second, autoSwapped: false };
}

function compare(first, second) {
  const { older, newer, autoSwapped } = chooseOrder(first, second);
  const findings = [];
  const totalChange = Number.isFinite(older.total) && Number.isFinite(newer.total) ? round(newer.total - older.total) : undefined;
  const totalPercentChange = percentChange(older.total, newer.total);

  if (Number.isFinite(totalChange) && Math.abs(totalChange) >= 0.01) {
    findings.push({
      type: 'TOTAL_CHANGED',
      title: 'Invoice total changed',
      description: `The printed invoice total changed from ${fmtMoney(older.total)} to ${fmtMoney(newer.total)}.`,
      oldValue: older.total,
      newValue: newer.total,
      percentChange: totalPercentChange,
      annualizedImpact: round(totalChange * 52),
      confidence: Math.min(older.confidence, newer.confidence)
    });
  }

  const oldMap = new Map(older.lines.map((line) => [line.key, line]));
  const newMap = new Map(newer.lines.map((line) => [line.key, line]));

  for (const [key, current] of newMap) {
    const prior = oldMap.get(key);
    if (!prior) {
      const isFee = current.lineType.includes('fee') || current.lineType.includes('surcharge');
      findings.push({
        type: isFee ? 'NEW_FEE' : 'NEW_ITEM',
        title: isFee ? 'New recurring fee detected' : 'New line item detected',
        description: current.description,
        newValue: current.lineTotal ?? current.unitPrice,
        annualizedImpact: Number.isFinite(current.lineTotal) ? round(current.lineTotal * 52) : undefined,
        confidence: current.confidence,
        key
      });
      continue;
    }

    if (Number.isFinite(prior.unitPrice) && Number.isFinite(current.unitPrice) && Math.abs(prior.unitPrice - current.unitPrice) > 0.0001) {
      const isFee = current.lineType.includes('fee') || current.lineType.includes('surcharge');
      const delta = current.unitPrice - prior.unitPrice;
      findings.push({
        type: isFee ? 'FEE_CHANGED' : 'UNIT_PRICE_CHANGED',
        title: isFee ? 'Fee changed' : 'Unit price changed',
        description: current.description,
        oldValue: prior.unitPrice,
        newValue: current.unitPrice,
        percentChange: percentChange(prior.unitPrice, current.unitPrice),
        annualizedImpact: round(delta * (current.quantity || 1) * 52),
        confidence: Math.min(prior.confidence, current.confidence),
        key
      });
    } else if (Number.isFinite(prior.lineTotal) && Number.isFinite(current.lineTotal) && Math.abs(prior.lineTotal - current.lineTotal) > 0.01 && current.lineType !== 'rental_item') {
      const delta = current.lineTotal - prior.lineTotal;
      findings.push({
        type: 'FEE_CHANGED',
        title: 'Recurring charge changed',
        description: current.description,
        oldValue: prior.lineTotal,
        newValue: current.lineTotal,
        percentChange: percentChange(prior.lineTotal, current.lineTotal),
        annualizedImpact: round(delta * 52),
        confidence: Math.min(prior.confidence, current.confidence),
        key
      });
    }

    if (Number.isFinite(prior.quantity) && Number.isFinite(current.quantity) && prior.quantity !== current.quantity) {
      findings.push({
        type: 'QUANTITY_CHANGED',
        title: 'Quantity changed',
        description: current.description,
        oldValue: prior.quantity,
        newValue: current.quantity,
        percentChange: percentChange(prior.quantity, current.quantity),
        confidence: Math.min(prior.confidence, current.confidence),
        key
      });
    }
  }

  for (const [key, prior] of oldMap) {
    if (!newMap.has(key)) {
      findings.push({
        type: 'REMOVED_ITEM',
        title: 'Line item no longer appears',
        description: prior.description,
        oldValue: prior.lineTotal ?? prior.unitPrice,
        confidence: prior.confidence,
        key
      });
    }
  }

  findings.sort((a, b) => Math.abs(b.annualizedImpact || 0) - Math.abs(a.annualizedImpact || 0));

  return {
    older,
    newer,
    autoSwapped,
    totalChange,
    totalPercentChange,
    annualizedDifference: Number.isFinite(totalChange) ? round(totalChange * 52) : undefined,
    findings,
    notices: [...older.notices, ...newer.notices].slice(0, 3)
  };
}

function demo() {
  const make = (filename, date, total, rows) => ({
    filename,
    vendor: 'Cintas',
    invoiceDate: date,
    invoiceDateObject: parseDateString(date),
    total,
    confidence: 0.99,
    warnings: [],
    notices: date === '05/06/2024' ? ['Annual price adjustment notice'] : [],
    lines: rows.map(([materialCode, description, unitPrice]) => ({
      key: `material:${materialCode.toLowerCase()}|${normalizeDescription(description)}`,
      materialCode,
      description,
      normalizedDescription: normalizeDescription(description),
      quantity: 1,
      unitPrice,
      lineTotal: unitPrice,
      lineType: description.includes('Service') ? 'service_fee' : 'rental_item',
      confidence: 0.99
    }))
  });

  const older = make('cintas-older-demo.pdf', '05/06/2024', 97.38, [
    ['X10184', 'Entry Mat', 6.96],
    ['X10186', 'Scraper Mat', 8.12],
    ['X10189', 'Logo Mat', 11.02],
    ['SERVICE', 'Service Charge', 6.90]
  ]);
  const newer = make('cintas-newer-demo.pdf', '06/03/2024', 115.88, [
    ['X10184', 'Entry Mat', 8.282],
    ['X10186', 'Scraper Mat', 9.662],
    ['X10189', 'Logo Mat', 13.113],
    ['SERVICE', 'Service Charge', 8.21]
  ]);
  return compare(older, newer);
}

function icon(finding) {
  if (finding.type === 'TOTAL_CHANGED') return '↗';
  if (finding.type.includes('FEE')) return '$';
  if (finding.type === 'NEW_ITEM') return '+';
  if (finding.type === 'REMOVED_ITEM') return '−';
  if (finding.type === 'QUANTITY_CHANGED') return '#';
  return '∆';
}

function render(result) {
  $('results').hidden = false;
  $('results-title').textContent = Number.isFinite(result.totalPercentChange)
    ? `Your Cintas bill changed ${fmtPct(result.totalPercentChange)}`
    : 'Your Cintas bill has changes';

  $('metric-old').textContent = fmtMoney(result.older.total);
  $('metric-new').textContent = fmtMoney(result.newer.total);
  $('metric-old-date').textContent = result.older.invoiceDate || result.older.filename;
  $('metric-new-date').textContent = result.newer.invoiceDate || result.newer.filename;
  $('metric-diff').textContent = Number.isFinite(result.totalChange) ? `${result.totalChange > 0 ? '+' : ''}${fmtMoney(result.totalChange)}` : '—';
  $('metric-pct').textContent = fmtPct(result.totalPercentChange);
  $('metric-annual').textContent = Number.isFinite(result.annualizedDifference) ? `${result.annualizedDifference > 0 ? '+' : ''}${fmtMoney(result.annualizedDifference)}` : '—';
  $('difference-card').classList.toggle('positive', (result.totalChange || 0) < 0);

  $('count-price').textContent = result.findings.filter((f) => f.type === 'UNIT_PRICE_CHANGED').length;
  $('count-fee').textContent = result.findings.filter((f) => f.type === 'FEE_CHANGED' || f.type === 'NEW_FEE').length;
  $('count-new').textContent = result.findings.filter((f) => f.type === 'NEW_ITEM').length;
  $('count-removed').textContent = result.findings.filter((f) => f.type === 'REMOVED_ITEM').length;

  const warnings = [...(result.older.warnings || []), ...(result.newer.warnings || [])];
  if (result.autoSwapped) warnings.unshift('The invoice dates showed the files were uploaded in reverse order, so we corrected the order automatically.');
  if (result.notices.length) warnings.unshift('A price/rate adjustment notice may be present on one of the invoices. A detected increase is not necessarily a billing error.');
  $('review-note').hidden = !warnings.length;
  $('review-note-text').textContent = warnings[0] || '';
  $('confidence').textContent = `Parser confidence ${Math.round(Math.min(result.older.confidence, result.newer.confidence) * 100)}%`;

  const list = $('finding-list');
  list.innerHTML = '';
  if (!result.findings.length) {
    list.innerHTML = '<div class="empty-state"><strong>No comparable changes were confidently detected.</strong><span>The PDFs were readable, but the checker did not find a supported change between them.</span></div>';
  } else {
    result.findings.forEach((finding) => {
      const row = document.createElement('article');
      row.className = 'finding-row';
      const oldValue = Number.isFinite(finding.oldValue) ? fmtMoney(finding.oldValue) : finding.oldValue ?? '';
      const newValue = Number.isFinite(finding.newValue) ? fmtMoney(finding.newValue) : finding.newValue ?? '';
      row.innerHTML = `<div class="finding-icon">${icon(finding)}</div><div class="finding-main"><strong>${escapeHtml(finding.title)}</strong><span>${escapeHtml(finding.description)}</span>${Number.isFinite(finding.annualizedImpact) ? `<small>${finding.annualizedImpact >= 0 ? '+' : ''}${fmtMoney(finding.annualizedImpact)}/yr estimate</small>` : ''}</div><div class="finding-values">${oldValue !== '' ? `<span>${escapeHtml(String(oldValue))}</span>` : ''}${newValue !== '' ? `<strong>→ ${escapeHtml(String(newValue))}</strong>` : ''}${Number.isFinite(finding.percentChange) ? `<em>${fmtPct(finding.percentChange)}</em>` : ''}</div>`;
      list.appendChild(row);
    });
  }

  $('copy-summary').hidden = false;
  $('copy-summary').onclick = async () => {
    const summary = buildSummary(result);
    try {
      await navigator.clipboard.writeText(summary);
      $('copy-summary').textContent = 'Copied ✓';
      setTimeout(() => { $('copy-summary').textContent = 'Copy summary'; }, 1600);
    } catch {
      window.prompt('Copy this summary:', summary);
    }
  };

  fire('result_view', { findings: result.findings.length, confidence: Math.min(result.older.confidence, result.newer.confidence) });
  $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function buildSummary(result) {
  const lines = [
    'Cintas Invoice Checker summary',
    `${result.older.invoiceDate || result.older.filename}: ${fmtMoney(result.older.total)}`,
    `${result.newer.invoiceDate || result.newer.filename}: ${fmtMoney(result.newer.total)}`,
    `Difference: ${Number.isFinite(result.totalChange) ? `${result.totalChange > 0 ? '+' : ''}${fmtMoney(result.totalChange)} (${fmtPct(result.totalPercentChange)})` : 'Not verified'}`,
    ''
  ];
  for (const finding of result.findings.slice(0, 12)) {
    lines.push(`- ${finding.title}: ${finding.description}${Number.isFinite(finding.percentChange) ? ` (${fmtPct(finding.percentChange)})` : ''}`);
  }
  lines.push('', 'This comparison identifies billing changes only. It does not determine whether a charge violates an agreement.');
  return lines.join('\n');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

function updateProgress(message) {
  $('analysis-status').textContent = message;
}

$('compare-button').addEventListener('click', async () => {
  const error = $('global-error');
  error.hidden = true;
  state.comparing = true;
  refreshCompareButton();
  $('analysis-progress').hidden = false;
  updateProgress('Opening PDFs…');
  fire('compare_start');

  try {
    const [olderPdf, newerPdf] = await Promise.all([extractPdf(state.older), extractPdf(state.newer)]);
    updateProgress('Matching invoice lines…');
    const older = parseInvoice(state.older.name, olderPdf);
    const newer = parseInvoice(state.newer.name, newerPdf);

    if (older.vendor !== 'Cintas' && newer.vendor !== 'Cintas') {
      throw new Error('These files could not be identified as Cintas invoices. Please use original Cintas invoice PDFs.');
    }
    if (older.invoiceNumber && newer.invoiceNumber && older.invoiceNumber === newer.invoiceNumber) {
      throw new Error('These appear to be the same invoice. Please upload two different invoice periods.');
    }

    render(compare(older, newer));
  } catch (errorValue) {
    error.textContent = errorValue?.message || 'We could not read these PDFs.';
    error.hidden = false;
    fire('parse_failed');
  } finally {
    state.comparing = false;
    $('analysis-progress').hidden = true;
    updateProgress('');
    refreshCompareButton();
  }
});

$('demo-button').addEventListener('click', () => {
  fire('demo_view');
  render(demo());
});

$('reset-button').addEventListener('click', () => {
  state.older = null;
  state.newer = null;
  ['older', 'newer'].forEach((slot) => {
    $(`${slot}-file`).value = '';
    $(`${slot}-name`).textContent = slot === 'older' ? 'Drop your earlier Cintas PDF here' : 'Drop your later Cintas PDF here';
    $(`${slot}-icon`).textContent = '↑';
    $(`${slot}-card`).classList.remove('has-file', 'is-error', 'is-dragging');
    $(`${slot}-error`).textContent = '';
  });
  $('results').hidden = true;
  $('copy-summary').hidden = true;
  refreshCompareButton();
  document.querySelector('#checker').scrollIntoView({ behavior: 'smooth', block: 'center' });
});

fire('landing_view');
