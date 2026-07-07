/* ================================================================
   AI WORKFLOW ENGINE — APP LOGIC
   Vanilla JS, ES2022, module pattern via IIFEs. All cross-module
   communication happens through EventBus — no direct coupling.
   Data (forms/providers/agents) lives in external JSON files next
   to index.html and is fetched at startup (see README.md).
   ================================================================ */
'use strict';

/* ---------------------------------------------------------------
   EventBus — lightweight pub/sub.
   --------------------------------------------------------------- */
const EventBus = (() => {
  const listeners = {};
  function on(event, fn){
    (listeners[event] ||= []).push(fn);
    return () => off(event, fn);
  }
  function off(event, fn){
    if(!listeners[event]) return;
    listeners[event] = listeners[event].filter(f => f !== fn);
  }
  function emit(event, payload){
    (listeners[event] || []).slice().forEach(fn => {
      try{ fn(payload); }catch(e){ console.error(`[EventBus:${event}]`, e); }
    });
  }
  return { on, off, emit };
})();

/* ---------------------------------------------------------------
   Utils — small pure helpers shared across modules.
   --------------------------------------------------------------- */
const Utils = (() => {
  function uid(prefix='id'){
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
  }
  function clamp(n,min,max){ return Math.max(min, Math.min(max, n)); }
  function escapeHtml(str){
    if(str === undefined || str === null) return '';
    return String(str).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }
  function formatDate(iso){
    if(!iso) return '—';
    const d = new Date(iso);
    if(isNaN(d)) return '—';
    return d.toLocaleString(undefined, { year:'numeric', month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit' });
  }
  function deepClone(obj){ return JSON.parse(JSON.stringify(obj)); }
  function download(filename, content, mime='text/plain'){
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }
  async function copyToClipboard(text){
    try{
      await navigator.clipboard.writeText(text);
      return true;
    }catch(e){
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position='fixed'; ta.style.opacity='0';
      document.body.appendChild(ta); ta.select();
      let ok = false;
      try{ ok = document.execCommand('copy'); }catch(_){}
      ta.remove();
      return ok;
    }
  }
  function debounce(fn, wait=300){
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
  }
  const LIKERT_LABELS = ['Strongly Disagree','Disagree','Neutral','Agree','Strongly Agree'];
  return { uid, clamp, escapeHtml, formatDate, deepClone, download, copyToClipboard, debounce, LIKERT_LABELS };
})();

/* ---------------------------------------------------------------
   Storage — LocalStorage wrapper with fixed keys.
   --------------------------------------------------------------- */
const Storage = (() => {
  const KEYS = {
    forms: 'workflow.forms',
    responses: 'workflow.responses',
    settings: 'workflow.settings',
    providers: 'workflow.providers',
    agents: 'workflow.agents',
    theme: 'workflow.theme'
  };
  function save(key, value){
    try{
      localStorage.setItem(KEYS[key] || key, JSON.stringify(value));
      EventBus.emit('storage:save', { key });
      return true;
    }catch(e){
      console.error('Storage.save failed', e);
      EventBus.emit('toast:show', { type:'error', message:'Could not save (storage full or blocked).' });
      return false;
    }
  }
  function load(key, fallback=null){
    try{
      const raw = localStorage.getItem(KEYS[key] || key);
      if(raw === null) return fallback;
      const val = JSON.parse(raw);
      EventBus.emit('storage:load', { key });
      return val;
    }catch(e){
      console.error('Storage.load failed', e);
      return fallback;
    }
  }
  function remove(key){ localStorage.removeItem(KEYS[key] || key); }
  function clearAll(){ Object.values(KEYS).forEach(k => localStorage.removeItem(k)); }
  function exportAll(){
    const dump = {};
    Object.entries(KEYS).forEach(([name, key]) => {
      const raw = localStorage.getItem(key);
      if(raw !== null) dump[name] = JSON.parse(raw);
    });
    return dump;
  }
  function importAll(dump){
    Object.entries(dump).forEach(([name, val]) => {
      if(KEYS[name]) save(name, val);
    });
  }
  return { KEYS, save, load, remove, clearAll, exportAll, importAll };
})();

/* ---------------------------------------------------------------
   State — single centralized source of truth.
   --------------------------------------------------------------- */
const State = (() => {
  const state = {
    role: null,                 // 'user' | 'admin'
    route: 'role',              // current top-level screen
    adminSection: 'dashboard',  // active admin sidebar tab
    forms: [],
    activeFormId: null,
    responses: [],
    providers: { active:'offline', providers:[] },
    agents: { globalPrompt:'', agents:[] },
    settings: { theme:'dark', autosave:true, defaultProvider:'offline', defaultAgent:'' },
    theme: 'dark',
    currentWizardStep: 0,
    currentResponse: null,      // response object being filled in the wizard
    builderDraft: null,         // form currently being edited in the Builder
    searchQuery: ''
  };
  function get(){ return state; }
  function patch(partial){ Object.assign(state, partial); }
  function getForm(id){ return state.forms.find(f => f.id === id) || null; }
  return { get, patch, getForm };
})();

/* ---------------------------------------------------------------
   DataLoader — fetches external JSON, falls back to LocalStorage
   overrides made previously by the admin (Builder/Provider/Agent
   changes are persisted locally and take precedence on reload).
   --------------------------------------------------------------- */
const DataLoader = (() => {
  async function fetchJson(path){
    const res = await fetch(path, { cache: 'no-store' });
    if(!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status}`);
    return res.json();
  }
  async function loadForms(){
    const stored = Storage.load('forms');
    if(stored && Array.isArray(stored) && stored.length) return stored;
    try{
      const data = await fetchJson('./forms.json');
      const forms = data.forms || [];
      Storage.save('forms', forms);
      return forms;
    }catch(e){
      console.error('Could not load forms.json', e);
      EventBus.emit('toast:show', { type:'error', message:'Could not load forms.json — make sure it sits next to index.html.' });
      return [];
    }
  }
  async function loadProviders(){
    const stored = Storage.load('providers');
    if(stored && stored.providers && stored.providers.length) return stored;
    try{
      const data = await fetchJson('./providers.json');
      Storage.save('providers', data);
      return data;
    }catch(e){
      console.error('Could not load providers.json', e);
      EventBus.emit('toast:show', { type:'error', message:'Could not load providers.json.' });
      return { active:'offline', providers:[{ id:'offline', name:'Offline', enabled:true }] };
    }
  }
  async function loadAgents(){
    const stored = Storage.load('agents');
    if(stored && stored.agents) return stored;
    try{
      const data = await fetchJson('./agents.json');
      Storage.save('agents', data);
      return data;
    }catch(e){
      console.error('Could not load agents.json', e);
      EventBus.emit('toast:show', { type:'error', message:'Could not load agents.json.' });
      return { globalPrompt:'', agents:[] };
    }
  }
  function loadResponses(){
    return Storage.load('responses', []);
  }
  function loadSettings(){
    return Storage.load('settings', { theme:'dark', autosave:true, defaultProvider:'offline', defaultAgent:'' });
  }
  return { loadForms, loadProviders, loadAgents, loadResponses, loadSettings };
})();

/* ---------------------------------------------------------------
   Toast — small notification popups. Subscribes to 'toast:show'.
   --------------------------------------------------------------- */
const Toast = (() => {
  const ICONS = { success:'✅', error:'⚠️', info:'ℹ️' };
  function init(){
    EventBus.on('toast:show', ({ type='info', message='' }) => show(type, message));
  }
  function show(type, message){
    const stack = document.getElementById('toastStack');
    if(!stack) return;
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span class="t-ic">${ICONS[type] || ICONS.info}</span><span>${Utils.escapeHtml(message)}</span>`;
    stack.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .25s, transform .25s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      setTimeout(() => el.remove(), 260);
    }, 3400);
  }
  return { init, show };
})();

/* ---------------------------------------------------------------
   Modal — generic overlay dialog. Only one modal open at a time.
   --------------------------------------------------------------- */
const Modal = (() => {
  let root = null;
  function open({ title, bodyHtml, footHtml='', onMount=null, width=null }){
    close();
    root = document.createElement('div');
    root.className = 'modal-overlay';
    root.innerHTML = `
      <div class="modal-box" style="${width ? `max-width:${width}` : ''}" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h3>${Utils.escapeHtml(title || '')}</h3>
          <button class="btn btn-icon btn-ghost" data-modal-close aria-label="Close">✕</button>
        </div>
        <div class="modal-body">${bodyHtml}</div>
        ${footHtml ? `<div class="modal-foot">${footHtml}</div>` : ''}
      </div>`;
    document.body.appendChild(root);
    root.addEventListener('mousedown', e => { if(e.target === root) close(); });
    root.querySelector('[data-modal-close]').addEventListener('click', close);
    if(onMount) onMount(root);
    document.addEventListener('keydown', escHandler);
  }
  function escHandler(e){ if(e.key === 'Escape') close(); }
  function close(){
    if(root){ root.remove(); root = null; }
    document.removeEventListener('keydown', escHandler);
  }
  function isOpen(){ return !!root; }
  function confirmDialog({ title, message, confirmText='Confirm', danger=false, onConfirm }){
    open({
      title,
      bodyHtml: `<p style="color:var(--text-dim);font-size:13.5px;line-height:1.6">${Utils.escapeHtml(message)}</p>`,
      footHtml: `
        <button class="btn btn-secondary" data-cancel>Cancel</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok style="${danger ? 'background:var(--danger);color:#fff;border-color:var(--danger)' : ''}">${Utils.escapeHtml(confirmText)}</button>`,
      onMount: (r) => {
        r.querySelector('[data-cancel]').addEventListener('click', close);
        r.querySelector('[data-ok]').addEventListener('click', () => { close(); onConfirm && onConfirm(); });
      }
    });
  }
  return { open, close, isOpen, confirmDialog };
})();

/* ---------------------------------------------------------------
   Theme — dark/light switching, persisted to Storage.
   --------------------------------------------------------------- */
const Theme = (() => {
  function apply(theme){
    const resolved = theme === 'auto'
      ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      : theme;
    document.body.setAttribute('data-theme', resolved);
    State.patch({ theme });
  }
  function toggle(){
    const current = State.get().theme;
    const next = current === 'dark' ? 'light' : 'dark';
    set(next);
  }
  function set(theme){
    apply(theme);
    const settings = State.get().settings;
    settings.theme = theme;
    Storage.save('settings', settings);
    EventBus.emit('toast:show', { type:'info', message:`Theme set to ${theme}` });
  }
  function init(){
    const settings = DataLoader.loadSettings();
    apply(settings.theme || 'dark');
  }
  return { init, apply, toggle, set };
})();

/* ---------------------------------------------------------------
   Router — controls which top-level screen is shown. Renders into
   #app. Actual screen markup is built by the UI module.
   --------------------------------------------------------------- */
const Router = (() => {
  function go(route, extra={}){
    State.patch({ route, ...extra });
    render();
  }
  function render(){
    const { route } = State.get();
    const app = document.getElementById('app');
    if(!app) return;
    if(route === 'role') app.innerHTML = UI.renderRoleScreen();
    else if(route === 'admin') app.innerHTML = UI.renderAdminScreen();
    else if(route === 'user') app.innerHTML = UI.renderUserScreen();
    UI.afterRender(route);
  }
  function init(){
    EventBus.on('role:selected', ({ role }) => {
      State.patch({ role });
      go(role === 'admin' ? 'admin' : 'user');
    });
    EventBus.on('admin:logout', () => go('role', { role:null, adminSection:'dashboard' }));
    render();
  }
  return { init, go, render };
})();

/* ---------------------------------------------------------------
   UI — builds the shell markup for each top-level screen and wires
   up the static, always-present event listeners (nav clicks etc).
   Page-specific bodies (Dashboard, Builder, Wizard...) are supplied
   by their own modules and injected via UI.setPageBody().
   --------------------------------------------------------------- */
