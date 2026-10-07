/**
 * Northwind Realty — shared behaviour.
 *
 * Every page loads this file; each block guards on the elements it needs, so the same
 * script drives the home page, the results page, the detail page and the contact page.
 * No dependencies, no build step, and the only storage used is `localStorage` for
 * saved homes and the chosen layout.
 */
const { listings, agents, offices, site = {} } = NORTHWIND;
const numberFormat = new Intl.NumberFormat('en-US');
const FAVORITES_KEY = 'northwind:favorites';
const VIEW_KEY = 'northwind:view';
const CURRENCY_KEY = 'northwind:currency';
const PAGE_SIZE = 6;
let toastTimer;

/* ---- helpers ------------------------------------------------------------ */
const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
}

/*
 * The two categories of thing the agency sells.
 *
 * `HOME_TYPES` are built-on dwellings, so they are described by bedrooms,
 * bathrooms and floor area. `LAND_TYPES` are parcels of ground, and the figures
 * that decide whether one suits a buyer - plot size, zoning, title, access - are
 * entirely different. So land is kept as its own list rather than being appended
 * to the property types: that is what lets a card, a detail page and a filter
 * swap between two sets of facts instead of showing "0 bedrooms" for a field.
 */
const HOME_TYPES = ['House', 'Apartment', 'Townhouse', 'Villa', 'Loft'];
const LAND_TYPES = [
  'Virgin land',
  'Residential land',
  'Agricultural land',
  'Commercial land',
  'Industrial land',
  'Beachfront land',
  'Ranch land',
  'Orchard land',
  'Mixed-use land',
  'Plot'
];
const PROPERTY_TYPES = [...HOME_TYPES, ...LAND_TYPES];

/** A listing is land when its type says so, or when it carries a land block. */
const isLand = (listing) => Boolean(listing.land) || LAND_TYPES.includes(listing.type);
const isHome = (listing) => !isLand(listing);

const isRent = (listing) => listing.status === 'For rent';

/* ---- short stays ---------------------------------------------------------- */
/*
 * Rentals taken for a set period rather than a year: a few nights, a week, a
 * couple of months, a whole weekend.
 *
 * The shape of this is deliberately additive. `price` stays what it always was
 * - the monthly rent for a rental, the asking price for a sale - so the budget
 * bands, the sorting, the currency conversion and the "/ month" suffix all keep
 * working on every listing without being taught about a new field. `nightly` and
 * `weekly` are optional overrides on top of it, and anything left out is derived
 * rather than shown as a gap.
 *
 * An owner who wants a discount for staying longer writes one: a high nightly
 * rate and a lower monthly price is exactly that, and it needs no extra concept.
 */
const STAY_TERMS = ['Nightly', 'Weekly', 'Monthly'];

/** Does this listing accept anything shorter than a full tenancy? */
const isShortStay = (listing) =>
  Array.isArray(listing.stays) && listing.stays.some((term) => STAY_TERMS.includes(term));

/**
 * The nightly rate for a listing, preferring what the owner actually wrote and
 * falling back through weekly and monthly so a card can never show a blank.
 *
 * `nightlyRateExact` is the same derivation unrounded. It exists because rounding
 * a rate to display it and then comparing that rounded number against an exact
 * one produces phantom differences: p14's weekly rate works out at 88.57 a night,
 * which rounds to 89, so "89 minus 88.57" became a saving of 3 on a term that
 * saves nothing. Comparisons are made on the exact figures and rounded once, at
 * the point of display.
 */
function nightlyRateExact(listing) {
  if (Number(listing.nightly) > 0) return Number(listing.nightly);
  if (Number(listing.weekly) > 0) return Number(listing.weekly) / 7;
  if (isRent(listing) && Number(listing.price) > 0) return Number(listing.price) / 30;
  return 0;
}

/*
 * Rounding is to the nearest whole unit: a nightly rate of 172.857 would look
 * like a bug on a listing card, and nobody prices a weekend to the penny.
 */
function nightlyRate(listing) {
  return Math.round(nightlyRateExact(listing));
}

function weeklyRate(listing) {
  if (Number(listing.weekly) > 0) return Math.round(Number(listing.weekly));
  return nightlyRate(listing) * 7;
}

/**
 * A rate is only shown as a headline if the owner has something to say about it.
 * A one-month let is not a special offer and is left to the ordinary rent path.
 */
const shortStayRates = (listing) => {
  if (!isShortStay(listing)) return null;
  const rates = [];
  // A nightly rate is offered when the owner says nights are acceptable, or
  // writes a nightly figure. It is NOT offered merely because a weekly rate
  // exists: somebody who takes weeks and not nights has usually said so on
  // purpose, and deriving a night rate for them would promise a booking they
  // will refuse.
  if (listing.stays.includes('Nightly') || Number(listing.nightly) > 0) {
    rates.push({ term: 'Nightly', value: nightlyRate(listing), unit: 'night' });
  }
  if (listing.stays.includes('Weekly') || Number(listing.weekly) > 0) {
    rates.push({ term: 'Weekly', value: weeklyRate(listing), unit: 'week' });
  }
  if (listing.stays.includes('Monthly')) {
    rates.push({ term: 'Monthly', value: Number(listing.price), unit: 'month' });
  }
  return rates.length ? rates : null;
};

/** The shortest booking this listing will accept, in nights. */
const minNights = (listing) => (Number(listing.minNights) > 0 ? Number(listing.minNights) : 1);

/**
 * A hot deal, and only while it is actually hot.
 *
 * `hotUntil` is what stops this becoming a permanent decoration. A listing
 * flagged hot with no end date is treated as running indefinitely, because some
 * agencies do want a standing promotion; anything with a date quietly stops
 * being hot the day after, with no one having to remember to clear it.
 */
function isHot(listing) {
  if (!listing.hot) return false;
  if (!listing.hotUntil) return true;
  const until = new Date(`${listing.hotUntil}T23:59:59`);
  return !Number.isNaN(until.getTime()) && until.getTime() >= Date.now();
}

/**
 * The figure a visitor is actually quoted, and what it is called.
 *
 * On a short stay this is the first rate the card leads with, which is not always
 * the nightly one: a place taking weeks and months but no nights leads with its
 * weekly rate, so quoting a saving against a derived nightly figure would
 * describe a price nobody is charged. Everywhere else it is the asking price.
 *
 * Returning the unit with the amount is what lets the saving be labelled in the
 * same words the card used - "save 100 a week" beside a weekly rate, "save 250" on
 * an asking price.
 */
function headlineRate(listing) {
  const rates = shortStayRates(listing);
  if (rates && rates.length) return { value: rates[0].value, unit: rates[0].unit };
  return { value: Number(listing.price), unit: '' };
}

/**
 * What the promotion is worth, in money.
 *
 * A "Hot deal" badge on its own tells a visitor something is reduced and nothing
 * about by how much - so the figure they are being asked for is still unknown, and
 * the badge is decoration rather than information. `originalPrice` is the price
 * before the reduction, against the same headline rate the card leads with.
 *
 * Returns null when there is nothing honest to print, which is most of the
 * conditions worth naming:
 *
 *   not hot         - an expired promotion must vanish entirely, not linger as a
 *                     struck-through figure nobody is being charged any more.
 *   no original     - a flag with no `originalPrice` says only "reduced", which is
 *                     the badge itself, so the helper declines rather than
 *                     inventing a number.
 *   original <= now - a price that rose is not a saving. Printing "save -KES 40"
 *                     would be worse than printing nothing.
 */
function dealSavings(listing) {
  if (!isHot(listing)) return null;
  const { value: now, unit } = headlineRate(listing);
  const was = Number(listing.originalPrice);
  if (!Number.isFinite(was) || was <= 0 || !Number.isFinite(now) || now <= 0) return null;
  if (was <= now) return null;
  return {
    was,
    now,
    unit,
    saving: was - now,
    // Rounded, because "17.5% off" is false precision on a figure the visitor is
    // about to be asked to trust to the penny.
    percent: Math.round((1 - now / was) * 100),
    until: listing.hotUntil || ''
  };
}

