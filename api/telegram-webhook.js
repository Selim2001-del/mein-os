// Ablauf: Sprachnachricht -> Whisper (Text) -> Claude entscheidet: LOGGEN, FRAGE, oder CHECK-IN-ABLAUF?

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
    await rememberChatId(chatId);

    if (!message.voice) {
      await sendTelegramMessage(chatId, "Schick mir bitte eine Sprachnachricht 🎙️");
      return res.status(200).send("OK");
    }

    // 1. Sprachdatei von Telegram herunterladen
    const audioBuffer = await downloadTelegramVoice(message.voice.file_id);

    // 2. Whisper: Sprache -> Text
    const transcript = await transcribeAudio(audioBuffer);

    // 3. Läuft gerade ein interaktiver Check-in? Nur eingreifen, wenn die Nachricht wirklich
    //    danach aussieht (kurz + enthält eine Note) oder ein Abbruch gewünscht ist.
    const activeSession = await getCheckinSession(chatId);
    if (activeSession) {
      const wordCount = transcript.trim().split(/\s+/).length;
      const wantsCancel = /abbrechen|stopp|stop|später|pause/i.test(transcript);

      if (wantsCancel) {
        await deleteCheckinSession(chatId);
        await sendTelegramMessage(chatId, "Check-in abgebrochen, kein Problem. Sag einfach wieder \"Check-in\" wenn du weitermachen willst.");
        return res.status(200).send("OK");
      }

      if (wordCount <= 6 && parseGermanNumber(transcript) !== null) {
        await handleCheckinAnswer(chatId, transcript, activeSession);
        return res.status(200).send("OK");
      }
      // Sonst: lange/komplexe Nachricht während einer offenen Session -> ignorieren und normal verarbeiten
    }

    // 4. Will die Person einen Check-in STARTEN?
    const wantsCheckup = /check-?in|checkup|kpis? durchgehen|eigenschaften durchgehen|flaws durchgehen/i.test(transcript);
    if (wantsCheckup) {
      await startCheckinSession(chatId);
      return res.status(200).send("OK");
    }

    // 5. Ansonsten: normale Klassifizierung (Loggen / Frage / Sonderaktionen)
    const actions = await classifyWithClaude(transcript);
    const results = [];

    for (const action of actions) {
      try {
        if (action.type === "insert") {
          if (action.table === "nutrition_log") {
            await refineNutritionWithSearch(action.data);
          }
          await saveToSupabase(action.table, action.data);
          results.push(`✅ Gespeichert in "${action.table}"`);

          if (action.table === "workouts" && action.data.exercise) {
            const feedback = await checkProgressionFeedback(action.data.exercise);
            if (feedback) results.push(`💪 ${feedback}`);
          }
          if (action.table === "body_metrics") {
            const feedback = await checkBodyProgressFeedback();
            if (feedback) results.push(`📊 ${feedback}`);
          }
          if (action.table === "nutrition_log") {
            const feedback = await checkNutritionFeedback();
            if (feedback) results.push(`🍽️ ${feedback}`);
          }
        } else if (action.type === "trait_new") {
          await ensureTraitExists(action.name, action.is_flaw);
          results.push(`✅ Neue Eigenschaft angelegt: "${action.name}"`);
        } else if (action.type === "trait_checkin") {
          const traitId = await ensureTraitExists(action.trait_name, false);
          await saveToSupabase("personality_checkins", {
            trait_id: traitId,
            note: action.note,
            notes: action.notes || null,
          });
          results.push(`✅ Check-in "${action.trait_name}": Note ${action.note}`);
        } else if (action.type === "generate_plan") {
          const planText = await generateTrainingPlan(action.constraints);
          await deactivateOldPlans();
          await saveToSupabase("training_plan", { plan_text: planText, active: true });
          results.push(`✅ Neuer Trainingsplan erstellt`);
        } else if (action.type === "question") {
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

// ---------- Claude Hilfsfunktionen ----------

async function callClaude(system, userMessage, maxTokens = 1000, model = "claude-haiku-4-5-20251001", tools = null) {
  const body = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: userMessage }],
  };
  if (tools) body.tools = tools;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(`Claude-API-Fehler (${res.status}): ${JSON.stringify(data)}`);
  }

  const textBlock = data.content && data.content.find((block) => block.type === "text");
  if (!textBlock) {
    throw new Error(`Claude-Antwort hatte keinen Text-Block: ${JSON.stringify(data)}`);
  }

  return textBlock.text;
}

