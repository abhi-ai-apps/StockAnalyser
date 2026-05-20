// weekly-scan.js
// Usage: node weekly-scan.js
// Env:   GEMINI_API_KEY, SLACK_WEBHOOK (optional), GITHUB_TOKEN + GITHUB_REPO (optional)

import { GoogleGenerativeAI } from "@google/generative-ai";
import yahooFinance from "yahoo-finance2";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG = {
  topN: 5,                 // Number of top-scored stocks to deep-analyze
  delayBetweenCalls: 1000, // ms between Gemini calls (rate limit buffer)
};

// Pre-screen thresholds — only fields reliably returned by yahooFinance.quote()
const SCREEN = {
  minMarketCap: 2e9,       // >$2B
  maxAnalystMean: 2.5,     // ≤2.5 analyst consensus (1=Strong Buy, 5=Sell)
};

// ─── Analyst System Prompt ────────────────────────────────────────────────────

const ANALYST_SYSTEM = `You are an expert stock analyst. Analyze stocks using 8 filters with PASS/WATCH/FAIL ratings:

FILTER 1 — REVENUE GROWTH: Latest YoY revenue growth. Accelerating/stable/decelerating? Organic or acquisition-driven? PASS: >15% growth stock, >5% value stock.
FILTER 2 — PROFITABILITY & MARGINS: Gross margin trend (expanding/compressing), operating leverage. Path to profitability if unprofitable?
FILTER 3 — FREE CASH FLOW: FCF positive? Trend? FCF margin %? Flag if SBC is inflating FCF.
FILTER 4 — BALANCE SHEET: Debt-to-equity, cash runway in years, annual dilution % from SBC. Flag if >5%.
FILTER 5 — COMPETITIVE MOAT: Network effects, switching costs, IP, brand, cost advantage. NRR >110% = strong signal.
FILTER 6 — VALUATION: P/E, P/S, EV/EBITDA, PEG vs sector peers and historical range. What growth is priced in? Realistic?
FILTER 7 — LEADERSHIP QUALITY: Insider buying/selling, SBC % of revenue, earnings guidance accuracy last 4-8 quarters, capital allocation.
FILTER 8 — RISK & TIMING: Downside if growth slows 50%, regulatory risk, concentration risk (>30% single customer?), macro sensitivity, near-term catalysts.

Verdicts: STRONG BUY (7-8 pass), BUY (6 pass), WATCH (4-5 pass), AVOID (<4 pass or critical filter fails), STRONG AVOID (multiple red flags).
Use web search to get current data. Be precise with numbers.`;

// ─── Step 1: Get S&P 500 Tickers ─────────────────────────────────────────────

async function getSP500Tickers() {
  log("Fetching S&P 500 ticker list from Wikipedia...");
  try {
    const res = await fetch("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies");
    const html = await res.text();
    // Extract tickers from the first table (constituents)
    const tableMatch = html.match(/id="constituents"[\s\S]*?<\/table>/);
    if (!tableMatch) throw new Error("Table not found");
    const tickers = [...tableMatch[0].matchAll(/<td><a[^>]*>([A-Z.]{1,6})<\/a>/g)]
      .map(m => m[1].replace(".", "-")) // BRK.B → BRK-B (Yahoo format)
      .filter(t => t.length >= 1);
    log(`  Got ${tickers.length} tickers`);
    return [...new Set(tickers)];
  } catch (e) {
    log(`  Wikipedia fetch failed (${e.message}), using fallback list`);
    // Fallback: curated high-quality S&P 500 subset
    return [
      "NVDA","MSFT","AAPL","GOOGL","META","AMZN","AVGO","CRM","NOW","ADBE",
      "PANW","SNPS","KLAC","LRCX","AMAT","MRVL","ORCL","AMD","CDNS","INTU",
      "FTNT","CRWD","DDOG","ZS","NET","MDB","TTD","WDAY","TEAM","OKTA",
      "HUBS","ZM","DOCU","BILL","PAYC","VEEV","IDXX","ISRG","ELV","UNH",
      "MCK","CVS","HCA","DHR","TMO","A","METTLER","IQV","BIO","MTD",
      "JPM","V","MA","BAC","GS","MS","BLK","SCHW","AXP","COF",
      "LLY","ABBV","JNJ","MRK","PFE","BMY","AMGN","GILD","REGN","VRTX",
      "COST","WMT","HD","TGT","LOW","SBUX","MCD","NKE","LULU","CMG",
      "GE","HON","RTX","LMT","NOC","CAT","DE","EMR","ROK","ETN"
    ];
  }
}

