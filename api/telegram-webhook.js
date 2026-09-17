// Diese Funktion wird jedes Mal aufgerufen, wenn dein Telegram-Bot eine Nachricht bekommt.
// Ablauf: Sprachnachricht -> Whisper (Text) -> Claude (kann MEHRERE Einträge erkennen) -> Supabase (speichern) -> Bestätigung an dich

module.exports = async (req, res) => {
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

    if (!message.voice) {
      await sendTelegramMessage(chatId, "Schick mir bitte eine Sprachnachricht 🎙️");
      return res.status(200).send("OK");
    }

    // 1. Sprachdatei von Telegram herunterladen
    const audioBuffer = await downloadTelegramVoice(message.voice.file_id);

    // 2. Whisper: Sprache -> Text
    const transcript = await transcribeAudio(audioBuffer);

    // 3. Claude: Text -> Liste von Einträgen (auch wenn nur 1 erwähnt wird, kommt ein Array zurück)
    const entries = await classifyWithClaude(transcript);

    // 4. Jeden einzelnen Eintrag in Supabase speichern, Erfolge/Fehler mitzählen
    const results = [];
    for (const entry of entries) {
      try {
        await saveToSupabase(entry.table, entry.data);
        results.push(`✅ ${entry.table}`);
      } catch (err) {
        console.error(`Fehler beim Speichern in ${entry.table}:`, err);
        results.push(`❌ ${entry.table} (${err.message})`);
      }
    }

    // 5. Zusammenfassung an dich schicken
    await sendTelegramMessage(chatId, `Verarbeitet (${entries.length} Einträge):\n${results.join("\n")}`);

    return res.status(200).send("OK");
  } catch (err) {
    console.error("Fehler im Webhook:", err);

    try {
      const chatId = req.body?.message?.chat?.id;
      if (chatId) {
        await sendTelegramMessage(chatId, `❌ Fehler beim Verarbeiten: ${err.message}`);
      }
    } catch (notifyErr) {
      console.error("Konnte Fehler-Nachricht nicht senden:", notifyErr);
    }

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
  const systemPrompt = `Du bekommst eine gesprochene Notiz einer Person. Sie kann EINEN oder MEHRERE unabhängige Fakten enthalten (z.B. eine Aufgabe UND eine Ausgabe UND ein Workout in derselben Nachricht).

Deine Aufgabe: Zerlege die Notiz in einzelne Einträge und entscheide für JEDEN, in welche Tabelle er gehört.

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

Antworte NUR mit einem validen JSON-ARRAY, ohne Erklärung, ohne Markdown-Codeblock. Auch wenn die Notiz nur EINEN Fakt enthält, muss trotzdem ein Array mit einem Element zurückkommen. Format:

[
  {"table": "tabellenname", "data": { ...felder... }},
  {"table": "tabellenname", "data": { ...felder... }}
]

Wenn du bei einem Teil unsicher bist oder es eine freie Reflexion/ein Gedanke ist, nutze "journal_entries" mit raw_text (der Originaltext dieses Teils), einer kurzen summary und mood (z.B. "belastet", "neutral", "gut").`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: "user", content: transcript }],
    }),
  });

  const data = await res.json();
  const text = data.content[0].text;
  const cleaned = text.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(cleaned);

  // Falls Claude doch nur ein einzelnes Objekt statt eines Arrays zurückgibt, absichern
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function saveToSupabase(table, data) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${table}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Supabase-Fehler (${res.status}): ${errorText}`);
  }
}

async function sendTelegramMessage(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}