function parseJson(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned);
}

async function classifyWithClaude(transcript) {
  const today = new Date().toISOString().split("T")[0];

  const systemPrompt = `Heutiges Datum: ${today}. Nutze das für alle relativen Datumsangaben (z.B. "Ende des Jahres", "in 3 Monaten").

Du bekommst eine gesprochene Notiz einer Person. Sie kann mehrere unabhängige Teile enthalten: neue Fakten zum Speichern, Fragen zu bisherigen Daten, oder Sonderbefehle.

Zerlege die Notiz in einzelne Aktionen. Jede Aktion hat ein "type"-Feld:

1. "insert" - ein normaler Fakt für eine dieser Tabellen:
   - tasks: title, category, priority, due_date
   - nutrition_log: description, calories, protein_g
     WICHTIG: Falls die Person keine genauen Zahlen nennt (z.B. nur "Hähnchen mit Reis gegessen"), schätze calories und protein_g SELBST anhand deines Ernährungswissens für eine typische Portion. Nenne IMMER eine Zahl, nie null/leer lassen.
   - nutrition_goals: daily_calorie_target, daily_protein_target
   - workouts: exercise, sets, reps, weight_kg, notes
   - body_metrics: weight_kg, body_fat_percent
   - training_goals: target_weight_kg, target_body_fat_percent, target_date, notes
   - expenses: amount, category, description
   - income: amount, source, description
   - fixed_costs: name, betrag, rhythmus, kategorie
   - debts: name, restbetrag, monatliche_rate, zinssatz
   - finance_goals: title, target_amount, target_date
   - finance_snapshots: liquide_mittel, ruecklagen, vermoegen_gesamt
   - journal_entries: raw_text, summary, mood
   Format: {"type":"insert","table":"...","data":{...}}

2. "trait_new" - die Person will eine NEUE Charaktereigenschaft/einen Flaw anlegen:
   Format: {"type":"trait_new","name":"...","is_flaw":true}

3. "trait_checkin" - die Person bewertet eine Charaktereigenschaft mit einer Schulnote (1=sehr gut, 6=ungenügend):
   Format: {"type":"trait_checkin","trait_name":"...","note":1-6,"notes":"optionaler Kontext"}

4. "generate_plan" - die Person bittet ausdrücklich darum, einen (neuen) Trainingsplan zu erstellen/anzupassen. Falls sie dabei einen konkreten Wunsch nennt (z.B. "nur 4 Tage die Woche", "mehr Fokus auf Beine"), diesen unter "constraints" mitgeben:
   Format: {"type":"generate_plan","constraints":"z.B. 4 Trainingstage pro Woche"}

5. "question" - die Person stellt eine Frage zu ihren bisherigen Daten (z.B. "wie viel hab ich für Lebensmittel ausgegeben", "was ist mein Trainingsplan für heute, ich mache Tag 1", "wie liefen meine Charaktereigenschaften diese Woche"):
   Format: {"type":"question","text":"die Frage","relevant_tables":["expenses"]}
   Zusätzlich zu den Tabellen oben stehen für relevant_tables auch "training_plan" (aktueller Trainingsplan als Text), "personality_traits" und "personality_checkins" (Charaktereigenschaften-Verlauf) zur Verfügung.

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

// ---------- Interaktiver Check-in-Ablauf ----------

async function getCheckinSession(chatId) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/personality_checkin_sessions?chat_id=eq.${chatId}`;
  const res = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
    },
  });
  const rows = await res.json();
  return rows && rows.length > 0 ? rows[0] : null;
}

