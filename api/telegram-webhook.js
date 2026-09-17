// Diese Funktion wird jedes Mal aufgerufen, wenn dein Telegram-Bot eine Nachricht bekommt.
// Ablauf: Sprachnachricht -> Whisper (Text) -> Claude (Kategorie + Daten) -> Supabase (speichern) -> Bestätigung an dich

module.exports = async (req, res) => {
  // Telegram schickt nur POST-Anfragen. Alles andere ignorieren wir einfach.
  if (req.method !== "POST") {
    return res.status(200).send("OK");
  }

  try {
    const update = req.body;
    const message = update.message;

    if (!message) {
      return res.status(200).send("Kein Message-Objekt");
    }

    const chatId = message.chat.id;

    // Falls es keine Sprachnachricht ist, kurz Bescheid geben und aufhören
    if (!message.voice) {
      await sendTelegramMessage(chatId, "Schick mir bitte eine Sprachnachricht 🎙️");
      return res.status(200).send("OK");
    }

    // 1. Sprachdatei von Telegram herunterladen
    const audioBuffer = await downloadTelegramVoice(message.voice.file_id);

    // 2. Whisper: Sprache -> Text
    const transcript = await transcribeAudio(audioBuffer);

    // 3. Claude: Text -> welche Tabelle + welche Daten
    const classification = await classifyWithClaude(transcript);

    // 4. In Supabase speichern
    await saveToSupabase(classification.table, classification.data);

    // 5. Dir eine Bestätigung schicken
    await sendTelegramMessage(
      chatId,
      `✅ Gespeichert in "${classification.table}":\n"${transcript}"`
    );

    return res.status(200).send("OK");
  } catch (err) {
    // Fehler landen im Vercel-Log (Dashboard -> Logs), nicht als Absturz beim Nutzer
    console.error("Fehler im Webhook:", err);
    return res.status(200).send("Fehler wurde geloggt");
  }
};

// ---------- Hilfsfunktionen ----------

async function downloadTelegramVoice(fileId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  const fileInfoRes = await fetch(
    `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`
  );
  const fileInfo = await fileInfoRes.json();
  const filePath = fileInfo.result.file_path;

  const fileRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  const arrayBuffer = await fileRes.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function transcribeAudio(audioBuffer) {
  const formData = new FormData();
  formData.append("file", new Blob([audioBuffer]), "voice.ogg");
  formData.append("model", "whisper-1");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: formData,
  });

  const data = await res.json();
  return data.text;
}

async function classifyWithClaude(transcript) {
  const systemPrompt = `Du bekommst eine gesprochene Notiz einer Person. Entscheide, in welche Tabelle sie am besten passt und extrahiere die passenden Felder als JSON.

Verfügbare Tabellen und Felder:
- tasks: title, category, priority, due_date
- nutrition_log: description, calories, protein_g
- workouts: exercise, sets, reps, weight_kg, notes
- body_metrics: weight_kg, body_fat_percent
- expenses: amount, category, description
- fixed_costs: name, betrag, rhythmus, kategorie
- debts: name, restbetrag, monatliche_rate, zinssatz
- finance_goals: title, target_amount, target_date
- finance_snapshots: liquide_mittel, ruecklagen, vermoegen_gesamt
- journal_entries: raw_text, summary, mood

Antworte NUR mit validem JSON, ohne Erklärung, ohne Markdown-Codeblock, in diesem Format:
{"table": "tabellenname", "data": { ...felder... }}

Wenn du unsicher bist oder es eine freie Reflexion/ein Gedanke ist, nutze "journal_entries" mit raw_text (Originaltext), einer kurzen summary und mood (z.B. "belastet", "neutral", "gut").`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      system: systemPrompt,
      messages: [{ role: "user", content: transcript }],
    }),
  });

  const data = await res.json();
  const text = data.content[0].text;
  // Falls Claude die Antwort in ```json ... ``` einpackt, das entfernen
  const cleaned = text.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned);
}

async function saveToSupabase(table, data) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${table}`;
  await fetch(url, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(data),
  });
}

async function sendTelegramMessage(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}
