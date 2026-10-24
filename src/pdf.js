// src/pdf.js — HTML→PDF via Puppeteer chrome-headless-shell (C1: serial queue, measured 279–330MB PSS)
import puppeteer from 'puppeteer';

let browserPromise = null;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: 'shell', // C1 — measured verdict (Task 3): 279–330MB PSS
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none'],
    });
  }
  return browserPromise;
}

async function closeBrowser() {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    await b?.close().catch(() => {});
    browserPromise = null;
  }
}

// Serial queue — concurrency = 1 ALWAYS (C1). One job at a time; browser killed after each batch.
let chain = Promise.resolve();
export function renderPdf(html) {
  const job = chain.then(async () => {
    try {
      const browser = await getBrowser();
      const page = await browser.newPage();
      try {
        await page.setContent(html, { waitUntil: 'networkidle0', timeout: 60_000 });
        const out = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: false });
        return Buffer.from(out); // puppeteer may return Uint8Array — normalize to Buffer
      } finally { await page.close(); }
    } finally {
      await closeBrowser(); // kill child after every job (C1 discipline; RAM budget)
    }
  });
  chain = chain.then(() => job, () => job);
  return job;
}