async function saveCheckinSession(chatId, traitIds, currentIndex) {
  // Alte Session löschen, falls vorhanden, dann neu anlegen (einfacher als ein echtes Upsert)
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/personality_checkin_sessions?chat_id=eq.${chatId}`, {
    method: "DELETE",
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
    },
  });
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/personality_checkin_sessions`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ chat_id: chatId, trait_ids: traitIds, current_index: currentIndex }),
  });
}

async function deleteCheckinSession(chatId) {
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/personality_checkin_sessions?chat_id=eq.${chatId}`, {
    method: "DELETE",
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
    },
  });
}

async function getTraitById(id) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/personality_traits?id=eq.${id}`;
  const res = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
    },
  });
  const rows = await res.json();
  return rows[0];
}

function formatTraitQuestion(trait, position, total) {
  let msg = `(${position}/${total}) ${trait.name}`;
  if (trait.old_pattern) msg += `\nAltes Muster: ${trait.old_pattern}`;
  if (trait.new_behavior) msg += `\nNeues Verhalten: ${trait.new_behavior}`;
  msg += `\n\nWelche Note (1-6) für heute?`;
  return msg;
}

async function startCheckinSession(chatId) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/personality_traits?active=eq.true&select=id`;
  const res = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
    },
  });
  const traits = await res.json();

  if (!traits || traits.length === 0) {
    await sendTelegramMessage(chatId, "Du hast noch keine Charaktereigenschaften angelegt. Sag mir erstmal welche, z.B. \"Neue Eigenschaft: Prokrastination, ist ein Flaw\".");
    return;
  }

  const traitIds = traits.map((t) => t.id);
  await saveCheckinSession(chatId, traitIds, 0);

  const firstTrait = await getTraitById(traitIds[0]);
  await sendTelegramMessage(chatId, `Los geht's, ${traits.length} Eigenschaften:\n\n${formatTraitQuestion(firstTrait, 1, traits.length)}`);
}

function parseGermanNumber(text) {
  const digitMatch = text.match(/\b([1-6])\b/);
  if (digitMatch) return parseInt(digitMatch[1], 10);

  const words = { eins: 1, zwei: 2, drei: 3, vier: 4, fünf: 5, fuenf: 5, sechs: 6 };
  const lower = text.toLowerCase();
  for (const word in words) {
    if (lower.includes(word)) return words[word];
  }
  return null;
}

async function handleCheckinAnswer(chatId, transcript, session) {
  const note = parseGermanNumber(transcript);

  if (note === null) {
    await sendTelegramMessage(chatId, "Ich konnte keine Note (1-6) erkennen, sag's nochmal bitte 🙂");
    return;
  }

  const currentTraitId = session.trait_ids[session.current_index];
  await saveToSupabase("personality_checkins", { trait_id: currentTraitId, note });

  const nextIndex = session.current_index + 1;

  if (nextIndex >= session.trait_ids.length) {
    await deleteCheckinSession(chatId);
    await sendTelegramMessage(chatId, `✅ Alles erledigt! ${session.trait_ids.length} Eigenschaften bewertet. Guter Job heute.`);
    return;
  }

  await saveCheckinSession(chatId, session.trait_ids, nextIndex);
  const nextTrait = await getTraitById(session.trait_ids[nextIndex]);
  await sendTelegramMessage(chatId, formatTraitQuestion(nextTrait, nextIndex + 1, session.trait_ids.length));
}

// ---------- Chat-ID merken (für proaktive Nachrichten) ----------