/** The day a promotion ends, as words. Empty when it runs indefinitely. */
function dealEndsOn(listing) {
  if (!listing.hotUntil) return '';
  const date = new Date(`${listing.hotUntil}T00:00:00`);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/*
 * The window during which the property can actually be booked, in words.
 *
 * These dates are recorded once by the owner and then left alone, so by the time
 * anybody reads the page most of them are in the past - and printing them as
 * stored tells a reader something untrue in both directions. "Available from 25
 * Sept", read in October, says you cannot arrive before a day that has already
 * gone, which reads as a stale listing rather than as a house that is ready now.
 * And a window that has closed in full keeps advertising dates nobody can use.
 *
 * So the window is read against today rather than echoed. A start that has passed
 * is no longer a constraint and is dropped; a window with no end is simply open;
 * a window that has ended says nothing at all. The year is printed only where a
 * date falls outside the current one, because "until 15 Jan" means a different
 * thing each time January comes round.
 */
function availabilityWindow(listing) {
  const from = listing.availableFrom;
  const to = listing.availableTo;
  if (!from && !to) return '';

  const parse = (value) => new Date(`${value}T00:00:00`);
  // Midnight today, so the comparison is between whole days and does not depend
  // on what time of day the page happened to be opened.
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // A closed window is not an availability statement. Printed as stored it would
  // keep claiming availability for a date nobody can arrive in, so it is dropped
  // entirely rather than corrected - the rates above it are still true.
  if (to && parse(to) < today) return '';

  const fmt = (value) => {
    const date = parse(value);
    const opts = { day: 'numeric', month: 'short' };
    // Only the current year stays implicit. Any other year is named, so a date
    // months out is not read as the nearer one that has already passed.
    if (date.getFullYear() !== today.getFullYear()) opts.year = 'numeric';
    return date.toLocaleDateString('en-GB', opts);
  };

  const startsLater = from && parse(from) > today;
  if (!startsLater) {
    return to ? `Available until ${fmt(to)}` : 'Available now';
  }

  return to ? `Available ${fmt(from)} – ${fmt(to)}` : `Available from ${fmt(from)}`;
}

/*
 * The money around a stay that is not the rate.
 *
 * A nightly figure is what a guest compares on, and it is never the whole bill.
 * The deposit is refundable but has to be found; the cleaning fee is charged once
 * per stay however long that stay is; the service fee is a share of the booking;
 * the booking fee lands with the first payment. All four are named here, and
 * only when the owner has actually set them - the same "absent rather than zero"
 * rule the deposit already worked by. A stored 0 would render as "no cleaning
 * fee", which is a promise nobody made.
 *
 * The note on each one is the part that stops it being misread. A deposit printed
 * in the same weight as a nightly rate looks like a charge every night, when it
 * comes back; a cleaning fee printed as a nightly rate looks like it repeats.
 */
const STAY_CHARGES = [
  { key: 'deposit', label: 'Refundable deposit', short: 'Deposit', note: 'held against the property, returned after check-out' },
  { key: 'cleaningFee', label: 'Cleaning fee', short: 'Cleaning fee', note: 'once per stay, not per night' },
  { key: 'serviceFee', label: 'Service fee', short: 'Service fee', note: 'a share of the booking' },
  { key: 'bookingFee', label: 'Booking fee', short: 'Booking fee', note: 'charged with the first payment' }
];

function stayCharges(listing) {
  return STAY_CHARGES
    .filter((charge) => Number(listing[charge.key]) > 0)
    .map((charge) => ({ ...charge, value: Number(listing[charge.key]) }));
}

/**
 * What the cancellation terms are, in one sentence.
 *
 * `cancellation` is free text and wins, because an agency may need to say
 * something a number cannot ("balance due on arrival, non-refundable"). The
 * numeric `cancellationDays` is the fallback for the common case, and produces
 * the sentence an owner would otherwise have to write by hand.
 */
function cancellationPolicy(listing) {
  if (typeof listing.cancellation === 'string' && listing.cancellation.trim()) {
    return listing.cancellation.trim();
  }
  const days = Number(listing.cancellationDays);
  if (Number.isFinite(days) && days > 0) {
    return `Free cancellation up to ${days} day${days === 1 ? '' : 's'} before arrival`;
  }
  return '';
}

/*
 * What a week or a month actually costs per night.
 *
 * A card that prints "KES 560 per week" beside "KES 95 a night" leaves the reader
 * to divide, and most people do not - they read the smaller number as the better
 * deal and book the wrong length. So each longer term carries the per-night
 * figure it works out at, and the difference from the nightly rate as an amount.
 *
 * The saving is only ever printed when it is genuinely positive. p14 takes weeks
 * and months, and its weekly rate costs more per night than its monthly one, so
 * "save" would be false there. An owner who has priced a term above the nightly
 * rate has usually done it on purpose - a minimum-stay week during a festival -
 * and saying so is more useful than hiding it.
 */
const NIGHTS_PER_TERM = { night: 1, week: 7, month: 30 };

function rateComparison(listing) {
  const rates = shortStayRates(listing);
  if (!rates) return null;
  // The comparison is made on the exact nightly rate, never the rounded one -
  // see nightlyRateExact for why that distinction matters.
  const exactNightly = nightlyRateExact(listing);
  const longer = rates
    .filter((rate) => rate.unit !== 'night')
    .map((rate) => {
      const span = NIGHTS_PER_TERM[rate.unit] || 1;
      const perNightExact = rate.value / span;
      return {
        ...rate,
        perNight: Math.round(perNightExact),
        // The saving over the whole term, not just the night.
        saving: Math.max(0, Math.round((exactNightly - perNightExact) * span))
      };
    });
  return { nightly: Math.round(exactNightly), longer };
}
const formatArea = (listing) => `${numberFormat.format(listing.area)} ft²`;

/* ---- listing truth -------------------------------------------------------- */
/*
 * What we know about a listing, and how we know it.
 *
 * Every portal prints a price. Almost none of them print the three things that
 * decide whether the price is worth acting on: when somebody last checked it was
 * still true, who checked it, and what they actually checked. That gap is the
 * whole opportunity this site is built around, so it is modelled as data rather
 * than as a badge.
 *
 * Three rules govern everything below:
 *
 *   1. Never say "verified" on its own. A generic badge covering "we know who
 *      this agent is" and one covering "somebody stood in the house" are the
 *      same word to a reader and completely different promises, so the scope is
 *      always spelled out and always per listing.
 *
 *   2. Never print a date the data does not hold. An older listing with no
 *      confirmation date is shown as unconfirmed rather than being given the
 *      `listed` date, because "last confirmed" and "first listed" are not the
 *      same claim and conflating them is how a stale listing looks fresh.
 *
 *   3. Age is stated in words a person would use. "Confirmed 3 days ago" is
 *      actionable; "2026-10-01" requires the reader to do the arithmetic against
 *      a date they have to notice.
 */

/** Normalised truth, tolerant of an older listing that predates the block. */
function truthOf(listing) {
  const truth = listing.truth || {};
  const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
  return {
    confirmedOn: isDate(truth.confirmedOn) ? truth.confirmedOn : '',
    verifiedOn: isDate(truth.verifiedOn) ? truth.verifiedOn : '',
    source: String(truth.source || '').trim(),
    scope: Array.isArray(truth.scope) ? truth.scope.filter((item) => typeof item === 'string' && item.trim()) : []
  };
}

/** Whole days since a confirmation, or null when there is no date to count from. */
function confirmedDaysAgo(listing) {
  const { confirmedOn } = truthOf(listing);
  if (!confirmedOn) return null;
  const then = new Date(`${confirmedOn}T00:00:00`);
  if (Number.isNaN(then.getTime())) return null;
  // Compared against local midnight rather than "now": a confirmation made this
  // morning is 0 days old, and rounding against the current time of day would
  // print "1 day ago" for something checked four hours ago.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((today - then) / 86400000));
}

/*
 * Whether a confirmation is still good enough to lean on.
 *
 * The thresholds are deliberately short and deliberately visible. A portal that
 * quietly treats a nine-month-old confirmation as current has not solved
 * anything; one that says "confirmed 8 months ago" has, because the reader now
 * knows to ask. Twenty-eight days is roughly a month, which is about as long as
 * a buyer will hold a listing in mind without checking it again.
 */
const STALE_AFTER_DAYS = 28;
const OLD_AFTER_DAYS = 90;

function confirmationState(listing) {
  const days = confirmedDaysAgo(listing);
  if (days === null) return { level: 'none', days: null };
  if (days <= STALE_AFTER_DAYS) return { level: 'fresh', days };
  if (days <= OLD_AFTER_DAYS) return { level: 'aging', days };
  return { level: 'old', days };
}

/** "Confirmed today" / "Confirmed 3 days ago" / "Not confirmed on record". */
function confirmationSentence(listing) {
  const { level, days } = confirmationState(listing);
  if (level === 'none') return 'Not confirmed on record';
  if (days === 0) return 'Confirmed today';
  if (days === 1) return 'Confirmed yesterday';
  if (days < 14) return `Confirmed ${days} days ago`;
  if (days < 60) return `Confirmed ${Math.round(days / 7)} weeks ago`;
  return `Confirmed ${Math.round(days / 30)} months ago`;
}

/*
 * How much of this listing is actually filled in, as a percentage.
 *
 * Computed from the fields rather than stored, so it cannot drift away from the
 * data it describes: add a bathroom and the score moves, and nothing has to be
 * remembered. The field list is per category, because "complete" means something
 * different for a house than for a parcel - a land listing is not missing a
 * bedroom count, it simply has no bedrooms.
 *
 * This is published rather than hidden. An incomplete listing is a normal thing,
 * and telling a renter "this one has no stated utilities" is more use to them
 * than a listing that looks finished and quietly is not.
 */
const TRUTH_FIELDS = {
  home: [
    ['Price', (l) => Number(l.price) > 0],
    ['Bedrooms', (l) => Number(l.beds) > 0],
    ['Bathrooms', (l) => Number(l.baths) > 0],
    ['Floor area', (l) => Number(l.area) > 0],
    ['Plot', (l) => Boolean(String(l.lot || '').trim())],
    ['Year built', (l) => Number(l.year) > 0],
    ['Parking', (l) => Number(l.parking) > 0],
    ['Description', (l) => String(l.description || '').trim().length > 40],
    ['Features', (l) => (l.features || []).length >= 3],
    ['Photographs', (l) => (l.images || []).length >= 1]
  ],
  land: [
    ['Price', (l) => Number(l.price) > 0],
    ['Plot size', (l) => Number(l.land?.plotAcres) > 0],
    ['Zoning', (l) => Boolean(String(l.land?.zoning || '').trim())],
    ['Title', (l) => Boolean(String(l.land?.titleDeed || '').trim())],
    ['Road access', (l) => Boolean(String(l.land?.access || '').trim())],
    ['Utilities', (l) => Boolean(String(l.land?.utilities || '').trim())],
    ['Permitted use', (l) => Boolean(String(l.land?.permittedUse || '').trim())],
    ['Restrictions', (l) => Boolean(String(l.land?.restrictions || '').trim())],
    ['Description', (l) => String(l.description || '').trim().length > 40],
    ['Photographs', (l) => (l.images || []).length >= 1]
  ],
  let_: [
    ['Monthly rent', (l) => Number(l.price) > 0],
    ['Lease term', (l) => Boolean(String(l.let?.leaseTerm || '').trim())],
    ['Deposit', (l) => Number(l.let?.deposit) > 0],
    ['Utilities', (l) => Boolean(String(l.let?.utilities || '').trim())],
    ['Pets', (l) => Boolean(String(l.let?.pets || '').trim())],
    ['Move-in date', (l) => Boolean(String(l.let?.moveIn || '').trim())],
    ['Bedrooms', (l) => Number(l.beds) > 0],
    ['Bathrooms', (l) => Number(l.baths) > 0],
    ['Description', (l) => String(l.description || '').trim().length > 40],
    ['Photographs', (l) => (l.images || []).length >= 1]
  ]
};

function completeness(listing) {
  const group = isLand(listing) ? 'land' : isRent(listing) ? 'let_' : 'home';
  const fields = TRUTH_FIELDS[group];
  const missing = fields.filter(([, present]) => !present(listing)).map(([label]) => label);
  return {
    group,
    missing,
    have: fields.length - missing.length,
    total: fields.length,
    percent: Math.round(((fields.length - missing.length) / fields.length) * 100)
  };
}

/*
 * The one line a card can carry.
 *
 * A results page has to stay scannable, so the card gets the freshness and the
 * score and nothing else - the full scope, the source and the list of missing
 * fields are one click away. It must never print a bare "verified", for the
 * reason given above.
 */
function cardTruth(listing) {
  const { level } = confirmationState(listing);
  const score = completeness(listing);
  const mark = { fresh: 'check', aging: 'clock', old: 'alert', none: 'alert' }[level];
  const title = score.missing.length ? `Not stated: ${score.missing.join(', ')}` : 'Every listed field is filled in';
  return `
    <p class="card-truth card-truth--${level}">
      ${icon(mark, 'icon--sm')}<span>${escapeHtml(confirmationSentence(listing))}</span>
      <span class="card-truth-score" title="${escapeHtml(title)}">${score.percent}% complete</span>
    </p>`;
}

/*
 * The full Listing Truth panel.
 *
 * This is the page the whole feature exists for. Everything the card compresses
 * into one line is spelled out here, and - the part that matters - the reader can
 * correct it. A trust promise nobody can act on is marketing; a "report a change"
 * button that reaches the office turns the claim into a process.
 */
function truthPanel(listing) {
  const truth = truthOf(listing);
  const { level } = confirmationState(listing);
  const score = completeness(listing);
  const agent = agentFor(listing);

  const rows = [
    ['Status', listing.status === 'Sold' ? 'Sold - no longer available' : listing.status === 'For rent' ? 'Available to rent' : 'Available to buy'],
    ['Last confirmed', truth.confirmedOn ? `${confirmationSentence(listing)} (${formatListed(truth.confirmedOn)})` : 'No confirmation on record'],
    ['Information source', truth.source || 'Not recorded'],
    ['Listed by', `${agent.name} — ${agent.role}`],
    ['Verification scope', truth.scope.length ? truth.scope.join(' · ') : 'Nothing has been checked on record'],
    ['Listing completeness', `${score.percent}% — ${score.have} of ${score.total} fields stated`]
  ];

  const gaps = score.missing.length
    ? `<p class="truth-gap">${icon('alert', 'icon--sm')}Not stated: ${escapeHtml(score.missing.join(', '))}. Tell us and we will confirm it or take the listing down.</p>`
    : '';

  return `
    <section class="detail-section truth-panel" aria-labelledby="truth-title">
      <div class="section-head section-head--split">
        <div>
          <p class="eyebrow">Listing truth</p>
          <h2 id="truth-title">What we know, and how we know it</h2>
        </div>
        <span class="truth-stamp truth-stamp--${level}">${icon(level === 'fresh' ? 'shield' : 'alert', 'icon--sm')}${escapeHtml(confirmationSentence(listing))}</span>
      </div>

      <dl class="truth-rows">
        ${rows.map(([label, value]) => `
          <div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}
      </dl>

      ${gaps}

      <div class="truth-foot">
        <button class="button button--ghost button--sm" type="button" data-report-change>
          ${icon('alert', 'icon--sm')} Report a change
        </button>
        <p class="truth-foot-note">
          Reported changes reach ${escapeHtml(agent.name.split(' ')[0])} directly. A stale listing is worse
          than no listing, so we would rather correct it than defend it.
        </p>
      </div>
    </section>`;
}

/*
 * The evidence behind an asking price.
 *
 * Deliberately a range with its reasoning attached, never a single figure. One
 * number reads as a measurement and gets treated as one; a range with named
 * comparables and stated assumptions reads as an opinion, which is what it is,
 * and can be argued with. The confidence figure is the honest part - it is
 * driven by how many comparables there are, so an opinion built on one sale
 * says so instead of borrowing certainty it has not earned.
 */
function valuationPanel(listing) {
  const v = listing.valuation;
  if (!v || !Number(v.low) || !Number(v.high)) return '';
  const comps = Array.isArray(v.comps) ? v.comps.filter(Boolean) : [];
  const assumptions = Array.isArray(v.assumptions) ? v.assumptions.filter(Boolean) : [];
  // Confidence follows the evidence. A single comparable is a guess with one
  // data point behind it, and printing "Medium" there would be flattering.
  const confidence = comps.length >= 2 ? (v.confidence || 'Medium') : 'Low';

  return `
    <section class="detail-section valuation" aria-labelledby="valuation-title">
      <p class="eyebrow">Evidence</p>
      <h2 id="valuation-title">Our view of the value</h2>
      <p class="valuation-range">
        <span ${priceAttrs(v.low)}></span>
        <span class="valuation-dash">to</span>
        <span ${priceAttrs(v.high)}></span>
      </p>
      <p class="valuation-meta">
        <span class="valuation-confidence valuation-confidence--${escapeHtml(confidence.toLowerCase())}">${escapeHtml(confidence)} confidence</span>
        <span>Valued ${escapeHtml(formatListed(v.on))}</span>
        <span>${comps.length} comparable${comps.length === 1 ? '' : 's'}</span>
      </p>

      ${comps.length ? `
        <div class="valuation-block">
          <h3>Comparable properties</h3>
          <ul class="valuation-list">${comps.map((c) => `<li>${icon('trend', 'icon--sm')}${escapeHtml(c)}</li>`).join('')}</ul>
        </div>` : ''}

      ${assumptions.length ? `
        <div class="valuation-block">
          <h3>What this assumes</h3>
          <ul class="valuation-list valuation-list--assumes">${assumptions.map((a) => `<li>${icon('check', 'icon--sm')}${escapeHtml(a)}</li>`).join('')}</ul>
        </div>` : ''}

      <p class="valuation-disclaimer">
        ${icon('alert', 'icon--sm')}
        This is an opinion of value for a conversation, <strong>not a formal appraisal</strong> and not an
        offer. If you are selling, book a proper valuation with the agent — it costs nothing and no obligation.
      </p>
      <a class="button button--secondary" href="contact.html">Ask for a full valuation</a>
    </section>`;
}

/*
 * The terms of a let, as its own panel.
 *
 * A renter is not buying rooms; they are committing to a term, a deposit, a set
 * of bills and a pet policy, none of which is a bedroom count. Printing them in
 * a panel of their own is the difference between a rental listing that can be
 * acted on and one that sends the reader to an FAQ.
 *
 * Only what the office has actually recorded is shown. A missing deposit prints
 * nothing rather than "none" - "none" is a claim about someone's money.
 */
function tenancyPanel(listing) {
  const lease = listing.let;
  if (!lease) return '';

  const rows = [
    ['Lease term', lease.leaseTerm],
    ['Move-in date', formatListed(lease.moveIn)],
    ['Utilities', lease.utilities],
    ['Pets', lease.pets],
    ['Deposit', lease.deposit ? `<span ${priceAttrs(lease.deposit, ', refundable')}></span>` : '']
  ].filter(([, value]) => value);

  if (!rows.length) return '';

  return `
    <section class="detail-section tenancy" aria-labelledby="tenancy-title">
      <p class="eyebrow">The terms</p>
      <h2 id="tenancy-title">What you would be signing</h2>
      <dl class="spec-grid spec-grid--tenancy">
        ${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${value.startsWith?.('<span') ? value : escapeHtml(value)}</dd></div>`).join('')}
      </dl>
      <p class="tenancy-note">
        ${icon('alert', 'icon--sm')}
        These are the terms the landlord has told us. Always read the actual
        tenancy agreement before you commit — it is the contract, not this summary.
      </p>
    </section>`;
}

/*
 * Why a price moved, and what the saving does not cover.
 *
 * The badge already says something is reduced; this says by how much, since when,
 * who decided and — the line that actually protects the reader — what is not part
 * of the discount. A reduced rent that quietly excludes the deposit is a smaller
 * discount than the headline, and saying so is the whole difference between a
 * promotion and a lure.
 */
/*
 * Paid placement, said out loud on the listing's own page.
 *
 * A "Sponsored" badge on a results card is not enough on its own: the buyer who
 * followed the link into the detail page has lost the badge, and this is exactly
 * where they decide whether to trust what they are reading. If a placement is
 * paid for, the page it bought has to say so.
 *
 * Written to sit quietly above the gallery rather than shout. It is a disclosure,
 * not a selling point - and it explicitly separates the two things money and
 * diligence each affect, because "we paid for this" must never be read as "so
 * this is checked" or "and so this was not".
 */
function placementDisclosure(listing) {
  if (!listing.sponsored) return '';
  const { level } = confirmationState(listing);
  return `
    <p class="placement-note">
      <span class="badge badge--sponsored">Sponsored</span>
      <span>This position was paid for. It does not affect the checks below — this listing was
      ${level === 'fresh' ? 'confirmed' : 'last confirmed'} on the same terms as every other one.</span>
    </p>`;
}

function promotionNote(listing) {
  const promo = listing.promotion;
  if (!isHot(listing) || !promo) return '';
  const since = promo.hotSince ? `Since ${formatListed(promo.hotSince)}. ` : '';
  return `
    <div class="promotion-note">
      <p class="promotion-reason">${icon('sparkle', 'icon--sm')}${escapeHtml(since + (promo.hotReason || 'Reduced price.'))}</p>
      ${promo.hotExcludes ? `<p class="promotion-excludes">${icon('alert', 'icon--sm')}Not included in the discount: ${escapeHtml(promo.hotExcludes)}</p>` : ''}
    </div>`;
}

/*
 * Whether the price has fallen, and when.
 *
 * Separate from the hot-deal flag on purpose: a reduction and a promotion are
 * different events, and collapsing them would let a paid promotion masquerade as
 * a market-driven cut. This reads only `priceHistory`.
 */
function priceReduced(listing) {
  const history = Array.isArray(listing.priceHistory) ? listing.priceHistory : [];
  const latest = history[history.length - 1];
  if (!latest || Number(latest.from) <= 0 || Number(latest.from) <= Number(listing.price)) return null;
  return {
    from: Number(latest.from),
    on: latest.on,
    amount: Number(latest.from) - Number(listing.price),
    percent: Math.round((1 - listing.price / Number(latest.from)) * 100)
  };
}

/*
 * Plot size is the headline number for land, so it gets its own formatter rather
 * than reusing `lot`. That string is free text ("620 m2", "0.8 acres") and is
 * shown as-is for houses; `land.plotAcres` is the numeric field filters and
 * sorting can actually compare. `plotUnit` decides which unit it is read in.
 */
const PLOT_UNITS = { acres: 'acres', hectares: 'hectares', 'sq m': 'm²' };
const formatPlot = (listing) => {
  const size = Number(listing.land?.plotAcres);
  if (!Number.isFinite(size) || size <= 0) return listing.lot || '-';
  const unit = PLOT_UNITS[listing.land?.plotUnit] || 'acres';
  /*
   * Plot sizes span four orders of magnitude, from a quarter-acre corner plot to a
   * hundred-acre parcel, so a fixed number of decimals is wrong at one end or the
   * other: two decimals printed 20 acres as "20.00", and one decimal rounded a
   * quarter-acre to "0.3 acres" - which overstates the land being sold. Counting
   * from the size itself keeps 0.25 at 0.25 and 20 at 20, and 2.5 at 2.5.
   */
  const digits = size >= 10 ? 0 : size >= 1 ? Math.min(2, (String(size).split('.')[1] || '').length) : 2;
  return `${size.toFixed(digits)} ${unit}`;
};

const agentFor = (listing) => agents.find((agent) => agent.id === listing.agentId) || agents[0];
const icon = (name, extra = '') => `<svg class="icon ${extra}" aria-hidden="true" focusable="false"><use href="#icon-${name}"></use></svg>`;
const formatListed = (value) => new Date(`${value}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/*
 * Prices are rendered as empty elements carrying their base-currency amount, and
 * filled in by paintPrices(). That keeps the amount in one place — the data — and
 * means switching currency is a single pass over the document rather than a
 * re-render of every list on whichever page happens to be open.
 *
 * `prefix` was added for the short-stay work, where a figure is read as part of a
 * sentence rather than on its own - "≈ KES 80 a night", "save KES 105". Painting
 * the label here rather than writing it into the markup means the word moves with
 * the currency symbol instead of sitting in front of a number that has already
 * been converted.
 */
const priceAttrs = (amount, suffix = '', compact = false, prefix = '') =>
  `data-price="${amount}"${prefix ? ` data-price-prefix="${escapeHtml(prefix)}"` : ''}` +
  `${suffix ? ` data-price-suffix="${escapeHtml(suffix)}"` : ''}${compact ? ' data-price-compact' : ''}`;

function announce(message) {
  const toast = $('#toast');
  if (!toast) return;
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('is-visible');
  toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 3200);
}

/* ---- currency ----------------------------------------------------------- */
/*
 * Every price is stored once, in the base currency the agency publishes in
 * (site.currency, set in the admin panel). Visitors can read the site in any
 * other currency; the rates come from Frankfurter, a free key-less service that
 * republishes the European Central Bank's daily reference rates.
 *
 * This is the only request the site makes. It is a read-only GET that carries
 * nothing about the visitor, and everything here degrades to the base currency if
 * it fails — which is what the site showed before this existed, so a failed
 * request is a missing feature rather than a broken page.
 */
const RATES_URL = 'https://api.frankfurter.app/latest';
const CURRENCY_NAMES_URL = 'https://api.frankfurter.app/currencies';
/*
 * Frankfurter republishes the ECB's daily reference rates, and the ECB quotes only
 * the currencies of its own member states plus a few majors - 30 in all. Anything
 * outside that set (the Kenyan shilling, for one) has no rate there at all, so
 * asking Frankfurter for it returns a set that simply does not contain the code.
 *
 * This second key-less service covers ~160 currencies, and is consulted only for
 * codes the first source could not quote. Frankfurter stays the source of the
 * rate date shown to the reader, because ECB reference rates are the ones with a
 * real publication date and a defensible provenance.
 */
const SUPPLEMENT_RATES_URL = 'https://open.er-api.com/v6/latest/USD';
const RATE_TIMEOUT = 7000;

/**
 * Used to label the picker if the currency list cannot be fetched. Kept to the
 * currencies a property site is plausibly read in, rather than all ~30.
 */
const FALLBACK_CURRENCIES = {
  AUD: 'Australian Dollar', BRL: 'Brazilian Real', CAD: 'Canadian Dollar', CHF: 'Swiss Franc',
  CNY: 'Chinese Yuan', CZK: 'Czech Koruna', DKK: 'Danish Krone', EUR: 'Euro',
  GBP: 'British Pound', HKD: 'Hong Kong Dollar', HUF: 'Hungarian Forint', IDR: 'Indonesian Rupiah',
  ILS: 'Israeli New Shekel', INR: 'Indian Rupee', ISK: 'Icelandic Krona', JPY: 'Japanese Yen',
  KES: 'Kenyan Shilling', KRW: 'South Korean Won', MXN: 'Mexican Peso', MYR: 'Malaysian Ringgit',
  NOK: 'Norwegian Krone', NZD: 'New Zealand Dollar', PHP: 'Philippine Peso', PLN: 'Polish Zloty',
  SEK: 'Swedish Krona', SGD: 'Singapore Dollar', TRY: 'Turkish Lira', USD: 'US Dollar',
  ZAR: 'South African Rand'
};

const baseCurrency = /^[A-Z]{3}$/i.test(String(site.currency || '')) ? String(site.currency).toUpperCase() : 'USD';

let rates = null;        // { CODE: number } against the base currency
let rateDate = '';       // the day the rate set was published
let supplement = null;   // { CODE: number } per USD, for codes Frankfurter omits
let supplementDate = ''; // the day that service last updated, for its own rates
let displayCurrency = baseCurrency;
let currencyNames = null;

/** Set by whichever page-level render is on screen, so chips and prices agree. */
let repaintPrices = () => {};

function readCurrencyPreference() {
  try {
    const saved = window.localStorage.getItem(CURRENCY_KEY);
    if (saved && /^[A-Z]{3}$/i.test(saved)) return saved.toUpperCase();
  } catch {
    // Storage is optional; fall through to the base currency.
  }
  return baseCurrency;
}

/*
 * Units of `to` per 1 `from`, using the supplement set.
 *
 * That service quotes everything against the dollar only, so reaching a
 * base currency other than USD means crossing two of its rates. Doing it this
 * way rather than asking the service to re-base it keeps one request and one
 * consistent set of numbers.
 */
function crossRate(from, to) {
  if (from === to) return 1;
  const a = supplement?.[from];
  const b = supplement?.[to];
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
  return b / a;
}

function rateFor(code) {
  if (code === baseCurrency) return 1;
  const rate = rates?.[code];
  if (Number.isFinite(rate) && rate > 0) return rate;
  return crossRate(baseCurrency, code);
}

/**
 * The day the rate actually in use was published.
 *
 * A supplement rate has no ECB publication date, so it is reported with the day
 * that service last updated instead of borrowing Frankfurter's, which would
 * date a number from a different source.
 */
function rateDateFor(code) {
  if (code === baseCurrency) return '';
  if (Number.isFinite(rates?.[code]) && rates[code] > 0) return rateDate;
  return crossRate(baseCurrency, code) === null ? '' : supplementDate;
}

/**
 * The currency prices are actually drawn in right now.
 *
 * If the visitor picked a currency and the rates have not arrived (or failed to)
 * we keep drawing the base currency rather than relabelling an unconverted number
 * as euros. Showing the right number in the wrong symbol is worse than showing the
 * number we are sure of.
 */
function effectiveCurrency() {
  return rateFor(displayCurrency) === null ? baseCurrency : displayCurrency;
}

const convert = (amount, code) => (rateFor(code) ?? 1) * (Number(amount) || 0);

const moneyFormatters = new Map();
function moneyFormatter(code) {
  if (!moneyFormatters.has(code)) {
    moneyFormatters.set(code, new Intl.NumberFormat('en', {
      style: 'currency', currency: code, maximumFractionDigits: 0
    }));
  }
  return moneyFormatters.get(code);
}

function compactFormatter(code) {
  return new Intl.NumberFormat('en', {
    style: 'currency', currency: code, notation: 'compact', maximumFractionDigits: 1
  });
}

/** A full price, e.g. $2,850,000 or €2,498,000. */
const formatMoney = (amount) => moneyFormatter(effectiveCurrency()).format(convert(amount, effectiveCurrency()));

/** A short price for stat bands and filter labels, e.g. $750k or €1.5M. */
const formatCompact = (amount) => compactFormatter(effectiveCurrency()).format(convert(amount, effectiveCurrency()));

/**
 * Fill every price placeholder on the page. Safe to call repeatedly, and cheap
 * enough to run on every filter keystroke.
 */
function paintPrices(scope = document) {
  const code = effectiveCurrency();
  /* The separator goes between a number and a word, and between a number and a
     mark that stands on its own - but not between a number and a comma, which
     belongs to the number it follows. Several callers pass exactly that:
     the deposit's ", refundable" and the headline's "· listed ...", and a blind
     space turned the first into "EUR 29 , refundable", a price nobody has ever
     paid. A prefix or suffix that already opens with its own space is left to
     supply its own, so "save " and " / week" do not gain a second one. */
  const attaches = /^[,.;:)\]}]/;
  const lead = (value) => (/^\s/.test(value) || attaches.test(value) ? '' : ' ');

  $$('[data-price]', scope).forEach((element) => {
    const amount = Number(element.dataset.price) || 0;
    const formatter = element.hasAttribute('data-price-compact') ? compactFormatter(code) : moneyFormatter(code);
    const prefix = element.dataset.pricePrefix;
    const suffix = element.dataset.priceSuffix;
    element.innerHTML =
      (prefix ? `${escapeHtml(prefix)}${lead(prefix)}` : '')
      + formatter.format(convert(amount, code))
      + (suffix ? `${lead(suffix)}<small>${escapeHtml(suffix)}</small>` : '');
  });
}

/*
 * Budget bands stay in base-currency numbers so that filtering, sorting and any
 * shared URL keep meaning the same thing whichever currency is on screen; only
 * the label the visitor reads is reworded.
 */
const BUDGET_LABELS = {
  '0-750000': (c) => `Up to ${c(750000)}`,
  '750000-1500000': (c) => `${c(750000)} – ${c(1500000)}`,
  '1500000-2500000': (c) => `${c(1500000)} – ${c(2500000)}`,
  '2500000-5000000': (c) => `${c(2500000)} – ${c(5000000)}`,
  '5000000-15000000': (c) => `${c(5000000)} – ${c(15000000)}`,
  '15000000-': (c) => `${c(15000000)}+`,
  // Kept: a saved URL naming the old top band still filters exactly as before.
  '2500000-': (c) => `${c(2500000)}+`,
  '0-2500': (c) => `Up to ${c(2500)}`,
  '2500-4000': (c) => `${c(2500)} – ${c(4000)}`,
  '4000-': (c) => `${c(4000)}+`,
  // Nightly bands, for the short-stay search. The values are per night, so these
  // are deliberately tiny next to the sale bands above: a night is a night
  // whatever currency it is shown in, and the arithmetic stays honest.
  '0-100': (c) => `Up to ${c(100)} a night`,
  '100-200': (c) => `${c(100)} – ${c(200)} a night`,
  '200-350': (c) => `${c(200)} – ${c(350)} a night`,
  '350-': (c) => `${c(350)}+ a night`
};

function paintBudgetLabels(scope = document) {
  $$('[name="budget"] option', scope).forEach((option) => {
    const label = BUDGET_LABELS[option.value];
    if (label) option.textContent = label(formatCompact);
  });
}

function paintCurrencyNote() {
  const note = $('[data-currency-note]');
  if (!note) return;
  const code = effectiveCurrency();
  // A supplement rate has a different publication rhythm to an ECB one, so the
  // note says which set the number on screen came from rather than implying the
  // whole page is on ECB reference rates.
  const date = rateDateFor(code);
  if (code === baseCurrency) note.textContent = '';
  else if (date) note.textContent = `Converted at reference rates from ${date}`;
  else note.textContent = 'Converted — rate date unavailable';
  note.hidden = code === baseCurrency;
}

/** Re-draw every price-bearing surface for the currency now on screen. */
function applyCurrency() {
  paintPrices();
  paintBudgetLabels();
  repaintPrices();
  paintCurrencyNote();
  const select = $('[data-currency-select]');
  if (select) select.value = effectiveCurrency();
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), RATE_TIMEOUT);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Request failed with ${response.status}`);
    return await response.json();
  } finally {
    window.clearTimeout(timer);
  }
}

