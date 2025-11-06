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
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}`;
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
const sFetch = async (path, method = "GET", body) => {
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-10/${path}`, {
    method,
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(`[Shopify ${method} ${path}] ${res.status} ${await res.text()}`);
  return res.json();
};

const findCustomerByEmail = async (email) => {
  const data = await sFetch(`customers/search.json?query=email:${encodeURIComponent(email)}`);
  return data.customers?.[0] || null;
};

const getCustomerMetafields = async (customerId) => {
  const data = await sFetch(`customers/${customerId}/metafields.json`);
  const mf = {};
  for (const m of data.metafields || []) if (m.namespace === "festivio") mf[m.key] = m;
  return mf;
};

const upsertMetafield = async (customerId, namespace, key, type, value) => {
  try {
    return (await sFetch(`metafields.json`, "POST", {
      metafield: { namespace, key, type, value, owner_resource: "customer", owner_id: customerId }
    })).metafield;
  } catch {
    const all = await sFetch(`customers/${customerId}/metafields.json`);
    const found = (all.metafields || []).find(m => m.namespace === namespace && m.key === key);
    if (!found) throw new Error("Metafield not found for update");
    return (await sFetch(`metafields/${found.id}.json`, "PUT", {
      metafield: { id: found.id, type, value }
    })).metafield;
  }
};

// ---- Gestion des abonnements ----
const grantIssue = async (customerId, age, issueKey) => {
  const mf = await getCustomerMetafields(customerId);
  let owned = [];
  if (mf.owned_numbers?.value) {
    try { owned = JSON.parse(mf.owned_numbers.value); } catch {}
  }

  const conf = getNumeroLink(age, issueKey);
  if (!conf) throw new Error(`No mapping for ${issueKey}/${age}`);

  // On évite les doublons
  if (!owned.some(i => i.key === issueKey && i.age === age)) {
    owned.push({
      key: issueKey,
      age,
      catalog: conf.catalog,
      annexes: conf.annexes
    });
  }

  await upsertMetafield(customerId, "festivio", "owned_numbers", "json", JSON.stringify(owned));
};

const setStatus = (customerId, status) =>
  upsertMetafield(customerId, "festivio", "subscription_status", "single_line_text_field", status);

const setExpiryPlusMonths = async (customerId, months) => {
  const d = new Date();
  d.setMonth(d.getMonth()+months);
  await upsertMetafield(customerId, "festivio", "subscription_expiry", "date", d.toISOString());
};

// ---- Webhooks ----
app.post("/webhooks/seal/subscription_created", async (req, res) => {
  try {
    const p = req.body;
    const email = p.customer?.email || p.customer_email;
    const age = p.metadata?.age || p.age || NUM_DEFAULT_AGE;
    const planType = p.plan_interval || p.plan_type || "month";
    const issueKey = currentIssueKey();

    const cust = await findCustomerByEmail(email);
    if (!cust) throw new Error(`Customer not found: ${email}`);

    await setStatus(cust.id, "active");
    await setExpiryPlusMonths(cust.id, planType === "year" ? 12 : 1);
    await grantIssue(cust.id, age, issueKey);

    res.status(200).send("ok");
  } catch (e) {
    console.error(e);
    res.status(200).send("ok");
  }
});

app.post("/webhooks/seal/billing_succeeded", async (req, res) => {
  try {
    const p = req.body;
    const email = p.customer?.email || p.customer_email;
    const age = p.metadata?.age || p.age || NUM_DEFAULT_AGE;
    const planType = p.plan_interval || p.plan_type || "month";
    const issueKey = currentIssueKey();

    const cust = await findCustomerByEmail(email);
    if (!cust) throw new Error(`Customer not found: ${email}`);

    await setStatus(cust.id, "active");
    await setExpiryPlusMonths(cust.id, planType === "year" ? 12 : 1);
    await grantIssue(cust.id, age, issueKey);

    res.status(200).send("ok");
  } catch (e) {
    console.error(e);
    res.status(200).send("ok");
  }
});

app.post("/webhooks/seal/subscription_cancelled", async (req, res) => {
  try {
    const p = req.body;
    const email = p.customer?.email || p.customer_email;
    const cust = await findCustomerByEmail(email);
    if (cust) await setStatus(cust.id, "cancelled");
    res.status(200).send("ok");
  } catch (e) {
    console.error(e);
    res.status(200).send("ok");
  }
});

// ---- Routes de test ----
app.get("/grant", async (req, res) => {
  try {
    const { email, age = NUM_DEFAULT_AGE, issue = currentIssueKey() } = req.query;
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
    if (!cust) return res.status(404).json({ error: "Customer not found" });

    const mf = await getCustomerMetafields(cust.id);
    let owned = [];
    if (mf.owned_numbers?.value) { try { owned = JSON.parse(mf.owned_numbers.value); } catch {} }

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


app.listen(PORT, () => console.log(`Festivio backend running on :${PORT}`));
