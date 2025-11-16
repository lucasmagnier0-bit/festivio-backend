import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";

let numeros = {};

// --- Chargement du numeros.json ---
function loadNumeros() {
  try {
    const filePath = path.resolve("./data/numeros.json");
    const content = fs.readFileSync(filePath, "utf8");
    numeros = JSON.parse(content);
    console.log("✅ numeros.json chargé avec succès");
  } catch (err) {
    console.error("❌ Erreur de lecture du numeros.json :", err);
    numeros = {};
  }
}
loadNumeros();
fs.watchFile(path.resolve("./data/numeros.json"), loadNumeros);

function currentIssueKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function getNumeroLink(age, issueKey) {
  return numeros[issueKey]?.[age] || null;
}

const {
  PORT = 3000,
  SHOPIFY_STORE,
  SHOPIFY_ADMIN_TOKEN,
  NUM_DEFAULT_AGE = "6-9"
} = process.env;

const app = express();
app.use(bodyParser.json({ type: "*/*" }));

// ---- Utils Shopify ----
const sFetch = async (pathSuffix, method = "GET", body) => {
  const url = `https://${SHOPIFY_STORE}/admin/api/2024-10/${pathSuffix}`;
  const res = await fetch(url, {
    method,
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`[Shopify ${method} ${pathSuffix}] ${res.status} ${txt}`);
  }
  return res.json();
};

const findCustomerByEmail = async (email) => {
  const data = await sFetch(
    `customers/search.json?query=email:${encodeURIComponent(email)}`
  );
  return data.customers?.[0] || null;
};

const getCustomerMetafields = async (customerId) => {
  const data = await sFetch(`customers/${customerId}/metafields.json`);
  const mf = {};
  for (const m of data.metafields || []) {
    if (m.namespace === "festivio") mf[m.key] = m;
  }
  return mf;
};

// 🔎 Récupère l'âge sur le produit via metafield produit festivo.age
const getProductAge = async (productId) => {
  if (!productId) return null;
  try {
    const data = await sFetch(`products/${productId}/metafields.json`);
    const mf = (data.metafields || []).find(
      (m) => m.namespace === "festivio" && m.key === "age"
    );
    if (!mf) {
      console.warn(`⚠️ Pas de metafield festivo.age pour le produit ${productId}`);
      return null;
    }
    console.log(`🎯 Age produit ${productId} = ${mf.value}`);
    return mf.value;
  } catch (e) {
    console.error("❌ Erreur getProductAge:", e.message);
    return null;
  }
};

const upsertMetafield = async (customerId, namespace, key, type, value) => {
  try {
    // tentative de création
    return (
      await sFetch(`metafields.json`, "POST", {
        metafield: {
          namespace,
          key,
          type,
          value,
          owner_resource: "customer",
          owner_id: customerId
        }
      })
    ).metafield;
  } catch {
    // sinon on met à jour un existant
    const all = await sFetch(`customers/${customerId}/metafields.json`);
    const found = (all.metafields || []).find(
      (m) => m.namespace === namespace && m.key === key
    );
    if (!found) throw new Error("Metafield not found for update");
    return (
      await sFetch(`metafields/${found.id}.json`, "PUT", {
        metafield: { id: found.id, type, value }
      })
    ).metafield;
  }
};

// ---- Gestion des abonnements ----
const grantIssue = async (customerId, age, issueKey) => {
  const mf = await getCustomerMetafields(customerId);
  let owned = [];
  if (mf.owned_numbers?.value) {
    try {
      owned = JSON.parse(mf.owned_numbers.value);
    } catch {}
  }

  const conf = getNumeroLink(age, issueKey);
  if (!conf) throw new Error(`No mapping for ${issueKey}/${age}`);

  // On évite les doublons
  if (!owned.some((i) => i.key === issueKey && i.age === age)) {
    owned.push({
      key: issueKey,
      age,
      catalog: conf.catalog,
      annexes: conf.annexes
    });
  }

  await upsertMetafield(
    customerId,
    "festivio",
    "owned_numbers",
    "json",
    JSON.stringify(owned)
  );
};

const setStatus = (customerId, status) =>
  upsertMetafield(
    customerId,
    "festivio",
    "subscription_status",
    "single_line_text_field",
    status
  );

const setExpiryPlusMonths = async (customerId, months) => {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  await upsertMetafield(
    customerId,
    "festivio",
    "subscription_expiry",
    "date",
    d.toISOString()
  );
};

