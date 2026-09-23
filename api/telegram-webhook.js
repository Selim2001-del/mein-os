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

    // Fortschrittsfoto? Separat behandeln, keine Sprachverarbeitung nötig.
    if (message.photo) {
      await handlePhotoMessage(chatId, message);
      return res.status(200).send("OK");
    }

    if (!message.voice && !message.text) {
      await sendTelegramMessage(chatId, "Schick mir eine Sprachnachricht oder schreib mir einfach 🎙️💬");
      return res.status(200).send("OK");
    }

    // Sprachnachricht -> herunterladen + transkribieren. Getippter Text -> direkt übernehmen.
    let transcript;
    if (message.voice) {
      const audioBuffer = await downloadTelegramFile(message.voice.file_id);
      transcript = await transcribeAudio(audioBuffer);
    } else {
      transcript = message.text;
    }

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

      const hasNote = parseGermanNumber(transcript) !== null;
      const hasSkip = /überspringen|skip|weiter|nächste/i.test(transcript);
      if (wordCount <= 6 && (hasNote || hasSkip)) {
        await handleCheckinAnswer(chatId, transcript, activeSession);
        return res.status(200).send("OK");
      }
      // Sonst: lange/komplexe Nachricht während einer offenen Session -> ignorieren und normal verarbeiten
    }

    // 4. Will die Person einen Check-in STARTEN?
    const wantsCheckup = /check[\s-]?in|check[\s-]?up|kpis?\s*(von\s*)?(meiner?\s*)?(persönlichkeit\s*)?durchgehen|persönlichkeits[\s-]?kpis?|tageskontroll[\s-]?kpis?|tägliche[nr]?\s*(check|kpis?)|eigenschaften\s*durchgehen|charaktereigenschaften\s*durchgehen|flaws?\s*durchgehen/i.test(transcript);
    if (wantsCheckup) {
      await startCheckinSession(chatId);
      return res.status(200).send("OK");
    }

    // 4b. Wartet der Bot gerade auf eine Ja/Nein-Antwort (z.B. "war die Ausführung sauber?")?
    const pending = await getPendingConfirmation(chatId);
    if (pending) {
      const pendingWordCount = transcript.trim().split(/\s+/).length;
      const looksLikeYesNo = /^(ja|nein|jup|jep|joa|nö|klar|passt|genau|richtig|stimmt|korrekt|nicht wirklich|eher nicht)\b/i.test(transcript.trim()) || pendingWordCount <= 4;
      if (looksLikeYesNo) {
        await deletePendingConfirmation(chatId);
        const ackPrompt = `Du hattest der Person diese Frage gestellt: "${pending.question}"\nSie hat geantwortet: "${transcript}"\nGib eine kurze (1 Satz), passende Reaktion darauf als Trainer/Coach - falls sie "ja" (saubere Ausführung) sagt, bestärke die Steigerung beim nächsten Mal; falls "nein", bestärke dass Technik vor Gewicht geht und sie beim aktuellen Gewicht bleiben sollte. Antworte NUR mit dem einen Satz.`;
        const ack = await callClaude(ackPrompt, transcript, 150, "claude-haiku-4-5-20251001");
        await sendTelegramMessage(chatId, ack);
        return res.status(200).send("OK");
      }
      // Nachricht sieht nicht nach einer Antwort aus -> offene Frage verwerfen und normal weiterverarbeiten
      await deletePendingConfirmation(chatId);
    }

    // 5. Ansonsten: normale Klassifizierung (Loggen / Frage / Sonderaktionen)
    const actions = await classifyWithClaude(transcript);
    const results = [];

    for (const action of actions) {
      try {
        if (action.type === "insert") {
          if (action.table === "debts") {
            await upsertDebt(action.data);
            results.push(`✅ Gespeichert in "debts"`);
            continue;
          }
          if (action.table === "expense_budgets") {
            await upsertExpenseBudget(action.data);
            results.push(`✅ Budget gesetzt für "${action.data.category}"`);
            continue;
          }
          if (action.table === "finance_snapshots") {
            const snapshot = await upsertFinanceSnapshot(action.data);
            results.push(`✅ Vermögens-Snapshot: ${snapshot.liquide_mittel}€ liquide, ${snapshot.ruecklagen}€ Rücklagen, ${snapshot.vermoegen_gesamt}€ Gesamtvermögen`);
            continue;
          }
          if (action.table === "sales_kpis") {
            const todayRow = await accumulateSalesKpis(action.data);
            const feedback = await checkSalesFeedback();
            results.push(`✅ Gespeichert in "sales_kpis"`);

            const streakMsg = await checkSalesStreak(todayRow);
            if (streakMsg) results.push(streakMsg);

            if (feedback) results.push(`📈 ${feedback}`);
            continue;
          }
          await saveToSupabase(action.table, action.data);
          results.push(`✅ Gespeichert in "${action.table}"`);

          if (action.table === "workouts" && action.data.exercise) {
            const feedback = await checkProgressionFeedback(action.data.exercise, chatId);
            if (feedback) results.push(`💪 ${feedback}`);

            const weeklyCount = await getWeeklyTrainingDayCount();
            results.push(`🗓️ Training Nr. ${weeklyCount} diese Woche (Mo-So)`);
          }
          if (action.table === "body_metrics") {
            const feedback = await checkBodyProgressFeedback();
            if (feedback) results.push(`📊 ${feedback}`);
          }
          if (action.table === "nutrition_log") {
            const feedback = await checkNutritionFeedback();
            if (feedback) results.push(`🍽️ ${feedback}`);
          }
          if (action.table === "daily_steps") {
            const stepsFeedback = await checkStepsFeedback();
            if (stepsFeedback) results.push(`🚶 ${stepsFeedback}`);
          }
          if (action.table === "journal_entries") {
            const reflection = await generateJournalReflection(action.data.raw_text || action.data.summary);
            if (reflection) results.push(`💭 ${reflection}`);
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
        } else if (action.type === "delete") {
          const deleteResult = await handleDelete(action.table, action.description);
          results.push(`🗑️ ${deleteResult}`);
        } else if (action.type === "complete_task") {
          const completeResult = await handleCompleteTask(action.description);
          results.push(`✅ ${completeResult}`);
        } else if (action.type === "reopen_task") {
          const reopenResult = await handleReopenTask(action.description);
          results.push(`↩️ ${reopenResult}`);
        } else if (action.type === "update_nutrition") {
          const updateResult = await handleUpdateNutrition(action.description, action.calories_delta, action.protein_delta);
          results.push(`✏️ ${updateResult}`);
        } else if (action.type === "update_debt") {
          const debtResult = await handleUpdateDebt(action.description, action.paid_off_completely, action.paid_amount);
          results.push(`💰 ${debtResult}`);
        } else if (action.type === "merge_tasks") {
          const mergeResult = await handleMergeTasks(action.description, action.combined_title);
          results.push(`🔀 ${mergeResult}`);
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

async function downloadTelegramFile(fileId) {
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

async function getKnownExpenseCategories() {
  try {
    const url = `${process.env.SUPABASE_URL}/rest/v1/expense_budgets?select=category`;
    const res = await fetch(url, {
      headers: {
        apikey: process.env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      },
    });
    if (!res.ok) return [];
    const rows = await res.json();
    return rows.map((r) => r.category);
  } catch (err) {
    console.error("Konnte bekannte Kategorien nicht laden:", err);
    return [];
  }
}

async function classifyWithClaude(transcript) {
  const today = new Date().toISOString().split("T")[0];
  const knownCategories = await getKnownExpenseCategories();
  const categoryHint = knownCategories.length
    ? `\n\nBekannte Ausgaben-Kategorien dieser Person (mit gesetztem Budget): ${knownCategories.join(", ")}. Bei "expenses" IMMER versuchen, eine dieser Kategorien passend zur Beschreibung zu wählen - AUCH WENN die Person das Wort "Kategorie" nicht explizit sagt (z.B. "getankt" -> Kategorie "${knownCategories.find(c => /tank/i.test(c)) || "Tank"}", "eingekauft"/Essen -> "${knownCategories.find(c => /lebensmittel/i.test(c)) || "Lebensmittel"}"). Nur falls WIRKLICH nichts passt, eine neue, sinnvolle Kategorie wählen.`
    : "";

  const systemPrompt = `Heutiges Datum: ${today}. Nutze das für alle relativen Datumsangaben (z.B. "Ende des Jahres", "in 3 Monaten").${categoryHint}

Du bekommst eine gesprochene Notiz einer Person. Sie kann mehrere unabhängige Teile enthalten: neue Fakten zum Speichern, Fragen zu bisherigen Daten, oder Sonderbefehle.

Zerlege die Notiz in einzelne Aktionen. Jede Aktion hat ein "type"-Feld:

1. "insert" - ein normaler Fakt für eine dieser Tabellen:
   - tasks: title, category, priority, due_date
   - nutrition_log: description, calories, protein_g
     WICHTIG: Falls die Person keine genauen Zahlen nennt (z.B. nur "Hähnchen mit Reis gegessen"), schätze calories und protein_g SELBST anhand deines Ernährungswissens für eine typische Portion. Nenne IMMER eine Zahl, nie null/leer lassen.
   - nutrition_goals: daily_calorie_target, daily_protein_target
     WICHTIG: NUR verwenden, wenn die Person EXPLIZIT das Wort "Ziel" nutzt (z.B. "mein Ernährungsziel ist...", "neues Protein-Ziel: ..."). Eine Aussage wie "50g Protein mehr" OHNE das Wort "Ziel" bezieht sich fast immer auf eine KORREKTUR einer geloggten Mahlzeit (siehe "update_nutrition" unten), NICHT auf eine Zieländerung.
   - workouts: exercise, sets, reps, weight_kg, notes
     WICHTIG: Auch eine GROBE Aussage ohne Details zählt als Workout-Eintrag, z.B. "Pull Tag gemacht", "Training heute abgeschlossen", "war im Gym" -> exercise = kurze Beschreibung (z.B. "Pull Tag"), sets/reps/weight_kg dürfen dann leer/null bleiben. NICHT als journal_entries einordnen, nur weil keine genauen Sätze/Wiederholungen genannt wurden.
   - daily_steps: steps
     Hinweis: logged_at ist automatisch heute, außer die Person nennt explizit ein anderes Datum.
   - sales_kpis: cold_calls, vz_blocks, entscheider_erreicht, entscheider_gepitcht, termine_gelegt, sets_im_kalender, no_show, gekommen, sales_call_terminiert
     Hinweis: Vertriebs-Kennzahlen für den Job. Nur die genannten Felder ausfüllen, Rest weglassen (nicht 0 erfinden). Werte addieren sich automatisch zum Tageswert, falls mehrfach am Tag gemeldet.
   - sales_goals: daily_cold_call_target, daily_termine_target
   - body_metrics: weight_kg, body_fat_percent
   - training_goals: target_weight_kg, target_body_fat_percent, target_date, notes
   - expenses: amount, category, description
   - expense_budgets: category, monthly_limit
     Hinweis: Reicht Kategorie-Name + Limit-Betrag (z.B. "Limit für Lebensmittel: 400 Euro im Monat"). Der Bot aktualisiert automatisch statt zu duplizieren.
   - income: amount, source, description
   - fixed_costs: name, betrag, rhythmus, kategorie
   - debts: name, restbetrag, monatliche_rate, zinssatz
     Hinweis: Bei debts reicht der AKTUELLE Rest-Betrag - der Bot merkt sich beim ersten Mal automatisch den Ausgangspunkt und trackt danach den Fortschritt.
   - finance_goals: title, target_amount, target_date
   - finance_snapshots: liquide_mittel, ruecklagen, vermoegen_gesamt
     Hinweis: Nenne nur die Felder, die die Person tatsächlich sagt (z.B. nur liquide_mittel) - fehlende Felder werden automatisch vom letzten bekannten Stand übernommen bzw. automatisch berechnet. Erfinde KEINE Werte für Felder, die nicht genannt wurden.
   - journal_entries: raw_text, summary, mood
   Format: {"type":"insert","table":"...","data":{...}}

2. "trait_new" - die Person will eine NEUE Charaktereigenschaft/einen Flaw anlegen:
   Format: {"type":"trait_new","name":"...","is_flaw":true}

3. "trait_checkin" - die Person bewertet eine Charaktereigenschaft mit einer Schulnote (1=sehr gut, 6=ungenügend):
   Format: {"type":"trait_checkin","trait_name":"...","note":1-6,"notes":"optionaler Kontext"}

4. "generate_plan" - die Person bittet ausdrücklich darum, einen (neuen) Trainingsplan zu erstellen/anzupassen. Falls sie dabei einen konkreten Wunsch nennt (z.B. "nur 4 Tage die Woche", "mehr Fokus auf Beine"), diesen unter "constraints" mitgeben:
   Format: {"type":"generate_plan","constraints":"z.B. 4 Trainingstage pro Woche"}

5. "question" - die Person stellt eine Frage zu ihren bisherigen Daten. Das umfasst auch OFFENE, GEFÜHLSBASIERTE Fragen wie "ich hab das Gefühl, ich mache keinen Progress", "läuft's finanziell besser?", "wie geht's mir eigentlich gerade" - bei solchen Fragen mehrere relevante Tabellen gleichzeitig auswählen (nicht nur eine), damit eine fundierte, ehrliche Antwort anhand der echten Daten möglich ist (z.B. bei "kein Progress"-Gefühl: body_metrics + workouts + training_goals; bei "finanziell besser"-Gefühl: debts + expenses + income + finance_snapshots + finance_goals):
   Format: {"type":"question","text":"die Frage","relevant_tables":["expenses","debts"]}
   Zusätzlich zu den Tabellen oben stehen für relevant_tables auch "training_plan" (aktueller Trainingsplan als Text), "personality_traits" und "personality_checkins" (Charaktereigenschaften-Verlauf) zur Verfügung. Bis zu 5 Tabellen gleichzeitig sind erlaubt, wenn die Frage das braucht.
   KRITISCH: "question" ist NUR zum LESEN da, kann NIEMALS etwas verändern/speichern/aktualisieren. Jede Aussage, die eine VERÄNDERUNG will (auch implizit, z.B. "mehr", "weniger", "erhöhe", "reduzier"), ist NIEMALS "question" - das muss immer "insert", "update_nutrition" oder ein anderer handelnder Typ sein, je nachdem was verändert werden soll.

6. "delete" - die Person möchte einen bestehenden Eintrag löschen (z.B. "lösch die Aufgabe zur Steuerzahlung", "entfern den Workout-Eintrag Bankdrücken von heute"):
   Format: {"type":"delete","table":"tabellenname","description":"was gelöscht werden soll, in normalen Worten"}
   Unterstützte Tabellen dafür: tasks, expenses, fixed_costs, debts, finance_goals, journal_entries, workouts, nutrition_log, income, personality_traits, personality_checkins

7. "complete_task" - die Person hat eine Aufgabe erledigt und möchte sie als "fertig" markieren (NICHT löschen), z.B. "ich hab die Aufgabe mit meiner Schwester erledigt", "Steuerzahlung ist fertig":
   Format: {"type":"complete_task","description":"welche Aufgabe, in normalen Worten"}

8. "reopen_task" - die Person möchte eine bereits als erledigt markierte Aufgabe wieder als OFFEN zurückholen, z.B. "die Aufgabe X ist doch nicht erledigt, hol sie zurück", "war ein Versehen, X ist noch offen":
   Format: {"type":"reopen_task","description":"welche Aufgabe, in normalen Worten"}

9. "update_nutrition" - die Person möchte einen BESTEHENDEN Ernährungs-Eintrag korrigieren (z.B. "streich 500 Kalorien von der Nuggets-Mahlzeit", "die Kartoffeln waren ohne Öl, zieh 300 Kalorien ab", "50g Protein mehr", "20g weniger Protein"):
   Format: {"type":"update_nutrition","description":"welcher Eintrag","calories_delta":-500,"protein_delta":0}
   KRITISCH: calories_delta und protein_delta sind VERÄNDERUNGEN (nicht neue Absolutwerte) - positiv zum Erhöhen, negativ zum Verringern. Setze protein_delta auf 0, AUSSER die Person nennt explizit auch eine Protein-Änderung. Reines Kalorien-Korrigieren (z.B. wegen Öl/Fett) darf das Protein NICHT verändern, da Fett kein Protein enthält.
   WICHTIG: Falls die Person KEINE bestimmte Mahlzeit nennt (z.B. nur "50g Protein mehr"), setze description auf "letzte Mahlzeit" - das bedeutet: die zuletzt geloggte Mahlzeit heute. NIEMALS in so einem Fall auf journal_entries ausweichen, nur weil keine Mahlzeit genannt wurde - "letzte Mahlzeit" ist eine gültige, verständliche Beschreibung.

10. "update_debt" - die Person hat eine BESTEHENDE Schuld (teilweise oder vollständig) ABBEZAHLT, z.B. "GKV ist jetzt komplett abbezahlt", "ich hab 100 Euro auf die Rentenversicherung abbezahlt", "Metahan ist beglichen":
    Format: {"type":"update_debt","description":"welche Schuld","paid_off_completely":true} ODER {"type":"update_debt","description":"welche Schuld","paid_amount":100}
    NIEMALS als normales "insert" in debts behandeln, wenn es um eine bereits bestehende Schuld geht, die abbezahlt wurde - das würde eine neue/doppelte Schuld anlegen statt die bestehende zu reduzieren.

11. "merge_tasks" - die Person möchte mehrere bestehende Aufgaben zu EINER zusammenfassen, z.B. "nimm die letzten drei Aufgaben und mach eine draus", "fass X, Y und Z zu einer Aufgabe zusammen":
    Format: {"type":"merge_tasks","description":"welche Aufgaben zusammengeführt werden sollen, in normalen Worten","combined_title":"neuer, zusammengefasster Aufgaben-Titel"}

Antworte NUR mit einem validen JSON-ARRAY dieser Aktionen, ohne Erklärung, ohne Markdown-Codeblock. Wenn nur EIN Teil erkannt wird, trotzdem ein Array mit einem Element zurückgeben.

Wenn du unsicher bist oder es eine freie Reflexion ist, nutze "insert" mit table "journal_entries".

WICHTIG: Wenn die Person mehrere Eigenschaften mit "Note X" nennt (Schulnoten-Bewertung, z.B. "Verantwortung heute Note 3, Präsenz Note 2"), ist das IMMER "trait_checkin" pro genanntem Namen, NIEMALS journal_entries - auch wenn keine weitere Erklärung dabei ist. Ein Name + eine Zahl 1-6 nacheinander = ein Check-in.

Beispiel:
Eingabe: "Verantwortung heute Note 3, Rechtfertigen Note 5, Präsenz Note 2"
Ausgabe: [{"type":"trait_checkin","trait_name":"Verantwortung","note":3,"notes":null},{"type":"trait_checkin","trait_name":"Rechtfertigen","note":5,"notes":null},{"type":"trait_checkin","trait_name":"Präsenz","note":2,"notes":null}]

WICHTIG: Jede Frage nach bereits gespeicherten/bekannten Infos (z.B. "was ist Übung 5 in meinem Trainingsplan", "was hab ich letzte Woche gegessen", "was war nochmal mein Ziel") ist IMMER "question", NIEMALS "insert" mit journal_entries - auch wenn die Frage sich auf eine vorherige Bot-Antwort/Aktion bezieht statt auf eine neue Tatsache.

Beispiel:
Eingabe: "Was ist denn jetzt Übung 5 in meinem neuen Trainingsplan?"
Ausgabe: [{"type":"question","text":"Was ist Übung 5 im Trainingsplan?","relevant_tables":["training_plan"]}]`;

  const text = await callClaude(systemPrompt, transcript, 4000, "claude-sonnet-5");
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

  // Bereits heute beantwortete Eigenschaften automatisch überspringen
  const todayStr = new Date().toISOString().split("T")[0];
  const answeredUrl = `${process.env.SUPABASE_URL}/rest/v1/personality_checkins?select=trait_id&logged_at=eq.${todayStr}`;
  const answeredRes = await fetch(answeredUrl, {
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
    },
  });
  const answeredToday = answeredRes.ok ? await answeredRes.json() : [];
  const answeredIds = new Set(answeredToday.map((a) => a.trait_id));

  const remainingTraits = traits.filter((t) => !answeredIds.has(t.id));

  if (remainingTraits.length === 0) {
    await sendTelegramMessage(chatId, "✅ Du hast heute schon alle Eigenschaften bewertet. Guter Job!");
    return;
  }

  const traitIds = remainingTraits.map((t) => t.id);
  await saveCheckinSession(chatId, traitIds, 0);

  const firstTrait = await getTraitById(traitIds[0]);
  const skippedNote = answeredIds.size > 0 ? ` (${answeredIds.size} heute schon erledigt, übersprungen)` : "";
  await sendTelegramMessage(chatId, `Los geht's, ${remainingTraits.length} Eigenschaften${skippedNote}:\n\n${formatTraitQuestion(firstTrait, 1, remainingTraits.length)}`);
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
  const wantsSkip = /überspringen|skip|weiter|nächste/i.test(transcript);
  const note = parseGermanNumber(transcript);

  if (note === null && !wantsSkip) {
    await sendTelegramMessage(chatId, "Ich konnte keine Note (1-6) erkennen, sag's nochmal bitte, oder sag \"überspringen\" 🙂");
    return;
  }

  const currentTraitId = session.trait_ids[session.current_index];
  if (!wantsSkip) {
    await saveToSupabase("personality_checkins", { trait_id: currentTraitId, note });
  }

  const nextIndex = session.current_index + 1;

  if (nextIndex >= session.trait_ids.length) {
    await deleteCheckinSession(chatId);
    await sendTelegramMessage(chatId, `✅ Alles erledigt! ${session.trait_ids.length} Eigenschaften durchgegangen. Guter Job heute.`);
    return;
  }

  await saveCheckinSession(chatId, session.trait_ids, nextIndex);
  const nextTrait = await getTraitById(session.trait_ids[nextIndex]);
  await sendTelegramMessage(chatId, formatTraitQuestion(nextTrait, nextIndex + 1, session.trait_ids.length));
}

// ---------- Schulden: Upsert per Name (Fortschritt trackbar) ----------

// ---------- Ausgaben-Budgets: Upsert per Kategorie ----------

// ---------- Vermögens-Snapshot: fehlende Felder übernehmen, Vermögen automatisch berechnen ----------

async function upsertFinanceSnapshot(data) {
  // Letzten bekannten Snapshot holen, um nicht genannte Felder zu übernehmen
  const lastRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/finance_snapshots?order=logged_at.desc&limit=1`, {
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
    },
  });
  const lastRows = lastRes.ok ? await lastRes.json() : [];
  const last = lastRows[0] || {};

  const liquide = data.liquide_mittel != null ? data.liquide_mittel : (last.liquide_mittel || 0);
  const ruecklagen = data.ruecklagen != null ? data.ruecklagen : (last.ruecklagen || 0);

  // Aktuelle Schulden-Summe holen für automatische Vermögensberechnung
  const debtsRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/debts?select=restbetrag`, {
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
    },
  });
  const debtsRows = debtsRes.ok ? await debtsRes.json() : [];
  const totalDebt = debtsRows.reduce((s, d) => s + (d.restbetrag || 0), 0);

  const vermoegen = data.vermoegen_gesamt != null ? data.vermoegen_gesamt : liquide + ruecklagen - totalDebt;

  const finalData = { liquide_mittel: liquide, ruecklagen, vermoegen_gesamt: vermoegen };
  await saveToSupabase("finance_snapshots", finalData);
  return finalData;
}

async function upsertExpenseBudget(data) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/expense_budgets?category=ilike.${encodeURIComponent(data.category)}`;
  const res = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
    },
  });
  const existing = await res.json();

  if (existing && existing.length > 0) {
    const patchRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/expense_budgets?id=eq.${existing[0].id}`, {
      method: "PATCH",
      headers: {
        apikey: process.env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ monthly_limit: data.monthly_limit, updated_at: new Date().toISOString() }),
    });
    if (!patchRes.ok) throw new Error(`Supabase-Fehler beim Aktualisieren des Budgets (${patchRes.status}): ${await patchRes.text()}`);
  } else {
    await saveToSupabase("expense_budgets", data);
  }
}

