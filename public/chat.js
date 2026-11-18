(function () {
  var workspace = document.getElementById('chat-workspace');
  var chatList = document.getElementById('chat-list');
  var chatListMessage = document.getElementById('chat-list-message');
  var chatSearch = document.getElementById('chat-search');
  var detailView = document.getElementById('chat-detail-view');
  var emptyDetail = document.getElementById('chat-empty');
  var conversation = document.getElementById('chat-conversation');
  var detailAvatar = document.getElementById('detail-avatar');
  var detailName = document.getElementById('detail-name');
  var detailNumber = document.getElementById('detail-number');
  var messageList = document.getElementById('message-list');
  var backButton = document.getElementById('back-to-chats');
  var messageForm = document.getElementById('message-form');
  var messageInput = document.getElementById('message-input');
  var photoInput = document.getElementById('photo-input');
  var photoButton = document.getElementById('photo-button');
  var sendButton = document.getElementById('send-button');
  var sendStatus = document.getElementById('send-status');
  var chats = [];
  var contactSearchResults = [];
  var activeChat = null;
  var socket = null;
  var chatsListener = null;
  var contactsListener = null;
  var messageRequestId = 0;
  var chatListRevision = 0;
  var contactSearchRequestId = 0;
  var contactOpenRequestId = 0;
  var contactSearchTimer = null;
  var contactSearchLoading = false;
  var contactSearchError = '';
  var pendingSend = null;
  var pendingImageSend = null;
  var sending = false;
  var stickerImageChatId = null;
  var stickerImageCache = Object.create(null);

  function request(method, url, body, callback) {
    var xhr = new XMLHttpRequest();
    var completed = false;

    xhr.open(method, url, true);
    xhr.setRequestHeader('Accept', 'application/json');
    if (body !== null) {
      xhr.setRequestHeader('Content-Type', 'application/json');
    }

    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4 || completed) return;
      completed = true;

      var response;
      try {
        response = xhr.responseText ? JSON.parse(xhr.responseText) : {};
      } catch (error) {
        callback(new Error('Respons server tidak valid.'), null, xhr.status);
        return;
      }

      if (xhr.status < 200 || xhr.status >= 300) {
        callback(
          new Error(response.error || 'Permintaan gagal (' + xhr.status + ').'),
          response,
          xhr.status
        );
        return;
      }

      callback(null, response, xhr.status);
    };
    xhr.onerror = function () {
      if (completed) return;
      completed = true;
      callback(new Error('Server tidak dapat dijangkau.'), null, 0);
    };
    xhr.send(body === null ? null : JSON.stringify(body));
  }

  function formatChatId(jid) {
    return String(jid || '')
      .replace(/@s\.whatsapp\.net$/, '')
      .replace(/@g\.us$/, '');
  }

  function getChatName(chat) {
    if (chat.name && chat.name !== chat.id) return chat.name;
    return chat.phoneNumber || formatChatId(chat.id) || 'Kontak';
  }

  function initials(name) {
    var parts = String(name || '?').split(/\s+/);
    if (parts.length > 1) {
      return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
    }
    return name.substring(0, 2).toUpperCase();
  }

  function formatTime(value) {
    var timestamp = Number(value || 0);
    if (!timestamp) return '';

    var date = new Date(timestamp * 1000);
    if (isNaN(date.getTime())) return '';

    var now = new Date();
    var hours = date.getHours();
    var minutes = date.getMinutes();
    var time = (hours < 10 ? '0' : '') + hours + ':' +
      (minutes < 10 ? '0' : '') + minutes;

    if (
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate()
    ) {
      return time;
    }

    return date.getDate() + '/' + (date.getMonth() + 1);
  }

  function createElement(tagName, className, text) {
    var element = document.createElement(tagName);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function getStickerImage(message, chatId) {
    if (stickerImageChatId !== chatId) {
      stickerImageChatId = chatId;
      stickerImageCache = Object.create(null);
    }

    var entry = stickerImageCache[message.id];
    if (!entry) {
      entry = {
        image: document.createElement('img'),
        fallback: createElement('span', 'message-text', message.text || '[Stiker]'),
        failed: false,
      };
      entry.image.className = 'message-sticker';
      entry.image.alt = 'Stiker';
      entry.image.onerror = function () {
        entry.failed = true;
        if (entry.image.parentNode) {
          entry.image.parentNode.replaceChild(entry.fallback, entry.image);
        }
      };
      entry.image.src =
        '/api/messages/' + encodeURIComponent(chatId) + '/' +
        encodeURIComponent(message.id) + '/sticker';
      stickerImageCache[message.id] = entry;
    }

    return entry;
  }

  function renderChats() {
    while (chatList.firstChild) {
      chatList.removeChild(chatList.firstChild);
    }

    var query = chatSearch.value.toLowerCase().replace(/^\s+|\s+$/g, '');
    var visibleCount = 0;
    var visibleChatIds = Object.create(null);

    for (var index = 0; index < chats.length; index += 1) {
      var chat = chats[index];
      var name = getChatName(chat);
      var searchable = (
        name + ' ' + (chat.phoneNumber || '') + ' ' + (chat.lastMessage || '')
      ).toLowerCase();
      if (query && searchable.indexOf(query) === -1) continue;

      visibleCount += 1;
      visibleChatIds[chat.id] = true;
      var item = document.createElement('li');
      var button = createElement('button', 'chat-row');
      button.type = 'button';

      var avatar = createElement('span', 'chat-avatar', initials(name));
      var details = createElement('span', 'chat-row-details');
      var heading = createElement('span', 'chat-row-heading');
      var contactName = createElement('strong', 'chat-row-name', name);
      var time = createElement('small', 'chat-row-time', formatTime(chat.lastMessageTimestamp));
      var preview = createElement(
        'span',
        'chat-row-preview',
        (chat.lastMessage || 'Belum ada pesan')
      );

      heading.appendChild(contactName);
      heading.appendChild(time);
      details.appendChild(heading);
      details.appendChild(preview);

      var unreadCount = Number(chat.unreadCount || 0);
      if (unreadCount > 0) {
        details.appendChild(
          createElement('span', 'unread-badge', unreadCount > 99 ? '99+' : String(unreadCount))
        );
      }

      button.appendChild(avatar);
      button.appendChild(details);
      button.addEventListener('click', (function (selectedChat) {
        return function () {
          openChat(selectedChat);
        };
      }(chat)));
      item.appendChild(button);
      chatList.appendChild(item);
    }

    var visibleContactCount = 0;
    for (var contactIndex = 0; contactIndex < contactSearchResults.length; contactIndex += 1) {
      var contact = contactSearchResults[contactIndex];
      if (visibleChatIds[contact.id]) continue;

      if (visibleContactCount === 0) {
        chatList.appendChild(
          createElement('li', 'contact-list-heading', 'Kontak')
        );
      }

      visibleContactCount += 1;
      visibleCount += 1;
      var contactName =
        contact.name || contact.phoneNumber || formatChatId(contact.id) || 'Kontak';
      var contactItem = document.createElement('li');
      var contactButton = createElement('button', 'chat-row contact-row');
      contactButton.type = 'button';
      contactButton.appendChild(
        createElement('span', 'chat-avatar', initials(contactName))
      );

      var contactDetails = createElement('span', 'chat-row-details');
      var contactHeading = createElement('span', 'chat-row-heading');
      contactHeading.appendChild(
        createElement('strong', 'chat-row-name', contactName)
      );
      contactHeading.appendChild(createElement('small', 'chat-row-time', 'Kontak'));
      contactDetails.appendChild(contactHeading);
      contactDetails.appendChild(
        createElement(
          'span',
          'chat-row-preview',
          contact.phoneNumber || 'Ketuk untuk memulai chat'
        )
      );
      contactButton.appendChild(contactDetails);
      contactButton.addEventListener('click', (function (selectedContact) {
        return function () {
          openContact(selectedContact);
        };
      }(contact)));
      contactItem.appendChild(contactButton);
      chatList.appendChild(contactItem);
    }

    if (!visibleCount) {
      chatListMessage.textContent = query
        ? contactSearchLoading
          ? 'Mencari kontak...'
          : contactSearchError || 'Tidak ada chat atau kontak yang cocok.'
        : 'Belum ada percakapan yang tersedia.';
      chatListMessage.style.display = 'block';
    } else if (contactSearchLoading || contactSearchError) {
      chatListMessage.textContent = contactSearchLoading
        ? 'Mencari kontak...'
        : contactSearchError;
      chatListMessage.style.display = 'block';
    } else {
      chatListMessage.style.display = 'none';
    }
  }

  function openContact(contact) {
    var requestId = ++contactOpenRequestId;
    chatListMessage.textContent = 'Membuka percakapan...';
    chatListMessage.style.display = 'block';

    request('POST', '/api/chats', { jid: contact.id }, function (error, chat) {
      if (requestId !== contactOpenRequestId) return;
      if (error || !chat || !chat.id) {
        chatListMessage.textContent = error
          ? error.message
          : 'Percakapan gagal dibuka.';
        return;
      }

      var updatedChats = chats.slice();
      var replaced = false;
      for (var index = 0; index < updatedChats.length; index += 1) {
        if (updatedChats[index].id === chat.id) {
          updatedChats[index] = chat;
          replaced = true;
          break;
        }
      }
      if (!replaced) updatedChats.push(chat);

      updateChats(updatedChats);
      openChat(chat);
    });
  }

  function searchContacts(query) {
    contactSearchRequestId += 1;
    var requestId = contactSearchRequestId;
    if (contactSearchTimer) {
      clearTimeout(contactSearchTimer);
      contactSearchTimer = null;
    }

    contactSearchResults = [];
    contactSearchError = '';
    contactSearchLoading = Boolean(query);
    renderChats();
    if (!query) return;

    contactSearchTimer = setTimeout(function () {
      contactSearchTimer = null;
      request(
        'GET',
        '/api/contacts/search?q=' + encodeURIComponent(query),
        null,
        function (error, results) {
          if (requestId !== contactSearchRequestId) return;

          contactSearchLoading = false;
          if (error) {
            contactSearchError = error.message;
          } else if (!Array.isArray(results)) {
            contactSearchError = 'Format hasil kontak tidak valid.';
          } else {
            contactSearchResults = results;
          }
          renderChats();
        }
      );
    }, 300);
  }

  function refreshContactSearch() {
    var query = chatSearch.value.replace(/^\s+|\s+$/g, '');
    if (query) searchContacts(query);
  }

  function setChatHeader(chat) {
    var name = getChatName(chat);
    detailAvatar.textContent = initials(name);
    detailName.textContent = name;
    detailNumber.textContent =
      chat.phoneNumber && chat.phoneNumber !== name ? chat.phoneNumber : '';
  }

  function renderMessages(items, shouldScroll) {
    while (messageList.firstChild) {
      messageList.removeChild(messageList.firstChild);
    }

    if (!items.length) {
      messageList.appendChild(
        createElement('p', 'message-empty', 'Belum ada pesan di percakapan ini.')
      );
      return;
    }

    for (var index = 0; index < items.length; index += 1) {
      var message = items[index];
      var row = createElement(
        'div',
        'message-row ' + (message.fromMe ? 'outgoing' : 'incoming')
      );
      var bubble = createElement('div', 'message-bubble');

      if (
        !message.fromMe &&
        activeChat &&
        activeChat.id.indexOf('@g.us') !== -1 &&
        message.senderName
      ) {
        bubble.appendChild(createElement('strong', 'message-sender', message.senderName));
      }

      if (message.type === 'sticker' && activeChat && message.id) {
        var sticker = getStickerImage(message, activeChat.id);
        bubble.appendChild(sticker.failed ? sticker.fallback : sticker.image);
      } else {
        bubble.appendChild(
          createElement('span', 'message-text', message.text || '[Pesan]')
        );
      }
      bubble.appendChild(
        createElement('small', 'message-time', formatTime(message.timestamp))
      );
      if (message.fromMe && message.status !== null && message.status !== undefined) {
        var statusText = {
          0: 'Gagal',
          1: 'Menunggu',
          2: 'Terkirim',
          3: 'Diterima',
          4: 'Dibaca',
          5: 'Diputar',
        }[message.status];
        if (statusText) {
          bubble.appendChild(createElement('small', 'message-status', statusText));
        }
      }
      row.appendChild(bubble);
      messageList.appendChild(row);
    }

    if (shouldScroll) {
      messageList.scrollTop = messageList.scrollHeight;
    }
  }

  function loadMessages(chat, forceScroll) {
    var requestId = ++messageRequestId;
    var wasNearBottom =
      messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 60;

    request('GET', '/api/messages/' + encodeURIComponent(chat.id), null, function (error, items) {
      if (
        requestId !== messageRequestId ||
        !activeChat ||
        activeChat.id !== chat.id
      ) {
        return;
      }

      if (error || !Array.isArray(items)) {
        renderMessages([], false);
        messageList.firstChild.textContent = error
          ? 'Riwayat pesan gagal dimuat.'
          : 'Format riwayat pesan tidak valid.';
        return;
      }

      renderMessages(items, forceScroll || wasNearBottom);
    });
  }

  function openChat(chat) {
    activeChat = chat;
    workspace.className = 'chat-workspace chat-selection-open';
    detailView.className = 'chat-detail-view chat-has-selection';
    emptyDetail.style.display = 'none';
    conversation.style.display = 'flex';
    setChatHeader(chat);
    loadMessages(chat, true);
  }

  function showChatList() {
    activeChat = null;
    messageRequestId += 1;
    stickerImageChatId = null;
    stickerImageCache = Object.create(null);
    workspace.className = 'chat-workspace';
    detailView.className = 'chat-detail-view';
    conversation.style.display = 'none';
    emptyDetail.style.display = 'block';
  }

  function updateChats(updatedChats) {
    if (!Array.isArray(updatedChats)) return;
    chatListRevision += 1;
    chats = updatedChats;
    renderChats();

    if (activeChat) {
      for (var index = 0; index < chats.length; index += 1) {
        if (chats[index].id === activeChat.id) {
          activeChat = chats[index];
          setChatHeader(activeChat);
          loadMessages(activeChat, false);
          return;
        }
      }
      showChatList();
    }
  }

  function initialize(socketClient) {
    if (socket && chatsListener) {
      socket.off('wa:chats', chatsListener);
    }
    if (socket && contactsListener) {
      socket.off('wa:contacts', contactsListener);
    }

    socket = socketClient;
    chatsListener = updateChats;
    contactsListener = refreshContactSearch;
    socket.on('wa:chats', chatsListener);
    socket.on('wa:contacts', contactsListener);
    chatListMessage.textContent = 'Memuat percakapan...';
    chatListMessage.style.display = 'block';
    var initialRevision = chatListRevision;

    request('GET', '/api/chats', null, function (error, items) {
      if (initialRevision !== chatListRevision) return;
      if (error) {
        chatListMessage.textContent = 'Daftar percakapan gagal dimuat.';
        chatListMessage.style.display = 'block';
        return;
      }
      updateChats(items);
    });
  }

  function clear() {
    if (socket && chatsListener) {
      socket.off('wa:chats', chatsListener);
    }
    if (socket && contactsListener) {
      socket.off('wa:contacts', contactsListener);
    }
    contactSearchRequestId += 1;
    contactOpenRequestId += 1;
    if (contactSearchTimer) {
      clearTimeout(contactSearchTimer);
      contactSearchTimer = null;
    }
    socket = null;
    chatsListener = null;
    contactsListener = null;
    chats = [];
    contactSearchResults = [];
    contactSearchLoading = false;
    contactSearchError = '';
    chatSearch.value = '';
    showChatList();
    renderChats();
    chatListMessage.textContent = '';
    while (messageList.firstChild) {
      messageList.removeChild(messageList.firstChild);
    }
    detailAvatar.textContent = '';
    detailName.textContent = '';
    detailNumber.textContent = '';
    messageInput.value = '';
    photoInput.value = '';
    sendStatus.textContent = '';
    pendingSend = null;
    pendingImageSend = null;
    setSendingState(false);
  }

  function createClientMessageId() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  function setSendingState(value) {
    sending = value;
    sendButton.disabled = value;
    photoButton.disabled = value;
    photoInput.disabled = value;
    messageInput.disabled = value;
  }

  function submitMessage(event) {
    event.preventDefault();
    if (sending || !activeChat) return;

    var text = messageInput.value;
    if (!text.replace(/^\s+|\s+$/g, '')) {
      sendStatus.textContent = 'Pesan tidak boleh kosong.';
      return;
    }

    var jid = activeChat.id;
    var requestId =
      pendingSend && pendingSend.jid === jid && pendingSend.text === text
        ? pendingSend.id
        : createClientMessageId();
    pendingSend = { id: requestId, jid: jid, text: text };
    setSendingState(true);
    sendStatus.textContent = 'Mengirim...';

    request(
      'POST',
      '/api/messages/' + encodeURIComponent(jid),
      { text: text, clientMessageId: requestId },
      function (error, response) {
        setSendingState(false);

        if (!activeChat || activeChat.id !== jid) return;

        if (error || !response || !response.sent) {
          sendStatus.textContent = error
            ? error.message
            : 'Pesan belum terkonfirmasi.';
          return;
        }

        pendingSend = null;
        sendStatus.textContent = 'Pesan terkirim.';
        if (messageInput.value === text) {
          messageInput.value = '';
        }
        loadMessages(activeChat, true);
      }
    );
  }

  function uploadPhoto(file) {
    if (sending || !activeChat) return;

    if (file.size > 8 * 1024 * 1024) {
      sendStatus.textContent = 'Ukuran foto maksimal 8 MB.';
      return;
    }

    var jid = activeChat.id;
    var caption = messageInput.value;
    var selectionKey = [
      jid,
      file.name,
      file.size,
      file.type,
      file.lastModified || '',
      caption,
    ].join('\n');
    var requestId =
      pendingImageSend && pendingImageSend.selectionKey === selectionKey
        ? pendingImageSend.id
        : createClientMessageId();
    pendingImageSend = {
      id: requestId,
      selectionKey: selectionKey,
    };

    setSendingState(true);
    sendStatus.textContent = 'Mengirim foto...';

    var xhr = new XMLHttpRequest();
    var completed = false;
    var url =
      '/api/messages/' + encodeURIComponent(jid) + '/image?caption=' +
      encodeURIComponent(caption);

    xhr.open('POST', url, true);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Client-Message-Id', requestId);
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4 || completed) return;
      completed = true;

      var response;
      try {
        response = xhr.responseText ? JSON.parse(xhr.responseText) : {};
      } catch (error) {
        setSendingState(false);
        sendStatus.textContent = 'Respons server tidak valid.';
        return;
      }

      setSendingState(false);
      if (!activeChat || activeChat.id !== jid) return;

      if (xhr.status < 200 || xhr.status >= 300 || !response.sent) {
        if (xhr.status === 409) pendingImageSend = null;
        sendStatus.textContent = response.error || 'Foto belum terkonfirmasi.';
        return;
      }

      pendingImageSend = null;
      sendStatus.textContent = 'Foto terkirim.';
      if (messageInput.value === caption) {
        messageInput.value = '';
      }
      loadMessages(activeChat, true);
    };
    xhr.onerror = function () {
      if (completed) return;
      completed = true;
      setSendingState(false);
      sendStatus.textContent =
        'Server tidak dapat dijangkau. Periksa percakapan sebelum mencoba lagi.';
    };
    xhr.send(file);
  }

  chatSearch.addEventListener('input', function () {
    searchContacts(chatSearch.value.replace(/^\s+|\s+$/g, ''));
  });
  backButton.addEventListener('click', showChatList);
  messageForm.addEventListener('submit', submitMessage);
  photoButton.addEventListener('click', function () {
    if (!sending) photoInput.click();
  });
  photoInput.addEventListener('change', function () {
    var file = photoInput.files && photoInput.files[0];
    photoInput.value = '';
    if (file) uploadPhoto(file);
  });

  window.WABridgeChat = {
    initialize: initialize,
    clear: clear,
  };
}());