const UI = (() => {
  const ADMIN_PASSWORD = '09172079245';
  const ADMIN_NAV = [
    { id:'dashboard', icon:'🏠', label:'Dashboard' },
    { id:'forms', icon:'🧩', label:'Forms' },
    { id:'providers', icon:'🔌', label:'Providers' },
    { id:'agents', icon:'🤖', label:'Agents' },
    { id:'settings', icon:'⚙️', label:'Settings' },
    { id:'preview', icon:'👁️', label:'Preview' },
    { id:'responses', icon:'📋', label:'Responses' }
  ];

  /* ---------- Role selection screen ---------- */
  function renderRoleScreen(){
    return `
      <div class="screen">
        <div class="topbar">
          <div class="brand"><span class="mark">⚙️</span> AI Workflow Engine</div>
          <div class="topbar-actions">
            <button class="btn btn-icon btn-ghost" id="themeToggleBtn" title="Toggle theme">🌓</button>
          </div>
        </div>
        <div class="role-screen">
          <div class="role-hero">
            <div class="eyebrow">Offline-first · Event-driven</div>
            <h1>Structured discovery, powered by your own workflow</h1>
            <p>Build forms once, answer them section by section, and get a clean summary you can act on — with or without AI.</p>
          </div>
          <div class="role-cards">
            <div class="card card-hover role-card" data-role="user">
              <div class="icon">🧑</div>
              <h3>Continue as User</h3>
              <p>Pick a form, answer the wizard, and get your summary. No password needed.</p>
              <span class="go">Start →</span>
            </div>
            <div class="card card-hover role-card" data-role="admin">
              <div class="icon">🛠️</div>
              <h3>Continue as Admin</h3>
              <p>Build and edit forms, configure AI providers and agents, review responses.</p>
              <span class="go">Sign in →</span>
            </div>
          </div>
        </div>
      </div>`;
  }

  function bindRoleScreen(){
    document.getElementById('themeToggleBtn')?.addEventListener('click', Theme.toggle);
    document.querySelectorAll('[data-role]').forEach(card => {
      card.addEventListener('click', () => {
        const role = card.getAttribute('data-role');
        if(role === 'user'){ EventBus.emit('role:selected', { role:'user' }); return; }
        promptAdminPassword();
      });
    });
  }

  function promptAdminPassword(){
    Modal.open({
      title: 'Admin Sign In',
      bodyHtml: `
        <div class="field-row">
          <label for="adminPass">Password</label>
          <input type="password" id="adminPass" placeholder="Enter admin password" autocomplete="off">
        </div>`,
      footHtml: `
        <button class="btn btn-secondary" data-cancel>Cancel</button>
        <button class="btn btn-primary" id="adminLoginBtn">Sign In</button>`,
      onMount: (root) => {
        const input = root.querySelector('#adminPass');
        input.focus();
        const attempt = () => {
          if(input.value === ADMIN_PASSWORD){
            Modal.close();
            EventBus.emit('admin:login', {});
            EventBus.emit('role:selected', { role:'admin' });
          } else {
            EventBus.emit('toast:show', { type:'error', message:'Incorrect password.' });
          }
        };
        root.querySelector('#adminLoginBtn').addEventListener('click', attempt);
        input.addEventListener('keydown', e => { if(e.key === 'Enter') attempt(); });
        root.querySelector('[data-cancel]').addEventListener('click', Modal.close);
      }
    });
  }

  /* ---------- Admin screen shell ---------- */
  function renderAdminScreen(){
    const { adminSection } = State.get();
    const navHtml = ADMIN_NAV.map(n => `
      <div class="nav-item ${adminSection === n.id ? 'active' : ''}" data-nav="${n.id}">
        <span class="ic">${n.icon}</span><span>${n.label}</span>
      </div>`).join('');
    return `
      <div class="screen">
        <div class="topbar">
          <div class="brand"><span class="mark">⚙️</span> AI Workflow Engine <span class="tag" style="margin-left:6px">Admin</span></div>
          <div class="topbar-actions">
            <button class="btn btn-icon btn-ghost" id="themeToggleBtn" title="Toggle theme">🌓</button>
            <button class="btn btn-secondary btn-sm" id="logoutBtn">Log Out</button>
          </div>
        </div>
        <div class="admin-layout">
          <div class="sidebar">
            ${navHtml}
            <div class="sidebar-spacer"></div>
          </div>
          <div class="main-panel" id="adminMain"></div>
        </div>
      </div>`;
  }

  function bindAdminScreen(){
    document.getElementById('themeToggleBtn')?.addEventListener('click', Theme.toggle);
    document.getElementById('logoutBtn')?.addEventListener('click', () => EventBus.emit('admin:logout', {}));
    document.querySelectorAll('[data-nav]').forEach(item => {
      item.addEventListener('click', () => {
        State.patch({ adminSection: item.getAttribute('data-nav') });
        Router.render();
      });
    });
    renderAdminSectionBody();
  }

  function renderAdminSectionBody(){
    const main = document.getElementById('adminMain');
    if(!main) return;
    const { adminSection } = State.get();
    if(adminSection === 'dashboard') main.innerHTML = AdminPages.renderDashboard();
    else if(adminSection === 'forms') main.innerHTML = AdminPages.renderForms();
    else if(adminSection === 'providers') main.innerHTML = AdminPages.renderProviders();
    else if(adminSection === 'agents') main.innerHTML = AdminPages.renderAgents();
    else if(adminSection === 'settings') main.innerHTML = AdminPages.renderSettings();
    else if(adminSection === 'preview') main.innerHTML = AdminPages.renderPreview();
    else if(adminSection === 'responses') main.innerHTML = AdminPages.renderResponses();
    AdminPages.afterRender(adminSection);
  }

  /* ---------- User screen shell ---------- */
  function renderUserScreen(){
    return `
      <div class="screen">
        <div class="topbar">
          <div class="brand"><span class="mark">⚙️</span> AI Workflow Engine</div>
          <div class="topbar-actions">
            <button class="btn btn-icon btn-ghost" id="themeToggleBtn" title="Toggle theme">🌓</button>
            <button class="btn btn-secondary btn-sm" id="backToRoleBtn">Exit</button>
          </div>
        </div>
        <div class="main-panel" id="userMain" style="max-width:1100px;margin:0 auto;width:100%"></div>
      </div>`;
  }

  function bindUserScreen(){
    document.getElementById('themeToggleBtn')?.addEventListener('click', Theme.toggle);
    document.getElementById('backToRoleBtn')?.addEventListener('click', () => Router.go('role', { role:null }));
    UserFlow.renderCurrentStep();
  }

  /* ---------- dispatch after every render ---------- */
  function afterRender(route){
    if(route === 'role') bindRoleScreen();
    else if(route === 'admin') bindAdminScreen();
    else if(route === 'user') bindUserScreen();
  }

  return { renderRoleScreen, renderAdminScreen, renderUserScreen, afterRender, renderAdminSectionBody, ADMIN_NAV };
})();

/* ---------------------------------------------------------------
   FormEngine — CRUD helpers over State.forms. Every mutation saves
   to Storage and emits the matching event. No UI code here.
   --------------------------------------------------------------- */
const FormEngine = (() => {
  function all(){ return State.get().forms; }
  function get(id){ return State.getForm(id); }
  function persist(){ Storage.save('forms', State.get().forms); }

  function createForm(partial={}){
    const now = new Date().toISOString();
    const form = {
      id: Utils.uid('form'),
      title: partial.title || 'Untitled Form',
      description: partial.description || '',
      icon: partial.icon || '📄',
      color: partial.color || '#6366f1',
      version: '1.0',
      category: partial.category || 'General',
      tags: partial.tags || [],
      createdAt: now,
      updatedAt: now,
      sections: []
    };
    State.get().forms.push(form);
    persist();
    EventBus.emit('form:create', { form });
    return form;
  }

  function updateForm(id, patch){
    const form = get(id);
    if(!form) return null;
    Object.assign(form, patch, { updatedAt: new Date().toISOString() });
    persist();
    EventBus.emit('form:update', { form });
    return form;
  }

  function deleteForm(id){
    const forms = State.get().forms;
    const idx = forms.findIndex(f => f.id === id);
    if(idx === -1) return false;
    forms.splice(idx, 1);
    persist();
    EventBus.emit('form:delete', { id });
    return true;
  }

  function duplicateForm(id){
    const src = get(id);
    if(!src) return null;
    const now = new Date().toISOString();
    const copy = Utils.deepClone(src);
    copy.id = Utils.uid('form');
    copy.title = `${src.title} (Copy)`;
    copy.createdAt = now;
    copy.updatedAt = now;
    copy.sections.forEach(sec => {
      sec.id = Utils.uid('sec');
      sec.questions.forEach(q => { q.id = Utils.uid('q'); });
    });
    State.get().forms.push(copy);
    persist();
    EventBus.emit('form:duplicate', { form: copy });
    return copy;
  }

  function validateForm(form){
    const errors = [];
    if(!form.title || !form.title.trim()) errors.push('Form title cannot be empty.');
    if(!form.sections || !form.sections.length) errors.push('Form must have at least one section.');
    (form.sections || []).forEach((sec, i) => {
      if(!sec.title || !sec.title.trim()) errors.push(`Section ${i+1} needs a title.`);
      if(!sec.questions || !sec.questions.length) errors.push(`Section "${sec.title || i+1}" needs at least one question.`);
      (sec.questions || []).forEach((q, qi) => {
        if(!q.title || !q.title.trim()) errors.push(`Question ${qi+1} in "${sec.title}" needs a title.`);
      });
    });
    const ids = new Set();
    (form.sections || []).forEach(sec => {
      (sec.questions || []).forEach(q => {
        if(ids.has(q.id)) errors.push(`Duplicate question id: ${q.id}`);
        ids.add(q.id);
      });
    });
    return errors;
  }

  function importFormJson(jsonStr){
    let data;
    try{ data = JSON.parse(jsonStr); }
    catch(e){ return { ok:false, error:'Invalid JSON syntax.' }; }
    const form = data.forms ? data.forms[0] : data;
    if(!form || typeof form !== 'object') return { ok:false, error:'JSON does not contain a valid form object.' };
    form.id = form.id || Utils.uid('form');
    form.sections = form.sections || [];
    const errors = validateForm(form);
    if(errors.length) return { ok:false, error: errors.join(' ') };
    form.createdAt = form.createdAt || new Date().toISOString();
    form.updatedAt = new Date().toISOString();
    State.get().forms.push(form);
    persist();
    EventBus.emit('form:import', { form });
    return { ok:true, form };
  }

  function exportFormJson(id){
    const form = get(id);
    if(!form) return null;
    EventBus.emit('form:export', { id });
    return JSON.stringify({ forms:[form] }, null, 2);
  }

  /* ---- Section helpers ---- */
  function addSection(formId){
    const form = get(formId);
    if(!form) return null;
    const section = { id: Utils.uid('sec'), title:'New Section', description:'', summaryTemplate:'', aiPrompt:'', questions:[] };
    form.sections.push(section);
    persist();
    EventBus.emit('section:create', { formId, section });
    return section;
  }
  function updateSection(formId, sectionId, patch){
    const form = get(formId);
    const sec = form?.sections.find(s => s.id === sectionId);
    if(!sec) return null;
    Object.assign(sec, patch);
    form.updatedAt = new Date().toISOString();
    persist();
    EventBus.emit('section:update', { formId, section: sec });
    return sec;
  }
  function deleteSection(formId, sectionId){
    const form = get(formId);
    if(!form) return false;
    form.sections = form.sections.filter(s => s.id !== sectionId);
    persist();
    EventBus.emit('form:update', { form });
    return true;
  }
  function moveSection(formId, sectionId, dir){
    const form = get(formId);
    if(!form) return;
    const i = form.sections.findIndex(s => s.id === sectionId);
    const j = i + dir;
    if(i === -1 || j < 0 || j >= form.sections.length) return;
    [form.sections[i], form.sections[j]] = [form.sections[j], form.sections[i]];
    persist();
    EventBus.emit('form:update', { form });
  }
  function duplicateSection(formId, sectionId){
    const form = get(formId);
    const sec = form?.sections.find(s => s.id === sectionId);
    if(!sec) return null;
    const copy = Utils.deepClone(sec);
    copy.id = Utils.uid('sec');
    copy.title = `${sec.title} (Copy)`;
    copy.questions.forEach(q => q.id = Utils.uid('q'));
    const idx = form.sections.findIndex(s => s.id === sectionId);
    form.sections.splice(idx + 1, 0, copy);
    persist();
    EventBus.emit('form:update', { form });
    return copy;
  }

  /* ---- Question helpers ---- */
  function addQuestion(formId, sectionId, type='text'){
    const form = get(formId);
    const sec = form?.sections.find(s => s.id === sectionId);
    if(!sec) return null;
    const q = {
      id: Utils.uid('q'), type, title:'New Question', description:'', placeholder:'',
      required:false, hint:'', weight:1, tags:[], defaultValue:'', questionPrompt:'', aiEnabled:false
    };
    sec.questions.push(q);
    persist();
    EventBus.emit('question:create', { formId, sectionId, question:q });
    return q;
  }
  function updateQuestion(formId, sectionId, questionId, patch){
    const form = get(formId);
    const sec = form?.sections.find(s => s.id === sectionId);
    const q = sec?.questions.find(q => q.id === questionId);
    if(!q) return null;
    Object.assign(q, patch);
    persist();
    EventBus.emit('question:update', { formId, sectionId, question:q });
    return q;
  }
  function deleteQuestion(formId, sectionId, questionId){
    const form = get(formId);
    const sec = form?.sections.find(s => s.id === sectionId);
    if(!sec) return false;
    sec.questions = sec.questions.filter(q => q.id !== questionId);
    persist();
    EventBus.emit('form:update', { form });
    return true;
  }
  function moveQuestion(formId, sectionId, questionId, dir){
    const form = get(formId);
    const sec = form?.sections.find(s => s.id === sectionId);
    if(!sec) return;
    const i = sec.questions.findIndex(q => q.id === questionId);
    const j = i + dir;
    if(i === -1 || j < 0 || j >= sec.questions.length) return;
    [sec.questions[i], sec.questions[j]] = [sec.questions[j], sec.questions[i]];
    persist();
    EventBus.emit('form:update', { form });
  }
  function duplicateQuestion(formId, sectionId, questionId){
    const form = get(formId);
    const sec = form?.sections.find(s => s.id === sectionId);
    const q = sec?.questions.find(q => q.id === questionId);
    if(!q) return null;
    const copy = Utils.deepClone(q);
    copy.id = Utils.uid('q');
    copy.title = `${q.title} (Copy)`;
    const idx = sec.questions.findIndex(x => x.id === questionId);
    sec.questions.splice(idx + 1, 0, copy);
    persist();
    EventBus.emit('form:update', { form });
    return copy;
  }

  return {
    all, get, createForm, updateForm, deleteForm, duplicateForm, validateForm,
    importFormJson, exportFormJson,
    addSection, updateSection, deleteSection, moveSection, duplicateSection,
    addQuestion, updateQuestion, deleteQuestion, moveQuestion, duplicateQuestion
  };
})();

