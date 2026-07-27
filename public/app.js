// SCP788BOT Mini App
// Talks directly to TheSportsDB (free tier) from the browser for scores/
// fixtures/standings, and to our one Netlify function for news (RSS needs
// a server-side fetch to avoid CORS). Follows are stored per-user in
// Telegram's CloudStorage so there's no backend database to run.

const SPORTSDB_KEY = "3";
const SPORTSDB_BASE = `https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}`;
const NEWS_ENDPOINT = "/api/news";
const FOLLOWS_KEY = "scp788_follows";

const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

// ---------------------------------------------------------------------
// Telegram bootstrap
// ---------------------------------------------------------------------
function initTelegram() {
  if (!tg) return;
  tg.ready();
  tg.expand();
  document.getElementById("headerSub").textContent = tg.initDataUnsafe?.user?.first_name
    ? `Hey ${tg.initDataUnsafe.user.first_name} — here's today's action`
    : "Your daily sports companion";
}

// ---------------------------------------------------------------------
// Storage: Telegram CloudStorage with a localStorage fallback so this
// still works when previewing outside Telegram during development.
// ---------------------------------------------------------------------
function storageGet(key) {
  return new Promise((resolve) => {
    if (tg && tg.CloudStorage) {
      tg.CloudStorage.getItem(key, (err, value) => {
        if (err) { resolve(null); return; }
        resolve(value || null);
      });
    } else {
      resolve(window.localStorage.getItem(key));
    }
  });
}

function storageSet(key, value) {
  return new Promise((resolve) => {
    if (tg && tg.CloudStorage) {
      tg.CloudStorage.setItem(key, value, () => resolve(true));
    } else {
      window.localStorage.setItem(key, value);
      resolve(true);
    }
  });
}

