# Nexus Captura para Windows

Este programa precisa ser baixado e instalado no computador da loja. Ele fica em segundo plano e observa uma pasta de cupons.

## Gerar o instalador

```powershell
npm install
npm run build
```

O instalador fica em `dist/`.

## Configurar a loja

1. No painel Nexus, escolha **Programa Nexus Captura no Windows**.
2. Salve e gere uma chave.
3. Abra o Nexus Captura, informe o WhatsApp da empresa e a chave.
4. Escolha a pasta onde o BeeFood salva/imprime os cupons em TXT, PRN ou PDF.

## Limite do spooler

A fila nativa do Windows pode armazenar a impressao como EMF/imagem sem texto extraivel. Por isso, o modo confiavel usa uma pasta de impressao em PDF/TXT. Arquivos SPL/PRN com texto tambem sao aceitos, mas sao experimentais.
