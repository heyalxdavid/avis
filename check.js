// Checks Avis.com for car rental availability at a given location/date range
// and writes the result to docs/status.json (and debug artifacts) so a
// GitHub Actions workflow can notify on a change and GitHub Pages can show it.
//
// NOTE: Avis.com is a JS-heavy booking app with no stable public API for this,
// so this script drives a real headless browser through the actual search
// form. Selectors are based on the visible labels/placeholders Avis shows,
// with several fallback strategies, because exact CSS classes can change
// without notice and could not be verified from the environment that wrote
// this script. If a run fails to find something, it still writes a status
// file (status: "unknown") plus a screenshot + HTML dump under docs/debug/
// so the workflow logs make it obvious what changed and the selectors can
// be adjusted.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CONFIG = {
  homeUrl: 'https://www.avis.com/en/home',
  location: process.env.PICKUP_LOCATION || 'SEA',
  locationLabel: process.env.PICKUP_LOCATION_LABEL || 'Seattle-Tacoma Airport',
  pickupDate: process.env.PICKUP_DATE || '2026-09-04', // YYYY-MM-DD
  pickupTime: process.env.PICKUP_TIME || '4:00 PM',
  returnDate: process.env.RETURN_DATE || '2026-09-12', // YYYY-MM-DD
  returnTime: process.env.RETURN_TIME || '4:00 PM',
};

const DOCS_DIR = path.join(__dirname, 'docs');
const DEBUG_DIR = path.join(DOCS_DIR, 'debug');
const STATUS_PATH = path.join(DOCS_DIR, 'status.json');

function ensureDirs() {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
}

function readPreviousStatus() {
  try {
    return JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function fmtDateForSearch(dateStr) {
  // "2026-09-04" -> { day: "4", monthName: "September", year: "2026", long: "September 4, 2026" }
  const [y, m, d] = dateStr.split('-').map((n) => parseInt(n, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  const monthName = dt.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  return {
    day: String(d),
    monthName,
    year: String(y),
    long: `${monthName} ${d}, ${y}`,
  };
}

async function dismissCookieBanner(page) {
  const candidates = [
    '#onetrust-accept-btn-handler',
    'button:has-text("Accept All Cookies")',
    'button:has-text("Accept all cookies")',
    'button:has-text("Accept All")',
    'button:has-text("Accept")',
    '[aria-label="Accept Cookies"]',
  ];
  for (const sel of candidates) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 })) {
        await el.click({ timeout: 2000 });
        await page.waitForTimeout(500);
        return true;
      }
    } catch {
      // ignore and try next
    }
  }
  return false;
}

async function trySetLocation(page, log) {
  const fieldCandidates = [
    () => page.getByLabel(/pick.?up location/i),
    () => page.getByPlaceholder(/city, airport|pick.?up location/i),
    () => page.locator('input[id*="pickup" i][id*="location" i]').first(),
    () => page.locator('input[name*="pickup" i]').first(),
  ];

  for (const getField of fieldCandidates) {
    try {
      const field = getField();
      if (await field.count() === 0) continue;
      await field.click({ timeout: 5000 });
      await field.fill('', { timeout: 5000 }).catch(() => {});
      await field.type(CONFIG.location, { delay: 60 });
      await page.waitForTimeout(1200);

      const optionCandidates = [
        page.getByRole('option', { name: new RegExp(CONFIG.location, 'i') }).first(),
        page.getByRole('option', { name: /seattle.?tacoma/i }).first(),
        page.locator('li:has-text("Seattle")').first(),
      ];
      for (const opt of optionCandidates) {
        try {
          if (await opt.isVisible({ timeout: 2000 })) {
            await opt.click({ timeout: 2000 });
            log.push('Selected location from dropdown.');
            return true;
          }
        } catch {
          // try next
        }
      }
      // No dropdown matched; assume typed value is enough and move on.
      log.push('Typed location, no dropdown option matched (continuing anyway).');
      return true;
    } catch (e) {
      log.push(`Location field candidate failed: ${e.message}`);
    }
  }
  return false;
}

async function clickDayInOpenCalendar(page, dateStr, log) {
  const { long, day } = fmtDateForSearch(dateStr);
  const candidates = [
    page.getByRole('button', { name: new RegExp(long.replace(',', ',?'), 'i') }).first(),
    page.getByLabel(new RegExp(long.replace(',', ',?'), 'i')).first(),
    page.locator(`[aria-label*="${long}" i]`).first(),
    page.getByText(new RegExp(`^${day}$`)).first(),
  ];
  for (const el of candidates) {
    try {
      if (await el.isVisible({ timeout: 3000 })) {
        await el.click({ timeout: 3000 });
        log.push(`Clicked calendar day for ${long}.`);
        return true;
      }
    } catch {
      // try next
    }
  }
  log.push(`Could not find a calendar day cell for ${long}.`);
  return false;
}

async function trySetDateField(page, labelRegex, dateStr, log, fieldName) {
  const openers = [
    () => page.getByLabel(labelRegex).first(),
    () => page.getByPlaceholder(labelRegex).first(),
    () => page.getByRole('button', { name: labelRegex }).first(),
  ];
  for (const getOpener of openers) {
    try {
      const opener = getOpener();
      if (await opener.count() === 0) continue;
      await opener.click({ timeout: 5000 });
      await page.waitForTimeout(600);
      const ok = await clickDayInOpenCalendar(page, dateStr, log);
      if (ok) return true;
    } catch (e) {
      log.push(`${fieldName} date opener candidate failed: ${e.message}`);
    }
  }
  return false;
}

