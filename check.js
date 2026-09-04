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

// Avis shows a "Sign in to get your best rates" popover (a MUI Popover with
// data-testid="sign-in-dialog-container") a few seconds after the homepage
// loads, on a timer/poll (not immediately). Its backdrop covers the whole
// viewport and intercepts clicks on the search form even though the dialog
// itself is drawn in a corner, so it must be dismissed before (and defensively
// re-checked while) filling the form.
async function dismissSignInDialog(page, log) {
  try {
    const closeBtn = page
      .locator('[data-testid="sign-in-dialog-container"] button[aria-label="close"]')
      .first();
    if (await closeBtn.isVisible({ timeout: 1500 })) {
      await closeBtn.click({ timeout: 2000 });
      await page.waitForTimeout(400);
      log?.push('Dismissed sign-in dialog via close button.');
      return true;
    }
  } catch {
    // fall through to Escape fallback
  }
  try {
    if (await page.locator('[data-testid="sign-in-dialog-container"]').count()) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      log?.push('Dismissed sign-in dialog via Escape.');
      return true;
    }
  } catch {
    // no dialog present, nothing to do
  }
  return false;
}

// Actively waits a few seconds for the timer-driven sign-in dialog to show up
// (rather than only checking once) so we don't lose a race with it appearing
// mid-form-fill, then dismisses it if/when it does.
async function waitOutSignInDialog(page, log) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (await dismissSignInDialog(page, log)) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

// Avis also runs Bounce Exchange marketing campaigns (email-capture / "35%
// off" modals, id="bx-campaign-*", role="dialog") that pop up on an
// unpredictable timer/engagement trigger — sometimes immediately, sometimes
// mid-interaction, sometimes not at all. Rather than one selector per
// campaign, this closes whatever generic dialog is currently blocking via
// common close patterns, then Escape as a last resort.
async function dismissGenericOverlay(page, log) {
  try {
    const overlay = page.locator('[role="dialog"]:visible, [id^="bx-campaign-"]:visible').first();
    if ((await overlay.count()) === 0) return false;

    const closeCandidates = [
      overlay.locator('button[aria-label="close" i], [aria-label="close" i]').first(),
      overlay.getByText(/^(continue without|no thanks|skip|maybe later|not now|decline)/i).first(),
      overlay.locator('[class*="close" i]').first(),
    ];
    for (const btn of closeCandidates) {
      try {
        if (await btn.isVisible({ timeout: 800 })) {
          await btn.click({ timeout: 1500 });
          await page.waitForTimeout(300);
          log?.push('Dismissed a promo/overlay dialog.');
          return true;
        }
      } catch {
        // try next candidate
      }
    }
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
    const stillThere = await overlay.isVisible().catch(() => false);
    if (!stillThere) {
      log?.push('Dismissed a promo/overlay dialog via Escape.');
      return true;
    }
  } catch {
    // no overlay present, nothing to do
  }
  return false;
}

async function dismissAnyOverlay(page, log) {
  const a = await dismissSignInDialog(page, log);
  const b = await dismissGenericOverlay(page, log);
  return a || b;
}

// Wraps a click with one retry: if an overlay (of any known kind) intercepts
// the click, dismiss it and try once more before giving up.
async function clickWithOverlayRetry(page, locator, log, description) {
  try {
    await locator.click({ timeout: 4000 });
    return true;
  } catch (e) {
    const dismissed = await dismissAnyOverlay(page, log);
    if (dismissed) {
      try {
        await locator.click({ timeout: 4000 });
        return true;
      } catch (e2) {
        log.push(`${description} click failed after dismissing overlay: ${e2.message}`);
        return false;
      }
    }
    log.push(`${description} click failed: ${e.message}`);
    return false;
  }
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
          if (await opt.isVisible({ timeout: 4000 })) {
            await opt.click({ timeout: 2000 });
            log.push('Selected location from dropdown.');
            return true;
          }
        } catch {
          // try next
        }
      }
      // No dropdown option matched (or the click didn't land). Whatever
      // happened, close the suggestions popper explicitly — if left open it
      // sits on top of the page and silently blocks every later click (the
      // date/time/submit buttons all report "intercepts pointer events").
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(300);
      log.push('Typed location, no dropdown option matched (continuing anyway).');
      return true;
    } catch (e) {
      log.push(`Location field candidate failed: ${e.message}`);
    }
  }
  return false;
}

function ordinalSuffix(n) {
  const j = n % 10;
  const k = n % 100;
  if (j === 1 && k !== 11) return 'st';
  if (j === 2 && k !== 12) return 'nd';
  if (j === 3 && k !== 13) return 'rd';
  return 'th';
}

// The date picker (react-day-picker) gives each day button an accessible
// name like "Today, Friday, September 4th, 2026" or, once picked,
// "Saturday, September 12th, 2026, selected" — always with an ordinal
// suffix on the day and a weekday prefix that varies, so match on the
// stable middle portion only.
function calendarDayRegex(dateStr) {
  const { day, monthName, year } = fmtDateForSearch(dateStr);
  const suffix = ordinalSuffix(parseInt(day, 10));
  return new RegExp(`${monthName}\\s+${day}${suffix},\\s*${year}`, 'i');
}

async function isCalendarOpen(page) {
  // "Go to the Next Month" is a stable, unambiguous marker that the
  // react-day-picker calendar is currently rendered (unlike matching on a
  // bare year number, which can coincidentally match unrelated page text).
  return page
    .getByRole('button', { name: /go to the next month/i })
    .first()
    .isVisible({ timeout: 1000 })
    .catch(() => false);
}

