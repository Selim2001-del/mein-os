// Wird einmal täglich von Vercel Cron aufgerufen (siehe vercel.json).
// Prüft selbst, ob heute eine Erinnerung fällig ist - Sonntag = Gewicht, 1. des Monats = Foto.

module.exports = async (req, res) => {
  // Sicherheits-Check: nur echte Vercel-Cron-Aufrufe akzeptieren
  const authHeader = req.headers["authorization"];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).send("Unauthorized");
  }

  try {
    const chatId = await getSavedChatId();
    if (!chatId) {
      console.log("Keine Chat-ID gespeichert, noch keine Nachricht vom Nutzer erhalten.");
      return res.status(200).send("Keine Chat-ID vorhanden");
    }

    const now = new Date();
    const dayOfWeek = now.getUTCDay(); // 0 = Sonntag
    const dayOfMonth = now.getUTCDate();

    if (dayOfWeek === 0) {
      await sendTelegramMessage(chatId, "📅 Zeit für dein wöchentliches Gewicht! Wie viel wiegst du heute?");
    }

    if (dayOfMonth === 1) {
      await sendTelegramMessage(
        chatId,
        "📸 Zeit für dein monatliches Fortschrittsfoto! Schick eins hoch, sobald du kannst (Hinweis: die automatische Auswertung von Fotos ist noch nicht angebunden - das kommt als eigener Baustein)."
      );
    }

    return res.status(200).send("OK");
  } catch (err) {
    console.error("Fehler im täglichen Check:", err);
    return res.status(200).send("Fehler wurde geloggt");
  }
};

async function getSavedChatId() {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/bot_settings?id=eq.1`, {
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
    },
  });
  const rows = await res.json();
  return rows && rows[0] ? rows[0].chat_id : null;
}

async function sendTelegramMessage(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}
