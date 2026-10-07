/**
 * Northwind Realty — content admin.
 *
 * Loads everything from /api/state, edits a working copy in memory, and writes the
 * whole document back with a single Save. The server stores data.json and
 * regenerates data.js, which is the file the public website loads.
 */
const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

const TOKEN_KEY = 'northwind:admin-token';

// Never let unavailable site storage abort this script. The public site already
// wraps its localStorage calls for exactly this reason; the panel has to as
// well, because a throw on the line below would kill admin.js outright, leaving
// the sign-in form to submit natively and reload the page in a loop. Losing the
// saved token only costs a sign-in after a reload.
const store = {
  get(key) { try { return window.localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { window.localStorage.setItem(key, value); } catch { /* session only */ } },
  remove(key) { try { window.localStorage.removeItem(key); } catch { /* nothing to clear */ } }
};

let token = store.get(TOKEN_KEY) || '';
let data = null;
let dirty = false;
let toastTimer;
let drawer = null;
let enquiries = [];

/* ---- currency ----------------------------------------------------------- */
/*
 * Prices live in the data as plain numbers in one base currency, and the panel
 * always shows and accepts that currency — an editor changing a price has to be
 * typing the number that will be saved, not a converted one. Choosing what the
 * base is happens here; converting it for the reader happens on the website.
 */
const BASE_CURRENCIES = {
  AUD: 'Australian Dollar', BRL: 'Brazilian Real', CAD: 'Canadian Dollar', CHF: 'Swiss Franc',
  CNY: 'Chinese Yuan', CZK: 'Czech Koruna', DKK: 'Danish Krone', EUR: 'Euro',
  GBP: 'British Pound', HKD: 'Hong Kong Dollar', HUF: 'Hungarian Forint', IDR: 'Indonesian Rupiah',
  ILS: 'Israeli New Shekel', INR: 'Indian Rupee', ISK: 'Icelandic Krona', JPY: 'Japanese Yen', KES: 'Kenyan Shilling',
  KRW: 'South Korean Won', MXN: 'Mexican Peso', MYR: 'Malaysian Ringgit', NOK: 'Norwegian Krone',
  NZD: 'New Zealand Dollar', PHP: 'Philippine Peso', PLN: 'Polish Zloty', SEK: 'Swedish Krona',
  SGD: 'Singapore Dollar', TRY: 'Turkish Lira', USD: 'US Dollar', ZAR: 'South African Rand'
};

const RATES_URL = 'https://api.frankfurter.app/latest';

const moneyFormatters = new Map();
function moneyFormatter(code) {
  if (!moneyFormatters.has(code)) {
    moneyFormatters.set(code, new Intl.NumberFormat('en', { style: 'currency', currency: code, maximumFractionDigits: 0 }));
  }
  return moneyFormatters.get(code);
}

/** The currency every stored price is in, falling back to USD if unset or invalid. */
const baseCurrency = () => {
  const code = String(data?.site?.currency || '').toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : 'USD';
};

const money = (amount) => moneyFormatter(baseCurrency()).format(Number(amount) || 0);

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character]));

function announce(message) {
  const toast = $('#toast');
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('is-visible');
  toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 3000);
}

async function api(path, options = {}) {
  // Remember which session this request was sent with. A request left over from
  // an earlier page load can come back 401 *after* the user has already signed in
  // again, and it must not be allowed to sign that new session out.
  const sentToken = token;

  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(sentToken ? { Authorization: `Bearer ${sentToken}` } : {}),
      ...(options.headers || {})
    }
  });

  if (response.status === 401) {
    if (sentToken === token) {
      token = '';
      store.remove(TOKEN_KEY);
      showLogin();
    }
    throw new Error('Session expired — sign in again.');
  }

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  return payload;
}

/* ---- auth --------------------------------------------------------------- */
function showLogin() {
  $('#login').hidden = false;
  $('#app').hidden = true;
  $('#password').focus();
}

async function startApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  const payload = await api('/api/state');
  data = payload.data;
  markDirty(false);
  renderAll();
  // The inbox is a convenience, not a prerequisite: if it fails to load the
  // content editor still works, so the error is left for the Refresh button.
  loadEnquiries();
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('#login-error');
  error.hidden = true;
  try {
    const payload = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ password: $('#password').value })
    });
    token = payload.token;
    store.set(TOKEN_KEY, token);
    $('#password').value = '';
    await startApp();
    announce('Signed in');
  } catch (problem) {
    error.textContent = problem.message;
    error.hidden = false;
  }
});

$('#logout').addEventListener('click', () => {
  if (dirty && !window.confirm('You have unsaved changes. Sign out anyway?')) return;
  token = '';
  store.remove(TOKEN_KEY);
  dirty = false;
  showLogin();
});

/* ---- save --------------------------------------------------------------- */
function markDirty(value = true) {
  dirty = value;
  const label = $('#save-state');
  label.textContent = value ? 'Unsaved changes' : 'All changes saved';
  label.classList.toggle('is-dirty', value);
  $('#save').disabled = !value;
}

$('#save').addEventListener('click', async () => {
  const button = $('#save');
  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    await api('/api/data', { method: 'PUT', body: JSON.stringify(data) });
    markDirty(false);
    announce('Saved — the website now shows your changes');
  } catch (problem) {
    announce(problem.message);
  } finally {
    button.textContent = 'Save changes';
    button.disabled = !dirty;
  }
});

window.addEventListener('beforeunload', (event) => {
  if (!dirty) return;
  event.preventDefault();
  event.returnValue = '';
});

/* ---- drawer ------------------------------------------------------------- */
function openDrawer({ title, html, onApply }) {
  drawer = { onApply };
  $('#drawer-title').textContent = title;
  $('#drawer-body').innerHTML = html;
  $('#drawer').hidden = false;
  requestAnimationFrame(() => {
    $('#drawer').classList.add('is-open');
    $('#scrim').classList.add('is-open');
  });
  const first = $('#drawer-body input, #drawer-body select, #drawer-body textarea');
  if (first) first.focus();
}

function closeDrawer() {
  drawer = null;
  $('#drawer').classList.remove('is-open');
  $('#scrim').classList.remove('is-open');
  window.setTimeout(() => { $('#drawer').hidden = true; }, 200);
}

$('#drawer-close').addEventListener('click', closeDrawer);
$('#drawer-cancel').addEventListener('click', closeDrawer);
$('#scrim').addEventListener('click', closeDrawer);
$('#drawer-apply').addEventListener('click', () => {
  if (!drawer) return;
  try {
    drawer.onApply();
    closeDrawer();
    markDirty();
    renderAll();
  } catch (problem) {
    announce(problem.message);
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && drawer) closeDrawer();
});

/* ---- rendering ---------------------------------------------------------- */
function renderAll() {
  renderListings();
  renderAgents();
  renderOffices();
  renderSettings();
}

const statusClass = (status) => (status === 'For rent' ? 'pill--rent' : status === 'Sold' ? 'pill--sold' : 'pill--sale');

function renderListings() {
  const query = $('#listing-search').value.trim().toLowerCase();
  const status = $('#listing-status').value;
  const rows = data.listings.filter((listing) => {
    if (status && listing.status !== status) return false;
    if (!query) return true;
    return `${listing.title} ${listing.address} ${listing.city} ${listing.type}`.toLowerCase().includes(query);
  });

  if (!rows.length) {
    $('#listings-body').innerHTML = '<div class="empty">No listings match. Try clearing the search, or add a new one.</div>';
    return;
  }

  $('#listings-body').innerHTML = `
    <div class="table-card">
      <div class="row row--head">
        <span>Photo</span><span>Listing</span><span>Status</span><span>Price</span><span></span>
      </div>
      ${rows.map((listing) => `
        <div class="row" data-id="${escapeHtml(listing.id)}">
          <div class="row__image"><img src="/${escapeHtml(listing.image)}" alt="" loading="lazy" /></div>
          <div>
            <div class="row__title">${escapeHtml(listing.title)}</div>
            <div class="row__meta">${escapeHtml(listing.address)}, ${escapeHtml(listing.city)} · ${listing.beds} bed · ${escapeHtml(listing.type)}</div>
          </div>
          <div><span class="pill ${statusClass(listing.status)}">${escapeHtml(listing.status)}</span>${listing.featured ? '<span class="pill pill--featured">Featured</span>' : ''}</div>
          <div class="row__price">${listing.status === 'For rent' ? `${money(listing.price)}<span class="row__meta"> /mo</span>` : money(listing.price)}</div>
          <div class="row__actions">
            <button class="btn btn--secondary btn--sm" data-edit="${escapeHtml(listing.id)}" type="button">Edit</button>
            <button class="btn btn--danger btn--sm" data-delete="${escapeHtml(listing.id)}" type="button">Delete</button>
          </div>
        </div>`).join('')}
    </div>`;
}

function renderAgents() {
  $('#agents-body').innerHTML = data.agents.map((agent) => `
    <article class="entity" data-id="${escapeHtml(agent.id)}">
      <div class="entity__head">
        <span class="avatar avatar--${escapeHtml(agent.tint)}">${escapeHtml(agent.initials)}</span>
        <div>
          <div class="entity__name">${escapeHtml(agent.name)}</div>
          <div class="entity__meta">${escapeHtml(agent.role)}</div>
        </div>
      </div>
      <div class="entity__text">${escapeHtml(agent.email)}<br />${escapeHtml(agent.phone)}</div>
      <div class="entity__actions">
        <button class="btn btn--secondary btn--sm" data-edit-agent="${escapeHtml(agent.id)}" type="button">Edit</button>
        <button class="btn btn--danger btn--sm" data-delete-agent="${escapeHtml(agent.id)}" type="button">Delete</button>
      </div>
    </article>`).join('') || '<div class="empty">No agents yet.</div>';
}

