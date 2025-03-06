 navegador:

http://localhost:3000/session/meu_numero/qrcode

Ou via `curl` se preferir JSON:

curl http://localhost:3000/session/meu_numero/qrcode

---

### 4️⃣ Enviar mensagem via sessão criada

curl -X POST http://localhost:3000/session/meu_numero/send-message
    -H "Content-Type: application/json"
    -d '{"number":"5511999999999","message":"Olá, esta é uma mensagem do bot!"}'

---

### 5️⃣ Listar todas as sessões ativas (números conectados)

curl http://localhost:3000/sessions

---

### 6️⃣ Remover sessão (logout e apagar cache)

curl -X DELETE http://localhost:3000/session/meu_numero

---

## 🔧 Configurações no Dockerfile

O `Dockerfile` usa a imagem oficial do Puppeteer, garantindo que o Chromium e todas as dependências necessárias já estejam instaladas.

### Exemplo de Dockerfile

FROM ghcr.io/puppeteer/puppeteer:latest

WORKDIR /usr/src/app

RUN npm init -y
RUN npm install express whatsapp-web.js qrcode puppeteer

COPY ./src ./src

WORKDIR /usr/src/app/src

EXPOSE 3000

CMD ["node", "index.js"]

---

## ⚠️ Observações importantes

* O diretório `sessions` é mapeado para persistir o login de cada número.
* Se você remover o diretório `sessions`, todos os números serão deslogados.
* Apenas números que já conversaram com o seu bot podem receber mensagens (limitação do WhatsApp).

---

## 📦 Requisitos para rodar fora do Docker (opcional)

Se quiser rodar direto na sua máquina:

### 1️⃣ Instale dependências

npm install express whatsapp-web.js qrcode puppeteer

### 2️⃣ Crie a pasta `sessions`

mkdir -p sessions

### 3️⃣ Rode o app

node src/index.js

---

## 🚀 Roadmap futuro (sugestões)

✅ Adicionar logs persistentes.
✅ Melhorar autenticação via token para proteger a API.
✅ Adicionar suporte para envio de mídia (imagens, áudios, etc).
✅ Criar painel web para gerenciamento visual das sessões.

---

## 🧑‍💻 Contribuição

Sinta-se à vontade para clonar, abrir PRs ou sugerir melhorias.

---

## 📄 Licença

Este projeto é open-source sob a licença MIT.

---

### Criado com ❤️ por LeossTech

---
