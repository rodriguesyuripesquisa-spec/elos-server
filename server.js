process.env.TZ = 'America/Fortaleza'; // 🟢 Força o servidor (local e Render) a usar o fuso horário de Fortaleza (-03:00)

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { default: makeWASocket, DisconnectReason } = require('@whiskeysockets/baileys'); 
const QRCode = require('qrcode');
const nodemailer = require('nodemailer'); 

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
app.use(cors({
  origin: '*',
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
let idsAniversariantesEnviadosHoje = []; 
let idsPosVendaEnviadosHoje = [];
let dataUltimaVerificacaoJanela = "";

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
  dataPedido: { type: Date, default: Date.now }, infinitePayId: String
});
const PedidoOnline = mongoose.model('PedidoOnline', PedidoOnlineSchema);

const inicializarAdmin = async () => {
  try {
    const adminExiste = await Funcionario.findOne({ cargo: 'ADMIN' });
    if (!adminExiste) {
      await new Funcionario({ 
        nome: 'Administrador (Dono)', 
        usuario: 'admin', 
        senha: '123', 
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
  try { const configs = await Configuracao.find(); const mapa = {}; configs.forEach(c => mapa[c.chave] = c.valor); res.json(mapa); } 
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

app.post('/api/funcionarios/login', async (req, res) => {
  try {
    const { usuario, senha } = req.body;
    const func = await Funcionario.findOne({ usuario: usuario.toLowerCase(), senha });
    if (!func) return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
    if (!func.ativo) return res.status(403).json({ error: 'Sua conta foi desativada pelo administrador.' });
    res.json({ id: func._id, nome: func.nome, usuario: func.usuario, cargo: func.cargo });
  } catch (err) { res.status(500).json({ error: 'Erro no servidor' }); }
});

app.get('/api/funcionarios', async (req, res) => { try { res.json(await Funcionario.find().select('-senha')); } catch (err) { res.status(500).json({ error: "Erro" }); } });
app.post('/api/funcionarios', async (req, res) => { try { const dados = { ...req.body, usuario: req.body.usuario.toLowerCase() }; const novoFunc = new Funcionario(dados); await novoFunc.save(); res.status(201).json(novoFunc); } catch (err) { if (err.code === 11000) return res.status(400).json({ error: "Este nome de usuário já está em uso." }); res.status(500).json({ error: "Erro" }); } });
app.put('/api/funcionarios/:id', async (req, res) => { try { if (req.body.usuario) req.body.usuario = req.body.usuario.toLowerCase(); const func = await Funcionario.findByIdAndUpdate(req.params.id, req.body, { new: true }); res.json(func); } catch (err) { res.status(500).json({ error: "Erro" }); } });
app.delete('/api/funcionarios/:id', async (req, res) => { try { await Funcionario.findByIdAndDelete(req.params.id); res.json({ message: "Excluído." }); } catch (err) { res.status(500).json({ error: "Erro" }); } });

// ==========================================
// 🎟️ ROTAS DE CUPONS (FUSO HORÁRIO E LIMITE DE USO CORRIGIDOS)
// ==========================================

const arred = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const limparCpf = (c) => String(c || '').replace(/\D/g, '');

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

// Regras do cupom num lugar só (usado em /validar e no pedido)
function verificarCupom(cupom, cpfLimpo) {
  if (!cupom) return 'Cupom não encontrado.';
  if (!cupom.ativo) return 'Este cupom está inativo.';
  if (new Date() > new Date(cupom.dataFim)) return 'Este cupom já expirou.';   // dataFim já é 23:59:59-03:00
  if ((cupom.usosAtuais || 0) >= (cupom.limiteUso ?? 1)) return 'Este cupom já atingiu o limite máximo de utilizações.';
  if (cpfLimpo && (cupom.cpfsUtilizados || []).includes(cpfLimpo)) return 'Você já utilizou este cupom anteriormente.';
  return null;
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
  if (freteId === 'motoboy' && !['60','61'].includes(String(cep || '').replace(/\D/g, '').slice(0, 2)))
  throw new ErroNegocio('Motoboy disponível apenas para Fortaleza e região.');

  const valorTotal = arred(Math.max(0, subtotal - descontoCupom) + frete.valor);
  return { itensFinais, subtotal, descontoCupom, valorTotal, frete, cupomDoc, cpfLimpo };
}

app.get('/api/cupons', async (req, res) => { try { res.json(await Cupom.find().sort({ dataFim: -1 })); } catch (err) { res.status(500).json({ error: "Erro" }); } });

app.post('/api/cupons', async (req, res) => { 
  try { 
    // 🟢 Salva a dataFim sempre às 23:59:59 do fuso de Fortaleza (-03:00)
    const dataPura = String(req.body.dataFim).split('T')[0];
    const dataFimAjustada = new Date(`${dataPura}T23:59:59-03:00`);

    const dadosCupom = {
      ...req.body,
      dataFim: dataFimAjustada,
      limiteUso: req.body.limiteUso !== undefined && req.body.limiteUso !== '' ? Number(req.body.limiteUso) : 1,
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

app.put('/api/cupons/:id', async (req, res) => { try { const cupomEditado = await Cupom.findByIdAndUpdate(req.params.id, req.body, { new: true }); res.json(cupomEditado); } catch (err) { res.status(500).json({ error: "Erro" }); } });
app.delete('/api/cupons/:id', async (req, res) => { try { await Cupom.findByIdAndDelete(req.params.id); res.json({ message: "Excluído" }); } catch (err) { res.status(500).json({ error: "Erro" }); } });

app.get('/api/cupons/validar/:codigo', async (req, res) => {
  try {
    const cupom = await Cupom.findOne({ codigo: req.params.codigo.toUpperCase() });
    const erro = verificarCupom(cupom, limparCpf(req.query.cpf));
    if (erro) return res.status(erro.includes('não encontrado') ? 404 : 400).json({ valido: false, error: erro });
    res.json({ valido: true, cupom });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

app.get('/api/clientes', async (req, res) => res.json(await Cliente.find().sort({ nome: 1 })));
app.get('/api/clientes/:id', async (req, res) => { try { const cliente = await Cliente.findById(req.params.id); if (!cliente) return res.status(404).json({ error: "Não encontrado" }); res.json(cliente); } catch (err) { res.status(500).json({ error: "Erro" }); } });

app.post('/api/clientes', async (req, res) => {
  try {
    const novoCliente = new Cliente(req.body);
    await novoCliente.save();
    if (novoCliente.telefone) {
      let num = novoCliente.telefone.replace(/\D/g, ''); 
      if (!num.startsWith('55')) num = `55${num}`;
      const msg = `Olá, ${novoCliente.nome.split(' ')[0]}! ✨\n\nSeja muito bem-vindo(a) à *Ótica Elos*! Seu cadastro foi realizado com sucesso. Sempre que precisar, este é o nosso canal oficial de atendimento.`;
      validarNumeroWhatsApp(num)
        .then(jid => enviarMensagemTexto(jid, msg))
        .catch(() => {});
    }
    res.json(novoCliente);
  } catch(e) { res.status(500).json({error: "Erro"}); }
});

app.put('/api/clientes/:id', async (req, res) => { try { const clienteAtualizado = await Cliente.findByIdAndUpdate(req.params.id, req.body, { new: true }); if (!clienteAtualizado) return res.status(404).json({ error: "Não encontrado" }); await Venda.updateMany({ cpf: clienteAtualizado.cpf }, { $set: { cliente: clienteAtualizado.nome } }); res.json(clienteAtualizado); } catch (err) { res.status(500).json({ error: "Erro" }); } });
app.delete('/api/clientes/:cpf', async (req, res) => { await Cliente.deleteOne({ cpf: req.params.cpf }); res.json({ message: "Removido" }); });

app.post('/api/clientes/solicitar-recuperacao', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "E-mail obrigatório." });
    const cliente = await Cliente.findOne({ email: email.trim().toLowerCase() });
    if (!cliente) return res.status(404).json({ error: "E-mail não encontrado." });

    const codigoToken = Math.floor(100000 + Math.random() * 900000).toString();
    const dataExpiracao = new Date(Date.now() + 15 * 60000); 

    cliente.tokenRecuperacao = codigoToken; cliente.tokenExpiraEm = dataExpiracao; await cliente.save();

    const mailOptions = {
      from: '"Ótica Elos - Suporte" <nao-responda@oticaelos.com>', to: cliente.email, subject: 'Recuperação de Senha - Ótica Elos',
      html: `
        <div style="font-family: sans-serif; max-w: 600px; margin: auto; padding: 30px; border: 1px solid #eee; border-radius: 10px;">
          <h2 style="color: #1d3026;">Olá, ${cliente.nome.split(' ')[0]}!</h2>
          <p>Recebemos um pedido de recuperação de senha para a sua conta na Ótica Elos E-commerce.</p>
          <p>Seu código de segurança é:</p>
          <div style="background-color: #f9f8f6; padding: 20px; text-align: center; font-size: 32px; letter-spacing: 5px; font-weight: bold; color: #1d3026; border-radius: 10px; margin: 20px 0;">
            ${codigoToken}
          </div>
          <p style="font-size: 12px; color: #666;">Este código é válido por 15 minutos.</p>
        </div>`
    };

    transporter.sendMail(mailOptions, (error) => {
      if (error) return res.status(500).json({ error: "Erro no servidor de e-mail." });
      res.json({ success: true, message: "Token enviado!" });
    });
  } catch (err) { res.status(500).json({ error: "Erro ao processar." }); }
});

app.post('/api/clientes/redefinir-senha', async (req, res) => {
  try {
    const { email, token, novaSenha } = req.body;
    const cliente = await Cliente.findOne({ email: email.trim().toLowerCase() });
    if (!cliente) return res.status(404).json({ error: "Cliente não encontrado." });
    if (cliente.tokenRecuperacao !== token || new Date() > cliente.tokenExpiraEm) return res.status(400).json({ error: "Código inválido ou expirado." });

    cliente.senha = novaSenha; cliente.tokenRecuperacao = null; cliente.tokenExpiraEm = null; await cliente.save();
    res.json({ success: true, message: "Senha atualizada." });
  } catch (err) { res.status(500).json({ error: "Erro ao redefinir." }); }
});

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

app.get('/api/ordens_servico', async (req, res) => res.json(await OrdemServico.find().sort({ _id: -1 })));
app.get('/api/ordens_servico/:id', async (req, res) => { try { const os = await OrdemServico.findById(req.params.id); if (!os) return res.status(404).json({ error: "Não encontrada" }); res.json(os); } catch (err) { res.status(500).json({ error: "Erro" }); } });
app.get('/api/ordens_servico/pedido/:numeroPedido', async (req, res) => { try { const ordens = await OrdemServico.find({ numeroPedido: req.params.numeroPedido }); res.json(ordens); } catch (err) { res.status(500).json({ error: "Erro" }); } });
app.post('/api/ordens_servico', async (req, res) => { try { const novaOS = new OrdemServico(req.body); await novaOS.save(); res.status(201).json(novaOS); } catch (err) { res.status(500).json({ error: "Erro" }); } });
app.put('/api/ordens_servico/:id', async (req, res) => { try { const osEditada = await OrdemServico.findByIdAndUpdate(req.params.id, req.body, { new: true }); res.json(osEditada); } catch (err) { res.status(500).json({ error: "Erro" }); } });
app.delete('/api/ordens_servico/:id', async (req, res) => { try { await OrdemServico.findByIdAndDelete(req.params.id); res.json({ message: "Excluída" }); } catch (err) { res.status(500).json({ error: "Erro" }); } });


// =========================================================================
// 🟢 ROTA DE PARCELAS BLINDADA
// =========================================================================
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
      const proximoNumero = numAtual + 0.5; 
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
          if (novasParcelas[i].paga) continue;
          
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
            numero: numAtual + 0.5, 
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


app.get('/api/despesas', async (req, res) => res.json(await Despesa.find().sort({ vencimento: -1 })));
app.post('/api/despesas', async (req, res) => res.json(await new Despesa(req.body).save()));
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
app.post('/api/produtos', async (req, res) => res.json(await new Produto(req.body).save()));
app.put('/api/produtos/:id', async (req, res) => { try { res.json(await Produto.findByIdAndUpdate(req.params.id, req.body, { new: true })); } catch (err) { res.status(500).json({ error: "Erro" }); } });
app.delete('/api/produtos/:id', async (req, res) => { try { await Produto.findByIdAndDelete(req.params.id); res.json({ message: "Removido" }); } catch (err) { res.status(500).json({ error: "Erro" }); } });

app.get('/api/pedidos_online', async (req, res) => { try { const pedidos = await PedidoOnline.find().sort({ dataPedido: -1 }); res.json(pedidos); } catch (err) { res.status(500).json({ error: "Erro" }); } });

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

    const ultimo = await PedidoOnline.findOne().sort({ numeroPedidoOnline: -1 });
    const proximoNumero = ultimo && ultimo.numeroPedidoOnline ? ultimo.numeroPedidoOnline + 1 : 1000;

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
      await Cupom.updateOne(
        { _id: cupomConsumido._id },
        { $inc: { usosAtuais: -1 }, $pull: { cpfsUtilizados: limparCpf(req.body.clienteCpf) }, $set: { ativo: true } }
      ).catch(() => {});
    }
    if (err instanceof ErroNegocio) return res.status(err.status).json({ error: err.message });
    console.error('Erro ao criar pedido:', err);
    res.status(500).json({ error: 'Erro ao criar pedido.' });
  }
});

app.patch('/api/pedidos_online/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const pedidoAnterior = await PedidoOnline.findById(req.params.id);
    if (!pedidoAnterior) return res.status(404).json({ error: 'Pedido não encontrado.' });

    if (status === 'CANCELADO') {
      if (pedidoAnterior.cupomUtilizado && pedidoAnterior.status !== 'CONCLUIDO') {
        await Cupom.updateOne(
          { codigo: pedidoAnterior.cupomUtilizado },
          {
            $inc: { usosAtuais: -1 },
            $pull: { cpfsUtilizados: limparCpf(pedidoAnterior.clienteCpf) },
            $set: { ativo: true }
          }
        );
      }
      await PedidoOnline.findByIdAndDelete(req.params.id);
      return res.json({ message: 'Excluído.' });
    }

    if (status === 'CONCLUIDO' && pedidoAnterior.status !== 'CONCLUIDO') {
      let clienteExiste = await Cliente.findOne({ cpf: pedidoAtualizado.clienteCpf });
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
  } catch (err) { res.status(500).json({ error: "Erro" }); }
});

app.post('/api/frete', async (req, res) => {
  try {
    const { cepDestino } = req.body;
    const cepOrigem = '60442000'; 
    const cepDestinoLimpo = cepDestino.replace(/\D/g, '');

    if (!cepDestinoLimpo || cepDestinoLimpo.length !== 8) return res.status(400).json({ error: "CEP inválido." });

    const pacReq = fetch(`https://brasilapi.com.br/api/correios/v1/frete/preco?sCepOrigem=${cepOrigem}&sCepDestino=${cepDestinoLimpo}&nVlPeso=0.3&nCdFormato=1&nVlComprimento=16&nVlAltura=11&nVlLargura=11&nCdServico=04510`);
    const sedexReq = fetch(`https://brasilapi.com.br/api/correios/v1/frete/preco?sCepOrigem=${cepOrigem}&sCepDestino=${cepDestinoLimpo}&nVlPeso=0.3&nCdFormato=1&nVlComprimento=16&nVlAltura=11&nVlLargura=11&nCdServico=04014`);

    const [pacRes, sedexRes] = await Promise.all([pacReq, sedexReq]);
    const opcoes = [
      { id: 'retirada', nome: 'Retirar na Loja (Bela Vista)', valor: 0.00, prazo: 'Imediato' }
    ];
    
    const prefixo = cepDestinoLimpo.substring(0, 2);
    if (['60', '61', '62', '63'].includes(prefixo)) {
      opcoes.push({ id: 'motoboy', nome: 'Motoboy Fortaleza/Região', valor: 15.00, prazo: '1 dia útil' });
    }

    if (pacRes.ok) {
      const pacData = await pacRes.json();
      opcoes.push({ id: 'pac', nome: 'Correios PAC', valor: Number(pacData[0].Valor.replace(',', '.')), prazo: `${pacData[0].PrazoEntrega} dias úteis` });
    }
    if (sedexRes.ok) {
      const sedexData = await sedexRes.json();
      opcoes.push({ id: 'sedex', nome: 'Correios Sedex', valor: Number(sedexData[0].Valor.replace(',', '.')), prazo: `${sedexData[0].PrazoEntrega} dias úteis` });
    }

    if (!opcoes.some(o => o.id === 'pac')) {
       opcoes.push({ id: 'pac', nome: 'Correios PAC', valor: 28.90, prazo: '5 a 8 dias úteis' });
       opcoes.push({ id: 'sedex', nome: 'Correios Sedex', valor: 45.50, prazo: '2 a 3 dias úteis' });
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
  if (!whatsappClient || statusConexao !== 'Conectado') return; 
  try {
    await whatsappClient.sendMessage(jid, { text: texto }); 
  } catch (e) {
    console.error('Erro ao enviar msg WhatsApp:', e.message);
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

async function verificarAniversariantesDoDia() {
  if (!whatsappClient || statusConexao !== 'Conectado') return;
  const hojeDataCompleta = obterDataHojeBR(); // 🟢 YYYY-MM-DD local de Fortaleza
  const [, mesHoje, diaHoje] = hojeDataCompleta.split('-');

  if (dataUltimaVerificacaoJanela !== hojeDataCompleta) { 
    idsAniversariantesEnviadosHoje = []; 
    idsPosVendaEnviadosHoje = []; 
    dataUltimaVerificacaoJanela = hojeDataCompleta; 
  }
  try {
    const aniversariantes = await Cliente.find({ dataNascimento: new RegExp(`^\\d{4}-${mesHoje}-${diaHoje}$`) });
    const pendentes = aniversariantes.filter(c => !idsAniversariantesEnviadosHoje.includes(String(c._id)));
    if (pendentes.length === 0) return;
    const configMsg = await Configuracao.findOne({ chave: 'msg_aniversario' }); const templateBase = configMsg ? configMsg.valor : "Olá, {nome}! Feliz Aniversário!";

    for (const cliente of pendentes) {
      if (!cliente.telefone) continue;
      let num = cliente.telefone.replace(/\D/g, ''); if (!num.startsWith('55')) num = `55${num}`;
      const msg = templateBase.replace(/{nome}/g, cliente.nome);
      let sucesso = false;
      try { const jid = await validarNumeroWhatsApp(num); await enviarMensagemTexto(jid, msg); sucesso = true; } catch (e) {}
      if (!sucesso && num.length === 13) { try { const jid = await validarNumeroWhatsApp(num.substring(0, 4) + num.substring(5)); await enviarMensagemTexto(jid, msg); } catch (e) {} }
      idsAniversariantesEnviadosHoje.push(String(cliente._id)); await new Promise(r => setTimeout(r, 5000));
    }
  } catch (error) {}
}

async function verificarPosVendaTrintaDias() {
  if (!whatsappClient || statusConexao !== 'Conectado') return;
  const data = new Date(); 
  data.setDate(data.getDate() - 30); 
  const dataAlvoStr = data.toLocaleDateString('sv-SE', { timeZone: 'America/Fortaleza' }); // 🟢 30 dias atrás no fuso local

  try {
    const vendas = await Venda.find({ dataVenda: dataAlvoStr });
    const pendentes = vendas.filter(v => !idsPosVendaEnviadosHoje.includes(String(v._id)));
    if (pendentes.length === 0) return;
    const configMsg = await Configuracao.findOne({ chave: 'msg_pos_venda' }); const templateBase = configMsg ? configMsg.valor : "Olá, {nome}! Como está seu {produto}?";

    for (const venda of pendentes) {
      const cliente = await Cliente.findOne({ cpf: venda.cpf }); if (!cliente || !cliente.telefone) continue;
      let num = cliente.telefone.replace(/\D/g, ''); if (!num.startsWith('55')) num = `55${num}`;
      const msg = templateBase.replace(/{nome}/g, venda.cliente).replace(/{produto}/g, venda.produto);
      let sucesso = false;
      try { const jid = await validarNumeroWhatsApp(num); await enviarMensagemTexto(jid, msg); sucesso = true; } catch (e) {}
      if (!sucesso && num.length === 13) { try { const jid = await validarNumeroWhatsApp(num.substring(0, 4) + num.substring(5)); await enviarMensagemTexto(jid, msg); } catch (e) {} }
      idsPosVendaEnviadosHoje.push(String(venda._id)); await new Promise(r => setTimeout(r, 5000));
    }
  } catch (error) {}
}

setInterval(() => { verificarAniversariantesDoDia(); verificarPosVendaTrintaDias(); }, 1000 * 60 * 60);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Servidor rodando na porta ${PORT} (Fuso: America/Fortaleza)`));