function renderOffices() {
  $('#offices-body').innerHTML = data.offices.map((office, index) => `
    <article class="entity" data-index="${index}">
      <div class="entity__head">
        <div>
          <div class="entity__name">${escapeHtml(office.city)}</div>
          <div class="entity__meta">${escapeHtml(office.hours)}</div>
        </div>
      </div>
      <div class="entity__text">${escapeHtml(office.address)}<br />${escapeHtml(office.phone)}</div>
      <div class="entity__actions">
        <button class="btn btn--secondary btn--sm" data-edit-office="${index}" type="button">Edit</button>
        <button class="btn btn--danger btn--sm" data-delete-office="${index}" type="button">Delete</button>
      </div>
    </article>`).join('') || '<div class="empty">No offices yet.</div>';
}

const settingFields = [
  { key: 'name', label: 'Company name', hint: 'Used in the logo, page titles and the footer.' },
  {
    key: 'currency',
    label: 'Base currency',
    type: 'select',
    options: BASE_CURRENCIES,
    hint: 'Every price on this site is stored in this currency, and this is what the editing panel shows you. Visitors can read the website in any other currency — it is converted for them with live reference rates, and the rate used is printed under the picker.'
  },
  { key: 'tagline', label: 'Home page eyebrow', hint: 'The small line above the headline.' },
  { key: 'heroTitle', label: 'Home page headline', hint: 'HTML is allowed, e.g. Find the home that <em>actually</em> fits.' },
  { key: 'heroLead', label: 'Home page intro', hint: 'One or two sentences under the headline.' },
  { key: 'brandColor', label: 'Brand colour', type: 'color' },
  { key: 'brandDark', label: 'Brand colour (dark)', type: 'color' },
  { key: 'accentColor', label: 'Accent colour', type: 'color' },
  { key: 'email', label: 'Contact email', type: 'email' },
  { key: 'phone', label: 'Contact phone', type: 'tel' },
  { key: 'footerNote', label: 'Footer description' },
  { key: 'copyright', label: 'Footer copyright' }
];

function renderSettings() {
  $('#settings-form').innerHTML = settingFields.map((field) => {
    const stored = data.site[field.key] ?? '';
    const value = escapeHtml(stored);
    if (field.type === 'select') {
      // Compare against the raw stored value, not the escaped one, so a code
      // that is not in the list keeps the field honest instead of silently
      // snapping to whatever happens to be first.
      const options = Object.entries(field.options)
        .map(([code, name]) => `<option value="${code}"${code === stored ? ' selected' : ''}>${code} — ${escapeHtml(name)}</option>`)
        .join('');
      return `<div class="field field--full">
        <span>${field.label}</span>
        <select name="${field.key}">${options}</select>
        ${field.hint ? `<small class="hint">${field.hint}</small>` : ''}
      </div>`;
    }
    if (field.type === 'color') {
      return `<div class="field field--full">
        <span>${field.label}</span>
        <div class="color-field">
          <input type="color" name="${field.key}" value="${value}" />
          <input type="text" name="${field.key}-text" value="${value}" />
        </div>
      </div>`;
    }
    const wide = ['heroTitle', 'heroLead', 'footerNote', 'copyright', 'tagline'].includes(field.key);
    return `<div class="field${wide ? ' field--full' : ''}">
      <span>${field.label}</span>
      <input type="${field.type || 'text'}" name="${field.key}" value="${value}" />
      ${field.hint ? `<small class="hint">${field.hint}</small>` : ''}
    </div>`;
  }).join('');

  refreshCurrencyStatus();
}

