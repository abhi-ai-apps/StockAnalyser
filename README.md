# StockAnalyser

An automated weekly scanner that screens the entire S&P 500, ranks stocks using quantitative signals, and runs a deep 8-filter AI analysis via Gemini — delivering actionable buy/avoid verdicts every Monday morning.

## What it does

1. **Fetches all ~500 S&P 500 tickers** from Wikipedia (live) with a curated fallback list
2. **Pulls real-time quotes** from Yahoo Finance (free, no API key needed) — revenue growth, FCF, market cap, analyst consensus, margins, EPS growth, price vs moving averages
3. **Hard-filters** down to only stocks meeting minimum quality thresholds:
   - Revenue growth > 15% YoY
   - Positive free cash flow (TTM)
   - Market cap > $2B
   - Analyst mean rating ≤ 2.3 (Strong Buy territory)
4. **Scores and ranks** surviving stocks across 7 quantitative dimensions to prioritize the best candidates for deep analysis
5. **Runs Gemini AI analysis** (with Google Search grounding) on top-ranked stocks in batches of 5, applying 8 investment filters:

| # | Filter | What it checks |
|---|--------|----------------|
| 1 | Revenue Growth | YoY growth rate, acceleration/deceleration, organic vs acquisition |
| 2 | Profitability & Margins | Gross margin trend, operating leverage, path to profit |
| 3 | Free Cash Flow | FCF positive, FCF margin %, SBC inflation |
| 4 | Balance Sheet | Debt/equity, cash runway, annual dilution from SBC |
| 5 | Competitive Moat | Network effects, switching costs, IP, NRR >110% |
| 6 | Valuation | P/E, P/S, EV/EBITDA, PEG vs sector peers and history |
| 7 | Leadership Quality | Insider activity, SBC % revenue, guidance accuracy |
| 8 | Risk & Timing | Downside scenario, regulatory/concentration/macro risk, catalysts |

6. **Stops early** once 3 STRONG BUYs are found (configurable), to keep API costs minimal
7. **Publishes results** as a GitHub Issue with a full scorecard table and deep dives on top picks, and optionally posts a summary to Slack

## Verdicts

| Verdict | Criteria |
|---------|----------|
| STRONG BUY | 7–8 filters PASS |
| BUY | 6 filters PASS |
| WATCH | 4–5 filters PASS |
| AVOID | <4 filters PASS or critical filter fails |
| STRONG AVOID | Multiple red flags across filters |

## Setup

### Prerequisites

- Node.js 20+
- A [Google AI Studio](https://aistudio.google.com) API key (Gemini)
- A GitHub repository with Actions enabled

### GitHub Actions (automated, recommended)

Add these secrets to your repository (`Settings → Secrets → Actions`):

| Secret | Required | Description |
|--------|----------|-------------|
| `GEMINI_API_KEY` | Yes | Your Google AI Studio API key |
| `SLACK_WEBHOOK` | No | Slack incoming webhook URL for summaries |

The workflow runs automatically every **Monday at 9AM ET**. You can also trigger it manually from the Actions tab.

### Local run

```bash
npm install
GEMINI_API_KEY=your_key_here npm run scan
```

## Output

Each run creates a GitHub Issue tagged `weekly-scan` with:
- A stats header (stocks screened → filtered → analyzed)
- A full results table with per-filter pass/fail/watch icons
- Deep-dive sections for every STRONG BUY with thesis bullets and next catalyst
- Slack summary (if webhook configured)

## Project goals

- **Zero cost for data** — Yahoo Finance provides all market data for free
- **Minimal AI spend** — early stopping and hard pre-filters mean usually only 15–25 stocks get expensive AI analysis
- **Repeatable signal** — same 8 filters every week means results are comparable over time
- **Transparent reasoning** — every verdict shows the filter breakdown, not just a score
- **Published results** — scan history lives in GitHub Issues, browsable and searchable

## Tech stack

- **Runtime**: Node.js (ESM)
- **Market data**: [yahoo-finance2](https://github.com/gadicc/node-yahoo-finance2)
- **AI analysis**: Google Gemini 2.0 Flash with Google Search grounding
- **Automation**: GitHub Actions
- **Results**: GitHub Issues + optional Slack
