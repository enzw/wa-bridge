(function () {
  var loginForm = document.getElementById('login-form');
  var loginPanel = document.getElementById('login-panel');
  var bridgePanel = document.getElementById('bridge-panel');
  var pinInput = document.getElementById('pin-input');
  var loginError = document.getElementById('login-error');
  var status = document.getElementById('status');
  var qr = document.getElementById('qr');
  var logoutButton = document.getElementById('logout-button');
  var socket = null;

  function request(method, url, body, callback) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    xhr.setRequestHeader('Accept', 'application/json');

    if (body) {
      xhr.setRequestHeader('Content-Type', 'application/json');
    }

    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;

      var response = {};
      try {
        response = xhr.responseText ? JSON.parse(xhr.responseText) : {};
      } catch (error) {
        callback(new Error('Respons server tidak valid.'));
        return;
      }

      callback(null, response, xhr.status);
    };

    xhr.onerror = function () {
      callback(new Error('Server tidak dapat dijangkau.'));
    };

    xhr.send(body ? JSON.stringify(body) : null);
  }

  function showLogin(message) {
    loginPanel.style.display = 'block';
    bridgePanel.style.display = 'none';
    loginError.textContent = message || '';
    pinInput.value = '';
    qr.removeAttribute('src');
    qr.style.display = 'none';
    if (socket) {
      window.WABridgeChat.clear();
      socket.disconnect();
      socket = null;
    } else {
      window.WABridgeChat.clear();
    }
  }

  function connectBridge() {
    if (socket) return;

    loginPanel.style.display = 'none';
    bridgePanel.style.display = 'block';
    status.textContent = 'Menghubungkan ke server...';
    socket = io();

    socket.on('wa:status', function (data) {
      status.textContent = data.message;
    });

    socket.on('wa:qr', function (image) {
      if (image) {
        qr.src = image;
        qr.style.display = 'block';
      } else {
        qr.removeAttribute('src');
        qr.style.display = 'none';
      }
    });

    window.WABridgeChat.initialize(socket);

    socket.on('connect_error', function () {
      request('GET', '/api/auth/session', null, function (error, response) {
        if (!error && !response.authenticated) {
          showLogin('Sesi berakhir. Silakan masuk kembali.');
        } else {
          status.textContent = 'Koneksi realtime gagal. Periksa jaringan.';
        }
      });
    });
  }

  loginForm.addEventListener('submit', function (event) {
    event.preventDefault();
    loginError.textContent = '';

    request('POST', '/api/auth/login', { pin: pinInput.value }, function (error, response, statusCode) {
      if (error) {
        loginError.textContent = error.message;
        return;
      }

      if (statusCode !== 200 || !response.authenticated) {
        loginError.textContent = response.error || 'Login gagal.';
        return;
      }

      pinInput.value = '';
      connectBridge();
    });
  });

  logoutButton.addEventListener('click', function () {
    logoutButton.disabled = true;
    request('POST', '/api/auth/logout', {}, function (error, response, statusCode) {
      logoutButton.disabled = false;
      if (error || statusCode !== 200 || response.authenticated !== false) {
        status.textContent = 'Logout gagal. Periksa jaringan, lalu coba lagi.';
        return;
      }

      if (socket) {
        socket.disconnect();
        socket = null;
      }
      qr.removeAttribute('src');
      qr.style.display = 'none';
      showLogin('');
    });
  });

  request('GET', '/api/auth/session', null, function (error, response) {
    if (!error && response.authenticated) {
      connectBridge();
    } else {
      showLogin('');
    }
  });
}());
