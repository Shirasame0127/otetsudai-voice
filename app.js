"use strict";
/* お手伝いさん v0.1
   ウェイクワード → 聞き取り → Claude → 声で返事。ブラウザだけで動く。
   ・ウェイクワード待機は、ブラウザの音声認識(SpeechRecognition)で言葉を拾う方式。画面を開いている間だけ動く。
   ・声は、ElevenLabs のキーがあればそれ、無ければ端末の標準の声。
   ・詳しい連携(家電・MCP・経理)は、まだ入れていない。 */

const $ = (s) => document.querySelector(s);

/* ---------- 設定 ---------- */
const DEFAULT_PERSONA =
  "あなたは、持ち主の声のお手伝いさん。親しみやすい日本語の話し言葉で、短く(たいてい1〜3文)答える。" +
  "読み上げられる前提なので、マークダウン・箇条書き・絵文字・URL・記号は使わない。" +
  "分からないことは分からないと言う。できないことを、できたふりをしない。";
const DEFAULTS = {
  apiKey: "",
  model: "claude-haiku-5-5",
  wake: "ねえアシスタント",
  persona: DEFAULT_PERSONA,
  elKey: "",
  elVoice: "",
  elModel: "eleven_v4_turbo", // 表現力重視なら "eleven_v4"
  rate: 1.0,
};
const KEY = "otetsudai-settings-v1";
let cfg = { ...DEFAULTS };
try {
  cfg = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
} catch (e) {}
function saveCfg() {
  try {
    localStorage.setItem(KEY, JSON.stringify(cfg));
  } catch (e) {}
}

/* ---------- 状態表示 ---------- */
const LABEL = {
  off: "タップして起動",
  idle: "呼びかけを待っています",
  listening: "聞いています",
  thinking: "考えています",
  speaking: "話しています",
};
let state = "off";
function setState(s) {
  state = s;
  $("#orb").dataset.state = s;
  $("#orb").setAttribute("aria-label", LABEL[s]);
  $("#status").textContent = LABEL[s];
  $("#btnStop").hidden = s === "off";
  if (s === "idle") $("#heard").textContent = "";
  updateHint();
}
function updateHint() {
  const h = $("#hint");
  if (state === "off") h.textContent = SR ? "「" + wakeList()[0] + "」と呼びかけると反応します。" : "";
  else if (state === "idle") h.textContent = "「" + wakeList()[0] + "」と呼びかける。反応しない時は、丸をタップ。";
  else h.textContent = "";
}

/* ---------- 画面のログ ---------- */
function addMsg(kind, text) {
  const d = document.createElement("div");
  d.className = "msg " + kind;
  d.textContent = text;
  $("#log").appendChild(d);
  d.scrollIntoView({ block: "end", behavior: "smooth" });
  return d;
}

/* ---------- ウェイクワードの照合 ---------- */
// 大文字小文字・カタカナ・記号の違いを無視して照合する。map は元の文字の位置。
function norm(text) {
  let s = "";
  const map = [];
  const small = { ぁ: "あ", ぃ: "い", ぅ: "う", ぇ: "え", ぉ: "お" };
  for (let i = 0; i < text.length; i++) {
    let c = text[i];
    if (/[\s、。，．,.!?！？「」『』・ー〜~-]/.test(c)) continue;
    const code = c.charCodeAt(0);
    if (code >= 0x30a1 && code <= 0x30f6) c = String.fromCharCode(code - 0x60);
    c = (small[c] || c).toLowerCase();
    s += c;
    map.push(i);
  }
  return { s, map };
}
function wakeList() {
  const raw = cfg.wake.split(/[,、]/).map((x) => x.trim()).filter(Boolean);
  return raw.length ? raw : [DEFAULTS.wake];
}
function wakeKeys() {
  const keys = new Set();
  for (const w of wakeList()) {
    const n = norm(w).s;
    if (n) keys.add(n);
    const core = n.replace(/^(ねえ|おい|へい|はい|ちょっと)/, "");
    if (core.length >= 3) keys.add(core);
  }
  return [...keys].sort((a, b) => b.length - a.length);
}
// 見つかれば、元の文字列での「ウェイクワードの終わりの位置」を返す。無ければ -1。
function findWake(text) {
  const { s, map } = norm(text);
  for (const k of wakeKeys()) {
    const i = s.indexOf(k);
    if (i >= 0) return map[i + k.length - 1] + 1;
  }
  return -1;
}