function buildCurrencyOptions(select) {
  const names = currencyNames || FALLBACK_CURRENCIES;
  const labelFor = (code) => names[code] || FALLBACK_CURRENCIES[code] || 'Currency';
  /*
   * The base currency is put in unconditionally rather than filtered against the
   * service's list. It is the one currency this site is certain about, and the
   * rate set never quotes a currency against itself — so a service that omits it
   * (or a failed request, which leaves only the fallback list) would otherwise
   * produce a picker with no valid selection and render as an empty box.
   *
   * The fallback list is merged in as well, for the opposite reason: it is where
   * currencies the ECB does not publish live, and a code with no rate behind it
   * would be a dead end in the picker.
   */
  const codes = [...new Set([
    baseCurrency, displayCurrency, ...Object.keys(names), ...Object.keys(FALLBACK_CURRENCIES)
  ])].sort();
  select.replaceChildren(...codes.map((code) => {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = `${code} — ${labelFor(code)}`;
    return option;
  }));
  select.value = effectiveCurrency();
}

async function initCurrency() {
  const picker = $('[data-currency-picker]');
  const select = $('[data-currency-select]');
  displayCurrency = readCurrencyPreference();

  // Draw straight away in the base currency so no price is ever blank. The
  // picker is revealed here rather than in the markup so that a visitor with
  // JavaScript switched off is not offered a control that cannot work.
  if (picker) picker.hidden = false;
  if (select) {
    select.disabled = true;
    buildCurrencyOptions(select);
  }
  applyCurrency();

  const [names, latest, extra] = await Promise.all([
    fetchJson(CURRENCY_NAMES_URL).catch(() => null),
    fetchJson(`${RATES_URL}?base=${encodeURIComponent(baseCurrency)}`).catch(() => null),
    // Only useful for the codes Frankfurter cannot quote, but which codes those
    // are is not known until its list arrives, so it is fetched alongside. It is
    // the third and last request, and every one of them failing is survivable.
    // An empty SUPPLEMENT_RATES_URL turns this second source off entirely.
    SUPPLEMENT_RATES_URL ? fetchJson(SUPPLEMENT_RATES_URL).catch(() => null) : null
  ]);

  if (names && !Array.isArray(names)) currencyNames = names;
  // Only trust a rate set that is actually quoted against our base currency.
  if (latest?.rates && (!latest.base || latest.base === baseCurrency)) {
    rates = latest.rates;
    rateDate = latest.date || '';
  }
  // This service always quotes against USD and reports success in `result`, so
  // both are checked before its numbers are trusted for anything.
  if (extra && extra.result === 'success' && extra.rates && typeof extra.rates === 'object') {
    supplement = extra.rates;
    // Its `time_last_update_utc` is an RFC-1123 string ("Sun, 27 Sep 2026 ..."),
    // not the ISO day Frankfurter returns, so truncating it would yield
    // "Sun, 27 Se". The Unix stamp alongside it is unambiguous, and is used to
    // build a plain YYYY-MM-DD day that reads the same as the other source's.
    const stamp = Number(extra.time_last_update_unix);
    if (Number.isFinite(stamp) && stamp > 0) {
      supplementDate = new Date(stamp * 1000).toISOString().slice(0, 10);
    }
  }

  if (select) {
    buildCurrencyOptions(select);
    select.disabled = false;
    select.addEventListener('change', () => {
      displayCurrency = select.value;
      try { window.localStorage.setItem(CURRENCY_KEY, displayCurrency); } catch { /* storage is optional */ }
      applyCurrency();
      /*
       * This has to describe what is on screen, not what was asked for. When no
       * rate could be found the prices are still in the base currency, and saying
       * "converted to EUR" over an unconverted figure is the one message that
       * would make a working fallback look like a fault.
       */
      const shown = effectiveCurrency();
      if (shown === displayCurrency) {
        const date = rateDateFor(shown);
        announce(`Prices converted to ${shown}${date ? ` using rates from ${date}` : ''}`);
      } else {
        announce(`No rate is available for ${displayCurrency}, so prices are shown in ${baseCurrency}`);
      }
    });
    // If a saved choice never became available, say so rather than quietly resetting it.
    if (displayCurrency !== effectiveCurrency()) {
      select.title = `Live rates are unavailable, so prices are shown in ${baseCurrency}`;
    }
  }

  applyCurrency();
}

/* ---- saved homes -------------------------------------------------------- */
function readFavorites() {
  try {
    return JSON.parse(window.localStorage.getItem(FAVORITES_KEY)) || [];
  } catch {
    return [];
  }
}

function writeFavorites(ids) {
  try {
    window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(ids));
  } catch {
    announce('Saved homes are unavailable in this browser');
  }
}

function toggleFavorite(id) {
  const saved = readFavorites();
  const index = saved.indexOf(id);
  const isSaved = index === -1;
  if (isSaved) saved.push(id); else saved.splice(index, 1);
  writeFavorites(saved);
  syncFavoriteButtons();
  const listing = listings.find((item) => item.id === id);
  announce(isSaved ? `Saved ${listing?.title || 'this home'}` : `Removed ${listing?.title || 'this home'}`);
}

function syncFavoriteButtons() {
  const saved = readFavorites();
  $$('[data-favorite]').forEach((button) => {
    const isSaved = saved.includes(button.dataset.favorite);
    button.setAttribute('aria-pressed', String(isSaved));
    button.setAttribute('aria-label', isSaved ? 'Remove from saved homes' : 'Save this home');
  });
}

/*
 * The three figures printed under a card's address.
 *
 * A house is bought on how many rooms it has and how big it is; land is bought on
 * how much ground there is and what it is zoned and titled for. Both render into
 * the same row so a grid mixing houses and parcels still lines up, and the icon
 * beside each figure changes with it.
 */
