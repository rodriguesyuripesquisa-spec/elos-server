process.env.TZ = 'America/Fortaleza'; // 🟢 Força o servidor (local e Render) a usar o fuso horário de Fortaleza (-03:00)

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const crypto = require('crypto');
const { default: makeWASocket, DisconnectReason } = require('@whiskeysockets/baileys'); 
const QRCode = require('qrcode');
const nodemailer = require('nodemailer'); 

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// 🟢 (OPCIONAL, recomendado) senhas criptografadas: npm install bcryptjs
// Sem o pacote, tudo continua funcionando com senha em texto puro.
let bcrypt = null;
try { bcrypt = require('bcryptjs'); } catch (e) { /* segue sem bcrypt */ }

const app = express();
app.set('trust proxy', 1);          // 🟢 Render: faz o req.ip refletir o IP real do visitante
app.disable('x-powered-by');

// 🟢 CORS: por padrão libera tudo (como antes). Para restringir, defina no Render:
// CORS_ORIGINS=https://seusite.com,https://www.seusite.com
const origensPermitidas = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: origensPermitidas.length ? origensPermitidas : '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const MONGO_URI = process.env.MONGODB_URI; 

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
    console.log("✅ Banco MongoDB da Ótica Elos Conectado!");
    atualizarVendasAntigas().catch(e => console.error('erro atualizarVendas:', e));
    inicializarMensagensPadrao().catch(e => console.error('erro msgs:', e));
    inicializarAdmin().catch(e => console.error('erro admin:', e));

    console.log("⏳ WhatsApp será iniciado em 60s (background)...");
    setTimeout(() => {
      console.log("🤖 Iniciando WhatsApp em background...");
      inicializarWhatsApp().catch(e => console.error('erro whatsapp:', e));
    }, 60000);
  })
  .catch(err => console.error("❌ Erro na conexão:", err));

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
  senha: { type: String, default: "" }, tokenRecuperacao: { type: String, default: null }, tokenExpiraEm: { type: Date, default: null }
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
  referencia: { type: String, default: "" },
  foto: { type: String, default: "" }, 
  fotos: [{ type: String }],
  descricao: { type: String, default: "" }
});
const Produto = mongoose.model('Produto', ProdutoSchema, 'produtos');

const Configuracao = mongoose.model('Configuracao', { chave: String, valor: String });

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
  estoqueBaixado: { type: Boolean, default: false },   // 🟢 evita baixar o estoque duas vezes
  dataPedido: { type: Date, default: Date.now }, infinitePayId: String
});
const PedidoOnline = mongoose.model('PedidoOnline', PedidoOnlineSchema);

// 🟢 Contador atômico (evita repetir número de pedido, mesmo se um pedido for excluído)
const Contador = mongoose.model('Contador', new mongoose.Schema({ _id: String, seq: Number }));

