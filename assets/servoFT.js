const $ = id => document.getElementById(id);
const PROJECT_IDS = [10, 11, 12, 13, 14, 20, 21, 22, 23, 24, 30, 31, 32, 33, 34];
const PART_NAMES = {
  10: '右腿 · 髋偏航', 11: '右腿 · 髋滚转', 12: '右腿 · 髋俯仰', 13: '右腿 · 膝', 14: '右腿 · 踝',
  20: '左腿 · 髋偏航', 21: '左腿 · 髋滚转', 22: '左腿 · 髋俯仰', 23: '左腿 · 膝', 24: '左腿 · 踝',
  30: '颈 · 俯仰', 31: '头 · 俯仰', 32: '头 · 偏航', 33: '头 · 滚转', 34: '嘴'
};
const BATCH_KEY = 'xgo-servo-setup-batch-v2';
const BAUD_RATES = [1000000, 500000, 250000, 128000, 115200, 57600, 38400, 19200, 9600];
let active = false;
let connected = false;
let step = 1;
let maxStep = 1;
let sessionToken = 0;
let serverBaud = null;
let state = { currentId: null, targetId: null, writtenId: null, configVerified: false, labelConfirmed: false };
let batch = loadBatch();

function loadBatch() {
  try {
    const value = JSON.parse(localStorage.getItem(BATCH_KEY) || '{}');
    return { completed: Array.isArray(value.completed) ? value.completed : [], incomplete: Array.isArray(value.incomplete) ? value.incomplete : [] };
  } catch (_) { return { completed: [], incomplete: [] }; }
}
function saveBatch() { localStorage.setItem(BATCH_KEY, JSON.stringify(batch)); renderBatch(); }
function show(message) { $('message').textContent = message; }
function result(id, message, kind = '') { const el = $(id); el.textContent = message; el.className = `result ${kind}`; }
function partName(id) { return PART_NAMES[id] || '未分配部位'; }
function nextTarget() { return PROJECT_IDS.find(id => !batch.completed.some(item => item.targetId === id)) || PROJECT_IDS[0]; }