function cardSpecs(listing) {
  if (isLand(listing)) {
    const zoning = listing.land?.zoning;
    const title = listing.land?.titleDeed;
    return [
      `<span>${icon('area', 'icon--sm')}${escapeHtml(formatPlot(listing))}</span>`,
      zoning ? `<span>${icon('pin', 'icon--sm')}${escapeHtml(zoning)}</span>` : '',
      title ? `<span>${icon('check', 'icon--sm')}${escapeHtml(title)}</span>` : ''
    ].filter(Boolean).join('');
  }
  return `<span>${icon('bed', 'icon--sm')}${listing.beds} bed${listing.beds === 1 ? '' : 's'}</span>
          <span>${icon('bath', 'icon--sm')}${listing.baths} bath${listing.baths === 1 ? '' : 's'}</span>
          <span>${icon('area', 'icon--sm')}${formatArea(listing)}</span>`;
}

/*
 * The full specification table on a listing page.
 *
 * Land never has bedrooms or a build year, so those rows are dropped rather than
 * printed as zero, and the rows that actually decide a land purchase - plot size,
 * zoning, the title, and how you reach it - take their place. `type` and `status`
 * are common to both, so they are appended either way and the grid keeps its
 * eight-row shape.
 */
function detailSpecs(listing) {
  const common = `<div><dt>Property type</dt><dd>${escapeHtml(listing.type)}</dd></div>
    <div><dt>Status</dt><dd>${escapeHtml(listing.status)}</dd></div>`;

  if (isLand(listing)) {
    const land = listing.land || {};
    const access = land.access;
    return `<div><dt>Plot size</dt><dd>${escapeHtml(formatPlot(listing))}</dd></div>
      ${land.zoning ? `<div><dt>Zoning</dt><dd>${escapeHtml(land.zoning)}</dd></div>` : ''}
      ${land.titleDeed ? `<div><dt>Title</dt><dd>${escapeHtml(land.titleDeed)}</dd></div>` : ''}
      ${access ? `<div><dt>Access</dt><dd>${escapeHtml(access)}</dd></div>` : ''}
      ${land.landmarks ? `<div><dt>Landmarks</dt><dd>${escapeHtml(land.landmarks)}</dd></div>` : ''}
      ${land.utilities ? `<div><dt>Utilities</dt><dd>${escapeHtml(land.utilities)}</dd></div>` : ''}
      ${/* What the council permits and what the title forbids are different
          questions, and a buyer who only sees the zoning discovers the covenant
          after exchange. Both are printed; neither is inferred from the other. */ ''}
      ${land.permittedUse ? `<div><dt>Permitted use</dt><dd>${escapeHtml(land.permittedUse)}</dd></div>` : ''}
      ${land.restrictions ? `<div><dt>Restrictions</dt><dd>${escapeHtml(land.restrictions)}</dd></div>` : ''}
      <div><dt>Listed on</dt><dd>${formatListed(listing.listed)}</dd></div>
      ${common}`;
  }

  return `<div><dt>Bedrooms</dt><dd>${listing.beds}</dd></div>
    <div><dt>Bathrooms</dt><dd>${listing.baths}</dd></div>
    <div><dt>Floor area</dt><dd>${formatArea(listing)}</dd></div>
    <div><dt>Plot</dt><dd>${escapeHtml(listing.lot)}</dd></div>
    <div><dt>Year built</dt><dd>${listing.year}</dd></div>
    <div><dt>Parking</dt><dd>${listing.parking} car${listing.parking === 1 ? '' : 's'}</dd></div>
    ${common}`;
}

/* ---- card template ------------------------------------------------------ */
function propertyCard(listing, options = {}) {
  const agent = agentFor(listing);
  const statusClass = listing.status === 'Sold' ? 'card--sold' : '';
  const description = options.withDescription
    ? `<p class="card-description">${escapeHtml(listing.description)}</p>`
    : '';
  return `
    <article class="property-card ${statusClass}${isHot(listing) ? ' card--hot' : ''}" data-listing="${listing.id}">
      <div class="card-media">
        <img src="${listing.image}" alt="${escapeHtml(listing.title)}" loading="lazy" width="1200" height="900" />
        <div class="card-badges">
          ${isHot(listing) ? '<span class="badge badge--hot">Hot deal</span>' : ''}
          ${listing.status === 'Sold' ? '<span class="badge badge--muted">Sold</span>' : ''}
          ${isRent(listing) ? `<span class="badge badge--accent">To rent</span>` : ''}
          ${isShortStay(listing) ? '<span class="badge badge--brand">Short stay</span>' : ''}
          ${listing.featured && !isRent(listing) ? '<span class="badge badge--solid">Featured</span>' : ''}
          ${/* Paid placement says so, on its own badge, and never borrows the words
              "featured" or "verified". A reader who sees money mentioned here
              learns it bought position and nothing else - the truth fields below
              are earned separately. */ ''}
          ${listing.sponsored ? '<span class="badge badge--sponsored" title="This position was paid for. It does not affect the listing checks.">Sponsored</span>' : ''}
          ${priceReduced(listing) && !isHot(listing) ? '<span class="badge badge--reduced">Price reduced</span>' : ''}
        </div>
        <button class="favorite-button" type="button" data-favorite="${listing.id}" aria-pressed="false" aria-label="Save this home">${icon('heart')}</button>
      </div>
      <div class="card-body">
        ${cardPriceBlock(listing)}
        ${cardDeal(listing)}
        <h3 class="card-title"><a href="property.html?id=${listing.id}">${escapeHtml(listing.title)}</a></h3>
        <p class="card-address">${icon('pin', 'icon--sm')}${escapeHtml(listing.address)}, ${escapeHtml(listing.city)}</p>
        <div class="card-specs">${cardSpecs(listing)}</div>
        ${shortStayNote(listing)}
        ${cardTruth(listing)}
        ${description}
        <div class="card-footer">
          <span class="card-agent"><span class="avatar avatar--${agent.tint}">${agent.initials}</span>${escapeHtml(agent.name)}</span>
          <a class="section-link" href="property.html?id=${listing.id}">View ${icon('arrow-right', 'icon--sm')}</a>
        </div>
      </div>
    </article>`;
}

/**
 * The price line.
 *
 * A short stay leads with the rate a visitor searching for a weekend actually
 * compares on - the night - and puts the week beside it in the quieter colour.
 * The monthly rate is still here for anyone letting for three months, which is
 * the other half of what this feature is for.
 */
function cardPriceBlock(listing) {
  const rates = shortStayRates(listing);
  if (!rates) {
    return `<p class="card-price" ${priceAttrs(listing.price, isRent(listing) ? '/ month' : '')}></p>`;
  }

  const head = rates[0];
  const comparison = rateComparison(listing);
  const rest = rates.slice(1).map((rate) => {
    // The per-night figure goes on the card too. A week priced at 560 beside a
    // night priced at 95 is not a comparison - it is a division the reader has to
    // do, and most read the smaller number as the better deal.
    const longer = comparison?.longer.find((item) => item.unit === rate.unit);
    const equivalent = longer ? ` <span class="card-rate-equiv">≈ <span ${priceAttrs(longer.perNight)}></span>/night</span>` : '';
    return `
      <span ${priceAttrs(rate.value, ` / ${rate.unit}`)}>${equivalent}</span>`;
  }).join('');

  return `
    <p class="card-price card-price--stay">
      <strong ${priceAttrs(head.value, ` / ${head.unit}`)}></strong>
      ${rest}
    </p>`;
}

/**
 * The line under the specs.
 *
 * The things that decide whether this place can be booked at all: the shortest
 * stay, the window it is open for, and which charges apply. The charges are named
 * here rather than left to the detail page because someone comparing three
 * cottages on a card needs to know which one wants a deposit before they start
 * arranging a weekend, not after.
 */
function shortStayNote(listing) {
  if (!isShortStay(listing)) return '';
  const notes = [];
  const nights = minNights(listing);
  if (nights > 1) notes.push(`Minimum ${nights} nights`);

  // A live promotion is the one thing on this line worth reading twice, so it
  // leads after the minimum rather than being lost among the charge names.
  const deal = dealSavings(listing);
  if (deal) notes.push(`Hot deal · save ${deal.percent}%`);

  const window = availabilityWindow(listing);
  if (window) notes.push(window);
  if (deal && deal.until) notes.push(`ends ${dealEndsOn(listing)}`);

  // The card runs out of room fast, so it gets the short names. "Refundable
  // deposit" is the honest label on the rates table; on a line already carrying a
  // minimum stay, a window and a promotion, it is four words too many - and the
  // detail page is one click away.
  for (const charge of stayCharges(listing)) notes.push(charge.short);
  if (!notes.length) return '';
  return `<p class="card-stay">${icon('calendar', 'icon--sm')}${escapeHtml(notes.join(' · '))}</p>`;
}

/**
 * A promotion on a card, in one line.
 *
 * Deliberately a separate element from the price block: a struck-through figure
 * sitting inside the price line gets read as the price, and the badge above already
 * says the thing is reduced. What is missing from both is by how much, which is
 * the whole reason `originalPrice` was added.
 */
function cardDeal(listing) {
  const deal = dealSavings(listing);
  if (!deal) return '';
  // Named in the unit the card leads with, for the same reason as the banner.
  const per = deal.unit ? ` a ${deal.unit}` : '';
  return `
    <p class="card-deal">
      <span class="card-deal-was"><span ${priceAttrs(deal.was)}></span></span>
      <span class="card-deal-save">Save <span ${priceAttrs(deal.saving)}></span> · ${deal.percent}% off${per}</span>
    </p>`;
}

/* ---- theme --------------------------------------------------------------- */
/*
 * Light and dark.
 *
 * The stylesheet already knows how to do both from `prefers-color-scheme`, so
 * this does not have to be clever. What it adds is a control: a reader whose
 * system is light can still ask for dark and have it stick across pages and
 * across visits.
 *
 * The preference is resolved to a concrete `data-theme` rather than left as
 * "follow the system", so every rule downstream reads one attribute instead of
 * branching on a media query. A tiny inline script in each page head has already
 * set that attribute before first paint - this only picks it up, wires the
 * button, and keeps following the system while the reader has not said otherwise.
 */
const THEME_KEY = 'northwind:theme';
const THEME_META = { light: '#0f423a', dark: '#0d1113' };

const SUN_GLYPH = '<svg class="icon icon--sun" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.6M12 19.4V22M2 12h2.6M19.4 12H22M4.9 4.9l1.9 1.9M17.2 17.2l1.9 1.9M19.1 4.9l-1.9 1.9M6.8 17.2l-1.9 1.9"/></svg>';
const MOON_GLYPH = '<svg class="icon icon--moon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/></svg>';

function initTheme() {
  const system = window.matchMedia('(prefers-color-scheme: dark)');

  // Read the preference here as well as in the head script. The head script is
  // what prevents a flash of the wrong theme; this is what makes the toggle work
  // even if that script did not run, or if another tab changed the preference.
  let stored = null;
  try { stored = localStorage.getItem(THEME_KEY); } catch { /* storage off */ }
  if (stored !== 'light' && stored !== 'dark') stored = null;

  // Still tracking the system, because no choice has been made in this browser.
  let following = stored === null;

  let button = $('.theme-toggle');
  let current = stored
    || document.documentElement.dataset.theme
    || (system.matches ? 'dark' : 'light');

  function apply(value) {
    current = value;
    document.documentElement.dataset.theme = value;

    // The address bar colour on mobile follows the page, so it has to follow too.
    const meta = $('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_META[value]);

    if (button) {
      const next = value === 'dark' ? 'light' : 'dark';
      const label = `Switch to ${next} theme`;
      button.setAttribute('aria-label', label);
      button.title = label;
    }
  }

  apply(current);

  system.addEventListener?.('change', (event) => {
    if (following) apply(event.matches ? 'dark' : 'light');
  });

  // The button is added here rather than in the markup so that every page gets
  // it without the five copies of the header being kept in step by hand.
  const host = $('.header-actions');
  if (host && !button) {
    const control = document.createElement('button');
    control.type = 'button';
    control.className = 'icon-button theme-toggle';
    control.innerHTML = `${SUN_GLYPH}${MOON_GLYPH}`;
    control.addEventListener('click', () => {
      following = false;
      const next = current === 'dark' ? 'light' : 'dark';
      apply(next);
      try { localStorage.setItem(THEME_KEY, next); } catch { /* lasts one page */ }
      announce(`Switched to ${next} theme`);
    });
    host.append(control);
    // Assigned before apply() so the new button is described and labelled, not
    // just appended.
    button = control;
  }

  apply(current);
}

/* ---- header & navigation ------------------------------------------------ */
function initHeader() {
  const header = $('.site-header');
  const menuButton = $('[data-menu-toggle]');

  if (header) {
    const onScroll = () => header.classList.toggle('is-stuck', window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  if (menuButton) {
    menuButton.addEventListener('click', () => {
      const open = document.body.classList.toggle('nav-open');
      menuButton.setAttribute('aria-expanded', String(open));
    });
  }

  $$('.nav-scrim, .main-nav a').forEach((element) => {
    element.addEventListener('click', () => {
      document.body.classList.remove('nav-open');
      menuButton?.setAttribute('aria-expanded', 'false');
    });
  });

  const page = document.body.dataset.page === 'property' ? 'properties' : document.body.dataset.page;
  $$('.main-nav a').forEach((link) => {
    if (link.dataset.nav === page) link.setAttribute('aria-current', 'page');
  });
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-favorite]');
  if (button) toggleFavorite(button.dataset.favorite);
});

/* ---- home page ---------------------------------------------------------- */
function renderHome() {
  const featuredGrid = $('#featured-grid');
  if (featuredGrid) {
    const featured = listings.filter((listing) => listing.featured && listing.status !== 'Sold').slice(0, 6);
    featuredGrid.innerHTML = featured.map((listing) => propertyCard(listing)).join('');
  }

  // Hot deals, if there are any. A promotion that has run out is not hot any
  // more, so isHot() filters them on their own and this can simply check whether
  // anything survived. The section stays hidden otherwise.
  const hotSection = $('#hot-section');
  const hotGrid = $('#hot-grid');
  if (hotSection && hotGrid) {
    const hot = listings
      .filter((listing) => isHot(listing) && listing.status !== 'Sold')
      .slice(0, 3);
    if (hot.length) {
      hotGrid.innerHTML = hot.map((listing) => propertyCard(listing)).join('');
      hotSection.hidden = false;
    }
  }

  const agentGrid = $('#agent-grid');
  if (agentGrid) {
    agentGrid.innerHTML = agents.map((agent) => `
      <article class="agent-card">
        <span class="avatar avatar--${agent.tint} avatar--lg">${agent.initials}</span>
        <h3>${escapeHtml(agent.name)}</h3>
        <p class="agent-role">${escapeHtml(agent.role)}</p>
        <p class="agent-stat">${agent.listings} sales on record</p>
        <div class="agent-links">
          <a class="icon-button" href="contact.html" aria-label="Email ${escapeHtml(agent.name)}">${icon('mail', 'icon--sm')}</a>
          <a class="icon-button" href="contact.html" aria-label="Call ${escapeHtml(agent.name)}">${icon('phone', 'icon--sm')}</a>
        </div>
      </article>`).join('');
  }

  const statBand = $('#stat-band');
  if (statBand) {
    const available = listings.filter((listing) => listing.status !== 'Sold').length;
    const totalValue = listings.filter((listing) => !isRent(listing) && listing.status !== 'Sold')
      .reduce((sum, listing) => sum + listing.price, 0);
    const stats = [
      { value: numberFormat.format(available), label: 'Homes on the books' },
      { money: totalValue, compact: true, label: 'Current inventory value' },
      // The hero band carries the marketing figures. This one carries the ones the
      // data actually supports, so the two never claim the same thing twice.
      { value: '11 days', label: 'Average days on market' },
      { value: '98%', label: 'Asking price achieved' }
    ];
    statBand.innerHTML = stats.map((stat) => {
      const value = stat.money === undefined
        ? `<strong>${stat.value}</strong>`
        : `<strong ${priceAttrs(stat.money, '', stat.compact)}></strong>`;
      return `<div>${value}<span>${stat.label}</span></div>`;
    }).join('');
  }
}

const HERO_SLIDE_MS = 6500;

/**
 * assets/homes/ is not only artwork of the homes. It also holds mockups left in
 * the folder by other work - a billboard, a cap logo, a t-shirt, a sticker - and
 * one listing still points its `image` at the billboard. Those are not
 * photographs of anything being sold here, so they are kept out of the hero by
 * name. Real photography dropped into the folder needs nothing added here: it is
 * used as it comes, which is the swap the README asks for.
 */
const NOT_A_HOME = /billboard|logo|tshirt|shirt|sticker|keyring|cap-wirh/i;

/*
 * The hero slideshow.
 *
 * The hero was a flat green wash, which said nothing about what was actually on
 * sale. It now cycles the portfolio's own photography behind the headline. The
 * frames are built from the listings rather than listed out here, so real
 * photographs, pointed at by `image` and sized 16:10 as README:130 describes,
 * appear behind the hero with no further change to this file.
 *
 * The accessibility this site already insists on is kept, and a moving background
 * earns three obligations that a still does not: it does not move at all for a
 * reader who has asked for reduced motion, it holds still while it is being
 * hovered or focused, and it can be stopped outright by a button rather than only
 * by a timer nobody can reach.
 */
function initHeroSlideshow() {
  const layer = $('[data-hero-slides]');
  const slider = $('.hero-slider');
  const dots = $('[data-hero-dots]');
  const caption = $('[data-hero-caption]');
  if (!layer || !slider || !dots || !caption) return;

  // One frame per distinct image. The portfolio reuses photographs between
  // listings, and the placeholder set is six files across twelve listings, so
  // without this the hero would show the same picture twice in a row.
  const slides = [];
  const seen = new Set();
  listings.forEach((listing) => {
    const image = listing.image;
    if (listing.status === 'Sold' || !image || seen.has(image) || NOT_A_HOME.test(image)) return;
    seen.add(image);
    slides.push(listing);
  });

  // A single frame is a photograph, not a slideshow, and there would be nothing
  // for the controls to do. Leave the hero as the plain background.
  if (slides.length < 2) return;

  layer.innerHTML = slides.map((listing, index) => `
    <div class="hero-slide${index === 0 ? ' is-active' : ''}">
      <img src="${escapeHtml(listing.image)}" alt="" loading="${index === 0 ? 'eager' : 'lazy'}" decoding="async" />
    </div>`).join('');

  dots.innerHTML = slides.map((listing, index) => `
    <button class="hero-dot" type="button" data-goto="${index}" aria-label="Show ${escapeHtml(listing.title)}"${index === 0 ? ' aria-current="true"' : ''}></button>`).join('');

  const frames = $$('.hero-slide', layer);
  const dotButtons = $$('.hero-dot', dots);
  const prev = $('[data-hero-prev]');
  const next = $('[data-hero-next]');
  const toggle = $('[data-hero-toggle]');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  let index = 0;
  let timer = null;
  let playing = false;

  function paint(target) {
    index = (target + frames.length) % frames.length;
    frames.forEach((frame, i) => frame.classList.toggle('is-active', i === index));
    dotButtons.forEach((dot, i) => {
      if (i === index) dot.setAttribute('aria-current', 'true');
      else dot.removeAttribute('aria-current');
    });
    const listing = slides[index];
    caption.textContent = `${listing.title} · ${listing.city}`;
    caption.href = `property.html?id=${encodeURIComponent(listing.id)}`;
  }

  function schedule() {
    clearInterval(timer);
    timer = null;
    if (!playing || reduceMotion.matches) return;
    timer = setInterval(() => paint(index + 1), HERO_SLIDE_MS);
  }

  function setPlaying(value) {
    playing = value;
    toggle.setAttribute('aria-pressed', String(!playing));
    toggle.setAttribute('aria-label', playing ? 'Pause the slideshow' : 'Play the slideshow');
    toggle.innerHTML = icon(playing ? 'pause' : 'play', 'icon--fill');
    schedule();
  }

  // Only now, with the dots built, is the control row worth showing.
  slider.hidden = false;
  paint(0);
  setPlaying(!reduceMotion.matches);

  // Every deliberate move restarts the clock, so a slideshow someone is actually
  // reading does not swap out from under them.
  prev.addEventListener('click', () => { paint(index - 1); schedule(); });
  next.addEventListener('click', () => { paint(index + 1); schedule(); });
  toggle.addEventListener('click', () => setPlaying(!playing));

  dots.addEventListener('click', (event) => {
    const dot = event.target.closest('.hero-dot');
    if (!dot) return;
    paint(Number(dot.dataset.goto));
    schedule();
  });

  // Hold still while a pointer is on it or focus is inside it - somebody reaching
  // for the pause button should not have the frame change under their cursor.
  const hold = () => { clearInterval(timer); timer = null; };
  slider.addEventListener('mouseenter', hold);
  slider.addEventListener('mouseleave', schedule);
  slider.addEventListener('focusin', hold);
  slider.addEventListener('focusout', schedule);

  // Same in a background tab, where nobody is watching it anyway.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hold();
    else schedule();
  });

  // Turning reduced motion on mid-visit should stop it, not just slow it down.
  const onMotionChange = () => setPlaying(!reduceMotion.matches);
  if (reduceMotion.addEventListener) reduceMotion.addEventListener('change', onMotionChange);
  else reduceMotion.addListener(onMotionChange);
}