async function rememberChatId(chatId) {
  try {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/bot_settings?on_conflict=id`, {
      method: "POST",
      headers: {
        apikey: process.env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({ id: 1, chat_id: chatId, updated_at: new Date().toISOString() }),
    });
  } catch (err) {
    console.error("Konnte Chat-ID nicht speichern:", err);
  }
}

// ---------- Nährwert-Recherche für Markenprodukte ----------

async function refineNutritionWithSearch(nutritionData) {
  try {
    // Schritt 1: Günstig prüfen, ob es sich um ein Markenprodukt handelt (keine Websuche nötig)
    const brandCheckPrompt = `Prüfe, ob in dieser Mahlzeiten-Beschreibung ein KONKRETES Markenprodukt genannt wird (Hersteller + Produktname, z.B. "Ja! Grillkäse", "Aldi Crispy Chicken Nuggets 100%"). Antworte NUR mit JSON, ohne Markdown: {"is_branded": true oder false, "product_name": "kanonischer, kurzer Produktname oder null"}`;

    const brandCheckText = await callClaude(brandCheckPrompt, nutritionData.description || "", 200, "claude-haiku-4-5-20251001");
    const brandCheck = parseJson(brandCheckText);

    if (brandCheck.is_branded && brandCheck.product_name) {
      // Schritt 2: Im Cache nachschauen, ob wir das Produkt schon mal nachgeschlagen haben
      const cached = await getCachedProduct(brandCheck.product_name);
      if (cached) {
        nutritionData.calories = cached.calories;
        nutritionData.protein_g = cached.protein_g;
      } else {
        // Schritt 3: Noch nie gesehen -> jetzt einmalig im Web nachschauen
        try {
          const searchPrompt = `Suche im Web nach den Nährwerten (kcal und Protein) für eine typische Portion dieses Produkts: "${brandCheck.product_name}". Antworte NUR mit validem JSON, ohne Markdown: {"calories": Zahl, "protein_g": Zahl}`;

          const searchText = await callClaude(
            searchPrompt,
            brandCheck.product_name,
            1024,
            "claude-sonnet-5",
            [{ type: "web_search_20250305", name: "web_search" }]
          );
          const found = parseJson(searchText);

          if (found.calories) nutritionData.calories = found.calories;
          if (found.protein_g) nutritionData.protein_g = found.protein_g;

          // Schritt 4: Für's nächste Mal im Cache speichern
          if (nutritionData.calories) {
            await cacheProduct(brandCheck.product_name, nutritionData.calories, nutritionData.protein_g);
          }
        } catch (searchErr) {
          console.error("Websuche für Markenprodukt fehlgeschlagen:", searchErr);
        }
      }
    }
  } catch (err) {
    console.error("Marken-Check fehlgeschlagen:", err);
  } finally {
    // Sicherheitsnetz: Falls JETZT IMMER NOCH keine Zahl vorhanden ist (egal aus welchem Grund),
    // garantiert eine schnelle, einfache Schätzung nachholen - nie ohne Wert speichern.
    if (!nutritionData.calories) {
      try {
        const fallbackText = await callClaude(
          `Schätze für dieses Lebensmittel/diese Mahlzeit die Kalorien und das Protein einer typischen Portion. Antworte NUR mit validem JSON, ohne Markdown: {"calories": Zahl, "protein_g": Zahl}`,
          nutritionData.description || "unbekannte Mahlzeit",
          200,
          "claude-haiku-4-5-20251001"
        );
        const fallback = parseJson(fallbackText);
        if (fallback.calories) nutritionData.calories = fallback.calories;
        if (fallback.protein_g) nutritionData.protein_g = fallback.protein_g;
      } catch (fallbackErr) {
        console.error("Auch Fallback-Schätzung fehlgeschlagen:", fallbackErr);
      }
    }
  }
}

async function getCachedProduct(name) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/nutrition_products_cache?product_name=ilike.${encodeURIComponent(name)}`;
  const res = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
    },
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows && rows[0] ? rows[0] : null;
}