$('#settings-form').addEventListener('input', (event) => {
  const field = event.target;
  const key = field.name.replace('-text', '');
  if (field.type === 'color') {
    const twin = $(`[name="${field.name}-text"]`);
    if (twin) twin.value = field.value;
  } else if (field.name.endsWith('-text')) {
    const twin = $(`[name="${key}"]`);
    if (twin && /^#[0-9a-f]{6}$/i.test(field.value)) twin.value = field.value;
  }
  data.site[key] = field.value;
  // The listings table prints every price in the base currency, so changing the
  // base has to redraw them — and the status line below it quotes that currency.
  if (key === 'currency') {
    renderListings();
    refreshCurrencyStatus();
  }
  markDirty();
});

/**
 * Say out loud what the website is converting with.
 *
 * The base currency on its own does not tell an editor whether a visitor in
 * Tokyo is seeing today's rate or a month-old one, so this asks the same service
 * the website asks and reports the date it got back. If the service is
 * unreachable that is worth knowing too, because the site falls back to showing
 * the base currency rather than guessing.
 */
async function refreshCurrencyStatus() {
  const status = $('#currency-status');
  if (!status) return;
  const base = baseCurrency();
  status.textContent = 'Checking live rates…';
  try {
    const response = await fetch(`${RATES_URL}?base=${encodeURIComponent(base)}`, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(String(response.status));
    const payload = await response.json();
    status.textContent = `Prices are stored in ${base}. Visitors who pick another currency are converted with European Central Bank reference rates published ${payload.date || 'recently'}, fetched by the website itself — there is nothing to configure here. Currencies the ECB does not publish, such as the Kenyan shilling, are converted with a second key-less service instead.`;
  } catch {
    status.textContent = `Could not reach frankfurter.app just now, so the rate date is unconfirmed. Prices are stored in ${base}, and the website shows them in ${base} until the service answers.`;
  }
}

$$('.tabs button').forEach((tab) => tab.addEventListener('click', () => {
  $$('.tabs button').forEach((item) => item.setAttribute('aria-selected', String(item === tab)));
  $$('.panel').forEach((panel) => { panel.hidden = panel.id !== `panel-${tab.dataset.tab}`; });
  // Pick up anything submitted from the website while the panel was closed.
  if (tab.dataset.tab === 'enquiries') loadEnquiries();
  // Submissions live on the worker rather than in a local file, so this tab is
  // read from it on every visit instead of being rendered from `data`.
  if (tab.dataset.tab === 'submissions') loadSubmissions();
}));

$('#listing-search').addEventListener('input', renderListings);
$('#listing-status').addEventListener('change', renderListings);

/* ---- submissions from agents ----------------------------------------------- */

/*
 * Homes and land uploaded by agents, held on the worker until they are approved.
 *
 * Unlike everything else in this panel these are not in `data` - they are read
 * through the server from the worker each time the tab is opened. Approval is the
 * moment a listing enters data.json and the site becomes static again.
 */
const SUBMISSION_STATE = {
  pending: 'Waiting for you',
  approved: 'Live',
  rejected: 'Not approved'
};

async function loadSubmissions() {
  const body = $('#submissions-body');
  const hint = $('#submissions-hint');

  try {
    const payload = await api('/api/submissions');
    renderSubmissions(payload.submissions || [], payload);
  } catch (problem) {
    hint.textContent = `Could not load submissions: ${problem.message}`;
    hint.hidden = false;
    body.innerHTML = '';
  }
}

function renderSubmissions(items, payload) {
  const body = $('#submissions-body');
  const hint = $('#submissions-hint');
  const badge = $('#submission-badge');

  if (payload && payload.configured === false) {
    hint.textContent =
      'Set NW_WORKER_URL and NW_WORKER_TOKEN before starting the panel to review agent submissions.';
    hint.hidden = false;
  } else {
    hint.hidden = true;
  }

  const pending = items.filter((item) => item.state === 'pending').length;
  if (pending > 0) {
    badge.textContent = String(pending);
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }

  if (!items.length) {
    body.innerHTML = '<p class="hint">Nothing from agents yet.</p>';
    return;
  }

  body.innerHTML = items
    .map((item) => {
      const listing = item.listing || {};
      const agent = item.agent || {};
      const decidable = item.state === 'pending';

      const figures = [];
      if (listing.price) figures.push(money(listing.price));
      if (listing.beds) figures.push(`${listing.beds} bed`);
      if (listing.lot) figures.push(listing.lot);
      if (listing.area) figures.push(`${listing.area} m²`);

      const photos = Array.isArray(item.photos) ? item.photos.length : 0;
      const note = item.note ? `<p class="hint">Note: ${escapeHtml(item.note)}</p>` : '';

      const actions = decidable
        ? `<button class="btn btn--primary" data-approve="${escapeHtml(item.id)}">Approve and publish</button>
           <button class="btn btn--secondary" data-reject="${escapeHtml(item.id)}">Reject</button>`
        : `<span class="hint">${escapeHtml(SUBMISSION_STATE[item.state] || item.state)}</span>`;

      return `<article class="row submission" data-state="${escapeHtml(item.state)}">
        <div>
          <p class="row__title">${escapeHtml(listing.title || '(no title)')}</p>
          <p class="row__meta">
            ${escapeHtml(listing.type || '')}
            ${listing.city ? ' · ' + escapeHtml(listing.city) : ''}
            · ${escapeHtml(listing.status || '')}
          </p>
          <p class="row__price">${escapeHtml(figures.join(' · '))}</p>
          <p class="row__meta">From ${escapeHtml(agent.name || 'Unknown agent')} · ${escapeHtml(agent.email || '')}</p>
          <p class="row__meta">${photos} photo${photos === 1 ? '' : 's'} · sent ${escapeHtml((item.createdAt || '').slice(0, 10))}</p>
          ${note}
        </div>
        <div class="row__actions">${actions}</div>
      </article>`;
    })
    .join('');
}

async function decideSubmission(id, verdict, note) {
  try {
    await api(`/api/submissions/${id}/${verdict}`, {
      method: 'POST',
      body: JSON.stringify({ note: note || '' })
    });
    // Approving rewrites data.json behind the panel's back, so the content it is
    // holding is stale and has to be read again - otherwise the new listing would
    // not appear under Listings until a reload.
    if (verdict === 'approve') {
      const fresh = await api('/api/state');
      data = fresh.data;
      markDirty(false);
      renderAll();
      announce('Approved. The listing is on the website.');
    } else {
      announce('Rejected, and the agent can read your note.');
    }
    await loadSubmissions();
  } catch (problem) {
    announce(problem.message);
  }
}

$('#submissions-body').addEventListener('click', (event) => {
  const target = event.target;

  const approveId = target.dataset && target.dataset.approve;
  if (approveId) {
    decideSubmission(approveId, 'approve', '');
    return;
  }

  const rejectId = target.dataset && target.dataset.reject;
  if (rejectId) {
    const note = window.prompt('Why is this being rejected? The agent will see this.') ?? '';
    if (note.trim() === '') return;
    decideSubmission(rejectId, 'reject', note.trim());
  }
});

$('#submissions-refresh').addEventListener('click', () => loadSubmissions());

/* ---- enquiries ----------------------------------------------------------- */
const formatWhen = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || '');
  return date.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const telHref = (phone) => `tel:${String(phone).replace(/[^0-9+]/g, '')}`;

function updateEnquiryBadge() {
  const badge = $('#enquiry-badge');
  const count = enquiries.filter((item) => !item.read && !item.archived).length;
  badge.textContent = String(count);
  badge.hidden = count === 0;
}

async function loadEnquiries() {
  try {
    const payload = await api('/api/enquiries');
    enquiries = payload.data.enquiries || [];
    updateEnquiryBadge();
    renderEnquiries();
    renderDeskMetrics();
  } catch (problem) {
    announce(problem.message);
  }
}

/*
 * Did the office actually work the viewing desk?
 *
 * The site promises a named agent, a reference and an escalation route, and a
 * promise nobody measures is a promise nobody keeps. These are the numbers behind
 * the audit's "Confirmed Viewing Desk": how quickly a request is opened, how many
 * were never opened at all, how many carry the times needed to confirm one without
 * a phone call, and how many people reported a listing as wrong.
 *
 * Everything here is derived from the enquiries file rather than counted by hand,
 * so it cannot drift from the inbox. Two rules keep it honest:
 *
 *   1. Nothing is printed as a rate until there is enough data for a rate to
 *      mean anything. One request opened in four hours is not "a 4 hour response
 *      time"; it is one request, and it is labelled with the count it came from.
 *
 *   2. A request that has not been opened yet is counted as unanswered rather than
 *      quietly dropped. Excluding the slow ones from the average is how a desk
 *      reports a 20-minute response time while somebody waits three days.
 */
function renderDeskMetrics() {
  const host = $('#desk-metrics');
  if (!host) return;

  const viewings = enquiries.filter((item) => item.kind === 'booking' || item.kind === 'availability');
  if (!viewings.length) {
    host.hidden = true;
    const table = $('#desk-metrics-table');
    if (table) table.hidden = true;
    return;
  }
  host.hidden = false;

  const now = Date.now();
  // How long each request sat before somebody opened it. A request still unread is
  // not given an infinite time here - it is counted separately as unanswered,
  // which is the number that actually needs watching.
  const responded = viewings
    .filter((item) => item.readAt && !Number.isNaN(Date.parse(item.readAt)))
    .map((item) => ({ item, hours: (Date.parse(item.readAt) - Date.parse(item.createdAt)) / 3600000 }))
    .filter((row) => row.hours >= 0)
    .sort((a, b) => a.hours - b.hours);

  const median = responded.length ? responded[Math.floor((responded.length - 1) / 2)] : null;
  const slowest = responded.length ? responded[responded.length - 1] : null;

  // Unanswered means never opened, and old enough that opening it now would
  // already be late. A request from ten minutes ago is not a failure.
  const GRACE_HOURS = 24;
  const unanswered = viewings.filter((item) => !item.readAt && (now - Date.parse(item.createdAt)) > GRACE_HOURS * 3600000);
  const stillOpen = viewings.filter((item) => !item.read && !item.archived);
  // A viewing request that arrived without a time is one the agent has to phone
  // back to arrange - the exact thing the desk exists to avoid.
  const noTimes = viewings.filter((item) => !(Array.isArray(item.slots) ? item.slots : []).length);
  const corrections = enquiries.filter((item) => item.kind === 'correction');

  const hours = (value) => {
    if (value === null) return '—';
    if (value < 1) return `${Math.max(1, Math.round(value * 60))} min`;
    if (value < 48) return `${Math.round(value)} h`;
    return `${Math.round(value / 24)} days`;
  };

  const cards = [
    {
      label: 'Median first response',
      value: hours(median ? median.hours : null),
      note: median
        ? `Across ${responded.length} of ${viewings.length} opened`
        : 'Nothing opened yet'
    },
    {
      label: 'Slowest opened',
      value: hours(slowest ? slowest.hours : null),
      note: slowest ? 'Longest a request waited to be opened' : 'No response recorded'
    },
    {
      label: 'No response',
      value: String(unanswered.length),
      note: unanswered.length ? `Unopened for over ${GRACE_HOURS} h` : 'Every request opened in time',
      tone: unanswered.length ? 'bad' : 'good'
    },
    {
      label: 'Awaiting a reply',
      value: String(stillOpen.length),
      note: stillOpen.length ? 'Open in the inbox now' : 'Inbox is clear'
    },
    {
      label: 'Came with times',
      value: `${Math.round(((viewings.length - noTimes.length) / viewings.length) * 100)}%`,
      note: noTimes.length ? `${noTimes.length} need a phone call to arrange` : 'All confirmable from the request',
      tone: noTimes.length ? 'warn' : 'good'
    },
    {
      label: 'Reported as wrong',
      value: String(corrections.length),
      note: corrections.length ? 'Listing corrections sent in' : 'Nobody has reported a listing'
    }
  ];

  /*
   * Written into the cards grid rather than the panel itself: the panel also
   * holds the per-agent table, and replacing the panel's innerHTML would delete
   * the very element the next few lines are about to fill.
   */
  $('#desk-metrics-cards').innerHTML = cards.map((card) => `
    <div class="metric${card.tone ? ` metric--${card.tone}` : ''}">
      <p class="metric__label">${escapeHtml(card.label)}</p>
      <p class="metric__value">${escapeHtml(card.value)}</p>
      <p class="metric__note">${escapeHtml(card.note)}</p>
    </div>`).join('');

  /*
   * Named per agent, because "the office" is not a thing anybody can improve.
   * The promise is made in the agent's name on the listing, so the number belongs
   * to them. Unattributed requests are grouped rather than dropped - a client that
   * predates the `agentName` field must still appear in the total.
   */
  const byAgent = new Map();
  for (const item of viewings) {
    const who = item.agentName || 'Unattributed';
    const row = byAgent.get(who) || { total: 0, opened: 0, hours: [] };
    row.total += 1;
    if (item.readAt && !Number.isNaN(Date.parse(item.readAt))) {
      const took = (Date.parse(item.readAt) - Date.parse(item.createdAt)) / 3600000;
      if (took >= 0) { row.opened += 1; row.hours.push(took); }
    }
    byAgent.set(who, row);
  }

  const table = $('#desk-metrics-table');
  if (table) {
    table.hidden = false;
    $('tbody', table).innerHTML = [...byAgent.entries()]
      .map(([who, row]) => {
        const sorted = [...row.hours].sort((a, b) => a - b);
        const mid = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
        return `<tr>
          <td>${escapeHtml(who)}</td>
          <td>${row.total}</td>
          <td>${row.opened}</td>
          <td>${escapeHtml(hours(mid))}</td>
        </tr>`;
      })
      .join('') || '<tr><td colspan="4">No viewing requests yet.</td></tr>';
  }
}

function renderEnquiries() {
  const query = $('#enquiry-search').value.trim().toLowerCase();
  const kind = $('#enquiry-kind').value;
  const state = $('#enquiry-state').value;

  const rows = enquiries.filter((item) => {
    if (kind && item.kind !== kind) return false;
    if (state === 'archived') { if (!item.archived) return false; }
    else if (state === 'unread') { if (item.read || item.archived) return false; }
    else if (item.archived) return false;
    if (!query) return true;
    const haystack = `${item.name} ${item.email} ${item.phone} ${item.intent} ${item.detail} ${item.message} ${item.listingTitle}`;
    return haystack.toLowerCase().includes(query);
  });

  if (!rows.length) {
    const noun = state === 'archived' ? 'Nothing archived yet.' : 'No enquiries yet.';
    $('#enquiries-body').innerHTML = `<div class="empty">${noun} Messages sent from the contact page and viewing requests from a property page arrive here.</div>`;
    return;
  }

  $('#enquiries-body').innerHTML = rows.map((item) => {
    // Three kinds, not two. A correction from the Listing Truth panel ("this has
    // sold") is a listing-maintenance signal and must not be filed under viewings,
    // or the office works the booking queue and the stale listing stays up.
    const isBooking = item.kind === 'booking';
    const isAvailability = item.kind === 'availability';
    const isCorrection = item.kind === 'correction';
    const heading = (isBooking || isAvailability)
      ? `Viewing — ${item.listingTitle || 'a property'}`
      : (item.intent || 'Enquiry');

    // The chosen times, printed first and in full. An agent triaging this inbox
    // against a diary needs the slots before they read anything else the customer
    // wrote, and the free-text note is the thing most likely to be skimmed.
    const slots = Array.isArray(item.slots) ? item.slots : [];
    const times = slots.length
      ? `<p class="enquiry__slots"><strong>Wants:</strong> ${escapeHtml(item.timesWanted || slots.map((s) => String(s).replace('T', ', ')).join(' · '))}</p>`
      : '';

    const notes = [item.message, (isBooking || isAvailability) ? '' : item.detail].filter(Boolean);
    const contact = [
      item.email ? `<a href="mailto:${escapeHtml(item.email)}">${escapeHtml(item.email)}</a>` : '<span class="entity__meta">no email</span>',
      item.phone ? `<a href="${escapeHtml(telHref(item.phone))}">${escapeHtml(item.phone)}</a>` : '',
      item.reference ? `<strong>ref ${escapeHtml(item.reference)}</strong>` : '',
      isBooking && item.date ? `wants ${escapeHtml(item.date)}` : '',
      !isBooking && !isAvailability && item.channel ? `prefers ${escapeHtml(item.channel)}` : '',
      !isBooking && !isAvailability && item.updates ? 'wants new listings' : ''
    ].filter(Boolean).join(' &middot; ');

    // Who the customer was told would handle it. The site names an agent before
    // the enquiry is sent, so the office needs to be able to check afterwards that
    // it actually reached them rather than the general inbox.
    const routed = item.agentName ? `<p class="enquiry__routed">Promised to <strong>${escapeHtml(item.agentName)}</strong></p>` : '';

    const pill = isCorrection
      ? '<span class="pill pill--danger">Correction</span>'
      : isAvailability
        ? '<span class="pill pill--accent">Availability</span>'
        : isBooking
          ? '<span class="pill pill--rent">Viewing</span>'
          : '<span class="pill pill--sale">Message</span>';

    return `
      <article class="enquiry${item.read ? '' : ' is-unread'}${isCorrection ? ' is-correction' : ''}" data-id="${escapeHtml(item.id)}">
        <header class="enquiry__head">
          <div>
            <div class="enquiry__who">${escapeHtml(item.name)}${item.read ? '' : '<span class="enquiry__dot" aria-label="Unread"></span>'}</div>
            <div class="enquiry__meta">${escapeHtml(heading)} · ${escapeHtml(formatWhen(item.createdAt))}</div>
          </div>
          ${pill}
        </header>
        <div class="enquiry__contact">${contact}</div>
        ${routed}
        ${times}
        ${notes.length ? `<div class="enquiry__body">${notes.map((note) => `<p>${escapeHtml(note)}</p>`).join('')}</div>` : ''}
        <footer class="enquiry__actions">
          <button class="btn btn--secondary btn--sm" data-enquiry-read="${escapeHtml(item.id)}" type="button">${item.read ? 'Mark unread' : 'Mark read'}</button>
          <button class="btn btn--secondary btn--sm" data-enquiry-archive="${escapeHtml(item.id)}" type="button">${item.archived ? 'Unarchive' : 'Archive'}</button>
          <span class="grow"></span>
          <button class="btn btn--danger btn--sm" data-enquiry-delete="${escapeHtml(item.id)}" type="button">Delete</button>
        </footer>
      </article>`;
  }).join('');
}

async function patchEnquiry(id, changes) {
  try {
    await api('/api/enquiry', { method: 'PATCH', body: JSON.stringify({ id, ...changes }) });
    await loadEnquiries();
  } catch (problem) {
    announce(problem.message);
  }
}

async function deleteEnquiry(id) {
  const item = enquiries.find((entry) => entry.id === id);
  if (!item) return;
  if (!window.confirm(`Delete the enquiry from ${item.name}? This cannot be undone.`)) return;
  try {
    await api('/api/enquiry', { method: 'DELETE', body: JSON.stringify({ id }) });
    announce('Enquiry deleted');
    await loadEnquiries();
  } catch (problem) {
    announce(problem.message);
  }
}

$('#enquiry-search').addEventListener('input', renderEnquiries);
$('#enquiry-kind').addEventListener('change', renderEnquiries);
$('#enquiry-state').addEventListener('change', renderEnquiries);
$('#enquiries-refresh').addEventListener('click', loadEnquiries);
$('#enquiries-archive-read').addEventListener('click', async () => {
  const targets = enquiries.filter((item) => item.read && !item.archived);
  if (!targets.length) {
    announce('Nothing to archive - there are no read enquiries');
    return;
  }
  for (const item of targets) {
    try {
      await api('/api/enquiry', { method: 'PATCH', body: JSON.stringify({ id: item.id, archived: true }) });
    } catch (problem) {
      announce(problem.message);
      return;
    }
  }
  announce(`Archived ${targets.length} read ${targets.length === 1 ? 'enquiry' : 'enquiries'}`);
  await loadEnquiries();
});

document.addEventListener('click', (event) => {
  const readButton = event.target.closest('[data-enquiry-read]');
  if (readButton) {
    const item = enquiries.find((entry) => entry.id === readButton.dataset.enquiryRead);
    if (item) patchEnquiry(item.id, { read: !item.read });
    return;
  }
  const archiveButton = event.target.closest('[data-enquiry-archive]');
  if (archiveButton) {
    const item = enquiries.find((entry) => entry.id === archiveButton.dataset.enquiryArchive);
    if (item) patchEnquiry(item.id, { archived: !item.archived });
    return;
  }
  const removeButton = event.target.closest('[data-enquiry-delete]');
  if (removeButton) deleteEnquiry(removeButton.dataset.enquiryDelete);
});

/* ---- photos ------------------------------------------------------------- */
async function uploadPhoto(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
  const payload = await api('/api/photo', { method: 'POST', body: JSON.stringify({ name: file.name, dataUrl }) });
  return payload.path;
}

// Removing a photo from a listing only removes the reference. The file itself
// is deleted once, after the edit is applied, and only if no other listing
// points at it - the same image is often shared, and deleting it on the first
// removal left every other listing showing a broken picture.
async function removeUnreferencedPhotos(paths) {
  for (const path of paths) {
    if (!path || !path.startsWith('assets/homes/')) continue;
    const stillUsed = data.listings.some((listing) =>
      listing.image === path || (listing.images || []).includes(path));
    if (stillUsed) continue;
    try {
      await api('/api/photo', { method: 'DELETE', body: JSON.stringify({ path }) });
    } catch (problem) {
      announce(problem.message);
    }
  }
}



/* ---- editors ------------------------------------------------------------ */
const newId = (prefix) => `${prefix}${Date.now().toString(36)}`;

/*
 * The two categories the panel edits, mirroring HOME_TYPES / LAND_TYPES in the
 * website's `app.js`. They are kept here rather than fetched because the panel
 * has to render a type picker the instant it opens, and the site is served
 * without JavaScript on the public side.
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
const ZONINGS = ['Residential', 'Commercial', 'Industrial', 'Agricultural', 'Mixed use', 'Recreational'];
const TITLE_DEEDS = ['Freehold', 'Leasehold', 'Consent', 'Searching title'];
const PLOT_UNITS = ['acres', 'hectares', 'sq m'];

/* The lengths of stay a rental can offer, in the order the website shows them.
   The worker keeps its own copy of this list and drops anything it does not
   recognise, so the two agreeing is what stops the panel offering a term the
   site would then quietly ignore. */
const STAY_TERMS = ['Nightly', 'Weekly', 'Monthly'];

/*
 * The picture a listing shows before it has any of its own.
 *
 * This used to be an SVG placeholder the website shipped. It stopped shipping
 * when the photography arrived, which left this pointing at nothing: approve a
 * listing with no photographs and its card got a broken image. The fallback is
 * now a photograph that is actually in assets/homes/, and if that ever goes
 * missing the site cannot publish anyway.
 */
const FALLBACK_IMAGE = 'assets/homes/property_04_harbour_villa_twilight.jpg';

const isLandType = (type) => LAND_TYPES.includes(type);

/**
 * Short stays only make sense on a rental, so the panel follows the status - the
 * same rule the agent form uses. `hot` stays visible for everything: a house
 * going for a fixed price can be the deal of the month just as easily as a
 * cottage taking weekends, and hiding the control would mean the promotion
 * feature quietly only worked for one kind of listing.
 */
function syncStayPanel(body, panel) {
  if (!panel) return;
  const status = $('[name="status"]', body);
  const type = $('[name="type"]', body);
  const rental = status && status.value === 'For rent';
  const land = type && isLandType(type.value);

  $$('[data-stay-only]', panel).forEach((row) => { row.hidden = !rental || land; });
  panel.querySelector('legend').textContent = rental ? 'Short stays' : 'Promotion';
}

/*
 * The tenancy and land-terms panels follow the same rule as the specification
 * blocks, for the same reason.
 *
 * A house for sale has no lease term and a parcel of ground is never rented, so
 * showing either panel would put fields in front of an editor that the site will
 * discard on save. Hiding them - rather than letting the office fill in values
 * that are then thrown away without explanation - is the difference between an
 * editor believing the form and quietly working around it.
 */
function syncCategoryPanels(body) {
  const status = $('[name="status"]', body);
  const type = $('[name="type"]', body);
  const rental = Boolean(status && status.value === 'For rent');
  const land = Boolean(type && isLandType(type.value));

  const letPanel = $('[data-let-panel]', body);
  if (letPanel) letPanel.hidden = !rental || land;

  const landPanel = $('[data-land-terms]', body);
  if (landPanel) landPanel.hidden = !land;
}

/** The type <select>, grouped the way the site's filter is grouped. */
const typeOptions = (selected) => `
  <optgroup label="Homes">${HOME_TYPES.map((type) => `<option${type === selected ? ' selected' : ''}>${type}</option>`).join('')}</optgroup>
  <optgroup label="Land">${LAND_TYPES.map((type) => `<option${type === selected ? ' selected' : ''}>${type}</option>`).join('')}</optgroup>`;

/*
 * Swap the two specification fieldsets.
 *
 * A parcel of ground has no bedrooms and no build year, and an editor typing a
 * price for twenty acres should not be asked for a bathroom count on the way -
 * so the house fields are hidden outright rather than left to be zeroed by hand.
 * The block is hidden with `hidden` and the inputs are disabled, because a
 * disabled field is skipped when the drawer reads the form, which is what stops a
 * stale number from a house being carried over onto a plot.
 */
const applyListingKind = (body, type) => {
  const land = isLandType(type) || Boolean($('[name="plotAcres"]', body)?.value);
  const houseBlock = $('[data-house-spec]', body);
  const landBlock = $('[data-land-spec]', body);
  if (houseBlock) {
    houseBlock.hidden = land;
    $$('input, select', houseBlock).forEach((input) => { input.disabled = land; });
  }
  if (landBlock) {
    landBlock.hidden = !land;
    $$('input, select', landBlock).forEach((input) => { input.disabled = !land; });
  }
};

const listingTemplate = {
  id: '', title: '', address: '', city: 'Harbor Point', type: 'House', status: 'For sale',
  price: 500000, beds: 3, baths: 2, area: 1500, lot: '', year: new Date().getFullYear(), parking: 1,
  featured: false, listed: new Date().toISOString().slice(0, 10), agentId: '',
  image: 'assets/homes/property-01.svg', images: [], features: [], description: ''
};

const renderPhotos = (draft) => draft.images.map((image, index) => `
  <div class="photo"><img src="/${escapeHtml(image)}" alt="" />${index === 0 ? '' : `<button type="button" class="photo__cover" data-make-cover="${index}" aria-label="Make this the cover photo" title="Make this the cover photo">&#9733;</button>`}<button type="button" data-remove-photo="${index}" aria-label="Remove photo">&times;</button></div>`).join('');

const renderFeatures = (draft) => draft.features.map((feature, index) => `
  <span class="tag">${escapeHtml(feature)}<button type="button" data-remove-feature="${index}" aria-label="Remove">&times;</button></span>`).join('');

function editListing(existing) {
  const isNew = !existing;
  const draft = existing
    ? JSON.parse(JSON.stringify(existing))
    : { ...JSON.parse(JSON.stringify(listingTemplate)), id: newId('p'), agentId: data.agents[0]?.id || '' };
  draft.features = draft.features || [];
  draft.images = draft.images && draft.images.length ? [...draft.images] : [draft.image];
  draft.removedPhotos = [];

  const html = `
    <fieldset>
      <legend>The basics</legend>
      <div class="form-grid">
        <label class="field field--full"><span>Title</span><input name="title" value="${escapeHtml(draft.title)}" required /></label>
        <label class="field"><span>Address</span><input name="address" value="${escapeHtml(draft.address)}" /></label>
        <label class="field"><span>City or area</span><input name="city" value="${escapeHtml(draft.city)}" /></label>
        <label class="field"><span>Property type</span>
          <select name="type" data-type>${typeOptions(draft.type)}</select>
          <small class="hint">Choosing a land type swaps the specification below for plot size, zoning and title.</small>
        </label>
        <label class="field"><span>Status</span>
          <select name="status">${['For sale', 'For rent', 'Sold'].map((status) => `<option${status === draft.status ? ' selected' : ''}>${status}</option>`).join('')}</select>
        </label>
        <label class="field"><span>Price in ${baseCurrency()} — no commas</span><input name="price" type="number" min="0" step="1000" value="${Number(draft.price) || 0}" required /></label>
        <label class="field"><span>Listed on</span><input name="listed" type="date" value="${escapeHtml(draft.listed)}" /></label>
        <label class="field field--check"><input name="featured" type="checkbox"${draft.featured ? ' checked' : ''} /> <span>Feature on the home page</span></label>
      </div>
    </fieldset>

    <fieldset data-stay-panel>
      <legend>Short stays and promotion</legend>
      <div class="form-grid">
        <label class="field field--full" data-stay-only><span>Lengths of stay accepted</span>
          <span class="check-row">${['Nightly', 'Weekly', 'Monthly'].map((term) => `
            <label class="field--check"><input type="checkbox" name="stays" value="${term}"${(draft.stays || []).includes(term) ? ' checked' : ''} /> <span>${term}</span></label>`).join('')}</span>
          <small class="hint">A sale cannot be booked by the night, so these only apply to a rental. Leave every box empty for an ordinary long let.</small>
        </label>
        <label class="field" data-stay-only><span>Price per night — optional</span>
          <input name="nightly" type="number" min="0" step="1" value="${Number(draft.nightly) || ''}" placeholder="Derived if blank" />
        </label>
        <label class="field" data-stay-only><span>Price per week — optional</span>
          <input name="weekly" type="number" min="0" step="1" value="${Number(draft.weekly) || ''}" placeholder="Derived if blank" />
        </label>
        <label class="field" data-stay-only><span>Refundable deposit — optional</span>
          <input name="deposit" type="number" min="0" step="1" value="${Number(draft.deposit) || ''}" placeholder="None if blank" />
          <small class="hint">Held against the property and returned at the end of the stay. Shown on the listing so a guest can budget for it.</small>
        </label>
        <label class="field" data-stay-only><span>Booking fee — optional</span>
          <input name="bookingFee" type="number" min="0" step="1" value="${Number(draft.bookingFee) || ''}" placeholder="None if blank" />
          <small class="hint">Charged once when the booking is made, on top of the first payment.</small>
        </label>
        <label class="field" data-stay-only><span>Minimum nights</span>
          <input name="minNights" type="number" min="1" max="365" step="1" value="${Number(draft.minNights) || 1}" />
        </label>
        <label class="field" data-stay-only><span>Available from</span>
          <input name="availableFrom" type="date" value="${escapeHtml(draft.availableFrom || '')}" />
        </label>
        <label class="field" data-stay-only><span>Available until</span>
          <input name="availableTo" type="date" value="${escapeHtml(draft.availableTo || '')}" />
        </label>
        <label class="field field--check"><input name="hot" type="checkbox"${draft.hot ? ' checked' : ''} /> <span>Show as a hot deal</span></label>
        <label class="field"><span>Hot deal ends</span>
          <input name="hotUntil" type="date" value="${escapeHtml(draft.hotUntil || '')}" />
          <small class="hint">Leave the date blank for a standing promotion. With a date, the deal stops being hot by itself and nobody has to remember to clear it.</small>
        </label>
      </div>
    </fieldset>

    <fieldset>
      <legend>Specification</legend>
      <div class="form-grid" data-house-spec>
        <label class="field"><span>Bedrooms</span><input name="beds" type="number" min="0" value="${Number(draft.beds) || 0}" /></label>
        <label class="field"><span>Bathrooms</span><input name="baths" type="number" min="0" value="${Number(draft.baths) || 0}" /></label>
        <label class="field"><span>Floor area (ft²)</span><input name="area" type="number" min="0" value="${Number(draft.area) || 0}" /></label>
        <label class="field"><span>Plot</span><input name="lot" value="${escapeHtml(draft.lot)}" placeholder="620 m2 or 0.8 acres" /></label>
        <label class="field"><span>Year built</span><input name="year" type="number" min="1800" max="2100" value="${Number(draft.year) || 2000}" /></label>
        <label class="field"><span>Parking spaces</span><input name="parking" type="number" min="0" value="${Number(draft.parking) || 0}" /></label>
        <label class="field field--full"><span>Listed by</span>
          <select name="agentId">${data.agents.map((agent) => `<option value="${escapeHtml(agent.id)}"${agent.id === draft.agentId ? ' selected' : ''}>${escapeHtml(agent.name)}</option>`).join('')}</select>
        </label>
      </div>

      <div class="form-grid" data-land-spec>
        <label class="field"><span>Plot size</span><input name="plotAcres" type="number" min="0" step="0.01" value="${Number(draft.land?.plotAcres) || ''}" placeholder="20" /></label>
        <label class="field"><span>Unit</span>
          <select name="plotUnit">${PLOT_UNITS.map((unit) => `<option${unit === (draft.land?.plotUnit || 'acres') ? ' selected' : ''}>${unit}</option>`).join('')}</select>
        </label>
        <label class="field"><span>Zoning</span>
          <select name="zoning"><option value="">Not stated</option>${ZONINGS.map((z) => `<option${z === draft.land?.zoning ? ' selected' : ''}>${z}</option>`).join('')}</select>
        </label>
        <label class="field"><span>Title</span>
          <select name="titleDeed"><option value="">Not stated</option>${TITLE_DEEDS.map((t) => `<option${t === draft.land?.titleDeed ? ' selected' : ''}>${t}</option>`).join('')}</select>
        </label>
        <label class="field field--full"><span>Access</span><input name="access" value="${escapeHtml(draft.land?.access || '')}" placeholder="e.g. Tarmac road frontage" /></label>
        <label class="field field--full"><span>Landmarks</span><input name="landmarks" value="${escapeHtml(draft.land?.landmarks || '')}" placeholder="e.g. Fifteen minutes walk to the market" /></label>
        <label class="field field--full"><span>Utilities</span><input name="utilities" value="${escapeHtml(draft.land?.utilities || '')}" placeholder="e.g. Power and water at the street" /></label>
        <label class="field field--full"><span>Listed by</span>
          <select name="landAgentId" data-agent-mirror>${data.agents.map((agent) => `<option value="${escapeHtml(agent.id)}"${agent.id === draft.agentId ? ' selected' : ''}>${escapeHtml(agent.name)}</option>`).join('')}</select>
        </label>
      </div>
    </fieldset>

    <fieldset>
      <legend>Listing truth</legend>
      <div class="form-grid">
        <label class="field"><span>Last confirmed on</span>
          <input name="confirmedOn" type="date" value="${escapeHtml(draft.truth?.confirmedOn || '')}" />
          <small class="hint">The day somebody last checked this was still available at this price. This is what the website prints as "confirmed N days ago", and the "recently confirmed" sort reads it.</small>
        </label>
        <label class="field"><span>Verified on</span>
          <input name="verifiedOn" type="date" value="${escapeHtml(draft.truth?.verifiedOn || '')}" />
          <small class="hint">When the checks below were last carried out. Leave blank if they were never done.</small>
        </label>
        <label class="field field--full"><span>Information source</span>
          <input name="source" value="${escapeHtml(draft.truth?.source || '')}" placeholder="e.g. Verified agent submission, owner confirmed" />
          <small class="hint">Where the information came from. Never write just "verified" - name the source, and let the scope below say what was checked.</small>
        </label>
        <label class="field field--full"><span>Verification scope <small>One per line</small></span>
          <textarea name="scope" rows="3" placeholder="Agent identity and listing authority checked&#10;Price and availability confirmed with the owner">${escapeHtml((draft.truth?.scope || []).join('\n'))}</textarea>
          <small class="hint">Exactly what was checked, and nothing more. This is printed on the listing word for word, so "we know who this agent is" must not be written as "we inspected the house".</small>
        </label>
      </div>
    </fieldset>

    <fieldset data-let-panel>
      <legend>Tenancy terms</legend>
      <div class="form-grid">
        <label class="field"><span>Lease term</span><input name="leaseTerm" value="${escapeHtml(draft.let?.leaseTerm || '')}" placeholder="12 months" /></label>
        <label class="field"><span>Deposit</span><input name="letDeposit" type="number" min="0" value="${Number(draft.let?.deposit) || ''}" placeholder="None if blank" /></label>
        <label class="field"><span>Move-in date</span><input name="moveIn" type="date" value="${escapeHtml(draft.let?.moveIn || '')}" /></label>
        <label class="field"><span>Pets</span><input name="pets" value="${escapeHtml(draft.let?.pets || '')}" placeholder="No pets" /></label>
        <label class="field field--full"><span>Utilities</span>
          <input name="letUtilities" value="${escapeHtml(draft.let?.utilities || '')}" placeholder="e.g. Water and heating included. Electricity metered." />
          <small class="hint">Say who pays for what. "Included" is not an answer.</small>
        </label>
      </div>
    </fieldset>

    <fieldset data-land-terms>
      <legend>What you may do with it</legend>
      <div class="form-grid">
        <label class="field field--full"><span>Permitted use</span>
          <input name="permittedUse" value="${escapeHtml(draft.land?.permittedUse || '')}" placeholder="e.g. Residential - single dwelling" />
        </label>
        <label class="field field--full"><span>Restrictions and covenants</span>
          <textarea name="restrictions" rows="2" placeholder="e.g. No building within 6 m of the river boundary">${escapeHtml(draft.land?.restrictions || '')}</textarea>
          <small class="hint">Zoning says what the council permits; this is what the title forbids. Both are printed, and they are not the same thing.</small>
        </label>
      </div>
    </fieldset>

    <fieldset>
      <legend>Promotion, if it is one</legend>
      <div class="form-grid">
        <label class="field"><span>Deal started</span>
          <input name="hotSince" type="date" value="${escapeHtml(draft.promotion?.hotSince || '')}" />
        </label>
        <label class="field field--full"><span>Why the price moved</span>
          <input name="hotReason" value="${escapeHtml(draft.promotion?.hotReason || '')}" placeholder="e.g. Reduced to fill the winter vacancy, agreed with the owner." />
        </label>
        <label class="field field--full"><span>What the discount does NOT include</span>
          <input name="hotExcludes" value="${escapeHtml(draft.promotion?.hotExcludes || '')}" placeholder="e.g. The deposit and booking fee are not reduced." />
          <small class="hint">The most important field on this panel. A reduced rent that excludes the deposit is a smaller discount than the headline, and the reader is entitled to know before they act.</small>
        </label>
      </div>
    </fieldset>

    <fieldset>
      <legend>Our view of the value</legend>
      <div class="form-grid">
        <label class="field"><span>Low</span><input name="valLow" type="number" min="0" value="${Number(draft.valuation?.low) || ''}" placeholder="Blank for no opinion" /></label>
        <label class="field"><span>High</span><input name="valHigh" type="number" min="0" value="${Number(draft.valuation?.high) || ''}" /></label>
        <label class="field"><span>Valued on</span><input name="valOn" type="date" value="${escapeHtml(draft.valuation?.on || '')}" /></label>
        <label class="field"><span>Confidence</span>
          <select name="valConfidence">${['High', 'Medium', 'Low'].map((c) => `<option${c === draft.valuation?.confidence ? ' selected' : ''}>${c}</option>`).join('')}</select>
          <small class="hint">Dropped to Low automatically when there is only one comparable. The asking price should sit inside the range.</small>
        </label>
        <label class="field field--full"><span>Comparable sales <small>One per line</small></span>
          <textarea name="comps" rows="3" placeholder="p7 Harbourline Tower - 3200 sq ft waterfront, sold 14 Aug 2026">${escapeHtml((draft.valuation?.comps || []).join('\n'))}</textarea>
        </label>
        <label class="field field--full"><span>What this assumes <small>One per line</small></span>
          <textarea name="assumptions" rows="3" placeholder="Assumes the mooring rights are transferable">${escapeHtml((draft.valuation?.assumptions || []).join('\n'))}</textarea>
        </label>
      </div>
      <label class="field field--check"><input name="sponsored" type="checkbox"${draft.sponsored ? ' checked' : ''} />
        <span>Sponsored placement — this position is paid for</span>
      </label>
      <small class="hint">Only ever enabled by the office, never by an agent. Paying for a position must never buy the appearance of extra checks, so it is stored and printed separately from the truth fields above.</small>
    </fieldset>

    <fieldset>
      <legend>Price history</legend>
      <div class="form-grid">
        <label class="field field--full"><span>Previous price</span>
          <input name="priceReducedFrom" type="number" min="0" value="${draft.priceHistory?.length ? Number(draft.priceHistory[draft.priceHistory.length - 1].from) || '' : ''}" placeholder="Blank if the price has never changed" />
          <small class="hint">Must be higher than the price being asked. This is separate from the hot-deal "original price" on purpose: a reduction is the market moving, a promotion is the office deciding, and only the first one belongs in the "price reduced" sort.</small>
        </label>
        <label class="field"><span>Reduced on</span>
          <input name="priceReducedOn" type="date" value="${escapeHtml(draft.priceHistory?.length ? draft.priceHistory[draft.priceHistory.length - 1].on : '')}" />
        </label>
      </div>
    </fieldset>

    <fieldset>
      <legend>Description</legend>
      <label class="field"><textarea name="description">${escapeHtml(draft.description)}</textarea></label>
    </fieldset>

    <fieldset>
      <legend>Photos</legend>
      <div class="photo-list" id="photo-list">${renderPhotos(draft)}</div>
      <div class="photo-actions">
        <label class="btn btn--secondary btn--sm">Upload photos<input id="photo-input" type="file" accept="image/*" multiple hidden /></label>
        <small class="hint">The first photo is used as the cover.</small>
      </div>
    </fieldset>

    <fieldset>
      <legend>Features</legend>
      <div class="tags" id="feature-tags">${renderFeatures(draft)}</div>
      <div class="photo-actions" style="margin-top:0">
        <input id="feature-input" type="text" placeholder="e.g. Underfloor heating" style="flex:1;padding:9px 12px;border:1px solid #e4e7ec;border-radius:9px" />
        <button class="btn btn--secondary btn--sm" type="button" id="feature-add">Add</button>
      </div>
    </fieldset>`;

  openDrawer({
    title: isNew ? 'New listing' : `Edit: ${draft.title}`,
    html,
    onApply: () => {
      const body = $('#drawer-body');
      const value = (name) => ($(`.field [name="${name}"]`, body)?.value ?? '').trim();
      const type = value('type');
      const land = isLandType(type);

      // "Listed by" appears in both specification blocks, so only one of the two
      // selects is enabled at a time. Read whichever is live rather than assuming
      // the house one.
      const agentId = value(land ? 'landAgentId' : 'agentId') || value('agentId') || value('landAgentId');

      const updated = {
        ...draft,
        title: value('title') || 'Untitled listing',
        address: value('address'),
        city: value('city'),
        type,
        status: value('status'),
        price: Number(value('price')) || 0,
        listed: value('listed'),
        featured: $('[name="featured"]', body).checked,
        // A parcel of ground has no rooms and no floor area, so those are written
        // as zero rather than left holding whatever the block still showed.
        beds: land ? 0 : Number(value('beds')) || 0,
        baths: land ? 0 : Number(value('baths')) || 0,
        area: land ? 0 : Number(value('area')) || 0,
        lot: value('lot'),
        year: land ? 0 : Number(value('year')) || 0,
        parking: land ? 0 : Number(value('parking')) || 0,
        agentId,
        description: value('description'),
        images: [...draft.images],
        image: draft.images[0] || FALLBACK_IMAGE,
        features: [...draft.features]
      };

      /*
       * Short stays.
       *
       * Everything here is removed rather than blanked when the office unticks a
       * box. Leaving `nightly: 0` behind would stop the website deriving that
       * rate from the monthly price and would show a free night, so an unticked
       * panel has to erase the fields, not empty them.
       */
      const stays = $$('[name="stays"]:checked', body).map((box) => box.value);
      ['stays', 'nightly', 'weekly', 'minNights', 'availableFrom', 'availableTo', 'deposit', 'bookingFee'].forEach((key) => {
        delete updated[key];
      });
      if (stays.length && !land && updated.status === 'For rent') {
        updated.stays = STAY_TERMS.filter((term) => stays.includes(term));
        const nightly = Number(value('nightly'));
        if (nightly > 0) updated.nightly = nightly;
        const weekly = Number(value('weekly'));
        if (weekly > 0) updated.weekly = weekly;
        const minNights = Number(value('minNights'));
        if (minNights >= 1 && minNights <= 365) updated.minNights = minNights;
        if (value('availableFrom')) updated.availableFrom = value('availableFrom');
        if (value('availableTo')) updated.availableTo = value('availableTo');
        // The two figures a guest cannot infer from a nightly rate. Deleted above
        // with the rest, so clearing them here is what makes them go.
        const deposit = Number(value('deposit'));
        if (deposit > 0) updated.deposit = deposit;
        const bookingFee = Number(value('bookingFee'));
        if (bookingFee > 0) updated.bookingFee = bookingFee;
      }

      /*
       * Promotion. Kept separate from the stays above on purpose: a house going
       * for a fixed price can still be the deal of the month, and a rental can be
       * hot without taking a single night. `hotUntil` is optional on purpose too,
       * because a standing promotion is a real thing an agency wants.
       */
      updated.hot = $('[name="hot"]', body).checked;
      if (updated.hot && value('hotUntil')) updated.hotUntil = value('hotUntil');
      else delete updated.hotUntil;
      if (!updated.hot) updated.hot = false;

      /*
       * Listing truth.
       *
       * Written on every save, including when it is blank - an editor who clears
       * the confirmation date is removing a claim, and the site has to be able to
       * say "not confirmed on record" rather than quietly keeping the old date and
       * continuing to claim a freshness nobody stands behind. The block is kept
       * even when empty, because its absence and its emptiness mean different
       * things to the renderer.
       */
      updated.truth = {
        confirmedOn: value('confirmedOn'),
        verifiedOn: value('verifiedOn'),
        source: value('source'),
        scope: value('scope').split('\n').map((line) => line.trim()).filter(Boolean)
      };

      // Tenancy. A rental with no terms recorded shows no panel at all, which is
      // honest; it does not show an empty one that implies there are none.
      if (updated.status === 'For rent' && !land) {
        const tenancy = {
          leaseTerm: value('leaseTerm'),
          utilities: value('letUtilities'),
          pets: value('pets'),
          moveIn: value('moveIn')
        };
        const letDeposit = Number(value('letDeposit'));
        if (letDeposit > 0) tenancy.deposit = letDeposit;
        // Only stored when the office actually wrote something. A blank panel on
        // a listing that has never had terms recorded should not manufacture a
        // record of having been asked for them.
        if (Object.values(tenancy).some((entry) => entry)) updated.let = tenancy;
        else delete updated.let;
      } else {
        delete updated.let;
      }

      /*
       * Promotion detail. Tied to the flag: a listing that is not hot must not
       * keep a "reason the price moved" from when it was, or the words linger on
       * a page that no longer shows a deal.
       */
      if (updated.hot) {
        updated.promotion = {
          hotSince: value('hotSince'),
          hotReason: value('hotReason'),
          hotExcludes: value('hotExcludes')
        };
      } else {
        delete updated.promotion;
      }

      /*
       * Valuation. Both ends are required - a range needs two numbers, and a
       * single figure is precisely the false precision the panel exists to avoid,
       * so a half-filled opinion is discarded rather than half-published.
       *
       * The asking price is checked against the range here as well as in the
       * tests. It is one line, and it is the difference between an agent pricing
       * above their own opinion on purpose and an agent who typed the wrong
       * number into the wrong box.
       */
      const valLow = Number(value('valLow'));
      const valHigh = Number(value('valHigh'));
      if (valLow > 0 && valHigh > 0 && valLow <= valHigh) {
        if (updated.price < valLow || updated.price > valHigh) {
          announce(`Saved, but note the price of ${money(updated.price)} sits outside the ${money(valLow)}–${money(valHigh)} range.`);
        }
        updated.valuation = {
          low: valLow,
          high: valHigh,
          on: value('valOn'),
          confidence: value('valConfidence') || 'Medium',
          comps: value('comps').split('\n').map((line) => line.trim()).filter(Boolean),
          assumptions: value('assumptions').split('\n').map((line) => line.trim()).filter(Boolean)
        };
      } else {
        delete updated.valuation;
      }

      // Paid placement. Office-only, and stored entirely apart from the truth
      // block above so that no future code path can read "this has been checked"
      // off the back of somebody having paid for the position.
      updated.sponsored = $('[name="sponsored"]', body).checked;

      /*
       * Price history. Only recorded when the previous figure is genuinely higher
       * than the price being asked: an entry at or below the current price is not
       * a reduction, and recording one would put this listing in the "price
       * reduced" sort for something that never happened.
       */
      const reducedFrom = Number(value('priceReducedFrom'));
      if (reducedFrom > updated.price) {
        updated.priceHistory = [{ from: reducedFrom, on: value('priceReducedOn') }];
      } else {
        delete updated.priceHistory;
      }

      if (land) {
        const plotAcres = Number(value('plotAcres')) || 0;
        updated.land = {
          plotAcres,
          plotUnit: value('plotUnit') || 'acres',
          zoning: value('zoning'),
          titleDeed: value('titleDeed'),
          access: value('access'),
          landmarks: value('landmarks'),
          utilities: value('utilities'),
          // What may be built and what the title forbids. Carried in the same
          // block as zoning so a parcel cannot end up with one and not the other.
          permittedUse: value('permittedUse'),
          restrictions: value('restrictions')
        };
        // Keep `lot` agreeing with the numeric plot, since it is what the app reads.
        if (plotAcres > 0) {
          const unit = updated.land.plotUnit === 'hectares' ? 'hectares' : updated.land.plotUnit === 'sq m' ? 'm²' : 'acres';
          updated.lot = `${plotAcres} ${unit}`;
        }
      } else {
        // Dropping the block entirely is what stops a house from being treated as
        // land by the site, which keys off both the type and the land block.
        delete updated.land;
      }

      const index = data.listings.findIndex((item) => item.id === draft.id);
      if (index === -1) data.listings.unshift(updated);
      else data.listings[index] = updated;
      // Now the edit is real, so any photo it dropped can be cleared from disk -
      // but only if nothing else still refers to it.
      if (draft.removedPhotos.length) removeUnreferencedPhotos(draft.removedPhotos);
    }
  });
  wireListingDrawer(draft);
}

function wireListingDrawer(draft) {
  const body = $('#drawer-body');

  // Pick the right specification block for the type already on the listing, and
  // keep picking it as the editor changes type.
  const typeControl = $('[data-type]', body);
  if (typeControl) {
    applyListingKind(body, typeControl.value);
    typeControl.addEventListener('change', () => applyListingKind(body, typeControl.value));
  }

  // The short-stay panel follows the status for the same reason the spec block
  // follows the type: nights and weeks are meaningless on a house for sale.
  const stayPanel = $('[data-stay-panel]', body);
  if (stayPanel) {
    syncStayPanel(body, stayPanel);
    $('[name="status"]', body)?.addEventListener('change', () => syncStayPanel(body, stayPanel));
    typeControl?.addEventListener('change', () => syncStayPanel(body, stayPanel));
  }

  // Same rule, same reason: the tenancy panel is for rentals and the land-terms
  // panel is for parcels, and both have to react to type and status changing.
  syncCategoryPanels(body);
  $('[name="status"]', body)?.addEventListener('change', () => syncCategoryPanels(body));
  typeControl?.addEventListener('change', () => syncCategoryPanels(body));

  // Both blocks carry a "Listed by", and only one is enabled at a time, so a
  // change in either has to be reflected in the other or the agent silently
  // changes back depending on which block was open when the drawer was applied.
  const agentMirrors = [$('[name="agentId"]', body), $('[data-agent-mirror]', body)].filter(Boolean);
  agentMirrors.forEach((control) => control.addEventListener('change', () => {
    agentMirrors.forEach((other) => { if (other !== control) other.value = control.value; });
  }));

  const refreshPhotos = () => { $('#photo-list', body).innerHTML = renderPhotos(draft); };
  const refreshFeatures = () => { $('#feature-tags', body).innerHTML = renderFeatures(draft); };

  $('#photo-input', body).addEventListener('change', async (event) => {
    const files = [...event.target.files];
    if (!files.length) return;
    announce(`Uploading ${files.length} photo${files.length === 1 ? '' : 's'}...`);
    const uploaded = [];
    for (const file of files) {
      try {
        uploaded.push(await uploadPhoto(file));
      } catch (problem) {
        announce(problem.message);
      }
    }
    // New photos go to the front, not the back. On the public site the first
    // photo is the cover - it is what every card and the home page show, and
    // the detail page's main gallery image. Appending left the upload saved but
    // invisible, which looked like nothing had happened.
    draft.images.unshift(...uploaded);
    event.target.value = '';
    refreshPhotos();
    announce(uploaded.length > 1
      ? `${uploaded.length} photos uploaded - the first is now the cover`
      : 'Photo uploaded - it is now the cover');
  });

  body.addEventListener('click', (event) => {
    const coverButton = event.target.closest('[data-make-cover]');
    if (coverButton) {
      const index = Number(coverButton.dataset.makeCover);
      if (index > 0) {
        const [chosen] = draft.images.splice(index, 1);
        draft.images.unshift(chosen);
        refreshPhotos();
        announce('Cover photo changed');
      }
      return;
    }
    const photoButton = event.target.closest('[data-remove-photo]');
    if (photoButton) {
      const index = Number(photoButton.dataset.removePhoto);
      const [removed] = draft.images.splice(index, 1);
      // Remember it, but do not delete anything yet: Cancel must be safe, and
      // other listings may still use the file.
      draft.removedPhotos.push(removed);
      refreshPhotos();
      return;
    }
    const featureButton = event.target.closest('[data-remove-feature]');
    if (featureButton) {
      draft.features.splice(Number(featureButton.dataset.removeFeature), 1);
      refreshFeatures();
    }
  });

  const addFeature = () => {
    const input = $('#feature-input', body);
    const value = input.value.trim();
    if (!value) return;
    draft.features.push(value);
    input.value = '';
    refreshFeatures();
  };
  $('#feature-add', body).addEventListener('click', addFeature);
  $('#feature-input', body).addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); addFeature(); }
  });
}

