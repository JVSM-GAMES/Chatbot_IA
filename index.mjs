import express from 'express'
import Pino from 'pino'
import fs from 'fs'
import * as baileys from '@whiskeysockets/baileys'
import qrcode from 'qrcode'
import { Boom } from '@hapi/boom'
import { GoogleAuth } from 'google-auth-library'
import { Pinecone } from '@pinecone-database/pinecone'

const { makeWASocket, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } = baileys
const logger = Pino({ level: 'info' })
const app = express()

// ================== GOOGLE AUTH COM SECRET FILE ==================
const CREDENTIALS_PATH = '/etc/secrets/ardent-codex-468613-n6-0a10770dbfed.json'
if (!fs.existsSync(CREDENTIALS_PATH)) {
  logger.error(`Arquivo de credenciais não encontrado em: ${CREDENTIALS_PATH}`)
  process.exit(1)
}

const auth = new GoogleAuth({
  keyFile: CREDENTIALS_PATH,
  scopes: ['https://www.googleapis.com/auth/cloud-platform']
})

// ================== PINECONE ==================
const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY
})

// ================== VARIÁVEIS GLOBAIS ==================
let sockRef = null
let latestQr = null

// ================== EMBEDDINGS & BUSCA ==================
async function gerarEmbedding(texto) {
  try {
    const client = await auth.getClient()
    const projectId = await auth.getProjectId()

    logger.info(`Gerando embedding no projeto: ${projectId}`)
    return { vector: [0.1, 0.2, 0.3] } // mock
  } catch (err) {
    logger.error({ err }, "Erro ao gerar embedding")
    throw err
  }
}

async function buscarProduto(consulta) {
  try {
    const embedding = await gerarEmbedding(consulta)
    const index = pinecone.index("produtos")
    const resultado = await index.query({
      vector: embedding.vector,
      topK: 3,
      includeMetadata: true
    })
    return resultado.matches
  } catch (err) {
    logger.error({ err }, "Erro ao buscar produto no Pinecone")
    throw err
  }
}

// ================== WHATSAPP ==================
async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('auth')
  const { version } = await fetchLatestBaileysVersion()
  const sock = makeWASocket({ version, auth: state, logger })

  sockRef = sock // guarda referência global

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) {
      latestQr = qr
      logger.info("Novo QR Code gerado, acesse /qr para visualizar")
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error).output.statusCode
      logger.error(`Conexão fechada: ${reason}`)
    } else if (connection === 'open') {
      logger.info("✅ Conectado ao WhatsApp!")
      latestQr = null // QR não é mais necessário
    }
  })
}

// ================== ROTAS EXPRESS ==================

// Página com QR
app.get('/qr', async (req, res) => {
  if (!latestQr) {
    return res.send("Nenhum QR disponível. Se já está conectado, não precisa escanear.")
  }
  try {
    const qrImage = await qrcode.toDataURL(latestQr)
    res.send(`
      <html>
        <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
          <h2>Escaneie o QR Code no WhatsApp</h2>
          <img src="${qrImage}" />
        </body>
      </html>
    `)
  } catch (err) {
    res.status(500).send("Erro ao gerar QR")
  }
})

// Desconectar e gerar novo QR
app.get('/desconectar', async (req, res) => {
  try {
    if (sockRef?.ws) {
      sockRef.ws.close()
      latestQr = null
      logger.info("Sessão WhatsApp desconectada")
    }
    startSock().catch(err => logger.error({ err }, "Erro ao reiniciar sessão WA"))
    res.send("Sessão desconectada. Novo QR será gerado. Acesse /qr para escanear.")
  } catch (err) {
    logger.error({ err }, "Erro no /desconectar")
    res.status(500).send("Erro ao desconectar")
  }
})

// ================== START ==================
startSock()
app.listen(3000, () => logger.info("Servidor rodando na porta 3000"))