/* ---------------------------------------------------------------
   AdminPages — renders the body for each admin sidebar tab.
   Builder-specific rendering lives in the Builder module; this
   module renders Dashboard, Forms list, Providers, Agents,
   Settings, Preview and Responses, then delegates to Builder when
   a form is opened for editing.
   --------------------------------------------------------------- */
const AdminPages = (() => {

  /* ---------- Dashboard ---------- */
  function renderDashboard(){
    const { forms, responses } = State.get();
    const completed = responses.filter(r => r.completedAt).length;
    const rate = responses.length ? Math.round((completed / responses.length) * 100) : 0;
    return `
      <div class="page-head"><div><h2>Dashboard</h2><p>Overview of your workflow engine.</p></div></div>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr))">
        ${statCard('🧩', forms.length, 'Forms created')}
        ${statCard('📋', responses.length, 'Responses collected')}
        ${statCard('✅', `${rate}%`, 'Completion rate')}
        ${statCard('🤖', State.get().providers.active, 'Active provider')}
      </div>
      <div class="divider"></div>
      <div class="page-head"><div><h2 style="font-size:16px">Recent Responses</h2></div></div>
      ${responses.length
        ? responses.slice(-5).reverse().map(r => responseRow(r)).join('')
        : `<div class="empty-state"><div class="ic">📭</div><h3>No responses yet</h3><p>Once someone completes a form as a User, it will show up here.</p></div>`}
    `;
  }
  function statCard(icon, value, label){
    return `<div class="card"><div style="font-size:22px">${icon}</div>
      <div style="font-size:22px;font-weight:800;margin-top:8px">${Utils.escapeHtml(String(value))}</div>
      <div style="font-size:12.5px;color:var(--text-dim);margin-top:2px">${label}</div></div>`;
  }
  function responseRow(r){
    const form = FormEngine.get(r.formId);
    return `<div class="card response-item" style="margin-bottom:10px" data-view-response="${r.id}">
      <div class="r-top">
        <strong style="font-size:13.5px">${Utils.escapeHtml(form?.title || 'Deleted form')}</strong>
        <span class="tag">${r.completedAt ? 'Completed' : 'In progress'}</span>
      </div>
      <div style="font-size:12px;color:var(--text-faint)">${Utils.formatDate(r.startedAt)}</div>
    </div>`;
  }

  /* ---------- Forms list ---------- */
  function renderForms(){
    const { forms } = State.get();
    const cards = forms.map(f => `
      <div class="card card-hover form-card" data-open-form="${f.id}">
        <div class="fc-actions">
          <button class="btn btn-icon btn-ghost btn-sm" data-dup-form="${f.id}" title="Duplicate">⧉</button>
          <button class="btn btn-icon btn-ghost btn-sm" data-export-form="${f.id}" title="Export JSON">⭳</button>
          <button class="btn btn-icon btn-ghost btn-sm" data-del-form="${f.id}" title="Delete">🗑</button>
        </div>
        <div class="fc-icon" style="background:${f.color}22;color:${f.color}">${f.icon}</div>
        <h4>${Utils.escapeHtml(f.title)}</h4>
        <p>${Utils.escapeHtml(f.description || '')}</p>
        <div class="fc-meta"><span class="tag">${f.sections.length} sections</span><span class="tag">${f.category || 'General'}</span></div>
      </div>`).join('');
    return `
      <div class="page-head">
        <div><h2>Forms</h2><p>Create and manage the forms Users will fill in.</p></div>
        <div class="page-head-actions">
          <button class="btn btn-secondary" id="importFormBtn">Import JSON</button>
          <button class="btn btn-primary" id="newFormBtn">+ New Form</button>
        </div>
      </div>
      ${forms.length ? `<div class="grid">${cards}</div>` : `
        <div class="empty-state"><div class="ic">🧩</div><h3>No forms yet</h3><p>Create your first form or import one from JSON.</p></div>`}
    `;
  }

  function bindForms(){
    document.getElementById('newFormBtn')?.addEventListener('click', () => {
      const form = FormEngine.createForm({ title:'Untitled Form' });
      openBuilder(form.id);
    });
    document.getElementById('importFormBtn')?.addEventListener('click', showImportModal);
    document.querySelectorAll('[data-open-form]').forEach(el => {
      el.addEventListener('click', (e) => {
        if(e.target.closest('[data-dup-form],[data-export-form],[data-del-form]')) return;
        openBuilder(el.getAttribute('data-open-form'));
      });
    });
    document.querySelectorAll('[data-dup-form]').forEach(el => el.addEventListener('click', () => {
      FormEngine.duplicateForm(el.getAttribute('data-dup-form'));
      EventBus.emit('toast:show', { type:'success', message:'Form duplicated.' });
      UI.renderAdminSectionBody();
    }));
    document.querySelectorAll('[data-export-form]').forEach(el => el.addEventListener('click', () => {
      const id = el.getAttribute('data-export-form');
      const json = FormEngine.exportFormJson(id);
      const form = FormEngine.get(id);
      Utils.download(`${(form.title || 'form').toLowerCase().replace(/\s+/g,'-')}.json`, json, 'application/json');
      EventBus.emit('toast:show', { type:'success', message:'Form exported.' });
    }));
    document.querySelectorAll('[data-del-form]').forEach(el => el.addEventListener('click', () => {
      const id = el.getAttribute('data-del-form');
      const form = FormEngine.get(id);
      Modal.confirmDialog({
        title:'Delete form?', danger:true, confirmText:'Delete',
        message:`This will permanently delete "${form.title}" and cannot be undone.`,
        onConfirm: () => { FormEngine.deleteForm(id); EventBus.emit('toast:show', { type:'success', message:'Form deleted.' }); UI.renderAdminSectionBody(); }
      });
    }));
  }

  function showImportModal(){
    Modal.open({
      title:'Import Form JSON',
      bodyHtml: `
        <div class="field-row">
          <label>Paste form JSON</label>
          <textarea id="importJsonArea" style="min-height:180px;font-family:var(--font-mono);font-size:12px" placeholder='{"title":"...","sections":[...]}'></textarea>
          <span class="hint">Must match the app's form schema. Invalid files will be rejected with an explanation.</span>
        </div>`,
      footHtml: `<button class="btn btn-secondary" data-cancel>Cancel</button><button class="btn btn-primary" id="doImportBtn">Import</button>`,
      onMount: (root) => {
        root.querySelector('[data-cancel]').addEventListener('click', Modal.close);
        root.querySelector('#doImportBtn').addEventListener('click', () => {
          const val = root.querySelector('#importJsonArea').value;
          const result = FormEngine.importFormJson(val);
          if(result.ok){
            Modal.close();
            EventBus.emit('toast:show', { type:'success', message:`Imported "${result.form.title}".` });
            UI.renderAdminSectionBody();
          } else {
            EventBus.emit('toast:show', { type:'error', message: result.error });
          }
        });
      }
    });
  }

  function openBuilder(formId){
    State.patch({ activeFormId: formId, adminSection:'forms-builder' });
    UI.renderAdminSectionBody();
  }

  /* ---------- dispatch ---------- */
  function afterRender(section){
    if(section === 'dashboard') document.querySelectorAll('[data-view-response]').forEach(el => el.addEventListener('click', () => {
      State.patch({ adminSection:'responses' });
      UI.renderAdminSectionBody();
    }));
    else if(section === 'forms') bindForms();
    else if(section === 'forms-builder') Builder.bind();
    else if(section === 'providers') Providers.bind();
    else if(section === 'agents') Agents.bind();
    else if(section === 'settings') SettingsPage.bind();
    else if(section === 'preview') PreviewPage.bind();
    else if(section === 'responses') ResponsesPage.bind();
  }

  function renderForms_or_Builder(){
    const { adminSection, activeFormId } = State.get();
    if(adminSection === 'forms-builder' && activeFormId) return Builder.render(activeFormId);
    return renderForms();
  }

  return {
    renderDashboard,
    renderForms: renderForms_or_Builder,
    renderProviders: () => Providers.render(),
    renderAgents: () => Agents.render(),
    renderSettings: () => SettingsPage.render(),
    renderPreview: () => PreviewPage.render(),
    renderResponses: () => ResponsesPage.render(),
    afterRender, openBuilder
  };
})();

/* ---------------------------------------------------------------
   Builder — visual, no-code Form/Section/Question builder with a
   live preview pane. The admin never edits JSON directly here.
   --------------------------------------------------------------- */
