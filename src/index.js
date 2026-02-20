const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Telegraf } = require("telegraf");
require("dotenv").config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const ADMIN_IDS = parseAdminIds(process.env.ADMIN_IDS);
const DISCOUNT_PERCENT = 10;
const COUPON_PREFIX = `D${DISCOUNT_PERCENT}`;
const MIN_COUPON_BODY_LENGTH = 6;
const CAPTCHA_STEPS = readPositiveInteger(process.env.CAPTCHA_STEPS, 2);
const CAPTCHA_TTL_MS = readPositiveInteger(process.env.CAPTCHA_TTL_MS, 90_000);
const CAPTCHA_MAX_FAILURES = readPositiveInteger(process.env.CAPTCHA_MAX_FAILURES, 3);
const CAPTCHA_COOLDOWN_MS = readPositiveInteger(process.env.CAPTCHA_COOLDOWN_MS, 10 * 60_000);
const CAPTCHA_TRUST_MS = readPositiveInteger(process.env.CAPTCHA_TRUST_MS, 30 * 60_000);
const CAPTCHA_OPTIONS_COUNT = 6;
const DATA_FILE = process.env.DATA_FILE
  ? path.resolve(process.env.DATA_FILE)
  : path.join(__dirname, "..", "data", "store.json");
const humanVerificationByUserId = new Map();

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is required in .env");
}
if (!CHANNEL_ID) {
  throw new Error("CHANNEL_ID is required in .env");
}
if (ADMIN_IDS.size === 0) {
  throw new Error("ADMIN_IDS is required in .env");
}

ensureStoreFile();

const bot = new Telegraf(BOT_TOKEN);

bot.start(async (ctx) => {
  const lines = [
    "Ciao.",
    `Rilascio un coupon del ${DISCOUNT_PERCENT}% solo agli iscritti al canale.`,
    "Per /coupon e richiesta una verifica anti-bot.",
    "",
    "Comandi:",
    "/coupon - ottieni un coupon",
    "/mycoupon - mostra il tuo coupon",
  ];

  if (hasAdminAccess(ctx)) {
    lines.push(
      "",
      "Comandi admin:",
      "/check CODICE - verifica la validita del coupon",
      "/use CODICE - segna il coupon come usato"
    );
  }

  await ctx.reply(
    lines.join("\n")
  );
});

bot.command("coupon", async (ctx) => {
  if (!ctx.from) {
    return;
  }

  const verification = await ensureHumanVerification(ctx);
  if (!verification.passed) {
    return;
  }

  await processCouponRequest(ctx);
});

bot.command("mycoupon", async (ctx) => {
  if (!ctx.from) {
    return;
  }

  const state = loadStore();
  const code = state.couponByUserId[String(ctx.from.id)];
  if (!code || !state.coupons[code]) {
    await ctx.reply("Non hai ancora un coupon. Usa il comando /coupon.");
    return;
  }

  const coupon = state.coupons[code];
  const status = coupon.used ? "usato" : "non usato";
  await replyCouponCard(ctx, coupon, status);
});

bot.command("check", async (ctx) => {
  if (!hasAdminAccess(ctx)) {
    await ctx.reply("Questo comando e disponibile solo per l'amministratore.");
    return;
  }

  const code = extractCommandArg(ctx.message?.text);
  if (!code) {
    await ctx.reply("Uso: /check CODICE");
    return;
  }

  const state = loadStore();
  const result = await validateCoupon(state, code);
  await ctx.reply(formatValidationResult(result), { parse_mode: "HTML" });
});