// ─── Step 2: Batch Fetch Quotes from Yahoo Finance ────────────────────────────

async function fetchQuotesBatch(tickers) {
  try {
    const results = await yahooFinance.quote(tickers, {}, { validateResult: false });
    return Array.isArray(results) ? results : [results];
  } catch (e) {
    log(`  Quote batch error: ${e.message}`);
    return [];
  }
}

async function fetchAllQuotes(tickers) {
  log(`\nFetching quotes for ${tickers.length} stocks...`);
  const BATCH = 50;
  const allQuotes = [];

  for (let i = 0; i < tickers.length; i += BATCH) {
    const batch = tickers.slice(i, i + BATCH);
    const quotes = await fetchQuotesBatch(batch);
    allQuotes.push(...quotes.filter(Boolean));
    process.stdout.write(`\r  Fetched ${allQuotes.length}/${tickers.length}...`);
    await sleep(300);
  }
  console.log(); // newline after progress
  return allQuotes;
}

// ─── Step 3: Pre-filter ───────────────────────────────────────────────────────
// Only uses fields reliably present in yahooFinance.quote() responses.
// revenueGrowth and freeCashflow are in quoteSummary/financialData, not quote(),
// so filtering on them here would silently wipe every stock.

function preFilter(quotes) {
  return quotes.filter(q => {
    const marketCap = q.marketCap ?? 0;
    const analystMean = q.recommendationMean ?? 5;
    return marketCap >= SCREEN.minMarketCap && analystMean <= SCREEN.maxAnalystMean;
  });
}

// ─── Step 4: Score & Rank ─────────────────────────────────────────────────────
// Higher score = analyzed first

function scoreStock(q) {
  let score = 0;

  const revGrowth   = q.revenueGrowth ?? q.earningsGrowth ?? 0;
  const fcf         = q.freeCashflow ?? 0;
  const totalRev    = q.totalRevenue ?? 1;
  const fcfMargin   = fcf / totalRev;
  const grossMargin = q.grossMargins ?? 0;
  const analystMean = q.recommendationMean ?? 5;
  const epsGrowth   = q.earningsQuarterlyGrowth ?? 0;
  const price       = q.regularMarketPrice ?? 0;
  const ma50        = q.fiftyDayAverage ?? price;
  const ma200       = q.twoHundredDayAverage ?? price;

  // Revenue growth (most important)
  if (revGrowth >= 0.40) score += 5;
  else if (revGrowth >= 0.30) score += 4;
  else if (revGrowth >= 0.25) score += 3;
  else if (revGrowth >= 0.20) score += 2;
  else if (revGrowth >= 0.15) score += 1;

  // FCF margin quality
  if (fcfMargin >= 0.25) score += 4;
  else if (fcfMargin >= 0.15) score += 3;
  else if (fcfMargin >= 0.10) score += 2;
  else if (fcfMargin > 0)     score += 1;

  // Gross margin (business quality proxy)
  if (grossMargin >= 0.70) score += 3;
  else if (grossMargin >= 0.50) score += 2;
  else if (grossMargin >= 0.40) score += 1;

  // Analyst consensus (1 = Strong Buy, 5 = Sell)
  if (analystMean <= 1.5) score += 4;
  else if (analystMean <= 1.8) score += 3;
  else if (analystMean <= 2.0) score += 2;
  else if (analystMean <= 2.3) score += 1;

  // EPS growth
  if (epsGrowth >= 0.30) score += 3;
  else if (epsGrowth >= 0.20) score += 2;
  else if (epsGrowth >= 0.10) score += 1;

  // Price momentum (above key moving averages)
  if (price > ma50)  score += 1;
  if (price > ma200) score += 1;

  return score;
}

