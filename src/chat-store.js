function toTimestamp(value) {
  const timestamp = Number(value || 0);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function getMessageContent(message) {
  const wrapper = message?.message;
  const content =
    wrapper?.ephemeralMessage?.message ||
    wrapper?.viewOnceMessage?.message ||
    wrapper?.viewOnceMessageV2?.message ||
    wrapper;

  if (!content) return null;
  if (content.conversation || content.extendedTextMessage?.text) {
    return {
      type: 'text',
      text: content.conversation || content.extendedTextMessage.text,
    };
  }
  if (content.imageMessage) {
    return { type: 'image', text: content.imageMessage.caption || '[Gambar]' };
  }
  if (content.videoMessage) {
    return { type: 'video', text: content.videoMessage.caption || '[Video]' };
  }
  if (content.documentMessage) {
    return {
      type: 'document',
      text: content.documentMessage.caption || content.documentMessage.fileName || '[Dokumen]',
    };
  }
  if (content.audioMessage) return { type: 'audio', text: '[Pesan audio]' };
  if (content.stickerMessage) return { type: 'sticker', text: '[Stiker]' };
  return { type: 'other', text: '[Pesan media atau lainnya]' };
}

export function createChatStore() {
  const chats = new Map();
  const messages = new Map();
  const contacts = new Map();
  const stickerMessages = new Map();
  const stickerMedia = new Map();
  let stickerMediaBytes = 0;
  const MAX_STICKER_CACHE_BYTES = 16 * 1024 * 1024;

  function stickerCacheKey(jid, messageId) {
    return `${jid}\n${messageId}`;
  }

  function getContactName(jid) {
    const contact = contacts.get(jid);
    return contact?.name || contact?.notify || contact?.verifiedName || '';
  }

  function getPhoneNumber(jid) {
    const contact = contacts.get(jid);
    if (contact?.phoneNumber) {
      return contact.phoneNumber.endsWith('@s.whatsapp.net')
        ? contact.phoneNumber.slice(0, -'@s.whatsapp.net'.length)
        : contact.phoneNumber;
    }
    if (jid && jid.endsWith('@s.whatsapp.net')) {
      return jid.slice(0, -'@s.whatsapp.net'.length);
    }
    return '';
  }

  function upsertChat(jid, update) {
    if (!jid) return;

    const existing = chats.get(jid) || {};
    const contactName = getContactName(jid);
    const name =
      (typeof update.name === 'string' && update.name.trim()) ||
      existing.name ||
      contactName;
    const incomingUnreadCount =
      update.unreadCount == null ? existing.unreadCount : Number(update.unreadCount);

    chats.set(jid, {
      id: jid,
      name: name || '',
      phoneNumber: getPhoneNumber(jid),
      unreadCount: Number.isFinite(incomingUnreadCount) ? incomingUnreadCount : 0,
      lastMessage: existing.lastMessage || '',
      lastMessageTimestamp: Math.max(
        toTimestamp(existing.lastMessageTimestamp),
        toTimestamp(update.conversationTimestamp),
        toTimestamp(update.lastMessageRecvTimestamp)
      ),
    });
  }

  function addMessage(message, countUnread) {
    const jid = message.key?.remoteJid;
    const content = getMessageContent(message);
    if (!jid || !content) return;

    const item = {
      id: message.key.id || '',
      fromMe: Boolean(message.key.fromMe),
      senderName: message.pushName || '',
      type: content.type,
      text: content.text,
      timestamp: toTimestamp(message.messageTimestamp),
      status: message.status == null ? null : Number(message.status),
    };

    if (!messages.has(jid)) {
      messages.set(jid, []);
    }

    const chatMessages = messages.get(jid);
    if (item.id && chatMessages.some((msg) => msg.id === item.id)) {
      return;
    }
    chatMessages.push(item);

    if (item.type === 'sticker' && item.id) {
      if (!stickerMessages.has(jid)) stickerMessages.set(jid, new Map());
      stickerMessages.get(jid).set(item.id, message);
    }

    const existingChat = chats.get(jid) || {};
    const isDirectChat = !jid.endsWith('@g.us');
    const nextChat = {
      ...existingChat,
      id: jid,
      name: existingChat.name || (isDirectChat ? message.pushName : '') || getContactName(jid),
      phoneNumber: getPhoneNumber(jid),
      unreadCount:
        toTimestamp(existingChat.unreadCount) +
        (countUnread && !item.fromMe ? 1 : 0),
    };

    if (
      !existingChat.lastMessage ||
      item.timestamp >= toTimestamp(existingChat.lastMessageTimestamp)
    ) {
      nextChat.lastMessage = item.text;
      nextChat.lastMessageTimestamp = Math.max(
        item.timestamp,
        toTimestamp(existingChat.lastMessageTimestamp)
      );
    }

    chats.set(jid, nextChat);
  }

  function updateContacts(contactUpdates) {
    for (const contact of contactUpdates || []) {
      if (!contact.id) continue;

      contacts.set(contact.id, {
        ...contacts.get(contact.id),
        ...contact,
      });

      if (chats.has(contact.id)) {
        upsertChat(contact.id, { name: getContactName(contact.id) });
      }
    }
  }

  return {
    setHistory({ chats: historyChats, contacts: historyContacts, messages: historyMessages }) {
      updateContacts(historyContacts);
      for (const chat of historyChats || []) {
        upsertChat(chat.id, chat);
      }
      for (const message of historyMessages || []) {
        addMessage(message, false);
      }
    },

    upsertChats(chatUpdates) {
      for (const chat of chatUpdates || []) {
        upsertChat(chat.id, chat);
      }
    },

    updateChats(chatUpdates) {
      for (const chat of chatUpdates || []) {
        upsertChat(chat.id, chat);
      }
    },

    deleteChats(chatIds) {
      for (const jid of chatIds || []) {
        chats.delete(jid);
        messages.delete(jid);
        stickerMessages.delete(jid);

        const keyPrefix = `${jid}\n`;
        for (const [key, media] of stickerMedia) {
          if (key.indexOf(keyPrefix) !== 0) continue;
          stickerMediaBytes -= media.length;
          stickerMedia.delete(key);
        }
      }
    },

    updateContacts,

    addMessages(newMessages, countUnread = false) {
      for (const message of newMessages || []) {
        addMessage(message, countUnread);
      }
    },

    updateMessages(updates) {
      for (const item of updates || []) {
        const jid = item.key?.remoteJid;
        const messageId = item.key?.id;
        if (!jid || !messageId || item.update?.status == null) continue;

        const chatMessages = messages.get(jid);
        if (!chatMessages) continue;

        for (const message of chatMessages) {
          if (message.id === messageId) {
            message.status = Number(item.update.status);
            break;
          }
        }
      }
    },

    getChats() {
      return Array.from(chats.values()).sort(
        (first, second) =>
          toTimestamp(second.lastMessageTimestamp) -
          toTimestamp(first.lastMessageTimestamp)
      );
    },

    getMessages(jid) {
      return (messages.get(jid) || [])
        .slice()
        .sort((first, second) => first.timestamp - second.timestamp);
    },

    getContacts(query = '') {
      const searchTerm = String(query).trim().toLowerCase();
      const searchDigits = searchTerm.replace(/\D/g, '');
      const results = [];

      for (const [jid, contact] of contacts) {
        if (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@lid')) continue;

        const name = getContactName(jid);
        const phoneNumber = getPhoneNumber(jid);
        const matches =
          !searchTerm ||
          name.toLowerCase().includes(searchTerm) ||
          phoneNumber.toLowerCase().includes(searchTerm) ||
          (searchDigits && phoneNumber.replace(/\D/g, '').includes(searchDigits));
        if (!matches) continue;

        results.push({
          id: jid,
          name,
          phoneNumber,
        });
      }

      return results.sort((first, second) =>
        (first.name || first.phoneNumber).localeCompare(second.name || second.phoneNumber)
      );
    },

    ensureChatForContact(jid) {
      if (!contacts.has(jid)) return null;
      upsertChat(jid, { name: getContactName(jid) });
      return chats.get(jid);
    },

    getStickerMessage(jid, messageId) {
      return stickerMessages.get(jid)?.get(messageId) || null;
    },

    getStickerMedia(jid, messageId) {
      return stickerMedia.get(stickerCacheKey(jid, messageId)) || null;
    },

    cacheStickerMedia(jid, messageId, media) {
      const key = stickerCacheKey(jid, messageId);
      const previous = stickerMedia.get(key);
      if (previous) {
        stickerMediaBytes -= previous.length;
        stickerMedia.delete(key);
      }

      if (media.length > MAX_STICKER_CACHE_BYTES) return;

      stickerMedia.set(key, media);
      stickerMediaBytes += media.length;

      while (stickerMediaBytes > MAX_STICKER_CACHE_BYTES) {
        const oldestKey = stickerMedia.keys().next().value;
        const oldestMedia = stickerMedia.get(oldestKey);
        stickerMediaBytes -= oldestMedia.length;
        stickerMedia.delete(oldestKey);
      }
    },
  };
}