bot.command("use", async (ctx) => {
  if (!hasAdminAccess(ctx)) {
    await ctx.reply("Questo comando e disponibile solo per l'amministratore.");
    return;
  }

  const code = extractCommandArg(ctx.message?.text);
  if (!code) {
    await ctx.reply("Uso: /use CODICE");
    return;
  }

  const state = loadStore();
  const validation = await validateCoupon(state, code);
  if (!validation.exists || !validation.valid) {
    await ctx.reply(formatValidationResult(validation), { parse_mode: "HTML" });
    return;
  }

  const normalizedCode = normalizeCouponCode(code);
  const coupon = state.coupons[normalizedCode];
  coupon.used = true;
  coupon.usedAt = new Date().toISOString();
  coupon.usedByAdminId = String(ctx.from.id);
  saveStore(state);

  await ctx.reply(
    [
      "Coupon riscattato: ora non e piu valido.",
      `Codice: ${formatCode(coupon.code)}`,
      `Proprietario: ${formatOwner(coupon)}`,
      `Data riscatto: ${coupon.usedAt}`,
      "",
      "Copia rapida:",
      formatCode(coupon.code),
    ].join("\n")
    ,
    { parse_mode: "HTML" }
  );
});

bot.on("callback_query", async (ctx, next) => {
  const payload = parseCaptchaPayload(ctx.callbackQuery?.data);
  if (!payload) {
    if (typeof next === "function") {
      await next();
    }
    return;
  }
  await handleCaptchaCallback(ctx, payload);
});

bot.catch((error) => {
  console.error("Bot error:", error);
});

bot.launch().then(() => {
  console.log("Bot started");
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

function parseAdminIds(value) {
  if (!value) {
    return new Set();
  }

  const ids = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => Number(item))
    .filter(Number.isInteger);

  return new Set(ids);
}

function readPositiveInteger(rawValue, fallbackValue) {
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallbackValue;
  }
  return parsed;
}

function ensureStoreFile() {
  const initial = {
    lastCouponId: 0,
    coupons: {},
    couponByUserId: {},
  };

  const directory = path.dirname(DATA_FILE);
  fs.mkdirSync(directory, { recursive: true });

  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2), "utf8");
  }
}

function loadStore() {
  const raw = fs.readFileSync(DATA_FILE, "utf8");
  const state = JSON.parse(raw);
  if (
    typeof state !== "object" ||
    state === null ||
    !Number.isInteger(state.lastCouponId) ||
    typeof state.coupons !== "object" ||
    state.coupons === null ||
    typeof state.couponByUserId !== "object" ||
    state.couponByUserId === null
  ) {
    throw new Error("Invalid store format");
  }
  return state;
}

function saveStore(state) {
  const tempFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tempFile, DATA_FILE);
}

async function processCouponRequest(ctx) {
  const userId = Number(ctx.from?.id);
  if (!Number.isInteger(userId)) {
    return;
  }

  const subscription = await checkSubscription(userId);
  if (!subscription.ok) {
    await ctx.reply(
      "Impossibile verificare l'iscrizione. Assicurati che il bot sia nel canale e abbia i permessi di amministratore."
    );
    return;
  }

  if (!subscription.subscribed) {
    await ctx.reply(
      "Non sei iscritto al canale. Iscriviti al canale e riprova con /coupon."
    );
    return;
  }

  const state = loadStore();
  const existingCode = state.couponByUserId[String(userId)];
  if (existingCode) {
    const existing = state.coupons[existingCode];
    if (!existing) {
      await ctx.reply(
        "Nel sistema risulta che hai gia ricevuto un coupon. Non e possibile riceverne un altro."
      );
      return;
    }

    const status = existing.used ? "usato" : "non usato";
    await replyCouponCard(
      ctx,
      existing,
      status,
      ["Rilascio unico: ogni utente puo ricevere solo 1 coupon per sempre."]
    );
    return;
  }

  const coupon = issueCoupon(state, ctx.from);
  saveStore(state);
  await replyCouponCard(
    ctx,
    coupon,
    "non usato",
    ["Salva questo codice e invialo all'amministratore durante l'acquisto."]
  );
}