/* ---------- 音声認識 ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let running = false; // 利用者が「起動」している
let paused = false; // 考え中・話し中は聞かない(自分の声を拾わないため)
let wakeIdx = -1;
let listenTimer = null;

function startRec() {
  if (!SR || !running || paused || rec) return;
  const r = new SR();
  rec = r;
  r.lang = "ja-JP";
  r.continuous = true;
  r.interimResults = true;
  r.maxAlternatives = 1;
  r.onresult = onResult;
  r.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      addMsg("err", "マイクが使えません。ブラウザのマイク許可を確認してください。");
      turnOff();
    }
  };
  r.onend = () => {
    if (rec === r) rec = null;
    if (running && !paused) setTimeout(startRec, 250);
  };
  wakeIdx = -1;
  try {
    r.start();
  } catch (e) {}
}
function stopRec() {
  if (!rec) return;
  const r = rec;
  rec = null;
  r.onend = null;
  try {
    r.abort();
  } catch (e) {}
}

function onResult(ev) {
  for (let i = ev.resultIndex; i < ev.results.length; i++) {
    const res = ev.results[i];
    const text = res[0].transcript;
    if (state === "idle") {
      const end = findWake(text);
      if (end < 0) continue;
      wakeIdx = i;
      beep(880);
      enterListening();
    }
    if (state !== "listening") continue;
    let cmd;
    if (wakeIdx >= 0 && i < wakeIdx) continue;
    if (wakeIdx === i) {
      const end = findWake(text);
      cmd = end >= 0 ? text.slice(end) : text;
    } else cmd = text;
    cmd = cmd.replace(/^[\s、。,.]+/, "");
    $("#heard").textContent = cmd ? "「" + cmd + "」" : "…";
    if (res.isFinal && cmd.trim()) {
      submit(cmd.trim());
      return;
    }
  }
}
function enterListening() {
  setState("listening");
  $("#heard").textContent = "…";
  clearTimeout(listenTimer);
  listenTimer = setTimeout(() => {
    if (state === "listening") {
      setState("idle");
      wakeIdx = -1;
    }
  }, 10000);
}

/* ---------- 効果音 ---------- */
let actx = null;
function beep(freq) {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(),
      g = actx.createGain();
    o.frequency.value = freq;
    o.type = "sine";
    g.gain.setValueAtTime(0.0001, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.18, actx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + 0.18);
    o.connect(g).connect(actx.destination);
    o.start();
    o.stop(actx.currentTime + 0.2);
  } catch (e) {}
}

/* ---------- 声を出す ---------- */
let epoch = 0; // 止めるたびに増やして、古い読み上げを捨てる
let chain = Promise.resolve();
let curAudio = null;
let curStop = null;

