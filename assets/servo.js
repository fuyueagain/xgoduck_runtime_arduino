const $ = id => document.getElementById(id);
const PROJECT_IDS = [10, 11, 12, 13, 14, 20, 21, 22, 23, 24, 30, 31, 32, 33, 34];
const PART_NAMES = {
  10: '右腿 · 髋偏航', 11: '右腿 · 髋滚转', 12: '右腿 · 髋俯仰', 13: '右腿 · 膝', 14: '右腿 · 踝',
  20: '左腿 · 髋偏航', 21: '左腿 · 髋滚转', 22: '左腿 · 髋俯仰', 23: '左腿 · 膝', 24: '左腿 · 踝',
  30: '颈 · 俯仰', 31: '头 · 俯仰', 32: '头 · 偏航', 33: '头 · 滚转', 34: '嘴'
};
const BATCH_KEY = 'xgo-servo-setup-batch-v2';
let active = false;
let step = 1;
let sessionToken = 0;
let state = { currentId: null, targetId: null, configVerified: false, labelConfirmed: false };
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
  document.querySelectorAll('[data-panel]').forEach(panel => { panel.hidden = +panel.dataset.panel !== step; });
  document.querySelectorAll('#step-list li').forEach(item => {
    const value = +item.dataset.step;
    item.classList.toggle('active', value === step);
    item.classList.toggle('done', value < step);
  });
}
function renderBatch() {
  const done = batch.completed.length;
  $('batch-summary').textContent = `已完成 ${done} 颗；建议下一个目标 ID ${nextTarget()}。`;
  $('batch-list').innerHTML = batch.completed.map(item => `<span class='batch-chip'>ID ${item.targetId} · ${item.labelConfirmed ? '已贴标' : '未贴标'}</span>`).join('') || '<span class=hint>尚无完成记录。</span>';
}
async function post(path, body = {}) {
  const response = await fetch(`/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || '请求失败');
  return data;
}
function chooseTarget() {
  const select = $('target-id');
  select.innerHTML = PROJECT_IDS.map(id => `<option value='${id}'>ID ${id} · ${partName(id)}</option>`).join('');
  select.value = nextTarget();
}
async function start() {
  if (!$('single-confirm').checked) { show('请先确认只连接一颗舵机。'); return; }
  try {
    await post('servo/enter'); active = true; show('设置模式已进入，正在扫描有效单播地址……');
    await scan(sessionToken);
  } catch (error) { show(error.message); }
}
async function scan(token = sessionToken) {
  $('cancel-scan').hidden = false;
  try {
    const data = await post('servo', { action: 'scan' });
    if (token !== sessionToken) { $('cancel-scan').hidden = true; return; }
    $('cancel-scan').hidden = true;
    if (data.cancelled) { show('扫描已取消，未进行写入。'); return; }
    if (data.count !== 1) {
      state.currentId = null;
      $('current-id').textContent = '—';
      $('scan-detail').textContent = data.count ? `检测到多个响应地址：${data.ids.join(', ')}。已阻止写入，请断电后确认只连接一颗。` : '没有地址响应。请检查电源、串口和接线后重新扫描。';
      show('识别未通过，当前不会写入任何参数。');
      setStep(2); return;
    }
    state.currentId = data.single_id;
    $('current-id').textContent = `ID ${state.currentId}`;
    $('scan-detail').textContent = '已识别一个响应地址。软件不能据此证明物理上只有一颗同 ID 舵机。';
    show('识别成功。请确认 Current ID 后继续。');
    setStep(2);
  } catch (error) { $('cancel-scan').hidden = true; show(error.message); }
}
async function cancelScan() { sessionToken += 1; try { await post('servo', { action: 'scan_cancel' }); } catch (_) {} }
function continueIdentify() {
  if (!state.currentId) { show('没有已验证的 Current ID，不能继续。'); return; }
  setStep(3); chooseTarget();
}
async function setId() {
  const targetId = +$('target-id').value;
  if (!state.currentId || !targetId) { show('缺少 Current ID 或目标 ID。'); return; }
  if (batch.completed.some(item => item.targetId === targetId)) show('提示：该目标 ID 已在本批次完成过，重新设置前请确认实体舵机。');
  try {
    await post('servo', { action: 'set_id', target_id: state.currentId, new_id: targetId });
    const verify = await post('servo', { action: 'read', target_id: targetId });
    if (verify.target_id !== targetId) throw new Error('目标地址读回不匹配');
    state.targetId = targetId; state.currentId = targetId;
    $('current-id').textContent = `ID ${targetId}`;
    result('id-verify', `ID ${targetId} 已写入并通过目标地址读回验证。`, 'ok');
    show('ID 配置已验证。'); setStep(4);
  } catch (error) { result('id-verify', `写入未确认：${error.message}`, 'error'); show(error.message); }
}
async function gotoReference() {
  if (!$('free-confirm').checked) { show('请先确认输出轴可自由运动。'); return; }
  try {
    const reply = await post('servo', { action: 'goto_verify', target_id: state.targetId, raw_pos: 2047, tolerance: 3 });
    result('position-result', `已收到位置反馈：${reply.raw_pos}，目标 2047，已验证到位。`, 'ok');
    show('参考中位已通过位置反馈验证。'); setStep(5);
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
      show('参数配置已验证。'); setStep(6);
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
  try {
    const exit = await post('servo/exit');
    active = false;
    if (exit.exit_state !== 'confirmed' && exit.exit_state !== 'already_closed') throw new Error('退出状态未确认');
    batch.completed = batch.completed.filter(item => item.targetId !== state.targetId);
    batch.completed.push({ targetId: state.targetId, configVerified: true, labelConfirmed: true, completedAt: new Date().toISOString() });
    saveBatch();
    $('complete-summary').textContent = `ID ${state.targetId}（${partName(state.targetId)}）已完成参数配置，并已确认贴标。`;
    $('exit-state').textContent = '当前设置控制已退出并确认。请先切断舵机电源，再更换下一颗。';
    setStep(7); show('本颗设置完成。');
  } catch (error) { state.labelConfirmed = false; show(`已贴标记录未提交：${error.message}`); }
}
function resetCurrent() {
  sessionToken += 1;
  state = { currentId: null, targetId: null, configVerified: false, labelConfirmed: false };
  $('single-confirm').checked = false; $('free-confirm').checked = false; $('current-id').textContent = '—';
  result('id-verify', '尚未写入。'); result('position-result', '尚未执行运动。'); result('gain-result', '尚未保存。结果会区分“已发送”和“已验证”。');
  setStep(1); show(`请断电并更换下一颗舵机。建议目标 ID ${nextTarget()}。`);
}
async function nextServo() { resetCurrent(); }
async function endBatch() {
  if (active) { try { await post('servo/exit'); active = false; } catch (_) {} }
  show(`本次设置结束：已完成 ${batch.completed.length} 颗。完成清单已保留，下次可继续。`);
}
async function exitEarly() {
  sessionToken += 1;
  if (active) {
    try { await post('servo/exit'); active = false; } catch (_) { show('退出状态未确认，请断开舵机电源。'); }
  }
  if (state.targetId || state.currentId) {
    batch.incomplete.push({ currentId: state.currentId, targetId: state.targetId, configVerified: state.configVerified, labelConfirmed: false, at: new Date().toISOString() });
    saveBatch();
  }
  resetCurrent(); show('设置已退出；未完成的舵机已记录为未完成，不计入成功清单。');
}
chooseTarget(); renderBatch(); setStep(1);
$('start').onclick = start; $('scan-again').onclick = scan; $('continue-identify').onclick = continueIdentify;
$('cancel-scan').onclick = cancelScan;
$('set-id').onclick = setId; $('goto').onclick = gotoReference; $('set-gains').onclick = saveGains; $('label-done').onclick = finishLabel;
$('next').onclick = nextServo; $('end').onclick = endBatch; $('exit').onclick = exitEarly;
setInterval(async () => {
  try {
    const status = await (await fetch('/api/status')).json();
    $('mode').textContent = status.mode || '—';
    if (active) await post('servo/heartbeat');
  } catch (_) {}
}, 1000);
window.addEventListener('pagehide', () => {
  if (active) navigator.sendBeacon('/api/servo/exit', new Blob(['{}'], { type: 'application/json' }));
});