async function upsertDebt(data) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/debts?name=ilike.${encodeURIComponent(data.name)}`;
  const res = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
    },
  });
  const existing = await res.json();

  if (existing && existing.length > 0) {
    // Schon vorhanden -> nur Rest-Betrag/Rate/Zins aktualisieren, Ausgangspunkt bleibt unangetastet
    const patchRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/debts?id=eq.${existing[0].id}`,
      {
        method: "PATCH",
        headers: {
          apikey: process.env.SUPABASE_SECRET_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          restbetrag: data.restbetrag,
          monatliche_rate: data.monatliche_rate ?? existing[0].monatliche_rate,
          zinssatz: data.zinssatz ?? existing[0].zinssatz,
        }),
      }
    );
    if (!patchRes.ok) throw new Error(`Supabase-Fehler beim Aktualisieren der Schuld (${patchRes.status}): ${await patchRes.text()}`);
  } else {
    // Neu -> Ausgangspunkt automatisch auf den aktuellen Rest-Betrag setzen
    await saveToSupabase("debts", { ...data, original_betrag: data.restbetrag });
  }
}

// ---------- Aufgabe wieder als offen zurückholen ----------

// ---------- Ernährungs-Eintrag gezielt korrigieren ----------

// ---------- Schuld als (teilweise) abbezahlt markieren ----------

