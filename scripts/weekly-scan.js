// weekly-scan.js
// Usage: node weekly-scan.js
// Env:   ANTHROPIC_API_KEY, SLACK_WEBHOOK (optional), GITHUB_TOKEN + GITHUB_REPO (optional)

const Anthropic = require("@anthropic-ai/sdk");
const yahooFinance = require("yahoo-finance2").default;

const client = new Anthropic(); // reads ANTHROPIC_API_KEY

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG = {
  batchSize: 5,            // Analyze 5 stocks at a time
  stopAtStrongBuys: 3,     // Stop once we find this many STRONG BUYs
  maxBatches: 10,          // Safety cap (never analyze more than 50 stocks)
  delayBetweenCalls: 1000, // ms between Claude calls (rate limit buffer)
};

// Aggressive pre-screen thresholds
const SCREEN = {
  minRevenueGrowth: 0.15,  // >15% YoY
  minFCF: 0,               // Positive FCF (TTM)
  minMarketCap: 2e9,       // >$2B
  maxAnalystMean: 2.3,     // ≤2.3 (1=Strong Buy, 5=Sell) — analyst consensus
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
    const results = await yahooFinance.quote(tickers);
    return Array.isArray(results) ? results : [results];
  } catch {
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

// ─── Step 3: Hard Filter ──────────────────────────────────────────────────────

function hardFilter(quotes) {
  return quotes.filter(q => {
    const revGrowth = q.revenueGrowth ?? q.earningsGrowth ?? -1;
    const fcf = q.freeCashflow ?? -1;
    const marketCap = q.marketCap ?? 0;
    const analystMean = q.recommendationMean ?? 5;

    return (
      revGrowth >= SCREEN.minRevenueGrowth &&
      fcf > SCREEN.minFCF &&
      marketCap >= SCREEN.minMarketCap &&
      analystMean <= SCREEN.maxAnalystMean
    );
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
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        system: ANALYST_SYSTEM,
        messages: [{
          role: "user",
          content: `Search for the latest financial data, earnings, analyst ratings, and news for ${ticker}. Run the full 8-filter analysis.

Return ONLY this JSON (no markdown, no extra text):
{"ticker":"${ticker}","companyName":"","sector":"","currentPrice":"","marketCap":"","filters":{"revenueGrowth":{"rating":"PASS","data":"","justification":""},"profitability":{"rating":"PASS","data":"","justification":""},"freeCashFlow":{"rating":"PASS","data":"","justification":""},"balanceSheet":{"rating":"PASS","data":"","justification":""},"moat":{"rating":"PASS","data":"","justification":""},"valuation":{"rating":"PASS","data":"","justification":""},"leadership":{"rating":"PASS","data":"","justification":""},"risk":{"rating":"PASS","data":"","justification":""}},"passCount":0,"verdict":"","thesis":["","",""],"nextCatalyst":""}`
        }],
        tools: [{ type: "web_search_20250305", name: "web_search" }]
      })
    });

    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();
    const text = data.content.filter(b => b.type === "text").map(b => b.text).join("");
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
  body += `> Screened **${screenerStats.total}** stocks → **${screenerStats.afterFilter}** passed hard filters → analyzed **${allResults.length}** stocks in batches of 5\n\n`;

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
  const repo = process.env.GITHUB_REPO; // e.g. "yourname/sp500-scanner"
  if (!token || !repo) return;

  await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ title, body, labels: ["weekly-scan"] })
  });
  log("  ✓ Created GitHub Issue");
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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║          S&P 500 AGGRESSIVE WEEKLY SCANNER          ║");
  console.log(`║          ${new Date().toLocaleDateString("en-US", { weekday:"long", month:"short", day:"numeric" }).padEnd(42)}║`);
  console.log("╚══════════════════════════════════════════════════════╝\n");

  // 1. Get tickers
  const allTickers = await getSP500Tickers();

  // 2. Fetch all quotes from Yahoo Finance (free, no key)
  const allQuotes = await fetchAllQuotes(allTickers);

  // 3. Hard filter
  const passed = hardFilter(allQuotes);
  log(`\nHard filter: ${allQuotes.length} stocks → ${passed.length} passed`);
  log(`  Criteria: Rev growth >${SCREEN.minRevenueGrowth*100}%, FCF>0, MCap>$${SCREEN.minMarketCap/1e9}B, Analyst≤${SCREEN.maxAnalystMean}`);

  if (passed.length === 0) {
    log("No stocks passed hard filter. Market conditions may be weak.");
    await postToSlack("⚠️ Weekly Scan: No stocks passed hard filter this week.");
    return;
  }

  // 4. Score and rank
  const ranked = passed
    .map(q => ({ ...q, _score: scoreStock(q) }))
    .sort((a, b) => b._score - a._score);

  log(`\nTop 10 by score:`);
  for (const q of ranked.slice(0, 10)) {
    log(`  ${q.symbol?.padEnd(6)} score:${q._score}  revGrowth:${((q.revenueGrowth||0)*100).toFixed(0)}%  analystMean:${(q.recommendationMean||0).toFixed(1)}`);
  }

  // 5. Analyze in batches of 5, stop when STRONG BUYs found
  const strongBuys = [];
  const allResults = [];
  let batchNum = 0;

  for (let i = 0; i < ranked.length && batchNum < CONFIG.maxBatches; i += CONFIG.batchSize) {
    batchNum++;
    const batch = ranked.slice(i, i + CONFIG.batchSize);
    const tickers = batch.map(q => q.symbol).filter(Boolean);

    log(`\n── Batch ${batchNum}: ${tickers.join(", ")} ──`);

    for (const ticker of tickers) {
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

    if (strongBuys.length >= CONFIG.stopAtStrongBuys) {
      log(`\n✓ Found ${strongBuys.length} STRONG BUYs — stopping early`);
      break;
    }

    if (i + CONFIG.batchSize < ranked.length && batchNum < CONFIG.maxBatches) {
      log(`  No STRONG BUY yet. Moving to next batch...`);
    }
  }

  // 6. Print scorecard
  printScorecard(allResults);

  const screenerStats = { total: allQuotes.length, afterFilter: passed.length };

  // 7. Output results
  log("Publishing results...");

  // Slack
  const slackMsg = formatSlackMessage(strongBuys, allResults);
  await postToSlack(slackMsg);

  // GitHub Issue
  const date = new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  const issueTitle = `📈 Weekly Scan ${date} — ${strongBuys.length} Strong Buy${strongBuys.length !== 1 ? "s" : ""} found`;
  const issueBody = formatGithubIssue(strongBuys, allResults, screenerStats);
  await createGithubIssue(issueTitle, issueBody);

  // Always print to stdout (visible in GitHub Actions logs)
  console.log("\n" + slackMsg.replace(/\*/g, ""));

  log(`\nDone. Analyzed ${allResults.length} stocks across ${batchNum} batches.`);
  log(`Strong Buys: ${strongBuys.map(r => r.ticker).join(", ") || "none"}`);
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