// ─── Step 5: Claude Deep Analysis ────────────────────────────────────────────

async function analyzeStock(ticker) {
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash",
      systemInstruction: ANALYST_SYSTEM,
      tools: [{ googleSearch: {} }],
    });

    const prompt = `Search for the latest financial data, earnings, analyst ratings, and news for ${ticker}. Run the full 8-filter analysis.

Return ONLY this JSON (no markdown, no extra text):
{"ticker":"${ticker}","companyName":"","sector":"","currentPrice":"","marketCap":"","filters":{"revenueGrowth":{"rating":"PASS","data":"","justification":""},"profitability":{"rating":"PASS","data":"","justification":""},"freeCashFlow":{"rating":"PASS","data":"","justification":""},"balanceSheet":{"rating":"PASS","data":"","justification":""},"moat":{"rating":"PASS","data":"","justification":""},"valuation":{"rating":"PASS","data":"","justification":""},"leadership":{"rating":"PASS","data":"","justification":""},"risk":{"rating":"PASS","data":"","justification":""}},"passCount":0,"verdict":"","thesis":["","",""],"nextCatalyst":""}`;

    const response = await model.generateContent(prompt);
    const text = response.response.text();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const result = JSON.parse(jsonMatch[0]);

    // Recount passes from filter ratings (don't trust model's passCount)
    const FILTER_KEYS = ["revenueGrowth","profitability","freeCashFlow","balanceSheet","moat","valuation","leadership","risk"];
    result.passCount = FILTER_KEYS.filter(k => result.filters?.[k]?.rating === "PASS").length;
    return result;

  } catch (e) {
    log(`  ✗ ${ticker}: ${e.message}`);
    return null;
  }
}

// ─── Step 6: Format & Output ──────────────────────────────────────────────────

function formatSlackMessage(strongBuys, allResults) {
  const date = new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  const VERDICT_EMOJI = { "STRONG BUY": "🟢", "BUY": "🟡", "WATCH": "🔵", "AVOID": "🔴", "STRONG AVOID": "⛔" };

  let msg = `*📈 S&P 500 Weekly Scan — ${date}*\n\n`;

  if (strongBuys.length === 0) {
    msg += "⚠️ No STRONG BUYs found this week.\n\n";
  } else {
    msg += `*🏆 STRONG BUYS (${strongBuys.length}):*\n`;
    for (const r of strongBuys) {
      msg += `\n*${r.ticker}* — ${r.companyName} @ ${r.currentPrice}\n`;
      msg += `  ${r.passCount}/8 filters pass · ${r.sector}\n`;
      msg += `  ${r.thesis?.map(t => `• ${t}`).join("\n  ")}\n`;
      if (r.nextCatalyst) msg += `  ⚡ ${r.nextCatalyst}\n`;
    }
  }

  const otherBuys = allResults.filter(r => r.verdict === "BUY");
  if (otherBuys.length > 0) {
    msg += `\n*BUYs (${otherBuys.length}):* ${otherBuys.map(r => `${r.ticker} (${r.passCount}/8)`).join(", ")}\n`;
  }

  msg += `\n_Screened ${allResults.length} stocks via 8-filter AI analysis_`;
  return msg;
}