async function handleUpdateDebt(description, paidOffCompletely, paidAmount) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/debts?select=id,name,restbetrag,original_betrag`;
  const res = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase-Fehler beim Laden (${res.status}): ${await res.text()}`);
  const rows = await res.json();

  if (!rows || rows.length === 0) {
    return `Keine Schulden hinterlegt.`;
  }

  const matchPrompt = `Hier ist eine Liste bestehender Schulden (id + Name):
${JSON.stringify(rows)}

Die Person hat eine davon abbezahlt, beschrieben als: "${description}"

Finde den EINEN am besten passenden Eintrag. Antworte NUR mit validem JSON, ohne Markdown: {"id": "die-id-oder-null", "matched_name": "der Name der gefundenen Schuld oder null", "reason": "kurze Begründung"}`;

  const matchText = await callClaude(matchPrompt, description, 500, "claude-haiku-4-5-20251001");
  const match = parseJson(matchText);

  if (!match.id) {
    return `Nichts eindeutig gefunden zu "${description}": ${match.reason || "kein eindeutiger Treffer"}`;
  }

  const row = rows.find((r) => r.id === match.id);
  const newRestbetrag = paidOffCompletely ? 0 : Math.max(0, (row.restbetrag || 0) - (paidAmount || 0));

  const patchRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/debts?id=eq.${match.id}`, {
    method: "PATCH",
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ restbetrag: newRestbetrag }),
  });
  if (!patchRes.ok) throw new Error(`Supabase-Fehler beim Aktualisieren (${patchRes.status}): ${await patchRes.text()}`);

  return newRestbetrag === 0
    ? `"${match.matched_name}" ist jetzt komplett abbezahlt! 🎉`
    : `"${match.matched_name}": noch ${newRestbetrag}€ offen (vorher ${row.restbetrag}€)`;
}

// ---------- Mehrere Aufgaben zu einer zusammenführen ----------

async function handleMergeTasks(description, combinedTitle) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/tasks?select=id,title&done=eq.false&order=created_at.desc&limit=100`;
  const res = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase-Fehler beim Laden (${res.status}): ${await res.text()}`);
  const rows = await res.json();

  if (!rows || rows.length === 0) {
    return `Keine offenen Aufgaben vorhanden.`;
  }

  const matchPrompt = `Hier ist eine Liste offener Aufgaben (id + Titel), NEUESTE ZUERST:
${JSON.stringify(rows)}

Die Person möchte mehrere davon zusammenführen, beschrieben als: "${description}"

Finde ALLE passenden Einträge (z.B. bei "die letzten drei" die drei neuesten aus der Liste). Antworte NUR mit validem JSON, ohne Markdown: {"ids": ["id1","id2","id3"], "matched_titles": ["...", "...", "..."], "reason": "kurze Begründung"}`;

  const matchText = await callClaude(matchPrompt, description, 500, "claude-haiku-4-5-20251001");
  const match = parseJson(matchText);

  if (!match.ids || match.ids.length === 0) {
    return `Nichts eindeutig gefunden zu "${description}": ${match.reason || "kein eindeutiger Treffer"}`;
  }

  for (const id of match.ids) {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/tasks?id=eq.${id}`, {
      method: "DELETE",
      headers: {
        apikey: process.env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      },
    });
  }

  await saveToSupabase("tasks", { title: combinedTitle });

  return `${match.ids.length} Aufgaben zusammengeführt zu: "${combinedTitle}"`;
}

async function handleUpdateNutrition(description, caloriesDelta, proteinDelta) {
  // Heutige Mahlzeiten holen (neueste zuerst), damit Claude den richtigen Eintrag findet
  const url = `${process.env.SUPABASE_URL}/rest/v1/nutrition_log?select=id,description,calories,protein_g,logged_at&logged_at=gte.${new Date().toISOString().split("T")[0]}&order=logged_at.desc`;
  const res = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase-Fehler beim Laden (${res.status}): ${await res.text()}`);
  const rows = await res.json();

  if (!rows || rows.length === 0) {
    return `Keine heutigen Mahlzeiten gefunden.`;
  }

  const matchPrompt = `Hier ist eine Liste heutiger Mahlzeiten, NEUESTE ZUERST (id + Beschreibung + Zeitpunkt):
${JSON.stringify(rows)}

Die Person möchte einen Eintrag korrigieren, beschrieben als: "${description}"

Falls die Beschreibung "letzte Mahlzeit" o.ä. ist (keine spezifische Mahlzeit genannt), nimm IMMER den ERSTEN Eintrag in der Liste (das ist die neueste).

Finde den EINEN am besten passenden Eintrag. Antworte NUR mit validem JSON, ohne Markdown: {"id": "die-id-oder-null", "matched_text": "die Beschreibung des gefundenen Eintrags oder null", "reason": "kurze Begründung"}`;

  const matchText = await callClaude(matchPrompt, description, 500, "claude-haiku-4-5-20251001");
  const match = parseJson(matchText);

  if (!match.id) {
    return `Nichts eindeutig gefunden zu "${description}": ${match.reason || "kein eindeutiger Treffer"}`;
  }

  const row = rows.find((r) => r.id === match.id);
  const newCalories = Math.max(0, (row.calories || 0) + (caloriesDelta || 0));
  const newProtein = Math.max(0, (row.protein_g || 0) + (proteinDelta || 0));

  const patchRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/nutrition_log?id=eq.${match.id}`, {
    method: "PATCH",
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ calories: newCalories, protein_g: newProtein }),
  });
  if (!patchRes.ok) throw new Error(`Supabase-Fehler beim Korrigieren (${patchRes.status}): ${await patchRes.text()}`);

  return `"${match.matched_text}" korrigiert: jetzt ${newCalories} kcal, ${newProtein}g Protein (vorher ${row.calories} kcal, ${row.protein_g}g)`;
}