const Builder = (() => {
  const COLORS = ['#6366f1','#8b5cf6','#ec4899','#f59e0b','#10b981','#06b6d4','#ef4444'];
  const QUESTION_TYPES = [
    { id:'text', label:'Short Text' },
    { id:'textarea', label:'Long Text' },
    { id:'likert', label:'Likert 1-5' }
  ];

  function render(formId){
    const form = FormEngine.get(formId);
    if(!form) return `<div class="empty-state"><div class="ic">⚠️</div><h3>Form not found</h3></div>`;
    return `
      <div class="page-head">
        <div>
          <button class="btn btn-ghost btn-sm" id="backToFormsBtn" style="margin-bottom:8px">← Back to Forms</button>
          <h2>${Utils.escapeHtml(form.title)}</h2>
          <p>Build sections and questions visually — everything is saved automatically.</p>
        </div>
        <div class="page-head-actions">
          <button class="btn btn-secondary" id="validateFormBtn">Validate</button>
          <button class="btn btn-primary" id="exportBuilderFormBtn">Export JSON</button>
        </div>
      </div>
      <div class="builder-layout">
        <div class="builder-col">
          ${renderFormInfoCard(form)}
          <div id="sectionsWrap">${renderSections(form)}</div>
          <button class="btn btn-secondary btn-block" id="addSectionBtn">+ Add Section</button>
        </div>
        <div class="preview-col">
          <div class="preview-frame">
            <h3>Live Preview</h3>
            ${Renderer.renderFormPreview(form)}
          </div>
        </div>
      </div>`;
  }

  function renderFormInfoCard(form){
    return `
      <div class="card">
        <div class="field-row">
          <label>Title</label>
          <input type="text" id="fTitle" value="${Utils.escapeHtml(form.title)}" placeholder="Form title">
        </div>
        <div class="field-row">
          <label>Description</label>
          <textarea id="fDesc" placeholder="What is this form for?">${Utils.escapeHtml(form.description)}</textarea>
        </div>
        <div class="field-2col">
          <div class="field-row">
            <label>Icon (emoji)</label>
            <input type="text" id="fIcon" value="${Utils.escapeHtml(form.icon)}" maxlength="4">
          </div>
          <div class="field-row">
            <label>Category</label>
            <input type="text" id="fCategory" value="${Utils.escapeHtml(form.category || '')}">
          </div>
        </div>
        <div class="field-row">
          <label>Theme Color</label>
          <div class="color-swatches">
            ${COLORS.map(c => `<div class="swatch ${form.color === c ? 'active' : ''}" style="background:${c}" data-color="${c}"></div>`).join('')}
          </div>
        </div>
        <div class="field-row">
          <label>Tags (comma separated)</label>
          <input type="text" id="fTags" value="${Utils.escapeHtml((form.tags||[]).join(', '))}">
        </div>
      </div>`;
  }

  function renderSections(form){
    if(!form.sections.length) return `<div class="empty-state"><div class="ic">📂</div><h3>No sections yet</h3><p>Add a section to start adding questions.</p></div>`;
    return form.sections.map((sec, i) => `
      <div class="section-block" data-section="${sec.id}">
        <div class="section-head" data-toggle-section="${sec.id}">
          <span class="drag">⋮⋮</span>
          <strong>${Utils.escapeHtml(sec.title)}</strong>
          <span class="count">${sec.questions.length} question${sec.questions.length===1?'':'s'}</span>
          <div class="sec-actions" onclick="event.stopPropagation()">
            <button class="btn btn-icon btn-ghost btn-sm" data-move-sec-up="${sec.id}" ${i===0?'disabled':''} title="Move up">↑</button>
            <button class="btn btn-icon btn-ghost btn-sm" data-move-sec-down="${sec.id}" ${i===form.sections.length-1?'disabled':''} title="Move down">↓</button>
            <button class="btn btn-icon btn-ghost btn-sm" data-dup-sec="${sec.id}" title="Duplicate">⧉</button>
            <button class="btn btn-icon btn-ghost btn-sm" data-del-sec="${sec.id}" title="Delete">🗑</button>
          </div>
        </div>
        <div class="section-body" data-section-body="${sec.id}">
          <div class="field-row"><label>Section Title</label><input type="text" data-sec-field="title" data-sec-id="${sec.id}" value="${Utils.escapeHtml(sec.title)}"></div>
          <div class="field-row"><label>Description</label><textarea data-sec-field="description" data-sec-id="${sec.id}">${Utils.escapeHtml(sec.description)}</textarea></div>
          <div class="field-row"><label>Summary Template</label><textarea data-sec-field="summaryTemplate" data-sec-id="${sec.id}" placeholder="e.g. The founder describes the problem as: {{answers}}">${Utils.escapeHtml(sec.summaryTemplate)}</textarea><span class="hint">Used by the offline Summary Engine. Use {{answers}} as a placeholder.</span></div>
          <div class="field-row"><label>AI Prompt (optional)</label><textarea data-sec-field="aiPrompt" data-sec-id="${sec.id}" placeholder="Instruction for AI when analyzing this section">${Utils.escapeHtml(sec.aiPrompt)}</textarea></div>
          <div class="divider"></div>
          ${sec.questions.map((q, qi) => renderQuestionRow(form.id, sec, q, qi)).join('')}
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            ${QUESTION_TYPES.map(t => `<button class="btn btn-secondary btn-sm" data-add-q="${sec.id}" data-q-type="${t.id}">+ ${t.label}</button>`).join('')}
          </div>
        </div>
      </div>`).join('');
  }

  function renderQuestionRow(formId, sec, q, i){
    const typeLabel = QUESTION_TYPES.find(t => t.id === q.type)?.label || q.type;
    return `
      <div class="question-row" data-question="${q.id}">
        <div class="q-top" data-toggle-q="${q.id}">
          <span class="q-type-badge">${typeLabel}</span>
          <strong>${Utils.escapeHtml(q.title)}</strong>
          <div class="q-actions" onclick="event.stopPropagation()">
            <button class="btn btn-icon btn-ghost btn-sm" data-move-q-up="${q.id}" data-sec-id="${sec.id}" ${i===0?'disabled':''}>↑</button>
            <button class="btn btn-icon btn-ghost btn-sm" data-move-q-down="${q.id}" data-sec-id="${sec.id}" ${i===sec.questions.length-1?'disabled':''}>↓</button>
            <button class="btn btn-icon btn-ghost btn-sm" data-dup-q="${q.id}" data-sec-id="${sec.id}">⧉</button>
            <button class="btn btn-icon btn-ghost btn-sm" data-del-q="${q.id}" data-sec-id="${sec.id}">🗑</button>
          </div>
        </div>
        <div class="q-detail" data-q-detail="${q.id}">
          <div class="field-row"><label>Title</label><input type="text" data-q-field="title" data-q-id="${q.id}" data-sec-id="${sec.id}" value="${Utils.escapeHtml(q.title)}"></div>
          <div class="field-row"><label>Description</label><input type="text" data-q-field="description" data-q-id="${q.id}" data-sec-id="${sec.id}" value="${Utils.escapeHtml(q.description)}"></div>
          <div class="field-2col">
            <div class="field-row"><label>Placeholder</label><input type="text" data-q-field="placeholder" data-q-id="${q.id}" data-sec-id="${sec.id}" value="${Utils.escapeHtml(q.placeholder)}"></div>
            <div class="field-row"><label>Weight</label><input type="number" min="1" max="5" data-q-field="weight" data-q-id="${q.id}" data-sec-id="${sec.id}" value="${q.weight||1}"></div>
          </div>
          <div class="field-row"><label>Hint</label><input type="text" data-q-field="hint" data-q-id="${q.id}" data-sec-id="${sec.id}" value="${Utils.escapeHtml(q.hint)}"></div>
          <div class="field-row"><label>Tags (comma separated)</label><input type="text" data-q-field="tags" data-q-id="${q.id}" data-sec-id="${sec.id}" value="${Utils.escapeHtml((q.tags||[]).join(', '))}"></div>
          <div class="field-row"><label>Question Prompt (optional, for AI)</label><input type="text" data-q-field="questionPrompt" data-q-id="${q.id}" data-sec-id="${sec.id}" value="${Utils.escapeHtml(q.questionPrompt)}"></div>
          <label class="checkbox-row"><input type="checkbox" data-q-field="required" data-q-id="${q.id}" data-sec-id="${sec.id}" ${q.required?'checked':''}> Required</label>
          <label class="checkbox-row"><input type="checkbox" data-q-field="aiEnabled" data-q-id="${q.id}" data-sec-id="${sec.id}" ${q.aiEnabled?'checked':''}> Show ✨ AI Assist button in wizard</label>
        </div>
      </div>`;
  }

  /* ---------- binding ---------- */
  function bind(){
    const { activeFormId: formId } = State.get();
    const form = FormEngine.get(formId);
    if(!form) return;

    document.getElementById('backToFormsBtn')?.addEventListener('click', () => {
      State.patch({ adminSection:'forms', activeFormId:null });
      UI.renderAdminSectionBody();
    });
    document.getElementById('validateFormBtn')?.addEventListener('click', () => {
      const errors = FormEngine.validateForm(form);
      if(!errors.length) EventBus.emit('toast:show', { type:'success', message:'Form is valid.' });
      else EventBus.emit('toast:show', { type:'error', message: errors[0] });
    });
    document.getElementById('exportBuilderFormBtn')?.addEventListener('click', () => {
      const json = FormEngine.exportFormJson(formId);
      Utils.download(`${form.title.toLowerCase().replace(/\s+/g,'-')}.json`, json, 'application/json');
      EventBus.emit('toast:show', { type:'success', message:'Form exported.' });
    });
    document.getElementById('addSectionBtn')?.addEventListener('click', () => {
      FormEngine.addSection(formId);
      refresh();
    });

    // form info fields
    bindField('fTitle','input', v => FormEngine.updateForm(formId, { title:v }));
    bindField('fDesc','input', v => FormEngine.updateForm(formId, { description:v }));
    bindField('fIcon','input', v => FormEngine.updateForm(formId, { icon:v }));
    bindField('fCategory','input', v => FormEngine.updateForm(formId, { category:v }));
    bindField('fTags','input', v => FormEngine.updateForm(formId, { tags: v.split(',').map(s=>s.trim()).filter(Boolean) }));
    document.querySelectorAll('[data-color]').forEach(el => el.addEventListener('click', () => {
      FormEngine.updateForm(formId, { color: el.getAttribute('data-color') });
      refresh();
    }));

    // section toggle + actions
    document.querySelectorAll('[data-toggle-section]').forEach(el => el.addEventListener('click', (e) => {
      if(e.target.closest('.sec-actions')) return;
      const id = el.getAttribute('data-toggle-section');
      document.querySelector(`[data-section-body="${id}"]`)?.classList.toggle('collapsed');
    }));
    document.querySelectorAll('[data-move-sec-up]').forEach(el => el.addEventListener('click', () => { FormEngine.moveSection(formId, el.getAttribute('data-move-sec-up'), -1); refresh(); }));
    document.querySelectorAll('[data-move-sec-down]').forEach(el => el.addEventListener('click', () => { FormEngine.moveSection(formId, el.getAttribute('data-move-sec-down'), 1); refresh(); }));
    document.querySelectorAll('[data-dup-sec]').forEach(el => el.addEventListener('click', () => { FormEngine.duplicateSection(formId, el.getAttribute('data-dup-sec')); refresh(); }));
    document.querySelectorAll('[data-del-sec]').forEach(el => el.addEventListener('click', () => {
      const id = el.getAttribute('data-del-sec');
      Modal.confirmDialog({ title:'Delete section?', danger:true, confirmText:'Delete', message:'All questions in this section will be removed.',
        onConfirm: () => { FormEngine.deleteSection(formId, id); refresh(); } });
    }));

    // section field inputs
    document.querySelectorAll('[data-sec-field]').forEach(el => {
      const handler = Utils.debounce(() => {
        const secId = el.getAttribute('data-sec-id');
        const field = el.getAttribute('data-sec-field');
        FormEngine.updateSection(formId, secId, { [field]: el.value });
        refreshPreviewOnly();
      }, 250);
      el.addEventListener('input', handler);
    });

    // add question buttons
    document.querySelectorAll('[data-add-q]').forEach(el => el.addEventListener('click', () => {
      FormEngine.addQuestion(formId, el.getAttribute('data-add-q'), el.getAttribute('data-q-type'));
      refresh();
    }));

    // question toggle + actions
    document.querySelectorAll('[data-toggle-q]').forEach(el => el.addEventListener('click', (e) => {
      if(e.target.closest('.q-actions')) return;
      const id = el.getAttribute('data-toggle-q');
      document.querySelector(`[data-q-detail="${id}"]`)?.classList.toggle('open');
    }));
    document.querySelectorAll('[data-move-q-up]').forEach(el => el.addEventListener('click', () => { FormEngine.moveQuestion(formId, el.getAttribute('data-sec-id'), el.getAttribute('data-move-q-up'), -1); refresh(); }));
    document.querySelectorAll('[data-move-q-down]').forEach(el => el.addEventListener('click', () => { FormEngine.moveQuestion(formId, el.getAttribute('data-sec-id'), el.getAttribute('data-move-q-down'), 1); refresh(); }));
    document.querySelectorAll('[data-dup-q]').forEach(el => el.addEventListener('click', () => { FormEngine.duplicateQuestion(formId, el.getAttribute('data-sec-id'), el.getAttribute('data-dup-q')); refresh(); }));
    document.querySelectorAll('[data-del-q]').forEach(el => el.addEventListener('click', () => {
      FormEngine.deleteQuestion(formId, el.getAttribute('data-sec-id'), el.getAttribute('data-del-q'));
      refresh();
    }));

    // question field inputs
    document.querySelectorAll('[data-q-field]').forEach(el => {
      const isCheckbox = el.type === 'checkbox';
      const handler = Utils.debounce(() => {
        const secId = el.getAttribute('data-sec-id');
        const qId = el.getAttribute('data-q-id');
        const field = el.getAttribute('data-q-field');
        let value = isCheckbox ? el.checked : el.value;
        if(field === 'tags') value = el.value.split(',').map(s=>s.trim()).filter(Boolean);
        if(field === 'weight') value = Utils.clamp(parseInt(el.value)||1, 1, 5);
        FormEngine.updateQuestion(formId, secId, qId, { [field]: value });
        refreshPreviewOnly();
      }, isCheckbox ? 0 : 250);
      el.addEventListener(isCheckbox ? 'change' : 'input', handler);
    });
  }

  function bindField(id, evt, cb){
    const el = document.getElementById(id);
    if(!el) return;
    el.addEventListener(evt, Utils.debounce(() => { cb(el.value); refreshPreviewOnly(); }, 250));
  }

  function refresh(){ UI.renderAdminSectionBody(); }
  function refreshPreviewOnly(){
    const form = FormEngine.get(State.get().activeFormId);
    const frame = document.querySelector('.preview-frame');
    if(frame && form) frame.innerHTML = `<h3>Live Preview</h3>${Renderer.renderFormPreview(form)}`;
    const countEls = document.querySelectorAll('[data-section]');
    countEls.forEach(sec => {
      const s = form.sections.find(x => x.id === sec.getAttribute('data-section'));
      if(s){ const c = sec.querySelector('.count'); if(c) c.textContent = `${s.questions.length} question${s.questions.length===1?'':'s'}`; }
    });
  }

  return { render, bind, QUESTION_TYPES };
})();

/* ---------------------------------------------------------------
   Renderer — renders questions/sections from JSON. Shared by the
   Builder's live preview and the real Wizard, so adding a new
   question type later only means touching this one module.
   --------------------------------------------------------------- */