async function getFollows() {
  const raw = await storageGet(FOLLOWS_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

async function saveFollows(follows) {
  await storageSet(FOLLOWS_KEY, JSON.stringify(follows));
}

async function addFollow(team) {
  const follows = await getFollows();
  if (follows.some((f) => f.idTeam === team.idTeam)) return follows;
  follows.push(team);
  await saveFollows(follows);
  return follows;
}

async function removeFollow(teamId) {
  const follows = await getFollows();
  const next = follows.filter((f) => f.idTeam !== teamId);
  await saveFollows(next);
  return next;
}

// ---------------------------------------------------------------------
// TheSportsDB helpers
// ---------------------------------------------------------------------
const FETCH_TIMEOUT_MS = 10000;

// Never throws — a failed or slow request just resolves to null so the
// UI can always fall back to an empty/error state instead of hanging on
// a stuck spinner forever.
async function safeFetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error("Request failed:", url, err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function sdbGet(path, params) {
  const url = new URL(`${SPORTSDB_BASE}/${path}`);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  return safeFetchJson(url.toString());
}

async function searchTeam(name) {
  const data = await sdbGet("searchteams.php", { t: name });
  return (data && data.teams) || [];
}

async function teamNextEvents(teamId) {
  const data = await sdbGet("eventsnext.php", { id: teamId });
  return (data && data.events) || [];
}

async function teamLastEvents(teamId) {
  const data = await sdbGet("eventslast.php", { id: teamId });
  return (data && data.results) || [];
}

async function leagueTable(leagueId, season) {
  const data = await sdbGet("lookuptable.php", { l: leagueId, s: season });
  return (data && data.table) || [];
}

async function allLeagues() {
  const data = await sdbGet("all_leagues.php");
  return (data && data.leagues) || [];
}

function currentSeasonGuess() {
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  return month >= 7 ? `${year}-${year + 1}` : `${year - 1}-${year}`;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------
// News (via Netlify function)
// ---------------------------------------------------------------------
async function fetchNews(query) {
  const url = query ? `${NEWS_ENDPOINT}?q=${encodeURIComponent(query)}` : NEWS_ENDPOINT;
  const data = await safeFetchJson(url);
  return (data && data.items) || [];
}

// ---------------------------------------------------------------------
// Ticker (signature element) — scrolls today's + live fixtures for
// followed teams along the top, stadium-scoreboard style.
// ---------------------------------------------------------------------
async function refreshTicker() {
  const tickerEl = document.getElementById("ticker");
  if (!tickerEl) return;

  try {
    const follows = await getFollows();

    if (follows.length === 0) {
      tickerEl.innerHTML = `<span class="ticker-item">Follow a team in the Me tab to see fixtures here</span>`;
      return;
    }

    const items = [];
    for (const f of follows.slice(0, 8)) {
      const events = await teamNextEvents(f.idTeam);
      const next = events[0];
      if (next) {
        items.push(`${next.strHomeTeam} vs ${next.strAwayTeam} — ${next.dateEvent} ${next.strTime || ""}`.trim());
      }
    }

    tickerEl.innerHTML = items.length
      ? items.map((i) => `<span class="ticker-item">${escapeHtml(i)}</span>`).join("")
      : `<span class="ticker-item">No upcoming fixtures found for your teams</span>`;
  } catch (err) {
    console.error("Ticker refresh failed:", err);
    tickerEl.innerHTML = `<span class="ticker-item">Couldn't load fixtures right now</span>`;
  }
}

// ---------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function setScreen(html) {
  document.getElementById("screen").innerHTML = html;
}

function loadingRow(label) {
  return `<div class="spinner-row">${escapeHtml(label || "Loading…")}</div>`;
}

function emptyState(big, sub) {
  return `<div class="empty-state"><span class="big">${escapeHtml(big)}</span>${escapeHtml(sub || "")}</div>`;
}

function errorState(sub) {
  return emptyState("Couldn't load that", sub || "Check your connection and try again.");
}

// ---------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------
async function renderToday() {
  setScreen(loadingRow("Checking today's fixtures…"));
  try {
    const follows = await getFollows();

    if (follows.length === 0) {
      setScreen(emptyState("No teams yet", "Head to the Me tab and follow a team to see today's matches."));
      return;
    }

    const today = todayISO();
    let rows = [];

    for (const f of follows) {
      const events = await teamNextEvents(f.idTeam);
      const todays = events.filter((e) => e.dateEvent === today);
      for (const ev of todays) {
        rows.push({ ...ev, followedTeam: f.strTeam });
      }
    }

    if (rows.length === 0) {
      setScreen(emptyState("Nothing today", "No matches today for your followed teams. Check back tomorrow."));
      return;
    }

    const html = [`<div class="section-title">Today · ${today}</div>`];
    for (const ev of rows) {
      html.push(`
        <div class="card">
          <div class="match-row">
            <div>
              <div class="match-teams">${escapeHtml(ev.strHomeTeam)} vs ${escapeHtml(ev.strAwayTeam)}</div>
              <div class="match-meta">${escapeHtml(ev.strTime || "TBD")} UTC · ${escapeHtml(ev.followedTeam)}</div>
            </div>
          </div>
        </div>
      `);
    }
    setScreen(html.join(""));
  } catch (err) {
    console.error("renderToday failed:", err);
    setScreen(errorState());
  }
}

async function renderLive() {
  setScreen(loadingRow("Checking for live matches…"));
  try {
    const follows = await getFollows();

    if (follows.length === 0) {
      setScreen(emptyState("No teams yet", "Head to the Me tab and follow a team first."));
      return;
    }

    let live = [];
    for (const f of follows) {
      const events = await teamNextEvents(f.idTeam);
      for (const ev of events) {
        const status = (ev.strStatus || "").toLowerCase();
        if (status && status !== "not started" && status !== "ns") {
          live.push(ev);
        }
      }
    }

    if (live.length === 0) {
      setScreen(emptyState("Nothing live", "No live matches right now for your teams. Check the Today tab for upcoming fixtures."));
      return;
    }

    const html = [`<div class="section-title"><span class="live-dot"></span>Live now</div>`];
    for (const ev of live) {
      html.push(`
        <div class="card">
          <div class="match-row">
            <div>
              <div class="match-teams">${escapeHtml(ev.strHomeTeam)} vs ${escapeHtml(ev.strAwayTeam)}</div>
              <div class="match-meta">${escapeHtml(ev.strStatus || "")}</div>
            </div>
            <div class="score">${ev.intHomeScore ?? "-"}-${ev.intAwayScore ?? "-"}</div>
          </div>
        </div>
      `);
    }
    setScreen(html.join(""));
  } catch (err) {
    console.error("renderLive failed:", err);
    setScreen(errorState());
  }
}

async function renderTable() {
  const follows = await getFollows();
  const defaultLeagueId = follows[0]?.idLeague;
  const defaultLeagueName = follows[0]?.strLeague;

  setScreen(`
    <div class="section-title">Standings</div>
    <div class="search-row">
      <input id="leagueSearch" placeholder="Search a league e.g. Premier League" />
      <button class="btn" id="leagueSearchBtn">Go</button>
    </div>
    <div id="tableResults">${defaultLeagueId ? loadingRow("Loading table…") : emptyState("Pick a league", "Search above, or follow a team in the Me tab so we know which table to show.")}</div>
  `);

  document.getElementById("leagueSearchBtn").addEventListener("click", async () => {
    const q = document.getElementById("leagueSearch").value.trim();
    if (!q) return;
    const resultsEl = document.getElementById("tableResults");
    resultsEl.innerHTML = loadingRow("Searching…");
    try {
      const leagues = await allLeagues();
      const match = leagues.find((l) => (l.strLeague || "").toLowerCase().includes(q.toLowerCase()));
      if (!match) {
        resultsEl.innerHTML = emptyState("Not found", `No league matching "${q}".`);
        return;
      }
      await loadTable(match.idLeague, match.strLeague);
    } catch (err) {
      console.error("League search failed:", err);
      resultsEl.innerHTML = errorState();
    }
  });

  if (defaultLeagueId) {
    await loadTable(defaultLeagueId, defaultLeagueName);
  }
}

async function loadTable(leagueId, leagueName) {
  const container = document.getElementById("tableResults");
  if (!container) return;

  try {
    const season = currentSeasonGuess();
    const table = await leagueTable(leagueId, season);

    if (table.length === 0) {
      container.innerHTML = emptyState("No table yet", `${leagueName} — season may not have started.`);
      return;
    }

    const rows = [`
      <div class="section-title">${escapeHtml(leagueName)} · ${season}</div>
      <div class="table-row header"><span>#</span><span>Team</span><span class="pld">P</span><span class="pts">Pts</span></div>
    `];
    for (const row of table.slice(0, 20)) {
      rows.push(`
        <div class="table-row">
          <span class="rank">${escapeHtml(row.intRank || "?")}</span>
          <span>${escapeHtml(row.strTeam || "?")}</span>
          <span class="pld">${escapeHtml(row.intPlayed ?? "?")}</span>
          <span class="pts">${escapeHtml(row.intPoints ?? "?")}</span>
        </div>
      `);
    }
    container.innerHTML = `<div class="card">${rows.join("")}</div>`;
  } catch (err) {
    console.error("loadTable failed:", err);
    container.innerHTML = errorState();
  }
}

async function renderNews() {
  setScreen(loadingRow("Fetching headlines…"));
  try {
    const follows = await getFollows();
    const query = follows[0]?.strTeam || null;

    const items = await fetchNews(query);
    if (items.length === 0) {
      setScreen(emptyState("No headlines", "Nothing found right now — try again shortly."));
      return;
    }

    const html = [`<div class="section-title">Latest news${query ? " · " + escapeHtml(query) : ""}</div>`];
    for (const item of items) {
      html.push(`
        <a class="card news-item" href="${item.link}" target="_blank" rel="noopener">
          <div class="news-title">${escapeHtml(item.title)}</div>
          <div class="news-meta">${escapeHtml(item.published || "")}</div>
        </a>
      `);
    }
    setScreen(html.join(""));
  } catch (err) {
    console.error("renderNews failed:", err);
    setScreen(errorState());
  }
}

async function renderMe() {
  const follows = await getFollows();

  const pills = follows.length
    ? `<div class="pill-row">${follows.map((f) => `
        <span class="pill">${escapeHtml(f.strTeam)}<button data-unfollow="${f.idTeam}">&times;</button></span>
      `).join("")}</div>`
    : `<div class="empty-state" style="padding:16px 0;"><span class="big">No teams yet</span>Search below to follow your first team.</div>`;

  setScreen(`
    <div class="section-title">Your teams</div>
    ${pills}
    <div class="search-row">
      <input id="teamSearch" placeholder="Search a team e.g. Arsenal" />
      <button class="btn" id="teamSearchBtn">Go</button>
    </div>
    <div id="teamResults"></div>

    <div class="section-title">Daily trivia</div>
    <div class="trivia-card" id="triviaCard"></div>
  `);

  document.getElementById("teamSearchBtn").addEventListener("click", handleTeamSearch);
  document.querySelectorAll("[data-unfollow]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      await removeFollow(e.target.getAttribute("data-unfollow"));
      renderMe();
      refreshTicker();
    });
  });

  renderTrivia();
}