async function handleReopenTask(description) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/tasks?select=id,title&done=eq.true&order=created_at.desc&limit=100`;
  const res = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase-Fehler beim Laden (${res.status}): ${await res.text()}`);
  const rows = await res.json();

  if (!rows || rows.length === 0) {
    return `Keine erledigten Aufgaben vorhanden.`;
  }

  const matchPrompt = `Hier ist eine Liste bereits erledigter Aufgaben (id + Titel):
${JSON.stringify(rows)}

Die Person möchte eine davon wieder als offen zurückholen, beschrieben als: "${description}"

Finde den EINEN am besten passenden Eintrag. Antworte NUR mit validem JSON, ohne Markdown: {"id": "die-id-oder-null", "matched_text": "der Titel des gefundenen Eintrags oder null", "reason": "kurze Begründung, v.a. falls nichts eindeutig passt"}`;

  const matchText = await callClaude(matchPrompt, description, 500, "claude-haiku-4-5-20251001");
  const match = parseJson(matchText);

  if (!match.id) {
    return `Nichts eindeutig gefunden zu "${description}": ${match.reason || "kein eindeutiger Treffer"}`;
  }

  const patchRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/tasks?id=eq.${match.id}`, {
    method: "PATCH",
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ done: false }),
  });
  if (!patchRes.ok) throw new Error(`Supabase-Fehler beim Zurückholen (${patchRes.status}): ${await patchRes.text()}`);

  return `Aufgabe wieder offen: "${match.matched_text}"`;
}

// ---------- Aufgabe als erledigt markieren ----------

async function handleCompleteTask(description) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/tasks?select=id,title&done=eq.false&limit=100`;
  const res = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase-Fehler beim Laden (${res.status}): ${await res.text()}`);
  const rows = await res.json();

  if (!rows || rows.length === 0) {
    return `Keine offenen Aufgaben vorhanden.`;
  }

  const matchPrompt = `Hier ist eine Liste offener Aufgaben (id + Titel):
${JSON.stringify(rows)}

Die Person hat eine Aufgabe erledigt, beschrieben als: "${description}"

Finde den EINEN am besten passenden Eintrag. Antworte NUR mit validem JSON, ohne Markdown: {"id": "die-id-oder-null", "matched_text": "der Titel des gefundenen Eintrags oder null", "reason": "kurze Begründung, v.a. falls nichts eindeutig passt"}`;

  const matchText = await callClaude(matchPrompt, description, 500, "claude-haiku-4-5-20251001");
  const match = parseJson(matchText);

  if (!match.id) {
    return `Nichts eindeutig gefunden zu "${description}": ${match.reason || "kein eindeutiger Treffer"}`;
  }

  const patchRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/tasks?id=eq.${match.id}`, {
    method: "PATCH",
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ done: true }),
  });
  if (!patchRes.ok) throw new Error(`Supabase-Fehler beim Abhaken (${patchRes.status}): ${await patchRes.text()}`);

  return `Aufgabe erledigt: "${match.matched_text}" 🎉`;
}

// ---------- Löschen per Sprache/Text ----------

async function handleDelete(table, description) {
  const columnMap = {
    tasks: "title",
    expenses: "description",
    fixed_costs: "name",
    debts: "name",
    finance_goals: "title",
    journal_entries: "raw_text",
    workouts: "exercise",
    nutrition_log: "description",
    income: "source",
    personality_traits: "name",
  };

  let rows, column;

  if (table === "personality_checkins") {
    // Sonderfall: Kein eigener Text, also Trait-Name + Note + Datum zu einem Anzeigetext kombinieren
    const url = `${process.env.SUPABASE_URL}/rest/v1/personality_checkins?select=id,note,logged_at,personality_traits(name)&order=logged_at.desc&limit=100`;
    const res = await fetch(url, {
      headers: {
        apikey: process.env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      },
    });
    if (!res.ok) throw new Error(`Supabase-Fehler beim Laden (${res.status}): ${await res.text()}`);
    const raw = await res.json();
    rows = raw.map((r) => ({
      id: r.id,
      display: `${r.personality_traits ? r.personality_traits.name : "?"} - Note ${r.note} (${r.logged_at})`,
    }));
    column = "display";
  } else {
    column = columnMap[table];
    if (!column) {
      return `Löschen aus "${table}" wird nicht unterstützt.`;
    }
    const url = `${process.env.SUPABASE_URL}/rest/v1/${table}?select=id,${column}&limit=100`;
    const res = await fetch(url, {
      headers: {
        apikey: process.env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      },
    });
    if (!res.ok) throw new Error(`Supabase-Fehler beim Laden (${res.status}): ${await res.text()}`);
    rows = await res.json();
  }

  if (!rows || rows.length === 0) {
    return `Keine Einträge in "${table}" vorhanden.`;
  }

  const matchPrompt = `Hier ist eine Liste von Einträgen (id + Text) aus der Tabelle "${table}":
${JSON.stringify(rows)}

Die Person möchte einen Eintrag löschen, beschrieben als: "${description}"

Finde den EINEN am besten passenden Eintrag (auch bei ungenauer/anderer Formulierung, z.B. "Testeintrag" passt zu "Test Eintrag löschen"). Antworte NUR mit validem JSON, ohne Markdown: {"id": "die-id-oder-null", "matched_text": "der Text des gefundenen Eintrags oder null", "reason": "kurze Begründung, v.a. falls nichts eindeutig passt oder mehrere gleich gut passen"}`;

  const matchText = await callClaude(matchPrompt, description, 500, "claude-haiku-4-5-20251001");
  const match = parseJson(matchText);

  if (!match.id) {
    return `Nichts eindeutig gefunden zu "${description}" in "${table}": ${match.reason || "kein eindeutiger Treffer"}`;
  }

  const deleteRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}?id=eq.${match.id}`, {
    method: "DELETE",
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
    },
  });
  if (!deleteRes.ok) throw new Error(`Supabase-Fehler beim Löschen (${deleteRes.status}): ${await deleteRes.text()}`);

  return `Gelöscht aus "${table}": "${match.matched_text}"`;
}

// ---------- Journal-Reflexion mit Lebens-Kontext ----------

async function generateJournalReflection(currentText) {
  if (!currentText) return null;

  try {
    const url = `${process.env.SUPABASE_URL}/rest/v1/life_profile?select=category,topic,title,content,interpretation&limit=300`;
    const res = await fetch(url, {
      headers: {
        apikey: process.env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      },
    });
    const lifeProfile = res.ok ? await res.json() : [];

    if (lifeProfile.length === 0) {
      return null; // noch keine Lebens-Erkenntnisse hinterlegt, keine Reflexion möglich
    }

    const systemPrompt = `Du bist ein einfühlsamer, ehrlicher Begleiter für Selbstreflexion. Du bekommst Hintergrundwissen über die Person (destillierte Erkenntnisse aus jahrelanger Selbstreflexion) und ihre gerade geschriebene/gesprochene Nachricht.

