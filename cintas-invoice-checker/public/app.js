import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@latest/build/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@latest/build/pdf.worker.min.mjs';

const state = { older: null, newer: null };
const $ = (id) => document.getElementById(id);
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const fmtMoney = (v) => Number.isFinite(v) ? money.format(v) : '—';
const fmtPct = (v) => Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(1)}%` : '—';
const round = (n, d=2) => Number(n.toFixed(d));
const num = (s) => { const n = Number(String(s).replace(/[$,\s]/g,'')); return Number.isFinite(n) ? n : undefined; };

function setFile(slot, file) {
  const card = $(`${slot}-card`), name = $(`${slot}-name`), icon = $(`${slot}-icon`), err = $(`${slot}-error`);
  err.textContent = '';
  card.classList.remove('is-error');
  if (!file || (!(file.type === 'application/pdf') && !file.name.toLowerCase().endsWith('.pdf'))) {
    state[slot] = null; card.classList.add('is-error'); err.textContent = 'Please choose a PDF file.'; return;
  }
  state[slot] = file; name.textContent = file.name; icon.textContent = '✓'; card.classList.add('has-file');
  $('compare-button').disabled = !(state.older && state.newer);
}

['older','newer'].forEach(slot => {
  $(`${slot}-file`).addEventListener('change', e => setFile(slot, e.target.files?.[0]));
  const card = $(`${slot}-card`);
  card.addEventListener('dragover', e => e.preventDefault());
  card.addEventListener('drop', e => { e.preventDefault(); setFile(slot, e.dataTransfer.files?.[0]); });
});

async function extractPdfLines(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
  const allLines = [];
  for (let pageNum=1; pageNum<=doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    const tokens = [];
    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue;
      tokens.push({ text:item.str.trim(), x:item.transform[4], y:item.transform[5] });
    }
    tokens.sort((a,b) => Math.abs(a.y-b.y)>2.5 ? b.y-a.y : a.x-b.x);
    const groups=[];
    for (const token of tokens) {
      const last=groups.at(-1);
      if (!last || Math.abs(last[0].y-token.y)>2.5) groups.push([token]); else last.push(token);
    }
    for (const group of groups) {
      group.sort((a,b)=>a.x-b.x);
      const line=group.map(t=>t.text).join(' ').replace(/\s+/g,' ').trim();
      if(line) allLines.push(line);
    }
  }
  if(allLines.length<4) throw new Error('This PDF does not contain enough selectable text. Please use the original digital invoice PDF.');
  return allLines;
}

const moneyRegex=/-?\$?\s*\d{1,3}(?:,\d{3})*(?:\.\d{2,4})?/g;
function moneyAfter(lines, regexes) {
  for(const line of lines){
    if(!regexes.some(r=>r.test(line))) continue;
    const matches=[...line.matchAll(moneyRegex)].map(m=>m[0]);
    if(matches.length){ const n=num(matches.at(-1)); if(n!==undefined) return n; }
  }
}
function parseDate(lines){
  const ps=[/invoice\s*date\s*[:#-]?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i,/date\s*[:#-]?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i,/(\d{1,2}\/\d{1,2}\/\d{4})/];
  for(const line of lines) for(const p of ps){ const m=line.match(p); if(m) return m[1]; }
}
function parseInvoiceNumber(lines){
  const ps=[/invoice\s*(?:#|no\.?|number)?\s*[:#-]?\s*([A-Z0-9-]{5,})/i,/invoice\s+([A-Z0-9-]{6,})/i];
  for(const line of lines) for(const p of ps){ const m=line.match(p); if(m && !/date/i.test(m[1])) return m[1]; }
}
function classify(desc){ const d=desc.toLowerCase(); if(/environment|env\.?\s*(chg|charge|fee)/.test(d))return'environmental_fee'; if(/fuel/.test(d))return'fuel_fee'; if(/delivery|route charge/.test(d))return'delivery_fee'; if(/service charge|service fee/.test(d))return'service_fee'; if(/surcharge|admin fee|processing fee/.test(d))return'other_surcharge'; return'rental_item'; }
function parseLine(line){
  const lower=line.toLowerCase();
  if(/invoice|customer|account|route|page\s+\d+|subtotal|total due|amount due|payment/.test(lower)&&!/service charge|environment|fuel|delivery|surcharge/.test(lower)) return;
  const mm=[...line.matchAll(moneyRegex)].map(m=>m[0]); const charge=/service charge|environment|fuel|delivery|surcharge|fee/i.test(line);
  if(mm.length<1 || (mm.length<2&&!charge)) return;
  const numbers=mm.map(num).filter(v=>v!==undefined); if(!numbers.length)return;
  const material=line.match(/\b(?:X\d{4,8}|[A-Z]{1,3}\d{3,8}|\d{5,8})\b/)?.[0];
  const freq=line.match(/\b(?:FREQ\s*)?(0?[1-9]|1[0-2])\b/i)?.[1];
  let quantity,unitPrice,lineTotal;
  if(numbers.length>=2){unitPrice=numbers.at(-2);lineTotal=numbers.at(-1);const q=numbers.at(-3);if(Number.isInteger(q)&&q>=0&&q<10000)quantity=q;} else lineTotal=numbers[0];
  const description=line.replace(moneyRegex,' ').replace(material||'',' ').replace(/\s+/g,' ').trim(); if(description.length<2)return;
  return{materialCode:material,description,frequency:freq,quantity,unitPrice,lineTotal,lineType:classify(description),confidence:material&&lineTotal!==undefined?.94:charge?.91:.78,raw:line};
}
function parseInvoice(filename, lines){
  const raw=lines.join('\n'), vendor=/\bcintas\b/i.test(raw)?'Cintas':'Unknown';
  const invoiceDate=parseDate(lines), invoiceNumber=parseInvoiceNumber(lines), total=moneyAfter(lines,[/\btotal due\b/i,/\binvoice total\b/i,/^\s*total\s+/i,/\bamount due\b/i]);
  const parsed=lines.map(parseLine).filter(Boolean).filter((l,i,a)=>a.findIndex(o=>o.raw===l.raw)===i);
  const warnings=[]; if(vendor==='Unknown')warnings.push('The document was not confidently identified as a Cintas invoice.'); if(!invoiceDate)warnings.push('Invoice date could not be identified with high confidence.'); if(!invoiceNumber)warnings.push('Invoice number could not be identified with high confidence.');
  let score=.86;
  if(total===undefined){score-=.08;warnings.push('Invoice total could not be verified.');}
  if(parsed.length<2){score-=.12;warnings.push('Only a small number of comparable line items could be extracted.');}
  return{filename,vendor,invoiceDate,invoiceNumber,total,lines:parsed,confidence:Math.max(.55,Math.min(.99,score)),warnings};
}
function key(l){return`${(l.materialCode||'').toLowerCase()}|${l.description.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().slice(0,70)}|${l.frequency||''}`;}
function pct(a,b){return a&&Number.isFinite(a)&&Number.isFinite(b)?round((b-a)/a*100,1):undefined;}
function compare(oldI,newI){
  const findings=[], totalChange=Number.isFinite(oldI.total)&&Number.isFinite(newI.total)?round(newI.total-oldI.total):undefined, totalPct=pct(oldI.total,newI.total);
  if(Number.isFinite(totalChange)&&Math.abs(totalChange)>=.01)findings.push({type:'TOTAL_CHANGED',title:'Invoice total changed',description:`The printed invoice total changed from ${fmtMoney(oldI.total)} to ${fmtMoney(newI.total)}.`,oldValue:oldI.total,newValue:newI.total,percentChange:totalPct,annualizedImpact:round(totalChange*52),confidence:Math.min(oldI.confidence,newI.confidence)});
  const om=new Map(oldI.lines.map(l=>[key(l),l])), nm=new Map(newI.lines.map(l=>[key(l),l]));
  for(const[k,n]of nm){const o=om.get(k);if(!o){const isFee=n.lineType.includes('fee')||n.lineType.includes('surcharge');findings.push({type:isFee?'NEW_FEE':'NEW_ITEM',title:isFee?'New recurring fee detected':'New line item detected',description:n.description,newValue:n.lineTotal??n.unitPrice,annualizedImpact:Number.isFinite(n.lineTotal)?round(n.lineTotal*52):undefined,confidence:n.confidence,key:k});continue;}if(Number.isFinite(o.unitPrice)&&Number.isFinite(n.unitPrice)&&Math.abs(o.unitPrice-n.unitPrice)>.0001){const isFee=n.lineType.includes('fee')||n.lineType.includes('surcharge'),delta=n.unitPrice-o.unitPrice;findings.push({type:isFee?'FEE_CHANGED':'UNIT_PRICE_CHANGED',title:isFee?'Fee changed':'Unit price changed',description:n.description,oldValue:o.unitPrice,newValue:n.unitPrice,percentChange:pct(o.unitPrice,n.unitPrice),annualizedImpact:round(delta*(n.quantity||1)*52),confidence:Math.min(o.confidence,n.confidence),key:k});}if(Number.isFinite(o.quantity)&&Number.isFinite(n.quantity)&&o.quantity!==n.quantity)findings.push({type:'QUANTITY_CHANGED',title:'Quantity changed',description:n.description,oldValue:o.quantity,newValue:n.quantity,percentChange:pct(o.quantity,n.quantity),confidence:Math.min(o.confidence,n.confidence),key:k});}
  for(const[k,o]of om)if(!nm.has(k))findings.push({type:'REMOVED_ITEM',title:'Line item no longer appears',description:o.description,oldValue:o.lineTotal??o.unitPrice,confidence:o.confidence,key:k});
  return{older:oldI,newer:newI,totalChange,totalPercentChange:totalPct,annualizedDifference:Number.isFinite(totalChange)?round(totalChange*52):undefined,findings};
}
function demo(){
  const oldI={filename:'cintas-older-demo.pdf',vendor:'Cintas',invoiceDate:'05/06/2024',total:97.38,confidence:.99,warnings:[],lines:[['X10184','Entry Mat',6.96],['X10186','Scraper Mat',8.12],['X10189','Logo Mat',11.02],['SERVICE','Service Charge',6.9]].map(([m,d,p])=>({materialCode:m,description:d,frequency:'02',quantity:1,unitPrice:p,lineTotal:p,lineType:d.includes('Service')?'service_fee':'rental_item',confidence:.99,raw:''}))};
  const newI={...oldI,filename:'cintas-newer-demo.pdf',invoiceDate:'06/03/2024',total:115.88,lines:[['X10184','Entry Mat',8.282],['X10186','Scraper Mat',9.662],['X10189','Logo Mat',13.113],['SERVICE','Service Charge',8.21]].map(([m,d,p])=>({materialCode:m,description:d,frequency:'02',quantity:1,unitPrice:p,lineTotal:p,lineType:d.includes('Service')?'service_fee':'rental_item',confidence:.99,raw:''}))};
  return compare(oldI,newI);
}
function icon(f){if(f.type==='TOTAL_CHANGED')return'↗';if(f.type.includes('FEE'))return'$';if(f.type==='NEW_ITEM')return'+';if(f.type==='REMOVED_ITEM')return'−';if(f.type==='QUANTITY_CHANGED')return'#';return'∆';}
function render(result){
  $('results').hidden=false;$('results-title').textContent=`Your Cintas bill ${Number.isFinite(result.totalPercentChange)?`changed ${fmtPct(result.totalPercentChange)}`:'has changes'}`;$('metric-old').textContent=fmtMoney(result.older.total);$('metric-new').textContent=fmtMoney(result.newer.total);$('metric-old-date').textContent=result.older.invoiceDate||result.older.filename;$('metric-new-date').textContent=result.newer.invoiceDate||result.newer.filename;$('metric-diff').textContent=Number.isFinite(result.totalChange)?`${result.totalChange>0?'+':''}${fmtMoney(result.totalChange)}`:'—';$('metric-pct').textContent=fmtPct(result.totalPercentChange);$('metric-annual').textContent=Number.isFinite(result.annualizedDifference)?`${result.annualizedDifference>0?'+':''}${fmtMoney(result.annualizedDifference)}`:'—';$('difference-card').classList.toggle('positive',(result.totalChange||0)<0);
  $('count-price').textContent=result.findings.filter(f=>f.type==='UNIT_PRICE_CHANGED').length;$('count-fee').textContent=result.findings.filter(f=>f.type==='FEE_CHANGED'||f.type==='NEW_FEE').length;$('count-new').textContent=result.findings.filter(f=>f.type==='NEW_ITEM').length;$('count-removed').textContent=result.findings.filter(f=>f.type==='REMOVED_ITEM').length;
  const warnings=[...(result.older.warnings||[]),...(result.newer.warnings||[])];$('review-note').hidden=!warnings.length;$('review-note-text').textContent=warnings[0]||'';$('confidence').textContent=`Parser confidence ${Math.round(Math.min(result.older.confidence,result.newer.confidence)*100)}%`;
  const list=$('finding-list');list.innerHTML='';if(!result.findings.length){list.innerHTML='<div class="empty-state">No comparable changes were confidently detected.</div>';}else result.findings.forEach(f=>{const row=document.createElement('article');row.className='finding-row';const old=Number.isFinite(f.oldValue)?fmtMoney(f.oldValue):f.oldValue??'',nw=Number.isFinite(f.newValue)?fmtMoney(f.newValue):f.newValue??'';row.innerHTML=`<div class="finding-icon">${icon(f)}</div><div class="finding-main"><strong>${escapeHtml(f.title)}</strong><span>${escapeHtml(f.description)}</span></div><div class="finding-values">${old!==''?`<span>${escapeHtml(String(old))}</span>`:''}${nw!==''?`<strong>→ ${escapeHtml(String(nw))}</strong>`:''}${Number.isFinite(f.percentChange)?`<em>${fmtPct(f.percentChange)}</em>`:''}</div>`;list.appendChild(row);});
  $('results').scrollIntoView({behavior:'smooth',block:'start'});
}
function escapeHtml(s){return s.replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
$('compare-button').addEventListener('click',async()=>{const btn=$('compare-button'),err=$('global-error');err.hidden=true;btn.disabled=true;btn.firstChild.textContent='Reading invoices… ';try{const [a,b]=await Promise.all([extractPdfLines(state.older),extractPdfLines(state.newer)]),o=parseInvoice(state.older.name,a),n=parseInvoice(state.newer.name,b);if(o.vendor!=='Cintas'&&n.vendor!=='Cintas')throw new Error('These files could not be identified as Cintas invoices. Please use original Cintas invoice PDFs.');render(compare(o,n));}catch(e){err.textContent=e?.message||'We could not read these PDFs.';err.hidden=false;}finally{btn.firstChild.textContent='Compare my bills ';btn.disabled=!(state.older&&state.newer);}});
$('demo-button').addEventListener('click',()=>render(demo()));
$('reset-button').addEventListener('click',()=>{state.older=state.newer=null;['older','newer'].forEach(slot=>{$(`${slot}-file`).value='';$(`${slot}-name`).textContent=slot==='older'?'Drop your earlier Cintas PDF here':'Drop your later Cintas PDF here';$(`${slot}-icon`).textContent='↑';$(`${slot}-card`).classList.remove('has-file','is-error');$(`${slot}-error`).textContent='';});$('compare-button').disabled=true;$('results').hidden=true;window.scrollTo({top:0,behavior:'smooth'});});
$('early-access').addEventListener('click',()=>alert('Thanks — early-access interest noted for this validation build.'));
