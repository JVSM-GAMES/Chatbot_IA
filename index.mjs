import express from "express"
import fs from "fs"
import qrcode from "qrcode"
import axios from "axios"
import Pino from "pino"
import * as baileys from "@whiskeysockets/baileys"
import { Pinecone } from "@pinecone-database/pinecone"
import { GoogleAuth } from "google-auth-library"

const logger = Pino({ level: process.env.LOG_LEVEL || "info" })
const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// ---------------- CONFIG ----------------
const OPENROUTER_KEY = process.env.OPENROUTER_KEY
const MODEL = "gpt-4o-mini"
const PINECONE_API_KEY = process.env.PINECONE_API_KEY
const INDEX_NAME = "produtos-chatbot"
const CREDENTIALS_PATH = "/etc/secrets/ardent-codex-468613-n6-0a10770dbfed.json"
const SESSION_DIR = "./auth_info_baileys"

// ---------------- GOOGLE VERTEX AUTH ----------------
if (!fs.existsSync(CREDENTIALS_PATH)) {
  logger.error("Arquivo de credenciais não encontrado:", CREDENTIALS_PATH)
  process.exit(1)
}
const auth = new GoogleAuth({
  keyFile: CREDENTIALS_PATH,
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
})

// ---------------- PINECONE ----------------
const pinecone = new Pinecone({ apiKey: PINECONE_API_KEY })
let index = pinecone.index(INDEX_NAME)

// ---------------- EMBEDDING MOCK ----------------
async function gerarEmbedding(texto) {
  if (!texto) texto = ""
  try {
    const client = await auth.getClient()
    const projectId = await auth.getProjectId()
    logger.info({ texto }, `Gerando embedding no projeto ${projectId}`)
    // Mock: substitua por chamada real ao Vertex AI
    return Array(768).fill(Math.random())
  } catch (err) {
    logger.error({ err }, "Erro ao gerar embedding")
    throw err
  }
}

// ---------------- FUNÇÕES DE PRODUTOS ----------------
async function adicionarProduto(nome, descricao, preco) {
  const emb = await gerarEmbedding(`${nome} - ${descricao}`)
  const produtoId = nome.toLowerCase().replace(/ /g, "_")
  await index.upsert([{ id: produtoId, values: emb, metadata: { nome, descricao, preco } }])
}

async function buscarProduto(pergunta) {
  const emb = await gerarEmbedding(pergunta)
  const resultado = await index.query({ vector: emb, topK: 3, includeMetadata: true })
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
      { model: MODEL, messages: [{ role: "user", content: prompt }] },
      { headers: { Authorization: `Bearer ${OPENROUTER_KEY}`, "Content-Type": "application/json" }, timeout: 10000 }
    )
    return r.data.choices[0].message.content
  } catch (e) {
    logger.error({ err: e }, "Erro OpenRouter")
    return "Erro ao gerar resposta no momento. Tente mais tarde."
  }
}

// ---------------- WHATSAPP ----------------
let sock = null
let qrCodeData = null
const { makeWASocket, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } = baileys

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR)
  const { version } = await fetchLatestBaileysVersion()
  sock = makeWASocket({ version, auth: state, logger })

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      qrCodeData = qr
      logger.info("Novo QR gerado, use /qr para visualizar")
    }

    if (connection === "close") {
      const reason = new baileys.Boom(lastDisconnect?.error)?.output?.statusCode
      logger.warn({ reason }, "Conexão fechada, reconectando...")
      setTimeout(startSock, 2000)
    } else if (connection === "open") {
      logger.info("✅ Conectado ao WhatsApp!")
      qrCodeData = null
    }
  })

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return
    const msg = messages[0]
    if (!msg.message || msg.key.fromMe) return

    const from = msg.key.remoteJid
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text
    if (!text) return

    logger.info({ from, text }, "Mensagem recebida")
    try {
      const produto = await buscarProduto(text)
      const resposta = await gerarResposta(text, produto)
      await sock.sendMessage(from, { text: resposta })
      logger.info({ from, resposta }, "Resposta enviada")
    } catch (err) {
      logger.error({ err }, "Erro ao processar mensagem")
      await sock.sendMessage(from, { text: "Ops! Ocorreu um erro. Tente novamente mais tarde." })
    }
  })
}

// ---------------- ROTAS WEB ----------------
app.get("/", (req, res) => res.send("✅ Bot está rodando!"))

app.get("/qr", async (req, res) => {
  if (qrCodeData) {
    const qrImage = await qrcode.toDataURL(qrCodeData)
    res.send(`<img src="${qrImage}" />`)
  } else {
    res.send("Nenhum QR disponível. Se já está conectado, não precisa escanear.")
  }
})

app.post("/desconectar", async (req, res) => {
  if (fs.existsSync(SESSION_DIR)) fs.rmSync(SESSION_DIR, { recursive: true, force: true })
  qrCodeData = null
  sock = null
  try {
    await startSock()
    res.send("Sessão apagada. Novo QR gerado em /qr.")
  } catch (err) {
    logger.error({ err }, "Erro ao reiniciar WhatsApp")
    res.status(500).send("Erro ao reiniciar sessão WA")
  }
})

app.post("/produto", async (req, res) => {
  const { nome, descricao, preco } = req.body
  await adicionarProduto(nome, descricao, preco)
  res.send("Produto adicionado com sucesso.")
})

app.post("/chat", async (req, res) => {
  const { message } = req.body
  if (!message) return res.status(400).json({ error: "Mensagem obrigatória" })
  try {
    const produto = await buscarProduto(message)
    const resposta = await gerarResposta(message, produto)
    res.json({ resposta, produto })
  } catch (err) {
    logger.error({ err }, "Erro /chat")
    res.status(500).json({ error: "Erro interno" })
  }
})

// ---------------- START ----------------
const PORT = process.env.PORT || 3000
app.listen(PORT, async () => {
  logger.info({ PORT }, "Servidor rodando")
  await startSock()
})