Falls die Nachricht erkennbar mit einem der Hintergrund-Punkte zusammenhängt (z.B. ein wiederkehrendes Muster, ein Flaw an dem sie arbeitet, eine alte Angst): weise das SANFT und KONKRET darauf hin, idealerweise mit einem Hinweis auf Wachstum/Veränderung, falls erkennbar ("früher X, jetzt Y").

Falls kein klarer Zusammenhang erkennbar ist: gib einfach eine kurze, warme, unterstützende Reflexion zur Nachricht selbst, ohne das Hintergrundwissen zu erzwingen.

WICHTIG: Du bist kein Ersatz für echte therapeutische Hilfe. Bei Anzeichen von echtem Leid/Krise: sanft dazu ermutigen, mit einer echten Person zu sprechen, statt nur hier weiterzumachen. Das Feld "interpretation" im Hintergrundwissen sind ausdrücklich ARBEITSHYPOTHESEN, keine festgestellten Fakten - entsprechend vorsichtig formulieren ("könnte", "vielleicht"), nicht als Diagnose oder Wahrheit hinstellen. Keine Diagnosen stellen. 2-4 Sätze, keine Plattitüden.

Hintergrundwissen über die Person:
${JSON.stringify(lifeProfile)}`;

    return await callClaude(systemPrompt, currentText, 600, "claude-sonnet-5");
  } catch (err) {
    console.error("Fehler bei Journal-Reflexion:", err);
    return null;
  }
}

// ---------- Sales-KPIs: Tages-Aufsummierung + Wochenvergleich ----------

async function accumulateSalesKpis(data) {
  const todayStr = new Date().toISOString().split("T")[0];
  const url = `${process.env.SUPABASE_URL}/rest/v1/sales_kpis?logged_at=eq.${todayStr}`;
  const res = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
    },
  });
  const existing = res.ok ? await res.json() : [];

  const fields = ["cold_calls", "vz_blocks", "entscheider_erreicht", "entscheider_gepitcht", "termine_gelegt", "sets_im_kalender", "no_show", "gekommen", "sales_call_terminiert"];

  if (existing.length > 0) {
    const row = existing[0];
    const merged = {};
    for (const f of fields) {
      merged[f] = (row[f] || 0) + (data[f] || 0);
    }
    const patchRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/sales_kpis?id=eq.${row.id}`, {
      method: "PATCH",
      headers: {
        apikey: process.env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(merged),
    });
    if (!patchRes.ok) throw new Error(`Supabase-Fehler beim Aktualisieren der Sales-KPIs (${patchRes.status}): ${await patchRes.text()}`);
    return { logged_at: todayStr, ...merged };
  } else {
    await saveToSupabase("sales_kpis", data);
    const zeroed = Object.fromEntries(fields.map((f) => [f, data[f] || 0]));
    return { logged_at: todayStr, ...zeroed };
  }
}

function getMonday(date) {
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - diff);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// ---------- Sales-Tagesziel-Streak ----------

async function checkSalesStreak(todayRow) {
  try {
    const goalRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/sales_goals?order=updated_at.desc&limit=1`, {
      headers: {
        apikey: process.env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      },
    });
    const goals = goalRes.ok ? await goalRes.json() : [];
    const goal = goals[0];
    if (!goal || !goal.daily_cold_call_target) return null; // ohne Ziel kein Streak möglich

    const callsGoal = goal.daily_cold_call_target;
    const termineGoal = goal.daily_termine_target || 0;
    const todayHit = (todayRow.cold_calls || 0) >= callsGoal && (todayRow.termine_gelegt || 0) >= termineGoal;

    if (!todayHit) return null; // heute noch nicht erreicht, keine Streak-Meldung nötig

    // Letzte 60 Tage laden, um von heute rückwärts die Streak zu zählen
    const url = `${process.env.SUPABASE_URL}/rest/v1/sales_kpis?order=logged_at.desc&limit=60`;
    const res = await fetch(url, {
      headers: {
        apikey: process.env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      },
    });
    const rows = res.ok ? await res.json() : [];
    const byDate = {};
    rows.forEach((r) => (byDate[r.logged_at] = r));
    byDate[todayRow.logged_at] = todayRow; // heutigen (frisch gemergten) Wert nutzen, nicht den alten

    let streak = 0;
    let cursor = new Date();
    for (let i = 0; i < 60; i++) {
      const dStr = cursor.toISOString().split("T")[0];
      const row = byDate[dStr];
      if (!row) {
        cursor.setDate(cursor.getDate() - 1);
        continue; // Tag ohne Eintrag (z.B. Wochenende) unterbricht die Streak nicht
      }
      const hit = (row.cold_calls || 0) >= callsGoal && (row.termine_gelegt || 0) >= termineGoal;
      if (!hit) break;
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }

    let msg = `✅ Tagesziel erreicht! 🔥 ${streak} Tage Streak`;

    if (streak > 0 && streak % 5 === 0) {
      const newCallsGoal = Math.round((callsGoal * 1.1) / 10) * 10;
      msg += `\n🚀 ${streak} Tage in Folge das Ziel erreicht - Zeit für mehr! Wie wär's mit ${newCallsGoal} Cold Calls/Tag ab jetzt?`;
    }

    return msg;
  } catch (err) {
    console.error("Fehler beim Sales-Streak:", err);
    return null;
  }
}