const Renderer = (() => {
  function renderFormPreview(form){
    if(!form.sections.length) return `<p style="color:var(--text-faint);font-size:13px">Add a section to see the preview.</p>`;
    return form.sections.map(sec => `
      <div style="margin-bottom:22px">
        <div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;color:var(--accent-text);margin-bottom:2px">${Utils.escapeHtml(sec.title)}</div>
        ${sec.description ? `<div style="font-size:12px;color:var(--text-dim);margin-bottom:10px">${Utils.escapeHtml(sec.description)}</div>` : ''}
        ${sec.questions.map(q => renderQuestionPreview(q)).join('')}
      </div>`).join('');
  }

  function renderQuestionPreview(q){
    return `
      <div style="margin-bottom:14px">
        <div style="font-size:13px;font-weight:700">${Utils.escapeHtml(q.title)}${q.required ? ' <span style="color:var(--danger)">*</span>' : ''}</div>
        ${q.description ? `<div style="font-size:11.5px;color:var(--text-dim);margin:2px 0 6px">${Utils.escapeHtml(q.description)}</div>` : ''}
        ${renderInputPreview(q)}
      </div>`;
  }

  function renderInputPreview(q){
    if(q.type === 'textarea') return `<textarea disabled placeholder="${Utils.escapeHtml(q.placeholder)}" style="min-height:50px"></textarea>`;
    if(q.type === 'likert') return `<div class="likert-group">${Utils.LIKERT_LABELS.map((lbl,i) => `<div class="likert-btn"><span class="num">${i+1}</span><span class="lbl">${lbl}</span></div>`).join('')}</div>`;
    return `<input type="text" disabled placeholder="${Utils.escapeHtml(q.placeholder)}">`;
  }

  /* ---------- interactive wizard rendering (live, not disabled) ---------- */
  function renderWizardQuestion(q, currentValue){
    const aiBtn = q.aiEnabled ? `<button class="ai-assist-btn" data-ai-assist="${q.id}">✨ AI Assist</button>` : '';
    return `
      <div class="q-block" data-question-block="${q.id}">
        <div class="q-title">${Utils.escapeHtml(q.title)}${q.required ? '<span class="req">*</span>' : ''}${aiBtn}</div>
        ${q.description ? `<div class="q-desc">${Utils.escapeHtml(q.description)}</div>` : ''}
        ${renderWizardInput(q, currentValue)}
        ${q.hint ? `<div class="q-hint">${Utils.escapeHtml(q.hint)}</div>` : ''}
        <div class="ai-answer-slot" data-ai-answer="${q.id}"></div>
      </div>`;
  }

  function renderWizardInput(q, currentValue){
    const val = currentValue !== undefined && currentValue !== null ? currentValue : (q.defaultValue || '');
    if(q.type === 'textarea'){
      return `<textarea data-answer-input="${q.id}" placeholder="${Utils.escapeHtml(q.placeholder)}">${Utils.escapeHtml(val)}</textarea>`;
    }
    if(q.type === 'likert'){
      const numVal = val && val.value ? val.value : null;
      return `<div class="likert-group" data-answer-likert="${q.id}">
        ${Utils.LIKERT_LABELS.map((lbl,i) => {
          const n = i+1;
          return `<div class="likert-btn ${numVal===n?'selected':''}" data-likert-value="${n}" data-likert-label="${lbl}" data-question="${q.id}">
            <span class="num">${n}</span><span class="lbl">${lbl}</span></div>`;
        }).join('')}
      </div>`;
    }
    return `<input type="text" data-answer-input="${q.id}" placeholder="${Utils.escapeHtml(q.placeholder)}" value="${Utils.escapeHtml(val)}">`;
  }

  return { renderFormPreview, renderQuestionPreview, renderWizardQuestion };
})();

/* ---------------------------------------------------------------
   Wizard — drives the User's step-by-step answering flow. Reads
   the active form + current response from State, autosaves every
   change to Storage via ResponseStore.
   --------------------------------------------------------------- */
const Wizard = (() => {
  function start(formId){
    const form = FormEngine.get(formId);
    if(!form) return;
    const response = ResponseStore.createInProgress(formId);
    State.patch({ activeFormId: formId, currentWizardStep: 0, currentResponse: response });
    EventBus.emit('wizard:start', { formId });
    Router.go('user');
  }

  function resume(response){
    State.patch({ activeFormId: response.formId, currentWizardStep: 0, currentResponse: response });
    EventBus.emit('wizard:resume', { response });
    Router.go('user');
  }

  function render(){
    const { activeFormId, currentWizardStep, currentResponse } = State.get();
    const form = FormEngine.get(activeFormId);
    if(!form || !currentResponse) return `<div class="empty-state"><div class="ic">⚠️</div><h3>No active form</h3></div>`;
    const sec = form.sections[currentWizardStep];
    const total = form.sections.length;
    const answeredCount = countAnswered(form, currentResponse);
    const totalQ = form.sections.reduce((n,s) => n + s.questions.length, 0);
    const pct = totalQ ? Math.round((answeredCount/totalQ)*100) : 0;

    const rail = form.sections.map((s,i) => `
      <div class="rail-item ${i===currentWizardStep?'active':i<currentWizardStep?'done':''}" data-rail-step="${i}">
        <div class="rail-dot">${i<currentWizardStep?'✓':i+1}</div>
        <div class="rail-label">${Utils.escapeHtml(s.title)}</div>
      </div>`).join('');

    const questionsHtml = sec.questions.map(q => Renderer.renderWizardQuestion(q, currentResponse.answers[q.id])).join('');

    return `
      <div class="wizard-shell">
        <div class="wizard-inner">
          <div class="workflow-rail">${rail}</div>
          <div class="wizard-main">
            <div class="wizard-progress-bar"><div class="wizard-progress-fill" style="width:${pct}%"></div></div>
            <div class="wizard-meta">
              <span>Section ${currentWizardStep+1} of ${total} · ${sec.questions.length} question${sec.questions.length===1?'':'s'}</span>
              <span>${pct}% complete</span>
            </div>
            <div class="card wizard-card">
              <div class="sec-title">${Utils.escapeHtml(sec.title)}</div>
              ${sec.description ? `<div class="sec-desc">${Utils.escapeHtml(sec.description)}</div>` : ''}
              ${questionsHtml}
            </div>
            <div class="wizard-nav">
              <span class="autosave-tag"><span class="dot"></span> Autosaved</span>
              <div style="display:flex;gap:8px">
                <button class="btn btn-secondary" id="wizPrevBtn" ${currentWizardStep===0?'disabled':''}>← Previous</button>
                ${currentWizardStep < total-1
                  ? `<button class="btn btn-primary" id="wizNextBtn">Next →</button>`
                  : `<button class="btn btn-primary" id="wizFinishBtn">Finish ✓</button>`}
              </div>
            </div>
          </div>
        </div>
      </div>`;
  }

  function countAnswered(form, response){
    let n = 0;
    form.sections.forEach(s => s.questions.forEach(q => {
      const a = response.answers[q.id];
      if(a !== undefined && a !== null && a !== '' && !(a && a.value === undefined && typeof a === 'object' && !a.value)) n++;
    }));
    return n;
  }

  function bind(){
    const { activeFormId, currentWizardStep } = State.get();
    const form = FormEngine.get(activeFormId);
    if(!form) return;

    document.querySelectorAll('[data-answer-input]').forEach(el => {
      el.addEventListener('input', Utils.debounce(() => {
        saveAnswer(el.getAttribute('data-answer-input'), el.value);
      }, 300));
    });
    document.querySelectorAll('[data-likert-value]').forEach(el => {
      el.addEventListener('click', () => {
        const qId = el.getAttribute('data-question');
        const value = parseInt(el.getAttribute('data-likert-value'));
        const label = el.getAttribute('data-likert-label');
        saveAnswer(qId, { value, label });
        document.querySelectorAll(`[data-answer-likert="${qId}"] .likert-btn`).forEach(b => b.classList.remove('selected'));
        el.classList.add('selected');
      });
    });
    document.querySelectorAll('[data-ai-assist]').forEach(el => {
      el.addEventListener('click', () => AIEngine.assistQuestion(el.getAttribute('data-ai-assist')));
    });
    document.querySelectorAll('[data-rail-step]').forEach(el => {
      el.addEventListener('click', () => {
        const step = parseInt(el.getAttribute('data-rail-step'));
        if(step <= currentWizardStep){ State.patch({ currentWizardStep: step }); UserFlow.renderCurrentStep(); }
      });
    });
    document.getElementById('wizPrevBtn')?.addEventListener('click', () => {
      State.patch({ currentWizardStep: currentWizardStep - 1 });
      EventBus.emit('wizard:previous', {});
      UserFlow.renderCurrentStep();
    });
    document.getElementById('wizNextBtn')?.addEventListener('click', () => goNext(form));
    document.getElementById('wizFinishBtn')?.addEventListener('click', () => finish(form));

    document.addEventListener('keydown', wizardKeyHandler);
  }

  function wizardKeyHandler(e){
    if(e.key === 'Enter' && e.target.tagName !== 'TEXTAREA'){
      const nextBtn = document.getElementById('wizNextBtn');
      const finishBtn = document.getElementById('wizFinishBtn');
      if(nextBtn){ e.preventDefault(); nextBtn.click(); }
      else if(finishBtn){ e.preventDefault(); finishBtn.click(); }
    }
  }

  function goNext(form){
    const { currentWizardStep } = State.get();
    const sec = form.sections[currentWizardStep];
    const missing = requiredMissing(sec);
    if(missing){ EventBus.emit('toast:show', { type:'error', message:`Please answer: ${missing}` }); return; }
    State.patch({ currentWizardStep: currentWizardStep + 1 });
    EventBus.emit('wizard:next', {});
    UserFlow.renderCurrentStep();
  }

  function requiredMissing(sec){
    const { currentResponse } = State.get();
    for(const q of sec.questions){
      if(!q.required) continue;
      const a = currentResponse.answers[q.id];
      const empty = a === undefined || a === null || a === '' || (typeof a === 'object' && a.value === undefined);
      if(empty) return q.title;
    }
    return null;
  }

  function saveAnswer(questionId, value){
    const { currentResponse } = State.get();
    currentResponse.answers[questionId] = value;
    currentResponse.updatedAt = new Date().toISOString();
    ResponseStore.save(currentResponse);
    EventBus.emit('answer:changed', { questionId, value });
  }

  function finish(form){
    const sec = form.sections[form.sections.length - 1];
    const missing = requiredMissing(sec);
    if(missing){ EventBus.emit('toast:show', { type:'error', message:`Please answer: ${missing}` }); return; }
    const { currentResponse } = State.get();
    currentResponse.completedAt = new Date().toISOString();
    currentResponse.durationMs = new Date(currentResponse.completedAt) - new Date(currentResponse.startedAt);
    ResponseStore.save(currentResponse);
    document.removeEventListener('keydown', wizardKeyHandler);
    EventBus.emit('wizard:finish', { response: currentResponse });
    EventBus.emit('wizard:completed', { response: currentResponse });
    State.patch({ adminSection: State.get().adminSection }); // no-op keep
    UserFlow.goToSummary();
  }

  return { start, resume, render, bind };
})();

/* ---------------------------------------------------------------
   ResponseStore — persistence for wizard responses (in-progress
   and completed). Kept separate from FormEngine on purpose.
   --------------------------------------------------------------- */
const ResponseStore = (() => {
  function all(){ return State.get().responses; }
  function persist(){ Storage.save('responses', State.get().responses); }

  function createInProgress(formId){
    const response = {
      id: Utils.uid('resp'), formId, startedAt: new Date().toISOString(),
      completedAt: null, durationMs: null, answers: {},
      providerUsed: State.get().providers.active, agentUsed: null
    };
    State.get().responses.push(response);
    persist();
    return response;
  }
  function save(response){
    const list = State.get().responses;
    const idx = list.findIndex(r => r.id === response.id);
    if(idx >= 0) list[idx] = response; else list.push(response);
    persist();
    EventBus.emit('response:save', { response });
  }
  function remove(id){
    State.patch({ responses: State.get().responses.filter(r => r.id !== id) });
    persist();
    EventBus.emit('response:delete', { id });
  }
  function get(id){ return State.get().responses.find(r => r.id === id) || null; }

  return { all, createInProgress, save, remove, get };
})();

/* ---------------------------------------------------------------
   SummaryEngine — pure JavaScript, no AI required. Produces a
   polished Markdown report and a separate "LLM Ready Prompt" that
   the user can paste into ChatGPT/Claude/Qwen.
   --------------------------------------------------------------- */
