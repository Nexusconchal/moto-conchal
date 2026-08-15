// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const corridasRoutes = require('./routes/corridas');
const webhookRoutes = require('./routes/webhook');
const adminRoutes = require('./routes/admin');

const app = express();

app.use(cors());
app.use(express.json());

// Rotas da API
app.use('/api/corridas', corridasRoutes);
app.use('/api/webhook', webhookRoutes);
app.use('/api/admin', adminRoutes);

// (Opcional) servir o PWA do cliente e o painel do admin como estático,
// caso queira hospedar tudo junto no mesmo serviço (Railway/Render).
app.use('/', express.static(path.join(__dirname, '..', 'frontend')));
app.use('/admin', express.static(path.join(__dirname, '..', 'admin')));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', servico: 'Moto Conchal Backend', hora: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🏍️  Moto Conchal Backend rodando na porta ${PORT}`);
});