async function ensureHumanVerification(ctx) {
  const userId = Number(ctx.from?.id);
  if (!Number.isInteger(userId)) {
    return { passed: false };
  }

  const key = String(userId);
  const now = Date.now();
  const state = getHumanVerificationState(key);
  clearExpiredHumanVerificationState(state, now);

  if (state.cooldownUntil > now) {
    await ctx.reply(
      `Troppe risposte errate. Riprova tra ${Math.ceil((state.cooldownUntil - now) / 1000)} secondi.`
    );
    return { passed: false };
  }

  if (state.trustedUntil > now) {
    return { passed: true };
  }

  if (state.pending) {
    await ctx.reply(
      [
        "Hai gia una verifica anti-bot attiva.",
        `Scade tra ${Math.ceil((state.pending.expiresAt - now) / 1000)} secondi.`,
        "Premi uno dei pulsanti della challenge gia inviata o riprova /coupon alla scadenza.",
      ].join("\n")
    );
    return { passed: false };
  }

  await sendCaptchaChallenge(ctx, key, state, 1);
  return { passed: false };
}

async function sendCaptchaChallenge(ctx, userId, state, step) {
  const challenge = createCaptchaChallenge(userId, step);
  state.pending = challenge;
  const lines = [
    `Verifica anti-bot (${step}/${CAPTCHA_STEPS})`,
    `Tempo massimo: ${Math.ceil(CAPTCHA_TTL_MS / 1000)} secondi`,
    challenge.question,
    "Seleziona la risposta corretta:",
  ];
  await ctx.reply(lines.join("\n"), {
    reply_markup: {
      inline_keyboard: buildCaptchaKeyboard(userId, challenge.challengeId, challenge.options),
    },
  });
}

function getHumanVerificationState(userId) {
  const existing = humanVerificationByUserId.get(userId);
  if (existing) {
    return existing;
  }

  const created = {
    failedAttempts: 0,
    cooldownUntil: 0,
    trustedUntil: 0,
    pending: null,
  };
  humanVerificationByUserId.set(userId, created);
  return created;
}

function clearExpiredHumanVerificationState(state, now) {
  if (state.pending && state.pending.expiresAt <= now) {
    state.pending = null;
  }
}

function createCaptchaChallenge(userId, step) {
  const operation = buildCaptchaOperation();
  const challengeId = crypto.randomBytes(8).toString("hex");
  return {
    challengeId,
    step,
    correctAnswer: operation.answer,
    options: buildCaptchaOptions(operation.answer),
    question: `${operation.left} ${operation.symbol} ${operation.right} = ?`,
    expiresAt: Date.now() + CAPTCHA_TTL_MS,
    userId,
  };
}

function buildCaptchaOperation() {
  const mode = crypto.randomInt(0, 3);
  if (mode === 0) {
    const left = crypto.randomInt(7, 40);
    const right = crypto.randomInt(2, 18);
    return { left, right, symbol: "-", answer: left - right };
  }

  if (mode === 1) {
    const left = crypto.randomInt(4, 30);
    const right = crypto.randomInt(3, 22);
    return { left, right, symbol: "+", answer: left + right };
  }

  const left = crypto.randomInt(2, 11);
  const right = crypto.randomInt(2, 11);
  return { left, right, symbol: "*", answer: left * right };
}

function buildCaptchaOptions(correctAnswer) {
  const options = new Set([correctAnswer]);
  while (options.size < CAPTCHA_OPTIONS_COUNT) {
    const offset = crypto.randomInt(-10, 11);
    const candidate = correctAnswer + offset;
    if (candidate >= 0) {
      options.add(candidate);
    }
  }
  return shuffleArray(Array.from(options));
}

function buildCaptchaKeyboard(userId, challengeId, options) {
  const rows = [];
  for (let index = 0; index < options.length; index += 3) {
    const row = options.slice(index, index + 3).map((value) => ({
      text: String(value),
      callback_data: buildCaptchaPayload(userId, challengeId, value),
    }));
    rows.push(row);
  }
  return rows;
}