const SummaryEngine = (() => {
  function likertMeaning(n){
    return Utils.LIKERT_LABELS[n-1] || 'Unknown';
  }

  function generateOfflineSummary(form, response){
    const lines = [];
    lines.push(`# ${form.title}`);
    lines.push(`*Generated ${Utils.formatDate(response.completedAt || new Date().toISOString())}*`);
    if(form.description) lines.push(`\n${form.description}`);
    lines.push(`\n## Executive Summary`);
    lines.push(execSummary(form, response));

    const missing = [];
    form.sections.forEach(sec => {
      lines.push(`\n## ${sec.title}`);
      if(sec.description) lines.push(`_${sec.description}_\n`);
      sec.questions.forEach(q => {
        const a = response.answers[q.id];
        lines.push(`**${q.title}**`);
        if(a === undefined || a === null || a === ''){
          lines.push(`> _No answer provided._`);
          missing.push(`${sec.title} → ${q.title}`);
        } else if(q.type === 'likert'){
          lines.push(`> Score: ${a.value}/5 — ${likertMeaning(a.value)}`);
        } else {
          lines.push(`> ${a}`);
        }
        lines.push('');
      });
      if(sec.summaryTemplate){
        const answersText = sec.questions.map(q => `${q.title}: ${formatAnswer(response.answers[q.id])}`).join('; ');
        lines.push(`_Section note: ${sec.summaryTemplate.replace('{{answers}}', answersText)}_`);
      }
    });

    lines.push(`\n## Missing Information`);
    lines.push(missing.length ? missing.map(m => `- ${m}`).join('\n') : '_All questions were answered._');

    lines.push(`\n## Key Findings`);
    lines.push(keyFindings(form, response));

    lines.push(`\n## Recommended Next Steps`);
    lines.push(nextSteps(form, response, missing));

    return lines.join('\n');
  }

  function formatAnswer(a){
    if(a === undefined || a === null || a === '') return 'not answered';
    if(typeof a === 'object' && a.value !== undefined) return `${a.value}/5 (${a.label})`;
    return String(a);
  }

  function execSummary(form, response){
    const totalQ = form.sections.reduce((n,s) => n + s.questions.length, 0);
    const answered = form.sections.reduce((n,s) => n + s.questions.filter(q => {
      const a = response.answers[q.id];
      return !(a === undefined || a === null || a === '');
    }).length, 0);
    const pct = totalQ ? Math.round((answered/totalQ)*100) : 0;
    return `This response covers ${form.sections.length} section(s) and answers ${answered} of ${totalQ} questions (${pct}% complete). It was ${response.completedAt ? 'fully completed' : 'left in progress'}.`;
  }

  function keyFindings(form, response){
    const likertQs = [];
    form.sections.forEach(sec => sec.questions.forEach(q => {
      if(q.type === 'likert' && response.answers[q.id]) likertQs.push({ q, sec, a: response.answers[q.id] });
    }));
    if(!likertQs.length) return '_No rated (Likert) questions to analyze._';
    const low = likertQs.filter(x => x.a.value <= 2);
    const high = likertQs.filter(x => x.a.value >= 4);
    const parts = [];
    if(high.length) parts.push(`**Strengths:** ${high.map(x => x.q.title).join(', ')}.`);
    if(low.length) parts.push(`**Weaknesses / risk areas:** ${low.map(x => x.q.title).join(', ')}.`);
    if(!parts.length) parts.push('Ratings are mostly neutral — no strong strengths or weaknesses stood out.');
    return parts.join('\n\n');
  }

  function nextSteps(form, response, missing){
    const steps = [];
    if(missing.length) steps.push(`Follow up on the ${missing.length} unanswered question(s) listed above.`);
    form.sections.forEach(sec => sec.questions.forEach(q => {
      if(q.type === 'likert'){
        const a = response.answers[q.id];
        if(a && a.value <= 2) steps.push(`Dig deeper into "${q.title}" (rated ${a.value}/5) — this may be a risk area.`);
      }
    }));
    if(!steps.length) steps.push('No immediate red flags. Proceed to the next stage of your workflow.');
    return steps.map(s => `- ${s}`).join('\n');
  }

  /* ---------- LLM-ready prompt (layered prompt hierarchy) ---------- */
  function generateLLMPrompt(form, response){
    const agentsData = State.get().agents;
    const global = agentsData.globalPrompt || '';
    const lines = [];
    lines.push(`# Context`);
    lines.push(global || 'You are an expert consultant reviewing structured discovery answers.');
    lines.push(`\n# Objective`);
    lines.push(`Review the collected information below, identify assumptions, contradictions, opportunities and risks, and propose actionable recommendations.`);
    lines.push(`\n# Form Information`);
    lines.push(`- Title: ${form.title}`);
    if(form.description) lines.push(`- Description: ${form.description}`);
    lines.push(`- Completed: ${response.completedAt ? 'Yes' : 'No'}`);

    const missing = [];
    form.sections.forEach((sec, i) => {
      lines.push(`\n# Section ${i+1}: ${sec.title}`);
      if(sec.aiPrompt) lines.push(`_Instruction: ${sec.aiPrompt}_`);
      sec.questions.forEach(q => {
        const a = response.answers[q.id];
        lines.push(`- **${q.title}**: ${formatAnswer(a)}`);
        if(a === undefined || a === null || a === '') missing.push(`${sec.title} → ${q.title}`);
        if(q.questionPrompt) lines.push(`  _(${q.questionPrompt})_`);
      });
      if(sec.summaryTemplate){
        const answersText = sec.questions.map(q => `${q.title}: ${formatAnswer(response.answers[q.id])}`).join('; ');
        lines.push(`Section Summary: ${sec.summaryTemplate.replace('{{answers}}', answersText)}`);
      }
    });

    lines.push(`\n# Overall Findings`);
    lines.push(keyFindings(form, response));
    lines.push(`\n# Missing Information`);
    lines.push(missing.length ? missing.map(m => `- ${m}`).join('\n') : 'None — all questions answered.');
    lines.push(`\n# Requested AI Tasks`);
    lines.push(`Act as an expert consultant. Review the collected information, identify assumptions, contradictions, opportunities, risks and propose actionable recommendations.`);
    return lines.join('\n');
  }

  return { generateOfflineSummary, generateLLMPrompt, likertMeaning };
})();

/* ---------------------------------------------------------------
   ProviderManager — CRUD over provider configs. No API calls here.
   --------------------------------------------------------------- */
const ProviderManager = (() => {
  function all(){ return State.get().providers.providers; }
  function getActive(){
    const { providers } = State.get();
    return providers.providers.find(p => p.id === providers.active) || providers.providers[0];
  }
  function get(id){ return State.get().providers.providers.find(p => p.id === id); }
  function persist(){ Storage.save('providers', State.get().providers); }

  function setActive(id){
    State.get().providers.active = id;
    persist();
    EventBus.emit('provider:changed', { id });
    EventBus.emit('provider:selected', { id });
  }
  function update(id, patch){
    const p = get(id);
    if(!p) return null;
    Object.assign(p, patch);
    persist();
    EventBus.emit('provider:changed', { id });
    return p;
  }
  function toggleEnabled(id){
    const p = get(id);
    if(!p) return;
    update(id, { enabled: !p.enabled });
  }

  return { all, getActive, get, setActive, update, toggleEnabled };
})();

/* ---------------------------------------------------------------
   PromptEngine — builds the layered prompt: Global -> Agent ->
   Section -> Question -> Answer, inheriting upward when a lower
   layer is empty.
   --------------------------------------------------------------- */
const PromptEngine = (() => {
  function agentForSection(form, section){
    const { agents } = State.get().agents ? State.get() : { agents:{ agents:[] } };
    const list = State.get().agents.agents || [];
    const candidates = list.filter(a => a.enabled && (a.assignedForms||[]).includes(form.id) && (a.assignedSections||[]).includes(section.id));
    if(!candidates.length) return list.find(a => a.enabled && (a.assignedForms||[]).includes(form.id)) || null;
    return candidates.sort((a,b) => (b.priority||0) - (a.priority||0))[0];
  }

  function buildForQuestion(form, section, question, answer){
    const global = State.get().agents.globalPrompt || '';
    const agent = agentForSection(form, section);
    const parts = [];
    if(global) parts.push(global);
    if(agent && agent.systemPrompt) parts.push(agent.systemPrompt);
    if(section.aiPrompt) parts.push(section.aiPrompt);
    if(question.questionPrompt) parts.push(question.questionPrompt);
    const systemPrompt = parts.join('\n\n');
    const userPrompt = `Question: ${question.title}\nAnswer: ${answer === undefined || answer === null || answer === '' ? '(no answer yet)' : (typeof answer === 'object' ? `${answer.value}/5 (${answer.label})` : answer)}`;
    return { systemPrompt, userPrompt, agent };
  }

  return { buildForQuestion, agentForSection };
})();

/* ---------------------------------------------------------------
   ProviderAdapter — the only module that touches fetch(). Speaks
   the OpenAI-compatible /chat/completions format used by both
   GapGPT and LM Studio.
   --------------------------------------------------------------- */
const ProviderAdapter = (() => {
  async function chat(provider, systemPrompt, userPrompt){
    const url = `${provider.baseUrl.replace(/\/$/,'')}${provider.endpointPath || '/chat/completions'}`;
    const headers = { 'Content-Type': 'application/json', ...(provider.headers || {}) };
    if(provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;
    const body = {
      model: provider.model,
      messages: [
        ...(systemPrompt ? [{ role:'system', content: systemPrompt }] : []),
        { role:'user', content: userPrompt }
      ],
      temperature: provider.temperature ?? 0.7,
      top_p: provider.topP ?? 1,
      max_tokens: provider.maxTokens ?? 1000
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), provider.timeout || 30000);
    try{
      const res = await fetch(url, { method:'POST', headers, body: JSON.stringify(body), signal: controller.signal });
      clearTimeout(timeout);
      if(!res.ok){
        const text = await res.text().catch(()=> '');
        throw new Error(`HTTP ${res.status}: ${text.slice(0,200)}`);
      }
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if(!content) throw new Error('No content returned by provider.');
      return { ok:true, content };
    }catch(e){
      clearTimeout(timeout);
      const msg = e.name === 'AbortError' ? 'Request timed out.' : e.message;
      return { ok:false, error: msg };
    }
  }

  async function testConnection(provider){
    if(provider.id === 'offline') return { ok:true, message:'Offline mode — no connection needed.' };
    if(!provider.baseUrl) return { ok:false, error:'Base URL is empty.' };
    const result = await chat(provider, 'You are a connection test.', 'Reply with the single word: OK');
    if(result.ok) return { ok:true, message:`Connected. Model replied: "${result.content.slice(0,80)}"` };
    return { ok:false, error: result.error };
  }

  return { chat, testConnection };
})();

/* ---------------------------------------------------------------
   AIEngine — orchestrates the AI Assist button in the wizard. If
   the active provider is offline or the call fails, it falls back
   to a friendly offline message and never breaks the flow.
   --------------------------------------------------------------- */
const AIEngine = (() => {
  async function assistQuestion(questionId){
    const { activeFormId, currentWizardStep, currentResponse } = State.get();
    const form = FormEngine.get(activeFormId);
    const section = form.sections[currentWizardStep];
    const question = section.questions.find(q => q.id === questionId);
    if(!question) return;

    const slot = document.querySelector(`[data-ai-answer="${questionId}"]`);
    const provider = ProviderManager.getActive();

    if(!provider || provider.id === 'offline' || !provider.enabled){
      renderOfflineOffer(slot, form, section, question);
      return;
    }

    if(slot) slot.innerHTML = `<div style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:12px;color:var(--text-dim)"><span class="spinner"></span> Asking ${provider.name}…</div>`;

    const answer = currentResponse.answers[questionId];
    const { systemPrompt, userPrompt, agent } = PromptEngine.buildForQuestion(form, section, question, answer);
    const result = await ProviderAdapter.chat(provider, systemPrompt, userPrompt);

    if(result.ok){
      currentResponse.agentUsed = agent ? agent.id : null;
      currentResponse.providerUsed = provider.id;
      ResponseStore.save(currentResponse);
      EventBus.emit('report:generated', { questionId, provider: provider.id });
      if(slot) slot.innerHTML = `<div class="card" style="margin-top:8px;font-size:12.5px;line-height:1.6;background:var(--accent-soft);border-color:transparent"><strong style="color:var(--accent-text)">✨ AI Assist (${Utils.escapeHtml(provider.name)})</strong><div style="margin-top:6px;white-space:pre-wrap">${Utils.escapeHtml(result.content)}</div></div>`;
    } else {
      EventBus.emit('toast:show', { type:'error', message:`AI request failed: ${result.error}` });
      renderOfflineOffer(slot, form, section, question, result.error);
    }
  }

  function renderOfflineOffer(slot, form, section, question, errorMsg=null){
    if(!slot) return;
    slot.innerHTML = `
      <div class="card" style="margin-top:8px;font-size:12.5px;background:var(--bg-hover);border-color:transparent">
        ${errorMsg ? `<div style="color:var(--danger);margin-bottom:6px">Could not reach the AI provider (${Utils.escapeHtml(errorMsg)}).</div>` : `<div style="color:var(--text-dim);margin-bottom:6px">AI is currently offline for this question.</div>`}
        <button class="btn btn-secondary btn-sm" data-offline-summary="${question.id}">Generate Offline Summary</button>
      </div>`;
    slot.querySelector('[data-offline-summary]').addEventListener('click', () => {
      const { currentResponse } = State.get();
      const answer = currentResponse.answers[question.id];
      const text = answer === undefined || answer === null || answer === ''
        ? 'No answer has been provided yet for this question.'
        : `Recorded answer: ${typeof answer === 'object' ? `${answer.value}/5 (${answer.label})` : answer}`;
      slot.innerHTML = `<div class="card" style="margin-top:8px;font-size:12.5px;background:var(--bg-hover);border-color:transparent">${Utils.escapeHtml(text)}</div>`;
    });
  }

  return { assistQuestion };
})();

/* ---------------------------------------------------------------
   Providers — admin page for configuring AI providers.
   --------------------------------------------------------------- */