async function proximoNumeroPedidoOnline() {
  try {
    const ultimo = await PedidoOnline.findOne().sort({ numeroPedidoOnline: -1 }).select('numeroPedidoOnline').lean();
    const semente = Math.max((ultimo && ultimo.numeroPedidoOnline) || 0, 999);
    // $setOnInsert só vale na 1ª vez (cria o contador já alinhado ao maior número existente)
    await Contador.updateOne({ _id: 'pedidoOnline' }, { $setOnInsert: { seq: semente } }, { upsert: true }).catch(() => {});
  } catch (e) { /* segue para o incremento */ }
  const doc = await Contador.findOneAndUpdate({ _id: 'pedidoOnline' }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  return doc.seq;
}

// ==========================================
// 🔐 HELPERS DE AUTENTICAÇÃO E SEGURANÇA
// ==========================================
const limparCpf = (c) => String(c || '').replace(/\D/g, '');
const formatarCpf = (d) => `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;

// Busca o cliente pelo CPF, com ou sem máscara (o banco tem os dois formatos)
const buscarClientePorCpf = (digitos) =>
  Cliente.findOne({ cpf: { $in: [digitos, formatarCpf(digitos)] } });

// Remove campos secretos antes de enviar um cliente ao navegador
const semSegredos = (c) => {
  const o = c && c.toObject ? c.toObject() : { ...c };
  delete o.senha;
  delete o.tokenRecuperacao;
  delete o.tokenExpiraEm;
  return o;
};

// Limitador simples de tentativas (em memória; zera se o servidor reiniciar)
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

// Senhas: aceita texto puro (legado) e hash bcrypt (se instalado)
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
      // 🟢 Defina ADMIN_SENHA_INICIAL no Render. Sem ela, usa "123" — TROQUE logo após o primeiro acesso!
      const senhaInicial = process.env.ADMIN_SENHA_INICIAL || '123';
      if (!process.env.ADMIN_SENHA_INICIAL) console.warn("⚠️ ADMIN_SENHA_INICIAL não definida: usando senha padrão '123'. Troque-a imediatamente.");
      await new Funcionario({ 
        nome: 'Administrador (Dono)', 
        usuario: 'admin', 
        senha: await gerarHash(senhaInicial), 
        cargo: 'ADMIN' 
      }).save();
      console.log("👤 Usuário Mestre criado com sucesso!");
    }
  } catch (err) {}
};

const atualizarVendasAntigas = async () => {
  try {
    const vendasSemNumero = await Venda.find({ numeroPedido: { $exists: false } }).sort({ dataVenda: 1 });
    if (vendasSemNumero.length > 0) {
      for (let i = 0; i < vendasSemNumero.length; i++) { vendasSemNumero[i].numeroPedido = 2000 + i; await vendasSemNumero[i].save(); }
    }
  } catch (err) {}
};

const inicializarMensagensPadrao = async () => {
  try {
    const msgAniv = await Configuracao.findOne({ chave: 'msg_aniversario' });
    if (!msgAniv) await new Configuracao({ chave: 'msg_aniversario', valor: "Olá, {nome}! 🎉 Feliz aniversário!" }).save();
    const msgPosVenda = await Configuracao.findOne({ chave: 'msg_pos_venda' });
    if (!msgPosVenda) await new Configuracao({ chave: 'msg_pos_venda', valor: "Olá, {nome}! Tudo bem? 😊" }).save();
    const chavePix = await Configuracao.findOne({ chave: 'chave_pix_carne' });
    if (!chavePix) await new Configuracao({ chave: 'chave_pix_carne', valor: "(85) 8550-6571" }).save();
  } catch (err) {}
};

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_REMETENTE || 'seuemail@gmail.com', pass: process.env.SENHA_EMAIL || 'sua_senha_de_app_aqui' }
});

// ==========================================
// 🛠️ ROTAS DE CONTROLE GERAL E API
// ==========================================
app.get('/api/whatsapp/status', (req, res) => res.json({ status: statusConexao, qr: qrCodeBase64 }));

app.post('/api/whatsapp/desconectar', async (req, res) => {
  try {
    statusConexao = 'Desconectando...'; 
    if (whatsappClient) {
      try { await whatsappClient.logout(); } catch(e) {}
    }
    await Configuracao.deleteOne({ chave: 'whatsapp_session_creds' });
    
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

app.post('/api/whatsapp/conectar', async (req, res) => {
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

app.get('/api/whatsapp/mensagens', async (req, res) => {
  try { 
    const configs = await Configuracao.find({ chave: { $in: ['msg_aniversario', 'msg_pos_venda', 'chave_pix_carne'] } }); // 🟢 não expõe a sessão do WhatsApp
    const mapa = {}; configs.forEach(c => mapa[c.chave] = c.valor); res.json(mapa); 
  } 
  catch (err) { res.status(500).json({ error: "Erro" }); }
});

app.post('/api/whatsapp/mensagens', async (req, res) => {
  try {
    const { msg_aniversario, msg_pos_venda, chave_pix_carne } = req.body;
    if (msg_aniversario !== undefined) await Configuracao.updateOne({ chave: 'msg_aniversario' }, { valor: msg_aniversario }, { upsert: true });
    if (msg_pos_venda !== undefined) await Configuracao.updateOne({ chave: 'msg_pos_venda' }, { valor: msg_pos_venda }, { upsert: true });
    if (chave_pix_carne !== undefined) await Configuracao.updateOne({ chave: 'chave_pix_carne' }, { valor: chave_pix_carne }, { upsert: true });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Erro" }); }
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

    // Se o bcrypt estiver instalado, migra a senha antiga para hash no primeiro login
    if (bcrypt && !ehHash(func.senha)) {
      func.senha = await gerarHash(senha);
      await func.save();
    }

    liberarLimite(chaveLogin);
    res.json({ id: func._id, nome: func.nome, usuario: func.usuario, cargo: func.cargo });
  } catch (err) { res.status(500).json({ error: 'Erro no servidor' }); }
});

app.get('/api/funcionarios', async (req, res) => { try { res.json(await Funcionario.find().select('-senha')); } catch (err) { res.status(500).json({ error: "Erro" }); } });

app.post('/api/funcionarios', async (req, res) => {
  try {
    const { senha, _id, ...resto } = req.body;
    const usuario = String(resto.usuario || '').trim().toLowerCase();
    if (!usuario || !senha || String(senha).length < 3) return res.status(400).json({ error: "Informe usuário e uma senha válida." });

    const novoFunc = await new Funcionario({ ...resto, usuario, senha: await gerarHash(String(senha)) }).save();
    const retorno = novoFunc.toObject(); delete retorno.senha;   // 🟢 nunca devolve a senha
    res.status(201).json(retorno);
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ error: "Este nome de usuário já está em uso." });
    res.status(500).json({ error: "Erro" });
  }
});

// 🟢 Impede ficar sem nenhum ADMIN ativo no sistema
async function ehUltimoAdminAtivo(id) {
  const alvo = await Funcionario.findById(id);
  if (!alvo || alvo.cargo !== 'ADMIN' || !alvo.ativo) return false;
  const outros = await Funcionario.countDocuments({ cargo: 'ADMIN', ativo: true, _id: { $ne: id } });
  return outros === 0;
}

app.put('/api/funcionarios/:id', async (req, res) => {
  try {
    const { senha, _id, ...dados } = req.body;
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
    if (err.code === 11000) return res.status(400).json({ error: "Este nome de usuário já está em uso." });
    res.status(500).json({ error: "Erro" });
  }
});

app.delete('/api/funcionarios/:id', async (req, res) => {
  try {
    if (await ehUltimoAdminAtivo(req.params.id)) {
      return res.status(400).json({ error: 'Não é possível excluir o único administrador ativo.' });
    }
    await Funcionario.findByIdAndDelete(req.params.id);
    res.json({ message: "Excluído." });
  } catch (err) { res.status(500).json({ error: "Erro" }); }
});

// ==========================================
// 🎟️ CUPONS, PREÇOS E CÁLCULO DO PEDIDO (FEITO NO SERVIDOR)
// ==========================================

const arred = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

class ErroNegocio extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

// Tabela de frete no servidor (o navegador só diz QUAL opção escolheu)
const FRETES = {
  retirada: { nome: 'Retirar na Loja (Bela Vista)', valor: 0 },
  motoboy:  { nome: 'Motoboy Fortaleza/Região', valor: 15.00 },
  pac:      { nome: 'Correios PAC', valor: 28.90 },
  sedex:    { nome: 'Correios Sedex', valor: 45.50 }
};
const PREFIXOS_MOTOBOY = ['60', '61']; // Fortaleza e região metropolitana

// Regras do cupom num lugar só (usado em /validar e no pedido)
function verificarCupom(cupom, cpfLimpo) {
  if (!cupom) return 'Cupom não encontrado.';
  if (!cupom.ativo) return 'Este cupom está inativo.';
  if (new Date() > new Date(cupom.dataFim)) return 'Este cupom já expirou.';   // dataFim já é 23:59:59-03:00
  if ((cupom.usosAtuais || 0) >= (cupom.limiteUso ?? 1)) return 'Este cupom já atingiu o limite máximo de utilizações.';
  if (cpfLimpo && (cupom.cpfsUtilizados || []).includes(cpfLimpo)) return 'Você já utilizou este cupom anteriormente.';
  return null;
}

// 🟢 Devolve 1 uso do cupom (cancelamento ou falha ao criar o pedido) sem deixar o contador negativo
async function devolverUsoCupom(filtro, cpfLimpo) {
  const c = await Cupom.findOneAndUpdate(
    { ...filtro, usosAtuais: { $gt: 0 } },
    { $inc: { usosAtuais: -1 }, ...(cpfLimpo ? { $pull: { cpfsUtilizados: cpfLimpo } } : {}) },
    { new: true }
  );
  // Só reativa se ele estava inativo POR TER ESGOTADO (não reativa cupom pausado à mão)
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

  const ids = [...new Set(itens.map(i => String(i?.id || i?._id)))];
  if (ids.some(id => !mongoose.isValidObjectId(id))) throw new ErroNegocio('Item inválido no carrinho.');

  const [produtos, promocoes] = await Promise.all([
    Produto.find({ _id: { $in: ids } }).lean(),
    Produto.find({ categoria: 'PROMO_CATE' }).lean()
  ]);
  if (produtos.length !== ids.length) throw new ErroNegocio('Um dos produtos não existe mais.');

  let temPromo = false;
  const temArmacao = produtos.some(p => p.categoria === 'ARMAÇÃO');

  const itensFinais = produtos.map(p => {
    if (['PROMO_CATE'].includes(p.categoria)) throw new ErroNegocio('Item inválido no carrinho.');
    if (p.categoria === 'UPSELL' && !temArmacao) throw new ErroNegocio('A oferta combo exige uma armação no carrinho.');
    if (p.quantidade <= 0 && p.categoria !== 'LENTE') throw new ErroNegocio(`"${p.nome}" está sem estoque.`);

    let preco = Number(p.preco);
    if (p.categoria === 'UPSELL') temPromo = true;
    else {
      const promo = precoPromocional(p, promocoes);
      if (promo !== null && promo < preco) { preco = promo; temPromo = true; }
    }
    return { id: String(p._id), nome: p.nome, preco: arred(preco), referencia: p.referencia || '' };
  });

  const subtotal = arred(itensFinais.reduce((s, i) => s + i.preco, 0));

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

  // Frete
  const frete = FRETES[freteId || 'retirada'];
  if (!frete) throw new ErroNegocio('Opção de frete inválida.');
  if (freteId === 'motoboy' && !PREFIXOS_MOTOBOY.includes(String(cep || '').replace(/\D/g, '').slice(0, 2)))
    throw new ErroNegocio('Motoboy disponível apenas para Fortaleza e região.');

  const valorTotal = arred(Math.max(0, subtotal - descontoCupom) + frete.valor);
  return { itensFinais, subtotal, descontoCupom, valorTotal, frete, cupomDoc, cpfLimpo };
}

// 🟢 Estoque: baixa (-1) ou devolve (+1) cada item de um pedido online
async function ajustarEstoquePedido(itens, delta) {
  for (const it of itens || []) {
    if (!it || !mongoose.isValidObjectId(it.id)) continue;
    const prod = await Produto.findById(it.id).select('categoria').lean();
    if (!prod || prod.categoria === 'LENTE') continue; // lentes são sob encomenda: sem controle de estoque
    if (delta < 0) {
      const r = await Produto.updateOne({ _id: it.id, quantidade: { $gt: 0 } }, { $inc: { quantidade: -1 } });
      if (!r.modifiedCount) console.warn(`⚠️ Estoque insuficiente ao baixar "${it.nome}" (pedido já vendido por outro canal?)`);
    } else {
      await Produto.updateOne({ _id: it.id }, { $inc: { quantidade: 1 } });
    }
  }
}

app.get('/api/cupons', async (req, res) => { try { res.json(await Cupom.find().sort({ dataFim: -1 })); } catch (err) { res.status(500).json({ error: "Erro" }); } });

app.post('/api/cupons', async (req, res) => { 
  try { 
    const { _id, ...corpo } = req.body;
    const tipo = corpo.tipo;
    const valor = Number(corpo.valor);

    if (!corpo.codigo || !String(corpo.codigo).trim()) return res.status(400).json({ error: "Informe o código do cupom." });
    if (!['PERCENTUAL', 'FIXO'].includes(tipo)) return res.status(400).json({ error: "Tipo de desconto inválido." });
    if (!(valor > 0) || (tipo === 'PERCENTUAL' && valor > 100)) {
      return res.status(400).json({ error: tipo === 'PERCENTUAL' ? "A porcentagem deve estar entre 1 e 100." : "Informe um valor de desconto válido." });
    }

    // 🟢 Salva a dataFim sempre às 23:59:59 do fuso de Fortaleza (-03:00)
    const dataPura = String(corpo.dataFim).split('T')[0];
    const dataFimAjustada = new Date(`${dataPura}T23:59:59-03:00`);
    if (isNaN(dataFimAjustada.getTime())) return res.status(400).json({ error: "Data de validade inválida." });

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
    if (err.code === 11000) return res.status(400).json({ error: "Já existe um cupom com este código." });
    res.status(500).json({ error: "Erro ao criar cupom." }); 
  } 
});

app.put('/api/cupons/:id', async (req, res) => {
  try {
    const { _id, ...dados } = req.body;
    // Só normaliza se vier uma data "pura" (YYYY-MM-DD); um ISO já salvo não é mexido
    if (typeof dados.dataFim === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dados.dataFim)) {
      dados.dataFim = new Date(`${dados.dataFim}T23:59:59-03:00`);
    }
    const cupomEditado = await Cupom.findByIdAndUpdate(req.params.id, dados, { new: true });
    if (!cupomEditado) return res.status(404).json({ error: "Cupom não encontrado." });
    res.json(cupomEditado);
  } catch (err) { res.status(500).json({ error: "Erro" }); }
});
app.delete('/api/cupons/:id', async (req, res) => { try { await Cupom.findByIdAndDelete(req.params.id); res.json({ message: "Excluído" }); } catch (err) { res.status(500).json({ error: "Erro" }); } });

app.get('/api/cupons/validar/:codigo', async (req, res) => {
  try {
    const cupom = await Cupom.findOne({ codigo: req.params.codigo.toUpperCase() });
    const erro = verificarCupom(cupom, limparCpf(req.query.cpf));
    if (erro) return res.status(erro.includes('não encontrado') ? 404 : 400).json({ valido: false, error: erro });
    res.json({ valido: true, cupom });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// ==========================================
// 🧑‍🤝‍🧑 CLIENTES (autenticação validada no servidor)
// ==========================================

// LOGIN DO CLIENTE (e-mail ou CPF + senha)
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

    // Mensagem única: não revela se o login existe
    if (!cliente || !(await verificarSenha(senha, cliente.senha))) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    if (bcrypt && !ehHash(cliente.senha)) {
      cliente.senha = await gerarHash(senha);
      await cliente.save();
    }

    liberarLimite(chaveLogin);
    res.json(semSegredos(cliente));
  } catch (err) {
    console.error('Erro no login de cliente:', err);
    res.status(500).json({ error: 'Erro no servidor.' });
  }
});

// STATUS DO CPF: devolve SOMENTE se existe e se já tem senha (nenhum dado pessoal)
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

// ATIVAÇÃO DE CONTA de quem já é cliente da loja física: exige CPF + DATA DE NASCIMENTO
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

    // Resposta idêntica para "não existe", "já tem senha" e "data errada"
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
    res.json(semSegredos(cliente));
  } catch (err) {
    console.error('Erro ao ativar conta:', err);
    res.status(500).json({ error: 'Erro no servidor.' });
  }
});

// CADASTRO ONLINE de quem ainda NÃO existe na base
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
        validarNumeroWhatsApp(num).then(jid => enviarMensagemTexto(jid, msg)).catch(() => {});
      }
    } catch (e) { /* boas-vindas é opcional */ }

    res.status(201).json(semSegredos(novo));
  } catch (err) {
    console.error('Erro no cadastro online:', err);
    res.status(500).json({ error: 'Erro no servidor.' });
  }
});

// RECUPERAÇÃO: resposta igual exista o e-mail ou não (não revela quem é cliente)
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

// GET /api/clientes → nunca devolve senha nem tokens
app.get('/api/clientes', async (req, res) => {
  try {
    res.json(await Cliente.find().select('-senha -tokenRecuperacao -tokenExpiraEm').sort({ nome: 1 }));
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

app.get('/api/clientes/:id', async (req, res) => {
  try {
    const cliente = await Cliente.findById(req.params.id).select('-senha -tokenRecuperacao -tokenExpiraEm');
    if (!cliente) return res.status(404).json({ error: 'Não encontrado' });
    res.json(cliente);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// POST /api/clientes (cadastro feito pelo painel da loja)
app.post('/api/clientes', async (req, res) => {
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
      validarNumeroWhatsApp(num).then(jid => enviarMensagemTexto(jid, msg)).catch(() => {});
    }
    res.json(semSegredos(novoCliente));
  } catch (e) { res.status(500).json({ error: 'Erro' }); }
});

// PUT /api/clientes/:id → não aceita mexer em senha/tokens; propaga nome e CPF para as vendas
app.put('/api/clientes/:id', async (req, res) => {
  try {
    const { senha, tokenRecuperacao, tokenExpiraEm, _id, ...dados } = req.body;
    const antigo = await Cliente.findById(req.params.id);
    if (!antigo) return res.status(404).json({ error: 'Não encontrado' });

    const atualizado = await Cliente.findByIdAndUpdate(req.params.id, dados, { new: true });
    await Venda.updateMany(
      { cpf: antigo.cpf },
      { $set: { cliente: atualizado.nome, cpf: atualizado.cpf } }
    );
    res.json(semSegredos(atualizado));
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

app.delete('/api/clientes/:cpf', async (req, res) => {
  try {
    const d = limparCpf(req.params.cpf);
    const filtro = d.length === 11 ? { cpf: { $in: [d, formatarCpf(d)] } } : { cpf: req.params.cpf };
    await Cliente.deleteOne(filtro);
    res.json({ message: "Removido" });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// ==========================================
// 💰 VENDAS E ORDENS DE SERVIÇO
// ==========================================
app.get('/api/vendas', async (req, res) => {
  try {
    const vendas = await Venda.find().lean().sort({ dataVenda: -1 }); 
    const ordensServico = await OrdemServico.find().lean();
    const vendasComOS = vendas.map(venda => {
      const identificadorVenda = venda.numeroPedido ? String(venda.numeroPedido) : venda._id.toString();
      const osDestaVenda = ordensServico.filter(os => String(os.numeroPedido) === identificadorVenda);
      return { ...venda, ordensServico: osDestaVenda.map(os => ({ ...os, idOS: os._id.toString() })) };
    });
    res.json(vendasComOS);
  } catch (err) { res.status(500).json({ error: "Erro" }); }
});
app.post('/api/vendas', async (req, res) => { try { const ultimaVenda = await Venda.findOne().sort({ numeroPedido: -1 }); const proximoNumero = ultimaVenda && ultimaVenda.numeroPedido ? ultimaVenda.numeroPedido + 1 : 2000; const novaVenda = new Venda({ ...req.body, numeroPedido: proximoNumero }); res.json(await novaVenda.save()); } catch (err) { res.status(500).json({ error: "Erro" }); } });
app.patch('/api/vendas/:id', async (req, res) => { try { res.json(await Venda.findByIdAndUpdate(req.params.id, req.body, { new: true })); } catch (err) { res.status(500).json({ error: "Erro" }); } });
app.put('/api/vendas/:id', async (req, res) => { try { res.json(await Venda.findByIdAndUpdate(req.params.id, req.body, { new: true })); } catch (err) { res.status(500).json({ error: "Erro" }); } });
app.delete('/api/vendas/:id', async (req, res) => { try { await Venda.findByIdAndDelete(req.params.id); res.json({ message: "Excluída" }); } catch (err) { res.status(500).json({ error: "Erro" }); } });

app.get('/api/ordens_servico', async (req, res) => { try { res.json(await OrdemServico.find().sort({ _id: -1 })); } catch (err) { res.status(500).json({ error: "Erro" }); } });
app.get('/api/ordens_servico/pedido/:numeroPedido', async (req, res) => { try { const ordens = await OrdemServico.find({ numeroPedido: req.params.numeroPedido }); res.json(ordens); } catch (err) { res.status(500).json({ error: "Erro" }); } });
app.get('/api/ordens_servico/:id', async (req, res) => { try { const os = await OrdemServico.findById(req.params.id); if (!os) return res.status(404).json({ error: "Não encontrada" }); res.json(os); } catch (err) { res.status(500).json({ error: "Erro" }); } });
app.post('/api/ordens_servico', async (req, res) => { try { const novaOS = new OrdemServico(req.body); await novaOS.save(); res.status(201).json(novaOS); } catch (err) { res.status(500).json({ error: "Erro" }); } });
app.put('/api/ordens_servico/:id', async (req, res) => { try { const osEditada = await OrdemServico.findByIdAndUpdate(req.params.id, req.body, { new: true }); res.json(osEditada); } catch (err) { res.status(500).json({ error: "Erro" }); } });
app.delete('/api/ordens_servico/:id', async (req, res) => { try { await OrdemServico.findByIdAndDelete(req.params.id); res.json({ message: "Excluída" }); } catch (err) { res.status(500).json({ error: "Erro" }); } });


// =========================================================================
// 🟢 ROTA DE PARCELAS BLINDADA
// =========================================================================
// Número da parcela "restante" (pagamento parcial): 1 -> 1.5 ; 1.5 -> 1.75 (nunca colide com a parcela inteira seguinte)
const numeroParcelaResidual = (n) => (Number.isInteger(n) ? n + 0.5 : n + 0.25);

app.patch('/api/vendas/:id/parcela/:numero', async (req, res) => {
  try {
    const { id, numero } = req.params; 
    const { paga, dataPagamento, valorPago } = req.body;
    
    const venda = await Venda.findById(id);
    if (!venda) return res.status(404).json({ error: "Venda não encontrada" });
    
    const numAtual = parseFloat(numero); 
    let novasParcelas = JSON.parse(JSON.stringify(venda.listaParcelas || []));
    const index = novasParcelas.findIndex(p => String(p.numero) === String(numAtual));
    
    if (index === -1) return res.status(404).json({ error: "Parcela não encontrada" });

    if (paga === false) {
      const proximoNumero = numeroParcelaResidual(numAtual); 
      const parcelaFilhaIndex = novasParcelas.findIndex(p => String(p.numero) === String(proximoNumero));
      
      if (parcelaFilhaIndex !== -1 && !Number.isInteger(proximoNumero)) {
        const somaRecomposta = Number(novasParcelas[index].valor) + Number(novasParcelas[parcelaFilhaIndex].valor);
        novasParcelas[index].valor = parseFloat(somaRecomposta.toFixed(2)); 
        novasParcelas.splice(parcelaFilhaIndex, 1); 
      }
      
      novasParcelas[index].paga = false; 
      novasParcelas[index].dataPagamento = null;
      
    } else {
      let valorInformado = parseFloat(Number(valorPago || novasParcelas[index].valor).toFixed(2));
      let valorOriginalDaParcela = parseFloat(Number(novasParcelas[index].valor).toFixed(2));
      const diferenca = parseFloat((valorInformado - valorOriginalDaParcela).toFixed(2));

      if (diferenca > 0) {
        let excesso = diferenca;
        novasParcelas[index].valor = valorInformado; 
        
        for (let i = index + 1; i < novasParcelas.length; i++) {
          if (excesso <= 0) break; 
          // 🟢 não "come" parcelas já pagas nem as que foram renegociadas
          if (novasParcelas[i].paga || novasParcelas[i].renegociada) continue;
          
          let valorDaProxima = parseFloat(Number(novasParcelas[i].valor).toFixed(2));
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
            numero: numeroParcelaResidual(numAtual), 
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
    console.error("Erro no patch de parcelas:", err);
    res.status(500).json({ error: "Erro interno no servidor." }); 
  }
});


// ==========================================
// 📉 DESPESAS E PRODUTOS
// ==========================================
app.get('/api/despesas', async (req, res) => { try { res.json(await Despesa.find().sort({ vencimento: -1 })); } catch (err) { res.status(500).json({ error: "Erro" }); } });
app.post('/api/despesas', async (req, res) => { try { res.json(await new Despesa(req.body).save()); } catch (err) { res.status(400).json({ error: "Erro ao salvar despesa." }); } });
app.patch('/api/despesas/:id', async (req, res) => { try { res.json(await Despesa.findByIdAndUpdate(req.params.id, req.body, { new: true })); } catch (err) { res.status(500).json({ error: "Erro" }); } });
app.delete('/api/despesas/:id', async (req, res) => { try { await Despesa.findByIdAndDelete(req.params.id); res.json({ message: "Excluída" }); } catch (err) { res.status(500).json({ error: "Erro" }); } });

app.get('/api/produtos', async (req, res) => {
  try {
    const listaProdutos = await Produto.find({}).select('nome preco categoria quantidade referencia foto fotos descricao').lean().sort({ nome: 1 });
    res.json(listaProdutos);
  } catch (err) {
    res.status(500).json({ error: "Falha ao buscar", detalhes: err.message });
  }
});
app.post('/api/produtos', async (req, res) => { try { res.json(await new Produto(req.body).save()); } catch (err) { res.status(400).json({ error: "Erro ao salvar produto." }); } });
app.put('/api/produtos/:id', async (req, res) => { try { res.json(await Produto.findByIdAndUpdate(req.params.id, req.body, { new: true })); } catch (err) { res.status(500).json({ error: "Erro" }); } });
app.delete('/api/produtos/:id', async (req, res) => { try { await Produto.findByIdAndDelete(req.params.id); res.json({ message: "Removido" }); } catch (err) { res.status(500).json({ error: "Erro" }); } });

// ==========================================
// 🛒 PEDIDOS ONLINE
// ==========================================
app.get('/api/pedidos_online', async (req, res) => { 
  try { 
    const pedidos = await PedidoOnline.find().sort({ dataPedido: -1 }); 
    res.json(pedidos); 
  } catch (err) { 
    res.status(500).json({ error: "Erro" }); 
  } 
});

// 🟢 Ponte (Proxy) com a InfinitePay, agora VALIDADA no servidor:
// só gera link para um pedido que existe, está aguardando pagamento e cujo valor confere.
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

    // Confere se a soma dos itens (em centavos) bate com o total gravado no pedido
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
    // tolerância de 1 centavo por item (arredondamento da divisão proporcional do desconto)
    if (Math.abs(somaCentavos - esperado) > itensLink.length) {
      return res.status(400).json({ error: 'O valor do pagamento não confere com o pedido.' });
    }

    // O handle pode ser fixado no servidor (INFINITEPAY_HANDLE); senão usa o que o front enviou
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

    // Consome o cupom de forma ATÔMICA (evita uso duplo em requisições simultâneas)
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

    // 🟢 Número do pedido vem de um contador atômico (nunca repete)
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
    // Se o pedido falhou depois de gastar o cupom, devolve o uso
    if (cupomConsumido) {
      await devolverUsoCupom({ _id: cupomConsumido._id }, limparCpf(req.body.clienteCpf)).catch(() => {});
    }
    if (err instanceof ErroNegocio) return res.status(err.status).json({ error: err.message });
    console.error('Erro ao criar pedido:', err);
    res.status(500).json({ error: 'Erro ao criar pedido.' });
  }
});

const STATUS_PEDIDO_VALIDOS = ['AGUARDANDO_PAGAMENTO', 'PAGO', 'CONCLUIDO', 'CANCELADO'];

app.patch('/api/pedidos_online/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!STATUS_PEDIDO_VALIDOS.includes(status)) return res.status(400).json({ error: 'Status inválido.' });

    const pedidoAnterior = await PedidoOnline.findById(req.params.id);
    if (!pedidoAnterior) return res.status(404).json({ error: 'Pedido não encontrado.' });

    if (status === 'CANCELADO') {
      // Pedido já despachado/concluído não pode ser apagado por aqui (a venda já foi registrada)
      if (pedidoAnterior.status === 'CONCLUIDO') {
        return res.status(400).json({ error: 'Pedido já concluído não pode ser cancelado.' });
      }
      if (pedidoAnterior.cupomUtilizado) {
        await devolverUsoCupom({ codigo: pedidoAnterior.cupomUtilizado }, limparCpf(pedidoAnterior.clienteCpf));
      }
      // 🟢 Se o estoque já tinha sido baixado (pedido pago), devolve
      if (pedidoAnterior.estoqueBaixado) {
        await ajustarEstoquePedido(pedidoAnterior.itens, +1);
      }
      await PedidoOnline.findByIdAndDelete(req.params.id);
      return res.json({ message: 'Excluído.' });
    }

    // 🟢 Baixa de estoque UMA vez, quando o pedido passa a PAGO (ou vai direto para CONCLUIDO)
    const atualizacao = { status };
    if ((status === 'PAGO' || status === 'CONCLUIDO') && !pedidoAnterior.estoqueBaixado) {
      await ajustarEstoquePedido(pedidoAnterior.itens, -1);
      atualizacao.estoqueBaixado = true;
    }

    const pedidoAtualizado = await PedidoOnline.findByIdAndUpdate(req.params.id, atualizacao, { new: true });

    if (status === 'CONCLUIDO' && pedidoAnterior.status !== 'CONCLUIDO') {
      // 🟢 Busca o cliente por CPF com ou sem máscara (evita cadastro duplicado)
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

      const ultimaVenda = await Venda.findOne().sort({ numeroPedido: -1 });
      const proximoNumero = ultimaVenda && ultimaVenda.numeroPedido ? ultimaVenda.numeroPedido + 1 : 2000;
      const hojeBR = obterDataHojeBR(); // 🟢 Data exata de Fortaleza

      const novaVendaOficial = new Venda({
        numeroPedido: proximoNumero, 
        cliente: pedidoAtualizado.clienteNome, 
        cpf: pedidoAtualizado.clienteCpf, 
        produto: "Compra Online - " + pedidoAtualizado.itens.map(i => i.nome).join(', '), 
        itensCarrinho: pedidoAtualizado.itens, 
        valorTotal: pedidoAtualizado.valorTotal, 
        valorEntrada: pedidoAtualizado.valorTotal, 
        desconto: 0, 
        parcelas: 1,
        listaParcelas: [{ numero: 1, valor: pedidoAtualizado.valorTotal, dataVencimento: hojeBR, paga: true, dataPagamento: hojeBR, observacao: "Pago via Site" }],
        dataVenda: hojeBR, 
        dataEntrada: hojeBR,
        metodoPagamento: 'Pagamento Digital (Site)', 
        observacoes: `Origem: Pedido Online #${pedidoAtualizado.numeroPedidoOnline} | Entrega: ${pedidoAtualizado.freteTipo || 'Padrão'}`
      });
      await novaVendaOficial.save();
    }
    res.json(pedidoAtualizado);
  } catch (err) { 
    console.error("Erro ao atualizar status do pedido:", err);
    res.status(500).json({ error: "Erro" }); 
  }
});

