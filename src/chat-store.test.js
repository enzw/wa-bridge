import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatStore } from './chat-store.js';

const directJid = '6281234567890@s.whatsapp.net';

function textMessage(id, jid, timestamp, text, fromMe = false) {
  return {
    key: { id, remoteJid: jid, fromMe },
    messageTimestamp: timestamp,
    message: { conversation: text },
  };
}

test('history builds named, sorted chat summaries with phone fallback', () => {
  const store = createChatStore();
  store.setHistory({
    chats: [
      { id: directJid, unreadCount: 2, conversationTimestamp: 12 },
      { id: '6281000000000@s.whatsapp.net', conversationTimestamp: 20 },
    ],
    contacts: [{ id: directJid, name: 'Rina', phoneNumber: '6281234567890' }],
    messages: [
      textMessage('old', directJid, 10, 'Pesan lama'),
      textMessage('latest', directJid, 12, 'Pesan terbaru'),
    ],
  });

  assert.deepEqual(
    store.getChats().map((chat) => chat.id),
    ['6281000000000@s.whatsapp.net', directJid]
  );
  assert.equal(store.getChats()[1].name, 'Rina');
  assert.equal(store.getChats()[1].phoneNumber, '6281234567890');
  assert.equal(store.getChats()[1].lastMessage, 'Pesan terbaru');
  assert.equal(store.getChats()[1].unreadCount, 2);
  assert.deepEqual(
    store.getMessages(directJid).map((message) => message.id),
    ['old', 'latest']
  );
});

test('contacts can be searched and started without an existing chat', () => {
  const store = createChatStore();
  store.updateContacts([
    {
      id: directJid,
      name: 'Rina Putri',
      phoneNumber: directJid,
    },
    {
      id: '6281000000000@s.whatsapp.net',
      notify: 'Budi',
    },
  ]);

  const rina = store.getContacts('rina');
  assert.deepEqual(rina.map((contact) => contact.id), [directJid]);
  assert.equal(rina[0].phoneNumber, '6281234567890');
  assert.deepEqual(store.getContacts('62810').map((contact) => contact.id), [
    '6281000000000@s.whatsapp.net',
  ]);
  assert.equal(store.getChats().length, 0);

  const chat = store.ensureChatForContact(directJid);
  assert.equal(chat.name, 'Rina Putri');
  assert.equal(store.getChats().length, 1);
  assert.equal(store.ensureChatForContact('unknown@s.whatsapp.net'), null);
});

test('new messages update previews, count live unread messages once, and retain media captions', () => {
  const store = createChatStore();
  store.upsertChats([{ id: directJid, name: 'Rina', unreadCount: 0 }]);
  const latest = textMessage('new', directJid, 30, 'Halo');

  store.addMessages([latest], true);
  store.addMessages([latest], true);
  store.addMessages([
    {
      key: { id: 'image', remoteJid: directJid, fromMe: false },
      messageTimestamp: 31,
      message: { imageMessage: { caption: 'Foto acara' } },
    },
  ], true);

  const chat = store.getChats()[0];
  assert.equal(chat.lastMessage, 'Foto acara');
  assert.equal(chat.lastMessageTimestamp, 31);
  assert.equal(chat.unreadCount, 2);
  assert.equal(store.getMessages(directJid).length, 2);
  assert.equal(store.getMessages(directJid)[1].type, 'image');
});

test('older messages do not replace the current preview and deleted chats remove history', () => {
  const store = createChatStore();
  store.addMessages([textMessage('newest', directJid, 50, 'Terbaru')]);
  store.addMessages([textMessage('older', directJid, 40, 'Lebih lama')]);

  assert.equal(store.getChats()[0].lastMessage, 'Terbaru');
  store.deleteChats([directJid]);
  assert.equal(store.getChats().length, 0);
  assert.equal(store.getMessages(directJid).length, 0);
});

test('message status updates are reflected in the stored conversation', () => {
  const store = createChatStore();
  store.addMessages([
    {
      ...textMessage('outgoing', directJid, 60, 'Terkirim', true),
      status: 1,
    },
  ]);

  store.updateMessages([
    {
      key: { id: 'outgoing', remoteJid: directJid },
      update: { status: 4 },
    },
  ]);

  assert.equal(store.getMessages(directJid)[0].status, 4);
});

test('sticker messages retain their media source and cached data until chat deletion', () => {
  const store = createChatStore();
  const sticker = {
    key: { id: 'sticker-1', remoteJid: directJid, fromMe: false },
    messageTimestamp: 70,
    message: { stickerMessage: { mimetype: 'image/webp' } },
  };

  store.addMessages([sticker]);

  assert.equal(store.getMessages(directJid)[0].type, 'sticker');
  assert.equal(store.getStickerMessage(directJid, 'sticker-1'), sticker);

  const media = Buffer.from('webp data');
  store.cacheStickerMedia(directJid, 'sticker-1', media);
  assert.deepEqual(store.getStickerMedia(directJid, 'sticker-1'), media);

  store.deleteChats([directJid]);
  assert.equal(store.getStickerMessage(directJid, 'sticker-1'), null);
  assert.equal(store.getStickerMedia(directJid, 'sticker-1'), null);
});
