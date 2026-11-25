process.env.TZ = 'America/Fortaleza'; // 🟢 Força o servidor (local e Render) a usar o fuso horário de Fortaleza (-03:00)

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const crypto = require('crypto');
const { default: makeWASocket, DisconnectReason, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// 🟢 (OPCIONAL, recomendado) senhas criptografadas: npm install bcryptjs
let bcrypt = null;
try { bcrypt = require('bcryptjs'); } catch (e) { /* segue sem bcrypt */ }

const app = express();
app.set('trust proxy', 1); // 🟢 Render: faz o req.ip refletir o IP real do visitante
app.disable('x-powered-by');

// 🟢 CORS: defina CORS_ORIGINS no Render (ex: https://seusite.com,https://www.seusite.com)
const origensPermitidas = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: origensPermitidas.length ? origensPermitidas : '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const MONGO_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'troque_essa_chave_no_render_otica_elos';
const EXIGIR_AUTH_ADMIN = process.env.EXIGIR_AUTH_ADMIN === 'true';

if (!EXIGIR_AUTH_ADMIN) {
  console.warn('⚠️ EXIGIR_AUTH_ADMIN não está ativo. Defina EXIGIR_AUTH_ADMIN=true e JWT_SECRET no Render assim que o front enviar o header Authorization.');
}

// 🟢 FUNÇÃO AUXILIAR DE DATA EXATA NO FUSO DE FORTALEZA (YYYY-MM-DD)
const obterDataHojeBR = () => {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Fortaleza' });
};

let whatsappClient = null;
let statusConexao = 'Iniciando...';
let qrCodeBase64 = null;

// 🟢 CONTROLES DE SEGURANÇA DO WHATSAPP
let tentativasConexao = 0;
let reconectando = false;

// ============================================================
// ✅ Boot do Express em paralelo, WhatsApp em background
// ============================================================
mongoose.connect(MONGO_URI)
  .then(() => {
    console.log('✅ Banco MongoDB da Ótica Elos Conectado!');
    atualizarVendasAntigas().catch(e => console.error('erro atualizarVendas:', e));
    inicializarMensagensPadrao().catch(e => console.error('erro msgs:', e));
    inicializarAdmin().catch(e => console.error('erro admin:', e));

    console.log('⏳ WhatsApp será iniciado em 60s (background)...');
    setTimeout(() => {
      console.log('🤖 Iniciando WhatsApp em background...');
      inicializarWhatsApp().catch(e => console.error('erro whatsapp:', e));
    }, 60000);
  })
  .catch(err => console.error('❌ Erro na conexão:', err));

// ==========================================
// --- MODELOS (SCHEMAS) ---
// ==========================================

const FuncionarioSchema = new mongoose.Schema({
  nome: { type: String, required: true },
  usuario: { type: String, required: true, unique: true },
  senha: { type: String, required: true },
  cargo: { type: String, enum: ['ADMIN', 'VENDEDOR'], default: 'VENDEDOR' },
  ativo: { type: Boolean, default: true }
});
const Funcionario = mongoose.model('Funcionario', FuncionarioSchema);

const Cliente = mongoose.model('Cliente', {
  nome: String, cpf: String, dataNascimento: String, telefone: String, email: String, origem: String, endereco: String, observacoes: String, foto: String,
  senha: { type: String, default: '' }, tokenRecuperacao: { type: String, default: null }, tokenExpiraEm: { type: Date, default: null }
});

// 🟢 Modelo Venda com suporte a dataEntrada e Renegociação de Dívidas
const Venda = mongoose.model('Venda', {
  numeroPedido: Number, cliente: String, cpf: String, produto: String, itensCarrinho: Array, valorTotal: Number, valorEntrada: Number, desconto: Number, parcelas: Number, listaParcelas: Array, dataVenda: String, dataEntrada: String, metodoPagamento: String, dataPrevisaoPagamento: String, observacoes: String, foto: String, dataPrimeiraParcela: String,
  renegociada: { type: Boolean, default: false },
  renegociadaEm: String
});

const Despesa = mongoose.model('Despesa', { descricao: String, valor: Number, categoria: String, vencimento: String, paga: Boolean });

// 🟢 Modelo Produto com campo descricao
const ProdutoSchema = new mongoose.Schema({
  nome: { type: String, required: true },
  preco: { type: Number, required: true },
  categoria: { type: String, required: true },
  quantidade: { type: Number, default: 0 },
  referencia: { type: String, default: '' },
  foto: { type: String, default: '' },
  fotos: [{ type: String }],
  descricao: { type: String, default: '' }
});
const Produto = mongoose.model('Produto', ProdutoSchema, 'produtos');

const Configuracao = mongoose.model('Configuracao', { chave: String, valor: String });

// 🟢 Persistência completa da sessão do Baileys (creds + Signal keys)
const WhatsAppAuth = mongoose.model('WhatsAppAuth', new mongoose.Schema({
  _id: String,
  valor: String
}));

const OrdemServico = mongoose.model('OrdemServico', {
  numeroPedido: String, dataCriacao: String, lente: String, tratamento: String, armacao: String,
  longe_od_esf: String, longe_od_cil: String, longe_od_eixo: String, longe_od_dnp: String,
  longe_oe_esf: String, longe_oe_cil: String, longe_oe_eixo: String, longe_oe_dnp: String,
  adicao: String, co_od_esf: String, co_od_cil: String, co_od_eixo: String, co_od_dnp: String,
  co_oe_esf: String, co_oe_cil: String, co_oe_eixo: String, co_oe_dnp: String,
  perto_od_esf: String, perto_od_cil: String, perto_od_eixo: String, perto_od_dnp: String,
  perto_oe_esf: String, perto_oe_cil: String, perto_oe_eixo: String, perto_oe_dnp: String,
  medidas_vertical: String, medidas_horizontal: String, medidas_ponte: String, medidas_diag: String,
  observacoes: String, consultor: String
});

// 🟢 Modelo Cupom com limite de uso (Padrão: 1) e controle de usos
const CupomSchema = new mongoose.Schema({
  codigo: { type: String, required: true, uppercase: true, unique: true },
  tipo: { type: String, enum: ['PERCENTUAL', 'FIXO'], required: true },
  valor: { type: Number, required: true },
  dataFim: { type: Date, required: true },
  limiteUso: { type: Number, default: 1 },
  usosAtuais: { type: Number, default: 0 },
  cpfsUtilizados: [{ type: String }],
  ativo: { type: Boolean, default: true }
});
const Cupom = mongoose.model('Cupom', CupomSchema);

const PedidoOnlineSchema = new mongoose.Schema({
  numeroPedidoOnline: Number, clienteNome: String, clienteTelefone: String, clienteCpf: String, clienteEndereco: String,
  itens: Array,
  subtotal: Number,
  descontoCupom: Number,
  valorTotal: Number, freteValor: Number, freteTipo: String, cupomUtilizado: String,
  status: { type: String, default: 'AGUARDANDO_PAGAMENTO' },
  estoqueBaixado: { type: Boolean, default: false },
  dataPedido: { type: Date, default: Date.now }, infinitePayId: String
});
const PedidoOnline = mongoose.model('PedidoOnline', PedidoOnlineSchema);

// 🟢 Contadores atômicos (evitam repetir número de pedido, mesmo com requisições simultâneas ou exclusões)
const Contador = mongoose.model('Contador', new mongoose.Schema({ _id: String, seq: Number }));

async function proximoNumeroPedidoOnline() {
  try {
    const ultimo = await PedidoOnline.findOne().sort({ numeroPedidoOnline: -1 }).select('numeroPedidoOnline').lean();
    const semente = Math.max((ultimo && ultimo.numeroPedidoOnline) || 0, 999);
    await Contador.updateOne({ _id: 'pedidoOnline' }, { $setOnInsert: { seq: semente } }, { upsert: true }).catch(() => {});
  } catch (e) { /* segue para o incremento */ }
  const doc = await Contador.findOneAndUpdate({ _id: 'pedidoOnline' }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  return doc.seq;
}

async function proximoNumeroVenda() {
  try {
    const ultima = await Venda.findOne().sort({ numeroPedido: -1 }).select('numeroPedido').lean();
    const semente = Math.max((ultima && ultima.numeroPedido) || 0, 1999);
    await Contador.updateOne({ _id: 'vendaNumeroPedido' }, { $setOnInsert: { seq: semente } }, { upsert: true }).catch(() => {});
  } catch (e) { /* segue para o incremento */ }
  const doc = await Contador.findOneAndUpdate({ _id: 'vendaNumeroPedido' }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  return doc.seq;
}

// ==========================================
// 🔐 HELPERS DE AUTENTICAÇÃO, JWT E SEGURANÇA
// ==========================================
const limparCpf = (c) => String(c || '').replace(/\D/g, '');
const formatarCpf = (d) => `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;

const buscarClientePorCpf = (digitos) =>
  Cliente.findOne({ cpf: { $in: [digitos, formatarCpf(digitos)] } });

const semSegredos = (c) => {
  const o = c && c.toObject ? c.toObject() : { ...c };
  delete o.senha;
  delete o.tokenRecuperacao;
  delete o.tokenExpiraEm;
  return o;
};

// 🟢 JWT nativo (HMAC-SHA256) sem dependências extras
const base64UrlEncode = (str) => Buffer.from(str).toString('base64url');
const base64UrlDecode = (str) => Buffer.from(str, 'base64url').toString('utf8');

function assinarToken(payload, expSegundos = 60 * 60 * 24 * 7) {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const agora = Math.floor(Date.now() / 1000);
  const corpo = base64UrlEncode(JSON.stringify({ ...payload, iat: agora, exp: agora + expSegundos }));
  const assinatura = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${corpo}`).digest('base64url');
  return `${header}.${corpo}.${assinatura}`;
}

function verificarToken(token) {
  try {
    const partes = String(token || '').split('.');
    if (partes.length !== 3) return null;
    const [header, corpo, assinatura] = partes;
    const esperada = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${corpo}`).digest('base64url');
    const a = Buffer.from(assinatura);
    const b = Buffer.from(esperada);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const dados = JSON.parse(base64UrlDecode(corpo));
    if (dados.exp && Math.floor(Date.now() / 1000) > dados.exp) return null;
    return dados;
  } catch (e) {
    return null;
  }
}

// 🟢 Middleware de proteção das rotas administrativas
function exigirEquipe(cargosPermitidos = ['ADMIN', 'VENDEDOR']) {
  return (req, res, next) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

    if (token) {
      const usuario = verificarToken(token);
      if (!usuario) return res.status(401).json({ error: 'Sessão expirada ou token inválido.' });
      if (!cargosPermitidos.includes(usuario.cargo)) {
        return res.status(403).json({ error: 'Permissão insuficiente para esta ação.' });
      }
      req.usuario = usuario;
      return next();
    }

    if (EXIGIR_AUTH_ADMIN) {
      return res.status(401).json({ error: 'Autenticação obrigatória.' });
    }
    return next();
  };
}

// 🟢 Retorna os dados do cliente (sem senha) + token JWT exclusivo de cliente
const comTokenCliente = (c) => {
  const limpo = semSegredos(c);
  const token = assinarToken({
    id: String(limpo._id),
    cpf: limparCpf(limpo.cpf),
    tipo: 'CLIENTE'
  });
  return { ...limpo, token };
};

// 🟢 Middleware exclusivo para rotas da área do cliente
function exigirCliente(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    return res.status(401).json({ error: 'Faça login para acessar seus pedidos.' });
  }
  const dados = verificarToken(token);
  if (!dados || dados.tipo !== 'CLIENTE' || !dados.cpf) {
    return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
  }
  req.cliente = dados;
  return next();
}

// Limitador simples de tentativas (em memória)
const tentativasRecentes = new Map();
function limitar(chave, max = 8, janelaMs = 15 * 60 * 1000) {
  const agora = Date.now();
  const reg = tentativasRecentes.get(chave) || { n: 0, ate: agora + janelaMs };
  if (agora > reg.ate) { reg.n = 0; reg.ate = agora + janelaMs; }
  reg.n += 1;
  tentativasRecentes.set(chave, reg);
  return reg.n > max;
}
const liberarLimite = (chave) => tentativasRecentes.delete(chave);
setInterval(() => {
  const agora = Date.now();
  for (const [k, v] of tentativasRecentes) if (agora > v.ate) tentativasRecentes.delete(k);
}, 10 * 60 * 1000).unref();

const ehHash = (s) => /^\$2[aby]\$/.test(String(s || ''));
async function verificarSenha(plana, armazenada) {
  if (!armazenada) return false;
  if (ehHash(armazenada)) return bcrypt ? bcrypt.compare(plana, armazenada) : false;
  return plana === armazenada;
}
async function gerarHash(plana) {
  return bcrypt ? bcrypt.hash(plana, 10) : plana;
}

const emailValido = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

const inicializarAdmin = async () => {
  try {
    const adminExiste = await Funcionario.findOne({ cargo: 'ADMIN' });
    if (!adminExiste) {
      const senhaInicial = process.env.ADMIN_SENHA_INICIAL || '123';
      if (!process.env.ADMIN_SENHA_INICIAL) console.warn("⚠️ ADMIN_SENHA_INICIAL não definida: usando senha padrão '123'. Troque-a imediatamente.");
      await new Funcionario({
        nome: 'Administrador (Dono)',
        usuario: 'admin',
        senha: await gerarHash(senhaInicial),
        cargo: 'ADMIN'
      }).save();
      console.log('👤 Usuário Mestre criado com sucesso!');
    }
  } catch (err) {}
};

const atualizarVendasAntigas = async () => {
  try {
    const vendasSemNumero = await Venda.find({ numeroPedido: { $exists: false } }).sort({ dataVenda: 1 });
    if (vendasSemNumero.length > 0) {
      for (let i = 0; i < vendasSemNumero.length; i++) {
        vendasSemNumero[i].numeroPedido = await proximoNumeroVenda();
        await vendasSemNumero[i].save();
      }
    }
  } catch (err) {}
};

const inicializarMensagensPadrao = async () => {
  try {
    const msgAniv = await Configuracao.findOne({ chave: 'msg_aniversario' });
    if (!msgAniv) await new Configuracao({ chave: 'msg_aniversario', valor: 'Olá, {nome}! 🎉 Feliz aniversário!' }).save();
    const msgPosVenda = await Configuracao.findOne({ chave: 'msg_pos_venda' });
    if (!msgPosVenda) await new Configuracao({ chave: 'msg_pos_venda', valor: 'Olá, {nome}! Tudo bem? 😊' }).save();
    const chavePix = await Configuracao.findOne({ chave: 'chave_pix_carne' });
    if (!chavePix) await new Configuracao({ chave: 'chave_pix_carne', valor: '(85) 8550-6571' }).save();
  } catch (err) {}
};

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_REMETENTE || 'seuemail@gmail.com', pass: process.env.SENHA_EMAIL || 'sua_senha_de_app_aqui' }
});

// ==========================================
// 🛠️ ROTAS DE CONTROLE GERAL E WHATSAPP
// ==========================================
app.get('/api/whatsapp/status', exigirEquipe(['ADMIN']), (req, res) => res.json({ status: statusConexao, qr: qrCodeBase64 }));

app.post('/api/whatsapp/desconectar', exigirEquipe(['ADMIN']), async (req, res) => {
  try {
    statusConexao = 'Desconectando...';
    if (whatsappClient) {
      try { await whatsappClient.logout(); } catch (e) {}
    }
    await Promise.all([
      WhatsAppAuth.deleteMany({}),
      Configuracao.deleteOne({ chave: 'whatsapp_session_creds' })
    ]);

    statusConexao = 'Desconectado';
    qrCodeBase64 = null;
    whatsappClient = null;
    tentativasConexao = 0;
    reconectando = false;

    res.json({ success: true, message: 'Sessão encerrada e limpa.' });

    setTimeout(() => { inicializarWhatsApp(true); }, 3000);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/whatsapp/conectar', exigirEquipe(['ADMIN']), async (req, res) => {
  try {
    statusConexao = 'Iniciando...';
    qrCodeBase64 = null;
    tentativasConexao = 0;
    reconectando = false;
    res.json({ success: true, message: 'Iniciando conexão...' });
    setTimeout(() => { inicializarWhatsApp(true).catch(e => console.error(e)); }, 1000);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/whatsapp/mensagens', exigirEquipe(['ADMIN', 'VENDEDOR']), async (req, res) => {
  try {
    const configs = await Configuracao.find({ chave: { $in: ['msg_aniversario', 'msg_pos_venda', 'chave_pix_carne'] } });
    const mapa = {}; configs.forEach(c => mapa[c.chave] = c.valor); res.json(mapa);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

app.post('/api/whatsapp/mensagens', exigirEquipe(['ADMIN', 'VENDEDOR']), async (req, res) => {
  try {
    const { msg_aniversario, msg_pos_venda, chave_pix_carne } = req.body;
    if (msg_aniversario !== undefined) await Configuracao.updateOne({ chave: 'msg_aniversario' }, { valor: msg_aniversario }, { upsert: true });
    if (msg_pos_venda !== undefined) await Configuracao.updateOne({ chave: 'msg_pos_venda' }, { valor: msg_pos_venda }, { upsert: true });
    if (chave_pix_carne !== undefined) await Configuracao.updateOne({ chave: 'chave_pix_carne' }, { valor: chave_pix_carne }, { upsert: true });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// ==========================================
// 👥 FUNCIONÁRIOS
// ==========================================
app.post('/api/funcionarios/login', async (req, res) => {
  try {
    const usuario = String(req.body.usuario || '').trim().toLowerCase();
    const senha = String(req.body.senha || '');
    if (!usuario || !senha) return res.status(400).json({ error: 'Informe usuário e senha.' });

    const chaveLogin = `func:${req.ip}:${usuario}`;
    if (limitar(`func-ip:${req.ip}`, 30) || limitar(chaveLogin, 8)) {
      return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' });
    }

    const func = await Funcionario.findOne({ usuario });
    if (!func || !(await verificarSenha(senha, func.senha))) {
      return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
    }
    if (!func.ativo) return res.status(403).json({ error: 'Sua conta foi desativada pelo administrador.' });

    if (bcrypt && !ehHash(func.senha)) {
      func.senha = await gerarHash(senha);
      await func.save();
    }

    liberarLimite(chaveLogin);
    const token = assinarToken({ id: String(func._id), usuario: func.usuario, cargo: func.cargo });
    res.json({ id: func._id, nome: func.nome, usuario: func.usuario, cargo: func.cargo, token });
  } catch (err) { res.status(500).json({ error: 'Erro no servidor' }); }
});

app.get('/api/funcionarios', exigirEquipe(['ADMIN']), async (req, res) => {
  try { res.json(await Funcionario.find().select('-senha')); } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

app.post('/api/funcionarios', exigirEquipe(['ADMIN']), async (req, res) => {
  try {
    const { senha, _id, ...resto } = req.body;
    const usuario = String(resto.usuario || '').trim().toLowerCase();
    if (!usuario || !senha || String(senha).length < 3) return res.status(400).json({ error: 'Informe usuário e uma senha válida.' });

    const novoFunc = await new Funcionario({ ...resto, usuario, senha: await gerarHash(String(senha)) }).save();
    const retorno = novoFunc.toObject(); delete retorno.senha;
    res.status(201).json(retorno);
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ error: 'Este nome de usuário já está em uso.' });
    res.status(500).json({ error: 'Erro' });
  }
});

async function ehUltimoAdminAtivo(id) {
  const alvo = await Funcionario.findById(id);
  if (!alvo || alvo.cargo !== 'ADMIN' || !alvo.ativo) return false;
  const outros = await Funcionario.countDocuments({ cargo: 'ADMIN', ativo: true, _id: { $ne: id } });
  return outros === 0;
}

app.put('/api/funcionarios/:id', exigirEquipe(['ADMIN', 'VENDEDOR']), async (req, res) => {
  try {
    // Se autenticado como VENDEDOR, só pode editar os próprios dados (sem mudar cargo/ativo)
    if (req.usuario && req.usuario.cargo !== 'ADMIN' && req.usuario.id !== req.params.id) {
      return res.status(403).json({ error: 'Você só pode editar suas próprias credenciais.' });
    }

    const { senha, _id, ...dados } = req.body;
    if (req.usuario && req.usuario.cargo !== 'ADMIN') {
      delete dados.cargo;
      delete dados.ativo;
    }

    if (dados.usuario) dados.usuario = String(dados.usuario).trim().toLowerCase();
    if (senha !== undefined && String(senha).trim() !== '') dados.senha = await gerarHash(String(senha));

    const perdeAdmin = (dados.cargo && dados.cargo !== 'ADMIN') || dados.ativo === false;
    if (perdeAdmin && await ehUltimoAdminAtivo(req.params.id)) {
      return res.status(400).json({ error: 'Não é possível rebaixar ou desativar o único administrador ativo.' });
    }

    const func = await Funcionario.findByIdAndUpdate(req.params.id, dados, { new: true }).select('-senha');
    if (!func) return res.status(404).json({ error: 'Funcionário não encontrado.' });
    res.json(func);
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ error: 'Este nome de usuário já está em uso.' });
    res.status(500).json({ error: 'Erro' });
  }
});

app.delete('/api/funcionarios/:id', exigirEquipe(['ADMIN']), async (req, res) => {
  try {
    if (await ehUltimoAdminAtivo(req.params.id)) {
      return res.status(400).json({ error: 'Não é possível excluir o único administrador ativo.' });
    }
    await Funcionario.findByIdAndDelete(req.params.id);
    res.json({ message: 'Excluído.' });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// ==========================================
// 🎟️ FRETE, CUPONS, PREÇOS E CÁLCULO DO PEDIDO (NO SERVIDOR)
// ==========================================

const arred = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

class ErroNegocio extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const FRETES = {
  retirada: { nome: 'Retirar na Loja (Bela Vista)', valor: 0 },
  motoboy:  { nome: 'Motoboy Fortaleza/Região', valor: 15.00 },
  pac:      { nome: 'Correios PAC', valor: 28.90 },
  sedex:    { nome: 'Correios Sedex', valor: 45.50 }
};
const PREFIXOS_MOTOBOY = ['60', '61'];

// 🟢 Cache de cotação por CEP (15 min): garante que /api/frete e calcularPedido cobrem o mesmo valor
const cacheFrete = new Map();
const TTL_FRETE_MS = 15 * 60 * 1000;

async function obterOpcoesFrete(cepBruto) {
  const cepDestinoLimpo = String(cepBruto || '').replace(/\D/g, '');
  if (cepDestinoLimpo.length !== 8) {
    return [{ id: 'retirada', nome: FRETES.retirada.nome, valor: 0.00, prazo: 'Imediato' }];
  }

  const emCache = cacheFrete.get(cepDestinoLimpo);
  if (emCache && Date.now() < emCache.ate) return emCache.opcoes;

  const cepOrigem = '60442000';
  const urlBase = `https://brasilapi.com.br/api/correios/v1/frete/preco?sCepOrigem=${cepOrigem}&sCepDestino=${cepDestinoLimpo}&nVlPeso=0.3&nCdFormato=1&nVlComprimento=16&nVlAltura=11&nVlLargura=11`;

  const [pacS, sedexS] = await Promise.allSettled([
    fetch(`${urlBase}&nCdServico=04510`),
    fetch(`${urlBase}&nCdServico=04014`)
  ]);

  const opcoes = [
    { id: 'retirada', nome: FRETES.retirada.nome, valor: 0.00, prazo: 'Imediato' }
  ];

  if (PREFIXOS_MOTOBOY.includes(cepDestinoLimpo.substring(0, 2))) {
    opcoes.push({ id: 'motoboy', nome: FRETES.motoboy.nome, valor: FRETES.motoboy.valor, prazo: '1 dia útil' });
  }

  const lerCorreios = async (resultado, id, nome) => {
    try {
      if (resultado.status !== 'fulfilled' || !resultado.value.ok) return;
      const dados = await resultado.value.json();
      const valor = arred(String(dados[0].Valor).replace(',', '.'));
      if (!isNaN(valor) && valor > 0) {
        opcoes.push({ id, nome, valor, prazo: `${dados[0].PrazoEntrega} dias úteis` });
      }
    } catch (e) { /* usa o padrão abaixo */ }
  };

  await lerCorreios(pacS, 'pac', FRETES.pac.nome);
  await lerCorreios(sedexS, 'sedex', FRETES.sedex.nome);

  if (!opcoes.some(o => o.id === 'pac')) {
    opcoes.push({ id: 'pac', nome: FRETES.pac.nome, valor: FRETES.pac.valor, prazo: '5 a 8 dias úteis' });
  }
  if (!opcoes.some(o => o.id === 'sedex')) {
    opcoes.push({ id: 'sedex', nome: FRETES.sedex.nome, valor: FRETES.sedex.valor, prazo: '2 a 3 dias úteis' });
  }

  cacheFrete.set(cepDestinoLimpo, { opcoes, ate: Date.now() + TTL_FRETE_MS });
  return opcoes;
}

function verificarCupom(cupom, cpfLimpo) {
  if (!cupom) return 'Cupom não encontrado.';
  if (!cupom.ativo) return 'Este cupom está inativo.';
  if (new Date() > new Date(cupom.dataFim)) return 'Este cupom já expirou.';
  if ((cupom.usosAtuais || 0) >= (cupom.limiteUso ?? 1)) return 'Este cupom já atingiu o limite máximo de utilizações.';
  if (cpfLimpo && (cupom.cpfsUtilizados || []).includes(cpfLimpo)) return 'Você já utilizou este cupom anteriormente.';
  return null;
}

async function devolverUsoCupom(filtro, cpfLimpo) {
  const c = await Cupom.findOneAndUpdate(
    { ...filtro, usosAtuais: { $gt: 0 } },
    { $inc: { usosAtuais: -1 }, ...(cpfLimpo ? { $pull: { cpfsUtilizados: cpfLimpo } } : {}) },
    { new: true }
  );
  if (c && !c.ativo && (c.usosAtuais + 1) >= (c.limiteUso ?? 1)) {
    await Cupom.updateOne({ _id: c._id }, { ativo: true });
  }
}

function precoPromocional(produto, promocoes) {
  const regra = promocoes.find(p => p.nome === `PROMOCAO_${produto.categoria}`);
  if (!regra) return null;
  const v = Number(regra.preco);
  const novo = regra.referencia === 'PERCENTUAL'
    ? produto.preco - produto.preco * (v / 100)
    : produto.preco - v;
  return arred(Math.max(0, novo));
}

async function calcularPedido({ itens, cupomCodigo, cpf, freteId, cep }) {
  if (!Array.isArray(itens) || itens.length === 0) throw new ErroNegocio('Carrinho vazio.');

  // 🟢 Preserva quantidades de itens repetidos ou com campo `quantidade`
  const mapaQtd = new Map();
  for (const i of itens) {
    const id = String(i?.id || i?._id || '');
    if (!mongoose.isValidObjectId(id)) throw new ErroNegocio('Item inválido no carrinho.');
    const qtd = Math.max(1, parseInt(i?.quantidade, 10) || 1);
    mapaQtd.set(id, (mapaQtd.get(id) || 0) + qtd);
  }

  const ids = [...mapaQtd.keys()];
  const [produtos, promocoes] = await Promise.all([
    Produto.find({ _id: { $in: ids } }).lean(),
    Produto.find({ categoria: 'PROMO_CATE' }).lean()
  ]);
  if (produtos.length !== ids.length) throw new ErroNegocio('Um dos produtos não existe mais.');

  let temPromo = false;
  const temArmacao = produtos.some(p => p.categoria === 'ARMAÇÃO');

  const itensFinais = produtos.map(p => {
    const qtdSolicitada = mapaQtd.get(String(p._id)) || 1;
    if (['PROMO_CATE'].includes(p.categoria)) throw new ErroNegocio('Item inválido no carrinho.');
    if (p.categoria === 'UPSELL' && !temArmacao) throw new ErroNegocio('A oferta combo exige uma armação no carrinho.');
    if (p.categoria !== 'LENTE' && (p.quantidade || 0) < qtdSolicitada) {
      throw new ErroNegocio(`"${p.nome}" não possui estoque suficiente (${p.quantidade || 0} disponível).`);
    }

    let preco = Number(p.preco);
    if (p.categoria === 'UPSELL') temPromo = true;
    else {
      const promo = precoPromocional(p, promocoes);
      if (promo !== null && promo < preco) { preco = promo; temPromo = true; }
    }
    return {
      id: String(p._id),
      nome: p.nome,
      preco: arred(preco),
      quantidade: qtdSolicitada,
      referencia: p.referencia || ''
    };
  });

  const subtotal = arred(itensFinais.reduce((s, i) => s + i.preco * i.quantidade, 0));

  // Cupom
  let cupomDoc = null, descontoCupom = 0;
  const cpfLimpo = limparCpf(cpf);
  if (cupomCodigo) {
    if (temPromo) throw new ErroNegocio('Cupons não são cumulativos com itens em promoção.');
    cupomDoc = await Cupom.findOne({ codigo: String(cupomCodigo).toUpperCase() });
    const erro = verificarCupom(cupomDoc, cpfLimpo);
    if (erro) throw new ErroNegocio(erro);
    descontoCupom = cupomDoc.tipo === 'PERCENTUAL'
      ? subtotal * (Number(cupomDoc.valor) / 100)
      : Math.min(Number(cupomDoc.valor), subtotal);
    descontoCupom = arred(descontoCupom);
  }

  // 🟢 Frete calculado pela mesma função da rota /api/frete
  const idFrete = freteId || 'retirada';
  let frete;
  if (idFrete === 'retirada') {
    frete = FRETES.retirada;
  } else {
    const cepLimpo = String(cep || '').replace(/\D/g, '');
    if (cepLimpo.length !== 8) throw new ErroNegocio('Informe um CEP válido para a entrega.');
    const opcoes = await obterOpcoesFrete(cepLimpo);
    frete = opcoes.find(o => o.id === idFrete);
    if (!frete) {
      if (idFrete === 'motoboy') throw new ErroNegocio('Motoboy disponível apenas para Fortaleza e região.');
      throw new ErroNegocio('Opção de frete inválida.');
    }
  }

  const valorTotal = arred(Math.max(0, subtotal - descontoCupom) + frete.valor);
  return { itensFinais, subtotal, descontoCupom, valorTotal, frete, cupomDoc, cpfLimpo };
}

// 🟢 Estoque: baixa (-1) ou devolve (+1) respeitando a quantidade de cada item
async function ajustarEstoquePedido(itens, direcao) {
  for (const it of itens || []) {
    if (!it || !mongoose.isValidObjectId(it.id)) continue;
    const prod = await Produto.findById(it.id).select('categoria').lean();
    if (!prod || prod.categoria === 'LENTE') continue;
    const qtd = Math.max(1, parseInt(it.quantidade, 10) || 1);
    if (direcao < 0) {
      const r = await Produto.updateOne({ _id: it.id, quantidade: { $gte: qtd } }, { $inc: { quantidade: -qtd } });
      if (!r.modifiedCount) console.warn(`⚠️ Estoque insuficiente ao baixar ${qtd}x "${it.nome}".`);
    } else {
      await Produto.updateOne({ _id: it.id }, { $inc: { quantidade: qtd } });
    }
  }
}

app.get('/api/cupons', exigirEquipe(['ADMIN']), async (req, res) => {
  try { res.json(await Cupom.find().sort({ dataFim: -1 })); } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

app.post('/api/cupons', exigirEquipe(['ADMIN']), async (req, res) => {
  try {
    const { _id, ...corpo } = req.body;
    const tipo = corpo.tipo;
    const valor = Number(corpo.valor);

    if (!corpo.codigo || !String(corpo.codigo).trim()) return res.status(400).json({ error: 'Informe o código do cupom.' });
    if (!['PERCENTUAL', 'FIXO'].includes(tipo)) return res.status(400).json({ error: 'Tipo de desconto inválido.' });
    if (!(valor > 0) || (tipo === 'PERCENTUAL' && valor > 100)) {
      return res.status(400).json({ error: tipo === 'PERCENTUAL' ? 'A porcentagem deve estar entre 1 e 100.' : 'Informe um valor de desconto válido.' });
    }

    const dataPura = String(corpo.dataFim).split('T')[0];
    const dataFimAjustada = new Date(`${dataPura}T23:59:59-03:00`);
    if (isNaN(dataFimAjustada.getTime())) return res.status(400).json({ error: 'Data de validade inválida.' });

    const dadosCupom = {
      ...corpo,
      codigo: String(corpo.codigo).trim(),
      valor,
      dataFim: dataFimAjustada,
      limiteUso: corpo.limiteUso !== undefined && corpo.limiteUso !== '' ? Math.max(1, Number(corpo.limiteUso)) : 1,
      usosAtuais: 0,
      cpfsUtilizados: []
    };
    const novoCupom = new Cupom(dadosCupom);
    await novoCupom.save();
    res.status(201).json(novoCupom);
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ error: 'Já existe um cupom com este código.' });
    res.status(500).json({ error: 'Erro ao criar cupom.' });
  }
});

app.put('/api/cupons/:id', exigirEquipe(['ADMIN']), async (req, res) => {
  try {
    const { _id, ...dados } = req.body;
    if (typeof dados.dataFim === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dados.dataFim)) {
      dados.dataFim = new Date(`${dados.dataFim}T23:59:59-03:00`);
    }
    const cupomEditado = await Cupom.findByIdAndUpdate(req.params.id, dados, { new: true });
    if (!cupomEditado) return res.status(404).json({ error: 'Cupom não encontrado.' });
    res.json(cupomEditado);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

app.delete('/api/cupons/:id', exigirEquipe(['ADMIN']), async (req, res) => {
  try { await Cupom.findByIdAndDelete(req.params.id); res.json({ message: 'Excluído' }); } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

app.get('/api/cupons/validar/:codigo', async (req, res) => {
  try {
    const cupom = await Cupom.findOne({ codigo: req.params.codigo.toUpperCase() });
    const erro = verificarCupom(cupom, limparCpf(req.query.cpf));
    if (erro) return res.status(erro.includes('não encontrado') ? 404 : 400).json({ valido: false, error: erro });
    res.json({ valido: true, cupom });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// ==========================================
// 🧑‍🤝‍🧑 CLIENTES
// ==========================================

app.post('/api/clientes/login', async (req, res) => {
  try {
    const entrada = String(req.body.login || '').trim().toLowerCase();
    const senha = String(req.body.senha || '');
    if (!entrada || !senha) return res.status(400).json({ error: 'Informe login e senha.' });

    const chaveLogin = `login:${req.ip}:${entrada}`;
    if (limitar(`ip:${req.ip}`, 30) || limitar(chaveLogin, 8)) {
      return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' });
    }

    const digitos = limparCpf(entrada);
    let cliente = null;
    if (digitos.length === 11 && !entrada.includes('@')) {
      cliente = await buscarClientePorCpf(digitos);
    } else {
      cliente = await Cliente.findOne({ email: entrada }).collation({ locale: 'pt', strength: 2 });
    }

    if (!cliente || !(await verificarSenha(senha, cliente.senha))) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    if (bcrypt && !ehHash(cliente.senha)) {
      cliente.senha = await gerarHash(senha);
      await cliente.save();
    }

    liberarLimite(chaveLogin);
    res.json(comTokenCliente(cliente));
  } catch (err) {
    console.error('Erro no login de cliente:', err);
    res.status(500).json({ error: 'Erro no servidor.' });
  }
});

app.get('/api/clientes/status-cpf/:cpf', async (req, res) => {
  try {
    if (limitar(`status:${req.ip}`, 40)) {
      return res.status(429).json({ error: 'Muitas consultas. Aguarde alguns minutos.' });
    }
    const digitos = limparCpf(req.params.cpf);
    if (digitos.length !== 11) return res.status(400).json({ error: 'CPF inválido.' });

    const cliente = await buscarClientePorCpf(digitos);
    res.json({
      existe: !!cliente,
      temSenha: !!(cliente && cliente.senha && String(cliente.senha).trim() !== '')
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro no servidor.' });
  }
});

app.post('/api/clientes/ativar-conta', async (req, res) => {
  const MSG_FALHA = 'Não foi possível confirmar seus dados. Verifique o CPF e a data de nascimento, ou procure a loja para atualizar seu cadastro.';
  try {
    const digitos = limparCpf(req.body.cpf);
    const dataNascimento = String(req.body.dataNascimento || '').slice(0, 10);
    const senha = String(req.body.senha || '');
    const email = String(req.body.email || '').trim().toLowerCase();
    const telefone = String(req.body.telefone || '').trim();

    if (digitos.length !== 11) return res.status(400).json({ error: 'Informe um CPF válido com 11 dígitos.' });
    if (senha.length < 6) return res.status(400).json({ error: 'A senha precisa ter no mínimo 6 caracteres.' });
    if (!dataNascimento) return res.status(400).json({ error: 'Informe sua data de nascimento.' });
    if (!emailValido(email)) return res.status(400).json({ error: 'Informe um e-mail válido.' });

    if (limitar(`ativar:${req.ip}`, 10) || limitar(`ativar:${digitos}`, 5)) {
      return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' });
    }

    const cliente = await buscarClientePorCpf(digitos);
    const nascimentoCadastrado = cliente ? String(cliente.dataNascimento || '').slice(0, 10) : '';

    if (!cliente || (cliente.senha && String(cliente.senha).trim() !== '') ||
        !nascimentoCadastrado || nascimentoCadastrado !== dataNascimento) {
      return res.status(403).json({ error: MSG_FALHA });
    }

    const emailEmUso = await Cliente.findOne({ email, _id: { $ne: cliente._id } }).collation({ locale: 'pt', strength: 2 });
    if (emailEmUso) return res.status(409).json({ error: 'Este e-mail já está em uso por outra conta.' });

    cliente.senha = await gerarHash(senha);
    cliente.email = email;
    if (telefone) cliente.telefone = telefone;
    await cliente.save();

    liberarLimite(`ativar:${digitos}`);
    res.json(comTokenCliente(cliente));
  } catch (err) {
    console.error('Erro ao ativar conta:', err);
    res.status(500).json({ error: 'Erro no servidor.' });
  }
});

app.post('/api/clientes/cadastro-online', async (req, res) => {
  try {
    const digitos = limparCpf(req.body.cpf);
    const nome = String(req.body.nome || '').trim().toUpperCase();
    const email = String(req.body.email || '').trim().toLowerCase();
    const senha = String(req.body.senha || '');
    const dataNascimento = String(req.body.dataNascimento || '').slice(0, 10);
    const telefone = String(req.body.telefone || '').trim();
    const endereco = String(req.body.endereco || '').trim();

    if (limitar(`cadastro:${req.ip}`, 10)) {
      return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' });
    }
    if (digitos.length !== 11) return res.status(400).json({ error: 'Informe um CPF válido com 11 dígitos.' });
    if (nome.length < 3) return res.status(400).json({ error: 'Informe seu nome completo.' });
    if (!emailValido(email)) return res.status(400).json({ error: 'Informe um e-mail válido.' });
    if (senha.length < 6) return res.status(400).json({ error: 'A senha precisa ter no mínimo 6 caracteres.' });
    if (!dataNascimento) return res.status(400).json({ error: 'Informe sua data de nascimento.' });
    if (!telefone) return res.status(400).json({ error: 'Informe seu celular.' });

    if (await buscarClientePorCpf(digitos)) {
      return res.status(409).json({ error: 'Este CPF já possui cadastro. Use "Fazer Login" ou, se nunca criou uma senha, digite o CPF novamente para ativar seu acesso.' });
    }
    if (await Cliente.findOne({ email }).collation({ locale: 'pt', strength: 2 })) {
      return res.status(409).json({ error: 'Este e-mail já está em uso.' });
    }

    const novo = await new Cliente({
      nome, cpf: formatarCpf(digitos), dataNascimento, telefone, email, endereco,
      senha: await gerarHash(senha),
      origem: 'Site / Loja Virtual',
      observacoes: 'Cadastro via Portal Online'
    }).save();

    try {
      let num = telefone.replace(/\D/g, '');
      if (num && !num.startsWith('55')) num = `55${num}`;
      if (num) {
        const msg = `Olá, ${nome.split(' ')[0]}! ✨\n\nSeja muito bem-vindo(a) à *Ótica Elos*! Seu cadastro foi realizado com sucesso. Sempre que precisar, este é o nosso canal oficial de atendimento.`;
        resolverJidWhatsApp(num).then(jid => jid && enviarMensagemTexto(jid, msg)).catch(() => {});
      }
    } catch (e) { /* boas-vindas é opcional */ }

    res.status(201).json(comTokenCliente(novo));
  } catch (err) {
    console.error('Erro no cadastro online:', err);
    res.status(500).json({ error: 'Erro no servidor.' });
  }
});

app.post('/api/clientes/solicitar-recuperacao', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'E-mail obrigatório.' });
    if (limitar(`rec:${req.ip}`, 5) || limitar(`rec:${email}`, 3)) {
      return res.status(429).json({ error: 'Muitas solicitações. Aguarde alguns minutos.' });
    }

    const cliente = await Cliente.findOne({ email }).collation({ locale: 'pt', strength: 2 });
    if (cliente) {
      const codigo = String(crypto.randomInt(100000, 1000000));
      cliente.tokenRecuperacao = codigo;
      cliente.tokenExpiraEm = new Date(Date.now() + 15 * 60000);
      await cliente.save();

      transporter.sendMail({
        from: '"Ótica Elos - Suporte" <nao-responda@oticaelos.com>',
        to: cliente.email,
        subject: 'Recuperação de Senha - Ótica Elos',
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 30px; border: 1px solid #eee; border-radius: 10px;">
            <h2 style="color: #1d3026;">Olá, ${String(cliente.nome || '').split(' ')[0]}!</h2>
            <p>Recebemos um pedido de recuperação de senha para a sua conta na Ótica Elos E-commerce.</p>
            <p>Seu código de segurança é:</p>
            <div style="background-color: #f9f8f6; padding: 20px; text-align: center; font-size: 32px; letter-spacing: 5px; font-weight: bold; color: #1d3026; border-radius: 10px; margin: 20px 0;">
              ${codigo}
            </div>
            <p style="font-size: 12px; color: #666;">Este código é válido por 15 minutos. Se não foi você, ignore este e-mail.</p>
          </div>`
      }).catch((e) => console.error('Falha ao enviar e-mail de recuperação:', e.message));
    }

    res.json({ success: true, message: 'Se o e-mail estiver cadastrado, enviaremos um código.' });
  } catch (err) { res.status(500).json({ error: 'Erro ao processar.' }); }
});

app.post('/api/clientes/redefinir-senha', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const token = String(req.body.token || '').trim();
    const novaSenha = String(req.body.novaSenha || '');

    if (!email || !token) return res.status(400).json({ error: 'Código inválido ou expirado.' });
    if (novaSenha.length < 6) return res.status(400).json({ error: 'A senha precisa ter no mínimo 6 caracteres.' });

    if (limitar(`red:${email}`, 5) || limitar(`red-ip:${req.ip}`, 20)) {
      return res.status(429).json({ error: 'Muitas tentativas. Solicite um novo código mais tarde.' });
    }

    const cliente = await Cliente.findOne({ email }).collation({ locale: 'pt', strength: 2 });
    if (!cliente || !cliente.tokenRecuperacao || cliente.tokenRecuperacao !== token ||
        !cliente.tokenExpiraEm || new Date() > cliente.tokenExpiraEm) {
      return res.status(400).json({ error: 'Código inválido ou expirado.' });
    }

    cliente.senha = await gerarHash(novaSenha);
    cliente.tokenRecuperacao = null;
    cliente.tokenExpiraEm = null;
    await cliente.save();

    liberarLimite(`red:${email}`);
    res.json({ success: true, message: 'Senha atualizada.' });
  } catch (err) { res.status(500).json({ error: 'Erro ao redefinir.' }); }
});

app.get('/api/clientes', exigirEquipe(['ADMIN', 'VENDEDOR']), async (req, res) => {
  try {
    res.json(await Cliente.find().select('-senha -tokenRecuperacao -tokenExpiraEm').sort({ nome: 1 }));
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

app.get('/api/clientes/:id', exigirEquipe(['ADMIN', 'VENDEDOR']), async (req, res) => {
  try {
    const cliente = await Cliente.findById(req.params.id).select('-senha -tokenRecuperacao -tokenExpiraEm');
    if (!cliente) return res.status(404).json({ error: 'Não encontrado' });
    res.json(cliente);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

app.post('/api/clientes', exigirEquipe(['ADMIN', 'VENDEDOR']), async (req, res) => {
  try {
    const { senha, tokenRecuperacao, tokenExpiraEm, _id, ...dados } = req.body;
    const digitos = limparCpf(dados.cpf);
    if (digitos.length === 11 && await buscarClientePorCpf(digitos)) {
      return res.status(409).json({ error: 'Já existe um cliente com este CPF.' });
    }

    const novoCliente = await new Cliente(dados).save();

    if (novoCliente.telefone) {
      let num = novoCliente.telefone.replace(/\D/g, '');
      if (!num.startsWith('55')) num = `55${num}`;
      const msg = `Olá, ${String(novoCliente.nome || '').split(' ')[0]}! ✨\n\nSeja muito bem-vindo(a) à *Ótica Elos*! Seu cadastro foi realizado com sucesso. Sempre que precisar, este é o nosso canal oficial de atendimento.`;
      resolverJidWhatsApp(num).then(jid => jid && enviarMensagemTexto(jid, msg)).catch(() => {});
    }
    res.json(semSegredos(novoCliente));
  } catch (e) { res.status(500).json({ error: 'Erro' }); }
});

// 🟢 Propaga nome e CPF para as vendas considerando CPF com e sem máscara
app.put('/api/clientes/:id', exigirEquipe(['ADMIN', 'VENDEDOR']), async (req, res) => {
  try {
    const { senha, tokenRecuperacao, tokenExpiraEm, _id, ...dados } = req.body;
    const antigo = await Cliente.findById(req.params.id);
    if (!antigo) return res.status(404).json({ error: 'Não encontrado' });

    const atualizado = await Cliente.findByIdAndUpdate(req.params.id, dados, { new: true });

    const digitosAntigo = limparCpf(antigo.cpf);
    const filtroVendas = digitosAntigo.length === 11
      ? { cpf: { $in: [digitosAntigo, formatarCpf(digitosAntigo)] } }
      : { cpf: antigo.cpf };

    await Venda.updateMany(
      filtroVendas,
      { $set: { cliente: atualizado.nome, cpf: atualizado.cpf } }
    );
    res.json(semSegredos(atualizado));
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

app.delete('/api/clientes/:cpf', exigirEquipe(['ADMIN', 'VENDEDOR']), async (req, res) => {
  try {
    const d = limparCpf(req.params.cpf);
    const filtro = d.length === 11 ? { cpf: { $in: [d, formatarCpf(d)] } } : { cpf: req.params.cpf };
    await Cliente.deleteOne(filtro);
    res.json({ message: 'Removido' });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// ==========================================
// 💰 VENDAS E ORDENS DE SERVIÇO
// ==========================================
app.get('/api/vendas', exigirEquipe(['ADMIN', 'VENDEDOR']), async (req, res) => {
  try {
    const vendas = await Venda.find().lean().sort({ dataVenda: -1 });
    const ordensServico = await OrdemServico.find().lean();
    const vendasComOS = vendas.map(venda => {
      const identificadorVenda = venda.numeroPedido ? String(venda.numeroPedido) : venda._id.toString();
      const osDestaVenda = ordensServico.filter(os => String(os.numeroPedido) === identificadorVenda);
      return { ...venda, ordensServico: osDestaVenda.map(os => ({ ...os, idOS: os._id.toString() })) };
    });
    res.json(vendasComOS);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// 🟢 Usa contador atômico para numeroPedido
app.post('/api/vendas', exigirEquipe(['ADMIN', 'VENDEDOR']), async (req, res) => {
  try {
    const proximoNumero = await proximoNumeroVenda();
    const novaVenda = new Venda({ ...req.body, numeroPedido: proximoNumero });
    res.json(await novaVenda.save());
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

app.patch('/api/vendas/:id', exigirEquipe(['ADMIN', 'VENDEDOR']), async (req, res) => {
  try { res.json(await Venda.findByIdAndUpdate(req.params.id, req.body, { new: true })); } catch (err) { res.status(500).json({ error: 'Erro' }); }
});
app.put('/api/vendas/:id', exigirEquipe(['ADMIN', 'VENDEDOR']), async (req, res) => {
  try { res.json(await Venda.findByIdAndUpdate(req.params.id, req.body, { new: true })); } catch (err) { res.status(500).json({ error: 'Erro' }); }
});
app.delete('/api/vendas/:id', exigirEquipe(['ADMIN', 'VENDEDOR']), async (req, res) => {
  try { await Venda.findByIdAndDelete(req.params.id); res.json({ message: 'Excluída' }); } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

app.get('/api/ordens_servico', exigirEquipe(['ADMIN', 'VENDEDOR']), async (req, res) => { try { res.json(await OrdemServico.find().sort({ _id: -1 })); } catch (err) { res.status(500).json({ error: 'Erro' }); } });
app.get('/api/ordens_servico/pedido/:numeroPedido', exigirEquipe(['ADMIN', 'VENDEDOR']), async (req, res) => { try { const ordens = await OrdemServico.find({ numeroPedido: req.params.numeroPedido }); res.json(ordens); } catch (err) { res.status(500).json({ error: 'Erro' }); } });
app.get('/api/ordens_servico/:id', exigirEquipe(['ADMIN', 'VENDEDOR']), async (req, res) => { try { const os = await OrdemServico.findById(req.params.id); if (!os) return res.status(404).json({ error: 'Não encontrada' }); res.json(os); } catch (err) { res.status(500).json({ error: 'Erro' }); } });
app.post('/api/ordens_servico', exigirEquipe(['ADMIN', 'VENDEDOR']), async (req, res) => { try { const novaOS = new OrdemServico(req.body); await novaOS.save(); res.status(201).json(novaOS); } catch (err) { res.status(500).json({ error: 'Erro' }); } });
app.put('/api/ordens_servico/:id', exigirEquipe(['ADMIN', 'VENDEDOR']), async (req, res) => { try { const osEditada = await OrdemServico.findByIdAndUpdate(req.params.id, req.body, { new: true }); res.json(osEditada); } catch (err) { res.status(500).json({ error: 'Erro' }); } });
app.delete('/api/ordens_servico/:id', exigirEquipe(['ADMIN', 'VENDEDOR']), async (req, res) => { try { await OrdemServico.findByIdAndDelete(req.params.id); res.json({ message: 'Excluída' }); } catch (err) { res.status(500).json({ error: 'Erro' }); } });

// =========================================================================
// 🟢 ROTA DE PARCELAS BLINDADA (sem colisão e bloqueando contratos renegociados)
// =========================================================================
const numeroParcelaResidual = (n, listaExistente = []) => {
  const proximoInteiro = Math.floor(n) + 1;
  let passo = (proximoInteiro - n) / 2;
  let candidato = Number((n + passo).toFixed(4));
  const usados = new Set(listaExistente.map(p => String(p.numero)));
  while (usados.has(String(candidato)) || candidato >= proximoInteiro) {
    passo /= 2;
    candidato = Number((n + passo).toFixed(4));
    if (passo < 0.0001) break;
  }
  return candidato;
};

app.patch('/api/vendas/:id/parcela/:numero', exigirEquipe(['ADMIN', 'VENDEDOR']), async (req, res) => {
  try {
    const { id, numero } = req.params;
    const { paga, dataPagamento, valorPago } = req.body;

    const venda = await Venda.findById(id);
    if (!venda) return res.status(404).json({ error: 'Venda não encontrada' });

    if (venda.renegociada === true) {
      return res.status(400).json({ error: 'Esta venda já foi renegociada e suas parcelas estão congeladas.' });
    }

    const numAtual = parseFloat(numero);
    const novasParcelas = JSON.parse(JSON.stringify(venda.listaParcelas || []));
    const index = novasParcelas.findIndex(p => String(p.numero) === String(numAtual));

    if (index === -1) return res.status(404).json({ error: 'Parcela não encontrada' });
    if (novasParcelas[index].renegociada === true) {
      return res.status(400).json({ error: 'Parcela renegociada não pode ser alterada.' });
    }

    if (paga === false) {
      const proximoInteiro = Math.floor(numAtual) + 1;
      const esperado = Number((numAtual + (proximoInteiro - numAtual) / 2).toFixed(4));
      const parcelaFilhaIndex = novasParcelas.findIndex(p =>
        !p.paga &&
        !p.renegociada &&
        !Number.isInteger(Number(p.numero)) &&
        Number(p.numero) > numAtual &&
        Number(p.numero) < proximoInteiro &&
        (String(p.observacao || '') === `Restante da parc. ${numAtual}` || String(p.numero) === String(esperado))
      );

      if (parcelaFilhaIndex !== -1) {
        const somaRecomposta = Number(novasParcelas[index].valor) + Number(novasParcelas[parcelaFilhaIndex].valor);
        novasParcelas[index].valor = parseFloat(somaRecomposta.toFixed(2));
        novasParcelas.splice(parcelaFilhaIndex, 1);
      }

      novasParcelas[index].paga = false;
      novasParcelas[index].dataPagamento = null;
    } else {
      const valorInformado = parseFloat(Number(valorPago || novasParcelas[index].valor).toFixed(2));
      const valorOriginalDaParcela = parseFloat(Number(novasParcelas[index].valor).toFixed(2));
      const diferenca = parseFloat((valorInformado - valorOriginalDaParcela).toFixed(2));

      if (diferenca > 0) {
        let excesso = diferenca;
        novasParcelas[index].valor = valorInformado;

        for (let i = index + 1; i < novasParcelas.length; i++) {
          if (excesso <= 0) break;
          if (novasParcelas[i].paga || novasParcelas[i].renegociada) continue;

          const valorDaProxima = parseFloat(Number(novasParcelas[i].valor).toFixed(2));
          if (excesso >= valorDaProxima) {
            excesso = parseFloat((excesso - valorDaProxima).toFixed(2));
            novasParcelas.splice(i, 1);
            i--;
          } else {
            novasParcelas[i].valor = parseFloat((valorDaProxima - excesso).toFixed(2));
            excesso = 0;
          }
        }

        novasParcelas[index].paga = true;
        novasParcelas[index].dataPagamento = dataPagamento;
      } else if (diferenca < 0) {
        const valorSobra = Math.abs(diferenca);
        novasParcelas[index].valor = valorInformado;
        novasParcelas[index].paga = true;
        novasParcelas[index].dataPagamento = dataPagamento;

        novasParcelas.push({
          ...novasParcelas[index],
          numero: numeroParcelaResidual(numAtual, novasParcelas),
          valor: valorSobra,
          paga: false,
          dataPagamento: null,
          observacao: `Restante da parc. ${numAtual}`
        });
      } else {
        novasParcelas[index].valor = valorInformado;
        novasParcelas[index].paga = true;
        novasParcelas[index].dataPagamento = dataPagamento;
      }
    }

    novasParcelas.sort((a, b) => a.numero - b.numero);
    venda.listaParcelas = novasParcelas;
    venda.markModified('listaParcelas');
    await venda.save();

    res.json(venda);
  } catch (err) {
    console.error('Erro no patch de parcelas:', err);
    res.status(500).json({ error: 'Erro interno no servidor.' });
  }
});

// ==========================================
// 📉 DESPESAS E PRODUTOS
// ==========================================
app.get('/api/despesas', exigirEquipe(['ADMIN']), async (req, res) => {
  try { res.json(await Despesa.find().sort({ vencimento: -1 })); } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// 🟢 Suporta tanto objeto único quanto array de despesas (parcelamento em Despesas.jsx)
app.post('/api/despesas', exigirEquipe(['ADMIN']), async (req, res) => {
  try {
    if (Array.isArray(req.body)) {
      if (req.body.length === 0) return res.status(400).json({ error: 'Lista de despesas vazia.' });
      const salvas = await Despesa.insertMany(req.body);
      return res.status(201).json(salvas);
    }
    res.status(201).json(await new Despesa(req.body).save());
  } catch (err) { res.status(400).json({ error: 'Erro ao salvar despesa.' }); }
});

app.patch('/api/despesas/:id', exigirEquipe(['ADMIN']), async (req, res) => {
  try { res.json(await Despesa.findByIdAndUpdate(req.params.id, req.body, { new: true })); } catch (err) { res.status(500).json({ error: 'Erro' }); }
});
app.delete('/api/despesas/:id', exigirEquipe(['ADMIN']), async (req, res) => {
  try { await Despesa.findByIdAndDelete(req.params.id); res.json({ message: 'Excluída' }); } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// GET /api/produtos permanece público (catálogo da loja virtual)
app.get('/api/produtos', async (req, res) => {
  try {
    const listaProdutos = await Produto.find({}).select('nome preco categoria quantidade referencia foto fotos descricao').lean().sort({ nome: 1 });
    res.json(listaProdutos);
  } catch (err) {
    res.status(500).json({ error: 'Falha ao buscar', detalhes: err.message });
  }
});
app.post('/api/produtos', exigirEquipe(['ADMIN', 'VENDEDOR']), async (req, res) => {
  try { res.json(await new Produto(req.body).save()); } catch (err) { res.status(400).json({ error: 'Erro ao salvar produto.' }); }
});
app.put('/api/produtos/:id', exigirEquipe(['ADMIN', 'VENDEDOR']), async (req, res) => {
  try { res.json(await Produto.findByIdAndUpdate(req.params.id, req.body, { new: true })); } catch (err) { res.status(500).json({ error: 'Erro' }); }
});
app.delete('/api/produtos/:id', exigirEquipe(['ADMIN', 'VENDEDOR']), async (req, res) => {
  try { await Produto.findByIdAndDelete(req.params.id); res.json({ message: 'Removido' }); } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// ==========================================
// 🛒 PEDIDOS ONLINE (ADMIN + ÁREA DO CLIENTE)
// ==========================================
app.get('/api/pedidos_online', exigirEquipe(['ADMIN']), async (req, res) => {
  try {
    const pedidos = await PedidoOnline.find().sort({ dataPedido: -1 });
    res.json(pedidos);
  } catch (err) {
    res.status(500).json({ error: 'Erro' });
  }
});

// 🟢 Área do Cliente: lista APENAS os pedidos do CPF autenticado no token
app.get('/api/meus-pedidos', exigirCliente, async (req, res) => {
  try {
    const digitos = req.cliente.cpf;
    const filtroCpf = digitos.length === 11
      ? { $in: [digitos, formatarCpf(digitos)] }
      : digitos;

    const pedidos = await PedidoOnline.find({ clienteCpf: filtroCpf }).sort({ dataPedido: -1 });
    res.json(pedidos);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar seus pedidos.' });
  }
});

// 🟢 Área do Cliente: cancela APENAS pedido próprio e que ainda esteja aguardando pagamento
app.patch('/api/meus-pedidos/:id/cancelar', exigirCliente, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Pedido inválido.' });
    }

    const pedido = await PedidoOnline.findById(req.params.id);
    if (!pedido) return res.status(404).json({ error: 'Pedido não encontrado.' });

    if (limparCpf(pedido.clienteCpf) !== req.cliente.cpf) {
      return res.status(403).json({ error: 'Você não tem permissão para cancelar este pedido.' });
    }

    if (pedido.status !== 'AGUARDANDO_PAGAMENTO') {
      return res.status(400).json({
        error: 'Apenas pedidos aguardando pagamento podem ser cancelados pelo site. Entre em contato pelo WhatsApp.'
      });
    }

    if (pedido.cupomUtilizado) {
      await devolverUsoCupom({ codigo: pedido.cupomUtilizado }, req.cliente.cpf);
    }
    if (pedido.estoqueBaixado) {
      await ajustarEstoquePedido(pedido.itens, +1);
    }

    await PedidoOnline.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Pedido cancelado com sucesso.' });
  } catch (err) {
    console.error('Erro ao cancelar pedido do cliente:', err);
    res.status(500).json({ error: 'Erro ao cancelar pedido.' });
  }
});

app.post('/api/infinitepay/checkout', async (req, res) => {
  try {
    if (limitar(`pay:${req.ip}`, 20)) {
      return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos.' });
    }

    const corpo = req.body || {};
    const nsu = Number(corpo.order_nsu);
    const itensLink = Array.isArray(corpo.items) ? corpo.items : [];
    if (!Number.isInteger(nsu) || itensLink.length === 0) {
      return res.status(400).json({ error: 'Dados do pagamento inválidos.' });
    }

    const pedido = await PedidoOnline.findOne({ numeroPedidoOnline: nsu });
    if (!pedido) return res.status(404).json({ error: 'Pedido não encontrado.' });
    if (pedido.status !== 'AGUARDANDO_PAGAMENTO') {
      return res.status(400).json({ error: 'Este pedido não está aguardando pagamento.' });
    }

    let somaCentavos = 0;
    for (const it of itensLink) {
      const preco = Number(it.price);
      const qtd = Number(it.quantity || 1);
      if (!Number.isInteger(preco) || preco < 0 || !Number.isInteger(qtd) || qtd <= 0) {
        return res.status(400).json({ error: 'Itens do pagamento inválidos.' });
      }
      somaCentavos += preco * qtd;
    }
    const esperado = Math.round(Number(pedido.valorTotal) * 100);
    if (Math.abs(somaCentavos - esperado) > itensLink.length) {
      return res.status(400).json({ error: 'O valor do pagamento não confere com o pedido.' });
    }

    const handle = process.env.INFINITEPAY_HANDLE || corpo.handle;
    if (!handle) return res.status(500).json({ error: 'Handle da InfinitePay não configurado.' });

    const resposta = await fetch('https://api.checkout.infinitepay.io/links', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(req.headers.authorization ? { 'Authorization': req.headers.authorization } : {})
      },
      body: JSON.stringify({ ...corpo, handle })
    });

    const dados = await resposta.json().catch(() => ({}));
    if (!resposta.ok) {
      return res.status(resposta.status).json(dados);
    }
    res.json(dados);
  } catch (err) {
    console.error('Erro ao comunicar com InfinitePay:', err);
    res.status(500).json({ error: 'Falha ao gerar link de pagamento na InfinitePay.' });
  }
});

app.post('/api/pedidos_online', async (req, res) => {
  let cupomConsumido = null;
  try {
    const { clienteNome, clienteTelefone, clienteCpf, clienteEndereco, itens, cupomUtilizado, freteId, cep } = req.body;

    if (!clienteNome || !clienteTelefone || !clienteCpf) return res.status(400).json({ error: 'Dados do cliente incompletos.' });

    const calc = await calcularPedido({ itens, cupomCodigo: cupomUtilizado, cpf: clienteCpf, freteId, cep });

    if (calc.cupomDoc) {
      const atualizado = await Cupom.findOneAndUpdate(
        {
          _id: calc.cupomDoc._id,
          ativo: true,
          dataFim: { $gte: new Date() },
          $expr: { $lt: ['$usosAtuais', { $ifNull: ['$limiteUso', 1] }] },
          ...(calc.cpfLimpo ? { cpfsUtilizados: { $ne: calc.cpfLimpo } } : {})
        },
        {
          $inc: { usosAtuais: 1 },
          ...(calc.cpfLimpo ? { $addToSet: { cpfsUtilizados: calc.cpfLimpo } } : {})
        },
        { new: true }
      );
      if (!atualizado) throw new ErroNegocio('Este cupom não está mais disponível.');
      cupomConsumido = atualizado;
      if (atualizado.usosAtuais >= (atualizado.limiteUso ?? 1)) {
        await Cupom.updateOne({ _id: atualizado._id }, { ativo: false });
      }
    }

    const proximoNumero = await proximoNumeroPedidoOnline();

    const novoPedido = await new PedidoOnline({
      numeroPedidoOnline: proximoNumero,
      clienteNome: String(clienteNome).toUpperCase(),
      clienteTelefone, clienteCpf, clienteEndereco,
      itens: calc.itensFinais,
      subtotal: calc.subtotal,
      descontoCupom: calc.descontoCupom,
      valorTotal: calc.valorTotal,
      freteValor: calc.frete.valor,
      freteTipo: calc.frete.nome,
      cupomUtilizado: calc.cupomDoc ? calc.cupomDoc.codigo : undefined
    }).save();

    res.json({ success: true, pedido: novoPedido });
  } catch (err) {
    if (cupomConsumido) {
      await devolverUsoCupom({ _id: cupomConsumido._id }, limparCpf(req.body.clienteCpf)).catch(() => {});
    }
    if (err instanceof ErroNegocio) return res.status(err.status).json({ error: err.message });
    console.error('Erro ao criar pedido:', err);
    res.status(500).json({ error: 'Erro ao criar pedido.' });
  }
});

const STATUS_PEDIDO_VALIDOS = ['AGUARDANDO_PAGAMENTO', 'PAGO', 'CONCLUIDO', 'CANCELADO'];

app.patch('/api/pedidos_online/:id/status', exigirEquipe(['ADMIN']), async (req, res) => {
  try {
    const { status } = req.body;
    if (!STATUS_PEDIDO_VALIDOS.includes(status)) return res.status(400).json({ error: 'Status inválido.' });

    const pedidoAnterior = await PedidoOnline.findById(req.params.id);
    if (!pedidoAnterior) return res.status(404).json({ error: 'Pedido não encontrado.' });

    if (status === 'CANCELADO') {
      if (pedidoAnterior.status === 'CONCLUIDO') {
        return res.status(400).json({ error: 'Pedido já concluído não pode ser cancelado.' });
      }
      if (pedidoAnterior.cupomUtilizado) {
        await devolverUsoCupom({ codigo: pedidoAnterior.cupomUtilizado }, limparCpf(pedidoAnterior.clienteCpf));
      }
      if (pedidoAnterior.estoqueBaixado) {
        await ajustarEstoquePedido(pedidoAnterior.itens, +1);
      }
      await PedidoOnline.findByIdAndDelete(req.params.id);
      return res.json({ message: 'Excluído.' });
    }

    const atualizacao = { status };
    if ((status === 'PAGO' || status === 'CONCLUIDO') && !pedidoAnterior.estoqueBaixado) {
      await ajustarEstoquePedido(pedidoAnterior.itens, -1);
      atualizacao.estoqueBaixado = true;
    }

    const pedidoAtualizado = await PedidoOnline.findByIdAndUpdate(req.params.id, atualizacao, { new: true });

    if (status === 'CONCLUIDO' && pedidoAnterior.status !== 'CONCLUIDO') {
      const digitosCpf = limparCpf(pedidoAtualizado.clienteCpf);
      let clienteExiste = digitosCpf.length === 11
        ? await buscarClientePorCpf(digitosCpf)
        : await Cliente.findOne({ cpf: pedidoAtualizado.clienteCpf });
      if (!clienteExiste) {
        clienteExiste = new Cliente({
          nome: pedidoAtualizado.clienteNome,
          cpf: pedidoAtualizado.clienteCpf,
          telefone: pedidoAtualizado.clienteTelefone,
          origem: 'Site / Loja Virtual',
          endereco: pedidoAtualizado.clienteEndereco || '',
          observacoes: 'Cliente via Loja Virtual.'
        });
        await clienteExiste.save();
      }

      const proximoNumero = await proximoNumeroVenda();
      const hojeBR = obterDataHojeBR();

      const novaVendaOficial = new Venda({
        numeroPedido: proximoNumero,
        cliente: pedidoAtualizado.clienteNome,
        cpf: pedidoAtualizado.clienteCpf,
        produto: 'Compra Online - ' + pedidoAtualizado.itens.map(i => `${i.quantidade > 1 ? `${i.quantidade}x ` : ''}${i.nome}`).join(', '),
        itensCarrinho: pedidoAtualizado.itens,
        valorTotal: pedidoAtualizado.valorTotal,
        valorEntrada: pedidoAtualizado.valorTotal,
        desconto: 0,
        parcelas: 1,
        listaParcelas: [{ numero: 1, valor: pedidoAtualizado.valorTotal, dataVencimento: hojeBR, paga: true, dataPagamento: hojeBR, observacao: 'Pago via Site' }],
        dataVenda: hojeBR,
        dataEntrada: hojeBR,
        metodoPagamento: 'Pagamento Digital (Site)',
        observacoes: `Origem: Pedido Online #${pedidoAtualizado.numeroPedidoOnline} | Entrega: ${pedidoAtualizado.freteTipo || 'Padrão'}`
      });
      await novaVendaOficial.save();
    }
    res.json(pedidoAtualizado);
  } catch (err) {
    console.error('Erro ao atualizar status do pedido:', err);
    res.status(500).json({ error: 'Erro' });
  }
});

// 🟢 Usa a mesma função `obterOpcoesFrete` do cálculo do pedido
app.post('/api/frete', async (req, res) => {
  try {
    const cepDestinoLimpo = String((req.body && req.body.cepDestino) || '').replace(/\D/g, '');
    if (cepDestinoLimpo.length !== 8) return res.status(400).json({ error: 'CEP inválido.' });
    const opcoes = await obterOpcoesFrete(cepDestinoLimpo);
    res.json(opcoes);
  } catch (error) {
    res.status(500).json({ error: 'Falha ao calcular.' });
  }
});

// ==========================================
// 🤖 MOTOR DO WHATSAPP COM PERSISTÊNCIA DE CREDS + SIGNAL KEYS NO MONGO
// ==========================================
async function usarMongoAuthState() {
  const ler = async (chave) => {
    const doc = await WhatsAppAuth.findById(chave).lean();
    return doc ? JSON.parse(doc.valor, BufferJSON.reviver) : null;
  };
  const escrever = async (chave, dados) => {
    await WhatsAppAuth.updateOne(
      { _id: chave },
      { valor: JSON.stringify(dados, BufferJSON.replacer) },
      { upsert: true }
    );
  };
  const remover = async (chave) => {
    await WhatsAppAuth.deleteOne({ _id: chave });
  };

  let creds = await ler('creds');
  // Migração suave da sessão legada (se existir em Configuracao)
  if (!creds) {
    const legado = await Configuracao.findOne({ chave: 'whatsapp_session_creds' }).lean();
    if (legado && legado.valor) {
      try {
        creds = JSON.parse(legado.valor, (key, value) => {
          if (value && value.type === 'Buffer' && Array.isArray(value.data)) return Buffer.from(value.data);
          return value;
        });
        await escrever('creds', creds);
      } catch (e) { creds = null; }
    }
  }

  const temSessao = !!creds;
  const credsAtuais = creds || initAuthCreds();

  return {
    temSessao,
    state: {
      creds: credsAtuais,
      keys: {
        get: async (type, ids) => {
          const resultado = {};
          const chaves = ids.map(id => `${type}-${id}`);
          const docs = await WhatsAppAuth.find({ _id: { $in: chaves } }).lean();
          const mapa = new Map(docs.map(d => [d._id, JSON.parse(d.valor, BufferJSON.reviver)]));
          for (const id of ids) {
            const val = mapa.get(`${type}-${id}`);
            if (val) resultado[id] = val;
          }
          return resultado;
        },
        set: async (dados) => {
          const ops = [];
          for (const categoria of Object.keys(dados)) {
            for (const id of Object.keys(dados[categoria])) {
              const valor = dados[categoria][id];
              const chave = `${categoria}-${id}`;
              if (valor) ops.push(escrever(chave, valor));
              else ops.push(remover(chave));
            }
          }
          await Promise.all(ops);
        }
      }
    },
    saveCreds: async () => { await escrever('creds', credsAtuais); }
  };
}

async function inicializarWhatsApp(forcar = false) {
  if (reconectando) return;
  reconectando = true;

  try {
    const { temSessao, state, saveCreds } = await usarMongoAuthState();

    if (!forcar && !temSessao) {
      console.log('📵 Sem sessão salva. Bot aguardando ação do usuário (Painel Zap → Conectar).');
      statusConexao = 'Aguardando configuração';
      reconectando = false;
      return;
    }

    whatsappClient = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      keepAliveIntervalMs: 30000,
      options: { headers: { 'User-Agent': 'Mozilla' } }
    });

    whatsappClient.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        statusConexao = 'Aguardando Leitura do QR Code';
        try { qrCodeBase64 = await QRCode.toDataURL(qr); } catch (err) {}
      }

      if (connection === 'close') {
        tentativasConexao++;
        const foiDeslogado = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
        statusConexao = 'Desconectado';
        qrCodeBase64 = null;
        reconectando = false;

        if (foiDeslogado || tentativasConexao >= 3) {
          try {
            await Promise.all([
              WhatsAppAuth.deleteMany({}),
              Configuracao.deleteOne({ chave: 'whatsapp_session_creds' })
            ]);
          } catch (e) {}
          console.log('🧹 Sessão do WhatsApp corrompida. Limpeza automática realizada!');
          tentativasConexao = 0;
          statusConexao = 'Erro ao conectar';
          console.log('⏸️ O bot pausou as tentativas. Use o botão no Painel Zap para reiniciar.');
          return;
        }

        setTimeout(() => inicializarWhatsApp(), 5000);
      } else if (connection === 'open') {
        tentativasConexao = 0;
        reconectando = false;
        statusConexao = 'Conectado';
        qrCodeBase64 = null;
        console.log('✅ WhatsApp conectado com sucesso!');
        setTimeout(() => { verificarAniversariantesDoDia(); verificarPosVendaTrintaDias(); }, 15000);
      }
    });

    whatsappClient.ev.on('creds.update', async () => {
      try { await saveCreds(); } catch (e) {}
    });
  } catch (error) {
    reconectando = false;
    statusConexao = 'Erro ao conectar';
  }
}

async function enviarMensagemTexto(jid, texto) {
  if (!whatsappClient || statusConexao !== 'Conectado') return false;
  try {
    await whatsappClient.sendMessage(jid, { text: texto });
    return true;
  } catch (e) {
    console.error('Erro ao enviar msg WhatsApp:', e.message);
    return false;
  }
}

async function resolverJidWhatsApp(num) {
  if (!whatsappClient || statusConexao !== 'Conectado') return null;
  const variantes = [num];
  if (num.length === 13 && num.startsWith('55')) variantes.push(num.slice(0, 4) + num.slice(5));
  if (num.length === 12 && num.startsWith('55')) variantes.push(num.slice(0, 4) + '9' + num.slice(4));

  for (const v of variantes) {
    try {
      const [r] = await Promise.race([
        whatsappClient.onWhatsApp(`${v}@s.whatsapp.net`),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
      ]);
      if (r && r.exists) return r.jid;
    } catch (e) { /* tenta a próxima variante */ }
  }
  return null;
}

async function carregarEnviados(chave, hoje) {
  try {
    const reg = await Configuracao.findOne({ chave });
    if (reg && reg.valor) {
      const o = JSON.parse(reg.valor);
      if (o && o.data === hoje && Array.isArray(o.ids)) return o;
    }
  } catch (e) {}
  return { data: hoje, ids: [] };
}
async function salvarEnviados(chave, objeto) {
  try { await Configuracao.updateOne({ chave }, { valor: JSON.stringify(objeto) }, { upsert: true }); } catch (e) {}
}
const esperar = (ms) => new Promise(r => setTimeout(r, ms));

let verificandoAniversario = false;
async function verificarAniversariantesDoDia() {
  if (!whatsappClient || statusConexao !== 'Conectado' || verificandoAniversario) return;
  verificandoAniversario = true;
  try {
    const hoje = obterDataHojeBR();
    const [, mesHoje, diaHoje] = hoje.split('-');
    const CHAVE = 'wa_enviados_aniversario';
    const enviados = await carregarEnviados(CHAVE, hoje);

    const aniversariantes = await Cliente.find({ dataNascimento: new RegExp(`^\\d{4}-${mesHoje}-${diaHoje}$`) });
    const pendentes = aniversariantes.filter(c => !enviados.ids.includes(String(c._id)));
    if (pendentes.length === 0) return;
    const configMsg = await Configuracao.findOne({ chave: 'msg_aniversario' });
    const templateBase = configMsg ? configMsg.valor : 'Olá, {nome}! Feliz Aniversário!';

    for (const cliente of pendentes) {
      if (!cliente.telefone) continue;
      let num = cliente.telefone.replace(/\D/g, '');
      if (!num.startsWith('55')) num = `55${num}`;
      const msg = templateBase.replace(/{nome}/g, cliente.nome);

      const jid = await resolverJidWhatsApp(num);
      if (jid) await enviarMensagemTexto(jid, msg);

      enviados.ids.push(String(cliente._id));
      await salvarEnviados(CHAVE, enviados);
      await esperar(5000);
    }
  } catch (error) {
    console.error('Erro nos aniversariantes:', error.message);
  } finally {
    verificandoAniversario = false;
  }
}

let verificandoPosVenda = false;
async function verificarPosVendaTrintaDias() {
  if (!whatsappClient || statusConexao !== 'Conectado' || verificandoPosVenda) return;
  verificandoPosVenda = true;
  try {
    const hoje = obterDataHojeBR();
    const data = new Date();
    data.setDate(data.getDate() - 30);
    const dataAlvoStr = data.toLocaleDateString('sv-SE', { timeZone: 'America/Fortaleza' });
    const CHAVE = 'wa_enviados_posvenda';
    const enviados = await carregarEnviados(CHAVE, hoje);

    // 🟢 Ignora vendas renegociadas e novos acordos de renegociação
    const vendas = await Venda.find({
      dataVenda: dataAlvoStr,
      renegociada: { $ne: true },
      produto: { $not: /RENEGOCIAÇÃO/i }
    });
    const pendentes = vendas.filter(v => !enviados.ids.includes(String(v._id)));
    if (pendentes.length === 0) return;
    const configMsg = await Configuracao.findOne({ chave: 'msg_pos_venda' });
    const templateBase = configMsg ? configMsg.valor : 'Olá, {nome}! Como está seu {produto}?';

    for (const venda of pendentes) {
      const digitos = limparCpf(venda.cpf);
      const cliente = digitos.length === 11 ? await buscarClientePorCpf(digitos) : await Cliente.findOne({ cpf: venda.cpf });
      if (!cliente || !cliente.telefone) continue;
      let num = cliente.telefone.replace(/\D/g, '');
      if (!num.startsWith('55')) num = `55${num}`;
      const msg = templateBase.replace(/{nome}/g, venda.cliente).replace(/{produto}/g, venda.produto);

      const jid = await resolverJidWhatsApp(num);
      if (jid) await enviarMensagemTexto(jid, msg);

      enviados.ids.push(String(venda._id));
      await salvarEnviados(CHAVE, enviados);
      await esperar(5000);
    }
  } catch (error) {
    console.error('Erro no pós-venda:', error.message);
  } finally {
    verificandoPosVenda = false;
  }
}

setInterval(() => { verificarAniversariantesDoDia(); verificarPosVendaTrintaDias(); }, 1000 * 60 * 60);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Servidor rodando na porta ${PORT} (Fuso: America/Fortaleza)`));
