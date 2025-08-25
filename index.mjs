import express from 'express';
import Pino from 'pino';
import fs from 'fs';
import * as baileys from '@whiskeysockets/baileys';
import qrcode from 'qrcode';
import { Boom } from '@hapi/boom';
import { Pinecone } from '@pinecone-database/pinecone';
import { GoogleAuth } from 'google-auth-library';
import { v2 as openai } from 'openai';

const { makeWASocket, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } = baileys;
const logger = Pino({ level: process.env.LOG_LEVEL || 'info' });
const app = express();
const PORT = process.env.PORT || 3000;

// ========== Google Cloud Auth corrigido ==========
let rawCreds = {};
try {
  rawCreds = JSON.parse(process.env.GCP_CREDENTIALS_JSON || '{}');
  if (rawCreds.private_key) {
    rawCreds.private_key = rawCreds.private_key.replace(/\\n/g, '\n');
  }
} catch (err) {
  console.error("Erro ao parsear GCP_CREDENTIALS_JSON:", err);
}

const auth = new GoogleAuth({
  credentials: rawCreds,
  scopes: 'https://www.googleapis.com/auth/cloud-platform'
});

// ========== Pinecone ==========
const pc = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY
});

// ========== OpenRouter ==========
openai.apiKey = process.env.OPENROUTER_API_KEY;

// ========== WhatsApp Socket ==========
async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const sock = makeWASocket({
    logger,
    printQRInTerminal: true,
    auth: state
  });

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrcode.toString(qr, { type: 'terminal' }, (err, qrCode) => {
        if (!err) console.log(qrCode);
      });
    }
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        startSock();
      }
    } else if (connection === 'open') {
      console.log('Conectado ao WhatsApp!');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  return sock;
}

startSock();

// ========== Express ==========
app.get('/', (req, res) => {
  res.send('Servidor rodando com Google, Pinecone, OpenRouter e Baileys!');
});

app.listen(PORT, () => {
  console.log(`Servidor iniciado em http://localhost:${PORT}`);
});