const Providers = (() => {
  function render(){
    const { providers, active } = State.get().providers;
    const cards = providers.map(p => `
      <div class="card provider-card" data-provider-card="${p.id}">
        <div class="p-head">
          <span class="status-dot ${p.enabled ? 'on':'off'}"></span>
          <strong>${Utils.escapeHtml(p.name)}</strong>
          ${State.get().providers.active === p.id ? `<span class="tag">Active</span>` : ''}
          <div class="switch ${p.enabled ? 'on':''}" data-toggle-provider="${p.id}" title="Enable/disable"></div>
        </div>
        <p style="font-size:12px;color:var(--text-dim)">${Utils.escapeHtml(p.description || '')}</p>
        ${p.id === 'offline' ? '' : `
        <div class="field-row"><label>Base URL</label><input type="text" data-p-field="baseUrl" data-p-id="${p.id}" value="${Utils.escapeHtml(p.baseUrl)}"></div>
        <div class="field-2col">
          <div class="field-row"><label>Model</label><input type="text" data-p-field="model" data-p-id="${p.id}" value="${Utils.escapeHtml(p.model)}"></div>
          <div class="field-row"><label>API Key</label><input type="password" data-p-field="apiKey" data-p-id="${p.id}" value="${Utils.escapeHtml(p.apiKey)}"></div>
        </div>
        <div class="field-2col">
          <div class="field-row"><label>Temperature</label><input type="number" step="0.1" min="0" max="2" data-p-field="temperature" data-p-id="${p.id}" value="${p.temperature}"></div>
          <div class="field-row"><label>Top P</label><input type="number" step="0.1" min="0" max="1" data-p-field="topP" data-p-id="${p.id}" value="${p.topP}"></div>
        </div>
        <div class="field-2col">
          <div class="field-row"><label>Max Tokens</label><input type="number" data-p-field="maxTokens" data-p-id="${p.id}" value="${p.maxTokens}"></div>
          <div class="field-row"><label>Timeout (ms)</label><input type="number" data-p-field="timeout" data-p-id="${p.id}" value="${p.timeout}"></div>
        </div>
        ${p.notes ? `<p class="hint">${Utils.escapeHtml(p.notes)}</p>` : ''}
        `}
        <div style="display:flex;gap:8px;margin-top:4px">
          <button class="btn btn-secondary btn-sm" data-set-active="${p.id}" ${active===p.id?'disabled':''}>Set as Active</button>
          <button class="btn btn-secondary btn-sm" data-test-conn="${p.id}">Test Connection</button>
        </div>
        <div class="conn-result" data-conn-result="${p.id}"></div>
      </div>`).join('');
    return `
      <div class="page-head"><div><h2>Providers</h2><p>Configure AI providers. Offline mode never makes network calls.</p></div></div>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr))">${cards}</div>
    `;
  }

  function bind(){
    document.querySelectorAll('[data-toggle-provider]').forEach(el => el.addEventListener('click', () => {
      ProviderManager.toggleEnabled(el.getAttribute('data-toggle-provider'));
      UI.renderAdminSectionBody();
    }));
    document.querySelectorAll('[data-set-active]').forEach(el => el.addEventListener('click', () => {
      const id = el.getAttribute('data-set-active');
      const p = ProviderManager.get(id);
      if(!p.enabled && id !== 'offline'){ EventBus.emit('toast:show', { type:'error', message:'Enable the provider before setting it active.' }); return; }
      ProviderManager.setActive(id);
      EventBus.emit('toast:show', { type:'success', message:`${p.name} is now active.` });
      UI.renderAdminSectionBody();
    }));
    document.querySelectorAll('[data-test-conn]').forEach(el => el.addEventListener('click', async () => {
      const id = el.getAttribute('data-test-conn');
      const p = ProviderManager.get(id);
      const resultEl = document.querySelector(`[data-conn-result="${id}"]`);
      resultEl.innerHTML = `<div style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-dim);margin-top:8px"><span class="spinner"></span> Testing…</div>`;
      EventBus.emit('provider:test', { id });
      const res = await ProviderAdapter.testConnection(p);
      if(res.ok){
        resultEl.innerHTML = `<div style="font-size:12px;color:var(--success);margin-top:8px">✓ ${Utils.escapeHtml(res.message)}</div>`;
        EventBus.emit('provider:online', { id });
      } else {
        resultEl.innerHTML = `<div style="font-size:12px;color:var(--danger);margin-top:8px">✗ ${Utils.escapeHtml(res.error)}</div>`;
        EventBus.emit('provider:offline', { id });
      }
    }));
    document.querySelectorAll('[data-p-field]').forEach(el => {
      el.addEventListener('input', Utils.debounce(() => {
        const id = el.getAttribute('data-p-id');
        const field = el.getAttribute('data-p-field');
        let val = el.value;
        if(['temperature','topP','maxTokens','timeout'].includes(field)) val = parseFloat(val) || 0;
        ProviderManager.update(id, { [field]: val });
      }, 300));
    });
  }

  return { render, bind };
})();

/* ---------------------------------------------------------------
   Agents — admin page for configuring AI agents.
   --------------------------------------------------------------- */
const Agents = (() => {
  function render(){
    const { globalPrompt, agents } = State.get().agents;
    const forms = State.get().forms;
    const rows = agents.map(a => `
      <div class="card" style="margin-bottom:14px" data-agent-card="${a.id}">
        <div class="p-head">
          <span class="status-dot ${a.enabled?'on':'off'}"></span>
          <strong>${Utils.escapeHtml(a.name)}</strong>
          <span class="tag">${Utils.escapeHtml(a.role || '')}</span>
          <div class="switch ${a.enabled?'on':''}" data-toggle-agent="${a.id}"></div>
        </div>
        <div class="field-row"><label>Name</label><input type="text" data-a-field="name" data-a-id="${a.id}" value="${Utils.escapeHtml(a.name)}"></div>
        <div class="field-row"><label>Role</label><input type="text" data-a-field="role" data-a-id="${a.id}" value="${Utils.escapeHtml(a.role)}"></div>
        <div class="field-row"><label>Description</label><input type="text" data-a-field="description" data-a-id="${a.id}" value="${Utils.escapeHtml(a.description)}"></div>
        <div class="field-row"><label>System Prompt</label><textarea data-a-field="systemPrompt" data-a-id="${a.id}">${Utils.escapeHtml(a.systemPrompt)}</textarea></div>
        <div class="field-row"><label>Assigned Forms</label>
          <select data-a-field="assignedForms" data-a-id="${a.id}" multiple style="min-height:70px">
            ${forms.map(f => `<option value="${f.id}" ${(a.assignedForms||[]).includes(f.id)?'selected':''}>${Utils.escapeHtml(f.title)}</option>`).join('')}
          </select>
          <span class="hint">Ctrl/Cmd+click to select multiple.</span>
        </div>
        <div class="field-2col">
          <div class="field-row"><label>Priority</label><input type="number" data-a-field="priority" data-a-id="${a.id}" value="${a.priority||1}"></div>
          <div class="field-row"><label>Temperature Override</label><input type="number" step="0.1" data-a-field="temperatureOverride" data-a-id="${a.id}" value="${a.temperatureOverride ?? ''}" placeholder="inherit"></div>
        </div>
      </div>`).join('');
    return `
      <div class="page-head">
        <div><h2>Agents</h2><p>Layered prompts: Global → Agent → Section → Question.</p></div>
        <div class="page-head-actions"><button class="btn btn-primary" id="newAgentBtn">+ New Agent</button></div>
      </div>
      <div class="card" style="margin-bottom:18px">
        <div class="field-row"><label>Global Prompt (applies to every agent and form)</label>
          <textarea id="globalPromptArea" style="min-height:90px">${Utils.escapeHtml(globalPrompt)}</textarea>
        </div>
      </div>
      ${rows || `<div class="empty-state"><div class="ic">🤖</div><h3>No agents yet</h3><p>Create one to assign a custom AI persona to specific sections.</p></div>`}
    `;
  }

  function persist(){ Storage.save('agents', State.get().agents); }

  function bind(){
    document.getElementById('globalPromptArea')?.addEventListener('input', Utils.debounce((e) => {
      State.get().agents.globalPrompt = e.target.value;
      persist();
    }, 300));
    document.getElementById('newAgentBtn')?.addEventListener('click', () => {
      State.get().agents.agents.push({
        id: Utils.uid('agent'), name:'New Agent', role:'', description:'', systemPrompt:'',
        outputStyle:'concise', temperatureOverride:null, assignedForms:[], assignedSections:[], enabled:true, priority:1
      });
      persist();
      UI.renderAdminSectionBody();
    });
    document.querySelectorAll('[data-toggle-agent]').forEach(el => el.addEventListener('click', () => {
      const a = State.get().agents.agents.find(a => a.id === el.getAttribute('data-toggle-agent'));
      a.enabled = !a.enabled;
      persist();
      UI.renderAdminSectionBody();
    }));
    document.querySelectorAll('[data-a-field]').forEach(el => {
      const isSelect = el.tagName === 'SELECT';
      el.addEventListener(isSelect ? 'change' : 'input', Utils.debounce(() => {
        const id = el.getAttribute('data-a-id');
        const field = el.getAttribute('data-a-field');
        const a = State.get().agents.agents.find(x => x.id === id);
        if(!a) return;
        if(isSelect) a.assignedForms = Array.from(el.selectedOptions).map(o => o.value);
        else if(field === 'temperatureOverride') a.temperatureOverride = el.value === '' ? null : parseFloat(el.value);
        else if(field === 'priority') a.priority = parseInt(el.value) || 1;
        else a[field] = el.value;
        persist();
        EventBus.emit('agent:changed', { id });
      }, 300));
    });
  }
  return { render, bind };
})();

/* ---------------------------------------------------------------
   SettingsPage — admin app-level settings.
   --------------------------------------------------------------- */
const SettingsPage = (() => {
  function render(){
    const s = State.get().settings;
    const providers = State.get().providers.providers;
    const agents = State.get().agents.agents;
    return `
      <div class="page-head"><div><h2>Settings</h2><p>Application-wide defaults.</p></div></div>
      <div class="card" style="max-width:520px">
        <div class="field-row"><label>Theme</label>
          <select id="setTheme">
            <option value="dark" ${s.theme==='dark'?'selected':''}>Dark</option>
            <option value="light" ${s.theme==='light'?'selected':''}>Light</option>
          </select>
        </div>
        <div class="field-row"><label>Default Provider</label>
          <select id="setProvider">${providers.map(p => `<option value="${p.id}" ${s.defaultProvider===p.id?'selected':''}>${Utils.escapeHtml(p.name)}</option>`).join('')}</select>
        </div>
        <div class="field-row"><label>Default Agent</label>
          <select id="setAgent"><option value="">None</option>${agents.map(a => `<option value="${a.id}" ${s.defaultAgent===a.id?'selected':''}>${Utils.escapeHtml(a.name)}</option>`).join('')}</select>
        </div>
        <label class="checkbox-row"><input type="checkbox" id="setAutosave" ${s.autosave?'checked':''}> Autosave answers while typing</label>
        <div class="divider"></div>
        <button class="btn btn-secondary btn-block" id="backupBtn">⭳ Download Backup (all data)</button>
        <div style="height:8px"></div>
        <label class="btn btn-secondary btn-block" style="text-align:center">
          ⭱ Restore from Backup
          <input type="file" id="restoreInput" accept="application/json" class="hidden">
        </label>
        <div style="height:8px"></div>
        <button class="btn btn-danger btn-block" id="resetAppBtn">Reset Application (clear LocalStorage)</button>
      </div>`;
  }

  function bind(){
    document.getElementById('setTheme')?.addEventListener('change', (e) => Theme.set(e.target.value));
    document.getElementById('setProvider')?.addEventListener('change', (e) => saveSetting('defaultProvider', e.target.value));
    document.getElementById('setAgent')?.addEventListener('change', (e) => saveSetting('defaultAgent', e.target.value));
    document.getElementById('setAutosave')?.addEventListener('change', (e) => saveSetting('autosave', e.target.checked));
    document.getElementById('backupBtn')?.addEventListener('click', () => {
      const dump = Storage.exportAll();
      Utils.download(`workflow-backup-${Date.now()}.json`, JSON.stringify(dump, null, 2), 'application/json');
      EventBus.emit('backup:created', {});
      EventBus.emit('toast:show', { type:'success', message:'Backup downloaded.' });
    });
    document.getElementById('restoreInput')?.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if(!file) return;
      try{
        const text = await file.text();
        const dump = JSON.parse(text);
        Storage.importAll(dump);
        EventBus.emit('backup:restored', {});
        EventBus.emit('toast:show', { type:'success', message:'Backup restored. Reloading…' });
        setTimeout(() => location.reload(), 900);
      }catch(err){
        EventBus.emit('toast:show', { type:'error', message:'Invalid backup file.' });
      }
    });
    document.getElementById('resetAppBtn')?.addEventListener('click', () => {
      Modal.confirmDialog({
        title:'Reset application?', danger:true, confirmText:'Reset everything',
        message:'This clears all forms, responses, provider and agent settings from this browser. This cannot be undone.',
        onConfirm: () => { Storage.clearAll(); location.reload(); }
      });
    });
  }
  function saveSetting(key, val){
    State.get().settings[key] = val;
    Storage.save('settings', State.get().settings);
  }
  return { render, bind };
})();

