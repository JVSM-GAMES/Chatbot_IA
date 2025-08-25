import express from 'express';
import Pino from 'pino';
import fs from 'fs';
import qrcode from 'qrcode';
import axios from 'axios';
import { Boom } from '@hapi/boom';
import { makeWASocket, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } from '@whiskeysockets/baileys';
import PineconePkg from '@pinecone-database/pinecone';
import { GoogleAuth } from 'google-auth-library';
import { v1 as uuidv1 } from 'uuid';

const logger = Pino({ level: process.env.LOG_LEVEL || 'info' });
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// --------------------- Suas Chaves de API ---------------------
const OPENROUTER_KEY = "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";
const PINECONE_API_KEY = "pcsk_3xpF3r_KgUPQgiGwpEusPR2iSAU3cERDVMi2LtDNHCHwAGxafTUUDfCTDgnf51aiWzmaTh";
const INDEX_NAME = "produtos-chatbot";

// --------------------- Pinecone ---------------------
let index;
let pc;

async function initPinecone() {
  const PineconeClient = PineconePkg.PineconeClient || PineconePkg.default?.PineconeClient;
  pc = new PineconeClient();
  await pc.init({
    apiKey: PINECONE_API_KEY,
    environment: 'us-east1-gcp'
  });

  try {
    index = pc.Index(INDEX_NAME);
  } catch {
    await pc.createIndex({ name: INDEX_NAME, dimension: 768, metric: "cosine" });
    index = pc.Index(INDEX_NAME);
  }
}

// --------------------- Google Cloud Embeddings ---------------------
const auth = new GoogleAuth({
  keyFile: './chatbot-embedding.json', // Coloque seu JSON aqui
  scopes: 'https://www.googleapis.com/auth/cloud-platform'
});

async function gerarEmbedding(texto) {
  try {
    const client = await auth.getClient();
    const projectId = await auth.getProjectId();
    const url = `https://us-central1-aiplatform.googleapis.com/v1/projects/${projectId}/locations/us-central1/publishers/google/models/textembedding-gecko:predict`;
    const payload = { instances: [{ content: texto }] };
    const r = await client.request({ url, method: 'POST', data: payload });
    return r.data.predictions[0].embedding;
  } catch (err) {
    logger.error({ err }, 'Erro ao gerar embedding');
    throw err;
  }
}

// --------------------- Pinecone Functions ---------------------
async function adicionarProduto(nome, descricao, preco) {
  const emb = await gerarEmbedding(`${nome} - ${descricao}`);
  const produtoId = nome.toLowerCase().replace(/\s+/g, "_");
  await index.upsert({
    upsertRequest: {
      vectors: [{ id: produtoId, values: emb, metadata: { nome, descricao, preco } }]
    }
  });
}

async function buscarProduto(pergunta) {
  const emb = await gerarEmbedding(pergunta);
  const resultado = await index.query({ queryRequest: { vector: emb, topK: 3, includeMetadata: true } });
  if (resultado.matches.length) {
    const melhor = resultado.matches.reduce((a, b) => (a.score > b.score ? a : b));
    if (melhor.score >= 0.7) return melhor.metadata;
  }
  return null;
}

// --------------------- Função IA ---------------------
async function gerarResposta(pergunta, produtoInfo) {
  let mensagem;
  if (produtoInfo) {
    mensagem = `Usuário perguntou: ${pergunta}\nProduto encontrado: Nome: ${produtoInfo.nome}, Descrição: ${produtoInfo.descricao}, Preço: ${produtoInfo.preco}. Responda de forma útil e natural.`;
  } else {
    mensagem = `Usuário perguntou: ${pergunta}\nNão encontramos produto relevante. Tente entender a intenção do usuário e responda de forma educada.`;
  }

  const r = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: mensagem }]
  }, { headers: { Authorization: `Bearer ${OPENROUTER_KEY}` } });

  return r.data.choices[0].message.content;
}

// --------------------- Express ---------------------
app.get('/', (_, res) => res.send('Bot Online'));
let latestQr = null;
app.get('/qr', (_, res) => res.send(latestQr ? `<img src="${latestQr}"/>` : 'Nenhum QR disponível'));
app.get('/desconectar', async (_, res) => {
  if (sockRef?.ws) sockRef.ws.close();
  latestQr = null;

  // Reinicia o WhatsApp para gerar novo QR
  try {
    await startWA();
    res.send('Desconectado. Novo QR gerado, acesse /qr.');
  } catch (err) {
    res.send('Erro ao reiniciar sessão WA.');
  }
});
app.listen(PORT, () => logger.info({ PORT }, 'HTTP server online'));

// --------------------- WhatsApp ---------------------
const sessions = {};
const now = () => Date.now();
let sockRef;

function sanitizeText(msg) {
  const m = msg.message;
  return (
    m?.conversation ||
    m?.extendedTextMessage?.text ||
    m?.imageMessage?.caption ||
    m?.videoMessage?.caption ||
    ''
  ).trim();
}

function ensureSession(jid) {
  if (!sessions[jid]) sessions[jid] = { lastActive: now(), silent: false };
  return sessions[jid];
}

async function startWA() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ version, auth: state, printQRInTerminal: false, logger });
  sockRef = sock;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) latestQr = await qrcode.toDataURL(qr);
    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) setTimeout(startWA, 2000);
    } else if (connection === 'open') latestQr = null;
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      const text = sanitizeText(msg);
      if (!text) continue;

      const s = ensureSession(jid);
      s.lastActive = now();

      try {
        const produtoInfo = await buscarProduto(text);
        const resposta = await gerarResposta(text, produtoInfo);
        await sock.sendMessage(jid, { text: resposta });
      } catch (err) {
        logger.error({ err }, 'Erro ao processar mensagem');
        await sock.sendMessage(jid, { text: 'Ops! Ocorreu um erro. Tente novamente mais tarde.' });
      }
    }
  });
}

// --------------------- Main ---------------------
async function main() {
  try {
    await initPinecone();
    await startWA();
  } catch (err) {
    logger.error({ err }, 'Erro fatal no main');
  }
}

main();
