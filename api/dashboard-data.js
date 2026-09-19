// Liefert alle Daten fürs Dashboard, geschützt durch ein einfaches Passwort.
// Der Supabase Secret Key bleibt hier im Backend - taucht nie im Browser auf.

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Nur POST erlaubt" });
  }

  const { password } = req.body || {};
  if (!password || password !== process.env.DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: "Falsches Passwort" });
  }

  try {
    const [
      tasks,
      nutritionToday,
      nutritionGoals,
      workouts,
      bodyMetrics,
      trainingGoals,
      trainingPlan,
      personalityTraits,
      personalityCheckins,
      journalEntries,
      fixedCosts,
      debts,
      income,
      expenses,
      financeGoals,
      financeSnapshots,
    ] = await Promise.all([
      sb("tasks?done=eq.false&order=created_at.desc&limit=50"),
      sb(`nutrition_log?logged_at=gte.${todayStartIso()}`),
      sb("nutrition_goals?order=updated_at.desc&limit=1"),
      sb("workouts?order=logged_at.desc&limit=100"),
      sb("body_metrics?order=logged_at.desc&limit=50"),
      sb("training_goals?order=updated_at.desc&limit=5"),
      sb("training_plan?active=eq.true&limit=1"),
      sb("personality_traits?active=eq.true"),
      sb("personality_checkins?select=note,logged_at,trait_id,personality_traits(name)&order=logged_at.desc&limit=200"),
      sb("journal_entries?order=created_at.desc&limit=30"),
      sb("fixed_costs"),
      sb("debts"),
      sb(`income?logged_at=gte.${monthStartIso()}`),
      sb(`expenses?logged_at=gte.${monthStartIso()}`),
      sb("finance_goals"),
      sb("finance_snapshots?order=logged_at.desc&limit=1"),
    ]);

    const xp =
      workouts.length * 10 +
      personalityCheckins.length * 5 +
      nutritionToday.length * 2 +
      journalEntries.length * 3;
    const level = Math.floor(xp / 100) + 1;
    const xpIntoLevel = xp % 100;

    // Check-in-Streak: aufeinanderfolgende Tage mit mind. 1 Check-in
    const checkinDates = [...new Set(personalityCheckins.map((c) => c.logged_at))].sort().reverse();
    let streak = 0;
    let cursor = new Date();
    for (const d of checkinDates) {
      const dateStr = cursor.toISOString().split("T")[0];
      if (d === dateStr) {
        streak++;
        cursor.setDate(cursor.getDate() - 1);
      } else break;
    }

    res.status(200).json({
      xp,
      level,
      xpIntoLevel,
      streak,
      tasks,
      nutritionToday,
      nutritionGoals: nutritionGoals[0] || null,
      workouts,
      bodyMetrics,
      trainingGoals,
      trainingPlan: trainingPlan[0] || null,
      personalityTraits,
      personalityCheckins,
      journalEntries,
      fixedCosts,
      debts,
      income,
      expenses,
      financeGoals,
      financeSnapshots: financeSnapshots[0] || null,
    });
  } catch (err) {
    console.error("Fehler beim Laden der Dashboard-Daten:", err);
    res.status(500).json({ error: err.message });
  }
};

async function sb(pathAndQuery) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${pathAndQuery}`;
  const res = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
    },
  });
  if (!res.ok) {
    console.error(`Supabase-Fehler bei ${pathAndQuery}:`, await res.text());
    return [];
  }
  return res.json();
}

function todayStartIso() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function monthStartIso() {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}