// ---- Traitement commun payload SEAL ----
const processSealPayload = async (payload) => {
  console.log("🔔 Payload SEAL reçu :", JSON.stringify(payload, null, 2));

  const email =
    payload.email || payload.customer?.email || payload.customer_email;
  if (!email) throw new Error("Email not found in payload");

  const cust = await findCustomerByEmail(email);
  if (!cust) throw new Error(`Customer not found: ${email}`);

  let prenom = payload.first_name || payload.s_first_name || "Enfant";
  let nom = payload.last_name || payload.s_last_name || "";
  let age = NUM_DEFAULT_AGE;

  // 1) Si SEAL envoie des properties (ex: via personnalisations sur le front)
  if (
    payload.items &&
    payload.items[0]?.properties &&
    payload.items[0].properties.length
  ) {
    const props = payload.items[0].properties;
    for (const prop of props) {
      const name = (prop.name || "").toLowerCase();
      if (name === "prenom" || name === "prénom") prenom = prop.value;
      if (name === "age" || name === "âge") age = prop.value;
    }
  }
  // 2) Si SEAL envoie metadata.age (au cas où tu utilises ça plus tard)
  else if (payload.metadata?.age) {
    age = payload.metadata.age;
    if (payload.metadata.prenom) prenom = payload.metadata.prenom;
  }
  // 3) Sinon : on déduit l'âge via le produit Shopify (metafield produit festivo.age)
  else if (payload.items && payload.items[0]) {
    const item = payload.items[0];
    const productId =
      item.product_id ||
      item.shopify_product_id ||
      (item.product && item.product.id) ||
      null;

    if (productId) {
      const productAge = await getProductAge(productId);
      if (productAge) {
        age = productAge;
      }
    }
  }

  const planType = payload.billing_interval || "month";
  const monthsToAdd = planType === "year" ? 12 : 1;
  const issueKey = currentIssueKey();

  await setStatus(cust.id, "active");
  await setExpiryPlusMonths(cust.id, monthsToAdd);
  await grantIssue(cust.id, age, issueKey);

  return { email, prenom, age, planType };
};

// ---- Webhooks SEAL ----
app.post("/webhooks/seal/subscription_created", async (req, res) => {
  console.log("=== SEAL WEBHOOK RECEIVED (subscription_created) ===");
  console.log("Headers:", req.headers);
  console.log("Body:", JSON.stringify(req.body, null, 2));

  try {
    const info = await processSealPayload(req.body);
    console.log(
      `[WEBHOOK] subscription_created traité pour ${info.email} (${info.prenom}, ${info.age} ans, ${info.planType})`
    );
    res.status(200).send("ok");
  } catch (e) {
    console.error(e);
    res.status(200).send("ok"); // on renvoie 200 pour éviter les retries SEAL
  }
});

app.post("/webhooks/seal/billing_succeeded", async (req, res) => {
  console.log("=== SEAL WEBHOOK RECEIVED (billing_succeeded) ===");
  console.log("Headers:", req.headers);
  console.log("Body:", JSON.stringify(req.body, null, 2));

  try {
    const info = await processSealPayload(req.body);
    console.log(
      `[WEBHOOK] billing_succeeded traité pour ${info.email} (${info.prenom}, ${info.age} ans, ${info.planType})`
    );
    res.status(200).send("ok");
  } catch (e) {
    console.error(e);
    res.status(200).send("ok");
  }
});

app.post("/webhooks/seal/subscription_cancelled", async (req, res) => {
  console.log("=== SEAL WEBHOOK RECEIVED (subscription_cancelled) ===");
  console.log("Headers:", req.headers);
  console.log("Body:", JSON.stringify(req.body, null, 2));

  try {
    const p = req.body;
    const email =
      p.email || p.customer?.email || p.customer_email;
    if (!email) throw new Error("Email not found in payload (cancel)");

    const cust = await findCustomerByEmail(email);
    if (cust) {
      await setStatus(cust.id, "cancelled");
      console.log(`[WEBHOOK] subscription_cancelled pour ${email}`);
    } else {
      console.warn(`[WEBHOOK] subscription_cancelled : client introuvable ${email}`);
    }
    res.status(200).send("ok");
  } catch (e) {
    console.error(e);
    res.status(200).send("ok");
  }
});

// ---- Routes de test ----
app.get("/grant", async (req, res) => {
  try {
    const {
      email,
      age = NUM_DEFAULT_AGE,
      issue = currentIssueKey()
    } = req.query;
    const cust = await findCustomerByEmail(email);
    if (!cust) throw new Error(`Customer not found: ${email}`);
    await grantIssue(cust.id, age, issue);
    res.send("granted");
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.get("/debug/customer", async (req, res) => {
  try {
    const { email } = req.query;
    const cust = await findCustomerByEmail(email);
    if (!cust)
      return res.status(404).json({ error: "Customer not found" });

    const mf = await getCustomerMetafields(cust.id);
    let owned = [];
    if (mf.owned_numbers?.value) {
      try {
        owned = JSON.parse(mf.owned_numbers.value);
      } catch {}
    }

    res.json({
      customer_id: cust.id,
      email: cust.email,
      metafields_keys: Object.keys(mf),
      subscription_status: mf.subscription_status?.value || null,
      subscription_expiry: mf.subscription_expiry?.value || null,
      owned_numbers_count: owned.length,
      owned_numbers: owned
    });
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.get("/debug/numeros", (req, res) => res.json(numeros));

// ---- Route de simulation SEAL ----
app.post("/simulate-seal", async (req, res) => {
  try {
    // Exemple payload simulé (pour tester sans SEAL)
    const payload = {
      email: req.body.email || "test@sealsubscriptions.com",
      first_name: req.body.prenom || "Enfant",
      last_name: req.body.nom || "Test",
      billing_interval: req.body.billing_interval || "month",
      items: [
        {
          product_id: req.body.product_id || null,
          properties: [
            { name: "prenom", value: req.body.prenom || "Enfant" },
            { name: "age", value: req.body.age || NUM_DEFAULT_AGE }
          ]
        }
      ]
    };
    const info = await processSealPayload(payload);
    res.json({ message: "Simulation OK", info });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () =>
  console.log(`Festivio backend running on port ${PORT}`)
);



