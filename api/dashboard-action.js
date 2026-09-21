// Nimmt Aktionen vom Dashboard entgegen (z.B. eine Aufgabe abhaken), geschützt durchs selbe Passwort.

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Nur POST erlaubt" });
  }

  const { password, action, taskId } = req.body || {};
  if (!password || password !== process.env.DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: "Falsches Passwort" });
  }

  try {
    if (action === "complete_task") {
      if (!taskId) return res.status(400).json({ error: "taskId fehlt" });

      const patchRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/tasks?id=eq.${taskId}`, {
        method: "PATCH",
        headers: {
          apikey: process.env.SUPABASE_SECRET_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ done: true }),
      });
      if (!patchRes.ok) throw new Error(`Supabase-Fehler (${patchRes.status}): ${await patchRes.text()}`);

      return res.status(200).json({ success: true });
    }

    if (action === "toggle_training_day") {
      const { date } = req.body;
      if (!date) return res.status(400).json({ error: "date fehlt" });

      const checkRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/training_days?logged_at=eq.${date}`, {
        headers: {
          apikey: process.env.SUPABASE_SECRET_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
        },
      });
      const existing = checkRes.ok ? await checkRes.json() : [];

      if (existing.length > 0) {
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/training_days?logged_at=eq.${date}`, {
          method: "DELETE",
          headers: {
            apikey: process.env.SUPABASE_SECRET_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
          },
        });
        return res.status(200).json({ success: true, trained: false });
      } else {
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/training_days`, {
          method: "POST",
          headers: {
            apikey: process.env.SUPABASE_SECRET_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ logged_at: date }),
        });
        return res.status(200).json({ success: true, trained: true });
      }
    }

    return res.status(400).json({ error: "Unbekannte Aktion" });
  } catch (err) {
    console.error("Fehler bei Dashboard-Aktion:", err);
    res.status(500).json({ error: err.message });
  }
};
