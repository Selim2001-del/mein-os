// Mikrofon/Chat im Dashboard: nimmt Audio oder Text entgegen, verarbeitet es mit derselben
// Logik wie der Telegram-Bot und liefert die Antworten zurück. Geschützt durchs Dashboard-Passwort.
// Der Chatverlauf liegt in der Supabase-Tabelle chat_messages.

const { processWebMessage } = require("./telegram-webhook.js");

const MAX_AUDIO_BASE64 = 4_000_000; // ca. 3 MB Audio, reicht für mehrere Minuten Sprache

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Nur POST erlaubt" });
  }

  const { password, action, audio, mime, text } = req.body || {};
  if (!password || password !== process.env.DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: "Falsches Passwort" });
  }

  try {
    if (action === "history") {
      const rows = await sb("chat_messages?select=id,created_at,role,text,source&order=created_at.desc&limit=150");
      return res.status(200).json({ messages: rows.reverse() });
    }

    let input;
    if (audio) {
      if (typeof audio !== "string" || audio.length > MAX_AUDIO_BASE64) {
        return res.status(413).json({ error: "Aufnahme zu lang. Bitte kürzer sprechen." });
      }
      const ext = /mp4|m4a|aac/i.test(mime || "") ? "mp4" : /ogg/i.test(mime || "") ? "ogg" : /wav/i.test(mime || "") ? "wav" : "webm";
      input = { audioBuffer: Buffer.from(audio, "base64"), filename: "voice." + ext };
    } else if (typeof text === "string" && text.trim()) {
      input = { text: text.trim().slice(0, 4000) };
    } else {
      return res.status(400).json({ error: "Weder Audio noch Text erhalten" });
    }

    const { transcript, replies } = await processWebMessage(input);
    const reply = replies.join("\n\n") || "Erledigt.";

    // Verlauf speichern (Fehler hier sollen die Antwort nicht verhindern)
    const now = Date.now();
    await saveMessages([
      { role: "user", text: transcript, created_at: new Date(now).toISOString() },
      { role: "assistant", text: reply, created_at: new Date(now + 1).toISOString() },
    ]);

    return res.status(200).json({ transcript, reply });
  } catch (err) {
    console.error("Fehler in /api/voice:", err);
    return res.status(500).json({ error: err.message || "Unbekannter Fehler" });
  }
};

async function sb(pathAndQuery) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
    },
  });
  if (!r.ok) {
    console.error(`Supabase-Fehler bei ${pathAndQuery}:`, await r.text());
    return [];
  }
  return r.json();
}

async function saveMessages(rows) {
  try {
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/chat_messages`, {
      method: "POST",
      headers: {
        apikey: process.env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(rows),
    });
    if (!r.ok) console.error("Chatverlauf konnte nicht gespeichert werden:", await r.text());
  } catch (err) {
    console.error("Chatverlauf konnte nicht gespeichert werden:", err);
  }
}