function browserVoice() {
  const vs = speechSynthesis.getVoices().filter((v) => /^ja/i.test(v.lang));
  return vs.find((v) => /natural|online|google/i.test(v.name)) || vs[0] || null;
}
function speakBrowser(text, my) {
  return new Promise((resolve) => {
    if (my !== epoch) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ja-JP";
    u.rate = cfg.rate;
    const v = browserVoice();
    if (v) u.voice = v;
    u.onend = u.onerror = () => resolve();
    speechSynthesis.speak(u);
  });
}
async function fetchEleven(text) {
  const url = "https://api.elevenlabs.io/v1/text-to-speech/" + encodeURIComponent(cfg.elVoice) + "?output_format=mp3_44100_128";
  const res = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": cfg.elKey, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: cfg.elModel }),
  });
  if (!res.ok) throw new Error("ElevenLabs " + res.status);
  return URL.createObjectURL(await res.blob());
}
function playUrl(url, my) {
  return new Promise((resolve) => {
    if (my !== epoch) return resolve();
    const a = new Audio(url);
    curAudio = a;
    const done = () => {
      URL.revokeObjectURL(url);
      if (curAudio === a) curAudio = null;
      curStop = null;
      resolve();
    };
    curStop = () => {
      a.pause();
      done();
    };
    a.onended = a.onerror = done;
    a.play().catch(done);
  });
}
const useEleven = () => !!(cfg.elKey && cfg.elVoice);

// 文を1つずつ受け取り、順番に読む。ElevenLabs は先に取りに行っておく(待ち時間を減らす)。
function enqueueSpeech(text) {
  const my = epoch;
  if (useEleven()) {
    const pre = fetchEleven(text).catch((e) => {
      addMsg("err", "声の取得に失敗(" + e.message + ")。標準の声で続けます。");
      return null;
    });
    chain = chain.then(async () => {
      const url = await pre;
      if (my !== epoch) return;
      if (url) await playUrl(url, my);
      else await speakBrowser(text, my);
    });
  } else {
    chain = chain.then(() => speakBrowser(text, my));
  }
}
function stopSpeaking() {
  epoch++;
  chain = Promise.resolve();
  try {
    speechSynthesis.cancel();
  } catch (e) {}
  if (curStop) curStop();
}

/* ---------- Claude ---------- */
let history = [];
function systemPrompt() {
  const now = new Date().toLocaleString("ja-JP", { dateStyle: "full", timeStyle: "short" });
  return cfg.persona.trim() + "\n\n現在の日時: " + now;
}
async function askClaude(userText, onDelta, signal) {
  history.push({ role: "user", content: userText });
  if (history.length > 24) history = history.slice(-24);
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({ model: cfg.model, max_tokens: 500, system: systemPrompt(), stream: true, messages: history }),
  });
  if (!res.ok) {
    history.pop();
    let detail = "";
    try {
      detail = (await res.json()).error.message;
    } catch (e) {}
    const hint = res.status === 401 ? "(APIキーを確認してください)" : res.status === 429 ? "(使いすぎか、残高不足かもしれません)" : "";
    throw new Error("Claude " + res.status + hint + " " + detail);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "",
    full = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      try {
        const j = JSON.parse(line.slice(5));
        if (j.type === "content_block_delta" && j.delta && j.delta.type === "text_delta") {
          full += j.delta.text;
          onDelta(j.delta.text);
        }
      } catch (e) {}
    }
  }
  history.push({ role: "assistant", content: full });
  return full;
}

