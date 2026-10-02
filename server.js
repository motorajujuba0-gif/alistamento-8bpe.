'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') }); // no Replit, o token vem de Secrets
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

// Remove espaços, aspas e o prefixo "Bot " caso tenham sido colados junto com o valor
const limparEnv = (v) => (v || '').trim().replace(/^["']|["']$/g, '').replace(/^Bot\s+/i, '').trim();
const TOKEN = limparEnv(process.env.DISCORD_BOT_TOKEN);
const CHANNEL_ID = limparEnv(process.env.DISCORD_ADMIN_CHANNEL_ID);
const PORT = process.env.PORT || 3000;
const RP_ANO = parseInt(process.env.RP_ANO_ATUAL || '2026', 10);
const ORIGIN = process.env.FRONTEND_ORIGIN;

if (!TOKEN || TOKEN === 'COLE_SEU_TOKEN_AQUI' || !CHANNEL_ID) {
  console.error('ERRO: configure DISCORD_BOT_TOKEN e DISCORD_ADMIN_CHANNEL_ID no arquivo .env');
  process.exit(1);
}
if (!/^\d{17,20}$/.test(CHANNEL_ID)) {
  console.error('ERRO: DISCORD_ADMIN_CHANNEL_ID deve conter apenas o ID numérico do canal.');
  process.exit(1);
}
// Nunca imprime o token — só confirma que foi carregado
console.log(`Configuração: token carregado (${TOKEN.length} caracteres), canal ${CHANNEL_ID}`);

const app = express();
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      connectSrc: ["'self'"],
      imgSrc: ["'self'", 'data:']
    }
  }
}));
app.use(cors(ORIGIN ? { origin: ORIGIN, methods: ['POST', 'GET'] } : { origin: false }));
app.use(express.json({ limit: '2kb' }));

// Limite por IP: 5 envios a cada 10 minutos
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, erro: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' }
});

// Anti-duplicação: o mesmo nick só pode enviar 1 vez a cada 30 minutos
const recentes = new Map();
const COOLDOWN = 30 * 60 * 1000;
setInterval(() => {
  const agora = Date.now();
  for (const [k, t] of recentes) if (agora - t > COOLDOWN) recentes.delete(k);
}, 60 * 1000).unref();

const limpar = (s) => String(s).normalize('NFC').replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
// Neutraliza markdown e menções do Discord
const escapar = (s) => s.replace(/([\\*_`~|>:@#\[\]()])/g, '\\$1');

function validar(body) {
  if (!body || typeof body !== 'object') return { erro: 'Dados inválidos.' };
  const roblox = limpar(body.roblox ?? '');
  const nomeRP = limpar(body.nomeRP ?? '');
  const idadeRP = Number(body.idadeRP);
  const ano = Number(body.anoNascimentoRP);

  if (!/^[A-Za-z0-9_]{3,20}$/.test(roblox))
    return { erro: 'Nick do Roblox inválido (3 a 20 caracteres: letras, números e _).' };
  if (!/^[A-Za-zÀ-ÖØ-öø-ÿ' ]{3,40}$/.test(nomeRP) || !nomeRP.includes(' '))
    return { erro: 'Informe nome e sobrenome de RP (apenas letras, 3 a 40 caracteres).' };
  if (!Number.isInteger(idadeRP) || ![18, 19].includes(idadeRP))
    return { erro: 'Para este alistamento, a idade permitida no RP é de 18 ou 19 anos.' };
  if (!Number.isInteger(ano) || ano < 1900 || ano > 2007)
    return { erro: 'O ano de nascimento informado não atende aos requisitos deste alistamento.' };
  // Coerência: nascido em (ano RP - idade) ou (ano RP - idade - 1), conforme o aniversário
  if (ano !== RP_ANO - idadeRP && ano !== RP_ANO - idadeRP - 1)
    return { erro: 'A idade e o ano de nascimento informados não são coerentes entre si.' };
  return { roblox, nomeRP, idadeRP, ano };
}

app.post('/api/alistamento', limiter, async (req, res) => {
  const v = validar(req.body);
  if (v.erro) return res.status(400).json({ ok: false, erro: v.erro });

  const chave = v.roblox.toLowerCase();
  if (recentes.has(chave) && Date.now() - recentes.get(chave) < COOLDOWN)
    return res.status(429).json({ ok: false, erro: 'Já existe um pedido recente para este nick. Aguarde a análise.' });

  const dataHora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const embed = {
    title: '🇧🇷 NOVO PEDIDO DE REVISÃO',
    color: 0x3b5d2e,
    description: '━━━━━━━━━━━━━━━━━━',
    fields: [
      { name: '🎮 Nick Roblox', value: escapar(v.roblox) },
      { name: '👤 Nome de RP', value: escapar(v.nomeRP) },
      { name: '🎂 Idade no RP', value: String(v.idadeRP), inline: true },
      { name: '📅 Ano de nascimento RP', value: String(v.ano), inline: true },
      { name: '📋 Status', value: 'AGUARDANDO ANÁLISE' },
      { name: '🕐 Data/Hora', value: dataHora }
    ],
    footer: { text: '8º BPE RP • SISTEMA DE ALISTAMENTO' },
    timestamp: new Date().toISOString()
  };

  recentes.set(chave, Date.now()); // reserva antes do envio (evita duplo clique simultâneo)
  try {
    const r = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(CHANNEL_ID)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } })
    });
    if (!r.ok) {
      console.error('Discord respondeu', r.status, await r.text());
      recentes.delete(chave);
      return res.status(502).json({ ok: false, erro: 'Não foi possível enviar à administração agora. Tente novamente em instantes.' });
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error('Falha ao contatar o Discord:', e.message);
    recentes.delete(chave);
    return res.status(502).json({ ok: false, erro: 'Falha de comunicação com o Discord. Tente novamente.' });
  }
});

// Verifica se o bot enxerga o canal: abra /api/saude no navegador
app.get('/api/saude', async (_req, res) => {
  try {
    const r = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(CHANNEL_ID)}`, {
      headers: { Authorization: `Bot ${TOKEN}` }
    });
    res.status(r.ok ? 200 : 502).json({ ok: r.ok, discordStatus: r.status });
  } catch { res.status(502).json({ ok: false }); }
});

// Serve o frontend (útil para hospedar tudo junto)
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.use((err, _req, res, _next) => {
  console.error(err.message);
  res.status(400).json({ ok: false, erro: 'Requisição inválida.' });
});

app.listen(PORT, () => console.log(`8º BPE RP — servidor em http://localhost:${PORT}`));