async function trySetTime(page, labelRegex, timeText, log, fieldName) {
  const selectCandidates = [
    () => page.getByLabel(labelRegex).first(),
    () => page.locator('select').filter({ hasText: /AM|PM/i }),
  ];
  const variants = [timeText, timeText.replace(' ', ''), timeText.toUpperCase(), timeText.toLowerCase()];
  for (const getSel of selectCandidates) {
    try {
      const sel = getSel();
      const count = await sel.count();
      for (let i = 0; i < count; i++) {
        const el = sel.nth(i);
        for (const v of variants) {
          try {
            await el.selectOption({ label: v }, { timeout: 1500 });
            log.push(`Set ${fieldName} time to ${v}.`);
            return true;
          } catch {
            // try next variant/element
          }
        }
      }
    } catch (e) {
      log.push(`${fieldName} time candidate failed: ${e.message}`);
    }
  }
  log.push(`Could not set ${fieldName} time to ${timeText} (leaving default).`);
  return false;
}

async function clickShowVehicles(page, log) {
  const candidates = [
    page.getByRole('button', { name: /show vehicles/i }).first(),
    page.getByRole('button', { name: /search|find a car|continue/i }).first(),
  ];
  for (const el of candidates) {
    try {
      if (await el.isVisible({ timeout: 3000 })) {
        await el.click({ timeout: 5000 });
        log.push('Clicked search/submit button.');
        return true;
      }
    } catch {
      // try next
    }
  }
  log.push('Could not find the search/submit button.');
  return false;
}

async function assessResults(page, log) {
  await page.waitForTimeout(4000); // let the SPA fetch + render results
  const bodyText = await page.locator('body').innerText().catch(() => '');

  const soldOutPatterns = /no vehicles (are )?available|sold out|no cars available|we('|’)re sorry|no availability/i;
  const pricePattern = /\$\s?\d+(\.\d{2})?\s*\/?\s*(day|total)?/gi;

  const priceMatches = bodyText.match(pricePattern) || [];

  if (soldOutPatterns.test(bodyText) && priceMatches.length === 0) {
    return { status: 'sold_out', vehicleCount: 0, cheapestPriceText: null, note: 'Sold-out message detected.' };
  }

  if (priceMatches.length > 0) {
    return {
      status: 'available',
      vehicleCount: priceMatches.length,
      cheapestPriceText: priceMatches[0],
      note: 'Price listings detected on results page.',
    };
  }

  return {
    status: 'unknown',
    vehicleCount: 0,
    cheapestPriceText: null,
    note: 'Neither a clear sold-out message nor price listings were found. See debug screenshot/HTML.',
  };
}

async function main() {
  ensureDirs();
  const log = [];
  const previous = readPreviousStatus();
  const checkedAt = new Date().toISOString();

  let result = { status: 'error', vehicleCount: 0, cheapestPriceText: null, note: '', error: null };

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1400, height: 1000 },
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
  });
  const page = await context.newPage();

  try {
    await page.goto(CONFIG.homeUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);
    await dismissCookieBanner(page);

    await trySetLocation(page, log);
    await trySetDateField(page, /pick.?up date/i, CONFIG.pickupDate, log, 'pickup');
    await trySetTime(page, /pick.?up time/i, CONFIG.pickupTime, log, 'pickup');
    await trySetDateField(page, /(drop.?off|return) date/i, CONFIG.returnDate, log, 'return');
    await trySetTime(page, /(drop.?off|return) time/i, CONFIG.returnTime, log, 'return');

    await page.screenshot({ path: path.join(DEBUG_DIR, 'before-search.png') }).catch(() => {});

    await clickShowVehicles(page, log);
    await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {});

    const assessed = await assessResults(page, log);
    result = { ...result, ...assessed, error: null, status: assessed.status };
  } catch (e) {
    result.error = e.message;
    result.note = 'Unhandled error during the browser check.';
    log.push(`FATAL: ${e.message}`);
  } finally {
    try {
      await page.screenshot({ path: path.join(DEBUG_DIR, 'latest.png'), fullPage: true });
      const html = await page.content();
      fs.writeFileSync(path.join(DEBUG_DIR, 'latest.html'), html);
    } catch {
      // best effort only
    }
    await browser.close();
  }

  const transitioned = Boolean(
    result.status === 'available' && (!previous || previous.status !== 'available')
  );

  const output = {
    checkedAt,
    location: CONFIG.location,
    locationLabel: CONFIG.locationLabel,
    pickupDate: CONFIG.pickupDate,
    pickupTime: CONFIG.pickupTime,
    returnDate: CONFIG.returnDate,
    returnTime: CONFIG.returnTime,
    status: result.status, // 'available' | 'sold_out' | 'unknown' | 'error'
    vehicleCount: result.vehicleCount,
    cheapestPriceText: result.cheapestPriceText,
    note: result.note,
    error: result.error,
    transitioned,
    log,
  };

  fs.writeFileSync(STATUS_PATH, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));

  // Surface for the GitHub Actions workflow to branch on.
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `status=${output.status}\ntransitioned=${output.transitioned}\n`
    );
  }
}

main();
