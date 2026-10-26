/* B站值班台 — client. Reads the plugin's status/report API through the local proxy. */
const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => [...document.querySelectorAll(sel)]

const state = {
  status: null,
  me: null,
  reports: [],
  day: null,
  running: false,
  runStartedAt: 0,
  timers: { status: 0, log: 0, elapsed: 0, login: 0 },
  filter: 'all',
  seen: [],
  activeTab: 'report',
  connected: false,
}

/* ── tiny helpers ─────────────────────────────────────────────── */

async function api(path, options) {
  const response = await fetch('/api' + path, options)
  const body = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }))
  if (!body.ok && body.error && !body.warn) console.warn('[bili-duty]', path, body.error)
  return body
}

function toast(text, bad = false) {
  const el = $('#toast')
  if (el) {
    el.textContent = text
    el.classList.toggle('bad', bad)
    el.classList.remove('hidden')
    clearTimeout(toast.timer)
    toast.timer = setTimeout(() => el.classList.add('hidden'), 3200)
  }
  const flash = $('#flash')
  if (flash) {
    flash.textContent = text
    flash.classList.toggle('bad', bad)
    flash.classList.remove('hidden')
    clearTimeout(toast.flashTimer)
    toast.flashTimer = setTimeout(() => flash.classList.add('hidden'), 4000)
  }
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function fmtTime(ms) {
  if (!ms) return '—'
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`
  return new Date(ms).toLocaleDateString('zh-CN')
}

function pad(n) { return String(n).padStart(2, '0') }

function nextWindow(config, windows) {
  if (!config || config.peakValley !== true) return null
  const enabled = []
  if (config.noon) enabled.push({ key: 'noon', ...windows.noon })
  if (config.night) enabled.push({ key: 'night', ...windows.night })
  if (enabled.length === 0) return null
  const now = new Date()
  let best = null
  for (const window of enabled) {
    const [h, m] = String(window.start || '00:00').split(':').map(Number)
    const at = new Date(now)
    at.setHours(h, m, 0, 0)
    if (at <= now) at.setDate(at.getDate() + 1)
    if (!best || at < best.at) best = { at, window }
  }
  return best
}

/* ── status ───────────────────────────────────────────────────── */

async function loadStatus() {
  let status
  try {
    status = await api('/status')
  } catch (error) {
    setConn(false)
    return
  }
  if (!status.ok) { setConn(false); return }
  state.status = status
  setConn(true)
  renderStats()
  renderSchedule()
  if (!status.loggedIn) $('#loginBanner').classList.remove('hidden')
  else $('#loginBanner').classList.add('hidden')
  $('#logPath').textContent = status.log || ''
}

async function loadMe() {
  const me = await api('/me').catch(() => null)
  if (me && me.ok) {
    state.me = me
    $('#statAccount').textContent = me.uname || '已登录'
    $('#statAccountHint').textContent = me.mid ? `UID ${me.mid}` : '凭证有效'
  } else if (!state.me) {
    $('#statAccount').textContent = state.status?.loggedIn ? '已登录' : '未登录'
    $('#statAccountHint').textContent = state.status?.loggedIn ? '凭证有效' : '需要扫码'
  }
}

function setConn(ok) {
  state.connected = ok
  updateRunState()
  const el = $('#conn')
  el.textContent = ok ? '已连接' : 'Harness 未响应'
  el.className = 'pill ' + (ok ? 'pill-ok' : 'pill-bad')
}

function renderStats() {
  const status = state.status
  if (!status) return
  const config = status.config || {}
  $('#statPicked').textContent = status.pickedToday ?? 0
  $('#statQuota').textContent = `/ ${config.perDay ?? 0} 条`
  $('#statEnv').textContent = status.venvReady ? '就绪' : '缺依赖'
  $('#statEnvHint').textContent = status.venvReady
    ? `插件 v${status.version || '?'}`
    : `缺：${(status.missingDeps || []).join('、') || '未知'}`
  const lastAt = status.lastEndAt || status.lastRunAt
  $('#statLastRun').textContent = lastAt
    ? `上次跑完：${fmtTime(lastAt)}`
    : (status.pickedToday > 0 ? `今天挑过 ${status.pickedToday} 条` : '今天还没跑过')
  loadMe()
  updateRunState()
}

function renderSchedule() {
  const status = state.status
  if (!status) return
  const config = status.config || {}
  const next = nextWindow(config, status.windows || {})
  if (!config.peakValley) {
    $('#statSchedule').textContent = '仅手动'
    $('#statScheduleHint').textContent = '打开峰谷自动刷才会自己跑'
    return
  }
  $('#statSchedule').textContent = next ? `${next.window.label}` : '已开启'
  if (next) {
    const day = next.at.toDateString() === new Date().toDateString() ? '今天' : '明天'
    $('#statScheduleHint').textContent = `下次 ${day} ${pad(next.at.getHours())}:${pad(next.at.getMinutes())}`
  }
}

/* ── tabs ─────────────────────────────────────────────────────── */

function setTab(name) {
  state.activeTab = name
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === name))
  for (const id of ['report', 'watched', 'settings', 'log']) {
    $('#tab-' + id).classList.toggle('hidden', id !== name)
  }
  if (name === 'report') loadReports()
  if (name === 'watched') loadWatched()
  if (name === 'settings') fillSettings()
  if (name === 'log') loadLog()
}

/* ── reports ──────────────────────────────────────────────────── */

async function loadReports() {
  const body = await api('/reports')
  if (!body.ok) return
  state.reports = body.reports || []
  const list = $('#dayList')
  if (state.reports.length === 0) {
    list.innerHTML = '<div class="empty">还没有日报</div>'
    return
  }
  const active = state.day || state.reports[0].day
  list.innerHTML = state.reports.map((row) => {
    const size = row.bytes > 1024 ? `${(row.bytes / 1024).toFixed(1)} KB` : `${row.bytes} B`
    return `<button class="day-item ${row.day === active ? 'active' : ''}" data-day="${row.day}">
      <span>${row.day}</span><span class="n">${size}</span></button>`
  }).join('')
  list.querySelectorAll('.day-item').forEach((btn) => {
    btn.onclick = () => { loadReport(btn.dataset.day) }
  })
  if (!state.day || !state.reports.some((r) => r.day === state.day)) await loadReport(active)
}

async function loadReport(day) {
  state.day = day
  $$('#dayList .day-item').forEach((btn) => btn.classList.toggle('active', btn.dataset.day === day))
  const body = await api('/report-file?day=' + encodeURIComponent(day))
  const view = $('#reportView')
  if (!body.ok) {
    view.innerHTML = `<div class="empty">${esc(body.error || '没有内容')}</div>`
    return
  }
  view.innerHTML = renderMarkdown(body.text)
  view.scrollTop = 0
}

/** Minimal markdown for the report shape the duty bot writes. */
function renderMarkdown(source) {
  const lines = String(source || '').replace(/\r\n/g, '\n').split('\n')
  const out = []
  let inCode = false
  let inList = false
  const inline = (text) => esc(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>')

  for (const raw of lines) {
    if (/^```/.test(raw)) {
      if (inList) { out.push('</ul>'); inList = false }
      out.push(inCode ? '</pre>' : '<pre>')
      inCode = !inCode
      continue
    }
    if (inCode) { out.push(esc(raw)); continue }
    const line = raw.trimEnd()
    if (!line.trim()) { if (inList) { out.push('</ul>'); inList = false } continue }
    if (/^[-*]\s+/.test(line)) {
      if (!inList) { out.push('<ul>'); inList = true }
      out.push(`<li>${inline(line.replace(/^[-*]\s+/, ''))}</li>`)
      continue
    }
    if (inList) { out.push('</ul>'); inList = false }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) { out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); continue }
    if (/^---+$/.test(line)) { out.push('<hr>'); continue }
    if (/^>\s?/.test(line)) { out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`); continue }
    out.push(`<p>${inline(line)}</p>`)
  }
  if (inList) out.push('</ul>')
  if (inCode) out.push('</pre>')
  return out.join('\n')
}

/* ── watched ──────────────────────────────────────────────────── */

async function loadWatched() {
  const body = await api('/seen')
  if (!body.ok) return
  state.seen = body.seen || []
  renderWatched()
}

function tagText(row) {
  const verdict = row.picked ? '挑中' : '跳过'
  const detail = String(row.note || '').replace(/^(挑中|跳过)[·\s]*/, '')
  return detail ? `${verdict} · ${detail}` : verdict
}

function renderWatched() {
  const rows = state.seen.filter((row) => state.filter === 'all' || (state.filter === 'picked' ? row.picked : !row.picked))
  const list = $('#watchedList')
  if (rows.length === 0) { list.innerHTML = '<div class="empty">还没有记录</div>'; return }
  list.innerHTML = rows.map((row) => `
    <div class="watch-row">
      <span class="bv">${row.bvid}</span>
      <span class="title"><a href="https://www.bilibili.com/video/${row.bvid}" target="_blank" rel="noreferrer">${esc(row.title)}</a>
        <span class="muted"> · ${row.day}</span></span>
      <span class="tag ${row.picked ? 'picked' : ''}">${esc(tagText(row))}</span>
    </div>`).join('')
}

/* ── settings ─────────────────────────────────────────────────── */

function fillSettings() {
  const status = state.status
  if (!status) return
  const config = status.config || {}
  $('#keywords').value = (config.keywords || []).join('\n')
  $('#perDay').value = config.perDay ?? 5
  $('#peakValley').checked = config.peakValley === true
  $('#noon').checked = config.noon !== false
  $('#night').checked = config.night !== false
  $('#reportLevel').value = config.reportLevel || 'full'
  $('#personaPrompt').value = config.personaPrompt || ''
  $('#transcribe').checked = config.transcribe === true
  $('#autoComment').checked = config.autoComment === true
  $('#mentionName').value = config.mentionName || ''
  $('#commentPerRound').value = config.commentPerRound ?? 1
  $('#dmMode').value = config.dmMode || 'off'
  const windows = status.windows || {}
  $('#noonLabel').textContent = windows.noon ? `${windows.noon.start}–${windows.noon.end}` : ''
  $('#nightLabel').textContent = windows.night ? `${windows.night.start}–${windows.night.end}` : ''
  updateCommentFields()
}

function updateCommentFields() {
  const on = $('#autoComment').checked
  $('#commentFields').style.opacity = on ? '1' : '0.45'
  $$('#commentFields input').forEach((el) => { el.disabled = !on })
}

async function saveSettings(event) {
  event.preventDefault()
  const patch = {
    keywords: $('#keywords').value.split('\n').map((line) => line.trim()).filter(Boolean),
    perDay: Number($('#perDay').value) || 0,
    peakValley: $('#peakValley').checked,
    noon: $('#noon').checked,
    night: $('#night').checked,
    reportLevel: $('#reportLevel').value,
    personaPrompt: $('#personaPrompt').value,
    transcribe: $('#transcribe').checked,
    autoComment: $('#autoComment').checked,
    mentionName: $('#mentionName').value.trim(),
    commentPerRound: Number($('#commentPerRound').value) || 0,
    dmMode: $('#dmMode').value,
  }
  const body = await api('/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (body.ok) {
    toast('设置已保存')
    await loadStatus()
    fillSettings()
  } else {
    toast(body.error || '保存失败', true)
  }
}

/* ── log ──────────────────────────────────────────────────────── */

async function loadLog() {
  const body = await api('/log?lines=400')
  if (!body.ok) return
  const view = $('#logView')
  const nearBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 60
  view.textContent = renderLog(body.text || '')
  if (nearBottom) view.scrollTop = view.scrollHeight
  return body.text || ''
}

/** Keep the plugin's own stage lines; hide the sub-agent's reasoning prose by default. */
function renderLog(text) {
  if ($('#logFull').checked) return text || '（还没有日志）'
  const lines = text.split('\n').filter((line) => /^\d{4}-\d{2}-\d{2}T/.test(line))
  return lines.length ? lines.join('\n') : '（这一轮还没写出阶段日志）'
}

/* ── run a round ──────────────────────────────────────────────── */

/** 当前为什么不能跑；空串表示可以。 */
function runBlockReason() {
  if (state.running) return '正在跑'
  if (!state.connected || !state.status) return 'Harness 未连接'
  if (!state.status.loggedIn) return '先扫码登录'
  if (!state.status.venvReady) return '先装依赖'
  return ''
}

/** 按钮状态机：不可跑时禁用并说明原因；配额满了给出提示但不拦。 */
function updateRunState() {
  const reason = runBlockReason()
  const button = $('#runBtn')
  const hint = $('#runHint')
  if (!button || !hint) return
  button.disabled = Boolean(reason) || state.running
  button.title = reason || '手动跑一轮'
  const status = state.status
  const quotaFull = status && status.config && status.config.perDay > 0 &&
    Number(status.pickedToday || 0) >= Number(status.config.perDay)
  const note = state.running ? '' : (reason || (quotaFull ? '今日配额已满，这一轮只出报告' : ''))
  hint.textContent = note
  hint.classList.toggle('warn', Boolean(reason) && !state.running)
}

async function runNow() {
  if (state.running) { toast('这一轮还在跑'); return }
  const reason = runBlockReason()
  if (reason) {
    toast('现在不能跑：' + reason, true)
    if (reason === '先扫码登录') openLogin()
    return
  }
  const button = $('#runBtn')
  button.disabled = true
  const body = await api('/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  if (!body.ok || body.started === false) {
    updateRunState()
    toast(body.error || body.reason || '起不来这一轮', true)
    return
  }
  startRunning()
}

function startRunning() {
  state.running = true
  state.runStartedAt = Date.now()
  $('#runBanner').classList.remove('hidden')
  updateRunState()
  $('#runBtn').textContent = '运行中…'
  setTab('log')
  clearInterval(state.timers.elapsed)
  state.timers.elapsed = setInterval(() => {
    $('#runElapsed').textContent = `${Math.round((Date.now() - state.runStartedAt) / 1000)} 秒`
  }, 1000)
  clearInterval(state.timers.log)
  state.timers.log = setInterval(checkRunFinished, 3000)
  checkRunFinished()
}

async function checkRunFinished() {
  const text = await loadLog()
  if (!text) return
  const startIso = new Date(state.runStartedAt - 5000).toISOString()
  const finished = text.split('\n').some((line) => {
    if (!/刷B站结束/.test(line)) return false
    const stamp = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(line)
    return stamp ? stamp[1] >= startIso : true
  })
  if (!finished) return
  stopRunning()
  toast('这一轮跑完了')
  await loadStatus()
  await loadReports()
}

function stopRunning() {
  state.running = false
  clearInterval(state.timers.log)
  clearInterval(state.timers.elapsed)
  $('#runBanner').classList.add('hidden')
  updateRunState()
  $('#runBtn').textContent = '立即跑一轮'
  loadReports()
}

/* ── login ────────────────────────────────────────────────────── */

function openLogin() {
  $('#qrModal').classList.remove('hidden')
  startLogin()
}

async function startLogin() {
  clearInterval(state.timers.login)
  $('#qrState').textContent = '二维码加载中…'
  const body = await api('/login/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  if (!body.ok) { $('#qrState').textContent = body.error || '出码失败'; return }
  $('#qrImg').src = '/api/qr?t=' + Date.now()
  $('#qrState').textContent = '等待扫码…'
  const key = body.key
  state.timers.login = setInterval(async () => {
    const poll = await api('/login/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    }).catch(() => null)
    if (!poll) return
    if (poll.state === 'ok') {
      clearInterval(state.timers.login)
      $('#qrState').textContent = '登录成功'
      setTimeout(() => $('#qrModal').classList.add('hidden'), 600)
      toast('登录成功')
      await loadStatus()
      return
    }
    if (poll.state === 'scanned') $('#qrState').textContent = '已扫码，请在手机上确认'
    else if (poll.state === 'expired') { clearInterval(state.timers.login); $('#qrState').textContent = '二维码过期了，点「换一张」' }
    else $('#qrState').textContent = '等待扫码…'
  }, 2000)
}

/* ── wiring ───────────────────────────────────────────────────── */

function wire() {
  $('#tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('.tab')
    if (tab) setTab(tab.dataset.tab)
  })
  $('#refreshBtn').onclick = async () => { await loadStatus(); await loadReports(); toast('已刷新') }
  $('#runBtn').onclick = runNow
  $('#showLogBtn').onclick = () => setTab('log')
  $('#loginBtn').onclick = openLogin
  $('#qrClose').onclick = () => { clearInterval(state.timers.login); $('#qrModal').classList.add('hidden') }
  $('#qrRefresh').onclick = startLogin
  $('#settingsForm').addEventListener('submit', saveSettings)
  $('#autoComment').addEventListener('change', updateCommentFields)
  $('#logRefresh').onclick = loadLog
  $('#logFull').addEventListener('change', loadLog)
  $('#logFollow').addEventListener('change', (event) => {
    if (event.target.checked) loadLog()
  })
  $('#watchedChips').addEventListener('click', (event) => {
    const chip = event.target.closest('.chip')
    if (!chip) return
    state.filter = chip.dataset.filter
    $$('#watchedChips .chip').forEach((el) => el.classList.toggle('active', el === chip))
    renderWatched()
  })
  setInterval(() => {
    if (document.hidden) return
    loadStatus()
    if (state.activeTab === 'log' && $('#logFollow').checked) loadLog()
  }, 5000)
}

async function boot() {
  wire()
  await loadStatus()
  await loadMe()
  await loadReports()
  if (state.status && !state.status.loggedIn) toast('还没登录 B站，点顶部提示里的「扫码登录」', true)
}

boot()