/* ---------- 1回のやりとり ---------- */
let busy = false;
let abort = null;
async function submit(text) {
  if (busy) return;
  if (!cfg.apiKey) {
    addMsg("err", "先に「設定」でClaudeのAPIキーを入れてください。");
    $("#settings").showModal();
    return;
  }
  busy = true;
  clearTimeout(listenTimer);
  paused = true;
  stopRec();
  beep(660);
  addMsg("user", text);
  setState("thinking");
  $("#heard").textContent = "";
  const bubble = addMsg("ai", "…");
  abort = new AbortController();
  let buf = "",
    shown = "",
    started = false;
  const flush = (all) => {
    // 句点などで区切って、できた文から読み始める
    for (;;) {
      const m = buf.match(/^([\s\S]*?[。！？!?\n])/);
      let part = m ? m[1] : null;
      if (!part && buf.length > 60) {
        const k = buf.lastIndexOf("、", 60);
        if (k > 10) part = buf.slice(0, k + 1);
      }
      if (!part) break;
      buf = buf.slice(part.length);
      speakPart(part);
    }
    if (all && buf.trim()) {
      speakPart(buf);
      buf = "";
    }
  };
  const speakPart = (p) => {
    const t = p.replace(/[*#`_>]/g, "").trim();
    if (!t) return;
    if (!started) {
      started = true;
      setState("speaking");
    }
    enqueueSpeech(t);
  };
  try {
    await askClaude(
      text,
      (d) => {
        shown += d;
        buf += d;
        bubble.textContent = shown;
        flush(false);
      },
      abort.signal
    );
    flush(true);
    if (!started) bubble.textContent = bubble.textContent === "…" ? "(返事が空でした)" : bubble.textContent;
    await chain;
  } catch (e) {
    if (e.name !== "AbortError") {
      bubble.remove();
      addMsg("err", e.message || String(e));
    }
  }
  abort = null;
  busy = false;
  paused = false;
  if (running) {
    setState("idle");
    startRec();
  } else setState("off");
}

/* ---------- 起動・停止 ---------- */
let wakeLock = null;
async function lockScreen() {
  try {
    if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
  } catch (e) {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && running) lockScreen();
});
function turnOn() {
  if (!SR) {
    addMsg("err", "このブラウザは音声認識に対応していません。AndroidのChromeで開いてください。文字入力なら使えます。");
    return;
  }
  running = true;
  paused = false;
  beep(740);
  lockScreen();
  setState("idle");
  startRec();
}
function turnOff() {
  running = false;
  paused = false;
  clearTimeout(listenTimer);
  stopRec();
  stopSpeaking();
  if (abort) abort.abort();
  try {
    if (wakeLock) wakeLock.release();
  } catch (e) {}
  setState("off");
}
function interrupt() {
  stopSpeaking();
  if (abort) abort.abort();
}

$("#orb").addEventListener("click", () => {
  if (state === "off") turnOn();
  else if (state === "idle") {
    wakeIdx = -1;
    beep(880);
    enterListening();
  } else if (state === "listening") {
    clearTimeout(listenTimer);
    setState("idle");
  } else interrupt();
});
$("#btnStop").addEventListener("click", turnOff);
$("#btnClear").addEventListener("click", () => {
  history = [];
  $("#log").textContent = "";
  addMsg("err", "会話の記憶を消しました。");
});
$("#typeForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const t = $("#typeInput").value.trim();
  if (!t) return;
  $("#typeInput").value = "";
  submit(t);
});

/* ---------- 設定画面 ---------- */
const FIELDS = ["apiKey", "model", "wake", "persona", "elKey", "elVoice", "elModel", "rate"];
function fillSettings() {
  FIELDS.forEach((k) => ($("#" + k).value = cfg[k]));
  $("#rateOut").textContent = "×" + Number(cfg.rate).toFixed(2);
}
$("#btnSettings").addEventListener("click", () => {
  fillSettings();
  $("#settings").showModal();
});
$("#rate").addEventListener("input", (e) => ($("#rateOut").textContent = "×" + Number(e.target.value).toFixed(2)));
$("#settings").addEventListener("close", () => {
  if ($("#settings").returnValue !== "save") return;
  FIELDS.forEach((k) => (cfg[k] = k === "rate" ? parseFloat($("#" + k).value) : $("#" + k).value.trim()));
  if (!cfg.persona) cfg.persona = DEFAULT_PERSONA;
  if (!cfg.wake) cfg.wake = DEFAULTS.wake;
  if (!cfg.elModel) cfg.elModel = DEFAULTS.elModel;
  saveCfg();
  updateHint();
  addMsg("err", "設定を保存しました。");
});
$("#settings").addEventListener("click", (e) => {
  if (e.target === $("#settings")) $("#settings").close("cancel");
});

/* ---------- はじめ ---------- */
try {
  speechSynthesis.getVoices();
} catch (e) {}
setState("off");
if (!SR) $("#hint").textContent = "音声認識に対応したChrome(Android・PC)で開くと、声で使えます。今は文字入力だけ使えます。";
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