function editAgent(existing) {
  const isNew = !existing;
  const draft = existing
    ? { ...existing }
    : { id: newId('a'), name: '', role: 'Sales advisor', initials: '', tint: 'teal', listings: 0, phone: '', email: '', bio: '' };
  const tints = ['teal', 'sand', 'lilac', 'slate'];

  openDrawer({
    title: isNew ? 'New agent' : `Edit: ${draft.name}`,
    html: `
      <fieldset>
        <legend>Agent</legend>
        <div class="form-grid">
          <label class="field field--full"><span>Name</span><input name="name" value="${escapeHtml(draft.name)}" /></label>
          <label class="field"><span>Role</span><input name="role" value="${escapeHtml(draft.role)}" /></label>
          <label class="field"><span>Initials</span><input name="initials" maxlength="3" value="${escapeHtml(draft.initials)}" placeholder="EM" /></label>
          <label class="field"><span>Colour</span>
            <select name="tint">${tints.map((tint) => `<option${tint === draft.tint ? ' selected' : ''}>${tint}</option>`).join('')}</select>
          </label>
          <label class="field"><span>Sales on record</span><input name="listings" type="number" min="0" value="${Number(draft.listings) || 0}" /></label>
          <label class="field"><span>Phone</span><input name="phone" value="${escapeHtml(draft.phone)}" /></label>
          <label class="field"><span>Email</span><input name="email" type="email" value="${escapeHtml(draft.email)}" /></label>
          <label class="field field--full"><span>Short bio</span><textarea name="bio">${escapeHtml(draft.bio)}</textarea></label>
        </div>
      </fieldset>`,
    onApply: () => {
      const body = $('#drawer-body');
      const value = (name) => ($(`.field [name="${name}"]`, body)?.value ?? '').trim();
      const name = value('name') || 'New agent';
      const updated = {
        ...draft,
        name,
        role: value('role'),
        initials: value('initials') || name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase(),
        tint: value('tint'),
        listings: Number(value('listings')) || 0,
        phone: value('phone'),
        email: value('email'),
        bio: value('bio')
      };
      const index = data.agents.findIndex((agent) => agent.id === draft.id);
      if (index === -1) data.agents.push(updated);
      else data.agents[index] = updated;
    }
  });
}

