const { resolvedSnapshot } = require("./returnFinance");
const fs = require("fs");
const path = require("path");
const logo = `data:image/png;base64,${fs.readFileSync(path.join(__dirname, "../lib/return-report-logo.png")).toString("base64")}`;
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const amount = (value, currency) => value === null || value === undefined || !currency ? "?" : `${currency} ${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 3 }).format(value)}`;

const dateText = (value) => {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime()) ? `${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")}/${date.getUTCFullYear()}` : "Not recorded";
};
const line = (label, value) => `<div class="detail-line">${escape(label)}: ${escape(value)}</div>`;
const renderHtml = (input) => {
  const report = resolvedSnapshot(input);
  const start = new Date(`${report.month}-01T00:00:00Z`), end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Returns &amp; Exchanges Statement</title><style>
    *{box-sizing:border-box}html{color-scheme:light;background:#fff}body{margin:0;padding:20px;background:#fff;color:#111;font:14px Helvetica,Arial,sans-serif}
    p{margin:0;line-height:20px}a{color:#111}header{max-width:640px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;padding:12px 20px 16px 36px}
    header img{width:100px;height:auto;display:block}header p{font-size:12px;line-height:18px;text-align:right}
    .statement{background:#fff;margin:0 20px;padding:12px 40px}.section{padding-top:14px;break-inside:avoid}h1,h2{font-size:18px;line-height:24px;margin:0;font-weight:700}
    .detail-line{font-size:13px;font-weight:700;line-height:18px;padding:8px 0;border-bottom:1px solid #000;overflow-wrap:anywhere}
    .company{margin-bottom:10px}
    .transactions{padding-top:24px}h3{font:700 16px "Times New Roman",serif;text-align:center;margin:0;padding-bottom:8px;border-bottom:1px solid #000}
    table{width:100%;border-collapse:collapse;table-layout:fixed;font:14px/1.25 "Times New Roman",serif;text-align:left}thead{display:table-header-group}th{padding:3px 8px 8px 0;vertical-align:top}td{padding:2px 8px 2px 0;vertical-align:top;overflow-wrap:anywhere}
    tr{break-inside:avoid}.footer{padding:16px 0;color:#767676;font-size:10px;line-height:16px}
  </style></head><body>
    <header><img src="${logo}" alt="Swipe"><p>Need help?<br><a href="mailto:support@swipe.ai">Contact</a></p></header>
    <main class="statement"><p class="company">Swipe AI Inc<br>230 E Ohio Street<br>Suite 410 #1400<br>Chicago, IL 60611</p>
      <section class="section"><h1>Report for:</h1>${line("Merchant", report.merchant_name)}${line("ADDRESS", report.merchant_address || "Not recorded")}</section>
      <section class="section"><h2>Details:</h2>${line("STATEMENT ID", report.report_id || `RET-${report.month}`)}${line("STATEMENT DATE", dateText(end))}${line("GENERATED ON", dateText(report.generated_at))}</section>
      <section class="section"><h2>Returns &amp; Exchanges Summary:</h2>${line("REPORTING PERIOD", `${dateText(start)} - ${dateText(end)}`)}${line("COMPLETED RETURNS", report.rows.length)}</section>
      ${Object.entries(report.totals).map(([currency, totals]) => `<section class="section"><h2>RETURNS &amp; EXCHANGES OVERVIEW (${escape(currency)}):</h2>${Object.entries({ total_value: "Total item value", refund: "Refund", stripe_charge: "Charged by Stripe" }).map(([key, label]) => line(label.toUpperCase(), amount(totals[key], currency))).join("")}</section>`).join("")}
    </main>
    <section class="transactions"><h3>Returns &amp; Exchanges</h3><table><thead><tr><th style="width:13%">Created date</th><th style="width:13%">Completed (UTC)</th><th style="width:13%">Order number</th><th style="width:16%">Type</th><th style="width:15%">Total item value</th><th style="width:15%">Refund</th><th style="width:15%">Charged by Stripe</th></tr></thead><tbody>
      ${report.rows.map((row) => `<tr><td>${escape(dateText(row.created_at))}</td><td>${escape(dateText(row.date))}</td><td>${escape(row.return_number)}</td><td>${escape(row.type)}</td><td>${escape(amount(row.total_value, row.currency))}</td><td>${escape(amount(row.refund, row.currency))}</td><td>${escape(amount(row.stripe_charge, row.currency))}</td></tr>`).join("")}
    </tbody></table></section><footer class="footer">Returns &amp; Exchanges &middot; ${escape(report.merchant_name)} &middot; ${escape(report.month)}</footer>
  </body></html>`;
};

const createPdf = async (report) => {
  const puppeteer = require("puppeteer");
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on("request", (request) => request.url().startsWith("data:") ? request.continue() : request.abort());
    await page.setContent(renderHtml(report), { waitUntil: "load" });
    const session = await page.createCDPSession();
    const result = await session.send("Page.printToPDF", { paperWidth: 297 / 25.4, paperHeight: 420 / 25.4, landscape: false, printBackground: true,
      marginTop: 0, marginBottom: 12 / 25.4, marginLeft: 0, marginRight: 0, displayHeaderFooter: true,
      transferMode: "ReturnAsBase64", headerTemplate: "<span></span>",
      footerTemplate: '<div style="font-size:9px;width:100%;text-align:center;color:#666">Returns &amp; Exchanges &middot; <span class="pageNumber"></span> / <span class="totalPages"></span></div>' });
    return Buffer.from(result.data, "base64");
  } finally { await browser.close(); }
};
module.exports = { renderHtml, createPdf };