async function handleTeamSearch() {
  const q = document.getElementById("teamSearch").value.trim();
  if (!q) return;
  const resultsEl = document.getElementById("teamResults");
  resultsEl.innerHTML = loadingRow("Searching…");

  let teams;
  try {
    teams = await searchTeam(q);
  } catch (err) {
    console.error("Team search failed:", err);
    resultsEl.innerHTML = errorState();
    return;
  }

  if (teams.length === 0) {
    resultsEl.innerHTML = emptyState("Not found", `No team matching "${q}". Try the full club name.`);
    return;
  }

  resultsEl.innerHTML = teams.slice(0, 5).map((t) => `
    <div class="card match-row">
      <div>
        <div class="match-teams">${escapeHtml(t.strTeam)}</div>
        <div class="match-meta">${escapeHtml(t.strLeague || t.strSport || "")}</div>
      </div>
      <button class="btn-outline" data-follow="${t.idTeam}">Follow</button>
    </div>
  `).join("");

  resultsEl.querySelectorAll("[data-follow]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const team = teams.find((t) => t.idTeam === btn.getAttribute("data-follow"));
      if (!team) return;
      await addFollow(team);
      renderMe();
      refreshTicker();
      if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
    });
  });
}

// Daily rotating trivia — same bank/logic as the Telegram bot, so both
// surfaces show the same question on a given day.
const TRIVIA_QUESTIONS = [
  ["Which country has won the most FIFA World Cups?", "Brazil (5 titles)"],
  ["Which NBA team has won the most championships?", "Boston Celtics (18 titles)"],
  ["How many players are on a rugby union team on the field?", "15"],
  ["Which country hosts the Wimbledon tennis championships?", "England (UK)"],
  ["What is the maximum score in a single frame of ten-pin bowling?", "300 (a perfect game)"],
  ["Which cyclist has won the most Tour de France titles?", "Tied at 5: Anquetil, Merckx, Hinault, Indurain"],
  ["In football, how long is a standard match (excluding stoppage time)?", "90 minutes"],
  ["Which country invented the sport of cricket?", "England"],
  ["How many rings are on the Olympic flag?", "5"],
  ["Which boxer was known as 'The Greatest'?", "Muhammad Ali"],
];

