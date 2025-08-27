import express from "express";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import bodyParser from "body-parser";
import { Pinecone } from "@pinecone-database/pinecone";
import fs from "fs";
import { GoogleAuth } from "google-auth-library";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// --------------------- Configuração ---------------------
const OPENROUTER_KEY = process.env.OPENROUTER_KEY || "sk-or-v1-...";
const MODEL = "gpt-4o-mini";

const PINECONE_API_KEY = process.env.PINECONE_API_KEY || "pcsk_...";
const INDEX_NAME = "produtos-chatbot";

// Google Cloud Config
const GOOGLE_CREDENTIALS_JSON = process.env.GOOGLE_CREDENTIALS_JSON;
if (!GOOGLE_CREDENTIALS_JSON) {
  throw new Error("A variável de ambiente GOOGLE_CREDENTIALS_JSON não está definida.");
}

const credentialsPath = "/tmp/gcp-credentials.json";
if (!fs.existsSync(credentialsPath)) {
  fs.writeFileSync(credentialsPath, GOOGLE_CREDENTIALS_JSON);
}

const PROJECT_ID = "ardent-codex-468613-n6";
const LOCATION = "us-central1";
const EMBEDDING_MODEL_NAME = "text-embedding-004";

// Middlewares
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));

// --------------------- Inicializa Pinecone ---------------------
const pc = new Pinecone({ apiKey: PINECONE_API_KEY });

async function ensureIndex() {
  const indexes = await pc.listIndexes();
  if (!indexes.indexes.some(idx => idx.name === INDEX_NAME)) {
    await pc.createIndex({
      name: INDEX_NAME,
      dimension: 768,
      metric: "cosine",
      spec: { serverless: { cloud: "aws", region: "us-east-1" } }
    });
  }
}
await ensureIndex();

const index = pc.index(INDEX_NAME);

// --------------------- Função para gerar embeddings com Vertex AI ---------------------
async function gerarEmbedding(texto) {
  try {
    const auth = new GoogleAuth({
      keyFile: credentialsPath,
      scopes: ["https://www.googleapis.com/auth/cloud-platform"]
    });
    const client = await auth.getClient();
    const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${EMBEDDING_MODEL_NAME}:predict`;

    const res = await client.request({
      url,
      method: "POST",
      data: {
        instances: [{ content: texto }]
      }
    });

    return res.data.predictions[0].embeddings.values;
  } catch (err) {
    console.error("Erro ao gerar embedding:", err);
    throw new Error("Falha ao gerar embedding com Vertex AI");
  }
}

// --------------------- Funções de Produtos ---------------------
async function adicionarProduto(nome, descricao, preco) {
  const emb = await gerarEmbedding(`${nome} - ${descricao}`);
  const produtoId = nome.toLowerCase().replace(/\s+/g, "_");
  await index.upsert([
    {
      id: produtoId,
      values: emb,
      metadata: { nome, descricao, preco }
    }
  ]);
}

async function buscarProduto(pergunta) {
  const emb = await gerarEmbedding(pergunta);
  const result = await index.query({
    vector: emb,
    topK: 3,
    includeMetadata: true
  });

  if (result.matches && result.matches.length > 0) {
    const melhor = result.matches[0];
    if (melhor.score >= 0.5) return melhor.metadata;
  }
  return null;
}

// --------------------- Função de Resposta Inteligente ---------------------
async function gerarResposta(pergunta, produtoInfo = null) {
  const url = "https://openrouter.ai/api/v1/chat/completions";
  const headers = {
    "Authorization": `Bearer ${OPENROUTER_KEY}`,
    "Content-Type": "application/json"
  };

  const prompt = produtoInfo
    ? `Um cliente perguntou: '${pergunta}'.\n\nProduto relevante encontrado:\n- Nome: ${produtoInfo.nome}\n- Descrição: ${produtoInfo.descricao}\n- Preço: ${produtoInfo.preco}\n\nResponda de forma clara, útil e natural.`
    : `Um cliente perguntou: '${pergunta}'.\n\nNão encontramos nenhum produto correspondente.\nResponda de forma amigável e natural, sugerindo alternativas úteis.`;

  const payload = {
    model: MODEL,
    messages: [{ role: "user", content: prompt }]
  };

  try {
    const r = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });
    const data = await r.json();
    return data.choices[0].message.content;
  } catch (err) {
    console.error("Erro OpenRouter:", err);
    return "Desculpe, estamos com problemas para gerar a resposta no momento. Tente novamente em alguns segundos.";
  }
}

// --------------------- Rotas ---------------------
app.get("/", async (req, res) => {
  let produtos = [];
  try {
    const result = await index.query({
      vector: Array(768).fill(0),
      topK: 100,
      includeMetadata: true
    });
    produtos = result.matches.map(m => m.metadata);
  } catch (err) {
    console.error("Erro ao listar produtos:", err);
  }

  res.render("index", { produtos });
});

app.post("/", async (req, res) => {
  const { nome, descricao, preco } = req.body;
  if (nome && descricao && preco) {
    await adicionarProduto(nome, descricao, preco);
  }
  res.redirect("/");
});

app.post("/chat", async (req, res) => {
  const { pergunta } = req.body;
  const produtoInfo = await buscarProduto(pergunta);
  const resposta = await gerarResposta(pergunta, produtoInfo);
  res.json({ resposta, produto: produtoInfo });
});

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
