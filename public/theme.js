(function () {
  var themeStorageKey = 'wa-bridge-theme';
  var supportedThemes = {
    classic: true,
    hacker: true,
    matrix: true
  };
  var themeSelect = document.getElementById('theme-select');
  var settingsToggle = document.getElementById('settings-toggle');
  var settingsPanel = document.getElementById('settings-panel');

  function applyTheme(theme, savePreference) {
    if (!supportedThemes[theme]) {
      theme = 'classic';
    }

    document.documentElement.setAttribute('data-theme', theme);
    document.body.setAttribute('data-theme', theme);
    themeSelect.value = theme;

    if (savePreference) {
      try {
        window.localStorage.setItem(themeStorageKey, theme);
      } catch (error) {
        // The current selection still applies when storage is unavailable.
      }
    }
  }

  try {
    var savedTheme = window.localStorage.getItem(themeStorageKey);
    if (supportedThemes[savedTheme]) {
      applyTheme(savedTheme, false);
    } else {
      applyTheme('classic', false);
    }
  } catch (error) {
    applyTheme('classic', false);
  }

  themeSelect.addEventListener('change', function () {
    applyTheme(themeSelect.value, true);
  });

  settingsToggle.addEventListener('click', function () {
    var isOpen = settingsPanel.style.display !== 'none';
    settingsPanel.style.display = isOpen ? 'none' : 'block';
    settingsToggle.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
  });
}());