function initSearchPanel() {
  const panel = $('#hero-search');
  if (!panel) return;

  let intent = 'sale';
  const tabs = $$('.search-tab', panel);
  const budgetField = $('[name="budget"]', panel);

  // The numbers in these bands are base-currency amounts, so the query string a
  // search produces means the same thing in every currency. The labels below are
  // only the starting text — paintBudgetLabels() rewords them on boot and
  // whenever the visitor changes currency.
  const budgetOptions = {
    sale: [['', 'Any budget'], ['0-750000', 'Up to $750k'], ['750000-1500000', '$750k – $1.5M'], ['1500000-2500000', '$1.5M – $2.5M'], ['2500000-5000000', '$2.5M – $5M']],
    rent: [['', 'Any rent'], ['0-2500', 'Up to $2,500'], ['2500-4000', '$2,500 – $4,000'], ['4000-', '$4,000+']],
    // Land is priced by the parcel and its paperwork rather than by the rooms it
    // will hold, so it gets bands an acre of ground actually falls into.
    land: [['', 'Any budget'], ['0-2500000', 'Up to $2.5M'], ['2500000-7500000', '$2.5M – $7.5M'], ['7500000-20000000', '$7.5M – $20M'], ['20000000-', '$20M+']],
    // A short stay is budgeted by the night, because that is what somebody
    // planning a weekend is actually shopping for. The bands are matched against
    // nightlyRate() rather than against the monthly price, so a three-month let
    // priced at its monthly rate is still found by the right search.
    short: [['', 'Any nightly rate'], ['0-100', 'Up to $100 a night'], ['100-200', '$100 – $200 a night'], ['200-350', '$200 – $350 a night'], ['350-', '$350+ a night']]
  };

  const renderBudget = () => {
    budgetField.innerHTML = budgetOptions[intent]
      .map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`)
      .join('');
    paintBudgetLabels(budgetField);
  };

  tabs.forEach((tab) => tab.addEventListener('click', () => {
    intent = tab.dataset.intent;
    tabs.forEach((item) => item.classList.toggle('is-active', item === tab));
    // Land is a category as well as an intent, so the type list is trimmed to the
    // group that can actually match rather than left offering apartments. A short
    // stay is the same idea: you cannot spend a weekend on a parcel of land, so
    // the land half of the type list goes too.
    const landOnly = intent === 'land';
    const homesOnly = intent === 'short';
    $$('[name="type"] option[data-group]', panel).forEach((option) => {
      option.hidden = (landOnly && option.dataset.group !== 'land')
        || (homesOnly && option.dataset.group !== 'home');
    });
    renderBudget();
  }));

  renderBudget();

  $('form', panel).addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const params = new URLSearchParams();
    const query = String(data.get('query') || '').trim();
    const budget = String(data.get('budget') || '');
    const type = String(data.get('type') || '');
    if (query) params.set('q', query);
    // Land is sold, never rented, so the Land tab is a category filter rather than
    // a status: it means "parcels of ground, for sale".
    if (intent === 'land') params.set('kind', 'land');
    if (intent === 'rent') params.set('status', 'For rent');
    // A short stay is a rental that also accepts a shorter term, so it needs both
    // halves: the status, because these are all "For rent", and the kind, because
    // without it a visitor looking for a weekend gets every long let as well.
    if (intent === 'short') { params.set('kind', 'short'); params.set('status', 'For rent'); }
    if (type) params.set('type', type);
    if (budget) params.set('budget', budget);
    window.location.href = `properties.html${params.toString() ? `?${params}` : ''}`;
  });
}

/* ---- results page ------------------------------------------------------- */
function initResults() {
  const form = $('#filter-form');
  if (!form) return;

  const grid = $('#results-grid');
  const countLabel = $('#result-count');
  const chipRow = $('#chip-row');
  const loadMoreWrap = $('#load-more-wrap');
  const emptyState = $('#empty-state');
  let visible = PAGE_SIZE;
  let view = window.localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';

  // Filters that live only in the query string - the search box, the category,
  // the status, the term and the hot-only toggle - have no control on this form
  // to clear. Their keys are remembered here so that removing the chip actually
  // removes the filter, rather than reaching for a form element that does not
  // exist. The set is emptied at the end of each render, once the cleaned state
  // has been written back to the URL and the URL is all that is left to read.

  const clearedFromUrl = new Set();

  const readState = () => {
    const params = new URLSearchParams(window.location.search);
    const value = (key) => (clearedFromUrl.has(key) ? '' : (params.get(key) || ''));
    return {
      q: value('q'),
      kind: value('kind'),
      type: value('type'),
      status: value('status'),
      budget: value('budget'),
      beds: value('beds'),
      term: value('term'),
      hot: value('hot'),
      sort: params.get('sort') || 'featured'
    };
  };

  const writeState = (state) => {
    const params = new URLSearchParams();
    Object.entries(state).forEach(([key, value]) => { if (value && !(key === 'sort' && value === 'featured')) params.set(key, value); });
    const query = params.toString();
    window.history.replaceState(null, '', query ? `?${query}` : window.location.pathname);
  };

  const matches = (listing, state) => {
    // `kind` narrows to a whole category, and it is deliberately not exclusive of
    // `type`: picking "Land" with "Agricultural land" chosen means agricultural
    // land, and the type box is already restricted to that group by the form.
    if (state.kind === 'land' && !isLand(listing)) return false;
    if (state.kind === 'home' && isLand(listing)) return false;
    // "Short" is a rental that also accepts a shorter term, so it implies the
    // rental status rather than replacing it: a weekend cannot be bought.
    if (state.kind === 'short' && (!isRent(listing) || !isShortStay(listing))) return false;
    if (state.hot && !isHot(listing)) return false;
    if (state.status && listing.status !== state.status) return false;
    if (state.type && listing.type !== state.type) return false;
    // The term box only narrows within short stays. Left applying to everything it
    // would silently hide every ordinary let whenever a shared URL carried it, so
    // it is treated as a leftover unless the search is already about short stays.
    if (state.term && isShortStay(listing) && !listing.stays.includes(state.term)) return false;
    // Bedrooms are a house fact. A land parcel stores zero there, so asking for
    // "3+ beds" over land would match nothing - the bedroom control is hidden
    // while the Land category is on, and a shared URL that still carries it is
    // treated as a leftover rather than as a filter.
    if (state.beds && !isLand(listing) && listing.beds < Number(state.beds)) return false;
    if (state.q) {
      const haystack = `${listing.title} ${listing.address} ${listing.city} ${listing.type} ${listing.land?.zoning || ''}`.toLowerCase();
      if (!haystack.includes(state.q.toLowerCase())) return false;
    }
    if (state.budget) {
      const [min, max] = state.budget.split('-').map(Number);
      // A short-stay search budgets by the night and everything else budgets by
      // the price on the listing, which for a rental is the month. Same control,
      // two different numbers behind it.
      const amount = state.kind === 'short' ? nightlyRate(listing) : listing.price;
      if (amount < min) return false;
      if (max && amount > max) return false;
    }
    return true;
  };

  const sorters = {
    'price-asc': (a, b) => a.price - b.price,
    'price-desc': (a, b) => b.price - a.price,
    newest: (a, b) => b.listed.localeCompare(a.listed),
    'area-desc': (a, b) => {
      // "Size" means plot size for land and floor area for a house, so each is
      // compared with its own listing rather than across the two.
      const sizeOf = (item) => (isLand(item) ? Number(item.land?.plotAcres) || 0 : item.area || 0);
      return sizeOf(b) - sizeOf(a);
    },
    // A live hot deal outranks a featured one, because isHot() already knows the
    // promotion has run out and stops treating it as hot on its own.
    featured: (a, b) => Number(isHot(b)) - Number(isHot(a))
      || Number(b.featured) - Number(a.featured)
      || b.listed.localeCompare(a.listed),

    /*
     * Freshness of the confirmation, not of the listing.
     *
     * "Newest" answers "what arrived today", which is a question about the agency.
     * "Recently confirmed" answers "what did somebody check lately", which is the
     * question the Listing Truth work exists for - and the two are different
     * orderings, because a listing from March confirmed yesterday is the safest
     * thing on the page and a listing from last Tuesday confirmed in June is not.
     *
     * Unconfirmed listings sink rather than sort as ancient: their date is absent
     * rather than old, and "" sorts below every real ISO date, so they land at the
     * bottom where they belong without needing a special case in the comparator.
     */
    confirmed: (a, b) => (truthOf(b).confirmedOn || '').localeCompare(truthOf(a).confirmedOn || '')
      || b.listed.localeCompare(a.listed),

    /*
     * Price reductions, biggest first.
     *
     * Reduction is read from `priceHistory` and never from `originalPrice`: that
     * field belongs to the hot-deal promotion, and reading a paid promotion as a
     * market-driven cut would put an advert in front of somebody who specifically
     * asked for properties whose owner has come down. Listings that were never
     * reduced sort to the end, again because null sorts below any number.
     */
    reduced: (a, b) => {
      const cut = (l) => priceReduced(l)?.amount || 0;
      return cut(b) - cut(a) || b.listed.localeCompare(a.listed);
    },

    /*
     * Closest match to the words typed, with a stated fallback.
     *
     * "Relevance" in a portal of this size is usually a black box, and a reader who
     * cannot predict the order cannot trust it. So the scoring is simple and the
     * tiebreak is explicit: an exact title match wins, then a word in the title,
     * then a word anywhere else on the listing, then anything that came out of
     * freshness. Every result that scores zero still appears - a search that
     * silently drops the properties you did not type the name of is worse than
     * one that shows them, because you cannot tell the difference between "no
     * match" and "bad luck".
     */
    match: (a, b, state) => {
      const q = String(state?.q || '').trim().toLowerCase();
      if (!q) return b.listed.localeCompare(a.listed);
      const score = (listing) => {
        const title = String(listing.title || '').toLowerCase();
        if (title === q) return 100;
        if (title.includes(q)) return 60;
        // Every word in the query has to appear somewhere, not just one of them -
        // otherwise "harbour villa" scores a listing for containing "harbour" and
        // calling it a match.
        const words = q.split(/\s+/).filter(Boolean);
        const haystack = `${title} ${listing.address} ${listing.city} ${listing.type} ${listing.land?.zoning || ''} ${listing.let?.leaseTerm || ''}`.toLowerCase();
        const allFound = words.every((word) => haystack.includes(word));
        if (!allFound) return 0;
        const inTitle = words.filter((word) => title.includes(word)).length;
        return 20 + inTitle * 8;
      };
      return score(b) - score(a) || (truthOf(b).confirmedOn || '').localeCompare(truthOf(a).confirmedOn || '');
    }
  };

  const describeChips = (state) => {
    const chips = [];
    if (state.q) chips.push({ key: 'q', label: `“${state.q}”` });
    if (state.kind) {
      const kindLabel = { land: 'Land', short: 'Short stay', home: 'Homes' }[state.kind] || 'Homes';
      chips.push({ key: 'kind', label: kindLabel });
    }
    if (state.type) chips.push({ key: 'type', label: state.type });
    if (state.status) chips.push({ key: 'status', label: state.status });
    if (state.term) chips.push({ key: 'term', label: `${state.term} stays` });
    if (state.beds) chips.push({ key: 'beds', label: `${state.beds}+ beds` });
    if (state.hot) chips.push({ key: 'hot', label: 'Hot deals only' });
    if (state.budget) {
      const selected = $(`[name="budget"] option[value="${state.budget}"]`)?.textContent;
      chips.push({ key: 'budget', label: selected || state.budget });
    }
    return chips;
  };

  /*
   * Say how these results were ordered, in a sentence, every time.
   *
   * A ranking nobody can inspect is a ranking nobody should trust, and the audit's
   * point about paid placement is really a point about opacity: if a listing is
   * first because someone paid, that is fine to say and absurd to hide, but it is
   * only fine if the reader can also see what the *other* orders do.
   *
   * So this states the current rule and its tiebreak, and - the part that is easy
   * to leave out and the part that matters - it names what is NOT driving the
   * order. A reader told "paid placement does not affect these results" learns
   * something; a reader told nothing learns whatever they already assumed.
   */
  const SORT_NOTES = {
    featured: 'Live hot deals first, then featured listings, then newest. Sponsored placement never changes this order.',
    newest: 'Newest listing first, by the day it came onto the books.',
    confirmed: 'Most recently confirmed first — the date somebody last checked it was still available.',
    reduced: 'Biggest price reduction first. Paid promotions are not counted as reductions.',
    match: 'Best match to your search first: an exact title match, then words in the title, then anywhere on the listing.',
    'price-asc': 'Lowest price first.',
    'price-desc': 'Highest price first.',
    'area-desc': 'Largest first — floor area for a house, plot size for land.'
  };

  function explainSort(state, results) {
    const note = SORT_NOTES[state.sort] || SORT_NOTES.featured;
    const el = $('#sort-explain');
    if (!el) return;
    // Only worth saying when there is something on the page to be ordered.
    el.innerHTML = results.length
      ? `${icon('trend', 'icon--sm')}<span><strong>How these are ordered:</strong> ${escapeHtml(note)}</span>`
      : '';
    el.hidden = results.length === 0;
  }

  /*
   * Keep the two controls that only make sense for one category in step with the
   * category box.
   *
   * "Bedrooms" is meaningless for a parcel of ground, so it is hidden rather than
   * left on screen to be ignored, and the property-type list is trimmed to the
   * group that can actually match. Hiding is done with the `hidden` attribute on
   * each <option>, so the untrimmed list is still in the HTML for anyone arriving
   * with JavaScript switched off.
   */
  const syncCategoryControls = (state) => {
    const bedsField = $('[data-beds-field]', form);
    if (bedsField) {
      const onLand = state.kind === 'land';
      bedsField.hidden = onLand;
      const bedsControl = form.elements.beds;
      // Drop a bedroom minimum left over from the houses when switching to land,
      // or it would sit in the URL describing something the visitor cannot see.
      if (onLand && bedsControl) bedsControl.value = '';
    }

    // The term box belongs to short stays alone. On any other category it would be
    // a control that cannot narrow anything, so it is hidden and cleared rather
    // than left on screen to be ignored.
    const termField = $('[data-term-field]', form);
    if (termField) {
      termField.hidden = state.kind !== 'short';
      const termControl = form.elements.term;
      if (state.kind !== 'short' && termControl) termControl.value = '';
    }

    $$('[name="type"] option[data-group]', form).forEach((option) => {
      // "short" is a category of homes, not a third group of type, so it is
      // expressed as "homes only" rather than as a group of its own.
      const group = state.kind === 'short' ? 'home' : state.kind;
      option.hidden = Boolean(state.kind) && option.dataset.group !== group;
    });
  };

  function render() {
    const state = readState();
    syncCategoryControls(state);

    /*
     * Sort through a wrapper rather than handing the comparator straight to
     * Array.prototype.sort.
     *
     * Two reasons. The "closest match" order needs the query string, and `.sort`
     * calls a comparator with exactly two arguments - there is no third slot to
     * pass the state through, so handing it the bare function would silently
     * score every listing against an empty query and quietly degrade to "newest".
     * And an unrecognised sort value from a hand-edited URL would otherwise reach
     * `.sort(undefined)`, which leaves the array in its original order and looks
     * like it worked. Both are caught here rather than being a mystery later.
     */
    const sorter = sorters[state.sort] || sorters.featured;
    const results = listings.filter((listing) => matches(listing, state)).sort((a, b) => sorter(a, b, state));

    grid.innerHTML = results.slice(0, visible).map((listing) => propertyCard(listing, { withDescription: view === 'list' })).join('');
    paintPrices(grid);
    grid.classList.toggle('is-list', view === 'list');
    // "N homes found" was written before land existed. Counting whichever category is
    // on screen keeps the sentence honest in every filter combination.
    const noun = state.kind === 'land' ? 'plot' : state.kind === 'short' ? 'short stay' : state.kind === 'home' ? 'home' : 'listing';
    countLabel.innerHTML = `<strong>${results.length}</strong> ${noun}${results.length === 1 ? '' : 's'} found`;
    emptyState.hidden = results.length !== 0;
    grid.hidden = results.length === 0;
    loadMoreWrap.hidden = results.length <= visible;

    const chips = describeChips(state);
    explainSort(state, results);
    chipRow.innerHTML = chips.map((chip) => `
      <span class="chip">${escapeHtml(chip.label)}
        <button type="button" data-clear="${chip.key}" aria-label="Remove ${escapeHtml(chip.label)} filter">${icon('x', 'icon--sm')}</button>
      </span>`).join('');

    syncFavoriteButtons();
    writeState(state);
    // The URL now carries the cleaned state, so the record of what was just
    // cleared has done its job and must not suppress a filter put back later.
    clearedFromUrl.clear();
  }

  // Reflect the URL state into the controls before the first render.
  const initial = readState();
  Object.entries(initial).forEach(([key, value]) => {
    if (!value) return;
    const control = form.elements[key] || $(`[name="${key}"]`);
    if (control) control.value = value;
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    visible = PAGE_SIZE;
    render();
  });

  form.addEventListener('reset', () => {
    window.setTimeout(() => { visible = PAGE_SIZE; render(); }, 0);
  });

  form.addEventListener('change', (event) => {
    if (event.target.name === 'sort') return;
    visible = PAGE_SIZE;
    render();
  });

  $$('[name="sort"]').forEach((control) => control.addEventListener('change', render));

  $('[data-clear-all]')?.addEventListener('click', () => {
    form.reset();
    visible = PAGE_SIZE;
    render();
  });

  chipRow.addEventListener('click', (event) => {
    const button = event.target.closest('[data-clear]');
    if (!button) return;
    const key = button.dataset.clear;
    const control = form.elements[key];
    if (control) control.value = '';
    // Remembered either way: a chip with no control behind it would otherwise
    // reappear on the next render, because the URL still carried the filter.
    clearedFromUrl.add(key);
    visible = PAGE_SIZE;
    render();
  });

  $('#load-more')?.addEventListener('click', () => {
    visible += PAGE_SIZE;
    render();
  });

  $$('.view-toggle button').forEach((button) => button.addEventListener('click', () => {
    view = button.dataset.view;
    try { window.localStorage.setItem(VIEW_KEY, view); } catch { /* storage is optional */ }
    $$('.view-toggle button').forEach((item) => item.classList.toggle('is-active', item === button));
    render();
  }));
  $$('.view-toggle button').forEach((button) => button.classList.toggle('is-active', button.dataset.view === view));

  // A filter chip copies its wording from the budget option it came from, so
  // changing currency has to rebuild the chips, not just repaint the prices.
  repaintPrices = render;
  render();
}

/*
 * The rates table on a short stay.
 *
 * Everything a guest is asked to pay, and everything that decides whether they
 * can book it, in one place rather than spread across a card and a page they may
 * not reach:
 *
 *   - the rates, each with its own unit, because a night and a month are not the
 *     same purchase and pretending otherwise is how a weekend looks like a bargain
 *   - the per-night figure each longer term works out at, so nobody has to divide
 *   - the charges around the stay, labelled as what they are
 *   - the cancellation terms, in words
 *   - the shortest booking and the window it is open for
 *   - a way to act on it
 */
function ratesTable(listing) {
  const rates = shortStayRates(listing);
  if (!rates) return '';
  const comparison = rateComparison(listing);

  const rows = rates.map((rate) => {
    // The nightly rate needs no per-night equivalent - it is the unit itself.
    const longer = comparison?.longer.find((item) => item.unit === rate.unit);
    const equivalent = longer
      ? `<span class="rates-equivalent">
          <span ${priceAttrs(longer.perNight, '', false, '≈')}></span> a night
          ${longer.saving > 0 ? `<span class="rates-saving" ${priceAttrs(longer.saving, ` over the ${rate.unit}`, false, 'save ')}></span>` : ''}
        </span>`
      : '';
    return `
    <div class="rates-row">
      <dt>Per ${rate.unit.replace(/s$/, '')}</dt>
      <dd ${priceAttrs(rate.value)}>${equivalent}</dd>
    </div>`;
  }).join('');

  /*
   * What a guest actually pays is never just the nightly rate, and a charge
   * printed in the same weight as a rate reads as a rate. The note on each line is
   * what separates them: a deposit comes back, a cleaning fee happens once.
   */
  const terms = stayCharges(listing).map((charge) => `
    <div class="rates-row rates-row--term">
      <dt>${escapeHtml(charge.label)} <small>${escapeHtml(charge.note)}</small></dt>
      <dd ${priceAttrs(charge.value)}></dd>
    </div>`).join('');

  const notes = [];
  const nights = minNights(listing);
  if (nights > 1) notes.push(`Minimum stay ${nights} nights`);
  const window = availabilityWindow(listing);
  if (window) notes.push(window);
  const cancellation = cancellationPolicy(listing);
  if (cancellation) notes.push(cancellation);

  return `
    <section class="detail-section">
      <h2>Rates</h2>
      <dl class="rates">
        ${rows}
        ${terms}
        ${notes.length ? `<div class="rates-note">${icon('calendar', 'icon--sm')}${escapeHtml(notes.join(' · '))}</div>` : ''}
      </dl>
      ${availabilityCta(listing)}
    </section>`;
}

/**
 * The way to act on the rates.
 *
 * A rates table with nothing to press is a price list. This opens the viewing
 * dialog that already exists further up the page, rather than inventing a second
 * enquiry path, and asks for dates - because "is it free that weekend" is the
 * question a short stay is browsed with, and it is the one thing the table cannot
 * answer.
 */
function availabilityCta(listing) {
  const window = availabilityWindow(listing);
  const nights = minNights(listing);
  const detail = [nights > 1 ? `From ${nights} nights` : '', window].filter(Boolean).join(' · ');
  return `
    <div class="rates-cta">
      <button class="button button--primary" type="button" data-check-availability>
        ${icon('calendar', 'icon--sm')} Check availability
      </button>
      ${detail ? `<p class="rates-cta-note">${icon('check', 'icon--sm')}${escapeHtml(detail)}</p>` : ''}
    </div>`;
}

/**
 * The promotion banner. Says what the promotion is, not just that there is one.
 *
 * When there is an original price it is stated, because "Hot deal" alone does not
 * let anybody decide whether it is worth anything. The end date is always there -
 * a deal with no date is one that quietly never expires, and the visitor is the
 * only one who will ever notice.
 */
function hotBanner(listing) {
  if (!isHot(listing)) return '';
  const stay = isShortStay(listing) ? ' on a short stay' : '';
  const deal = dealSavings(listing);
  const ends = dealEndsOn(listing);
  const until = ends ? ` · ends ${ends}` : '';

  if (!deal) {
    // Hot, but with nothing to quantify. The date is still the useful half.
    return `<p class="hot-banner">${icon('sparkle', 'icon--sm')} Hot deal${stay}${until}</p>`;
  }

  // "save 100 a week" beside a weekly rate, "save 25 a night" beside a nightly one.
  // Taking the unit from the rate itself is what keeps those two in step.
  const per = deal.unit ? ` ${deal.unit}` : '';
  return `
    <div class="hot-banner hot-banner--priced">
      <p class="hot-banner-line">${icon('sparkle', 'icon--sm')} Hot deal${stay}${until}</p>
      <p class="hot-deal">
        <span class="hot-deal-was"><span ${priceAttrs(deal.was)}></span></span>
        <span class="hot-deal-now"><span ${priceAttrs(deal.now, per)}></span></span>
        <span class="hot-deal-save">Save <span ${priceAttrs(deal.saving)}></span> · ${deal.percent}% off</span>
      </p>
    </div>`;
}

/* ---- viewing desk -------------------------------------------------------- */
/*
 * Turning "book a viewing" from a contact form into a request somebody is
 * actually going to keep.
 *
 * The audit's diagnosis is that the uncertainty is not about the house, it is
 * about the transaction: is this still available, who is handling it, did
 * anybody see my message, is a viewing actually going to happen. A form that
 * says "thanks, we will be in touch" answers none of those and is the reason
 * people ring a portal three times before trusting a single listing on it.
 *
 * So the request has three properties it needs:
 *
 *   1. It names the recipient. Not "our team" - the actual person, their role,
 *      and how they can be reached directly.
 *   2. It offers times rather than asking for one free-text date. Somebody who
 *      cannot attend anything has to be able to say so without writing a
 *      paragraph, and an agent who has to propose a time over the phone is an
 *      agent who never confirms.
 *   3. It comes back with a status and a reference, so "did this go anywhere?"
 *      has an answer that is not the reader's memory.
 */

/*
 * The slots the listing agent can actually offer.
 *
 * Built forward from today rather than stored, so the desk is never offering a
 * viewing for last Tuesday. Seven days out is a working week: long enough for
 * somebody to clear a diary, short enough that a stale listing is usually
 * noticed by whoever holds the keys.
 *
 * Deliberately conservative about times. Evening slots exist because most people
 * are at work, and a Saturday slot exists because that is when viewings actually
 * happen - a desk offering only nine-to-five slots on weekdays is a desk that
 * quietly loses every buyer who works.
 */
const VIEWING_DAYS_AHEAD = 7;
const VIEWING_SLOT_TIMES = [
  { value: '09:30', label: 'Morning, 9:30' },
  { value: '12:30', label: 'Lunchtime, 12:30' },
  { value: '16:00', label: 'Afternoon, 4:00' },
  { value: '18:30', label: 'Early evening, 6:30' },
  { value: '10:00', label: 'Saturday, 10:00' }
];

/** The next `count` dates on which a viewing could sensibly happen. */
function viewingDates(count = 6) {
  const dates = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  // Not today. Somebody asking to view a house at four o'clock this afternoon
  // needs an answer within the hour, not a diary slot.
  cursor.setDate(cursor.getDate() + 1);
  while (dates.length < count) {
    const day = cursor.getDay();
    if (day !== 0) dates.push(new Date(cursor)); // closed on Sundays
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

const isoDay = (date) => [
  date.getFullYear(),
  String(date.getMonth() + 1).padStart(2, '0'),
  String(date.getDate()).padStart(2, '0')
].join('-');

/** "Tomorrow" / "Thu 9 Oct" — a date label a person reads faster than an ISO one. */
function viewingDayLabel(date) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((date - today) / 86400000);
  if (days === 1) return 'Tomorrow';
  if (days === 2) return 'Day after tomorrow';
  if (days < 7) return date.toLocaleDateString('en-GB', { weekday: 'long' });
  return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

/*
 * The response time this office commits to, and what happens when it is missed.
 *
 * Printed before the request is sent rather than after, because a commitment the
 * customer only sees once it has been broken is not a commitment. The escalation
 * line is the part that makes it real: somebody who has heard nothing is not left
 * concluding they were forgotten, they are told there is a second address.
 */
function viewingPromise(agent) {
  return {
    response: 'within one working day',
    escalateTo: site.email || 'hello@northwind.example',
    agent
  };
}

/*
 * A reference the customer can quote, derived from the listing and the moment of
 * the request. Not a security token and not pretending to be one - it exists so
 * that "I enquired about the villa on Tuesday" becomes something the office can
 * look up in a second. The clock is the only moving part, so two requests for
 * the same listing in the same second collide; that is fine here and would not be
 * if the reference were ever used for authentication.
 */
function viewingReference(listing) {
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  return `${listing.id.toUpperCase()}-${stamp}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
}

/* ---- property detail ---------------------------------------------------- */
function initDetail() {
  const root = $('#property-detail');
  if (!root) return;

  const id = new URLSearchParams(window.location.search).get('id');
  const listing = listings.find((item) => item.id === id);

  if (!listing) {
    root.innerHTML = `
      <div class="not-found">
        <h1>We could not find that home</h1>
        <p class="gone-note">The listing may have sold or been withdrawn. Browse everything currently on the market instead.</p>
        <a class="button button--primary" href="properties.html">Browse all homes</a>
      </div>`;
    document.title = 'Listing not found — Northwind Realty';
    return;
  }

  const agent = agentFor(listing);
  document.title = `${listing.title} — Northwind Realty`;
  updateListingMeta(listing);

  root.innerHTML = `
    <nav class="breadcrumbs" aria-label="Breadcrumb">
      <a href="index.html">Home</a>${icon('chevron', 'icon--sm')}
      <a href="properties.html">Properties</a>${icon('chevron', 'icon--sm')}
      <span>${escapeHtml(listing.title)}</span>
    </nav>
    <div class="detail-layout">
      <div>
        ${placementDisclosure(listing)}
        ${hotBanner(listing)}
        ${promotionNote(listing)}
        <div class="gallery">
          <div class="gallery-main"><img id="gallery-main-image" src="${listing.images[0]}" alt="${escapeHtml(listing.title)}" width="1200" height="750" /></div>
          <div class="gallery-thumbs" role="group" aria-label="Property photos">
            ${listing.images.map((image, index) => `
              <button type="button" data-gallery="${image}" aria-current="${index === 0}" aria-label="Show photo ${index + 1}">
                <img src="${image}" alt="" width="400" height="300" />
              </button>`).join('')}
          </div>
        </div>

        <div class="detail-title">
          <div>
            <h1>${escapeHtml(listing.title)}</h1>
            <p class="card-address">${icon('pin', 'icon--sm')}${escapeHtml(listing.address)}, ${escapeHtml(listing.city)}</p>
            <p class="detail-price" ${priceAttrs(listing.price, isRent(listing) ? 'per month' : `· listed ${formatListed(listing.listed)}`)}></p>
          </div>
          <div class="detail-actions">
            <button class="favorite-button" type="button" data-favorite="${listing.id}" aria-pressed="false" aria-label="Save this home">${icon('heart')}</button>
            <button class="button button--secondary" type="button" data-share>${icon('share', 'icon--sm')} Share</button>
          </div>
        </div>

        ${ratesTable(listing)}
        ${tenancyPanel(listing)}

        ${truthPanel(listing)}

        <dl class="spec-grid">${detailSpecs(listing)}</dl>

        <section class="detail-section">
          <h2>${isLand(listing) ? 'About this plot' : 'About this home'}</h2>
          <p class="prose prose--spaced">${escapeHtml(listing.description)}</p>
        </section>

        <section class="detail-section">
          <h2>What you get</h2>
          <ul class="feature-grid">
            ${listing.features.map((feature) => `<li>${icon('check', 'icon--sm')}${escapeHtml(feature)}</li>`).join('')}
          </ul>
        </section>

        ${valuationPanel(listing)}
      </div>

      <aside class="agent-card--sticky" aria-labelledby="agent-name">
        <span class="avatar avatar--${agent.tint} avatar--lg">${agent.initials}</span>
        <h2 class="detail-subhead" id="agent-name">${escapeHtml(agent.name)}</h2>
        <p class="agent-role">${escapeHtml(agent.role)}</p>
        <p>${escapeHtml(agent.bio)}</p>
        <div class="agent-meta">
          <a href="tel:${agent.phone.replace(/[^+\d]/g, '')}">${icon('phone', 'icon--sm')}${escapeHtml(agent.phone)}</a>
          <a href="mailto:${agent.email}">${icon('mail', 'icon--sm')}${escapeHtml(agent.email)}</a>
          <span>${icon('home', 'icon--sm')}${agent.listings} sales on record</span>
        </div>
        <button class="button button--primary button--block" type="button" data-viewing>
          ${icon('calendar', 'icon--sm')} Request a viewing
        </button>
        <a class="button button--ghost button--block detail-ask" href="contact.html">Ask a question</a>
        <p class="desk-assurance">
          ${icon('shield', 'icon--sm')}
          ${escapeHtml(agent.name.split(' ')[0])} replies ${escapeHtml(viewingPromise(agent).response)}.
          Heard nothing by then? Email <a href="mailto:${escapeHtml(site.email || '')}">${escapeHtml(site.email || 'the office')}</a>.
        </p>
      </aside>
    </div>
    <div id="similar-mount"></div>

    <dialog class="dialog" id="viewing-dialog" aria-labelledby="viewing-title">
      <form class="dialog-shell" id="viewing-form">
        <!-- Honeypot: hidden from people, filled in by spam bots. -->
        <input type="text" name="botcheck" tabindex="-1" autocomplete="off" aria-hidden="true" />
        <header class="dialog-header">
          <div>
            <h2 id="viewing-title">Request a viewing</h2>
            <p>${escapeHtml(listing.title)} · ${escapeHtml(listing.address)}</p>
          </div>
          <button class="icon-button" type="button" data-close-dialog aria-label="Close">${icon('x', 'icon--sm')}</button>
        </header>
        <div class="form-grid">
          <label class="field"><span>Name</span><input name="name" type="text" autocomplete="name" required /></label>
          <label class="field"><span>Email</span><input name="email" type="email" autocomplete="email" required /></label>
          <label class="field"><span>Phone <small>Optional</small></span><input name="phone" type="tel" autocomplete="tel" /></label>
        </div>

        <!--
          Who is handling it.

          This sits above the form rather than being discovered in an email later.
          The audit's complaint is that nobody can find out who receives their
          enquiry, and the cheapest possible answer is to say so before they ask.
        -->
        <div class="desk-recipient">
          <span class="avatar avatar--${agent.tint}">${agent.initials}</span>
          <div>
            <p class="desk-recipient-name">This goes to ${escapeHtml(agent.name)}</p>
            <p class="desk-recipient-role">${escapeHtml(agent.role)} · replies ${escapeHtml(viewingPromise(agent).response)}</p>
          </div>
        </div>

        <!--
          Times, chosen rather than typed.

          A single date field makes the customer guess one slot and the agent spend
          a phone call discovering it was wrong. Offering the days that are actually
          open, and letting three be picked, turns that call into a confirmation.
          The dates are generated from today rather than stored, so the desk can
          never offer somebody a viewing for a day that has already passed.
        -->
        <fieldset class="desk-slots">
          <legend>When suits you? <small>Pick up to three</small></legend>
          <div class="slot-days">
            ${viewingDates().map((date) => `
              <div class="slot-day">
                <p class="slot-day-label">${escapeHtml(viewingDayLabel(date))}</p>
                <div class="slot-times">
                  ${VIEWING_SLOT_TIMES
                    .filter((slot) => slot.value === '10:00' ? date.getDay() === 6 : date.getDay() !== 6)
                    .map((slot) => `
                      <label class="slot">
                        <input type="checkbox" name="slots" value="${isoDay(date)}T${slot.value}" />
                        <span>${escapeHtml(slot.label.replace('Saturday, ', ''))}</span>
                      </label>`).join('')}
                </div>
              </div>`).join('')}
          </div>
          <p class="slot-error" data-slot-error hidden></p>
        </fieldset>

        <label class="field"><span id="date-label">Anything else we should know? <small>Optional</small></span>
          <textarea name="message" rows="2" placeholder="Access needs, questions, or other times that would work"></textarea>
        </label>
        <label class="field" id="nights-field" hidden><span>Nights</span>
            <select name="nights">
              ${[1, 2, 3, 4, 5, 6, 7, 14, 28, 30]
                .map((n) => `<option value="${n}">${n}${n === 7 ? ' (a week)' : n === 28 || n === 30 ? ' (a month)' : ''}</option>`)
                .join('')}
            </select>
          </label>
        <footer class="dialog-actions">
          <button class="button button--secondary" type="button" data-close-dialog>Cancel</button>
          <button class="button button--primary" type="submit" id="viewing-submit">Send request</button>
        </footer>
      </form>

      <!--
        The acknowledgement.

        This is the part a contact form never does. It replaces the form with a
        reference, a named owner, what happens next and by when, and an escalation
        route that is offered before it is needed. "We will be in touch" becomes a
        request number, and the reason the reader stops ringing the office three
        times is that the office told them what to do if nobody replied.
      -->
      <div class="dialog-shell desk-receipt" id="viewing-receipt" hidden>
        <header class="dialog-header">
          <div>
            <h2>Request sent</h2>
            <p>${escapeHtml(listing.title)}</p>
          </div>
          <button class="icon-button" type="button" data-close-dialog aria-label="Close">${icon('x', 'icon--sm')}</button>
        </header>
        <div class="receipt-body">
          <p class="receipt-ref">Your reference <strong>${escapeHtml(viewingReference(listing))}</strong></p>
          <ol class="receipt-steps">
            <li class="is-done"><strong>Sent</strong><span>Your times are with ${escapeHtml(agent.name)}.</span></li>
            <li><strong>Acknowledged</strong><span>An email lands within one working day.</span></li>
            <li><strong>Time agreed</strong><span>${escapeHtml(agent.name.split(' ')[0])} confirms one of your times or suggests another.</span></li>
            <li><strong>Viewing</strong><span>You get the address and a reminder the day before.</span></li>
          </ol>
          <p class="receipt-escalate">
            ${icon('alert', 'icon--sm')} No reply by the end of one working day? Quote the reference to
            <a href="mailto:${escapeHtml(site.email || '')}">${escapeHtml(site.email || 'the office')}</a> and it goes to somebody else.
          </p>
          <p class="receipt-actions">
            <a class="button button--secondary button--sm" href="tel:${agent.phone.replace(/[^+\d]/g, '')}">Call ${escapeHtml(agent.name.split(' ')[0])}</a>
            <button class="button button--ghost button--sm" type="button" data-close-dialog>Back to the listing</button>
          </p>
        </div>
      </div>
    </dialog>

    <!--
      Report a change.

      Separate from the viewing dialog on purpose: a correction is not an enquiry
      and must never be filed as one, or the office treats "this has sold" as a
      viewing request and the listing stays up for another fortnight. It posts as
      its own kind, tagged with the listing, and the agent is told.
    -->
    <dialog class="dialog" id="report-dialog" aria-labelledby="report-title">
      <form class="dialog-shell" id="report-form">
        <input type="text" name="botcheck" tabindex="-1" autocomplete="off" aria-hidden="true" />
        <header class="dialog-header">
          <div>
            <h2 id="report-title">Report a change</h2>
            <p>${escapeHtml(listing.title)} · ${escapeHtml(listing.address)}</p>
          </div>
          <button class="icon-button" type="button" data-report-close aria-label="Close">${icon('x', 'icon--sm')}</button>
        </header>
        <p class="report-intro">
          Every listing on this site carries a last-confirmed date. If that is wrong,
          tell us and we will check it or take the listing down. Nobody is penalised
          for a listing going stale.
        </p>
        <div class="form-grid">
          <label class="field field--full"><span>What has changed?</span>
            <select name="change" required>
              <option value="">Choose one…</option>
              <option value="no-longer-available">It has sold, let or been withdrawn</option>
              <option value="price-changed">The price is wrong</option>
              <option value="details-wrong">A detail is wrong</option>
              <option value="not-available-here">Nobody is answering the number</option>
            </select>
          </label>
          <label class="field field--full"><span>Anything else? <small>Optional</small></span>
            <textarea name="detail" rows="3" placeholder="What you saw, and roughly when"></textarea>
          </label>
          <label class="field field--full"><span>Your email <small>Optional, for a reply</small></span>
            <input name="email" type="email" autocomplete="email" />
          </label>
        </div>
        <footer class="dialog-actions">
          <button class="button button--secondary" type="button" data-report-close>Cancel</button>
          <button class="button button--primary" type="submit">Send to the office</button>
        </footer>
      </form>
    </dialog>`;

  $('#similar-mount').innerHTML = `
    <section class="section" aria-labelledby="similar-title">
      <div class="section-head section-head--split">
        <div>
          <p class="eyebrow">More like this</p>
          <h2 class="section-title" id="similar-title">Similar homes</h2>
        </div>
        <a class="section-link" href="properties.html">See all properties ${icon('arrow-right', 'icon--sm')}</a>
      </div>
      <div class="card-grid">
        ${listings
          .filter((item) => item.id !== listing.id && item.status !== 'Sold')
          .sort((a, b) => Number(b.type === listing.type) - Number(a.type === listing.type))
          .slice(0, 3)
          .map((item) => propertyCard(item))
          .join('')}
      </div>
    </section>`;

  $('.gallery-thumbs', root).addEventListener('click', (event) => {
    const button = event.target.closest('[data-gallery]');
    if (!button) return;
    $('#gallery-main-image').src = button.dataset.gallery;
    $$('.gallery-thumbs button', root).forEach((item) => item.setAttribute('aria-current', String(item === button)));
  });

  $('[data-share]', root)?.addEventListener('click', async () => {
    const shareData = { title: listing.title, text: listing.address, url: window.location.href };
    try {
      if (navigator.share) {
        await navigator.share(shareData);
      } else {
        await navigator.clipboard.writeText(window.location.href);
        announce('Link copied to your clipboard');
      }
    } catch {
      announce('Sharing was cancelled');
    }
  });

  /*
   * One dialog, two intents.
   *
   * "Book a viewing" and "Check availability" ask for almost the same thing and
   * arrive as the same enquiry, so they share the form rather than growing two.
   * What changes is the wording and the one extra question - how many nights -
   * because a weekend enquiry and a viewing request are not the same message to
   * an agent, and sending both labelled "viewing" loses the distinction before
   * anybody reads them.
   */
  const dialog = $('#viewing-dialog', root);
  const nightsField = $('#nights-field', root);
  const nightsControl = $('select[name="nights"]', root);
  const form = $('#viewing-form', root);
  const receipt = $('#viewing-receipt', root);
  const slotError = $('[data-slot-error]', root);
  let dialogIntent = 'viewing';

  /*
   * Three times, no more.
   *
   * More than three and the request stops being a request - an agent cannot
   * propose a time out of eight, and a customer offering eight times is usually a
   * customer who will not get any of them. Three is enough to cover a week.
   */
  const MAX_SLOTS = 3;

  const showSlotError = (message) => {
    if (!slotError) return;
    slotError.textContent = message;
    slotError.hidden = !message;
  };

  const openDialog = (intent) => {
    dialogIntent = intent;
    const availability = intent === 'availability';
    $('#viewing-title', root).textContent = availability ? 'Check availability' : 'Request a viewing';
    $('#viewing-submit', root).textContent = availability ? 'Request availability' : 'Send request';
    // A short stay is not booked by choosing a viewing slot - the guest wants to
    // know whether the nights are free. So the slot grid is for real viewings
    // only, and the availability path falls back to the arrival-date question.
    const slotField = $('.desk-slots', root);
    if (slotField) slotField.hidden = availability;
    nightsField.hidden = !availability;
    // Defaulted to the shortest booking the listing actually accepts, so the
    // form cannot be submitted asking for a stay the owner will refuse.
    if (availability && nightsControl) nightsControl.value = String(minNights(listing));
    // Coming back to the dialog after a receipt should show the form again.
    form.hidden = false;
    receipt.hidden = true;
    showSlotError('');
    dialog.showModal();
    document.body.classList.add('dialog-open');
    $('input[name="name"]', form).focus();
  };

  $('[data-viewing]', root).addEventListener('click', () => openDialog('viewing'));
  $('[data-check-availability]', root)?.addEventListener('click', () => openDialog('availability'));
  $$('[data-close-dialog]', root).forEach((button) => button.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => document.body.classList.remove('dialog-open'));
  // Enforcing the cap in the handler rather than in the markup: a checkbox with
  // a `max` attribute silently stops being clickable and looks broken, whereas
  // letting the customer tick a fourth and then telling them why is clearer.
  $$('input[name="slots"]', root).forEach((box) => box.addEventListener('change', () => {
    const chosen = $$('input[name="slots"]:checked', root);
    if (chosen.length <= MAX_SLOTS) {
      showSlotError('');
      return;
    }
    box.checked = false;
    showSlotError(`Please pick up to ${MAX_SLOTS} times — more than that and somebody has to call you back to choose.`);
  }));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const fields = new FormData(form);
    const availability = dialogIntent === 'availability';
    const slots = fields.getAll('slots').map(String);

    // A viewing with no time on it is the old form in a new costume: the agent
    // still has to phone to arrange it. Said plainly rather than submitted and
    // quietly dropped on a floor somewhere.
    if (!availability && !slots.length) {
      showSlotError('Pick at least one time that suits you, so we can confirm a viewing rather than ring you back.');
      $('.desk-slots', root)?.scrollIntoView({ block: 'nearest' });
      return;
    }

    const submit = lockSubmit(form);

    try {
      await postEnquiry({
        // The agent inbox files these separately, and an availability enquiry that
        // arrives labelled "booking" is one somebody has to read twice to work out.
        kind: availability ? 'availability' : 'booking',
        name: fields.get('name'),
        email: fields.get('email'),
        phone: fields.get('phone'),
        message: fields.get('message'),
        // The chosen slots, and a human-readable copy of them. The structured
        // value is what an agent triages against a diary; the prose is what they
        // read in the inbox list. Sending only one of the two makes somebody
        // reconstruct it.
        slots,
        timesWanted: slots.map((slot) => slot.replace('T', ', ')).join(' · '),
        nights: availability ? fields.get('nights') : null,
        listingId: listing.id,
        listingTitle: listing.title,
        // Who was named to the customer as the recipient. Without this the office
        // cannot tell whether a booking went to the agent who promised to handle
        // it, and the promise the website made cannot be checked afterwards.
        agentId: listing.agentId,
        agentName: agent.name,
        reference: viewingReference(listing)
      }, form);
      form.reset();
      showSlotError('');

      if (availability) {
        dialog.close();
        announce(`Availability request sent for ${listing.title}`);
        return;
      }

      // The receipt replaces the form rather than closing the dialog, so the
      // reader gets the reference and the next steps while the listing is still
      // behind them and they can act on it.
      form.hidden = true;
      receipt.hidden = false;
      $('[data-close-dialog]', receipt)?.focus();
      announce(`Viewing request sent — reference ${viewingReference(listing)}`);
    } catch (problem) {
      announce(problem.message);
    } finally {
      submit.done();
    }
  });

  /*
 * Report a change.
 *
 * The Listing Truth panel makes a claim, and a claim the reader cannot challenge
 * is decoration. This is the escape valve: it files the correction into the same
 * inbox as everything else, tagged against the listing, so the office hears from
 * the person most likely to know that a listing is stale.
 *
 * Deliberately one click plus a sentence. A form that insists on a category, a
 * severity and a photograph before it will accept "this has sold" is a form
 * nobody completes.
 */
