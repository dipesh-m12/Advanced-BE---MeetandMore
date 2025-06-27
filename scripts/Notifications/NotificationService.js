const { MongoClient } = require("mongodb");
const { sendMessageToKafka } = require("../../utils/kafka"); // Your Kafka producer
const fs = require("fs").promises;
const { check, validationResult } = require("express-validator");

const LOCAL_MONGO_URI = "mongodb://127.0.0.1:27017/meetandmore";

const currencyToLanguageMap = {
  INR: "en",
  USD: "en",
  CAD: "en",
  GBP: "en",
  EUR: "de",
  AUD: "en",
  SGD: "en",
  HKD: "en",
  JPY: "ja",
  KRW: "ko",
  MYR: "ms",
  THB: "th",
  AED: "ar",
  QAR: "ar",
  SAR: "ar",
  EGP: "ar",
  ZAR: "en",
  ARS: "es",
  MXN: "es",
  NGN: "en",
  RUB: "ru",
  TRY: "tr",
  CLP: "es",
  BRL: "pt",
  PEN: "es",
  COP: "es",
  RWF: "en",
  KES: "en",
  BDT: "bn",
};

// Validation rules
const validateNotification = [
  check("title").notEmpty().withMessage("Default title is required"),
  check("body").notEmpty().withMessage("Default body is required"),
  check("data").optional().isObject().withMessage("Data must be an object"),
  ...Object.values(currencyToLanguageMap).reduce((acc, lang) => {
    if (!acc.some((v) => v._param === `title_${lang}`)) {
      acc.push(
        check(`title_${lang}`)
          .optional()
          .notEmpty()
          .withMessage(`Title for ${lang} must not be empty`),
        check(`body_${lang}`)
          .optional()
          .notEmpty()
          .withMessage(`Body for ${lang} must not be empty`)
      );
    }
    return acc;
  }, []),
];

async function sendNotifications() {
  let client;
  try {
    // Read notification config
    const configRaw = await fs.readFile("notification-config.json");
    const config = JSON.parse(configRaw);
    console.log("Loaded notification config:", config);

    // Validate config
    const errors = validationResult(
      await Promise.all(
        validateNotification.map((v) => v.run({ body: config }))
      )
    );
    if (!errors.isEmpty()) {
      console.error("Validation error:", errors.array()[0].msg);
      process.exit(1);
    }

    const {
      title: defaultTitle,
      body: defaultBody,
      data: customData,
      ...languageMessages
    } = config;

    // Connect to local MongoDB
    client = new MongoClient(LOCAL_MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
    });
    await client.connect();
    const db = client.db("meetandmore");
    const profiles = db.collection("profiles");

    // Fetch all active profiles with pushtoken
    const users = await profiles
      .find({ deleted: false, pushtoken: { $exists: true, $ne: null } })
      .project({ _id: 1, region_currency: 1, pushtoken: 1 })
      .toArray();
    console.log(`Fetched ${users.length} users with pushtokens`);

    if (users.length === 0) {
      console.log("No users with valid push tokens");
      await client.close();
      process.exit(0);
    }

    // Group users by language
    const notificationsByLanguage = users.reduce((acc, user) => {
      const currency = user.region_currency || "INR";
      const lang = currencyToLanguageMap[currency] || "en";
      if (!acc[lang]) {
        acc[lang] = {
          tokens: [],
          currencies: new Set(),
          title: languageMessages[`title_${lang}`] || defaultTitle,
          body: languageMessages[`body_${lang}`] || defaultBody,
        };
      }
      acc[lang].tokens.push(user.pushtoken);
      acc[lang].currencies.add(currency);
      return acc;
    }, {});

    // Enqueue notifications to Kafka/BullMQ
    let totalQueued = 0;
    for (const [lang, { tokens, currencies, title, body }] of Object.entries(
      notificationsByLanguage
    )) {
      if (tokens.length === 0) continue;

      const data = {
        language: lang,
        currencies: Array.from(currencies).join(","),
        ...Object.fromEntries(
          Object.entries(customData || {}).map(([k, v]) => [k, String(v)])
        ), // Ensure all custom data values are strings
      };

      await sendMessageToKafka("notification-batch", {
        tokens,
        title,
        body,
        data,
      });
      totalQueued += tokens.length;
      console.log(
        `Enqueued ${
          tokens.length
        } notifications for language ${lang} (currencies: ${Array.from(
          currencies
        ).join(", ")}) with data: ${JSON.stringify(data)}`
      );
    }

    console.log(`Notifications enqueued for ${totalQueued} users`);
    await client.close();
    process.exit(0);
  } catch (err) {
    console.error("Notification error:", err);
    if (client) await client.close();
    process.exit(1);
  }
}

sendNotifications();