// Selecting the pick-up location auto-opens a single shared range calendar
// (pick-up day, then return day, in two clicks), but that happens
// asynchronously — poll briefly rather than checking once, then fall back
// to clicking the "Pick-up date" button to open it if it never appears.
async function openDateCalendar(page, log) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await isCalendarOpen(page)) return true;
    await page.waitForTimeout(250);
  }
  try {
    const opener = page.getByRole('button', { name: /pick.?up date/i }).first();
    if ((await opener.count()) === 0) return false;
    await opener.click({ timeout: 4000 });
    await page.waitForTimeout(500);
    return true;
  } catch (e) {
    log.push(`Could not open date calendar: ${e.message}`);
    return false;
  }
}

async function clickCalendarDay(page, dateStr, label, log) {
  const re = calendarDayRegex(dateStr);
  const btn = page.getByRole('button', { name: re }).first();
  try {
    if (!(await btn.isVisible({ timeout: 4000 }))) {
      log.push(`Could not find a calendar day cell for ${label} date ${dateStr}.`);
      return false;
    }
  } catch {
    log.push(`Could not find a calendar day cell for ${label} date ${dateStr}.`);
    return false;
  }
  const ok = await clickWithOverlayRetry(page, btn, log, `${label} date (${dateStr})`);
  if (ok) log.push(`Selected ${label} date ${dateStr}.`);
  return ok;
}

async function setDateRange(page, log) {
  await openDateCalendar(page, log);
  const pickupOk = await clickCalendarDay(page, CONFIG.pickupDate, 'pick-up', log);
  const returnOk = await clickCalendarDay(page, CONFIG.returnDate, 'return', log);
  return pickupOk && returnOk;
}

// Time fields are custom listboxes (not native <select>s), opened by
// clicking an unlabeled combobox that displays the current time. The
// pick-up location input is ALSO role="combobox", and comes first in DOM
// order, so within getByRole('combobox') the indices are:
// 0 = pick-up location, 1 = pick-up time, 2 = return time, 3+ = Driver's
// Age/Residency/etc. Options render zero-padded ("04:00 PM"), so match
// loosely against the configured value.
function timeOptionRegex(timeText) {
  const m = timeText.trim().match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/i);
  if (!m) return new RegExp(timeText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const [, h, mm, ap] = m;
  return new RegExp(`^0?${h}:${mm}\\s*${ap}$`, 'i');
}

async function trySetTimeByIndex(page, index, timeText, log, fieldName) {
  try {
    const combo = page.getByRole('combobox').nth(index);
    const opened = await clickWithOverlayRetry(page, combo, log, `${fieldName} time combobox`);
    if (!opened) {
      log.push(`Could not set ${fieldName} time to ${timeText} (leaving default).`);
      return false;
    }
    await page.waitForTimeout(300);
    const option = page.getByRole('option', { name: timeOptionRegex(timeText) }).first();
    if (await option.isVisible({ timeout: 3000 })) {
      const picked = await clickWithOverlayRetry(page, option, log, `${fieldName} time option`);
      if (picked) {
        log.push(`Set ${fieldName} time to ${timeText}.`);
        return true;
      }
    }
    await page.keyboard.press('Escape').catch(() => {});
  } catch (e) {
    log.push(`${fieldName} time selection failed: ${e.message}`);
  }
  log.push(`Could not set ${fieldName} time to ${timeText} (leaving default).`);
  return false;
}

async function clickShowVehicles(page, log) {
  const candidates = [
    page.getByRole('button', { name: /show vehicles/i }).first(),
    page.getByRole('button', { name: /show cars/i }).first(),
    page.getByRole('button', { name: /search|find a car|continue/i }).first(),
  ];
  for (const el of candidates) {
    try {
      if (await el.isVisible({ timeout: 3000 })) {
        const ok = await clickWithOverlayRetry(page, el, log, 'search/submit button');
        if (ok) {
          log.push('Clicked search/submit button.');
          return true;
        }
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

  // Avis sometimes puts the search behind a bot-detection challenge
  // ("Verification Required — Slide right to secure your access"). This
  // script deliberately does not attempt to solve or bypass it (that's an
  // explicit non-goal) — it just reports that it happened.
  const botCheckPatterns = /verification required|slide (right )?to secure|prove you.?re (a )?human|are you a robot|complete (this|the) (quick )?security check/i;
  if (botCheckPatterns.test(bodyText)) {
    log.push('Hit a bot-detection / verification challenge; not attempting to solve it.');
    return {
      status: 'blocked',
      vehicleCount: 0,
      cheapestPriceText: null,
      note: 'Avis showed a bot-detection challenge instead of results. This script does not attempt to solve CAPTCHAs — see docs/debug/latest.png.',
    };
  }

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
    await waitOutSignInDialog(page, log);

    await dismissAnyOverlay(page, log);
    await trySetLocation(page, log);
    await dismissAnyOverlay(page, log);
    await setDateRange(page, log);
    await dismissAnyOverlay(page, log);
    await trySetTimeByIndex(page, 1, CONFIG.pickupTime, log, 'pickup');
    await dismissAnyOverlay(page, log);
    await trySetTimeByIndex(page, 2, CONFIG.returnTime, log, 'return');
    await dismissAnyOverlay(page, log);

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
    status: result.status, // 'available' | 'sold_out' | 'unknown' | 'blocked' | 'error'
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