function editOffice(existing, index) {
  const isNew = existing === undefined;
  const draft = existing ? { ...existing } : { city: '', address: '', phone: '', hours: '' };

  openDrawer({
    title: isNew ? 'New office' : `Edit: ${draft.city}`,
    html: `
      <fieldset>
        <legend>Office</legend>
        <div class="form-grid">
          <label class="field field--full"><span>City or area</span><input name="city" value="${escapeHtml(draft.city)}" /></label>
          <label class="field field--full"><span>Address</span><input name="address" value="${escapeHtml(draft.address)}" /></label>
          <label class="field"><span>Phone</span><input name="phone" value="${escapeHtml(draft.phone)}" /></label>
          <label class="field"><span>Opening hours</span><input name="hours" value="${escapeHtml(draft.hours)}" placeholder="Mon-Fri 9:00-18:00" /></label>
        </div>
      </fieldset>`,
    onApply: () => {
      const body = $('#drawer-body');
      const value = (name) => ($(`.field [name="${name}"]`, body)?.value ?? '').trim();
      const updated = {
        city: value('city') || 'New office',
        address: value('address'),
        phone: value('phone'),
        hours: value('hours')
      };
      if (isNew) data.offices.push(updated);
      else data.offices[index] = updated;
    }
  });
}

/* ---- list actions ------------------------------------------------------- */
$('#new-listing').addEventListener('click', () => editListing(null));
$('#new-agent').addEventListener('click', () => editAgent(null));
$('#new-office').addEventListener('click', () => editOffice(undefined, -1));

