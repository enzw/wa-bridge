import { createHash } from 'node:crypto';

const REQUEST_TTL_MS = 10 * 60 * 1000;

function createError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function createMessageSender({ getSocket, isConnected, onSent }) {
  const requests = new Map();

  function getContentDetails(content) {
    if (typeof content === 'string') {
      return {
        fingerprint: `text:${content}`,
        baileysContent: { text: content },
      };
    }

    if (content && Buffer.isBuffer(content.image)) {
      const digest = createHash('sha256').update(content.image).digest('hex');
      return {
        fingerprint: `${content.mimetype || ''}:image:${digest}:${content.caption || ''}`,
        baileysContent: content,
      };
    }

    throw createError('INVALID_MESSAGE_CONTENT', 'Jenis pesan tidak didukung.');
  }

  function removeExpiredRequests() {
    const expiresBefore = Date.now() - REQUEST_TTL_MS;
    for (const [requestId, request] of requests) {
      if (request.completed && request.createdAt < expiresBefore) {
        requests.delete(requestId);
      }
    }
  }

  return async function sendMessage(jid, content, requestId) {
    removeExpiredRequests();

    const details = getContentDetails(content);
    const existing = requests.get(requestId);
    if (existing) {
      if (existing.jid !== jid || existing.fingerprint !== details.fingerprint) {
        throw createError(
          'IDEMPOTENCY_CONFLICT',
          'ID permintaan ini sudah digunakan untuk pesan lain.'
        );
      }
      return existing.promise;
    }

    const socket = getSocket();
    if (!socket || !isConnected()) {
      throw createError('WHATSAPP_DISCONNECTED', 'WhatsApp belum terhubung.');
    }

    const request = {
      jid,
      fingerprint: details.fingerprint,
      createdAt: Date.now(),
      completed: false,
      promise: null,
    };

    request.promise = Promise.resolve()
      .then(() => {
        const baileysContent = details.baileysContent;
        details.baileysContent = null;
        return socket.sendMessage(jid, baileysContent);
      })
      .then((message) => {
        if (!message) {
          throw createError('MESSAGE_SEND_FAILED', 'Baileys tidak mengembalikan pesan terkirim.');
        }
        onSent(message);
        return message;
      });

    request.promise.then(
      () => {
        request.completed = true;
      },
      () => {
        request.completed = true;
      }
    );
    requests.set(requestId, request);

    return request.promise;
  };
}