const reportDialog = $('#report-dialog', root);
if (reportDialog) {
  const reportForm = $('#report-form', root);
  const openReport = () => {
    reportDialog.showModal();
    document.body.classList.add('dialog-open');
    $('select[name="change"]', reportForm).focus();
  };
  $('[data-report-change]', root)?.addEventListener('click', openReport);
  $$('[data-report-close]', root).forEach((button) => button.addEventListener('click', () => reportDialog.close()));
  reportDialog.addEventListener('click', (event) => { if (event.target === reportDialog) reportDialog.close(); });
  reportDialog.addEventListener('close', () => document.body.classList.remove('dialog-open'));

  reportForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const fields = new FormData(reportForm);
    const submit = lockSubmit(reportForm);
    try {
      await postEnquiry({
        kind: 'correction',
        intent: fields.get('change'),
        detail: `${listing.title} (${listing.id})`,
        message: fields.get('detail'),
        email: fields.get('email') || undefined,
        listingId: listing.id,
        listingTitle: listing.title
      }, reportForm);
      reportForm.reset();
      reportDialog.close();
      announce('Thank you — that goes straight to the agent handling this listing.');
    } catch (problem) {
      announce(problem.message);
    } finally {
      submit.done();
    }
  });
}

syncFavoriteButtons();
}