function formatGithubIssue(strongBuys, allResults, screenerStats) {
  const date = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const FILTER_KEYS = ["revenueGrowth","profitability","freeCashFlow","balanceSheet","moat","valuation","leadership","risk"];
  const FILTER_SHORT = ["Rev","Profit","FCF","B/S","Moat","Val","Lead","Risk"];

  let body = `## 📈 S&P 500 Weekly Scan — ${date}\n\n`;
  body += `> Screened **${screenerStats.total}** stocks → **${screenerStats.afterFilter}** passed pre-filter → top **${screenerStats.topN}** scored stocks analyzed by AI\n\n`;

  // Scorecard table
  body += `### Results\n\n`;
  body += `| Ticker | Company | Price | ${FILTER_SHORT.join(" | ")} | Pass | Verdict |\n`;
  body += `|--------|---------|-------|${FILTER_SHORT.map(() => "---").join("|")}|------|--------|\n`;

  const VERDICT_ORDER = { "STRONG BUY": 0, "BUY": 1, "WATCH": 2, "AVOID": 3, "STRONG AVOID": 4 };
  const sorted = [...allResults].sort((a, b) =>
    (VERDICT_ORDER[a.verdict] ?? 3) - (VERDICT_ORDER[b.verdict] ?? 3) || b.passCount - a.passCount
  );

  for (const r of sorted) {
    const ratings = FILTER_KEYS.map(k => {
      const rating = r.filters?.[k]?.rating;
      return rating === "PASS" ? "✅" : rating === "FAIL" ? "❌" : "⚠️";
    });
    const verdictEmoji = { "STRONG BUY": "🟢 STRONG BUY", "BUY": "🟡 BUY", "WATCH": "🔵 WATCH", "AVOID": "🔴 AVOID", "STRONG AVOID": "⛔ STRONG AVOID" };
    body += `| **${r.ticker}** | ${r.companyName} | ${r.currentPrice} | ${ratings.join(" | ")} | ${r.passCount}/8 | ${verdictEmoji[r.verdict] || r.verdict} |\n`;
  }

  // Strong buy deep dives
  if (strongBuys.length > 0) {
    body += `\n---\n\n### 🏆 Strong Buy Deep Dives\n\n`;
    for (const r of strongBuys) {
      body += `#### ${r.ticker} — ${r.companyName}\n`;
      body += `**${r.currentPrice}** · ${r.marketCap} · ${r.sector}\n\n`;
      body += `**Thesis:**\n${r.thesis?.map(t => `- ${t}`).join("\n")}\n\n`;
      if (r.nextCatalyst) body += `**Next Catalyst:** ${r.nextCatalyst}\n\n`;
      body += `**Filter Details:**\n`;
      for (const k of FILTER_KEYS) {
        const f = r.filters?.[k];
        const icon = f?.rating === "PASS" ? "✅" : f?.rating === "FAIL" ? "❌" : "⚠️";
        body += `- ${icon} **${k}**: ${f?.data ? `[${f.data}] ` : ""}${f?.justification}\n`;
      }
      body += "\n";
    }
  }

  body += `---\n*Generated by weekly-scan.js at ${new Date().toISOString()}*`;
  return body;
}

// ─── Output: Slack ────────────────────────────────────────────────────────────

async function postToSlack(message) {
  const webhook = process.env.SLACK_WEBHOOK;
  if (!webhook) return;
  await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: message })
  });
  log("  ✓ Posted to Slack");
}

// ─── Output: GitHub Issue ─────────────────────────────────────────────────────

