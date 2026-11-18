
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuth } from './auth.js';
import { detectImageMimeType } from './image-utils.js';

import {
  connectWhatsApp,
  getMessages,
  getChats,
  searchWhatsAppContacts,
  createWhatsAppChat,
  getWhatsAppStatus,
  getWhatsAppQR,
  getWhatsAppSticker,
  sendWhatsAppImage,
  sendWhatsAppMessage,
} from './whatsapp.js';

// ==========================================
// CONFIGURATION
// ==========================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const auth = createAuth(
  process.env.WA_PIN,
  process.env.COOKIE_SECURE === 'true'
);

const PORT = 3000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const imageBodyParser = express.raw({
  type: 'application/octet-stream',
  limit: MAX_IMAGE_BYTES,
});

function parseImageBody(request, response, next) {
  imageBodyParser(request, response, (error) => {
    if (!error) {
      next();
      return;
    }

    if (error.type === 'entity.too.large') {
      response.status(413).json({ error: 'Ukuran foto maksimal 8 MB.' });
      return;
    }

    console.error('Image upload body parsing failed:', error);
    response.status(400).json({ error: 'Data foto tidak valid.' });
  });
}

// ==========================================
// STATIC FILES
// ==========================================

app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json({ limit: '70kb' }));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// ==========================================
// API
// ==========================================

app.post('/api/auth/login', auth.ensureSameOrigin, (req, res) => {
  auth.login(req, res);
});

app.get('/api/auth/session', (req, res) => {
  auth.sessionStatus(req, res);
});

app.post('/api/auth/logout', auth.ensureSameOrigin, (req, res) => {
  const token = auth.revokeSession(req, res);

  if (token) {
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.sessionToken === token) {
        socket.disconnect(true);
      }
    }
  }

  res.json({ authenticated: false });
});

app.use(auth.requireAuth);

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'WhatsApp Bridge Server is running',
  });
});

app.get('/api/status', (req, res) => {
  res.json(getWhatsAppStatus());
});

app.get('/api/chats', (req, res) => {
  res.json(getChats());
});

app.get('/api/contacts/search', async (req, res) => {
  const query = req.query.q;
  if (typeof query !== 'string' || query.length > 100) {
    res.status(400).json({ error: 'Pencarian kontak tidak valid.' });
    return;
  }

  try {
    res.json(await searchWhatsAppContacts(query));
  } catch (error) {
    if (error.code === 'WHATSAPP_DISCONNECTED') {
      res.status(503).json({ error: error.message });
      return;
    }

    console.error('WhatsApp contact search failed:', error);
    res.status(502).json({ error: 'Pencarian kontak gagal. Coba lagi.' });
  }
});

app.post('/api/chats', auth.ensureSameOrigin, (req, res) => {
  const { jid } = req.body || {};
  if (typeof jid !== 'string' || !jid) {
    res.status(400).json({ error: 'Kontak tidak valid.' });
    return;
  }

  const chat = createWhatsAppChat(jid);
  if (!chat) {
    res.status(404).json({ error: 'Kontak tidak ditemukan.' });
    return;
  }

  res.json(chat);
});

app.get('/api/messages/:jid', (req, res) => {
  const jid = req.params.jid;

  res.json(getMessages(jid));
});

app.get('/api/messages/:jid/:messageId/sticker', async (req, res) => {
  try {
    const media = await getWhatsAppSticker(req.params.jid, req.params.messageId);
    if (!media) {
      res.status(404).json({ error: 'Stiker tidak ditemukan.' });
      return;
    }

    res.type('image/webp').send(media);
  } catch (error) {
    if (error.code === 'STICKER_TOO_LARGE') {
      res.status(413).json({ error: 'Ukuran stiker melebihi batas.' });
      return;
    }

    console.error('WhatsApp sticker download failed:', error);
    res.status(502).json({ error: 'Stiker tidak dapat dimuat.' });
  }
});