async function cacheProduct(name, calories, protein_g) {
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/nutrition_products_cache`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ product_name: name, calories, protein_g }),
  });
}

// ---------- Tägliches Ernährungs-Feedback ----------

async function checkNutritionFeedback() {
  try {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayIso = todayStart.toISOString();

    const url = `${process.env.SUPABASE_URL}/rest/v1/nutrition_log?logged_at=gte.${todayIso}`;
    const res = await fetch(url, {
      headers: {
        apikey: process.env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      },
    });
    if (!res.ok) return null;
    const todayMeals = await res.json();

    const totalCalories = todayMeals.reduce((sum, m) => sum + (m.calories || 0), 0);
    const totalProtein = todayMeals.reduce((sum, m) => sum + (m.protein_g || 0), 0);

    const goalRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/nutrition_goals?order=updated_at.desc&limit=1`,
      {
        headers: {
          apikey: process.env.SUPABASE_SECRET_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
        },
      }
    );
    const goals = await goalRes.json();
    if (!goals || goals.length === 0) return null; // kein Ziel hinterlegt, kein Feedback möglich

    const calorieGoal = goals[0].daily_calorie_target;
    const proteinGoal = goals[0].daily_protein_target;

    if (!calorieGoal) return null;

    const diff = totalCalories - calorieGoal;

    if (diff > 200) {
      return `Heute bisher ${totalCalories} von ${calorieGoal} kcal (${diff} kcal drüber). Protein: ${totalProtein}/${proteinGoal || "?"}g. Für den Rest des Tages leichter essen, oder morgen etwas ausgleichen.`;
    } else if (diff < -300 && todayMeals.length >= 2) {
      return `Heute bisher nur ${totalCalories} von ${calorieGoal} kcal. Protein: ${totalProtein}/${proteinGoal || "?"}g. Achte darauf, nicht zu wenig zu essen, sonst leidet der Muskelerhalt.`;
    } else {
      return `Heute bisher ${totalCalories} von ${calorieGoal} kcal, Protein ${totalProtein}/${proteinGoal || "?"}g - liegt gut im Rahmen.`;
    }
  } catch (err) {
    console.error("Fehler beim Ernährungs-Feedback:", err);
    return null;
  }
}

// ---------- Gewichts-/Körperfett-Trend-Feedback ----------

async function checkBodyProgressFeedback() {
  try {
    const history = await fetchRecent("body_metrics", 8);
    if (!history || history.length < 2) return null;

    const goals = await fetchRecent("training_goals", 5);
    const nutritionGoals = await fetchRecent("nutrition_goals", 1);

    const systemPrompt = `Du bist ein Personal Trainer. Du bekommst den Gewichts-/Körperfett-Verlauf einer Person (neueste zuerst), ihre Trainingsziele und ihr aktuelles Ernährungsziel (Kalorien/Protein). Beurteile in 1-2 kurzen Sätzen, ob der Trend zum Ziel passt, und gib bei Bedarf eine konkrete Anpassungsempfehlung (z.B. "Kalorien um 100-150 senken" oder "mehr Cardio" oder "weiter so"). Sei konkret, keine Grundsatzerklärungen.`;

    const userMsg = `Verlauf: ${JSON.stringify(history)}\nTrainingsziele: ${JSON.stringify(goals)}\nErnährungsziel: ${JSON.stringify(nutritionGoals)}`;

    return await callClaude(systemPrompt, userMsg, 300, "claude-sonnet-5");
  } catch (err) {
    console.error("Fehler beim Body-Progress-Feedback:", err);
    return null;
  }
}

// ---------- Progressions-Feedback ----------