function shuffleArray(values) {
  const copy = values.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function buildCaptchaPayload(userId, challengeId, answer) {
  return `cap:${userId}:${challengeId}:${answer}`;
}

function parseCaptchaPayload(payload) {
  if (typeof payload !== "string" || !payload.startsWith("cap:")) {
    return null;
  }

  const parts = payload.split(":");
  if (parts.length !== 4) {
    return null;
  }

  const userId = parts[1];
  const challengeId = parts[2];
  const answer = Number(parts[3]);
  if (!userId || !challengeId || !Number.isInteger(answer)) {
    return null;
  }

  return { userId, challengeId, answer };
}

async function handleCaptchaCallback(ctx, payload) {
  const callerUserId = String(ctx.from?.id || "");
  if (!callerUserId) {
    await safeAnswerCallback(ctx, "Utente non valido.");
    return;
  }

  if (payload.userId !== callerUserId) {
    await safeAnswerCallback(ctx, "Questa verifica non e per te.");
    return;
  }

  const now = Date.now();
  const state = getHumanVerificationState(callerUserId);
  clearExpiredHumanVerificationState(state, now);

  if (state.cooldownUntil > now) {
    await safeAnswerCallback(
      ctx,
      `In pausa anti-bot. Riprova tra ${Math.ceil((state.cooldownUntil - now) / 1000)}s.`
    );
    return;
  }

  if (!state.pending) {
    await safeAnswerCallback(ctx, "Verifica scaduta. Usa /coupon per una nuova challenge.");
    await safeEditMessageText(ctx, "Verifica scaduta. Usa /coupon per crearne una nuova.");
    return;
  }

  if (state.pending.challengeId !== payload.challengeId) {
    await safeAnswerCallback(ctx, "Challenge non valida o scaduta.");
    return;
  }

  if (state.pending.correctAnswer !== payload.answer) {
    state.pending = null;
    state.failedAttempts += 1;
    await safeAnswerCallback(ctx, "Risposta errata.");
    await safeEditMessageText(ctx, "Risposta errata. Usa /coupon per riprovare.");
    if (state.failedAttempts >= CAPTCHA_MAX_FAILURES) {
      state.failedAttempts = 0;
      state.cooldownUntil = now + CAPTCHA_COOLDOWN_MS;
      await ctx.reply(
        `Troppi errori. Verifica bloccata per ${Math.ceil(CAPTCHA_COOLDOWN_MS / 1000)} secondi.`
      );
    }
    return;
  }

  const currentStep = state.pending.step;
  state.pending = null;
  state.failedAttempts = 0;
  await safeEditMessageText(ctx, `Step ${currentStep}/${CAPTCHA_STEPS} completato.`);
  await safeAnswerCallback(ctx, "Corretto.");

  if (currentStep < CAPTCHA_STEPS) {
    await sendCaptchaChallenge(ctx, callerUserId, state, currentStep + 1);
    return;
  }

  state.trustedUntil = now + CAPTCHA_TRUST_MS;
  await ctx.reply("Verifica completata. Procedo con il coupon.");
  await processCouponRequest(ctx);
}

async function safeAnswerCallback(ctx, text) {
  try {
    await ctx.answerCbQuery(text);
  } catch (error) {
    console.error("answerCbQuery failed:", error.message);
  }
}

async function safeEditMessageText(ctx, text) {
  try {
    await ctx.editMessageText(text);
  } catch (error) {
    console.error("editMessageText failed:", error.message);
  }
}

function issueCoupon(state, user) {
  state.lastCouponId += 1;
  const code = buildCouponCode(state.lastCouponId);

  if (state.coupons[code]) {
    throw new Error("Coupon collision detected");
  }

  const coupon = {
    couponId: state.lastCouponId,
    code,
    discountPercent: DISCOUNT_PERCENT,
    userId: String(user.id),
    username: user.username || null,
    firstName: user.first_name || null,
    lastName: user.last_name || null,
    issuedAt: new Date().toISOString(),
    used: false,
    usedAt: null,
    usedByAdminId: null,
  };

  state.coupons[code] = coupon;
  state.couponByUserId[String(user.id)] = code;
  return coupon;
}

function buildCouponCode(couponId) {
  const body = couponId
    .toString(36)
    .toUpperCase()
    .padStart(MIN_COUPON_BODY_LENGTH, "0");
  return `${COUPON_PREFIX}-${body}`;
}

function hasAdminAccess(ctx) {
  if (!ctx.from) {
    return false;
  }
  return ADMIN_IDS.has(Number(ctx.from.id));
}

function extractCommandArg(text) {
  if (!text) {
    return "";
  }
  const parts = text.trim().split(/\s+/);
  if (parts.length < 2) {
    return "";
  }
  return normalizeCouponCode(parts[1]);
}

function normalizeCouponCode(code) {
  return String(code || "").trim().toUpperCase();
}

async function checkSubscription(userId) {
  try {
    const member = await bot.telegram.getChatMember(CHANNEL_ID, userId);
    return {
      ok: true,
      subscribed: isSubscribedMember(member),
    };
  } catch (error) {
    console.error("Subscription check failed:", error.message);
    return {
      ok: false,
      subscribed: false,
    };
  }
}

function isSubscribedMember(member) {
  if (!member || !member.status) {
    return false;
  }

  if (member.status === "creator" || member.status === "administrator" || member.status === "member") {
    return true;
  }

  if (member.status === "restricted" && member.is_member === true) {
    return true;
  }

  return false;
}

async function validateCoupon(state, code) {
  const normalizedCode = normalizeCouponCode(code);
  const coupon = state.coupons[normalizedCode];
  if (!coupon) {
    return {
      exists: false,
      valid: false,
      reason: "not_found",
      code: normalizedCode,
    };
  }

  if (coupon.used) {
    return {
      exists: true,
      valid: false,
      reason: "used",
      coupon,
    };
  }

  const subscription = await checkSubscription(Number(coupon.userId));
  if (!subscription.ok) {
    return {
      exists: true,
      valid: false,
      reason: "subscription_check_error",
      coupon,
    };
  }

  if (!subscription.subscribed) {
    return {
      exists: true,
      valid: false,
      reason: "unsubscribed",
      coupon,
    };
  }

  return {
    exists: true,
    valid: true,
    reason: "valid",
    coupon,
  };
}

function formatValidationResult(result) {
  if (!result.exists) {
    return `Coupon ${formatCode(result.code)} non trovato. Stato: non valido.`;
  }

  if (result.reason === "used") {
    return [
      "Stato: non valido.",
      "Motivo: coupon gia usato.",
      `Codice: ${formatCode(result.coupon.code)}`,
      `Proprietario: ${formatOwner(result.coupon)}`,
      `Usato il: ${result.coupon.usedAt || "data non disponibile"}`,
      "",
      "Copia rapida:",
      formatCode(result.coupon.code),
    ].join("\n");
  }

  if (result.reason === "unsubscribed") {
    return [
      "Stato: non valido.",
      "Motivo: il proprietario del coupon non e piu iscritto al canale.",
      `Codice: ${formatCode(result.coupon.code)}`,
      `Proprietario: ${formatOwner(result.coupon)}`,
      "",
      "Copia rapida:",
      formatCode(result.coupon.code),
    ].join("\n");
  }

  if (result.reason === "subscription_check_error") {
    return [
      "Stato: non valido.",
      "Motivo: impossibile verificare l'iscrizione del proprietario del coupon.",
      "Controlla i permessi del bot nel canale.",
    ].join("\n");
  }

  return [
    "Stato: valido.",
    `Codice: ${formatCode(result.coupon.code)}`,
    `Sconto: ${result.coupon.discountPercent}%`,
    `Proprietario: ${formatOwner(result.coupon)}`,
    `Emesso il: ${result.coupon.issuedAt}`,
    "",
    "Copia rapida:",
    formatCode(result.coupon.code),
  ].join("\n");
}

function formatOwner(coupon) {
  const username = coupon.username ? `@${coupon.username}` : "senza username";
  return `${escapeHtml(username)} (id: ${escapeHtml(coupon.userId)})`;
}

async function replyCouponCard(ctx, coupon, status, extraLines = []) {
  const lines = [
    `<b>Coupon sconto ${escapeHtml(String(coupon.discountPercent))}%</b>`,
    `Codice: ${formatCode(coupon.code)}`,
    `Stato: ${escapeHtml(status)}`,
  ];

  if (extraLines.length > 0) {
    for (const line of extraLines) {
      lines.push(escapeHtml(line));
    }
  }

  lines.push("", "Copia rapida:", formatCode(coupon.code));
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

function formatCode(code) {
  return `<code>${escapeHtml(String(code || ""))}</code>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
