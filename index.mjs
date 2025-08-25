import express from 'express';
import Pino from 'pino';
import qrcode from 'qrcode';
import axios from 'axios';
import { Boom } from '@hapi/boom';
import { makeWASocket, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } from '@whiskeysockets/baileys';
import PineconePkg from '@pinecone-database/pinecone';
import { GoogleAuth } from 'google-auth-library';
import fs from 'fs';

const logger = Pino({ level: process.env.LOG_LEVEL || 'debug' });
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// --------------------- Suas Chaves de API ---------------------
const OPENROUTER_KEY = process.env.OPENROUTER_KEY;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const INDEX_NAME = "produtos-chatbot";

// --------------------- Pinecone ---------------------
let index;
let pc;

async function initPinecone() {
  try {
    const PineconeClient = PineconePkg.PineconeClient || PineconePkg.default?.PineconeClient;
    pc = new PineconeClient();
    await pc.init({ apiKey: PINECONE_API_KEY, environment: 'us-east1-gcp' });
    try {
      index = pc.Index(INDEX_NAME);
      logger.info('Pinecone: Index encontrado.');
    } catch {
      await pc.createIndex({ name: INDEX_NAME, dimension: 768, metric: "cosine" });
      index = pc.Index(INDEX_NAME);
      logger.info('Pinecone: Index criado.');
    }
  } catch (err) {
    logger.error({ err }, 'Erro ao inicializar Pinecone');
    throw err;
  }
}

// --------------------- Google Cloud Embeddings ---------------------
// No Render: coloque o Secret File como `gcp-key.json` no container
const auth = new GoogleAuth({
  keyFile: '/etc/secrets/gcp-key.json',
  scopes: 'https://www.googleapis.com/auth/cloud-platform'
});

async function gerarEmbedding(texto) {
  try {
    const client = await auth.getClient();
    const projectId = await auth.getProjectId();
    const url = `https://us-central1-aiplatform.googleapis.com/v1/projects/${projectId}/locations/us-central1/publishers/google/models/textembedding-gecko:predict`;
    const payload = { instances: [{ content: texto }] };
    logger.debug({ texto }, 'Gerando embedding');
    const r = await client.request({ url, method: 'POST', data: payload });
    logger.debug({ embedding: r.data.predictions[0].embedding.length }, 'Embedding recebido');
    return r.data.predictions[0].embedding;
  } catch (err) {
    logger.error({ err }, 'Erro ao gerar embedding');
    throw err;
  }
}

// --------------------- Pinecone Functions ---------------------
async function adicionarProduto(nome, descricao, preco) {
  try {
    const emb = await gerarEmbedding(`${nome} - ${descricao}`);
    const produtoId = nome.toLowerCase().replace(/\s+/g, "_");
    await index.upsert({ upsertRequest: { vectors: [{ id: produtoId, values: emb, metadata: { nome, descricao, preco } }] } });
    logger.info({ produtoId }, 'Produto adicionado/upsertado no Pinecone');
  } catch (err) {
    logger.error({ err }, 'Erro ao adicionar produto no Pinecone');
  }
}

async function buscarProduto(pergunta) {
  try {
    const emb = await gerarEmbedding(pergunta);
    const resultado = await index.query({ queryRequest: { vector: emb, topK: 3, includeMetadata: true } });
    if (resultado.matches.length) {
      const melhor = resultado.matches.reduce((a, b) => (a.score > b.score ? a : b));
      logger.debug({ melhor }, 'Produto mais relevante encontrado');
      if (melhor.score >= 0.5) return melhor.metadata;
    }
    return null;
  } catch (err) {
    logger.error({ err }, 'Erro ao buscar produto no Pinecone');
    return null;
  }
}

// --------------------- Função IA ---------------------
async function gerarResposta(pergunta, produtoInfo) {
  try {
    let mensagem = produtoInfo
      ? `Usuário perguntou: ${pergunta}\nProduto encontrado: Nome: ${produtoInfo.nome}, Descrição: ${produtoInfo.descricao}, Preço: ${produtoInfo.preco}. Responda de forma útil e natural.`
      : `Usuário perguntou: ${pergunta}\nNão encontramos produto relevante. Tente entender a intenção do usuário e responda de forma educada.`;

    logger.debug({ mensagem }, 'Enviando para OpenRouter');
    const r = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: mensagem }]
    }, { headers: { Authorization: `Bearer ${OPENROUTER_KEY}` } });

    logger.debug({ resposta: r.data.choices[0].message.content }, 'Resposta recebida da OpenRouter');
    return r.data.choices[0].message.content;
  } catch (err) {
    logger.error({ err }, 'Erro ao gerar resposta OpenRouter');
    return 'Ops! Ocorreu um erro na IA. Tente novamente mais tarde.';
  }
}

// --------------------- Express ---------------------
app.get('/', (_, res) => res.send('Bot Online'));

let latestQr = null;
let qrPendingResolve = null;

app.get('/qr', async (_, res) => {
  if (latestQr) return res.send(`<img src="${latestQr}"/>`);
  const qrData = await new Promise((resolve) => { qrPendingResolve = resolve; });
  res.send(`<img src="${qrData}"/>`);
});

// Corrigido: não espera QR, responde imediatamente
app.get('/desconectar', async (_, res) => {
  try {
    if (sockRef?.ws) {
      sockRef.ws.close();
      latestQr = null;
      logger.info('Sessão WhatsApp desconectada');
    }

    // Inicia nova sessão em background
    startWA().catch(err => logger.error({ err }, 'Erro ao reiniciar sessão WA'));

    res.send('Sessão desconectada. Novo QR será gerado automaticamente. Acesse /qr para visualizar.');
  } catch (err) {
    logger.error({ err }, 'Erro no /desconectar');
    res.status(500).send('Erro ao desconectar o WhatsApp.');
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
  try {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({ version, auth: state, printQRInTerminal: false, logger });
    sockRef = sock;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        latestQr = await qrcode.toDataURL(qr);
        logger.info('QR gerado');
        if (qrPendingResolve) {
          qrPendingResolve(latestQr);
          qrPendingResolve = null;
        }
      }
      if (connection === 'close') {
        const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
        logger.warn({ code }, 'Conexão fechada');
        if (code !== DisconnectReason.loggedOut) setTimeout(startWA, 2000);
      } else if (connection === 'open') {
        latestQr = null;
        logger.info('WhatsApp conectado');
      }
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
          logger.info({ text }, 'Mensagem recebida');
          const produtoInfo = await buscarProduto(text);
          const resposta = await gerarResposta(text, produtoInfo);
          await sock.sendMessage(jid, { text: resposta });
          logger.info({ resposta }, 'Resposta enviada');
        } catch (err) {
          logger.error({ err }, 'Erro ao processar mensagem');
          await sock.sendMessage(jid, { text: 'Ops! Ocorreu um erro. Tente novamente mais tarde.' });
        }
      }
    });
  } catch (err) {
    logger.error({ err }, 'Erro ao iniciar WhatsApp');
    throw err;
  }
}

// --------------------- Main ---------------------
async function main() {
  try {
    logger.info('Inicializando Pinecone...');
    await initPinecone();
    logger.info('Iniciando WhatsApp...');
    await startWA();
  } catch (err) {
    logger.error({ err }, 'Erro fatal no main');
  }
}

main();