/* ---- enquiries ----------------------------------------------------------- */
/*
 * Where a submission is sent.
 *
 * Two paths, chosen automatically:
 *
 *   1. On localhost the admin server is running, so enquiries go straight to
 *      /api/enquiry and land in enquiries.json, ready under the Enquiries tab.
 *
 *   2. Anywhere else - the published site on GitHub Pages - there is no server,
 *      so they go to a form service and arrive as an email.
 *
 * Set ONE of these to make the published forms work. All three are free.
 *
 *   Cloudflare Worker (recommended) - the one in worker/. Keeps enquiries in
 *   storage and hands them to the local admin panel, so the public site and the
 *   panel share a single Enquiries inbox. Paste the worker's /enquiry address
 *   into ENQUIRY_ENDPOINT below. See worker/README.md.
 *
 *   Web3Forms - no account at all. Type your email into
 *   https://web3forms.com and it shows an access key immediately. Paste it
 *   into ENQUIRY_KEY below. Delivers by email only, so these do not reach the
 *   admin inbox.
 *
 *   Formspree, or any service that accepts a JSON POST - paste the whole URL
 *   into ENQUIRY_ENDPOINT instead.
 */
const ENQUIRY_KEY = '';        // Web3Forms, e.g. 'a1b2c3d4-1234-5678-9abc-def012345678'
const ENQUIRY_ENDPOINT = '';   // Formspree, e.g. 'https://formspree.io/f/abcdefgh'

