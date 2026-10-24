// Prisbevakning för Roborock Qrevo Master och Qrevo MaxV.
// Kör: node price-monitor/check-prices.js [--no-save]
// Hämtar priser från PriceRunner och svenska butiker, jämför med förra körningen
// och sparar resultatet i price-monitor/history.json.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const HISTORY_FILE = path.join(__dirname, 'history.json');
const MAX_HISTORY = 400;

const MODELS = [
  { id: 'master', label: 'Qrevo Master', query: 'roborock qrevo master', re: /q[ -]?revo[ -]?master/i },
  { id: 'maxv', label: 'Qrevo MaxV', query: 'roborock qrevo maxv', re: /q[ -]?revo[ -]?maxv/i },
];

// Kända PriceRunner-sidor som alltid kollas, utöver det sökningen hittar.
const PRICERUNNER_PAGES = [
  'https://www.pricerunner.se/pl/1613-3269352781/Robotdammsugare/Roborock-Q-Revo-MaxV-QRMV02-Vit-priser',
];

const STORES = [
  { id: 'netonnet', name: 'NetOnNet', url: q => `https://www.netonnet.se/search?query=${q}` },
  { id: 'elgiganten', name: 'Elgiganten', url: q => `https://www.elgiganten.se/search?q=${q}` },
  { id: 'power', name: 'Power', url: q => `https://www.power.se/search/?q=${q}` },
  { id: 'webhallen', name: 'Webhallen', url: q => `https://www.webhallen.com/se/search?searchString=${q}` },
  { id: 'proshop', name: 'Proshop', url: q => `https://www.proshop.se/?s=${q}` },
  { id: 'amazon', name: 'Amazon.se', url: q => `https://www.amazon.se/s?k=${q}` },
];

// Reservdelar och tillbehör som nämner modellnamnet ska inte räknas som roboten.
const ACCESSORY = /borst|brush|filter|mopp|\bmop\b|påse|p[aå]sar|bags?\b|tillbehör|accessor|ersätt|replace|kompatib|compatib|\bkit\b|duk\b|cloth|wiper|tray|skydd|roller|sido|dammbehåll|reservdel|parts|zubehör|náhradní|\d+ ?pcs|\d+ ?st\b/i;
// Sökrutans eko och tomma resultat ("Hittade inga resultat för …") ska inte bli träffar.
const NOT_PRODUCT = /resultat|sök|search|"/i;
const USED = /fyndvara|begagnad|refurb|renewed|outlet|demo|öppnad/i;
const CAMPAIGN = /kampanj|\brea\b|erbjudande|spara|black ?week|black ?friday|ord\.? ?pris|tidigare pris|deal/i;

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function parsePrice(s) {
  const m = String(s).match(/(\d{1,3}(?:[ \u00a0.]\d{3})+|\d+)(?:,(\d{1,2}))?/);
  if (!m) return null;
  const n = Number(m[1].replace(/[ \u00a0.]/g, '') + (m[2] ? '.' + m[2] : ''));
  return Number.isFinite(n) ? n : null;
}

async function open(ctx, url, waitMs) {
  const page = await ctx.newPage();
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (waitMs) await page.waitForTimeout(waitMs);
    return { page, status: res ? res.status() : 0 };
  } catch (e) {
    await page.close();
    return { page: null, status: 0, error: e.message.split('\n')[0] };
  }
}