app.post(
  '/api/messages/:jid/image',
  auth.ensureSameOrigin,
  parseImageBody,
  async (req, res) => {
    const jid = req.params.jid;
    const image = req.body;
    const { caption } = req.query;
    const clientMessageId = req.get('X-Client-Message-Id');

    if (!getChats().some((chat) => chat.id === jid)) {
      res.status(404).json({ error: 'Percakapan tidak ditemukan.' });
      return;
    }

    if (!Buffer.isBuffer(image) || !image.length) {
      res.status(400).json({ error: 'Pilih foto yang valid.' });
      return;
    }

    const mimetype = detectImageMimeType(image);
    if (!mimetype) {
      res.status(415).json({ error: 'Format foto harus JPEG, PNG, atau WebP.' });
      return;
    }

    if (
      caption !== undefined &&
      (typeof caption !== 'string' || Buffer.byteLength(caption, 'utf8') > 4096)
    ) {
      res.status(400).json({ error: 'Caption foto maksimal 4096 byte.' });
      return;
    }

    if (
      typeof clientMessageId !== 'string' ||
      !/^[A-Za-z0-9_-]{8,100}$/.test(clientMessageId)
    ) {
      res.status(400).json({ error: 'ID pengiriman tidak valid.' });
      return;
    }

    try {
      const message = await sendWhatsAppImage(
        jid,
        image,
        mimetype,
        caption || '',
        clientMessageId
      );
      res.json({
        sent: true,
        message: {
          id: message.key.id,
          timestamp: Number(message.messageTimestamp || Math.floor(Date.now() / 1000)),
          status: message.status == null ? null : Number(message.status),
        },
      });
    } catch (error) {
      if (error.code === 'WHATSAPP_DISCONNECTED') {
        res.status(503).json({ error: 'WhatsApp belum terhubung. Foto belum dikirim.' });
        return;
      }

      if (error.code === 'IDEMPOTENCY_CONFLICT') {
        res.status(409).json({ error: error.message });
        return;
      }

      console.error('WhatsApp image send failed:', error);
      res.status(502).json({
        error: 'Pengiriman foto belum terkonfirmasi. Periksa percakapan sebelum mencoba lagi.',
      });
    }
  }
);

app.post('/api/messages/:jid', auth.ensureSameOrigin, async (req, res) => {
  const jid = req.params.jid;
  const { text, clientMessageId } = req.body || {};

  if (!getChats().some((chat) => chat.id === jid)) {
    res.status(404).json({ error: 'Percakapan tidak ditemukan.' });
    return;
  }

  if (typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: 'Pesan tidak boleh kosong.' });
    return;
  }

  if (Buffer.byteLength(text, 'utf8') > 65536) {
    res.status(413).json({ error: 'Pesan terlalu panjang.' });
    return;
  }

  if (
    typeof clientMessageId !== 'string' ||
    !/^[A-Za-z0-9_-]{8,100}$/.test(clientMessageId)
  ) {
    res.status(400).json({ error: 'ID pengiriman tidak valid.' });
    return;
  }

  try {
    const message = await sendWhatsAppMessage(jid, text, clientMessageId);
    res.json({
      sent: true,
      message: {
        id: message.key.id,
        timestamp: Number(message.messageTimestamp || Math.floor(Date.now() / 1000)),
        status: message.status == null ? null : Number(message.status),
      },
    });
  } catch (error) {
    if (error.code === 'WHATSAPP_DISCONNECTED') {
      res.status(503).json({ error: 'WhatsApp belum terhubung. Pesan belum dikirim.' });
      return;
    }

    if (error.code === 'IDEMPOTENCY_CONFLICT') {
      res.status(409).json({ error: error.message });
      return;
    }

    console.error('WhatsApp send failed:', error);
    res.status(502).json({
      error: 'Pengiriman belum terkonfirmasi. Periksa percakapan sebelum mencoba lagi.',
    });
  }
});

// ==========================================
// SOCKET.IO
// ==========================================

io.use(auth.socketAuth);

io.on('connection', (socket) => {
  const session = auth.getSessionForSocket(socket);
  if (!session) {
    socket.disconnect(true);
    return;
  }

  const sessionTimer = setTimeout(() => {
    socket.disconnect(true);
  }, session.expiresAt - Date.now());
  socket.on('disconnect', () => clearTimeout(sessionTimer));

  console.log('Browser connected:', socket.id);

  // Kirim status terbaru ketika browser terhubung.
  socket.emit('wa:status', getWhatsAppStatus());

  // Kirim QR jika masih dalam proses pairing.
  socket.emit('wa:qr', getWhatsAppQR());

  // Kirim daftar chat terbaru.
  socket.emit('wa:chats', getChats());
});

// ==========================================
// START SERVER
// ==========================================

httpServer.listen(PORT, '0.0.0.0', async () => {
  console.log(`Server: http://127.0.0.1:${PORT}`);

  try {
    await connectWhatsApp(io);
  } catch (error) {
    console.error('WhatsApp initialization error:', error);
  }
});