async function checkSalesFeedback() {
  try {
    const now = new Date();
    const thisMonday = getMonday(now);

    // Letzte 5 Wochen laden (aktuelle + 4 volle davor) für einen echten Trend
    const rangeStart = new Date(thisMonday);
    rangeStart.setUTCDate(thisMonday.getUTCDate() - 28);

    const url = `${process.env.SUPABASE_URL}/rest/v1/sales_kpis?logged_at=gte.${rangeStart.toISOString().split("T")[0]}&order=logged_at.asc`;
    const res = await fetch(url, {
      headers: {
        apikey: process.env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      },
    });
    if (!res.ok) return null;
    const rows = await res.json();

    const sum = (arr, field) => arr.reduce((s, r) => s + (r[field] || 0), 0);

    // In Wochen-Buckets aufteilen (Woche 0 = aktuelle, 1 = letzte volle, usw.)
    const weeks = [];
    for (let i = 0; i < 5; i++) {
      const start = new Date(thisMonday);
      start.setUTCDate(thisMonday.getUTCDate() - i * 7);
      const end = new Date(start);
      end.setUTCDate(start.getUTCDate() + 7);
      const startStr = start.toISOString().split("T")[0];
      const endStr = end.toISOString().split("T")[0];
      const weekRows = rows.filter((r) => r.logged_at >= startStr && r.logged_at < endStr);
      const gepitcht = sum(weekRows, "entscheider_gepitcht");
      const termine = sum(weekRows, "termine_gelegt");
      weeks.push({
        week: i === 0 ? "aktuell" : `vor ${i} Woche(n)`,
        cold_calls: sum(weekRows, "cold_calls"),
        termine_gelegt: termine,
        entscheider_gepitcht: gepitcht,
        terminierquote_prozent: gepitcht > 0 ? Math.round((termine / gepitcht) * 100) : null,
        tage_mit_daten: weekRows.length,
      });
    }

    const thisWeek = weeks[0];
    const lastWeek = weeks[1];
    const pctChange = (curr, prev) => (prev > 0 ? Math.round(((curr - prev) / prev) * 100) : null);
    const callsChange = pctChange(thisWeek.cold_calls, lastWeek.cold_calls);
    const termineChange = pctChange(thisWeek.termine_gelegt, lastWeek.termine_gelegt);

    let header = `Diese Woche: ${thisWeek.cold_calls} Cold Calls`;
    if (callsChange !== null) header += ` (${callsChange >= 0 ? "+" : ""}${callsChange}% ggü. letzter Woche)`;
    header += `, ${thisWeek.termine_gelegt} Termine`;
    if (termineChange !== null) header += ` (${termineChange >= 0 ? "+" : ""}${termineChange}%)`;

    // Aktuelles Ziel + Tageswert
    const todayStr = now.toISOString().split("T")[0];
    const todayRow = rows.find((r) => r.logged_at === todayStr);
    const goalRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/sales_goals?order=updated_at.desc&limit=1`, {
      headers: {
        apikey: process.env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      },
    });
    const goals = goalRes.ok ? await goalRes.json() : [];
    const goal = goals[0] || null;
    if (goal?.daily_cold_call_target && todayRow) {
      header += `. Heute: ${todayRow.cold_calls || 0}/${goal.daily_cold_call_target} Cold Calls`;
    }

    // Claude beurteilen lassen: Terminierquote-Trend + ggf. Zielanpassung vorschlagen
    const systemPrompt = `Du bist ein erfahrener Sales Coach. Du bekommst die Wochenzahlen der letzten 5 Wochen (Woche 0 = aktuelle, teils unvollständige Woche) sowie das aktuelle Tagesziel für Cold Calls.

Gib in 1-2 kurzen Sätzen eine Einschätzung zur TERMINIERQUOTE (termine_gelegt / entscheider_gepitcht) über die Wochen - wird sie besser, schlechter, stabil? Nur volle Wochen (mit tage_mit_daten >= 5) fair vergleichen, nicht die unvollständige aktuelle Woche urteilen.

WICHTIG - Zielanpassung: Falls die letzte VOLLE Woche (Woche 1, mit tage_mit_daten >= 5) im Schnitt deutlich (mehr als 15%) UNTER dem Tagesziel liegt: schlag konkret einen niedrigeren, realistischeren Tageswert vor (z.B. "setz dir erstmal 170 statt 200, das ist noch anspruchsvoll aber machbar"). Falls die letzten 1-2 vollen Wochen das Ziel konstant ERREICHT oder ÜBERTROFFEN haben: schlag eine leichte Steigerung vor. Falls keine klare Tendenz erkennbar ist oder zu wenig Daten vorhanden sind, sag nichts zur Zielanpassung.

Sei knapp, konkret, wie ein guter Coach - keine Plattitüden. Antworte NUR mit dem Fließtext, keine Einleitung, keine Überschrift.`;

    const insight = await callClaude(
      systemPrompt,
      JSON.stringify({ wochen: weeks, aktuelles_ziel: goal }),
      500,
      "claude-sonnet-5"
    );

    return `${header}\n${insight}`;
  } catch (err) {
    console.error("Fehler beim Sales-Feedback:", err);
    return null;
  }
}

// ---------- Wochen-Trainingstage-Zähler ----------

async function getWeeklyTrainingDayCount() {
  const now = new Date();
  const day = now.getUTCDay(); // 0 = Sonntag
  const diffToMonday = day === 0 ? 6 : day - 1;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - diffToMonday);
  monday.setUTCHours(0, 0, 0, 0);

  const url = `${process.env.SUPABASE_URL}/rest/v1/workouts?select=logged_at&logged_at=gte.${monday.toISOString()}`;
  const res = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
    },
  });
  if (!res.ok) return "?";
  const rows = await res.json();
  const distinctDays = new Set(rows.map((r) => r.logged_at.split("T")[0]));
  return distinctDays.size;
}

// ---------- Schritte-Feedback ----------

async function checkStepsFeedback() {
  try {
    const todayStr = new Date().toISOString().split("T")[0];
    const url = `${process.env.SUPABASE_URL}/rest/v1/daily_steps?logged_at=eq.${todayStr}`;
    const res = await fetch(url, {
      headers: {
        apikey: process.env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      },
    });
    if (!res.ok) return null;
    const rows = await res.json();
    const totalToday = rows.reduce((s, r) => s + (r.steps || 0), 0);

    const goalRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/training_goals?notes=ilike.*Schritt*&order=updated_at.desc&limit=1`,
      {
        headers: {
          apikey: process.env.SUPABASE_SECRET_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
        },
      }
    );
    const goalRows = goalRes.ok ? await goalRes.json() : [];
    const goalMatch = goalRows[0]?.notes?.match(/(\d+)[.,]?(\d{3})?\s*Schritte/i);
    const stepGoal = goalMatch ? parseInt(goalMatch[1] + (goalMatch[2] || ""), 10) : 10000;

    return `${totalToday.toLocaleString("de-DE")} / ${stepGoal.toLocaleString("de-DE")} Schritte heute`;
  } catch (err) {
    console.error("Fehler beim Schritte-Feedback:", err);
    return null;
  }
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

// ---------- Fortschrittsfotos ----------

async function handlePhotoMessage(chatId, message) {
  try {
    const photos = message.photo; // Telegram schickt mehrere Größen, die letzte ist die größte
    const fileId = photos[photos.length - 1].file_id;
    const imageBuffer = await downloadTelegramFile(fileId);

    const fileName = `progress_${Date.now()}.jpg`;
    await uploadToSupabaseStorage(fileName, imageBuffer);
    const signedUrl = await getSignedPhotoUrl(fileName);

    // Das allererste Foto holen, um einen echten visuellen Vergleich zu ermöglichen
    let firstPhotoBuffer = null;
    let isFirstPhotoEver = false;
    try {
      const firstPhotoRow = await getFirstPhotoRow();
      if (firstPhotoRow && firstPhotoRow.photo_url) {
        const firstRes = await fetch(firstPhotoRow.photo_url);
        if (firstRes.ok) {
          const arrBuf = await firstRes.arrayBuffer();
          firstPhotoBuffer = Buffer.from(arrBuf);
        }
      } else {
        isFirstPhotoEver = true;
      }
    } catch (fetchErr) {
      console.error("Konnte erstes Foto nicht laden für Vergleich:", fetchErr);
    }

    // KI-Schätzung des Körperfettanteils + Vergleich zum ersten Foto (grobe visuelle Einschätzung)
    let bodyFatEstimate = null;
    let estimateNote = null;
    try {
      const estimate = await estimateBodyFatFromPhoto(imageBuffer, firstPhotoBuffer);
      bodyFatEstimate = estimate.body_fat_percent || null;
      estimateNote = estimate.note || null;
    } catch (visionErr) {
      console.error("Körperfett-Schätzung fehlgeschlagen:", visionErr);
    }

    await saveToSupabase("body_metrics", {
      photo_url: signedUrl,
      photo_note: message.caption || estimateNote,
      body_fat_percent: bodyFatEstimate,
    });

    const estimateText = bodyFatEstimate
      ? `\n📊 Geschätzter Körperfettanteil: ~${bodyFatEstimate}% (grobe visuelle Schätzung, keine Messung)${estimateNote ? `\n${estimateNote}` : ""}`
      : "";
    const firstPhotoNote = isFirstPhotoEver ? "\n📸 Das ist dein erstes Fortschrittsfoto - ab jetzt kann verglichen werden!" : "";
    await sendTelegramMessage(chatId, `✅ Fortschrittsfoto gespeichert.${estimateText}${firstPhotoNote}`);
  } catch (err) {
    console.error("Fehler beim Foto-Upload:", err);
    await sendTelegramMessage(chatId, `❌ Fehler beim Foto-Upload: ${err.message}`);
  }
}

