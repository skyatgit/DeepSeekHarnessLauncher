// 主面板渲染逻辑
const $ = (id) => document.getElementById(id)

const badgeEl = $('badge')
const statusEl = $('statusDetail')
const stageEl = $('stageDetail')
const listenEl = $('listenInfo')
const urlRow = $('urlRow')
const urlLink = $('urlLink')
const activityEl = $('activity')
const errRow = $('errRow')
const errText = $('errText')
const envList = $('envList')
const btnEnvRefresh = $('btnEnvRefresh')
const stepperEl = $('stepper')
const logBox = $('logBox')
const btnStart = $('btnStart')
const btnStop = $('btnStop')
const btnWeb = $('btnWeb')
const btnUpdate = $('btnUpdate')
const chkAutoStart = $('chkAutoStart')
const chkAutoLogon = $('chkAutoLogon')
const btnLogs = $('btnLogs')
const btnFolder = $('btnFolder')
const btnExit = $('btnExit')

const BADGE_TEXT = {
  stopped: '已停止', provision: '准备环境', fetch: '拉取源码',
  install: '安装依赖', build: '构建中', starting: '启动中',
  running: '运行中', stopping: '停止中', updating: '更新中', error: '出错'
}

// ---------- 节点式步骤条：展示任务步骤与当前进度 ----------
function renderStepper(s) {
  const steps = s.steps || []
  const idx = typeof s.stepIndex === 'number' ? s.stepIndex : -1
  if (idx < 0) {
    stepperEl.style.display = 'none'
    stepperEl.innerHTML = ''
    return
  }
  stepperEl.style.display = 'flex'
  stepperEl.innerHTML = ''
  const failed = !!s.stepFailed
  steps.forEach((name, i) => {
    const node = document.createElement('div')
    node.className = 'step-node'
    if (failed && i === idx) node.classList.add('failed')
    else if (i < idx) node.classList.add('done')
    else if (i === idx) node.classList.add('active')

    const dot = document.createElement('span')
    dot.className = 'step-dot'
    const label = document.createElement('span')
    label.className = 'step-label'
    label.textContent = name
    node.appendChild(dot)
    node.appendChild(label)
    stepperEl.appendChild(node)

    if (i < steps.length - 1) {
      const line = document.createElement('span')
      line.className = 'step-line' + (i < idx ? ' done' : '')
      stepperEl.appendChild(line)
    }
  })
}

function applySnapshot(s) {
  badgeEl.className = 'badge ' + (s.state || 'stopped')
  badgeEl.textContent = BADGE_TEXT[s.state] || s.state || '已停止'
  statusEl.textContent = s.statusText || ''
  stageEl.textContent = s.detail ? ('— ' + s.detail) : ''
  activityEl.textContent = s.lastActivity || '-'
  listenEl.textContent = s.uiUrl || '-'
  if (s.tokenUrl || s.uiUrl) {
    urlRow.style.display = 'flex'
    urlLink.textContent = s.tokenUrl || ('http://' + s.uiUrl)
    urlLink.href = '#'
  } else {
    urlRow.style.display = 'none'
    urlLink.textContent = ''
  }
  if (s.lastError) {
    errRow.style.display = 'block'
    errText.textContent = s.lastError
  } else {
    errRow.style.display = 'none'
    errText.textContent = ''
  }
  const idle = s.state === 'stopped' || s.state === 'error'
  btnStart.disabled = !idle
  btnStop.disabled = !(s.state === 'running' || s.state === 'starting' || s.state === 'stopping')
  btnWeb.disabled = !(s.tokenUrl || s.uiUrl)
  btnUpdate.disabled = !idle
  chkAutoStart.checked = !!s.autoStartDsh
  chkAutoLogon.checked = !!s.openAtLogin
  renderStepper(s)
}

const MAX_LINES = 500
function appendLog(line) {
  const empty = logBox.querySelector('.empty')
  if (empty) empty.remove()
  const div = document.createElement('div')
  div.textContent = line
  logBox.appendChild(div)
  while (logBox.childElementCount > MAX_LINES) logBox.removeChild(logBox.firstChild)
  logBox.scrollTop = logBox.scrollHeight
}

// ---------- 环境依赖列表（每行两项） ----------
function renderEnv(items) {
  envList.innerHTML = ''
  for (const it of items || []) {
    const row = document.createElement('div')
    row.className = 'envrow'

    const line1 = document.createElement('div')
    line1.className = 'line1'
    const name = document.createElement('span')
    name.className = 'envname'
    name.textContent = it.name
    name.title = it.name
    const st = document.createElement('span')
    st.className = 'envst ' + (it.ready ? 'ok' : 'no')
    st.textContent = it.ready ? '就绪' : '未安装'
    line1.appendChild(name)
    line1.appendChild(st)

    const ver = document.createElement('div')
    ver.className = 'envver'
    ver.textContent = (it.version && it.version !== '-') ? it.version : (it.detail || '-')
    ver.title = (it.version && it.version !== '-') ? it.version : (it.detail || '')

    const p = document.createElement('div')
    p.className = 'envpath'
    p.textContent = '📂 ' + it.path
    p.title = '点击在资源管理器中打开'
    p.onclick = () => window.launcher.openPath(it.path)

    row.appendChild(line1)
    row.appendChild(ver)
    row.appendChild(p)
    envList.appendChild(row)
  }
}

btnEnvRefresh.onclick = () => window.launcher.getEnv().then(renderEnv).catch(() => {})
window.launcher.onEnv((items) => renderEnv(items))

btnStart.onclick = () => window.launcher.start()
btnStop.onclick = () => window.launcher.stop()
btnUpdate.onclick = () => window.launcher.update()
btnWeb.onclick = () => window.launcher.openWeb()
urlLink.onclick = (e) => { e.preventDefault(); window.launcher.openWeb() }
btnLogs.onclick = () => window.launcher.openLogs()
btnFolder.onclick = () => window.launcher.openFolder()
btnExit.onclick = () => window.launcher.exit()
chkAutoStart.onchange = () => window.launcher.setAutoStartDsh(chkAutoStart.checked)
chkAutoLogon.onchange = () => window.launcher.setOpenAtLogin(chkAutoLogon.checked)

window.launcher.onState((s) => applySnapshot(s))
window.launcher.onLog((line) => appendLog(line))
window.launcher.getEnv().then(renderEnv).catch(() => {})

window.launcher.getSnapshot().then((s) => {
  applySnapshot(s)
  const lines = s.logLines || []
  for (const line of lines) appendLog(line)
}).catch(() => {})
