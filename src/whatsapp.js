
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import { downloadMediaMessage } from '@whiskeysockets/baileys/lib/Utils/messages.js';

import { Boom } from '@hapi/boom';
import QRCode from 'qrcode';
import path from 'node:path';
import { createChatStore } from './chat-store.js';
import { createMessageSender } from './message-sender.js';

// ==========================================
// STORAGE
// ==========================================

const AUTH_FOLDER = path.resolve('auth_info');

const chatStore = createChatStore();
const pendingStickerDownloads = new Map();
const pendingContactLookups = new Map();
const contactLookupCache = new Map();
const MAX_STICKER_BYTES = 1024 * 1024;
const CONTACT_LOOKUP_TTL_MS = 5 * 60 * 1000;

let waStatus = {
  status: 'connecting',
  message: 'Menghubungkan...',
};

let waQr = null;
let reconnectTimer = null;
let waSocket = null;
let waIo = null;

// ==========================================
// HELPER
// ==========================================

function emitChats(io) {
  io.emit('wa:chats', chatStore.getChats());
}

function emitContacts(io) {
  io.emit('wa:contacts');
}

const sendMessage = createMessageSender({
  getSocket: () => waSocket,
  isConnected: () => waStatus.status === 'connected',
  onSent: (message) => {
    chatStore.addMessages([message]);
    if (waIo) emitChats(waIo);
  },
});

// ==========================================
// WHATSAPP CONNECTION
// ==========================================

export async function connectWhatsApp(io) {
  waIo = io;
  const { state, saveCreds } =
    await useMultiFileAuthState(AUTH_FOLDER);

  const sock = makeWASocket({
    auth: state,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
  waSocket = sock;

  sock.ev.on('creds.update', saveCreds);

  // ========================================
  // HISTORY SYNC
  // ========================================

  sock.ev.on(
    'messaging-history.set',
    (history) => {
      chatStore.setHistory(history);
      emitChats(io);
      emitContacts(io);

      console.log('History received:', {
        chats: chatStore.getChats().length,
        messages: history.messages?.length || 0,
      });
    }
  );

  // ========================================
  // NEW CHATS
  // ========================================

  sock.ev.on('chats.upsert', (newChats) => {
    chatStore.upsertChats(newChats);
    emitChats(io);
  });

  // ========================================
  // UPDATED CHATS
  // ========================================

  sock.ev.on('chats.update', (updatedChats) => {
    chatStore.updateChats(updatedChats);
    emitChats(io);
  });

  sock.ev.on('chats.delete', (deletedChatIds) => {
    chatStore.deleteChats(deletedChatIds);
    emitChats(io);
  });

  sock.ev.on('contacts.upsert', (newContacts) => {
    chatStore.updateContacts(newContacts);
    emitChats(io);
    emitContacts(io);
  });

  sock.ev.on('contacts.update', (updatedContacts) => {
    chatStore.updateContacts(updatedContacts);
    emitChats(io);
    emitContacts(io);
  });

  // ========================================
  // NEW MESSAGES
  // ========================================

  sock.ev.on('messages.upsert', ({ messages: newMessages, type, requestId }) => {
    chatStore.addMessages(newMessages, type === 'notify' && !requestId);
    emitChats(io);
  });

  sock.ev.on('messages.update', (updates) => {
    chatStore.updateMessages(updates);
    emitChats(io);
  });

  // ========================================
  // CONNECTION STATUS
  // ========================================

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (connection === 'connecting') {
      waStatus = {
        status: 'connecting',
        message: 'Menghubungkan ke WhatsApp...',
      };

      io.emit('wa:status', waStatus);
    }

    if (qr) {
      waQr = await QRCode.toDataURL(qr);

      waStatus = {
        status: 'qr',
        message: 'Silakan scan QR Code WhatsApp.',
      };

      io.emit('wa:qr', waQr);
      io.emit('wa:status', waStatus);
    }

    if (connection === 'open') {
      waQr = null;

      waStatus = {
        status: 'connected',
        message: 'WhatsApp berhasil terhubung!',
      };

      console.log('WhatsApp connected successfully.');

      io.emit('wa:qr', null);
      io.emit('wa:status', waStatus);

      emitChats(io);
    }

    if (connection === 'close') {
      if (waSocket === sock) {
        waSocket = null;
      }
      waQr = null;

      const errorCode = new Boom(lastDisconnect?.error)
        .output?.statusCode;

      const shouldReconnect =
        errorCode !== DisconnectReason.loggedOut;

      waStatus = {
        status: 'disconnected',
        message: shouldReconnect
          ? 'Koneksi terputus. Mencoba menghubungkan ulang...'
          : 'WhatsApp logout. Silakan tautkan ulang perangkat.',
      };

      console.log('WhatsApp disconnected:', errorCode);

      io.emit('wa:status', waStatus);
      io.emit('wa:qr', null);

      if (shouldReconnect && !reconnectTimer) {
        reconnectTimer = setTimeout(async () => {
          reconnectTimer = null;

          try {
            await connectWhatsApp(io);
          } catch (error) {
            console.error('Reconnect error:', error);
          }
        }, 3000);
      }
    }
  });

  return sock;
}

