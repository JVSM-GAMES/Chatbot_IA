import express from "express"
import fs from "fs"
import path from "path"
import axios from "axios"
import qrcode from "qrcode"
import * as baileys from "@whiskeysockets/baileys"
import { Pinecone } from "@pinecone-database/pinecone"
import { GoogleAuth } from "google-auth-library"

const { makeWASocket, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } = baileys
const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// ---------------- CONFIG ----------------
const OPENROUTER_KEY = process.env.OPENROUTER_KEY
const MODEL = "gpt-4o-mini"
const PINECONE_API_KEY = process.env.PINECONE_API_KEY
const INDEX_NAME = "produtos-chatbot"
const CREDENTIALS_PATH = "/etc/secrets/ardent-codex-468613-n6-0a10770dbfed.json"

// ---------------- GOOGLE VERTEX AUTH ----------------
if (!fs.existsSync(CREDENTIALS_PATH)) {
  console.error("Arquivo de credenciais não encontrado:", CREDENTIALS_PATH)
  process.exit(1)
}
const auth = new GoogleAuth({
  keyFile: CREDENTIALS_PATH,
  scopes: ["https://www.googleapis.com/auth/cloud-platform"]
})

// ---------------- PINECONE ----------------
const pinecone = new Pinecone({ apiKey: PINECONE_API_KEY })
let index = pinecone.index(INDEX_NAME)

// ---------------- EMBEDDING MOCK ----------------
// ⚠️ aqui você deve trocar para a chamada real do Vertex AI embeddings
async function gerarEmbedding(texto) {
  try {
    const client = await auth.getClient()
    const projectId = await auth.getProjectId()
    console.log("Gerando embedding para:", texto, "no projeto:", projectId)

    // Simulação: vetor de 3 números
    return Array(768).fill(Math.random())
  } catch (err) {
    console.error("Erro ao gerar embedding:", err)
    throw err
  }
}

// ---------------- FUNÇÕES DE PRODUTOS ----------------
async function adicionarProduto(nome, descricao, preco) {
  const emb = await gerarEmbedding(nome + " - " + descricao)
  const produtoId = nome.toLowerCase().replace(/ /g, "_")
  await index.upsert([
    { id: produtoId, values: emb, metadata: { nome, descricao, preco } }
  ])
}

async function buscarProduto(pergunta) {
  const emb = await gerarEmbedding(pergunta)
  const resultado = await index.query({
    vector: emb,
    topK: 3,
    includeMetadata: true
  })
  if (resultado.matches.length > 0 && resultado.matches[0].score >= 0.5) {
    return resultado.matches[0].metadata
  }
  return null
}

// ---------------- GERAR RESPOSTA ----------------
async function gerarResposta(pergunta, produtoInfo) {
  let prompt
  if (produtoInfo) {
    prompt = `Um cliente perguntou: "${pergunta}".\n\nProduto relevante:\n- Nome: ${produtoInfo.nome}\n- Descrição: ${produtoInfo.descricao}\n- Preço: ${produtoInfo.preco}\n\nResponda de forma clara e útil.`
  } else {
    prompt = `Um cliente perguntou: "${pergunta}".\nNenhum produto encontrado.\nResponda de forma amigável e sugira próximos passos.`
  }

  try {
    const r = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: MODEL,
        messages: [{ role: "user", content: prompt }]
      },
      {
        headers: {
          Authorization: `Bearer ${OPENROUTER_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 10000
      }
    )
    return r.data.choices[0].message.content
  } catch (e) {
    console.error("Erro OpenRouter:", e.message)
    return "Erro ao gerar resposta no momento. Tente mais tarde."
  }
}

// ---------------- WHATSAPP ----------------
const SESSION_DIR = "./auth_info_baileys"
let sock
let qrCodeData = null

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR)
  const { version } = await fetchLatestBaileysVersion()
  sock = makeWASocket({ version, logger: undefined, auth: state })

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) qrCodeData = qr
    if (connection === "open") {
      console.log("✅ Conectado ao WhatsApp!")
      qrCodeData = null
    }
  })

  // Ouvir mensagens recebidas
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return
    const msg = messages[0]
    if (!msg.message || msg.key.fromMe) return

    const from = msg.key.remoteJid
    const text =
      msg.message.conversation || msg.message.extendedTextMessage?.text
    console.log("📩 Mensagem recebida:", text)

    if (text) {
      const produto = await buscarProduto(text)
      const resposta = await gerarResposta(text, produto)
      await sock.sendMessage(from, { text: resposta })
    }
  })
}

// ---------------- ROTAS WEB ----------------
app.get("/", (req, res) => {
  res.send("✅ Bot está rodando!")
})

app.get("/qr", async (req, res) => {
  if (qrCodeData) {
    const qrImage = await qrcode.toDataURL(qrCodeData)
    res.send(`<img src="${qrImage}" />`)
  } else {
    res.send("Nenhum QR disponível. Se já está conectado, não precisa escanear.")
  }
})

app.post("/desconectar", (req, res) => {
  if (fs.existsSync(SESSION_DIR)) {
    fs.rmSync(SESSION_DIR, { recursive: true, force: true })
  }
  qrCodeData = null
  sock = null
  res.send("Sessão apagada. Reinicie para gerar novo QR.")
})

app.post("/produto", async (req, res) => {
  const { nome, descricao, preco } = req.body
  await adicionarProduto(nome, descricao, preco)
  res.send("Produto adicionado com sucesso.")
})

app.post("/chat", async (req, res) => {
  const { pergunta } = req.body
  const produto = await buscarProduto(pergunta)
  const resposta = await gerarResposta(pergunta, produto)
  res.json({ resposta, produto })
})

// ---------------- START ----------------
const PORT = process.env.PORT || 3000
app.listen(PORT, async () => {
  console.log("Servidor rodando na porta", PORT)
  await startSock()
})