async function checkPriceRunner(ctx) {
  const urls = new Set(PRICERUNNER_PAGES);
  for (const model of MODELS) {
    const { page } = await open(ctx, `https://www.pricerunner.se/results?q=${encodeURIComponent(model.query)}`, 2000);
    if (!page) continue;
    const html = await page.content();
    await page.close();
    for (const u of html.match(/\/pl\/1613-\d+\/Robotdammsugare\/[^"\\?#]+/g) || []) {
      if (model.re.test(u.replace(/-/g, ' '))) urls.add('https://www.pricerunner.se' + u);
    }
  }

  const offers = [];
  let status = 'ok';
  for (const url of urls) {
    const { page, status: code } = await open(ctx, url, 1000);
    if (!page || code >= 400) { status = `fel (${code || 'nätverk'})`; if (page) await page.close(); continue; }
    const blocks = await page.$$eval('script[type="application/ld+json"]', els => els.map(e => e.textContent));
    await page.close();
    for (const b of blocks) {
      let d;
      try { d = JSON.parse(b); } catch { continue; }
      if (d['@type'] !== 'Product') continue;
      const model = MODELS.find(m => m.re.test(d.name));
      if (!model) continue;
      for (const o of (d.offers && d.offers.offers) || []) {
        offers.push({
          model: model.id,
          name: d.name,
          price: Number(o.price),
          store: (o.seller && o.seller.name) || 'okänd',
          inStock: /InStock/i.test(o.availability || ''),
          via: 'PriceRunner',
          url,
        });
      }
    }
  }
  return { status, offers };
}

async function checkStore(ctx, store) {
  const offers = [];
  let status = 'ok';
  for (const model of MODELS) {
    const { page, status: code, error } = await open(ctx, store.url(encodeURIComponent(model.query)), 7000);
    if (!page) { status = `fel (${error})`; continue; }
    if (code >= 400) { status = `blockerad (HTTP ${code})`; await page.close(); continue; }
    const cards = await page.evaluate(() => {
      const priceRe = /(\d{1,3}(?:[ \u00a0.]\d{3})+|\d{3,6})(?:[.,]\d{2})?\s*(?:kr|:-|SEK)/gi;
      const out = [];
      for (const el of document.querySelectorAll('a, h2, h3, h4, span, div, p')) {
        const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ').trim();
        if (!/q ?revo/i.test(own) || own.length > 160) continue;
        let a = el;
        for (let i = 0; i < 8 && a; i++, a = a.parentElement) {
          const text = a.innerText || '';
          const prices = text.match(priceRe);
          if (prices) {
            const link = el.closest('a') || a.querySelector('a');
            out.push({ name: own, prices, text: text.slice(0, 400), href: link ? link.href : location.href });
            break;
          }
        }
      }
      return out;
    });
    const text = await page.evaluate(() => (document.body && document.body.innerText) || '');
    await page.close();
    if (text.length < 1500 && !cards.length) status = 'kunde inte läsas (tom sida/botskydd)';
    for (const c of cards) {
      const isEcho = c.name.toLowerCase().replace(/\s+/g, ' ').trim() === model.query;
      if (!model.re.test(c.name) || !/roborock/i.test(c.name) || ACCESSORY.test(c.name) || NOT_PRODUCT.test(c.name) || isEcho) continue;
      const prices = [...new Set(c.prices.map(parsePrice).filter(p => p && p > 1000))];
      if (!prices.length) continue;
      // Fler än två priser betyder att kortet tog med grannprodukter: lita bara på det första.
      const own = prices.length > 2 ? [prices[0]] : prices;
      const price = Math.min(...own);
      offers.push({
        model: model.id,
        name: c.name,
        price,
        otherPrices: own.length > 1 ? own.filter(p => p !== price) : undefined,
        campaign: own.length > 1 || (prices.length <= 2 && CAMPAIGN.test(c.text)),
        used: USED.test(c.name),
        store: store.name,
        via: store.name,
        url: c.href,
      });
    }
  }
  const seen = new Set();
  return {
    status,
    offers: offers.filter(o => {
      const k = `${o.model}|${o.name}|${o.price}`;
      return seen.has(k) ? false : seen.add(k);
    }),
  };
}

function lowest(offers) {
  const inStock = offers.filter(o => o.inStock !== false && !o.used);
  const pool = inStock.length ? inStock : offers;
  return pool.reduce((best, o) => (!best || o.price < best.price ? o : best), null);
}

function fmt(n) {
  return n == null ? '–' : `${Math.round(n).toLocaleString('sv-SE')} kr`;
}

async function main() {
  const save = !process.argv.includes('--no-save');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ locale: 'sv-SE', userAgent: UA });

  const sources = {};
  let all = [];
  const pr = await checkPriceRunner(ctx);
  sources.PriceRunner = pr.status;
  all = all.concat(pr.offers);
  for (const store of STORES) {
    const r = await checkStore(ctx, store);
    sources[store.name] = r.status === 'ok' && !r.offers.length ? 'ok, ingen träff' : r.status;
    all = all.concat(r.offers);
  }
  await browser.close();

  const history = fs.existsSync(HISTORY_FILE) ? JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) : [];
  const prev = history[history.length - 1];

  const entry = { checkedAt: new Date().toISOString(), sources, models: {} };
  const lines = [];
  for (const model of MODELS) {
    const offers = all.filter(o => o.model === model.id).sort((a, b) => a.price - b.price);
    const best = lowest(offers);
    const before = prev && prev.models[model.id] && prev.models[model.id].lowest;
    let change = 'första mätningen';
    if (before && best) {
      const diff = best.price - before.price;
      change = diff < 0 ? `SÄNKT ${fmt(-diff)} (från ${fmt(before.price)})` : diff > 0 ? `höjt ${fmt(diff)}` : 'oförändrat';
    } else if (before && !best) change = 'inga erbjudanden längre';
    else if (!before && best && prev) change = 'nytt erbjudande';
    else if (!before && !best && prev) change = 'fortfarande ingen butik';

    entry.models[model.id] = {
      lowest: best && { price: best.price, store: best.store, via: best.via, url: best.url },
      change,
      dropped: Boolean(before && best && best.price < before.price),
      offers: offers.slice(0, 15),
    };
    lines.push(`${model.label}: ${best ? `${fmt(best.price)} hos ${best.store} (via ${best.via})` : 'ingen butik hittad'} – ${change}`);
    const used = offers.filter(o => o.used);
    if (used.length) lines.push(`  fyndvara: från ${fmt(used[0].price)} hos ${used[0].store} (${used.length} st)`);
    entry.models[model.id].lowestUsed = used.length ? { price: used[0].price, store: used[0].store, url: used[0].url } : null;
    const campaigns = offers.filter(o => o.campaign);
    for (const c of campaigns.slice(0, 3)) lines.push(`  kampanj? ${c.store}: ${fmt(c.price)} ${c.otherPrices ? `(även ${c.otherPrices.map(fmt).join(', ')})` : ''}`);
  }
  lines.push('Källor: ' + Object.entries(sources).map(([k, v]) => `${k}: ${v}`).join('; '));

  if (save) {
    history.push(entry);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-MAX_HISTORY), null, 2) + '\n');
  }
  console.log(lines.join('\n'));
  console.log('\nJSON:' + JSON.stringify(entry));
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
