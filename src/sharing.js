const share = {
  button: document.getElementById('shareButton'),
  modal: document.getElementById('shareModal'),
  close: document.getElementById('shareClose'),
  toggle: document.getElementById('shareToggle'),
  password: document.getElementById('sharePassword'),
  save: document.getElementById('shareSave'),
  message: document.getElementById('shareMessage'),
  access: document.getElementById('shareAccess'),
  qr: document.getElementById('shareQr'),
  url: document.getElementById('shareUrl'),
  copy: document.getElementById('shareCopy')
};

function renderSharing(info) {
  share.toggle.checked = info.enabled;
  share.password.value = info.password;
  share.url.textContent = info.primaryUrl;
  if (info.qrCode) share.qr.src = info.qrCode;
  share.access.hidden = !info.enabled;
  share.button.classList.toggle('active', info.enabled);
  share.button.querySelector('span').title = info.enabled ? '手机共享已开启' : '手机共享未开启';
  if (info.enabled) {
    share.message.textContent = info.hasLanAddress ? '实时共享已开启' : '已开启，但没有检测到可用的局域网地址';
    share.message.className = `share-message ${info.hasLanAddress ? 'success' : 'warning'}`;
  } else {
    share.message.textContent = '手机共享当前未开启';
    share.message.className = 'share-message';
  }
}

async function refreshSharing() {
  try { renderSharing(await window.pulseboard.getSharing()); }
  catch (error) { share.message.textContent = error.message; share.message.className = 'share-message error'; }
}

share.button.addEventListener('click', async () => {
  share.modal.classList.add('open');
  share.modal.setAttribute('aria-hidden', 'false');
  await refreshSharing();
});
share.close.addEventListener('click', () => {
  share.modal.classList.remove('open');
  share.modal.setAttribute('aria-hidden', 'true');
});
share.modal.addEventListener('click', (event) => { if (event.target === share.modal) share.close.click(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && share.modal.classList.contains('open')) share.close.click(); });
share.save.addEventListener('click', async () => {
  share.save.disabled = true;
  share.save.textContent = '正在应用…';
  try {
    renderSharing(await window.pulseboard.updateSharing({ enabled: share.toggle.checked, password: share.password.value }));
  } catch (error) {
    share.message.textContent = error.message;
    share.message.className = 'share-message error';
  } finally {
    share.save.disabled = false;
    share.save.textContent = '保存设置';
  }
});
share.copy.addEventListener('click', async () => {
  await window.pulseboard.copyText(share.url.textContent);
  share.copy.textContent = '已复制';
  setTimeout(() => { share.copy.textContent = '复制地址'; }, 1500);
});
window.pulseboard.onSharingError((message) => {
  share.message.textContent = `手机共享启动失败：${message}`;
  share.message.className = 'share-message error';
});

refreshSharing();
