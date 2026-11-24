// On-device AI for GlenCal. The model runs inside the app on the iPhone's GPU (WebGPU).
// Model files are downloaded once from Hugging Face and cached; your text is never sent anywhere.

const LIB = './vendor/web-llm-0.2.87.js';
export const MODELS = {
  small: { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', label: 'Standard (about 1 GB download)' },
  large: { id: 'Qwen2.5-3B-Instruct-q4f16_1-MLC', label: 'Larger, smarter, slower (about 2 GB download)' }
};
const CATS = ['festive', 'money', 'travel', 'health', 'fitness', 'celebrate', 'food', 'work', 'errands', 'social', 'other'];

let lib = null, engine = null, loadedId = null;
async function L() { return lib || (lib = await import(LIB)); }

export function supported() { return !!navigator.gpu; }
export function loaded(size) { return !!engine && loadedId === MODELS[size].id; }
export async function downloaded(size) { return (await L()).hasModelInCache(MODELS[size].id); }

export async function load(size, onProgress) {
  const id = MODELS[size].id;
  if (engine && loadedId === id) return;
  const w = await L();
  if (engine) { try { await engine.unload(); } catch (e) {} engine = null; loadedId = null; }
  engine = await w.CreateMLCEngine(id, { initProgressCallback: (p) => onProgress && onProgress(p.progress || 0, p.text || '') });
  loadedId = id;
}

export async function remove(size) {
  const w = await L();
  if (engine && loadedId === MODELS[size].id) { try { await engine.unload(); } catch (e) {} engine = null; loadedId = null; }
  await w.deleteModelAllInfoInCache(MODELS[size].id);
}

const ENTRY = {
  type: 'object',
  properties: {
    date: { type: 'string' }, time: { type: 'string' }, title: { type: 'string' },
    place: { type: 'string' }, note: { type: 'string' }, category: { type: 'string', enum: CATS }
  },
  required: ['date', 'time', 'title', 'place', 'note', 'category']
};

async function json(messages, schema, maxTokens) {
  if (!engine) throw new Error('The AI model is not loaded.');
  const r = await engine.chat.completions.create({
    messages, temperature: 0, max_tokens: maxTokens || 900,
    response_format: { type: 'json_object', schema: JSON.stringify(schema) }
  });
  return JSON.parse(r.choices[0].message.content);
}

const RULES = `Rewrite each title in clear, correct English: fix spelling, grammar and capital letters.
Keep titles short but complete (3 to 10 words): who, what and any key detail. Keep every name, number, amount, code and company exactly as written.
Remove filler such as "need to", "remember to", "gonna", and leave the date and time out of the title. Never add facts that are not in the text. If unsure what something means, keep the original words.
Dates written with numbers are day first: 3/12 means 3 December. Resolve "tmr", "next Fri", "Sat" and similar against today's date. Dates are YYYY-MM-DD.
Times are 24-hour HH:MM, or HH:MM-HH:MM for a range, or empty.
Categories: festive = Christmas, New Year, Chinese New Year and similar; celebrate = birthdays, weddings, parties; money = insurance, tax, bills, bank; food = meals and drinks; work = meetings, deadlines, reports; errands = haircut, shopping, pickups; social = meeting friends; other = anything else.
Put a venue in "place". Put extra details that don't fit the title, such as what to bring or ask, in "note". Use empty strings for anything missing.`;

const EXAMPLES = `Example: "need to call agent abt hospital plan renewal tmr, ask if rider cover private ward" -> title "Call agent about hospital plan renewal", note "Ask if the rider covers private wards", category "money".
Example: "dinner w mum n dad sat 730 at jumbo" -> title "Dinner with Mum and Dad", time "19:30", place "Jumbo", category "food".`;

// Turns rough text into entries.
export async function extract(text, today) {
  const out = await json([
    { role: 'system', content: `You turn rough notes and messages into calendar entries for one person.\n${RULES}\n${EXAMPLES}\nList every event, appointment, deadline or task in the text. Do not invent entries. If an entry has no clear date, use "" for date.` },
    { role: 'user', content: `Today is ${today}.\n\nText:\n${text}` }
  ], { type: 'object', properties: { entries: { type: 'array', items: ENTRY } }, required: ['entries'] }, 1200);
  return out.entries || [];
}

// Tidies rough notes into a short title and clean bullet points, keeping every fact.
export async function tidy(text) {
  return json([
    { role: 'system', content: `You tidy one person's rough notes (call notes, market levels, ideas) into clean bullet points.
Keep every fact, name, number, level, date and currency pair exactly as written. Fix spelling and grammar. One idea per bullet, short and clear.
Never add facts, opinions or advice that are not in the text. If something is unclear, keep the original words.
Also give a short title (2 to 6 words) describing the note.` },
    { role: 'user', content: text }
  ], { type: 'object', properties: { title: { type: 'string' }, bullets: { type: 'array', items: { type: 'string' } } }, required: ['title', 'bullets'] }, 900);
}

// Answers a question or proposes changes, using only the entries it is given.
// history: [{q, a}] of recent turns.
export async function ask(question, today, contextLines, history) {
  const msgs = [{ role: 'system', content:
`You are the assistant inside GlenCal, Glen's private calendar. Today is ${today}.
Relevant calendar entries, one per line (id | date weekday time | title @ place | note):
${contextLines || '(none found)'}

Answer only from these entries; if something isn't listed, say you can't find it. Never invent entries.
If Glen asks to add, move, change or delete something, fill "add", "update" or "delete". Glen approves every change on screen, so say what you proposed. For "update", give the entry id and only the fields that change (empty string = keep). For "delete", give ids.
${RULES}
"reply": brief, plain English. When listing entries use short lines like "28 Nov Sat 11am – Haircut".` }];
  (history || []).slice(-2).forEach(h => { msgs.push({ role: 'user', content: h.q }); msgs.push({ role: 'assistant', content: JSON.stringify({ reply: h.a, add: [], update: [], delete: [] }) }); });
  msgs.push({ role: 'user', content: question });
  return json(msgs, {
    type: 'object',
    properties: {
      reply: { type: 'string' },
      add: { type: 'array', items: ENTRY },
      update: { type: 'array', items: { type: 'object', properties: {
        id: { type: 'string' }, date: { type: 'string' }, time: { type: 'string' },
        title: { type: 'string' }, place: { type: 'string' }, note: { type: 'string' } },
        required: ['id', 'date', 'time', 'title', 'place', 'note'] } },
      delete: { type: 'array', items: { type: 'string' } }
    },
    required: ['reply', 'add', 'update', 'delete']
  }, 900);
}
