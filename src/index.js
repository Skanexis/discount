const fs = require("fs");
const path = require("path");
const { Telegraf } = require("telegraf");
require("dotenv").config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const ADMIN_IDS = parseAdminIds(process.env.ADMIN_IDS);
const DISCOUNT_PERCENT = 10;
const COUPON_PREFIX = `D${DISCOUNT_PERCENT}`;
const MIN_COUPON_BODY_LENGTH = 6;
const DATA_FILE = process.env.DATA_FILE
  ? path.resolve(process.env.DATA_FILE)
  : path.join(__dirname, "..", "data", "store.json");

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
  await ctx.reply(
    [
      "Привет.",
      `Я выдаю купон на ${DISCOUNT_PERCENT}% только подписчикам канала.`,
      "",
      "Команды:",
      "/coupon - получить купон",
      "/mycoupon - показать ваш купон",
      "",
      "Админ-команды:",
      "/check КОД - проверить валидность купона",
      "/use КОД - отметить купон как использованный",
    ].join("\n")
  );
});

bot.command("coupon", async (ctx) => {
  if (!ctx.from) {
    return;
  }

  const subscription = await checkSubscription(ctx.from.id);
  if (!subscription.ok) {
    await ctx.reply(
      "Не удалось проверить подписку. Убедитесь, что бот добавлен в канал и имеет права администратора."
    );
    return;
  }

  if (!subscription.subscribed) {
    await ctx.reply(
      "Вы не подписаны на канал. Подпишитесь на канал и повторите команду /coupon."
    );
    return;
  }

  const state = loadStore();
  const existingCode = state.couponByUserId[String(ctx.from.id)];

  if (existingCode) {
    const existing = state.coupons[existingCode];
    if (!existing) {
      await ctx.reply(
        "В системе есть запись, что вы уже получали купон. Повторная выдача запрещена."
      );
      return;
    }

    const status = existing.used ? "использован" : "не использован";
    await ctx.reply(
      [
        `Ваш купон: ${existing.code}`,
        `Скидка: ${DISCOUNT_PERCENT}%`,
        `Статус: ${status}`,
        "Повторная выдача запрещена: один пользователь может получить только 1 купон навсегда.",
      ].join("\n")
    );
    return;
  }

  const coupon = issueCoupon(state, ctx.from);
  saveStore(state);

  await ctx.reply(
    [
      `Готово. Ваш купон: ${coupon.code}`,
      `Скидка: ${DISCOUNT_PERCENT}%`,
      "Сохраните код и отправьте его администратору при покупке.",
    ].join("\n")
  );
});

bot.command("mycoupon", async (ctx) => {
  if (!ctx.from) {
    return;
  }

  const state = loadStore();
  const code = state.couponByUserId[String(ctx.from.id)];
  if (!code || !state.coupons[code]) {
    await ctx.reply("У вас пока нет купона. Используйте команду /coupon.");
    return;
  }

  const coupon = state.coupons[code];
  const status = coupon.used ? "использован" : "не использован";
  await ctx.reply(
    [`Ваш купон: ${coupon.code}`, `Скидка: ${DISCOUNT_PERCENT}%`, `Статус: ${status}`].join(
      "\n"
    )
  );
});

bot.command("check", async (ctx) => {
  if (!hasAdminAccess(ctx)) {
    await ctx.reply("Эта команда доступна только администратору.");
    return;
  }

  const code = extractCommandArg(ctx.message?.text);
  if (!code) {
    await ctx.reply("Использование: /check КОД");
    return;
  }

  const state = loadStore();
  const result = await validateCoupon(state, code);
  await ctx.reply(formatValidationResult(result));
});

bot.command("use", async (ctx) => {
  if (!hasAdminAccess(ctx)) {
    await ctx.reply("Эта команда доступна только администратору.");
    return;
  }

  const code = extractCommandArg(ctx.message?.text);
  if (!code) {
    await ctx.reply("Использование: /use КОД");
    return;
  }

  const state = loadStore();
  const validation = await validateCoupon(state, code);
  if (!validation.exists || !validation.valid) {
    await ctx.reply(formatValidationResult(validation));
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
      "Купон погашен и теперь невалиден.",
      `Код: ${coupon.code}`,
      `Владелец: ${formatOwner(coupon)}`,
      `Дата погашения: ${coupon.usedAt}`,
    ].join("\n")
  );
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
    return `Купон ${result.code} не найден. Статус: невалидный.`;
  }

  if (result.reason === "used") {
    return [
      "Статус: невалидный.",
      `Причина: купон уже использован.`,
      `Код: ${result.coupon.code}`,
      `Владелец: ${formatOwner(result.coupon)}`,
      `Использован: ${result.coupon.usedAt || "дата отсутствует"}`,
    ].join("\n");
  }

  if (result.reason === "unsubscribed") {
    return [
      "Статус: невалидный.",
      "Причина: владелец купона отписался от канала.",
      `Код: ${result.coupon.code}`,
      `Владелец: ${formatOwner(result.coupon)}`,
    ].join("\n");
  }

  if (result.reason === "subscription_check_error") {
    return [
      "Статус: невалидный.",
      "Причина: не удалось проверить подписку владельца купона.",
      "Проверьте права бота в канале.",
    ].join("\n");
  }

  return [
    "Статус: валидный.",
    `Код: ${result.coupon.code}`,
    `Скидка: ${result.coupon.discountPercent}%`,
    `Владелец: ${formatOwner(result.coupon)}`,
    `Выдан: ${result.coupon.issuedAt}`,
  ].join("\n");
}

function formatOwner(coupon) {
  const username = coupon.username ? `@${coupon.username}` : "без username";
  return `${username} (id: ${coupon.userId})`;
}