async function createGithubIssue(title, body) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!token || !repo) { log("  ⚠ Skipping GitHub Issue (no token/repo)"); return; }

  const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ title, body })
  });
  if (res.ok) {
    const data = await res.json();
    log(`  ✓ Created GitHub Issue #${data.number}`);
  } else {
    const text = await res.text();
    log(`  ✗ GitHub Issue failed (${res.status}): ${text.slice(0, 200)}`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(msg) {
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
  console.log(`[${ts}] ${msg}`);
}

function printScorecard(results) {
  const VERDICT_ORDER = { "STRONG BUY": 0, "BUY": 1, "WATCH": 2, "AVOID": 3, "STRONG AVOID": 4 };
  const sorted = [...results].sort((a, b) =>
    (VERDICT_ORDER[a.verdict] ?? 3) - (VERDICT_ORDER[b.verdict] ?? 3) || b.passCount - a.passCount
  );
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║              WEEKLY SCAN SCORECARD                  ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  for (const r of sorted) {
    const bar = "█".repeat(r.passCount) + "░".repeat(8 - r.passCount);
    console.log(`  ${r.ticker.padEnd(6)} ${bar} ${r.passCount}/8  ${r.verdict}`);
  }
  console.log();
}

// ─── Step 7: Generate HTML Dashboard ─────────────────────────────────────────

function formatHtmlPage(strongBuys, allResults, screenerStats) {
  const date = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const iso = new Date().toISOString();
  const FILTER_KEYS = ["revenueGrowth","profitability","freeCashFlow","balanceSheet","moat","valuation","leadership","risk"];
  const FILTER_LABELS = ["Revenue","Profit","FCF","Bal. Sheet","Moat","Valuation","Leadership","Risk"];

  const VERDICT_ORDER = { "STRONG BUY": 0, "BUY": 1, "WATCH": 2, "AVOID": 3, "STRONG AVOID": 4 };
  const sorted = [...allResults].sort((a, b) =>
    (VERDICT_ORDER[a.verdict] ?? 3) - (VERDICT_ORDER[b.verdict] ?? 3) || b.passCount - a.passCount
  );

  const verdictClass = { "STRONG BUY": "strong-buy", "BUY": "buy", "WATCH": "watch", "AVOID": "avoid", "STRONG AVOID": "strong-avoid" };
  const ratingIcon = r => r === "PASS" ? "✅" : r === "FAIL" ? "❌" : "⚠️";

  const rows = sorted.map(r => {
    const ratings = FILTER_KEYS.map(k => `<td class="center">${ratingIcon(r.filters?.[k]?.rating)}</td>`).join("");
    return `<tr>
      <td><strong>${r.ticker}</strong></td>
      <td>${r.companyName || ""}</td>
      <td>${r.currentPrice || ""}</td>
      ${ratings}
      <td class="center">${r.passCount}/8</td>
      <td><span class="verdict ${verdictClass[r.verdict] || ""}">${r.verdict}</span></td>
    </tr>`;
  }).join("\n");

  const deepDives = strongBuys.map(r => {
    const filterDetails = FILTER_KEYS.map((k, i) => {
      const f = r.filters?.[k];
      return `<li>${ratingIcon(f?.rating)} <strong>${FILTER_LABELS[i]}</strong>${f?.data ? ` <span class="data">[${f.data}]</span>` : ""}: ${f?.justification || ""}</li>`;
    }).join("\n");
    const thesis = (r.thesis || []).map(t => `<li>${t}</li>`).join("\n");
    return `<div class="deep-dive">
      <h3>${r.ticker} — ${r.companyName || ""}</h3>
      <div class="meta">${r.currentPrice || ""} · ${r.marketCap || ""} · ${r.sector || ""}</div>
      <h4>Investment Thesis</h4>
      <ul class="thesis">${thesis}</ul>
      ${r.nextCatalyst ? `<p class="catalyst">⚡ <strong>Next Catalyst:</strong> ${r.nextCatalyst}</p>` : ""}
      <h4>Filter Breakdown</h4>
      <ul class="filters">${filterDetails}</ul>
    </div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>S&P 500 Weekly Scan</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0d1117; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.6; }
    .container { max-width: 1200px; margin: 0 auto; padding: 24px 16px; }
    header { border-bottom: 1px solid #21262d; padding-bottom: 24px; margin-bottom: 32px; }
    header h1 { font-size: 1.8rem; color: #58a6ff; }
    header .subtitle { color: #8b949e; margin-top: 4px; }
    .stats { display: flex; gap: 16px; flex-wrap: wrap; margin: 20px 0; }
    .stat { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 12px 20px; min-width: 130px; }
    .stat .label { font-size: 0.75rem; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; }
    .stat .value { font-size: 1.5rem; font-weight: 700; color: #e6edf3; }
    h2 { font-size: 1.1rem; color: #e6edf3; margin: 32px 0 16px; border-left: 3px solid #58a6ff; padding-left: 12px; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    th { background: #161b22; color: #8b949e; font-weight: 600; text-align: left; padding: 10px 12px; border-bottom: 1px solid #21262d; white-space: nowrap; }
    td { padding: 10px 12px; border-bottom: 1px solid #161b22; white-space: nowrap; }
    .center { text-align: center; }
    tr:hover td { background: #161b22; }
    .verdict { padding: 2px 8px; border-radius: 4px; font-size: 0.78rem; font-weight: 600; white-space: nowrap; }
    .strong-buy { background: #1a3a1f; color: #3fb950; }
    .buy        { background: #2d2a0f; color: #d29922; }
    .watch      { background: #0e2044; color: #58a6ff; }
    .avoid      { background: #3a1212; color: #f85149; }
    .strong-avoid { background: #3a1212; color: #f85149; }
    .deep-dive { background: #161b22; border: 1px solid #21262d; border-radius: 10px; padding: 24px; margin-bottom: 20px; }
    .deep-dive h3 { color: #3fb950; font-size: 1.05rem; margin-bottom: 4px; }
    .meta { color: #8b949e; font-size: 0.85rem; margin-bottom: 16px; }
    .deep-dive h4 { color: #8b949e; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; margin: 16px 0 8px; }
    .thesis li, .filters li { margin-left: 20px; margin-bottom: 6px; font-size: 0.88rem; }
    .catalyst { margin-top: 12px; color: #d29922; font-size: 0.88rem; }
    .data { color: #8b949e; font-size: 0.82rem; }
    .no-results { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 32px; text-align: center; color: #8b949e; margin: 32px 0; }
    footer { margin-top: 48px; border-top: 1px solid #21262d; padding-top: 16px; color: #8b949e; font-size: 0.8rem; }
    footer a { color: #58a6ff; }
    @media (max-width: 640px) { .stats { flex-direction: column; } }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>📈 S&P 500 Weekly Scan</h1>
      <div class="subtitle">${date}</div>
      <div class="stats">
        <div class="stat"><div class="label">Screened</div><div class="value">${screenerStats.total}</div></div>
        <div class="stat"><div class="label">Passed Filters</div><div class="value">${screenerStats.afterFilter}</div></div>
        <div class="stat"><div class="label">Top Analyzed</div><div class="value">${screenerStats.topN}</div></div>
        <div class="stat"><div class="label">Strong Buys</div><div class="value" style="color:#3fb950">${strongBuys.length}</div></div>
      </div>
    </header>

    ${allResults.length === 0 ? `
    <div class="no-results">No results yet — the first scan runs every Monday at 9AM ET.</div>` : `
    <h2>Results Scorecard</h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Ticker</th><th>Company</th><th>Price</th>
            ${FILTER_LABELS.map(l => `<th class="center">${l}</th>`).join("")}
            <th class="center">Pass</th><th>Verdict</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    ${strongBuys.length > 0 ? `
    <h2>🏆 Strong Buy Deep Dives</h2>
    ${deepDives}` : ""}`}

    <footer>Generated by StockAnalyser at ${iso} &nbsp;·&nbsp; <a href="https://github.com/abhi-ai-apps/StockAnalyser/issues">View full scan history →</a></footer>
  </div>
</body>
</html>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (process.env.ENABLE_SCAN === "false") {
    log("Scan disabled (ENABLE_SCAN=false). Exiting.");
    process.exit(0);
  }

  // Initialise before try so the finally block can always write dist/
  let allQuotes = [], passed = [], topStocks = [], strongBuys = [], allResults = [];
  let screenerStats = { total: 0, afterFilter: 0, topN: 0 };

  try {
    console.log("\n╔══════════════════════════════════════════════════════╗");
    console.log("║          S&P 500 AGGRESSIVE WEEKLY SCANNER          ║");
    console.log(`║          ${new Date().toLocaleDateString("en-US", { weekday:"long", month:"short", day:"numeric" }).padEnd(42)}║`);
    console.log("╚══════════════════════════════════════════════════════╝\n");

    // 1. Get tickers
    const allTickers = await getSP500Tickers();

    // 2. Fetch all quotes from Yahoo Finance (free, no key)
    allQuotes = await fetchAllQuotes(allTickers);

    // 3. Pre-filter (market cap + analyst consensus only — both reliably in quote())
    passed = preFilter(allQuotes);
    log(`\nPre-filter: ${allQuotes.length} stocks → ${passed.length} passed`);
    log(`  Criteria: MCap>$${SCREEN.minMarketCap/1e9}B, Analyst≤${SCREEN.maxAnalystMean}`);

    // 4. Score and rank, then take top N for AI analysis
    const ranked = passed
      .map(q => ({ ...q, _score: scoreStock(q) }))
      .sort((a, b) => b._score - a._score);

    topStocks = ranked.slice(0, CONFIG.topN);

    log(`\nTop ${CONFIG.topN} by score (selected for AI analysis):`);
    for (const q of topStocks) {
      log(`  ${q.symbol?.padEnd(6)} score:${q._score}  epsGrowth:${((q.earningsQuarterlyGrowth||0)*100).toFixed(0)}%  analystMean:${(q.recommendationMean||0).toFixed(1)}  grossMargin:${((q.grossMargins||0)*100).toFixed(0)}%`);
    }

    // 5. Deep AI analysis on top N
    log(`\n── Analyzing top ${topStocks.length} stocks with Gemini ──`);
    for (const q of topStocks) {
      const ticker = q.symbol;
      if (!ticker) continue;
      log(`  Analyzing ${ticker}...`);
      const result = await analyzeStock(ticker);
      if (result) {
        allResults.push(result);
        log(`  → ${ticker}: ${result.verdict} (${result.passCount}/8 pass)`);
        if (result.verdict === "STRONG BUY") {
          strongBuys.push(result);
          log(`  ★ STRONG BUY: ${ticker}`);
        }
      }
      await sleep(CONFIG.delayBetweenCalls);
    }

    // 6. Print scorecard
    printScorecard(allResults);

    screenerStats = { total: allQuotes.length, afterFilter: passed.length, topN: topStocks.length };

    // 7. Publish results
    log("Publishing results...");

    const slackMsg = formatSlackMessage(strongBuys, allResults);
    await postToSlack(slackMsg);

    const date = new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
    const issueTitle = `📈 Weekly Scan ${date} — ${strongBuys.length} Strong Buy${strongBuys.length !== 1 ? "s" : ""} found`;
    await createGithubIssue(issueTitle, formatGithubIssue(strongBuys, allResults, screenerStats));

    console.log("\n" + slackMsg.replace(/\*/g, ""));
    log(`\nDone. Analyzed ${allResults.length} of ${CONFIG.topN} top-scored stocks.`);
    log(`Strong Buys: ${strongBuys.map(r => r.ticker).join(", ") || "none"}`);

  } finally {
    // Always write dist/index.html so the Pages deploy step never fails
    // due to a missing folder, even when the scan errors out mid-run.
    const outDir = path.resolve("dist");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, "index.html"), formatHtmlPage(strongBuys, allResults, screenerStats));
    log("  ✓ Generated dist/index.html");
  }
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