async function checkProgressionFeedback(exerciseName) {
  try {
    const url = `${process.env.SUPABASE_URL}/rest/v1/workouts?exercise=ilike.${encodeURIComponent(exerciseName)}&order=logged_at.desc&limit=6`;
    const res = await fetch(url, {
      headers: {
        apikey: process.env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      },
    });
    if (!res.ok) return null;
    const history = await res.json();

    if (!history || history.length < 2) return null; // zu wenig Historie für eine Einschätzung

    const activePlan = await fetchRecent("training_plan", 1, "&active=eq.true");
    const planText = activePlan[0]?.plan_text || "kein Plan hinterlegt";

    const systemPrompt = `Du bist ein Personal Trainer. Du bekommst den Verlauf einer einzelnen Übung (neueste zuerst) und den aktuellen Trainingsplan. Beurteile in EINEM kurzen Satz, ob die Person das obere Ende ihres Wiederholungsbereichs mehrfach in Folge erreicht/übertroffen hat.

WICHTIG: Schlag eine Gewichts-/Wiederholungssteigerung NIE einfach so vor. Frag stattdessen zuerst nach der Ausführung, z.B.: "Du bist jetzt 3x am oberen Ende - war die Ausführung dabei sauber/kontrolliert? Falls ja, kannst du beim nächsten Mal das Gewicht leicht steigern." Sauberere Technik hat Vorrang vor mehr Gewicht.

Wenn kein Anlass für eine Steigerung besteht, antworte NUR mit "weiter so wie bisher". Antworte NUR mit diesem einen Satz/dieser einen Frage, keine Einleitung.`;

    const userMsg = `Übung: ${exerciseName}\nVerlauf: ${JSON.stringify(history)}\nTrainingsplan: ${planText}`;

    return await callClaude(systemPrompt, userMsg, 200, "claude-haiku-4-5-20251001");
  } catch (err) {
    console.error("Fehler beim Progressions-Feedback:", err);
    return null; // Feedback ist ein Bonus, darf das Loggen nicht blockieren
  }
}

// ---------- Trainingsplan erstellen ----------

async function fetchRecent(table, limit = 20, extraFilter = "") {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${table}?limit=${limit}${extraFilter}`;
  const res = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
    },
  });
  if (!res.ok) return [];
  return res.json();
}

async function generateTrainingPlan(constraints) {
  const workouts = await fetchRecent("workouts", 20);
  const bodyMetrics = await fetchRecent("body_metrics", 5);
  const goals = await fetchRecent("training_goals", 5);

  const context = `Bisherige Workouts (neueste zuerst): ${JSON.stringify(workouts)}
Körperwerte-Verlauf: ${JSON.stringify(bodyMetrics)}
Trainingsziele: ${JSON.stringify(goals)}
${constraints ? `Zusätzlicher Wunsch der Person: ${constraints}` : ""}`;

  const systemPrompt = `Du bist ein erfahrener Personal Trainer. Erstelle basierend auf den Trainingsdaten, Körperwerten und Zielen der Person einen konkreten, strukturierten Trainingsplan. Falls die Person einen zusätzlichen Wunsch genannt hat (z.B. Anzahl Trainingstage), halte dich exakt daran - auch wenn das vom Optimum abweicht, hat der Wunsch der Person Vorrang.

WICHTIG zur Ernährungsempfehlung: Schau dir die Trainingsziele genau an. Wenn das Ziel eine Reduktion des Körperfettanteils ist (Zielwert niedriger als der aktuelle Wert), empfiehl NIEMALS einen Kalorienüberschuss - das würde dem Ziel widersprechen. Empfiehl stattdessen Erhaltungsbedarf oder ein leichtes Kaloriendefizit (Body Recomposition), kombiniert mit hoher Proteinzufuhr. Ein Überschuss ist nur sinnvoll, wenn der Ziel-KFA höher oder gleich dem aktuellen ist.

Falls noch keine Daten vorhanden sind, erstelle einen sinnvollen Einsteiger-Plan. Antworte NUR mit dem Plan als lesbarem Text.`;

  return await callClaude(systemPrompt, context, 4000, "claude-sonnet-5");
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
    const filter = table === "training_plan" ? "&active=eq.true" : "";
    const rows = await fetchRecent(table, 50, filter);
    context += `\n\nDaten aus "${table}":\n${JSON.stringify(rows)}`;
  }

  const systemPrompt = `Du bist ein persönlicher Assistent. Beantworte die Frage der Person basierend AUSSCHLIESSLICH auf den mitgelieferten Daten. Sei kurz und konkret (2-4 Sätze). Falls die Daten nicht ausreichen, sag das ehrlich.`;

  return await callClaude(systemPrompt, `Frage: ${question}${context}`, 500, "claude-sonnet-5");
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