document.addEventListener('click', (event) => {
  const editButton = event.target.closest('[data-edit]');
  if (editButton) {
    editListing(data.listings.find((listing) => listing.id === editButton.dataset.edit));
    return;
  }
  const deleteButton = event.target.closest('[data-delete]');
  if (deleteButton) {
    const listing = data.listings.find((item) => item.id === deleteButton.dataset.delete);
    if (listing && window.confirm(`Delete "${listing.title}"? This cannot be undone.`)) {
      data.listings = data.listings.filter((item) => item.id !== listing.id);
      markDirty();
      renderAll();
      announce('Listing deleted - remember to save');
    }
    return;
  }
  const editAgentButton = event.target.closest('[data-edit-agent]');
  if (editAgentButton) {
    editAgent(data.agents.find((agent) => agent.id === editAgentButton.dataset.editAgent));
    return;
  }
  const deleteAgentButton = event.target.closest('[data-delete-agent]');
  if (deleteAgentButton) {
    const agent = data.agents.find((item) => item.id === deleteAgentButton.dataset.deleteAgent);
    if (agent && window.confirm(`Delete agent ${agent.name}?`)) {
      data.agents = data.agents.filter((item) => item.id !== agent.id);
      markDirty();
      renderAll();
      announce('Agent deleted - remember to save');
    }
    return;
  }
  const editOfficeButton = event.target.closest('[data-edit-office]');
  if (editOfficeButton) {
    const index = Number(editOfficeButton.dataset.editOffice);
    editOffice(data.offices[index], index);
    return;
  }
  const deleteOfficeButton = event.target.closest('[data-delete-office]');
  if (deleteOfficeButton) {
    const index = Number(deleteOfficeButton.dataset.deleteOffice);
    if (window.confirm(`Delete the ${data.offices[index].city} office?`)) {
      data.offices.splice(index, 1);
      markDirty();
      renderAll();
      announce('Office deleted - remember to save');
    }
  }
});

/* ---- boot --------------------------------------------------------------- */
if (token) {
  startApp().catch(() => showLogin());
} else {
  showLogin();
}
