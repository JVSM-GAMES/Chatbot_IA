import express from 'express'
import Pino from 'pino'
import fs from 'fs'
import * as baileys from '@whiskeysockets/baileys'
import qrcode from 'qrcode'
import { Boom } from '@hapi/boom'
import axios from 'axios'

const { makeWASocket, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } = baileys
const logger = Pino({ level: process.env.LOG_LEVEL || 'info' })
const app = express()
app.use(express.json())
const PORT = process.env.PORT || 10000

// Configurações IA
const OPENROUTER_KEY = "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"
const MODEL = "gpt-4o-mini"

// Pinecone + Vertex AI
import { Pinecone, ServerlessSpec } from 'pinecone'
import vertexai from '@google-cloud/aiplatform'

const PINECONE_API_KEY = "pcsk_3xpF3r_KgUPQgiGwpEusPR2iSAU3cERDVMi2LtDNHCHwAGxafTUUDfCTDgnf51aiWzmaTh"
const INDEX_NAME = "produtos-chatbot"

vertexai.init({ project: "ardent-codex-468613-n6", location: "us-central1" })
const pc = new Pinecone({ apiKey: PINECONE_API_KEY })
if (!pc.listIndexes().includes(INDEX_NAME)) {
  pc.createIndex({ name: INDEX_NAME, dimension: 768, metric: 'cosine', spec: new ServerlessSpec({ cloud: 'aws', region: 'us-east-1' }) })
}
const index = pc.Index(INDEX_NAME)

// ---------------- Funções de Embeddings e IA ----------------
async function gerarEmbedding(texto) {
  const model = vertexai.TextEmbeddingModel.fromPretrained("text-embedding-004")
  const resp = await model.getEmbeddings([texto])
  return resp[0].values
}

async function buscarProduto(pergunta) {
  const emb = await gerarEmbedding(pergunta)
  const resultado = await index.query({ vector: emb, topK: 3, includeMetadata: true })
  if (resultado.matches.length > 0) {
    const melhor = resultado.matches[0]
    if (melhor.score >= 0.55) return melhor.metadata
  }
  return null
}

async function gerarResposta(pergunta, produtoInfo = null) {
  let prompt
  if (produtoInfo) {
    prompt = `Um cliente perguntou: '${pergunta}'. Produto encontrado: Nome: ${produtoInfo.nome}, Descrição: ${produtoInfo.descricao}, Preço: ${produtoInfo.preco}. Responda de forma clara, natural, tentando entender a intenção do cliente.`
  } else {
    prompt = `Um cliente perguntou: '${pergunta}'. Não encontramos produto correspondente. Responda de forma amigável, tentando entender a intenção do cliente e sugerindo alternativas.`
  }
  try {
    const r = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model: MODEL,
      messages: [{ role: 'user', content: prompt }]
    }, { headers: { Authorization: `Bearer ${OPENROUTER_KEY}` }, timeout: 6000 })
    return r.data.choices[0].message.content
  } catch (e) {
    logger.error({ e }, "Erro OpenRouter")
    return "Desculpe, não consegui gerar a resposta no momento."
  }
}

// ---------------- WhatsApp ----------------
let latestQr = null
const sessions = {}

function sanitizeText(msg) {
  const m = msg.message
  return (m?.conversation || m?.extendedTextMessage?.text || m?.imageMessage?.caption || m?.videoMessage?.caption || '').trim()
}

async function startWA() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info')
  const { version } = await fetchLatestBaileysVersion()
  const sock = makeWASocket({ version, auth: state, printQRInTerminal: false, logger })

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) latestQr = await qrcode.toDataURL(qr)
    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode
      const shouldReconnect = code !== DisconnectReason.loggedOut
      if (shouldReconnect) setTimeout(startWA, 2000)
    } else if (connection === 'open') {
      latestQr = null
      logger.info('Conectado ao WhatsApp ✅')
    }
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue
      const jid = msg.key.remoteJid
      const text = sanitizeText(msg)
      if (!text) continue

      // ✅ Busca produto e gera resposta IA
      const produtoInfo = await buscarProduto(text)
      const resposta = await gerarResposta(text, produtoInfo)
      await sock.sendMessage(jid, { text: resposta })
    }
  })
}

startWA().catch((err) => logger.error({ err }, 'Erro fatal'))

// ---------------- Express ----------------
app.get('/', (_, res) => res.send('ok'))
app.get('/qr', (_, res) => latestQr ? res.send(`<img src="${latestQr}" />`) : res.send('Nenhum QR disponível'))
app.listen(PORT, () => logger.info({ PORT }, 'HTTP server online'))
