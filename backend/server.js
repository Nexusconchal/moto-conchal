// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

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

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', servico: 'Moto Conchal Backend', hora: new Date().toISOString() });
});

// Detecta pasta de build (por exemplo frontend/build) ou usa a pasta frontend bruta
const frontendBuildPath = path.join(__dirname, '..', 'frontend', 'build');
const frontendStaticPath = fs.existsSync(frontendBuildPath)
  ? frontendBuildPath
  : path.join(__dirname, '..', 'frontend');

// Detecta pasta de admin (pode ter um build também)
const adminBuildPath = path.join(__dirname, '..', 'admin', 'build');
const adminStaticPath = fs.existsSync(adminBuildPath)
  ? adminBuildPath
  : path.join(__dirname, '..', 'admin');

// Servir arquivos estáticos
app.use(express.static(frontendStaticPath));
app.use('/admin', express.static(adminStaticPath));

// Fallback para SPA do admin (serve index.html para /admin/*)
app.get('/admin/*', (req, res) => {
  const indexPath = path.join(adminStaticPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Admin frontend não encontrado');
  }
});

// Fallback geral para SPA do frontend (serve index.html para rotas não-API)
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    // Se chegou aqui para /api/* e não bateu em nenhuma rota, retorna 404 JSON
    return res.status(404).json({ error: 'Endpoint API não encontrado' });
  }
  const indexPath = path.join(frontendStaticPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Frontend não encontrado');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🏍️  Moto Conchal Backend rodando na porta ${PORT}`);
});