function setStep(next) {
  step = next;
  if (next > maxStep) maxStep = next;
  document.querySelectorAll('[data-panel]').forEach(panel => { panel.hidden = +panel.dataset.panel !== step; });
  document.querySelectorAll('#step-list li').forEach(item => {
    const value = +item.dataset.step;
    item.classList.toggle('active', value === step);
    item.classList.toggle('done', value < step);
    item.classList.toggle('clickable', value <= maxStep);
  });
  if (step === 3) startPositionPoll(); else stopPositionPoll();
}
function goToStep(target) {
  const value = +target;
  if (value > maxStep) { show('请先完成前面的步骤。'); return; }
  if (value !== step) { show(`已回到第 ${value} 步，可重新设置。`); setStep(value); }
}
function renderBatch() {
  const done = new Set(batch.completed.map(item => item.targetId));
  $('batch-summary').textContent = `已完成 ${done.size} 颗；建议下一个目标 ID ${nextTarget()}。`;
  $('batch-list').innerHTML = PROJECT_IDS.map(id =>
    `<span class='batch-chip ${done.has(id) ? 'done' : 'todo'}' title='ID ${id} · ${partName(id)}'>${id}</span>`).join('');
}
async function post(path, body = {}, allowRetry = true) {
  const response = await fetch(`/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    // A backgrounded tab throttles the 1 s heartbeat, so the session can lapse
    // while the page sits idle. Re-enter once instead of failing the click.
    if (allowRetry && data.detail === 'servo setup session is not active') {
      try { await post('servo/enter', {}, false); active = true; } catch (_) {}
      return post(path, body, false);
    }
    throw new Error(data.detail || '请求失败');
  }
  return data;
}
function chooseTarget() {
  const select = $('target-id');
  select.innerHTML = PROJECT_IDS.map(id => `<option value='${id}'>ID ${id} · ${partName(id)}</option>`).join('');
  select.value = nextTarget();
}

// --- connection ---------------------------------------------------------
function renderConnectButton() {
  $('connect').textContent = connected ? '断开连接' : '开始连接';
  $('connect').classList.toggle('stop', connected);
  $('port-list').disabled = connected;
}
async function loadPorts() {
  try {
    const data = await (await fetch('/api/ports')).json();
    const list = $('port-list');
    const found = data.ports || [];
    list.innerHTML = found.length
      ? found.map(p => `<option value='${p.device}'>${p.device} · ${p.description || 'USB 串口'}</option>`).join('')
      : '<option value="">未检测到 URT2</option>';
    if (data.current) list.value = data.current;
    connected = !!data.connected;
    renderConnectButton();
  } catch (_) { show('无法读取端口列表。'); }
}
async function connectToggle() {
  if (connected) { await doDisconnect(); show('已断开连接。'); return; }
  const port = $('port-list').value;
  if (!port) { show('没有可用端口。请插好 URT2 后点此按钮重试。'); await loadPorts(); return; }
  $('connect').disabled = true;
  show(`正在连接 ${port}……`);
  try {
    const reply = await post('connect', { port, baud: +$('baud').value });
    connected = true; active = true; serverBaud = reply.baud;
    syncBaud(reply.baud); renderConnectButton();
    resetCurrent();
    show(reply.probe_id
      ? `已连接 ${reply.port} @ ${reply.baud}，检测到 ID ${reply.probe_id}。`
      : `已连接 ${reply.port} @ ${reply.baud}，未检测到舵机；请检查供电和接线。`);
    await scan();
  } catch (error) { show(`连接失败：${error.message}`); }
  finally { $('connect').disabled = false; }
}
async function doDisconnect() {
  try { await post('disconnect'); } catch (_) {}
  connected = false; active = false;
  resetCurrent(); renderConnectButton();
}
function syncBaud(baud) {
  const rates = BAUD_RATES.includes(baud) ? BAUD_RATES : [baud, ...BAUD_RATES];
  $('baud').innerHTML = rates.map(rate => `<option value='${rate}'>${rate}</option>`).join('');
  $('baud').value = String(baud);
}
async function applyBaud() {
  const baud = +$('baud').value;
  if (baud === serverBaud) { show(`波特率已是 ${baud}。`); return; }
  try {
    const reply = await post('baud', { baud });
    serverBaud = reply.baud;
    $('baud').value = String(serverBaud);
    show(`波特率已切换为 ${reply.baud}。请重新扫描确认舵机应答。`);
  } catch (error) {
    show(`波特率未切换：${error.message}`);
    if (serverBaud) syncBaud(serverBaud);
  }
}

// --- wizard -------------------------------------------------------------
async function scan(token = sessionToken) {
  $('cancel-scan').hidden = false;
  try {
    const data = await post('servo', { action: 'scan' });
    $('cancel-scan').hidden = true;
    if (token !== sessionToken) return;
    if (data.cancelled) { show('扫描已取消，未进行写入。'); return; }
    if (data.count !== 1) {
      state.currentId = null;
      $('current-id').textContent = '—';
      $('scan-detail').textContent = data.count
        ? `检测到多个响应地址：${data.ids.join(', ')}。已阻止写入，请断电后确认只连接一颗。`
        : '没有地址响应。请检查电源、接线和波特率后重新扫描。';
      show('识别未通过，当前不会写入任何参数。');
      setStep(1); return;
    }
    state.currentId = data.single_id;
    $('current-id').textContent = `ID ${state.currentId}`;
    $('scan-detail').textContent = '已识别一个响应地址。软件不能据此证明物理上只有一颗同 ID 舵机。';
    show('识别成功。请确认 Current ID 后继续。');
    setStep(1);
  } catch (error) { $('cancel-scan').hidden = true; show(error.message); }
}
async function cancelScan() { sessionToken += 1; try { await post('servo', { action: 'scan_cancel' }); } catch (_) {} }
function continueIdentify() {
  if (!state.currentId) { show('没有已验证的 Current ID，不能继续。'); return; }
  state.writtenId = null;
  setStep(2); chooseTarget();
}
async function setId() {
  const targetId = +$('target-id').value;
  if (!state.currentId || !targetId) { show('缺少 Current ID 或目标 ID。'); return; }
  if (batch.completed.some(item => item.targetId === targetId)) show('提示：该目标 ID 已在本批次完成过，重新设置前请确认实体舵机。');
  try {
    await post('servo', { action: 'set_id', target_id: state.currentId, new_id: targetId });
    // A different target invalidates anything already verified for the old one.
    if (state.targetId !== null && state.targetId !== targetId) {
      state.targetId = null; state.configVerified = false; maxStep = 2;
    }
    state.writtenId = targetId;
    result('id-verify', `ID ${targetId} 已发送。请点击“验证（重新扫描）”确认写入生效。`, '');
    show('写入已发送，尚未验证。');
  } catch (error) { result('id-verify', `写入失败：${error.message}`, 'error'); show(error.message); }
}
async function verifyId() {
  if (!state.writtenId) { show('请先写入新 ID。'); return; }
  result('id-verify', '正在重新扫描总线……', '');
  try {
    const data = await post('servo', { action: 'scan' });
    if (data.cancelled) { result('id-verify', '扫描已取消，未产生验证结果。', ''); return; }
    if (data.count === 1 && data.single_id === state.writtenId) {
      state.targetId = state.writtenId; state.currentId = state.writtenId;
      $('current-id').textContent = `ID ${state.writtenId}`;
      result('id-verify', `重新扫描确认：总线上只有 ID ${data.single_id} 在线，与写入值一致。`, 'ok');
      show('ID 配置已验证。'); setStep(3); return;
    }
    if (data.count === 0) {
      result('id-verify', '重新扫描没有发现任何舵机。请检查供电和接线，或确认写入是否生效。', 'error');
    } else if (data.count === 1) {
      result('id-verify', `重新扫描发现 ID ${data.single_id}，与写入的 ${state.writtenId} 不一致，写入可能未生效。`, 'error');
    } else {
      result('id-verify', `重新扫描发现多个地址：${data.ids.join(', ')}。请断电后确认总线上只有一颗舵机。`, 'error');
    }
    show('验证未通过，不会进入下一步。');
  } catch (error) { result('id-verify', `验证失败：${error.message}`, 'error'); show(error.message); }
}
// Live encoder readout for step 3: the register read is harmless and does not move
// the servo, so it can be polled while the user watches the shaft.
let positionTimer = null;
function startPositionPoll() {
  stopPositionPoll();
  readPosition();
  positionTimer = setInterval(readPosition, 500);
}
function stopPositionPoll() {
  if (positionTimer) { clearInterval(positionTimer); positionTimer = null; }
}
async function readPosition() {
  if (step !== 3 || !state.targetId) return;
  try {
    const reply = await post('servo', { action: 'read', target_id: state.targetId });
    $('live-pos').textContent = reply.raw_pos;
  } catch (_) { $('live-pos').textContent = '—'; }
}
async function gotoReference() {
  if (!$('free-confirm').checked) { show('请先确认输出轴可自由运动。'); return; }
  try {
    const reply = await post('servo', { action: 'goto_verify', target_id: state.targetId, raw_pos: 2047, tolerance: 3 });
    result('position-result', `已收到位置反馈：${reply.raw_pos}，目标 2047，已验证到位。`, 'ok');
    show('参考中位已通过位置反馈验证。'); setStep(4);
  } catch (error) { result('position-result', `运动结果未验证：${error.message}`, 'error'); show(error.message); }
}
async function saveGains() {
  const kp = +$('kp').value; const kd = +$('kd').value;
  try {
    await post('servo', { action: 'set_gains', target_id: state.targetId, kp, kd });
    try {
      const verify = await post('servo', { action: 'gains_verify', target_id: state.targetId, kp, kd });
      state.configVerified = !!verify.verified;
      $('label-id').textContent = `ID ${state.targetId}`;
      $('label-name').textContent = partName(state.targetId);
      result('gain-result', `参数已发送并读回验证：KP ${verify.kp} / KD ${verify.kd}。`, 'ok');
      show('参数配置已验证。'); setStep(5);
    } catch (verifyError) {
      state.configVerified = false;
      result('gain-result', `参数已发送，但存储读回未验证：${verifyError.message}`, 'error');
      show('不能把“已发送”当作“已验证”，请勿继续贴标。');
    }
  } catch (error) { result('gain-result', `参数发送失败：${error.message}`, 'error'); show(error.message); }
}
async function finishLabel() {
  if (!state.configVerified) { show('参数尚未验证，不能确认本颗完成。'); return; }
  state.labelConfirmed = true;
  batch.completed = batch.completed.filter(item => item.targetId !== state.targetId);
  batch.completed.push({ targetId: state.targetId, configVerified: true, labelConfirmed: true, completedAt: new Date().toISOString() });
  saveBatch();
  $('complete-summary').textContent = `ID ${state.targetId}（${partName(state.targetId)}）已完成并贴标。`;
  $('exit-state').textContent = '请切断舵机电源，再更换下一颗。';
  $('finish-block').hidden = false;
  $('label-done').disabled = true;
  show('本颗完成。');
}
function resetCurrent() {
  sessionToken += 1;
  state = { currentId: null, targetId: null, writtenId: null, configVerified: false, labelConfirmed: false };
  maxStep = 1;
  $('current-id').textContent = '—';
  $('scan-detail').textContent = '扫描只读，不会让舵机运动或改写参数。';
  $('live-pos').textContent = '—';
  $('free-confirm').checked = false;
  $('finish-block').hidden = true;
  $('label-done').disabled = false;
  result('id-verify', '写入后需重新扫描验证。');
  result('position-result', '尚未执行运动。');
  result('gain-result', '结果会区分“已发送”和“已验证”。');
  setStep(1);
}
async function nextServo() {
  resetCurrent();
  chooseTarget();
  show(`请断电、更换下一颗舵机，然后点“重新扫描”。建议目标 ID ${nextTarget()}。`);
}
async function endBatch() {
  await doDisconnect();
  show(`本次设置结束：已完成 ${batch.completed.length} 颗。`);
}
async function exitEarly() {
  sessionToken += 1;
  if (state.targetId || state.currentId) {
    batch.incomplete.push({ currentId: state.currentId, targetId: state.targetId, configVerified: state.configVerified, labelConfirmed: false, at: new Date().toISOString() });
    saveBatch();
  }
  await doDisconnect();
  show('设置已退出；未完成的舵机已记录为未完成。');
}

chooseTarget(); renderBatch(); setStep(1); loadPorts();
$('connect').onclick = connectToggle; $('exit').onclick = exitEarly;
$('baud').onchange = applyBaud;
$('step-list').onclick = event => {
  const item = event.target.closest('li[data-step]');
  if (item) goToStep(item.dataset.step);
};
$('scan-again').onclick = scan; $('cancel-scan').onclick = cancelScan; $('continue-identify').onclick = continueIdentify;
$('set-id').onclick = setId; $('verify-id').onclick = verifyId;
$('goto').onclick = gotoReference; $('set-gains').onclick = saveGains; $('label-done').onclick = finishLabel;
$('next').onclick = nextServo; $('end').onclick = endBatch;
setInterval(async () => {
  try {
    const status = await (await fetch('/api/status')).json();
    $('mode').textContent = status.connected
      ? [status.port, `${status.baud} baud`].filter(Boolean).join(' · ')
      : '未连接';
    if (!!status.connected !== connected) { connected = !!status.connected; renderConnectButton(); }
    if (status.baud && status.baud !== serverBaud) { serverBaud = status.baud; syncBaud(status.baud); }
    if (active && connected) await post('servo/heartbeat');
  } catch (_) {}
}, 1000);
window.addEventListener('pagehide', () => {
  // Release the COM port when the page goes away, so another program can take it.
  if (connected) navigator.sendBeacon('/api/disconnect', new Blob(['{}'], { type: 'application/json' }));
});
