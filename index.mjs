import express from "express"
import Pino from "pino"
import fs from "fs"
import * as baileys from "@whiskeysockets/baileys"
import qrcode from "qrcode"
import path from "path"

const { makeWASocket, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } = baileys

const app = express()
app.use(express.json())

const logger = Pino({ level: "silent" })
const SESSION_DIR = "./auth_info_baileys"

let sock
let qrCodeData = null

// Função para iniciar conexão
async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR)
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: state
  })

  // Evento para QR
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      qrCodeData = qr
      console.log("Novo QR gerado, use /qr para visualizar.")
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      console.log("Conexão fechada. Reconectar:", shouldReconnect)
      if (shouldReconnect) {
        startSock()
      }
    } else if (connection === "open") {
      console.log("✅ Conectado ao WhatsApp!")
      qrCodeData = null
    }
  })

  sock.ev.on("creds.update", saveCreds)
}

// Função para resetar sessão
function resetSession() {
  if (fs.existsSync(SESSION_DIR)) {
    fs.rmSync(SESSION_DIR, { recursive: true, force: true })
    console.log("🗑️ Sessão apagada.")
  }
  qrCodeData = null
  sock = null
}

// Rota para pegar QR
app.get("/qr", async (req, res) => {
  if (qrCodeData) {
    const qrImage = await qrcode.toDataURL(qrCodeData)
    res.send(`<img src="${qrImage}" />`)
  } else {
    res.send("Nenhum QR disponível. Se já está conectado, não precisa escanear.")
  }
})

// Rota para desconectar
app.post("/desconectar", (req, res) => {
  resetSession()
  res.send("Sessão desconectada e apagada. Reinicie /qr para novo login.")
})

// Rota para enviar mensagem
app.post("/enviar", async (req, res) => {
  const { numero, mensagem } = req.body
  if (!sock) return res.status(400).send("❌ Não conectado ao WhatsApp.")

  try {
    const jid = numero + "@s.whatsapp.net"
    await sock.sendMessage(jid, { text: mensagem })
    res.send("Mensagem enviada com sucesso!")
  } catch (err) {
    console.error("Erro ao enviar mensagem:", err)
    res.status(500).send("Erro ao enviar mensagem.")
  }
})

// Inicia servidor
app.listen(3000, async () => {
  console.log("Servidor rodando na porta 3000")
  await startSock()
})
