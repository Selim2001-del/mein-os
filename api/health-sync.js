// Empfängt Tageswerte vom Fitness-Band (Xiaomi Smart Band -> Mi Fitness -> Apple Health -> iOS-Kurzbefehl).
// Der Kurzbefehl schickt einmal am Abend (oder beliebig oft) ein JSON wie:
//   { "password": "...", "steps": 8432, "active_kcal": 512, "resting_hr": 61, "sleep_hours": 7.2 }
// Ein Eintrag pro Tag, späterer Sync überschreibt den früheren. Felder sind alle optional.

module.exports = async (req, res) => {
  if (req.method === "GET") return res.status(200).json({ ok: true, hint: "POST mit JSON senden" });
  if (req.method !== "POST") return res.status(405).json({ error: "Nur POST erlaubt" });

  let body = req.body || {};
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }

  const password = body.password || req.headers["x-password"] || (req.query && req.query.key);
  if (!password || String(password).trim() !== process.env.DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: "Falsches Passwort" });
  }

  try {
    // Format der App "Health Auto Export" (REST-API-Automation): mehrere Tage + Kennzahlen auf einmal
    if (body.data && Array.isArray(body.data.metrics)) {
      const days = fromHealthAutoExport(body.data.metrics);
      const dates = Object.keys(days);
      for (const d of dates) await upsertDay({ logged_at: d, ...days[d] });
      return res.status(200).json({ ok: true, message: `Operator: ${dates.length} Tag(e) gespeichert`, days: dates });
    }

    const date = parseDate(body.date) || berlinToday();
    const row = { logged_at: date, updated_at: new Date().toISOString(), source: "apple_health" };

    const steps = parseNum(body.steps);
    const activeKcal = parseNum(body.active_kcal ?? body.kcal ?? body.calories);
    const restingHr = parseNum(body.resting_hr ?? body.ruhepuls);
    const avgHr = parseNum(body.avg_hr ?? body.puls);
    let sleep = parseNum(body.sleep_hours ?? body.schlaf);
    const sleepMin = parseNum(body.sleep_minutes);
    if (sleep == null && sleepMin != null) sleep = sleepMin / 60;
    if (sleep != null && sleep > 24) sleep = sleep / 60; // Minuten statt Stunden geschickt
    const distance = parseNum(body.distance_km ?? body.distanz);

    if (steps != null) row.steps = Math.round(steps);
    if (activeKcal != null) row.active_kcal = Math.round(activeKcal);
    if (restingHr != null) row.resting_hr = Math.round(restingHr);
    if (avgHr != null) row.avg_hr = Math.round(avgHr);
    if (sleep != null) row.sleep_hours = Math.round(sleep * 10) / 10;
    if (distance != null) row.distance_km = Math.round(distance * 100) / 100;

    const saved = await upsertDay(row);

    const parts = [];
    if (saved.steps != null) parts.push(`${Number(saved.steps).toLocaleString("de-DE")} Schritte`);
    if (saved.active_kcal != null) parts.push(`${saved.active_kcal} kcal aktiv`);
    if (saved.resting_hr != null) parts.push(`Ruhepuls ${saved.resting_hr}`);
    if (saved.sleep_hours != null) parts.push(`${String(saved.sleep_hours).replace(".", ",")} h Schlaf`);
    return res.status(200).json({ ok: true, message: `Operator: ${parts.join(" · ") || "gespeichert"}`, saved });
  } catch (err) {
    console.error("Fehler beim Health-Sync:", err);
    return res.status(500).json({ error: err.message });
  }
};

async function upsertDay(row) {
  const saveRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/health_daily?on_conflict=logged_at`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify({ source: "apple_health", ...row, updated_at: new Date().toISOString() }),
  });
  if (!saveRes.ok) throw new Error(`Supabase-Fehler (${saveRes.status}): ${await saveRes.text()}`);
  return (await saveRes.json())[0] || row;
}

// Health Auto Export: metrics = [{ name, units, data: [{ date, qty | totalSleep | asleep | Avg }] }]
function fromHealthAutoExport(metrics) {
  const days = {};
  const add = (date, key, val, mode) => {
    if (!date || val == null || !isFinite(val)) return;
    const d = parseDate(String(date));
    if (!d) return;
    days[d] = days[d] || {};
    const cur = days[d][key];
    if (mode === "sum") days[d][key] = (cur || 0) + val;
    else if (mode === "avg") { days[d]["_" + key] = (days[d]["_" + key] || []).concat(val); }
    else days[d][key] = val;
  };
  for (const m of metrics) {
    const name = String(m.name || "").toLowerCase();
    const kj = /kj/i.test(m.units || "");
    for (const p of m.data || []) {
      const q = parseNum(p.qty ?? p.Avg ?? p.avg);
      if (name === "step_count") add(p.date, "steps", q, "sum");
      else if (name === "active_energy") add(p.date, "active_kcal", q != null && kj ? q / 4.184 : q, "sum");
      else if (name === "resting_heart_rate") add(p.date, "resting_hr", q, "avg");
      else if (name === "heart_rate") add(p.date, "avg_hr", parseNum(p.Avg ?? p.avg ?? p.qty), "avg");
      else if (name === "walking_running_distance") add(p.date, "distance_km", q != null && /mi/i.test(m.units || "") ? q * 1.609 : q, "sum");
      else if (name === "sleep_analysis") {
        const h = parseNum(p.totalSleep ?? p.asleep ?? p.qty);
        // Schlaf zählt für den Tag, an dem man aufwacht
        add(p.sleepEnd || p.date, "sleep_hours", h, "set");
      }
    }
  }
  for (const d of Object.keys(days)) {
    const r = days[d];
    for (const k of Object.keys(r)) {
      if (k.startsWith("_")) { const arr = r[k]; r[k.slice(1)] = arr.reduce((s, x) => s + x, 0) / arr.length; delete r[k]; }
    }
    for (const k of ["steps", "active_kcal", "resting_hr", "avg_hr"]) if (r[k] != null) r[k] = Math.round(r[k]);
    if (r.sleep_hours != null) r.sleep_hours = Math.round(r.sleep_hours * 10) / 10;
    if (r.distance_km != null) r.distance_km = Math.round(r.distance_km * 100) / 100;
  }
  return days;
}

// Zahlen aus Kurzbefehlen kommen evtl. als Text mit deutschem Format ("8.432", "7,5", "61 BPM")
function parseNum(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  let s = String(v).trim().replace(/[^\d.,-]/g, "");
  if (!s) return null;
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  else s = s.replace(",", ".");
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

function parseDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
  if (m) return `${m[3].length === 2 ? "20" + m[3] : m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

function berlinToday() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
}
