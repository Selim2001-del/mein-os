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
      completedTasks,
      nutritionHistory,
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
      expenseBudgets,
    ] = await Promise.all([
      sb("tasks?done=eq.false&order=created_at.desc&limit=50"),
      sb("tasks?done=eq.true&select=id&limit=500"),
      sb(`nutrition_log?logged_at=gte.${daysAgoIso(60)}&order=logged_at.desc&limit=1000`),
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
      sb("finance_snapshots?order=logged_at.desc&limit=30"),
      sb("expense_budgets"),
    ]);

    const todayStr = new Date().toISOString().split("T")[0];
    const nutritionTodayCount = nutritionHistory.filter((n) => (n.logged_at || "").startsWith(todayStr)).length;

    const xp = computeXp({ debts, bodyMetrics, workouts, personalityCheckins, nutritionTodayCount, journalEntries, completedTasks });
    const { level, xpIntoLevel } = computeLevel(xp);

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
      nutritionHistory,
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
      financeSnapshots,
      expenseBudgets,
    });
  } catch (err) {
    console.error("Fehler beim Laden der Dashboard-Daten:", err);
    res.status(500).json({ error: err.message });
  }
};

function computeXp({ debts, bodyMetrics, workouts, personalityCheckins, nutritionTodayCount, journalEntries, completedTasks }) {
  // Echter Fortschritt zählt viel mehr als reines Loggen.

  // Schulden abbauen: 1 XP pro 5€ tatsächlich abbezahlt (über alle Schulden hinweg)
  const debtXp = (debts || []).reduce((sum, d) => {
    const paid = Number(d.original_betrag || 0) - Number(d.restbetrag || 0);
    return sum + Math.max(0, paid) / 5;
  }, 0);

  // Körperfett-Fortschritt: 15 XP pro Prozentpunkt Körperfett-Reduktion seit dem ersten Foto/Eintrag
  const bmSorted = [...(bodyMetrics || [])]
    .filter((b) => b.body_fat_percent)
    .sort((a, b) => new Date(a.logged_at) - new Date(b.logged_at));
  let bodyProgressXp = 0;
  if (bmSorted.length >= 2) {
    const first = bmSorted[0].body_fat_percent;
    const last = bmSorted[bmSorted.length - 1].body_fat_percent;
    bodyProgressXp = Math.max(0, first - last) * 15;
  }

  // Reines Loggen/Alltagsaktivität: klein gehalten, damit es nicht dominiert
  const loggingXp =
    (workouts || []).length * 3 +
    (personalityCheckins || []).length * 2 +
    (nutritionTodayCount || 0) * 1 +
    (completedTasks || []).length * 1 +
    (journalEntries || []).length * 2;

  return Math.round(debtXp + bodyProgressXp + loggingXp);
}

function computeLevel(xp) {
  // Wachsende Kurve statt linear - jedes Level braucht mehr XP als das vorherige,
  // damit man nicht innerhalb einer Woche "Level 100" erreicht.
  const level = Math.floor(Math.sqrt(xp / 20)) + 1;
  const currentLevelBaseXp = 20 * Math.pow(level - 1, 2);
  const nextLevelXp = 20 * Math.pow(level, 2);
  const span = nextLevelXp - currentLevelBaseXp;
  const xpIntoLevel = span > 0 ? Math.round(((xp - currentLevelBaseXp) / span) * 100) : 100;
  return { level, xpIntoLevel };
}

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

function daysAgoIso(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
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
