// Ablauf: Sprachnachricht -> Whisper (Text) -> Claude entscheidet: LOGGEN oder FRAGE?
// -> Loggen: in die richtige Tabelle einsortieren (inkl. Charaktereigenschaften, Trainingsplan)
// -> Frage: relevante Daten aus Supabase holen, Claude lässt daraus eine Antwort formulieren

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

    // 3. Claude: in einzelne Aktionen zerlegen (Logs, Fragen, Sonderaktionen)
    const actions = await classifyWithClaude(transcript);

    const results = [];

    for (const action of actions) {
      try {
        if (action.type === "insert") {
          // Normaler Eintrag in eine der einfachen Tabellen
          await saveToSupabase(action.table, action.data);
          results.push(`✅ Gespeichert in "${action.table}"`);
        } else if (action.type === "trait_new") {
          // Neue Charaktereigenschaft anlegen (nur falls noch nicht vorhanden)
          await ensureTraitExists(action.name, action.is_flaw);
          results.push(`✅ Neue Eigenschaft angelegt: "${action.name}"`);
        } else if (action.type === "trait_checkin") {
          // Tägliche Bewertung einer Eigenschaft (legt sie an, falls sie noch nicht existiert)
          const traitId = await ensureTraitExists(action.trait_name, false);
          await saveToSupabase("personality_checkins", {
            trait_id: traitId,
            note: action.note,
            notes: action.notes || null,
          });
          results.push(`✅ Check-in "${action.trait_name}": Note ${action.note}`);
        } else if (action.type === "generate_plan") {
          // Kompletten Trainingsplan neu erstellen lassen
          const planText = await generateTrainingPlan();
          await deactivateOldPlans();
          await saveToSupabase("training_plan", { plan_text: planText, active: true });
          results.push(`✅ Neuer Trainingsplan erstellt`);
        } else if (action.type === "question") {
          // Frage beantworten: relevante Daten holen, Claude antworten lassen
          const answer = await answerQuestion(action.text, action.relevant_tables);
          await sendTelegramMessage(chatId, `💬 ${answer}`);
          results.push(`✅ Frage beantwortet: "${action.text}"`);
        }
      } catch (err) {
        console.error(`Fehler bei Aktion ${JSON.stringify(action)}:`, err);
        results.push(`❌ Fehler: ${err.message}`);
      }
    }

    await sendTelegramMessage(chatId, results.join("\n"));

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

// ---------- Telegram / Whisper Hilfsfunktionen ----------

async function downloadTelegramVoice(fileId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const fileInfoRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
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
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: formData,
  });
  const data = await res.json();
  return data.text;
}

async function sendTelegramMessage(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

// ---------- Claude: Klassifizierung ----------

async function callClaude(system, userMessage, maxTokens = 1000, model = "claude-haiku-4-5-20251001") {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userMessage }],
    }),
  });
  const data = await res.json();
  return data.content[0].text;
}

function parseJson(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned);
}

async function classifyWithClaude(transcript) {
  const systemPrompt = `Du bekommst eine gesprochene Notiz einer Person. Sie kann mehrere unabhängige Teile enthalten: neue Fakten zum Speichern, Fragen zu bisherigen Daten, oder Sonderbefehle.

Zerlege die Notiz in einzelne Aktionen. Jede Aktion hat ein "type"-Feld:

1. "insert" - ein normaler Fakt für eine dieser Tabellen:
   - tasks: title, category, priority, due_date
   - nutrition_log: description, calories, protein_g
   - nutrition_goals: daily_calorie_target, daily_protein_target
   - workouts: exercise, sets, reps, weight_kg, notes
   - body_metrics: weight_kg, body_fat_percent
   - training_goals: target_weight_kg, target_body_fat_percent, target_date, notes
   - expenses: amount, category, description
   - fixed_costs: name, betrag, rhythmus, kategorie
   - debts: name, restbetrag, monatliche_rate, zinssatz
   - finance_goals: title, target_amount, target_date
   - finance_snapshots: liquide_mittel, ruecklagen, vermoegen_gesamt
   - journal_entries: raw_text, summary, mood
   Format: {"type":"insert","table":"...","data":{...}}

2. "trait_new" - die Person will eine NEUE Charaktereigenschaft/einen Flaw anlegen (z.B. "neue Eigenschaft: Prokrastination"):
   Format: {"type":"trait_new","name":"...","is_flaw":true}

3. "trait_checkin" - die Person bewertet eine Charaktereigenschaft mit einer Schulnote (1=sehr gut, 6=ungenügend):
   Format: {"type":"trait_checkin","trait_name":"...","note":1-6,"notes":"optionaler Kontext"}

4. "generate_plan" - die Person bittet ausdrücklich darum, einen (neuen) Trainingsplan zu erstellen/anzupassen:
   Format: {"type":"generate_plan"}

5. "question" - die Person stellt eine Frage zu ihren bisherigen Daten (z.B. "wie viel hab ich für Lebensmittel ausgegeben", "wie war mein Trainingsfortschritt"):
   Format: {"type":"question","text":"die Frage","relevant_tables":["expenses"]}
   Wähle bei relevant_tables die 1-3 Tabellen aus der Liste oben, die am ehesten die Antwort enthalten.

Antworte NUR mit einem validen JSON-ARRAY dieser Aktionen, ohne Erklärung, ohne Markdown-Codeblock. Wenn nur EIN Teil erkannt wird, trotzdem ein Array mit einem Element zurückgeben.

Wenn du unsicher bist oder es eine freie Reflexion ist, nutze "insert" mit table "journal_entries".

WICHTIG: Wenn die Person mehrere Eigenschaften mit "Note X" nennt (Schulnoten-Bewertung, z.B. "Verantwortung heute Note 3, Präsenz Note 2"), ist das IMMER "trait_checkin" pro genanntem Namen, NIEMALS journal_entries - auch wenn keine weitere Erklärung dabei ist. Ein Name + eine Zahl 1-6 nacheinander = ein Check-in.

Beispiel:
Eingabe: "Verantwortung heute Note 3, Rechtfertigen Note 5, Präsenz Note 2"
Ausgabe: [{"type":"trait_checkin","trait_name":"Verantwortung","note":3,"notes":null},{"type":"trait_checkin","trait_name":"Rechtfertigen","note":5,"notes":null},{"type":"trait_checkin","trait_name":"Präsenz","note":2,"notes":null}]`;

  const text = await callClaude(systemPrompt, transcript, 1500, "claude-sonnet-5");
  const parsed = parseJson(text);
  const actions = Array.isArray(parsed) ? parsed : [parsed];
  console.log("Klassifiziert als:", JSON.stringify(actions));
  return actions;
}