function dayOfYearIndex(len) {
  const start = new Date(new Date().getFullYear(), 0, 0);
  const diff = new Date() - start;
  const dayOfYear = Math.floor(diff / (1000 * 60 * 60 * 24));
  return dayOfYear % len;
}

function renderTrivia() {
  const idx = dayOfYearIndex(TRIVIA_QUESTIONS.length);
  const [question, answer] = TRIVIA_QUESTIONS[idx];
  const card = document.getElementById("triviaCard");
  if (!card) return;

  card.innerHTML = `
    <div class="trivia-q">${escapeHtml(question)}</div>
    <button class="btn-outline" id="revealBtn">Reveal answer</button>
    <div class="trivia-a" id="triviaAnswer" style="display:none;">${escapeHtml(answer)}</div>
  `;
  document.getElementById("revealBtn").addEventListener("click", () => {
    document.getElementById("triviaAnswer").style.display = "block";
  });
}

// ---------------------------------------------------------------------
// Tab wiring
// ---------------------------------------------------------------------
const SCREENS = {
  today: renderToday,
  live: renderLive,
  table: renderTable,
  news: renderNews,
  me: renderMe,
};

function setActiveTab(name) {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-tab") === name);
  });
}

function wireTabs() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.getAttribute("data-tab");
      setActiveTab(name);
      SCREENS[name]();
      if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred("light");
    });
  });
}

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------
(function init() {
  initTelegram();
  wireTabs();
  renderToday();
  refreshTicker();
})();