// ==========================================
// PUBLIC FUNCTIONS
// ==========================================

export function getWhatsAppStatus() {
  return waStatus;
}

export function getWhatsAppQR() {
  return waQr;
}

export function getChats() {
  return chatStore.getChats();
}

export function getMessages(jid) {
  return chatStore.getMessages(jid);
}

export async function searchWhatsAppContacts(query) {
  const searchTerm = String(query || '').trim();
  const localContacts = chatStore.getContacts(searchTerm);
  if (!/^[+\d\s().-]+$/.test(searchTerm)) return localContacts;

  const phoneNumber = searchTerm.replace(/\D/g, '');
  if (phoneNumber.length < 7 || phoneNumber.length > 20) return localContacts;

  const cachedLookup = contactLookupCache.get(phoneNumber);
  if (cachedLookup && cachedLookup.expiresAt > Date.now()) {
    return mergeContactResults(localContacts, cachedLookup.contacts);
  }
  if (cachedLookup) contactLookupCache.delete(phoneNumber);

  const socket = waSocket;
  if (!socket || waStatus.status !== 'connected') {
    if (localContacts.length) return localContacts;
    const error = new Error('WhatsApp harus terhubung untuk mencari nomor baru.');
    error.code = 'WHATSAPP_DISCONNECTED';
    throw error;
  }

  let lookup = pendingContactLookups.get(phoneNumber);
  if (!lookup) {
    lookup = socket.onWhatsApp(phoneNumber).then((matches) => {
      const contacts = (matches || [])
        .filter((match) => match.exists && match.jid)
        .map((match) => ({
          id: match.jid,
          phoneNumber: match.jid.split('@')[0],
        }));

      chatStore.updateContacts(contacts);
      contactLookupCache.set(phoneNumber, {
        contacts,
        expiresAt: Date.now() + CONTACT_LOOKUP_TTL_MS,
      });
      while (contactLookupCache.size > 200) {
        contactLookupCache.delete(contactLookupCache.keys().next().value);
      }
      return contacts;
    });
    pendingContactLookups.set(phoneNumber, lookup);
  }

  try {
    const lookedUpContacts = await lookup;
    return mergeContactResults(localContacts, lookedUpContacts);
  } finally {
    if (pendingContactLookups.get(phoneNumber) === lookup) {
      pendingContactLookups.delete(phoneNumber);
    }
  }
}

function mergeContactResults(first, second) {
  const contacts = new Map(first.map((contact) => [contact.id, contact]));
  for (const contact of second) {
    contacts.set(contact.id, {
      ...contact,
      ...contacts.get(contact.id),
    });
  }
  return Array.from(contacts.values());
}

export function createWhatsAppChat(jid) {
  const chat = chatStore.ensureChatForContact(jid);
  if (chat && waIo) emitChats(waIo);
  return chat;
}

export async function getWhatsAppSticker(jid, messageId) {
  const cachedMedia = chatStore.getStickerMedia(jid, messageId);
  if (cachedMedia) return cachedMedia;

  const message = chatStore.getStickerMessage(jid, messageId);
  if (!message) return null;

  const key = `${jid}\n${messageId}`;
  if (pendingStickerDownloads.has(key)) {
    return pendingStickerDownloads.get(key);
  }

  const download = (async () => {
    const stream = await downloadMediaMessage(message, 'stream', {});
    const chunks = [];
    let totalBytes = 0;

    for await (const chunk of stream) {
      totalBytes += chunk.length;
      if (totalBytes > MAX_STICKER_BYTES) {
        stream.destroy();
        const error = new Error('Sticker exceeds the allowed size.');
        error.code = 'STICKER_TOO_LARGE';
        throw error;
      }
      chunks.push(chunk);
    }

    const media = Buffer.concat(chunks, totalBytes);
    chatStore.cacheStickerMedia(jid, messageId, media);
    return media;
  })();

  pendingStickerDownloads.set(key, download);
  try {
    return await download;
  } finally {
    pendingStickerDownloads.delete(key);
  }
}

export function sendWhatsAppMessage(jid, text, requestId) {
  return sendMessage(jid, text, requestId);
}

export function sendWhatsAppImage(jid, image, mimetype, caption, requestId) {
  return sendMessage(jid, { image, mimetype, caption }, requestId);
}