// ---------- Charaktereigenschaften ----------

async function ensureTraitExists(name, isFlaw) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/personality_traits?name=ilike.${encodeURIComponent(name)}`;
  const res = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
    },
  });
  const existing = await res.json();

  if (existing && existing.length > 0) {
    return existing[0].id;
  }

  // Noch nicht vorhanden -> neu anlegen
  const insertRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/personality_traits`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({ name, is_flaw: isFlaw }),
  });

  if (!insertRes.ok) {
    const errorText = await insertRes.text();
    throw new Error(`Supabase-Fehler beim Anlegen der Eigenschaft (${insertRes.status}): ${errorText}`);
  }

  const inserted = await insertRes.json();
  return inserted[0].id;
}

// ---------- Trainingsplan erstellen ----------

async function fetchRecent(table, limit = 20) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${table}?limit=${limit}`;
  const res = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
    },
  });
  if (!res.ok) return [];
  return res.json();
}

async function generateTrainingPlan() {
  const workouts = await fetchRecent("workouts", 20);
  const bodyMetrics = await fetchRecent("body_metrics", 5);
  const goals = await fetchRecent("training_goals", 1);

  const context = `Bisherige Workouts (neueste zuerst): ${JSON.stringify(workouts)}
Körperwerte-Verlauf: ${JSON.stringify(bodyMetrics)}
Trainingsziele: ${JSON.stringify(goals)}`;

  const systemPrompt = `Du bist ein erfahrener Personal Trainer. Erstelle basierend auf den Trainingsdaten, Körperwerten und Zielen der Person einen konkreten, strukturierten Trainingsplan (z.B. nach Wochentagen, mit Übungen, Sätzen, Wiederholungen). Falls noch keine Daten vorhanden sind, erstelle einen sinnvollen Einsteiger-Plan und weise darauf hin, dass er sich mit mehr Daten verbessern wird. Antworte NUR mit dem Plan als lesbarem Text, keine Erklärungen drumherum.`;

  return await callClaude(systemPrompt, context, 2000);
}

async function deactivateOldPlans() {
  const url = `${process.env.SUPABASE_URL}/rest/v1/training_plan?active=eq.true`;
  await fetch(url, {
    method: "PATCH",
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ active: false }),
  });
}

// ---------- Fragen beantworten ----------

async function answerQuestion(question, relevantTables) {
  let context = "";
  for (const table of relevantTables) {
    const rows = await fetchRecent(table, 50);
    context += `\n\nDaten aus "${table}":\n${JSON.stringify(rows)}`;
  }

  const systemPrompt = `Du bist ein persönlicher Assistent. Beantworte die Frage der Person basierend AUSSCHLIESSLICH auf den mitgelieferten Daten. Sei kurz und konkret (2-4 Sätze). Falls die Daten nicht ausreichen, um die Frage zu beantworten, sag das ehrlich.`;

  return await callClaude(systemPrompt, `Frage: ${question}${context}`, 500);
}

// ---------- Supabase: Speichern ----------

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
