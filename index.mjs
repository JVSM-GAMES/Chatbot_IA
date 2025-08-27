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

// ✅ Carrega credenciais do Secret File montado pelo Cloud Run
const CREDENTIALS_PATH = '/etc/secrets/gcp-key.json'
if (!fs.existsSync(CREDENTIALS_PATH)) {
  logger.error(`Arquivo de credenciais não encontrado em: ${CREDENTIALS_PATH}`)
  process.exit(1)
}

const auth = new GoogleAuth({
  keyFile: CREDENTIALS_PATH,
  scopes: ['https://www.googleapis.com/auth/cloud-platform']
})

// ✅ Inicializa Pinecone
const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY // pode ser variável de ambiente simples
})

// Função para gerar embeddings
async function gerarEmbedding(texto) {
  try {
    const client = await auth.getClient()
    const projectId = await auth.getProjectId()

    logger.info(`Gerando embedding no projeto: ${projectId}`)

    // Aqui você chama a API do Vertex AI ou outro serviço
    // Exemplo fictício (ajuste conforme a lib que estiver usando):
    return { vector: [0.1, 0.2, 0.3] } // simulação
  } catch (err) {
    logger.error({ err }, "Erro ao gerar embedding")
    throw err
  }
}

// Função para buscar produto no Pinecone
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

// Inicializa WhatsApp
async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('auth')
  const { version } = await fetchLatestBaileysVersion()
  const sock = makeWASocket({ version, auth: state, logger })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) {
      qrcode.toFile("qr.png", qr)
      logger.info("QR Code gerado em qr.png")
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error).output.statusCode
      logger.error(`Conexão fechada: ${reason}`)
    } else if (connection === 'open') {
      logger.info("Conectado ao WhatsApp!")
    }
  })
}

startSock()
app.listen(3000, () => logger.info("Servidor rodando na porta 3000"))