// 🟢 Cotação de frete (informativa). O valor COBRADO no pedido vem sempre da tabela FRETES do servidor.
app.post('/api/frete', async (req, res) => {
  try {
    const cepOrigem = '60442000'; 
    const cepDestinoLimpo = String((req.body && req.body.cepDestino) || '').replace(/\D/g, '');

    if (cepDestinoLimpo.length !== 8) return res.status(400).json({ error: "CEP inválido." });

    const urlBase = `https://brasilapi.com.br/api/correios/v1/frete/preco?sCepOrigem=${cepOrigem}&sCepDestino=${cepDestinoLimpo}&nVlPeso=0.3&nCdFormato=1&nVlComprimento=16&nVlAltura=11&nVlLargura=11`;
    // 🟢 allSettled: se a BrasilAPI cair, ainda devolvemos as opções padrão em vez de erro 500
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
        const valor = Number(String(dados[0].Valor).replace(',', '.'));
        if (!isNaN(valor)) opcoes.push({ id, nome, valor, prazo: `${dados[0].PrazoEntrega} dias úteis` });
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

    res.json(opcoes);
  } catch (error) { res.status(500).json({ error: "Falha ao calcular." }); }
});

// ==========================================
// 🤖 MOTOR DO WHATSAPP BLINDADO CONTRA LOOP
// ==========================================
async function inicializarWhatsApp(forcar = false) {
  if (reconectando) return;
  reconectando = true;

  try {
    const registroSessao = await Configuracao.findOne({ chave: 'whatsapp_session_creds' });

    if (!forcar && (!registroSessao || !registroSessao.valor)) {
      console.log('📵 Sem sessão salva. Bot aguardando ação do usuário (Painel Zap → Conectar).');
      statusConexao = 'Aguardando configuração';
      reconectando = false;
      return;
    }

    let credsCarregadas = null;
    if (registroSessao && registroSessao.valor) { 
      try { 
        credsCarregadas = JSON.parse(registroSessao.valor, (key, value) => { 
          if (value && value.type === 'Buffer' && Array.isArray(value.data)) { return Buffer.from(value.data); } 
          return value; 
        }); 
      } catch (e) {} 
    }

    const { initAuthCreds } = require('@whiskeysockets/baileys');
    const state = { creds: credsCarregadas || initAuthCreds(), keys: { get: () => ({}), set: () => {} } };

    const guardarSessaoNoMongo = async () => { 
      try { 
        const textoSessao = JSON.stringify(state.creds); 
        await Configuracao.updateOne({ chave: 'whatsapp_session_creds' }, { valor: textoSessao }, { upsert: true }); 
      } catch (err) {} 
    };

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
          try { await Configuracao.deleteOne({ chave: 'whatsapp_session_creds' }); } catch (e) {} 
          console.log("🧹 Sessão do WhatsApp corrompida. Limpeza automática realizada!");
          tentativasConexao = 0; 
          statusConexao = 'Erro ao conectar';
          console.log("⏸️ O bot pausou as tentativas. Use o botão no Painel Zap para reiniciar.");
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

    whatsappClient.ev.on('creds.update', async () => { await guardarSessaoNoMongo(); });
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

async function validarNumeroWhatsApp(numeroPuro) { 
  const fallbackJid = `${numeroPuro}@s.whatsapp.net`;
  if (!whatsappClient || statusConexao !== 'Conectado') return fallbackJid;
  try { 
    const [result] = await Promise.race([
      whatsappClient.onWhatsApp(fallbackJid),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
    ]);
    if (result && result.exists) return result.jid; 
    return fallbackJid; 
  } catch (e) { 
    return fallbackJid; 
  } 
}

// 🟢 Descobre o JID real testando o número com e sem o 9º dígito. Retorna null se não existir no WhatsApp.
async function resolverJidWhatsApp(num) {
  if (!whatsappClient || statusConexao !== 'Conectado') return null;
  const variantes = [num];
  if (num.length === 13 && num.startsWith('55')) variantes.push(num.slice(0, 4) + num.slice(5));      // remove o 9
  if (num.length === 12 && num.startsWith('55')) variantes.push(num.slice(0, 4) + '9' + num.slice(4)); // adiciona o 9

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

// 🟢 Controle de "já enviei hoje" salvo no banco (não reenvia se o servidor reiniciar)
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
    const hoje = obterDataHojeBR(); // 🟢 YYYY-MM-DD local de Fortaleza
    const [, mesHoje, diaHoje] = hoje.split('-');
    const CHAVE = 'wa_enviados_aniversario';
    const enviados = await carregarEnviados(CHAVE, hoje);

    const aniversariantes = await Cliente.find({ dataNascimento: new RegExp(`^\\d{4}-${mesHoje}-${diaHoje}$`) });
    const pendentes = aniversariantes.filter(c => !enviados.ids.includes(String(c._id)));
    if (pendentes.length === 0) return;
    const configMsg = await Configuracao.findOne({ chave: 'msg_aniversario' }); 
    const templateBase = configMsg ? configMsg.valor : "Olá, {nome}! Feliz Aniversário!";

    for (const cliente of pendentes) {
      if (!cliente.telefone) continue;
      let num = cliente.telefone.replace(/\D/g, ''); if (!num.startsWith('55')) num = `55${num}`;
      const msg = templateBase.replace(/{nome}/g, cliente.nome);

      const jid = await resolverJidWhatsApp(num);
      if (jid) await enviarMensagemTexto(jid, msg);

      // marca como tratado (mesmo se o número não existir no WhatsApp, para não tentar de hora em hora)
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
    const dataAlvoStr = data.toLocaleDateString('sv-SE', { timeZone: 'America/Fortaleza' }); // 🟢 30 dias atrás no fuso local
    const CHAVE = 'wa_enviados_posvenda';
    const enviados = await carregarEnviados(CHAVE, hoje);

    const vendas = await Venda.find({ dataVenda: dataAlvoStr });
    const pendentes = vendas.filter(v => !enviados.ids.includes(String(v._id)));
    if (pendentes.length === 0) return;
    const configMsg = await Configuracao.findOne({ chave: 'msg_pos_venda' }); 
    const templateBase = configMsg ? configMsg.valor : "Olá, {nome}! Como está seu {produto}?";

    for (const venda of pendentes) {
      const digitos = limparCpf(venda.cpf);
      const cliente = digitos.length === 11 ? await buscarClientePorCpf(digitos) : await Cliente.findOne({ cpf: venda.cpf });
      if (!cliente || !cliente.telefone) continue;
      let num = cliente.telefone.replace(/\D/g, ''); if (!num.startsWith('55')) num = `55${num}`;
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
