// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');

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

// Health check e rota raiz
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    servico: 'Moto Conchal Backend',
    mensagem: 'API funcionando perfeitamente!'
  });
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    servico: 'Moto Conchal Backend', 
    hora: new Date().toISOString() 
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🏍️  Moto Conchal Backend rodando na porta ${PORT}`);
});