async function getFirstPhotoRow() {
  const url = `${process.env.SUPABASE_URL}/rest/v1/body_metrics?photo_url=not.is.null&order=logged_at.asc&limit=1`;
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

async function estimateBodyFatFromPhoto(imageBuffer, firstPhotoBuffer) {
  const base64Image = imageBuffer.toString("base64");

  const content = [];
  let systemPrompt;

  if (firstPhotoBuffer) {
    const base64First = firstPhotoBuffer.toString("base64");
    systemPrompt = `Du bist ein erfahrener Fitness-Coach. Du bekommst zwei Fotos: das ERSTE (ältestes Fortschrittsfoto) und das AKTUELLE. Schätze den ungefähren Körperfettanteil auf dem AKTUELLEN Foto (grobe visuelle Einschätzung, keine exakte Messung). Vergleiche außerdem sichtbar: Hat sich der Körper seit dem ersten Foto sichtbar verändert (Definition, Bauch, generelle Silhouette)? Sei ehrlich, auch wenn kein Unterschied erkennbar ist. Antworte NUR mit validem JSON, ohne Markdown: {"body_fat_percent": Zahl, "note": "kurzer Vergleichs-Kommentar zum ersten Foto"}`;
    content.push({ type: "text", text: "Erstes Foto (Ausgangspunkt):" });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64First } });
    content.push({ type: "text", text: "Aktuelles Foto:" });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64Image } });
    content.push({ type: "text", text: "Schätze den Körperfettanteil auf dem aktuellen Foto und vergleiche mit dem ersten." });
  } else {
    systemPrompt = `Du bist ein erfahrener Fitness-Coach. Schätze anhand des Fotos den ungefähren Körperfettanteil der abgebildeten Person. Das ist nur eine grobe visuelle Einschätzung, keine exakte Messung - sei ehrlich in deiner Unsicherheit. Antworte NUR mit validem JSON, ohne Markdown: {"body_fat_percent": Zahl, "note": "ein kurzer Kommentar"}`;
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64Image } });
    content.push({ type: "text", text: "Schätze den Körperfettanteil auf diesem Foto." });
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 500,
      system: systemPrompt,
      messages: [{ role: "user", content }],
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`Claude Vision Fehler (${res.status}): ${JSON.stringify(data)}`);

  const textBlock = data.content && data.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("Keine Text-Antwort von Claude Vision erhalten");

  return parseJson(textBlock.text);
}

async function uploadToSupabaseStorage(fileName, buffer) {
  const url = `${process.env.SUPABASE_URL}/storage/v1/object/progress-photos/${fileName}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      "Content-Type": "image/jpeg",
    },
    body: buffer,
  });
  if (!res.ok) {
    throw new Error(`Supabase Storage Upload-Fehler (${res.status}): ${await res.text()}`);
  }
}

async function getSignedPhotoUrl(fileName) {
  const url = `${process.env.SUPABASE_URL}/storage/v1/object/sign/progress-photos/${fileName}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expiresIn: 315360000 }), // ~10 Jahre gültig
  });
  if (!res.ok) {
    throw new Error(`Supabase Storage Sign-Fehler (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return `${process.env.SUPABASE_URL}/storage/v1${data.signedURL}`;
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

    return await callClaude(systemPrompt, userMsg, 1000, "claude-sonnet-5");
  } catch (err) {
    console.error("Fehler beim Body-Progress-Feedback:", err);
    return null;
  }
}

// ---------- Progressions-Feedback ----------

async function checkProgressionFeedback(exerciseName, chatId) {
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

    const feedback = await callClaude(systemPrompt, userMsg, 200, "claude-haiku-4-5-20251001");

    // Falls es eine echte Frage ist (nicht nur "weiter so wie bisher"), merken, dass eine Antwort erwartet wird
    if (feedback && !/weiter so wie bisher/i.test(feedback) && chatId) {
      await savePendingConfirmation(chatId, feedback);
    }

    return feedback;
  } catch (err) {
    console.error("Fehler beim Progressions-Feedback:", err);
    return null; // Feedback ist ein Bonus, darf das Loggen nicht blockieren
  }
}

// ---------- Offene Fragen merken (z.B. "war die Ausführung sauber?") ----------

async function savePendingConfirmation(chatId, question) {
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/pending_confirmations?on_conflict=chat_id`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ chat_id: chatId, question }),
  });
}

async function getPendingConfirmation(chatId) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/pending_confirmations?chat_id=eq.${chatId}`, {
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
    },
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows && rows[0] ? rows[0] : null;
}

async function deletePendingConfirmation(chatId) {
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/pending_confirmations?chat_id=eq.${chatId}`, {
    method: "DELETE",
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
    },
  });
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

  // Equipment steckt als Freitext in einer der Zielnotizen - explizit rausziehen und prominent platzieren
  const equipmentNote = goals.find((g) => g.notes && /equipment/i.test(g.notes));
  const equipmentText = equipmentNote ? equipmentNote.notes : "Kein Equipment hinterlegt - bitte nachfragen/allgemein halten.";

  const context = `VERFÜGBARES EQUIPMENT (STRIKT EINHALTEN): ${equipmentText}

Bisherige Workouts (neueste zuerst): ${JSON.stringify(workouts)}
Körperwerte-Verlauf: ${JSON.stringify(bodyMetrics)}
Trainingsziele: ${JSON.stringify(goals)}
${constraints ? `Zusätzlicher Wunsch der Person: ${constraints}` : ""}`;

  const systemPrompt = `Du bist ein erfahrener Personal Trainer. Erstelle basierend auf den Trainingsdaten, Körperwerten und Zielen der Person einen konkreten, strukturierten Trainingsplan. Falls die Person einen zusätzlichen Wunsch genannt hat (z.B. Anzahl Trainingstage), halte dich exakt daran - auch wenn das vom Optimum abweicht, hat der Wunsch der Person Vorrang.

ABSOLUT KRITISCH - Equipment-Regel: Die Person hat NUR das oben unter "VERFÜGBARES EQUIPMENT" genannte Zubehör. Bevor du IRGENDEINE Übung in den Plan aufnimmst, prüfe explizit: "Kann das mit genau diesem Equipment ausgeführt werden?" Falls nicht, wähle eine machbare Alternative für dieselbe Muskelgruppe. Nenne NIEMALS Übungen, die Kabelzug, Latzug-Maschine, Langhantel, Beinpresse oder ähnliches erfordern, außer diese Geräte wurden explizit genannt. Geh JEDE Übung im fertigen Plan nochmal einzeln durch, bevor du antwortest, und ersetze alles, was nicht passt.

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

  const systemPrompt = `Du bist ein persönlicher Assistent. Beantworte die Frage der Person basierend AUSSCHLIESSLICH auf den mitgelieferten Daten.

Falls es eine einfache Faktenfrage ist (z.B. "wie viel hab ich ausgegeben"): kurz und konkret antworten (2-4 Sätze).

Falls es eine OFFENE oder GEFÜHLSBASIERTE Frage ist (z.B. "ich hab das Gefühl, ich mache keinen Progress", "läuft's finanziell besser"): schau dir den echten Trend in den Daten an (Verlauf über Zeit, nicht nur den letzten Wert) und gib eine ehrliche, aber unterstützende Einschätzung - bestätige das Gefühl der Person NICHT automatisch, wenn die Daten etwas anderes zeigen (z.B. wenn tatsächlich Fortschritt da ist, auch wenn er sich nicht danach anfühlt), aber beschönige auch nichts, wenn die Daten wirklich Stillstand/Verschlechterung zeigen. Etwas mehr Raum ist hier okay (4-6 Sätze), aber bleib konkret und beziehe dich auf echte Zahlen/Einträge, keine Plattitüden.

Falls die Daten nicht ausreichen, sag das ehrlich.`;

  return await callClaude(systemPrompt, `Frage: ${question}${context}`, 800, "claude-sonnet-5");
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