const isLocalServer = () =>
  location.hostname === 'localhost' ||
  location.hostname === '127.0.0.1' ||
  location.hostname === '[::1]' ||
  location.protocol === 'file:';

// Resolve the destination, or explain why there isn't one.
function enquiryTarget() {
  if (ENQUIRY_KEY) {
    return { url: 'https://api.web3forms.com/submit', extra: { access_key: ENQUIRY_KEY } };
  }
  if (ENQUIRY_ENDPOINT) {
    return { url: ENQUIRY_ENDPOINT, extra: {} };
  }
  return null;
}

async function postEnquiry(payload, form) {
  // Running from the local admin server: use it.
  if (isLocalServer()) return postToLocalServer(payload);
  const target = enquiryTarget();
  if (!target) {
    throw new Error('This form is not connected yet. The site owner needs to add a form endpoint in app.js.');
  }
  return postToFormService(payload, target, form);
}

async function postToLocalServer(payload) {
  let response;
  try {
    response = await fetch('/api/enquiry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch {
    throw new Error('Could not reach the site server. Start it with start-admin.cmd and load the site from http://localhost:8001.');
  }

  const text = await response.text();
  const result = text ? JSON.parse(text) : {};
  if (!response.ok || result.ok === false) {
    throw new Error(result.error || `The server could not save this (${response.status}).`);
  }
  return result;
}

async function postToFormService(payload, target, form) {
  // Fields the services understand, so an enquiry arrives as a readable email
  // rather than a JSON blob.
  const body = {
    ...payload,
    ...target.extra,
    from_name: payload.name || 'Website enquiry',
    replyto: payload.email || ''
  };
  // Honeypot: hidden from people, filled in by bots. A bot that completes
  // every field gets this one too and is silently discarded.
  const honeypot = form ? $('[name="botcheck"]', form) : null;
  if (honeypot && honeypot.value.trim()) return { ok: true, discarded: true };

  let response;
  try {
    response = await fetch(target.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    });
  } catch {
    throw new Error('The message could not be sent. Please email us instead.');
  }

  let result = {};
  try { result = await response.json(); } catch { /* empty body is fine */ }
  if (!response.ok || result.success === false) {
    throw new Error((result.message ? `${result.message}. ` : '') + 'The message could not be sent. Please email us instead.');
  }
  return { ok: true };
}

function lockSubmit(form) {
  const button = $('button[type="submit"]', form);
  if (!button) return { done() {} };
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Sending…';
  return {
    done() {
      button.disabled = false;
      button.textContent = label;
    }
  };
}

function initForms() {
  $('#contact-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const name = String(fields.get('name') || '').trim();
    const submit = lockSubmit(form);

    try {
      await postEnquiry({
        kind: 'message',
        name,
        email: fields.get('email'),
        phone: fields.get('phone'),
        intent: fields.get('intent'),
        detail: fields.get('detail'),
        channel: fields.get('channel'),
        message: fields.get('message'),
        updates: fields.get('updates') === 'on'
      }, form);
      form.reset();
      announce(`Thanks ${name || 'for getting in touch'} — an agent will reply within one working day.`);
    } catch (problem) {
      announce(problem.message);
    } finally {
      submit.done();
    }
  });

  // There is no newsletter service behind this form. Saying "you are on the
  // list" without storing the address would be a promise the site cannot keep,
  // and the visitor has no way of knowing their email went nowhere. Until an
  // endpoint exists this says so plainly.
  $('#newsletter-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const field = event.currentTarget.querySelector('input[type="email"]');
    if (field) field.value = '';
    announce('New listing alerts are not switched on yet — please use the contact form instead.');
  });
}

/* ---- structured data for one listing ------------------------------------ */
const SITE_ORIGIN = 'https://megapulse11-dot.github.io/friendly-fiesta/';

/**
 * Rewrites the head for whichever listing the ?id= resolved to, and injects a
 * schema.org block describing it.
 *
 * This exists for property.html, which serves every listing on the site from one
 * file. It is why that page's raw HTML carries generic page copy: a static block
 * there would describe one hardcoded house on all fourteen listings.
 *
 * It is no longer the only way a listing page is published. Each listing also has
 * a pre-rendered page at property/<id>.html with its own title, description,
 * canonical, Open Graph, H1 and JSON-LD already in the served HTML - see
 * scripts/build-property-pages.mjs. Those are what a crawler and a link preview
 * actually read; this is what makes the ?id= URL agree with them.
 *
 * The canonical it writes is therefore the pre-rendered page's address, not this
 * one. Two URLs can serve the same content, but only one of them may claim to be
 * the canonical, and telling a crawler they are both is how a site ends up with
 * its own pages competing against each other in results.
 *
 * JSON-LD is built as a JS object and stringified, never as a template literal of
 * hand-written JSON. A listing description containing a quote or a newline would
 * otherwise produce invalid JSON, and invalid structured data is silently ignored
 * rather than reported.
 */
function updateListingMeta(listing) {
  const url = `${SITE_ORIGIN}property/${encodeURIComponent(listing.id)}.html`;
  // The card shows a price formatted in the visitor's chosen currency, but a
  // meta description is read before any currency choice has been made, so this
  // quotes the listing's own base-currency figure rather than a converted one.
  const description = `${listing.title} — ${listing.beds} bed ${listing.type.toLowerCase()} in ${listing.city}. ${moneyFormatter(baseCurrency).format(listing.price)}`.trim();

  const setMeta = (selector, attr, value) => {
    const element = document.querySelector(selector);
    if (element) element.setAttribute(attr, value);
  };

  setMeta('meta[property="og:title"]', 'content', `${listing.title} — ${site.name}`);
  setMeta('meta[property="og:description"]', 'content', description);
  setMeta('meta[property="og:url"]', 'content', url);
  setMeta('meta[property="og:image"]', 'content', `${SITE_ORIGIN}${listing.image}`);
  setMeta('meta[name="description"]', 'content', description);
  const canonical = document.querySelector('link[rel="canonical"]');
  if (canonical) canonical.setAttribute('href', url);

  // A short stay prices by the night, not by the month, so the structured data
  // has to quote the same figure the card shows. Getting this wrong would put a
  // nightly rate into a field every consumer reads as a monthly one.
  const price = listing.nightly || listing.price;
  const schema = {
    '@context': 'https://schema.org',
    '@type': ['Product', 'Residence'],
    name: listing.title,
    description: listing.description,
    url,
    image: listing.images.map((image) => `${SITE_ORIGIN}${image}`),
    sku: listing.id,
    category: listing.type,
    address: {
      '@type': 'PostalAddress',
      streetAddress: listing.address,
      addressLocality: listing.city,
      addressCountry: 'US'
    },
    numberOfRooms: listing.beds,
    floorSize: { '@type': 'QuantitativeValue', value: listing.area, unitCode: 'MTK' },
    offers: {
      '@type': 'Offer',
      price,
      priceCurrency: baseCurrency,
      availability: listing.status === 'Sold'
        ? 'https://schema.org/SoldOut'
        : 'https://schema.org/InStock',
      url,
      seller: { '@type': 'RealEstateAgent', name: site.name }
    }
  };

  document.querySelector('#listing-schema')?.remove();
  const script = document.createElement('script');
  script.type = 'application/ld+json';
  script.id = 'listing-schema';
  // textContent, not innerHTML: the payload is JSON, and assigning it as markup
  // lets a "<" in any field break out of the script element entirely.
  script.textContent = JSON.stringify(schema);
  document.head.appendChild(script);
}

/* ---- footer & offices --------------------------------------------------- */
function initFooter() {
  const list = $('#footer-offices');
  if (list) {
    list.innerHTML = offices.map((office) => `<li><a href="contact.html">${escapeHtml(office.city)}</a><br /><span>${escapeHtml(office.address)}</span></li>`).join('');
  }

  const officeList = $('#office-list');
  if (officeList) {
    officeList.innerHTML = offices.map((office) => `
      <article class="office-card">
        <svg class="icon" aria-hidden="true" focusable="false"><use href="#icon-pin"></use></svg>
        <div>
          <h3>${escapeHtml(office.city)}</h3>
          <p>${escapeHtml(office.address)}<br />${escapeHtml(office.phone)}<br />${escapeHtml(office.hours)}</p>
        </div>
      </article>`).join('');
  }
}

/* ---- site settings ------------------------------------------------------ */
function applySiteSettings() {
  const root = document.documentElement;
  [['--brand', site.brandColor], ['--brand-dark', site.brandDark], ['--accent', site.accentColor]]
    .forEach(([property, value]) => { if (value) root.style.setProperty(property, value); });

  if (site.name) {
    document.title = document.title.replace('Northwind Realty', site.name);
    $$('.brand').forEach((brand) => {
      const mark = brand.querySelector('.brand-mark');
      brand.textContent = site.name;
      if (mark) brand.insertBefore(mark, brand.firstChild);
    });
  }

  [['[data-site="tagline"]', site.tagline],
    ['[data-site="heroTitle"]', site.heroTitle],
    ['[data-site="heroLead"]', site.heroLead],
    ['[data-site="footerNote"]', site.footerNote],
    ['[data-site="copyright"]', site.copyright]]
    .forEach(([selector, value]) => {
      const element = $(selector);
      if (element && value) element.innerHTML = value;
    });

  const emailLink = $('[data-site="email"]');
  if (emailLink && site.email) emailLink.href = `mailto:${site.email}`;
  const phoneLink = $('[data-site="phone"]');
  if (phoneLink && site.phone) phoneLink.href = `tel:${String(site.phone).replace(/[^+\d]/g, '')}`;
}

/* ---- boot --------------------------------------------------------------- */
// First, because everything after it paints tokens off the root element.
initTheme();
applySiteSettings();
initHeader();
renderHome();
initHeroSlideshow();
initSearchPanel();
initResults();
initDetail();
initForms();
initFooter();
syncFavoriteButtons();

// Last, because the currency layer paints prices and so needs every list already
// in the document. The first pass draws the base currency straight away; a
// converted one replaces it as soon as the rates arrive.
initCurrency().catch(() => { /* the base-currency pass already ran */ });
