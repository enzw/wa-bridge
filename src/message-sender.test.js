import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageSender } from './message-sender.js';

test('a repeated send request uses one Baileys send and returns the same message', async () => {
  let sendCount = 0;
  const sentMessage = { key: { id: 'message-1' } };
  const send = createMessageSender({
    getSocket: () => ({
      sendMessage: async (jid, content) => {
        sendCount += 1;
        assert.equal(jid, '123@s.whatsapp.net');
        assert.equal(content.text, 'Halo');
        return sentMessage;
      },
    }),
    isConnected: () => true,
    onSent: () => {},
  });

  const [first, repeated] = await Promise.all([
    send('123@s.whatsapp.net', 'Halo', 'request-123456'),
    send('123@s.whatsapp.net', 'Halo', 'request-123456'),
  ]);

  assert.equal(sendCount, 1);
  assert.equal(first, sentMessage);
  assert.equal(repeated, sentMessage);
});

test('a repeated image request sends one image and rejects changed image content', async () => {
  let sendCount = 0;
  const image = Buffer.from('photo bytes');
  const send = createMessageSender({
    getSocket: () => ({
      sendMessage: async (jid, content) => {
        sendCount += 1;
        assert.equal(jid, '123@s.whatsapp.net');
        assert.deepEqual(content.image, image);
        assert.equal(content.mimetype, 'image/jpeg');
        assert.equal(content.caption, 'Liburan');
        return { key: { id: 'image-1' } };
      },
    }),
    isConnected: () => true,
    onSent: () => {},
  });

  const [first, repeated] = await Promise.all([
    send(
      '123@s.whatsapp.net',
      { image, mimetype: 'image/jpeg', caption: 'Liburan' },
      'image-request-1'
    ),
    send(
      '123@s.whatsapp.net',
      { image, mimetype: 'image/jpeg', caption: 'Liburan' },
      'image-request-1'
    ),
  ]);

  assert.equal(sendCount, 1);
  assert.equal(first, repeated);
  await assert.rejects(
    send('123@s.whatsapp.net', {
      image: Buffer.from('different photo'),
      mimetype: 'image/jpeg',
      caption: 'Liburan',
    }, 'image-request-1'),
    { code: 'IDEMPOTENCY_CONFLICT' }
  );
});

test('reusing a request id for different content is rejected', async () => {
  const send = createMessageSender({
    getSocket: () => ({ sendMessage: async () => ({ key: { id: 'message-1' } }) }),
    isConnected: () => true,
    onSent: () => {},
  });

  await send('123@s.whatsapp.net', 'Halo', 'request-123456');
  await assert.rejects(
    send('123@s.whatsapp.net', 'Teks berbeda', 'request-123456'),
    { code: 'IDEMPOTENCY_CONFLICT' }
  );
});

test('disconnected sends fail before entering the idempotency cache', async () => {
  let connected = false;
  const send = createMessageSender({
    getSocket: () => ({ sendMessage: async () => ({ key: { id: 'message-1' } }) }),
    isConnected: () => connected,
    onSent: () => {},
  });

  await assert.rejects(
    send('123@s.whatsapp.net', 'Halo', 'request-123456'),
    { code: 'WHATSAPP_DISCONNECTED' }
  );

  connected = true;
  const message = await send('123@s.whatsapp.net', 'Halo', 'request-123456');
  assert.equal(message.key.id, 'message-1');
});
