const copyBtn = document.getElementById('copyBtn');
const statusEl = document.getElementById('status');
const sourceBtn = document.getElementById('sourceBtn');

const sourceUrl = 'https://github.com/w4kzzz/silent-edit';
sourceBtn.setAttribute('href', sourceUrl);

async function copyCurrentUrl() {
  const url = window.location.href;

  try {
    await navigator.clipboard.writeText(url);
    showStatus('URL copied.');
  } catch (error) {
    const textarea = document.createElement('textarea');
    textarea.value = url;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    showStatus('URL copied.');
  }
}

function showStatus(message) {
  statusEl.textContent = message;
  statusEl.classList.add('visible');

  clearTimeout(showStatus.timer);
  showStatus.timer = setTimeout(() => {
    statusEl.classList.remove('visible');
  }, 1800);
}

copyBtn.addEventListener('click', copyCurrentUrl);