/* ---------------------------------------------------------------
   PreviewPage — lets the admin preview any form as a user would
   see it, without leaving the admin panel.
   --------------------------------------------------------------- */
const PreviewPage = (() => {
  function render(){
    const forms = State.get().forms;
    const options = forms.map(f => `<option value="${f.id}">${Utils.escapeHtml(f.title)}</option>`).join('');
    return `
      <div class="page-head"><div><h2>Preview</h2><p>See exactly what the User will see.</p></div></div>
      <div class="field-row" style="max-width:320px"><label>Choose a form</label><select id="previewFormSelect"><option value="">Select…</option>${options}</select></div>
      <div id="previewArea" style="margin-top:18px"></div>`;
  }
  function bind(){
    document.getElementById('previewFormSelect')?.addEventListener('change', (e) => {
      const form = FormEngine.get(e.target.value);
      const area = document.getElementById('previewArea');
      if(!form){ area.innerHTML = ''; return; }
      area.innerHTML = `<div class="preview-frame" style="max-width:640px"><h3>${Utils.escapeHtml(form.title)}</h3>${Renderer.renderFormPreview(form)}</div>`;
    });
  }
  return { render, bind };
})();

/* ---------------------------------------------------------------
   ResponsesPage — admin list of all saved responses.
   --------------------------------------------------------------- */
const ResponsesPage = (() => {
  function render(){
    const responses = State.get().responses;
    const rows = responses.slice().reverse().map(r => {
      const form = FormEngine.get(r.formId);
      const totalQ = form ? form.sections.reduce((n,s) => n + s.questions.length, 0) : 0;
      const answered = form ? form.sections.reduce((n,s) => n + s.questions.filter(q => {
        const a = r.answers[q.id]; return !(a===undefined||a===null||a==='');
      }).length, 0) : 0;
      const pct = totalQ ? Math.round((answered/totalQ)*100) : 0;
      return `
        <div class="card response-item" style="margin-bottom:12px" data-resp-id="${r.id}">
          <div class="r-top">
            <strong>${Utils.escapeHtml(form?.title || 'Deleted form')}</strong>
            <span class="tag">${r.completedAt ? 'Completed' : 'In progress'}</span>
          </div>
          <div style="font-size:12px;color:var(--text-faint)">Started ${Utils.formatDate(r.startedAt)}${r.completedAt ? ` · Finished ${Utils.formatDate(r.completedAt)}` : ''}</div>
          <div class="progress-mini"><div class="fill" style="width:${pct}%"></div></div>
          <div style="display:flex;gap:6px;margin-top:10px">
            <button class="btn btn-secondary btn-sm" data-view-summary="${r.id}">View Summary</button>
            <button class="btn btn-secondary btn-sm" data-export-resp="${r.id}">Export</button>
            <button class="btn btn-danger btn-sm" data-del-resp="${r.id}">Delete</button>
          </div>
        </div>`;
    }).join('');
    return `
      <div class="page-head">
        <div><h2>Responses</h2><p>All submissions collected from Users.</p></div>
        <div class="search-box"><span class="ic">🔍</span><input type="text" id="respSearch" placeholder="Search responses…"></div>
      </div>
      <div id="responsesList">${rows || `<div class="empty-state"><div class="ic">📭</div><h3>No responses yet</h3></div>`}</div>`;
  }
  function bind(){
    document.querySelectorAll('[data-view-summary]').forEach(el => el.addEventListener('click', () => {
      const r = ResponseStore.get(el.getAttribute('data-view-summary'));
      const form = FormEngine.get(r.formId);
      Modal.open({
        title: form.title, width:'640px',
        bodyHtml: `<div class="summary-content" style="max-height:50vh">${Utils.escapeHtml(SummaryEngine.generateOfflineSummary(form, r))}</div>`,
        footHtml: `<button class="btn btn-secondary" data-cancel>Close</button>`,
        onMount: (root) => root.querySelector('[data-cancel]').addEventListener('click', Modal.close)
      });
    }));
    document.querySelectorAll('[data-export-resp]').forEach(el => el.addEventListener('click', () => {
      const r = ResponseStore.get(el.getAttribute('data-export-resp'));
      const form = FormEngine.get(r.formId);
      const md = SummaryEngine.generateOfflineSummary(form, r);
      Utils.download(`response-${r.id}.md`, md, 'text/markdown');
    }));
    document.querySelectorAll('[data-del-resp]').forEach(el => el.addEventListener('click', () => {
      const id = el.getAttribute('data-del-resp');
      Modal.confirmDialog({
        title:'Delete response?', danger:true, confirmText:'Delete', message:'This cannot be undone.',
        onConfirm: () => { ResponseStore.remove(id); UI.renderAdminSectionBody(); }
      });
    }));
    document.getElementById('respSearch')?.addEventListener('input', Utils.debounce((e) => {
      const q = e.target.value.toLowerCase();
      document.querySelectorAll('[data-resp-id]').forEach(card => {
        card.style.display = card.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    }, 200));
  }
  return { render, bind };
})();

/* ---------------------------------------------------------------
   UserFlow — drives the User's screen: Select Form -> Wizard ->
   Summary -> Export. Keeps its own tiny step state separate from
   the wizard's internal section step.
   --------------------------------------------------------------- */
const UserFlow = (() => {
  let step = 'select'; // 'select' | 'wizard' | 'summary'

  function renderCurrentStep(){
    const main = document.getElementById('userMain');
    if(!main) return;
    if(step === 'select') main.innerHTML = renderFormSelect();
    else if(step === 'wizard') main.innerHTML = Wizard.render();
    else if(step === 'summary') main.innerHTML = renderSummaryScreen();
    bindCurrentStep();
  }

  function renderFormSelect(){
    const forms = State.get().forms;
    const cards = forms.map(f => `
      <div class="card card-hover form-card" data-select-form="${f.id}">
        <div class="fc-icon" style="background:${f.color}22;color:${f.color}">${f.icon}</div>
        <h4>${Utils.escapeHtml(f.title)}</h4>
        <p>${Utils.escapeHtml(f.description || '')}</p>
        <div class="fc-meta"><span class="tag">${f.sections.length} sections</span></div>
      </div>`).join('');
    return `
      <div class="page-head"><div><h2>Select a Form</h2><p>Choose a workflow to start answering.</p></div></div>
      ${forms.length ? `<div class="grid">${cards}</div>` : `<div class="empty-state"><div class="ic">🧩</div><h3>No forms available</h3><p>Ask an admin to create one first.</p></div>`}`;
  }

  function renderSummaryScreen(){
    const { activeFormId, currentResponse } = State.get();
    const form = FormEngine.get(activeFormId);
    if(!form || !currentResponse) return `<div class="empty-state"><h3>Nothing to summarize yet</h3></div>`;
    const offlineMd = SummaryEngine.generateOfflineSummary(form, currentResponse);
    const llmPrompt = SummaryEngine.generateLLMPrompt(form, currentResponse);
    State.patch({ _offlineMd: offlineMd, _llmPrompt: llmPrompt });
    return `
      <div class="summary-shell">
        <div class="page-head"><div><h2>Summary</h2><p>Your responses to "${Utils.escapeHtml(form.title)}"</p></div></div>
        <div class="summary-tabs">
          <div class="summary-tab active" data-summary-tab="offline">Offline Summary</div>
          <div class="summary-tab" data-summary-tab="llm">LLM Ready Prompt</div>
        </div>
        <div class="summary-content" id="summaryContent">${Utils.escapeHtml(offlineMd)}</div>
        <div class="summary-actions">
          <button class="btn btn-primary" id="copySummaryBtn">Copy to Clipboard</button>
          <button class="btn btn-secondary" id="downloadMdBtn">Download .md</button>
          <button class="btn btn-secondary" id="downloadTxtBtn">Download .txt</button>
          <button class="btn btn-secondary" id="downloadJsonBtn">Download .json</button>
          <button class="btn btn-secondary" id="printBtn">Print</button>
          <button class="btn btn-ghost" id="newFormFromSummaryBtn">Start Another Form</button>
        </div>
      </div>`;
  }

  function bindCurrentStep(){
    if(step === 'select'){
      document.querySelectorAll('[data-select-form]').forEach(el => el.addEventListener('click', () => {
        Wizard.start(el.getAttribute('data-select-form'));
        step = 'wizard';
        renderCurrentStep();
      }));
    } else if(step === 'wizard'){
      Wizard.bind();
    } else if(step === 'summary'){
      bindSummaryScreen();
    }
  }

  function bindSummaryScreen(){
    let activeTab = 'offline';
    const contentEl = () => document.getElementById('summaryContent');
    document.querySelectorAll('[data-summary-tab]').forEach(tab => tab.addEventListener('click', () => {
      activeTab = tab.getAttribute('data-summary-tab');
      document.querySelectorAll('[data-summary-tab]').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      contentEl().textContent = activeTab === 'offline' ? State.get()._offlineMd : State.get()._llmPrompt;
    }));
    const currentText = () => activeTab === 'offline' ? State.get()._offlineMd : State.get()._llmPrompt;
    document.getElementById('copySummaryBtn')?.addEventListener('click', async () => {
      const ok = await Utils.copyToClipboard(currentText());
      EventBus.emit('toast:show', { type: ok ? 'success' : 'error', message: ok ? 'Copied to clipboard.' : 'Could not copy.' });
      if(ok) EventBus.emit('prompt:copied', { tab: activeTab });
    });
    document.getElementById('downloadMdBtn')?.addEventListener('click', () => Export.asMarkdown());
    document.getElementById('downloadTxtBtn')?.addEventListener('click', () => Export.asTxt());
    document.getElementById('downloadJsonBtn')?.addEventListener('click', () => Export.asJson());
    document.getElementById('printBtn')?.addEventListener('click', () => window.print());
    document.getElementById('newFormFromSummaryBtn')?.addEventListener('click', () => {
      step = 'select';
      renderCurrentStep();
    });
  }

  function goToSummary(){
    step = 'summary';
    renderCurrentStep();
    EventBus.emit('summary:generate', {});
    EventBus.emit('summary:updated', {});
  }

  function reset(){ step = 'select'; }

  return { renderCurrentStep, goToSummary, reset };
})();

/* ---------------------------------------------------------------
   Export — file/clipboard export helpers used by the Summary screen.
   --------------------------------------------------------------- */
const Export = (() => {
  function currentContext(){
    const { activeFormId, currentResponse } = State.get();
    return { form: FormEngine.get(activeFormId), response: currentResponse };
  }
  function asMarkdown(){
    const { form, response } = currentContext();
    if(!form) return;
    Utils.download(`${form.title.toLowerCase().replace(/\s+/g,'-')}-summary.md`, SummaryEngine.generateOfflineSummary(form, response), 'text/markdown');
    EventBus.emit('report:exported', { type:'md' });
  }
  function asTxt(){
    const { form, response } = currentContext();
    if(!form) return;
    Utils.download(`${form.title.toLowerCase().replace(/\s+/g,'-')}-summary.txt`, SummaryEngine.generateOfflineSummary(form, response), 'text/plain');
    EventBus.emit('report:exported', { type:'txt' });
  }
  function asJson(){
    const { form, response } = currentContext();
    if(!form) return;
    Utils.download(`${form.title.toLowerCase().replace(/\s+/g,'-')}-response.json`, JSON.stringify(response, null, 2), 'application/json');
    EventBus.emit('report:exported', { type:'json' });
  }
  return { asMarkdown, asTxt, asJson };
})();

/* ---------------------------------------------------------------
   App — bootstraps the whole application.
   --------------------------------------------------------------- */
const App = (() => {
  async function init(){
    EventBus.emit('app:init', {});
    Toast.init();
    Theme.init();

    const [forms, providers, agents] = await Promise.all([
      DataLoader.loadForms(),
      DataLoader.loadProviders(),
      DataLoader.loadAgents()
    ]);
    State.patch({
      forms,
      providers,
      agents,
      responses: DataLoader.loadResponses(),
      settings: DataLoader.loadSettings()
    });

    bindGlobalShortcuts();
    Router.init();
    EventBus.emit('app:ready', {});
  }

  function bindGlobalShortcuts(){
    document.addEventListener('keydown', (e) => {
      if(e.key === 'Escape' && Modal.isOpen()){ Modal.close(); return; }
      if((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's'){
        e.preventDefault();
        EventBus.emit('toast:show', { type:'info', message:'Everything is autosaved — nothing to do.' });
      }
      if((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f'){
        const search = document.getElementById('respSearch');
        if(search){ e.preventDefault(); search.focus(); }
      }
    });
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', App.init);

