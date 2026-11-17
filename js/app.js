/* ZYMIARA — Cortes Studio frontend. Uses only the anon key. */
const $ = (s, r=document) => r.querySelector(s);

function storageGet(k){
  try { return localStorage.getItem(k); } catch (e) { return null; }
}
function storageSet(k, v){
  try { localStorage.setItem(k, v); } catch (e) {}
}
function showError(msg){
  if (window.showBootError) window.showBootError(msg);
  else try { toast(msg); } catch (e) {}
}

const $$ = (s, r=document) => [...r.querySelectorAll(s)];
const STAGES = [
  ["download","Baixando o vídeo"],
  ["transcribe","Transcrevendo"],
  ["select","Escolhendo trechos"],
  ["hooks","Preparando ganchos"],
  ["brain","Escrevendo ganchos"],
  ["render","Editando"],
  ["qc","Controle de qualidade"],
  ["auto_fix","Ajustes automáticos"],
  ["queue","Colocando na fila"],
];
const SEED_WORKSPACE = "00000000-0000-4000-8000-000000000001";
const SEED_PROFILE = "00000000-0000-4000-8000-000000000011";
const FALLBACK_PROFILE = {
  id: SEED_PROFILE,
  workspace_id: SEED_WORKSPACE,
  name: "Direto ao Osso",
  handle: "diretoaosso",
  niche: "empreendedorismo",
  default_style: "close",
  theme: { cut_template: "incisao", bg: "#F2EDE4", accent: "#E8261C", text: "#111111" },
  platforms: { instagram: "@diretoaosso", tiktok: "@diretoaosso", youtube: "" },
};

const cfg = window.CORTES_CONFIG || {};
const brandName = "ZYMIARA";
const appName = cfg.appName || "Cortes Studio";
const appTagline = cfg.appTagline || "Cortes para redes, em vários perfis";
function productTag(){
  const tag = appTagline || "";
  const lower = tag ? tag.charAt(0).toLowerCase() + tag.slice(1) : "";
  return lower ? `${appName} · ${lower}` : appName;
}
const configured = !!(cfg.supabaseUrl && cfg.supabaseAnonKey);

let sb = null;
let currentJobId = null;
let hasProfiles = false;
let hasProfileCols = false;
let hasAjustes = false;
let hasMaestri = false;
let hasMetas = false;
let hasAgenda = false;
let hasFormatReqs = false;
let hasFormats = false;
let hasStats = false;
let hasAccounts = false;
let hasKv = false;
let metas = [];
let agendaRows = [];
let formatReqs = [];
let formatRows = [];
let statRows = [];
let accountRows = [];
let diarioLines = [];
let profiles = [];
let currentProfileId = storageGet("cortes.profile") || SEED_PROFILE;
let allCuts = [];
let decMap = {};
let playerCut = null;
let signedCache = {};
let coverCache = {};
let appBound = false;
let schemaReady = false;   // a home só sai do skeleton depois do primeiro detectSchema
let filaOk = false;        // a última leitura de cuts/decisions deu certo
let filaAnimKey = "";

function toast(msg){
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("is-on");
  setTimeout(() => t.classList.remove("is-on"), 2800);
}
function esc(s){
  return String(s||"").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]));
}
// Só troca o DOM quando o HTML muda: evita piscar e repetir animação a cada evento do realtime.
function setHtml(el, html){
  if (el._html === html) return false;
  el._html = html;
  el.innerHTML = html;
  return true;
}
function reduceMotion(){
  return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}
// Anima só números reais (data-count). O texto final já está no HTML; com movimento reduzido nada roda.
function countUp(root){
  if (reduceMotion()) return;
  root.querySelectorAll("[data-count]").forEach(el => {
    const end = Number(el.dataset.count);
    if (!Number.isFinite(end) || end <= 0) return;
    const t0 = performance.now();
    el.textContent = "0";   // já no mesmo frame, para o valor final não piscar antes da contagem
    const step = now => {
      const k = Math.min(1, (now - t0) / 700);
      el.textContent = Math.round(end * (1 - Math.pow(1 - k, 3))).toLocaleString("pt-BR");
      if (k < 1 && el.isConnected) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}
function safeUrl(u){
  u = String(u||"").trim();
  if (!/^https:\/\//i.test(u)) return null;
  return u;
}
function hrefAttr(u){
  const s = safeUrl(u);
  return s ? `href="${esc(s)}"` : "";
}
function stageLabel(key){ return (STAGES.find(s=>s[0]===key)||[key,key])[1]; }
function currentProfile(){
  return profiles.find(p => p.id === currentProfileId) || profiles[0] || FALLBACK_PROFILE;
}

function applyTheme(p){
  const theme = p.theme && typeof p.theme === "object" ? p.theme : {};
  const profileAccent = theme.accent || "#3B6CFF";
  document.documentElement.style.setProperty("--profile-accent", profileAccent);
  /* O cromo do portal fica na paleta ZYMIARA. A cor do perfil não troca --accent. */
  document.title = (p && p.name) ? `${p.name} · ${brandName}` : brandName;
  ["login-title","app-title"].forEach(id => { const el=$( "#"+id ); if (el) el.textContent = brandName; });
  if ($("#login-tag")) $("#login-tag").textContent = productTag();
  if ($("#app-tag")) $("#app-tag").textContent = appName;
  if ($("#dash-sub")) $("#dash-sub").textContent = [p.name, p.niche, p.handle ? `@${p.handle.replace(/^@/,"")}` : ""].filter(Boolean).join(" · ");
}

function fillProfileSelects(){
  const html = profiles.map(p => `<option value="${esc(p.id)}" ${p.id===currentProfileId?"selected":""}>${esc(p.name)}</option>`).join("");
  $("#profile-select").innerHTML = html;
}

function parseRoute(){
  const raw = decodeURIComponent((location.hash || "").replace(/^#\/?/, ""));
  const parts = raw.split("/").filter(Boolean);
  const incoming = parts[0] || "inicio";
  // Início e Fila são a mesma tela (painel consolidado). #/fila/completa abre a fila em largura total.
  const map = {
    inicio:"fila", projetos:"projetos", cortes:"fila", fila:"fila",
    lives:"lives", perfis:"perfis", hoje:"hoje", metas:"metas",
    novo:"novo", numeros:"numeros", formatos:"formatos"
  };
  const tab = map[incoming] || "fila";
  const rest = parts[1] || "";
  const full = tab === "fila" && rest === "completa";
  const focusNew = tab === "projetos" && rest === "novo";
  const projectId = tab === "projetos" && rest && rest !== "novo" ? rest : null;
  return { tab, projectId, focusNew, full };
}
function setTab(name){
  const path = name;
  const h = "#/" + path;
  if (location.hash === h || location.hash === "#/" + name) applyRoute();
  else location.hash = h;
}
function applyRoute(){
  const { tab, projectId, focusNew, full } = parseRoute();
  $$(".tab").forEach(x => {
    const on = x.dataset.tab === tab;
    x.classList.toggle("is-on", on);
    if (on) x.setAttribute("aria-current", "page");
    else x.removeAttribute("aria-current");
  });
  $$(".panel").forEach(p => p.classList.toggle("is-on", p.id === "tab-"+tab));
  $("#tab-fila").classList.toggle("is-full", full);
  railMore(false);
  if (tab === "fila") loadFila();
  if (tab === "lives") loadLives();
  if (tab === "perfis") renderProfiles();
  if (tab === "projetos"){
    tickJob();
    renderProjects(projectId, focusNew);
  }
  if (tab === "hoje") { renderHoje(); loadDiario(); }
  if (tab === "metas") renderMetas();
  if (tab === "novo") renderPedidos();
  if (tab === "numeros") renderNumeros();
  if (tab === "formatos") renderFormatos();
}

function initClient(){
  if (!configured){
    $("#config-warn").hidden = false;
    $("#login-btn").disabled = true;
    return null;
  }
  if (!window.supabase){
    $("#config-warn").hidden = false;
    $("#config-warn").textContent = "Não carreguei a biblioteca do Supabase. Recarregue a página.";
    return null;
  }
  return window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });
}

async function detectSchema(){
  hasProfiles = false;
  hasProfileCols = false;
  hasAjustes = false;
  hasMaestri = hasMetas = hasAgenda = hasFormatReqs = hasFormats = hasStats = hasAccounts = hasKv = false;
  const { data, error } = await sb.from("profiles").select("*").order("created_at", { ascending: true });
  if (!error){
    hasProfiles = true;
    profiles = data && data.length ? data : [FALLBACK_PROFILE];
    if (currentProfileId && !profiles.some(p => p.id === currentProfileId)) currentProfileId = profiles[0].id;
  } else {
    profiles = [FALLBACK_PROFILE];
    currentProfileId = FALLBACK_PROFILE.id;
  }
  const probe = await sb.from("cuts").select("id,profile_id").limit(1);
  hasProfileCols = !probe.error;
  const probeAj = await sb.from("ajustes").select("id").limit(1);
  hasAjustes = !probeAj.error;
  await detectMaestri();
  fillProfileSelects();
  applyTheme(currentProfile());
  const st = $("#style");
  if (st && currentProfile().default_style) st.value = currentProfile().default_style;
  setMaestriBanners();
  schemaReady = true;
}

function cutsForProfile(list){
  if (!hasProfileCols) return list;
  const pid = currentProfile().id;
  return (list || []).filter(c => !c.profile_id || c.profile_id === pid);
}

async function signed(path, cache){
  if (!path) return null;
  const now = Date.now();
  const hit = cache[path];
  if (hit && hit.exp > now + 15_000) return hit.url;
  const { data, error } = await sb.storage.from("previews").createSignedUrl(path, 3600);
  if (error || !data || !data.signedUrl) return null;
  cache[path] = { url: data.signedUrl, exp: now + 50*60*1000 };
  return data.signedUrl;
}
const signedCover = path => signed(path, coverCache);
const signedVideo = path => signed(path, signedCache);

function showApp(){
  document.body.classList.add("is-in");
  try { bindApp(); } catch (e) {
    document.body.classList.remove("is-in");
    showError("Não consegui abrir o aplicativo. Atualize a página. " + (e && e.message ? e.message : ""));
    return;
  }
  if (!location.hash) history.replaceState(null, "", "#/inicio");
  applyRoute();
  detectSchema().then(async () => {
    await loadFila();
    loadLives();
    tickJob();
    renderProfiles();
    subscribe();
    applyRoute();
  }).catch(err => {
    document.body.classList.remove("is-in");
    showError("Não consegui carregar seus dados. Atualize a página. " + (err && err.message ? err.message : ""));
  });
}
function showGate(){ document.body.classList.remove("is-in"); }

async function boot(){
  try {
    ["login-title","app-title"].forEach(id => { const el=$("#"+id); if (el) el.textContent = brandName; });
    if ($("#login-tag")) $("#login-tag").textContent = productTag();
    if ($("#app-tag")) $("#app-tag").textContent = appName;
    document.title = brandName;
    sb = initClient();
    if (!sb){
      showError("Não carreguei a conexão com o banco. Atualize a página.");
      showGate();
      return;
    }
    const { data } = await sb.auth.getSession();
    if (data && data.session) showApp();
    else showGate();
    sb.auth.onAuthStateChange((_e, session) => { if (session) showApp(); else showGate(); });
  } catch (err) {
    showGate();
    showError("Não consegui iniciar a página. Atualize e tente de novo. " + (err && err.message ? err.message : ""));
  }
}

try {
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!sb) return;
  $("#login-err").hidden = true;
  $("#login-btn").disabled = true;
  const { error } = await sb.auth.signInWithPassword({
    email: $("#email").value.trim(),
    password: $("#password").value
  });
  $("#login-btn").disabled = false;
  if (error){
    $("#login-err").hidden = false;
    $("#login-err").textContent = error.message === "Invalid login credentials"
      ? "E-mail ou senha incorretos."
      : error.message;
  }
});
} catch (err) {
  showError("Não consegui ligar o login. Atualize a página.");
}

function bindApp(){
  if (appBound) return;
  appBound = true;
  $("#logout-btn").addEventListener("click", () => sb.auth.signOut());
  window.addEventListener("hashchange", applyRoute);
  $$(".tab").forEach(b => b.addEventListener("click", ev => {
    /* anchors already set the hash; still handle leftover buttons */
    if (b.tagName !== "A") { ev.preventDefault(); setTab(b.dataset.tab); }
  }));
  $$("[data-go]").forEach(b => b.addEventListener("click", ev => {
    ev.preventDefault();
    setTab(b.dataset.go);
  }));
  $("#profile-select").addEventListener("change", e => {
    currentProfileId = e.target.value;
    storageSet("cortes.profile", currentProfileId);
    applyTheme(currentProfile());
    fillProfileSelects();
    const st = $("#style");
    if (st && currentProfile().default_style) st.value = currentProfile().default_style;
    loadFila(); loadLives(); renderDashboard(); renderProfiles();
    loadMaestri();
  });
  bindRail();
  $("#file").addEventListener("change", () => {
    const f = $("#file").files[0];
    $("#file-name").textContent = f ? `${f.name} (${(f.size/1048576).toFixed(1)} MB)` : "";
  });
  $("#run-form").addEventListener("submit", onRun);
  $("#cancel-btn").addEventListener("click", onCancel);
  $("#reload-fila").addEventListener("click", loadFila);
  $("#fila-filter").addEventListener("change", () => renderFila());
  $("#add-channel").addEventListener("submit", onAddChannel);
  $("#lives-settings").addEventListener("submit", onSaveSettings);
  $("#profile-form").addEventListener("submit", onCreateProfile);
  initProfileTemplatePicker();
  $("#player-close").addEventListener("click", closePlayer);
  $("#player-close-bg").addEventListener("click", closePlayer);
  document.addEventListener("keydown", ev => { if (ev.key === "Escape"){ closePlayer(); railMore(false); } });
  $("#player-approve").addEventListener("click", () => decideCurrent("approved"));
  $("#player-reject").addEventListener("click", () => decideCurrent("rejected"));
  if ($("#ajuste-btn")) $("#ajuste-btn").addEventListener("click", requestAjuste);
  if ($("#agenda-btn")) $("#agenda-btn").addEventListener("click", saveAgenda);
  if ($("#meta-form")) $("#meta-form").addEventListener("submit", onSaveMeta);
  if ($("#pedido-form")) $("#pedido-form").addEventListener("submit", onPedido);
  if ($("#pedido-mode")) $("#pedido-mode").addEventListener("change", () => {
    const wrap = $("#pedido-link-wrap");
    if (wrap) wrap.hidden = $("#pedido-mode").value === "nova";
  });
  if ($("#conta-form")) $("#conta-form").addEventListener("submit", onSaveConta);
  if ($("#stat-form")) $("#stat-form").addEventListener("submit", onSaveStat);
  if ($("#btn-pedido-coleta")) $("#btn-pedido-coleta").addEventListener("click", onPedidoColeta);
}

function railMore(on){
  const rail = $("#rail"), btn = $("#rail-more-btn");
  if (!rail || !btn) return;
  rail.classList.toggle("is-open", on);
  btn.setAttribute("aria-expanded", on ? "true" : "false");
}
// text/uri-list pode trazer comentários (#) e várias linhas: vale a primeira URL, e só https.
function linkFromDrop(text){
  const first = String(text||"").split(/\r?\n/).map(t => t.trim()).find(t => t && !t.startsWith("#")) || "";
  return safeUrl(first.split(/\s+/)[0]);
}
// Só abre o formulário já preenchido. Quem roda a esteira é o botão do formulário.
function novoComLink(text){
  const u = linkFromDrop(text);
  if (!u){ toast("Só aceito link https. Cole o endereço completo do vídeo."); return; }
  $("#url").value = u;
  setTab("projetos/novo");
  toast("Link colocado em Novo projeto. Confira e clique em Rodar esteira.");
}
function bindRail(){
  const rail = $("#rail");
  $("#rail-more-btn").addEventListener("click", () => railMore(!rail.classList.contains("is-open")));
  document.addEventListener("click", ev => {
    if (!ev.target.closest("#rail-more, #rail-more-btn")) railMore(false);
  });
  // os próprios ícones não podem ser arrastados para o "+" (viraria link da própria página)
  $$("a", rail).forEach(a => { a.draggable = false; });
  rail.addEventListener("dragover", ev => { ev.preventDefault(); rail.classList.add("is-drop"); });
  rail.addEventListener("dragleave", ev => { if (!rail.contains(ev.relatedTarget)) rail.classList.remove("is-drop"); });
  rail.addEventListener("drop", ev => {
    ev.preventDefault();
    rail.classList.remove("is-drop");
    const dt = ev.dataTransfer;
    if (!dt) return;
    if (dt.files && dt.files.length){
      // sem upload automático: o envio só acontece pelo formulário, com o clique do usuário
      setTab("projetos/novo");
      toast("Para enviar um arquivo, escolha o vídeo no formulário de Novo projeto.");
      return;
    }
    novoComLink(dt.getData("text/uri-list") || dt.getData("text/plain"));
  });
  document.addEventListener("paste", ev => {
    if (!document.body.classList.contains("is-in") || !$("#player").hidden) return;
    if (ev.target && ev.target.closest && ev.target.closest("input,textarea,select,[contenteditable]")) return;
    const text = (ev.clipboardData && ev.clipboardData.getData("text/plain")) || "";
    if (/^\s*https?:\/\//i.test(text)) novoComLink(text);
  });
}

async function onRun(e){
  e.preventDefault();
  const url = $("#url").value.trim();
  const file = $("#file").files[0];
  const style = $("#style").value;
  if (!url && !file){ toast("Cole um link ou envie um arquivo."); return; }
  const max = (cfg.maxUploadMb || 80) * 1048576;
  if (file && file.size > max){
    toast(`O arquivo passa de ${cfg.maxUploadMb || 80} MB. Comprima ou envie um trecho menor.`);
    return;
  }
  $("#run-btn").disabled = true;
  try {
    let storage_path = null;
    if (file){
      const safe = file.name.replace(/[^\w.\-]+/g, "_").slice(0, 80);
      storage_path = `uploads/${Date.now()}-${safe}`;
      const { error } = await sb.storage.from("previews").upload(storage_path, file, {
        contentType: file.type || "video/mp4", upsert: false
      });
      if (error) throw error;
    }
    const row = {
      status: "queued",
      url: url || null,
      storage_path,
      style,
      source: file ? "upload" : "url",
    };
    if (hasProfileCols){
      row.profile_id = currentProfile().id;
      row.workspace_id = currentProfile().workspace_id || SEED_WORKSPACE;
    }
    const { data, error } = await sb.from("jobs").insert(row).select("id").single();
    if (error) throw error;
    currentJobId = data.id;
    toast("Esteira na fila. O servidor vai pegar em instantes.");
    tickJob();
  } catch (err) {
    toast(err.message || "Não foi possível iniciar.");
  } finally {
    $("#run-btn").disabled = false;
  }
}

async function onCancel(){
  if (!currentJobId) return;
  await sb.from("jobs").update({ status: "cancelled", note: "Cancelado pela interface." }).eq("id", currentJobId);
  tickJob();
}

function renderStages(stages){
  const keys = STAGES.map(s=>s[0]);
  Object.keys(stages||{}).forEach(k => { if (!keys.includes(k)) keys.push(k); });
  $("#stages").innerHTML = keys.map(k => {
    const st = (stages && stages[k] && (stages[k].status || stages[k])) || "pending";
    const status = String(st);
    return `<li><span>${esc(stageLabel(k))}</span><span class="st ${esc(status)}">${esc(status)}</span></li>`;
  }).join("");
}

async function tickJob(){
  const q = sb.from("jobs").select("*").order("created_at", { ascending: false }).limit(12);
  const { data, error } = await q;
  if (error) return;
  let jobs = data || [];
  if (hasProfileCols){
    const pid = currentProfile().id;
    jobs = jobs.filter(j => !j.profile_id || j.profile_id === pid);
  }
  const show = jobs.find(j => ["queued","running"].includes(j.status)) || (currentJobId && jobs.find(j => j.id === currentJobId)) || null;
  if (!show){
    $("#job-empty").hidden = false;
    $("#job-body").hidden = true;
    $("#cancel-btn").hidden = true;
    return;
  }
  currentJobId = show.id;
  $("#job-empty").hidden = true;
  $("#job-body").hidden = false;
  $("#cancel-btn").hidden = !["queued","running"].includes(show.status);
  const src = show.source === "upload" ? "arquivo enviado" : (show.url || "");
  $("#job-meta").textContent = `${show.status} · ${show.style || ""} · ${src} · ${show.video_id || ""}${show.note ? " · "+show.note : ""}`;
  renderStages(show.stages || {});
  if (show.log_tail){
    $("#job-log").hidden = false;
    $("#job-log").textContent = String(show.log_tail).split("\n").slice(-30).join("\n");
  }
}


function formatName(it){
  const blob = `${it.title||""} ${it.hook||""}`.toLowerCase();
  const id = String(it.id||"");
  const cid = String(it.cut_id||"");
  if (it.tag === "live" || id.startsWith("live:")) return "Live";
  if (/resenha|meme|humor/.test(blob) || /n03|n04/.test(cid)) return "Resenha/meme";
  if (/meia tela|split/.test(blob) || /n01|n02/.test(cid)) return "Meia tela";
  if (/storytelling/.test(blob) || /n05|n06/.test(cid)) return "Storytelling";
  if (/faixas|letterbox|motion/.test(blob) || /n07|n08/.test(cid)) return "Faixas (motion)";
  if (id.startsWith("video01:") || id.includes("KzV6rqI-xso") || id.includes("y5PBmcPzEF4")) return "Close";
  return "";
}
function sourceShort(it){
  const blob = `${it.title||""} ${it.channel||""} ${it.id||""}`;
  if (/titto|extremos|KzV6rqI-xso|video01:/i.test(blob)) return "Titto";
  if (/claude|y5PBmcPzEF4|jogo da ia/i.test(blob)) return "Claude";
  if (it.tag === "live" || String(it.id||"").startsWith("live:")) return "Live";
  const ch = (it.channel||"").trim();
  return ch ? ch.split(/\s+/)[0] : "Corte";
}
function cutLabel(it){
  return [formatName(it), sourceShort(it)].filter(Boolean).join(" · ");
}

function decisionOf(id){ return (decMap[id] && decMap[id].decision) || "pending"; }
function isOpenDecision(d){ return d === "pending" || d === "ajuste pedido"; }
function decisionMeta(d){
  if (d === "approved") return { badge: "ok", label: "aprovado" };
  if (d === "rejected") return { badge: "no", label: "rejeitado" };
  if (d === "ajuste pedido") return { badge: "ajuste", label: "ajuste pedido" };
  return { badge: "pending", label: "pendente" };
}

async function loadFila(){
  const [{ data: cuts, error: e1 }, { data: decs }] = await Promise.all([
    sb.from("cuts").select("*").order("mtime", { ascending: false, nullsFirst: false }),
    sb.from("decisions").select("*"),
  ]);
  if (e1){
    filaOk = false;
    allCuts = [];
    decMap = {};
    $("#fila").removeAttribute("aria-busy");
    setHtml($("#fila"), `<p class="error">${esc(e1.message)}</p>`);
    renderDashboard();
    return;
  }
  filaOk = true;
  decMap = {};
  (decs || []).forEach(d => { decMap[d.cut_id] = d; });
  allCuts = cutsForProfile(cuts || []);
  await renderFila();
  await renderDashboard();
  if (parseRoute().tab === "projetos") await renderProjects(parseRoute().projectId, parseRoute().focusNew);
}

async function renderFila(){
  const filter = ($("#fila-filter") && $("#fila-filter").value) || "pending";
  let items = allCuts.slice();
  if (filter === "pending") items = items.filter(it => isOpenDecision(decisionOf(it.id)));
  else if (filter === "approved") items = items.filter(it => decisionOf(it.id) === "approved");
  else if (filter === "rejected") items = items.filter(it => decisionOf(it.id) === "rejected");
  else if (filter === "ajuste") items = items.filter(it => decisionOf(it.id) === "ajuste pedido");
  else if (filter === "live") items = items.filter(it => it.tag === "live");
  const root = $("#fila");
  root.removeAttribute("aria-busy");
  if ($("#fila-count")) $("#fila-count").textContent = items.length ? String(items.length) : "";
  const more = $("#fila-more");
  if (more){
    // no celular a home mostra só os 4 primeiros (CSS); o resto fica a um toque
    more.hidden = items.length <= 4;
    more.textContent = `Ver todos os ${items.length} cortes`;
  }
  const animKey = filter + "|" + currentProfile().id;
  if (animKey !== filaAnimKey){
    filaAnimKey = animKey;
    root.classList.add("stagger");
    setTimeout(() => root.classList.remove("stagger"), 900);
  }
  if (!items.length){
    setHtml(root, `<p class="empty">Nenhum corte nesta vista. Se a fila estiver vazia, o servidor ainda está sincronizando.</p>`);
    return;
  }
  // Sign covers only — never attach a video src in the list.
  const covers = {};
  await Promise.all(items.map(async it => {
    covers[it.id] = await signedCover(it.cover_path);
  }));
  if (setHtml(root, items.map(it => cardHtml(it, covers[it.id])).join(""))) bindCutActions(root);
}

function bindCutActions(root){
  if (!root) return;
  root.querySelectorAll("[data-play]").forEach(b => b.addEventListener("click", () => openPlayer(b.dataset.play)));
  root.querySelectorAll("button[data-act]").forEach(b => b.addEventListener("click", ev => {
    ev.stopPropagation();
    decide(b.closest(".cut").dataset.id, b.dataset.act);
  }));
  // "Ajuste" abre o player já no campo de pedido (o pedido continua sendo feito lá)
  root.querySelectorAll("button[data-ajuste]").forEach(b => b.addEventListener("click", async () => {
    await openPlayer(b.closest(".cut").dataset.id);
    const t = $("#ajuste-text");
    if (t && !$("#player").hidden) t.focus();
  }));
}

function projectIdOf(it){
  if (it.video_id) return String(it.video_id);
  if (it.tag === "live") return "live";
  return String(it.source || "outros");
}
function cleanTitle(t){
  return String(t||"").replace(/\s+[—–-]\s+(resenha\/meme|meia tela|storytelling|faixas(?:\s*\(motion\))?|letterbox|close)\s*$/i, "").trim();
}
function groupProjects(cuts){
  const map = new Map();
  for (const c of cuts || []){
    const id = projectIdOf(c);
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(c);
  }
  return [...map.entries()].map(([id, items]) => {
    const first = items[0];
    const title = cleanTitle(first.title) || first.channel || id;
    const url = first.source_url && /^https?:/i.test(first.source_url)
      ? first.source_url
      : (id && !id.startsWith("live") && id !== "outros" ? "https://youtu.be/"+id : "");
    return {
      id,
      title,
      short: sourceShort(first),
      channel: first.channel || "",
      source_url: url,
      items,
      pending: items.filter(i => isOpenDecision(decisionOf(i.id))).length,
      cover: (items.find(i => i.cover_path) || {}).cover_path,
    };
  }).sort((a,b) => b.items.length - a.items.length);
}

async function renderProjects(projectId, focusNew){
  const listEl = $("#project-list");
  const detailEl = $("#project-detail");
  const form = $("#run-form");
  const job = $("#job-card");
  if (!listEl || !detailEl) return;
  const projects = groupProjects(allCuts);
  if (projectId){
    const proj = projects.find(p => p.id === projectId);
    if (!proj){
      toast("Não encontrei esse projeto.");
      history.replaceState(null, "", "#/projetos");
      projectId = null;
    } else {
      listEl.hidden = true;
      detailEl.hidden = false;
      if (form) form.hidden = true;
      if (job) job.hidden = true;
      const hero = $("#project-hero");
      if (hero){
        const link = safeUrl(proj.source_url) ? ` · <a ${hrefAttr(proj.source_url)} target="_blank" rel="noopener">vídeo original</a>` : "";
        hero.innerHTML = `<p class="kicker">${esc(proj.short)}</p>
          <h2>${esc(proj.title)}</h2>
          <p class="meta">${proj.items.length} corte${proj.items.length===1?"":"s"} · ${proj.pending} pendente${proj.pending===1?"":"s"}${link}</p>`;
      }
      const covers = {};
      await Promise.all(proj.items.map(async it => { covers[it.id] = await signedCover(it.cover_path); }));
      const box = $("#project-cuts");
      if (box){
        box.innerHTML = proj.items.map(it => cardHtml(it, covers[it.id])).join("");
        bindCutActions(box);
      }
      return;
    }
  }
  listEl.hidden = false;
  detailEl.hidden = true;
  if (form) form.hidden = false;
  if (job) job.hidden = false;
  const empty = $("#projects-empty");
  const grid = $("#projects-grid");
  if (!projects.length){
    if (empty) empty.hidden = false;
    if (grid) grid.innerHTML = "";
  } else {
    if (empty) empty.hidden = true;
    const covers = {};
    await Promise.all(projects.map(async p => { covers[p.id] = await signedCover(p.cover); }));
    if (grid){
      grid.innerHTML = projects.map(p => {
        const thumb = covers[p.id] ? `<img src="${covers[p.id]}" alt="">` : `<span class="ph"></span>`;
        return `<a class="proj" href="#/projetos/${encodeURIComponent(p.id)}">
          ${thumb}
          <div>
            <h3>${esc(p.short)} · ${esc(p.title)}</h3>
            <p class="meta">${p.items.length} corte${p.items.length===1?"":"s"} · ${p.pending} pendente${p.pending===1?"":"s"}</p>
          </div>
        </a>`;
      }).join("");
    }
  }
  if (focusNew){
    const url = $("#url");
    if (url){ url.scrollIntoView({ block: "center" }); setTimeout(() => url.focus(), 50); }
  }
}

function cardHtml(it, coverUrl){
  const decision = decisionOf(it.id);
  const { badge, label: decLabel } = decisionMeta(decision);
  const qc = it.qc && it.qc.score != null ? `QC ${it.qc.score}` : (it.qc && it.qc.pass === true ? "QC ok" : "");
  const tag = it.tag === "live" ? `<span class="badge live">live</span>` : "";
  const bg = coverUrl ? `style="background-image:url('${coverUrl}')"` : "";
  return `<article class="cut" data-id="${esc(it.id)}">
    <button type="button" class="thumb" data-play="${esc(it.id)}" ${bg} aria-label="Assistir corte"></button>
    <div class="body">
      <div>${tag} <span class="badge ${badge}">${decLabel}</span> <span class="badge">${esc(it.version||"")}</span></div>
      <h3>${esc(it.hook || "Ver prévia")}</h3>
      <p class="meta">${esc(cutLabel(it))}${qc ? " · "+esc(qc) : ""}</p>
      <div class="actions">
        <button class="btn ok" data-act="approved">Aprovar</button>
        <button class="btn danger" data-act="rejected">Rejeitar</button>
        <button type="button" class="btn ghost" data-ajuste aria-label="Pedir ajuste">Ajuste</button>
      </div>
    </div>
  </article>`;
}

async function openPlayer(id){
  const it = allCuts.find(x => x.id === id);
  if (!it) return;
  playerCut = it;
  const decision = decisionOf(id);
  const { badge, label: decLabel } = decisionMeta(decision);
  const tag = it.tag === "live" ? `<span class="badge live">live</span>` : "";
  $("#player-badges").innerHTML = `${tag} <span class="badge ${badge}">${decLabel}</span> <span class="badge">${esc(it.version||"")}</span>`;
  $("#player-hook").textContent = it.hook || "Prévia";
  $("#player-meta").textContent = [cutLabel(it), it.title||""].filter(Boolean).join(" · ");
  const ajText = $("#ajuste-text");
  const ajErr = $("#ajuste-err");
  const ajHint = $("#ajuste-hint");
  if (ajText) ajText.value = "";
  if (ajErr){ ajErr.hidden = true; ajErr.textContent = ""; }
  if (ajHint){
    ajHint.textContent = hasAjustes
      ? "O pedido fica registrado. Nada é publicado e nada muda sozinho."
      : "Para pedir ajuste por aqui, cole o SQL de ajustes no Editor SQL do Supabase e atualize a página.";
  }
  const video = $("#player-video");
  video.pause();
  video.removeAttribute("src");
  video.load();
  const poster = await signedCover(it.cover_path);
  if (poster) video.poster = poster;
  else video.removeAttribute("poster");
  const ag = $("#player-agenda");
  if (ag) ag.hidden = !(hasAgenda && decision === "approved");
  $("#player").hidden = false;
  document.body.style.overflow = "hidden";
  const url = await signedVideo(it.preview_path);
  if (!url){ toast("Não consegui gerar o link da prévia."); return; }
  video.preload = "auto";
  video.src = url;
  try { await video.play(); } catch (e) { /* autoplay blocked: user can tap play */ }
}

function closePlayer(){
  const video = $("#player-video");
  video.pause();
  video.removeAttribute("src");
  video.load();
  $("#player").hidden = true;
  document.body.style.overflow = "";
  playerCut = null;
  const box = $("#player-agenda");
  if (box) box.hidden = true;
}

async function decide(id, act){
  const item = allCuts.find(x => x.id === id) || {};
  const row = {
    cut_id: id,
    decision: act,
    at: new Date().toISOString(),
    hook: item.hook,
    version: item.version,
    source: item.source,
    tag: item.tag,
  };
  if (hasProfileCols){
    row.profile_id = currentProfile().id;
    row.workspace_id = currentProfile().workspace_id || SEED_WORKSPACE;
  }
  const { error } = await sb.from("decisions").upsert(row);
  if (error){ toast(error.message); return; }
  decMap[id] = { cut_id: id, decision: act };
  toast(act === "approved" ? "Aprovado (nada foi publicado)." : "Rejeitado.");
  const box = $("#player-agenda");
  if (box) box.hidden = !(act === "approved" && hasAgenda);
  renderFila();
  renderDashboard();
  renderHoje();
  renderFormatos();
  if (parseRoute().tab === "projetos") renderProjects(parseRoute().projectId, parseRoute().focusNew);
}
function decideCurrent(act){
  if (!playerCut) return;
  decide(playerCut.id, act);
}

async function requestAjuste(){
  if (!playerCut) return;
  const text = (($("#ajuste-text") || {}).value || "").trim();
  const err = $("#ajuste-err");
  if (err){ err.hidden = true; err.textContent = ""; }
  if (!text){
    if (err){ err.hidden = false; err.textContent = "Escreve o que você quer ajustar."; }
    return;
  }
  if (!hasAjustes){
    const msg = "Para pedir ajuste por aqui, cole o SQL de ajustes no Editor SQL do Supabase e atualize a página.";
    if (err){ err.hidden = false; err.textContent = msg; }
    toast(msg);
    return;
  }
  const { data: sessionData } = await sb.auth.getUser();
  const user = sessionData && sessionData.user;
  const row = {
    cut_id: playerCut.id,
    request: text,
    status: "ajuste pedido",
    hook: playerCut.hook || null,
    version: playerCut.version || null,
  };
  if (hasProfileCols){
    row.profile_id = currentProfile().id;
    row.workspace_id = currentProfile().workspace_id || SEED_WORKSPACE;
  }
  if (user) row.requested_by = user.id;
  const { error } = await sb.from("ajustes").insert(row);
  if (error){
    const msg = error.message || "Não consegui salvar o pedido.";
    if (err){ err.hidden = false; err.textContent = msg; }
    toast(msg);
    return;
  }
  const dec = {
    cut_id: playerCut.id,
    decision: "ajuste pedido",
    at: new Date().toISOString(),
    hook: playerCut.hook,
    version: playerCut.version,
    source: playerCut.source,
    tag: playerCut.tag,
  };
  if (hasProfileCols){
    dec.profile_id = currentProfile().id;
    dec.workspace_id = currentProfile().workspace_id || SEED_WORKSPACE;
  }
  const decRes = await sb.from("decisions").upsert(dec);
  if (!decRes.error) decMap[playerCut.id] = { cut_id: playerCut.id, decision: "ajuste pedido" };
  if ($("#ajuste-text")) $("#ajuste-text").value = "";
  toast("Pedido de ajuste registrado. Nada foi publicado e nada muda sozinho.");
  const meta = decisionMeta("ajuste pedido");
  const tag = playerCut.tag === "live" ? `<span class="badge live">live</span>` : "";
  $("#player-badges").innerHTML = `${tag} <span class="badge ${meta.badge}">${meta.label}</span> <span class="badge">${esc(playerCut.version||"")}</span>`;
  renderFila();
  renderDashboard();
  if (parseRoute().tab === "projetos") renderProjects(parseRoute().projectId, parseRoute().focusNew);
}

// Lado direito da home: Hoje e Números condensados. Só usa o que já foi carregado.
function renderDashboard(){
  if (!schemaReady) return;
  renderHojeCompacto();
  renderNumerosCompacto();
}
const SEM_DADOS = `<b class="nodata">sem dados ainda</b>`;
function renderHojeCompacto(){
  const root = $("#hoje-mini");
  if (!root) return;
  const lbl = $("#hoje-mini-data");
  if (lbl) lbl.textContent = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long", day: "2-digit", month: "2-digit" });
  const num = n => `<b data-count="${n}">${n}</b>`;
  const pend = allCuts.filter(it => decisionOf(it.id) === "pending").length;
  const ajustes = allCuts.filter(it => decisionOf(it.id) === "ajuste pedido").length;
  const slots = [];
  if (hasMetas) hojeSlots().forEach(g => g.slots.forEach(sl => slots.push({ h: sl.h, cut: sl.cut, m: g.m, pausada: metaStatus(g.m) === "pausada" })));
  slots.sort((x, y) => String(x.h).localeCompare(String(y.h)));
  const ativos = slots.filter(sl => !sl.pausada);
  const cheios = ativos.filter(sl => sl.cut).length;
  let html = `<div class="kpis">
    <div class="kpi">${filaOk ? num(pend) : SEM_DADOS}<span>pendentes de aprovação</span></div>
    <div class="kpi">${filaOk ? num(ajustes) : SEM_DADOS}<span>com ajuste pedido</span></div>
    <div class="kpi">${ativos.length ? `<b>${cheios}<small>/${ativos.length}</small></b>` : SEM_DADOS}<span>horários de hoje preenchidos</span></div>
  </div>`;
  if (ativos.length){
    html += `<div class="bar" role="img" aria-label="${cheios} de ${ativos.length} horários de hoje preenchidos"><span style="width:${Math.round(cheios / ativos.length * 100)}%"></span></div>`;
  }
  if (!hasMetas) html += `<p class="empty">Metas e agenda ainda não estão ligadas. Os detalhes estão na aba Hoje.</p>`;
  else if (!metas.length) html += `<p class="empty">Nenhuma meta neste perfil. Cadastre na aba Metas, ou deixe vazio — não inventamos quantidade.</p>`;
  else if (!slots.length) html += `<p class="empty">Sem horário definido.</p>`;
  else html += `<div class="slots-mini">` + slots.map(sl => `<div class="slot-mini ${sl.cut ? "is-cheio" : "is-vago"}">
      <b class="hora">${esc(sl.h)}</b>
      <span class="fmt">${esc(sl.m.formato || sl.m.id)}${sl.pausada ? " · pausada" : ""}</span>
      <span class="what">${sl.cut ? esc(sl.cut.hook || sl.cut.id) : "vago"}</span>
    </div>`).join("") + `</div>`;
  if (setHtml(root, html)) countUp(root);
}
const PLAT_NOME = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube" };
function renderNumerosCompacto(){
  const root = $("#numeros-mini");
  if (!root) return;
  const html = numerosData().map(n => {
    const v = n.val == null ? NaN : Number(n.val);
    const valor = Number.isFinite(v)
      ? `<b class="num" data-count="${v}">${v.toLocaleString("pt-BR")}</b><span class="num-un">${n.pl === "youtube" ? "inscritos" : "seguidores"}</span>`
      : SEM_DADOS;
    return `<div class="num-card ${n.pl}">
      <p class="num-plat"><i aria-hidden="true"></i>${PLAT_NOME[n.pl]}</p>
      <p class="num-handle">${esc(n.handle)}</p>
      ${valor}
      <span class="num-fonte">${esc(n.fonte)}</span>
    </div>`;
  }).join("");
  if (setHtml(root, html)) countUp(root);
}


let pendingProfileTemplate = (window.CUT_TEMPLATES && window.CUT_TEMPLATES.default) || "incisao";

function tmplSwatchHtml(tmpl, cls){
  const t = tmpl || window.cutTemplateById();
  if (!t) return "";
  return `<span class="tmpl-swatch${cls?" "+cls:""}" aria-hidden="true"><i style="background:${esc(t.paper)}"></i><i style="background:${esc(t.ink)}"></i><i style="background:${esc(t.highlight)}"></i></span>`;
}

function renderTmplPicker(root, selectedId, onPick){
  if (!root) return;
  const list = (window.CUT_TEMPLATES && window.CUT_TEMPLATES.templates) || [];
  const sel = selectedId || pendingProfileTemplate;
  root.innerHTML = list.map(tmpl => `
    <button type="button" class="tmpl-opt${tmpl.id===sel?" is-on":""}" role="radio" aria-checked="${tmpl.id===sel?"true":"false"}" data-tmpl="${esc(tmpl.id)}">
      ${tmplSwatchHtml(tmpl)}
      <span class="tmpl-copy">
        <strong>${esc(tmpl.label)}</strong>
        <em>${esc(tmpl.caption_font)} · destaque ${esc(tmpl.highlight)}</em>
      </span>
    </button>`).join("");
  root.querySelectorAll("[data-tmpl]").forEach(btn => {
    btn.addEventListener("click", ev => {
      ev.preventDefault();
      ev.stopPropagation();
      const id = btn.dataset.tmpl;
      renderTmplPicker(root, id, onPick);
      if (onPick) onPick(id);
    });
  });
}

function initProfileTemplatePicker(){
  pendingProfileTemplate = (window.CUT_TEMPLATES && window.CUT_TEMPLATES.default) || "incisao";
  renderTmplPicker($("#pf-tmpl-picker"), pendingProfileTemplate, id => { pendingProfileTemplate = id; });
}

async function saveProfileCutTemplate(pid, tmplId){
  const p = profiles.find(x => x.id === pid);
  if (!p) return;
  const tmpl = window.cutTemplateById(tmplId);
  if (!tmpl) return;
  const theme = window.themeFromCutTemplate(tmpl, p.theme && typeof p.theme === "object" ? p.theme : {});
  if (hasProfiles){
    const { data, error } = await sb.from("profiles").update({ theme }).eq("id", pid).select("*").single();
    if (error){ toast(error.message || "Não consegui salvar o template."); return; }
    const i = profiles.findIndex(x => x.id === pid);
    if (i >= 0) profiles[i] = data;
    if (pid === currentProfile().id) applyTheme(data);
  } else {
    p.theme = theme;
    if (pid === currentProfile().id) applyTheme(p);
  }
  toast("Template de cores salvo neste perfil.");
  renderProfiles();
}

function renderProfiles(){
  const box = $("#profiles-migrate");
  const form = $("#profile-form");
  if (box) box.hidden = hasProfiles;
  if (form) form.hidden = !hasProfiles;
  $("#profiles-grid").innerHTML = profiles.map(p => {
    const theme = p.theme && typeof p.theme === "object" ? p.theme : {};
    const tmpl = window.cutTemplateById(window.inferCutTemplateId(theme));
    const on = p.id === currentProfile().id ? " is-on" : "";
    return `<article class="profile-card${on}" data-pid="${esc(p.id)}">
      <button type="button" class="profile-card-hit" data-select-pid="${esc(p.id)}">
        <h3>${tmplSwatchHtml(tmpl, "sm")}${esc(p.name)}</h3>
        <p class="meta">${esc(p.handle ? "@"+p.handle.replace(/^@/,"") : "")} · ${esc(p.niche||"")} · ${esc(p.default_style||"")}</p>
        <p class="tmpl-name">Template: ${esc(tmpl ? tmpl.label : "—")}</p>
      </button>
      <div class="tmpl-picker tmpl-picker-sm" data-tmpl-for="${esc(p.id)}" role="radiogroup" aria-label="Template de cores de ${esc(p.name)}"></div>
    </article>`;
  }).join("");
  $$("#profiles-grid [data-select-pid]").forEach(b => b.addEventListener("click", () => {
    currentProfileId = b.dataset.selectPid;
    storageSet("cortes.profile", currentProfileId);
    applyTheme(currentProfile());
    fillProfileSelects();
    loadFila(); loadLives(); renderDashboard(); renderProfiles();
    loadMaestri();
  }));
  $$("#profiles-grid [data-tmpl-for]").forEach(box => {
    const pid = box.dataset.tmplFor;
    const prof = profiles.find(x => x.id === pid);
    const cur = window.inferCutTemplateId(prof && prof.theme);
    renderTmplPicker(box, cur, id => { saveProfileCutTemplate(pid, id); });
  });
}

async function onCreateProfile(e){
  e.preventDefault();
  $("#pf-err").hidden = true;
  if (!hasProfiles){ toast("Cole o SQL de perfis no Supabase para criar o segundo perfil."); return; }
  const handle = ($("#pf-handle").value || "").replace(/^@/, "").trim();
  const row = {
    workspace_id: currentProfile().workspace_id || SEED_WORKSPACE,
    name: $("#pf-name").value.trim(),
    handle: handle || null,
    niche: $("#pf-niche").value.trim() || null,
    default_style: $("#pf-style").value,
    theme: window.themeFromCutTemplate(window.cutTemplateById(pendingProfileTemplate), {}),
    platforms: {
      instagram: $("#pf-ig").value.trim(),
      tiktok: $("#pf-tt").value.trim(),
      youtube: $("#pf-yt").value.trim(),
    },
  };
  if (!row.name){ $("#pf-err").hidden=false; $("#pf-err").textContent="Dá um nome ao perfil."; return; }
  const { data, error } = await sb.from("profiles").insert(row).select("*").single();
  if (error){ $("#pf-err").hidden=false; $("#pf-err").textContent=error.message; return; }
  profiles.push(data);
  currentProfileId = data.id;
  storageSet("cortes.profile", currentProfileId);
  applyTheme(data);
  fillProfileSelects();
  $("#profile-form").reset();
  initProfileTemplatePicker();
  toast("Perfil criado. A fila dele começa vazia.");
  renderProfiles(); renderDashboard(); loadFila();
  loadMaestri();
}

async function loadLives(){
  const [{ data: channels }, { data: sessions }, { data: words }, { data: settings }] = await Promise.all([
    sb.from("lives_watchlist").select("*").order("added_at", { ascending: true }),
    sb.from("live_sessions").select("*").order("updated_at", { ascending: false }).limit(8),
    sb.from("keywords").select("*").order("word"),
    sb.from("app_settings").select("*"),
  ]);
  let ch = channels || [];
  let sess = sessions || [];
  let kwRows = words || [];
  if (hasProfileCols){
    const pid = currentProfile().id;
    ch = ch.filter(c => !c.profile_id || c.profile_id === pid);
    sess = sess.filter(s => !s.profile_id || s.profile_id === pid);
    kwRows = kwRows.filter(w => !w.profile_id || w.profile_id === pid);
  }
  const set = {};
  (settings || []).forEach(s => { set[s.key] = s.value; });
  const p = currentProfile();
  if ($("#live-style")){
    if (p.live_style) $("#live-style").value = p.live_style;
    else if (set.style) $("#live-style").value = typeof set.style === "string" ? set.style : "close";
  }
  if ($("#lives-enabled")){
    if (typeof p.live_enabled === "boolean") $("#lives-enabled").checked = p.live_enabled;
    else if (typeof set.enabled === "boolean") $("#lives-enabled").checked = set.enabled;
  }
  const kw = kwRows.map(w => w.word).join(", ");
  if ($("#keywords") && document.activeElement !== $("#keywords")) $("#keywords").value = kw;

  const ul = $("#channels");
  if (!ch.length) ul.innerHTML = `<li class="muted">Nenhum canal neste perfil.</li>`;
  else ul.innerHTML = ch.map(c => `<li>
    <div class="name"><strong>${esc(c.name||c.handle||c.id)}</strong>
      <span>${c.enabled===false?"pausado":"ligado"}</span></div>
    <a ${hrefAttr(c.url)} target="_blank" rel="noopener">${esc(c.url)}</a>
    <div class="actions">
      <button class="btn ghost" data-ch="${esc(c.id)}" data-op="toggle">${c.enabled===false?"Ligar":"Pausar"}</button>
      <button class="btn danger" data-ch="${esc(c.id)}" data-op="del">Remover</button>
    </div>
  </li>`).join("");
  ul.querySelectorAll("button[data-ch]").forEach(b => b.addEventListener("click", () => onChannelOp(b.dataset.ch, b.dataset.op)));

  const box = $("#sessions");
  if (!sess.length) box.innerHTML = `<p class="muted">Nenhuma live sendo gravada.</p>`;
  else box.innerHTML = sess.map(s => `<div class="session"><strong>${esc(s.title||s.channel_name||s.id)}</strong>
    <p class="meta">${esc(s.status||"")} · ${esc(s.platform||"")}</p></div>`).join("");
}

async function onChannelOp(id, op){
  if (op === "del") await sb.from("lives_watchlist").delete().eq("id", id);
  else {
    const { data } = await sb.from("lives_watchlist").select("enabled").eq("id", id).single();
    await sb.from("lives_watchlist").update({ enabled: !(data && data.enabled) }).eq("id", id);
  }
  loadLives();
}

async function onAddChannel(e){
  e.preventDefault();
  $("#channel-err").hidden = true;
  const url = $("#channel-url").value.trim();
  const name = $("#channel-name").value.trim();
  if (!url) return;
  const id = "ch-" + Math.random().toString(36).slice(2, 10);
  const row = { id, name: name || url, url, platform: /twitch/i.test(url) ? "twitch" : /tiktok/i.test(url) ? "tiktok" : "youtube", enabled: true };
  if (hasProfileCols){
    row.profile_id = currentProfile().id;
    row.workspace_id = currentProfile().workspace_id || SEED_WORKSPACE;
  }
  const { error } = await sb.from("lives_watchlist").insert(row);
  if (error){ $("#channel-err").hidden=false; $("#channel-err").textContent=error.message; return; }
  $("#channel-url").value = ""; $("#channel-name").value = "";
  loadLives();
}

async function onSaveSettings(e){
  e.preventDefault();
  const style = $("#live-style").value;
  const enabled = $("#lives-enabled").checked;
  const words = $("#keywords").value.split(",").map(s => s.trim()).filter(Boolean);
  if (hasProfiles){
    await sb.from("profiles").update({ live_style: style, live_enabled: enabled }).eq("id", currentProfile().id);
    const p = currentProfile();
    p.live_style = style; p.live_enabled = enabled;
  } else {
    await sb.from("app_settings").upsert({ key: "style", value: style });
    await sb.from("app_settings").upsert({ key: "enabled", value: enabled });
  }
  const { data: existing } = await sb.from("keywords").select("*");
  let rows = existing || [];
  if (hasProfileCols) rows = rows.filter(r => !r.profile_id || r.profile_id === currentProfile().id);
  const have = new Set(rows.map(r => (r.word||"").toLowerCase()));
  const want = new Set(words.map(w => w.toLowerCase()));
  for (const r of rows){
    if (!want.has((r.word||"").toLowerCase())) await sb.from("keywords").delete().eq("id", r.id);
  }
  const toAdd = words.filter(w => !have.has(w.toLowerCase())).map(word => {
    const row = { word };
    if (hasProfileCols){ row.profile_id = currentProfile().id; row.workspace_id = currentProfile().workspace_id || SEED_WORKSPACE; }
    return row;
  });
  if (toAdd.length) await sb.from("keywords").insert(toAdd);
  toast("Ajustes de live salvos.");
}

function subscribe(){
  try {
    sb.channel("cortes-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "cuts" }, () => loadFila())
      .on("postgres_changes", { event: "*", schema: "public", table: "decisions" }, () => loadFila())
      .on("postgres_changes", { event: "*", schema: "public", table: "jobs" }, () => tickJob())
      .on("postgres_changes", { event: "*", schema: "public", table: "lives_watchlist" }, () => loadLives())
      .on("postgres_changes", { event: "*", schema: "public", table: "profiles" }, () => detectSchema())
      .subscribe();
  } catch (e) { /* realtime is optional */ }
}


async function probeTable(name){
  const { error } = await sb.from(name).select("*").limit(1);
  return !error;
}
async function detectMaestri(){
  hasMetas = await probeTable("metas");
  hasAgenda = await probeTable("agenda");
  hasFormatReqs = await probeTable("format_requests");
  hasFormats = await probeTable("formats");
  hasStats = await probeTable("stats");
  hasAccounts = await probeTable("social_accounts");
  hasKv = await probeTable("panel_kv");
  hasMaestri = hasMetas || hasAgenda || hasFormatReqs || hasFormats || hasStats;
  if (hasMaestri) await loadMaestri();
  else {
    metas = []; agendaRows = []; formatReqs = []; formatRows = []; statRows = []; accountRows = []; diarioLines = [];
  }
}
function setMaestriBanners(){
  const map = {
    "faixa-maestri-hoje": !hasMetas,
    "faixa-maestri-metas": !hasMetas,
    "faixa-maestri-novo": !hasFormatReqs,
    "faixa-maestri-numeros": !hasStats && !hasAccounts,
    "faixa-maestri-formatos": !hasFormats,
  };
  Object.keys(map).forEach(id => { const el = $("#"+id); if (el) el.hidden = !map[id]; });
  const mf = $("#meta-form"); if (mf) mf.hidden = !hasMetas;
  const cf = $("#conta-form"); if (cf) cf.hidden = !hasAccounts;
  const sf = $("#stat-form"); if (sf) sf.hidden = !hasStats;
  const bc = $("#btn-pedido-coleta"); if (bc) bc.hidden = !hasAccounts;
}
function profileFilter(rows, key){
  const pid = currentProfile().id;
  return (rows || []).filter(r => !r[key] || r[key] === pid);
}
async function loadMaestri(){
  if (hasMetas){
    const { data, error } = await sb.from("metas").select("*").order("ordem", { ascending: true });
    metas = error ? [] : profileFilter(data || [], "profile_id");
  }
  if (hasAgenda){
    const { data, error } = await sb.from("agenda").select("*").order("scheduled_at", { ascending: true });
    agendaRows = error ? [] : profileFilter(data || [], "profile_id");
  }
  if (hasFormatReqs){
    const { data, error } = await sb.from("format_requests").select("*").order("created_at", { ascending: false });
    formatReqs = error ? [] : profileFilter(data || [], "profile_id");
  }
  if (hasFormats){
    const { data, error } = await sb.from("formats").select("*").order("created_at", { ascending: true });
    formatRows = error ? [] : profileFilter(data || [], "profile_id");
  }
  if (hasStats){
    const { data, error } = await sb.from("stats").select("*").order("captured_at", { ascending: false }).limit(200);
    statRows = error ? [] : profileFilter(data || [], "profile_id");
  }
  if (hasAccounts){
    const { data, error } = await sb.from("social_accounts").select("*").order("ordem", { ascending: true });
    accountRows = error ? [] : profileFilter(data || [], "profile_id");
  }
  setMaestriBanners();
  const tab = parseRoute().tab;
  if (tab === "hoje") { renderHoje(); loadDiario(); }
  if (tab === "metas") renderMetas();
  if (tab === "novo") renderPedidos();
  if (tab === "numeros") renderNumeros();
  if (tab === "formatos") renderFormatos();
  renderDashboard();
}
async function loadDiario(){
  const el = $("#diario-lines");
  if (!el) return;
  if (!hasKv){ el.textContent = "sem dados ainda"; return; }
  const { data, error } = await sb.from("panel_kv").select("value").eq("key", "diario").maybeSingle();
  if (error || !data || !data.value){ el.textContent = "sem dados ainda"; return; }
  const lines = (data.value.lines || []).filter(Boolean);
  diarioLines = lines;
  el.textContent = lines.length ? lines.join("\n") : "sem dados ainda";
}
function brDate(iso){
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" });
}
function todayISO(){
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year:"numeric", month:"2-digit", day:"2-digit" }).formatToParts(new Date());
  const g = k => (parts.find(p => p.type===k) || {}).value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}
function metaStatus(m){
  return m.ativo === false || /pausad/i.test(m.status||"") ? "pausada" : (m.status || "ativa");
}
// "AAAA-MM-DD HH:MM" no fuso de Brasília
function agendaKey(when){
  const d = new Date(when);
  if (isNaN(d)) return "";
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone:"America/Sao_Paulo", hour:"2-digit", minute:"2-digit", year:"numeric", month:"2-digit", day:"2-digit", hour12:false }).formatToParts(d);
  const g = k => (parts.find(p=>p.type===k)||{}).value;
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}`;
}
// Horários das metas de hoje contra a agenda. Fonte única da aba Hoje e do resumo da home.
function hojeSlots(){
  const iso = todayISO();
  const byId = Object.fromEntries(cutsForProfile(allCuts).map(c => [c.id, c]));
  const byKey = {};
  agendaRows.forEach(a => { const k = agendaKey(a.scheduled_at); if (k && !(k in byKey)) byKey[k] = a; });
  return metas.map(m => ({
    m,
    slots: (m.horarios || []).map(h => {
      const hit = byKey[`${iso} ${String(h).padStart(5,"0")}`];
      return { h, cut: (hit && byId[hit.cut_id]) || null };
    }),
  }));
}
function renderHoje(){
  const root = $("#hoje-lista");
  if (!root) return;
  const titulo = $("#hoje-titulo");
  if (titulo){
    const [, m, d] = todayISO().split("-");
    titulo.textContent = `Hoje · ${d}/${m}`;
  }
  if (!hasMetas){ root.innerHTML = ""; return; }
  if (!metas.length){
    root.innerHTML = `<p class="muted">Nenhuma meta neste perfil. Cadastre na aba Metas, ou deixe vazio — não inventamos quantidade.</p>`;
    return;
  }
  root.innerHTML = hojeSlots().map(({ m, slots }) => {
    const por = m.por_dia == null ? "a definir" : m.por_dia;
    const linhas = !slots.length
      ? `<p class="muted">Sem horário definido.</p>`
      : slots.map(({ h, cut }) => `<div class="slot${cut ? " is-cheio" : ""}"><div><div class="hora">${esc(h)}</div><p class="meta">${esc(m.formato||m.id)}</p></div><div>${cut ? esc(cut.hook || cut.id) : "vago"}</div></div>`).join("");
    return `<div class="meta-card"><h3>${esc(m.formato || m.id)}</h3>
      <p class="meta">${esc(por)} por dia · ${esc(metaStatus(m))}</p>${linhas}</div>`;
  }).join("");
}
function renderMetas(){
  const root = $("#metas-lista");
  if (!root) return;
  if (!hasMetas){ root.innerHTML = ""; return; }
  if (!metas.length){
    root.innerHTML = `<p class="muted">Nenhuma meta ainda. Se a quantidade não estiver definida, não produza além do combinado e não invente número.</p>`;
    return;
  }
  root.innerHTML = `<table class="table"><thead><tr><th>Formato</th><th>Por dia</th><th>Horários</th><th>Status</th></tr></thead><tbody>` +
    metas.map(m => `<tr>
      <td>${esc(m.formato || m.id)}</td>
      <td>${m.por_dia == null ? "a definir" : m.por_dia}</td>
      <td>${esc((m.horarios||[]).join(", ") || "a definir")}</td>
      <td>${esc(m.ativo === false ? "pausada" : (m.status || "ativa"))}</td>
    </tr>`).join("") + `</tbody></table>`;
}
function slugify(s){
  return String(s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,40) || "meta";
}
async function onSaveMeta(e){
  e.preventDefault();
  const err = $("#meta-err");
  if (err){ err.hidden = true; err.textContent = ""; }
  if (!hasMetas){ toast("Cole o SQL do painel no Supabase para cadastrar metas."); return; }
  const formato = $("#meta-formato").value.trim();
  const rawId = ($("#meta-id").value.trim() || slugify(formato));
  const pid = currentProfile().id;
  const id = rawId.includes(pid.slice(0,8)) ? rawId : `${slugify(currentProfile().handle || currentProfile().name)}-${rawId}`;
  const porRaw = $("#meta-pordia").value;
  const horas = $("#meta-horas").value.split(",").map(s => s.trim()).filter(Boolean);
  const plats = $("#meta-plats").value.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const row = {
    id,
    formato: formato || rawId,
    profile_id: pid,
    profile_nome: currentProfile().name,
    por_dia: porRaw === "" ? null : Number(porRaw),
    horarios: horas,
    plataformas: plats.length ? plats : ["instagram","tiktok","youtube"],
    ativo: $("#meta-ativa").checked,
    status: $("#meta-ativa").checked ? "ativa" : "pausada",
  };
  const { error } = await sb.from("metas").upsert(row);
  if (error){
    if (err){ err.hidden = false; err.textContent = error.message; }
    toast(error.message);
    return;
  }
  toast("Meta salva. O Hermes lê no próximo ciclo do worker.");
  await loadMaestri();
  renderMetas();
}
function renderPedidos(){
  const root = $("#pedidos-lista");
  if (!root) return;
  if (!hasFormatReqs){ root.innerHTML = ""; return; }
  if (!formatReqs.length){ root.innerHTML = `<p class="muted">Nenhum pedido de formato ainda.</p>`; return; }
  const stNome = { novo:"novo", em_criacao:"em criação", piloto:"piloto", aprovado:"aprovado" };
  root.innerHTML = formatReqs.map(p => `<div class="fmt-card">
    <h3>${esc(p.name || "sem nome")}</h3>
    <p class="meta">${esc(stNome[p.status] || p.status)} · ${esc(p.mode || "")} · ${esc(brDate(p.created_at))}</p>
    <p>${esc(p.premise || p.notes || "")}</p>
    ${safeUrl(p.link) ? `<p class="meta"><a ${hrefAttr(p.link)} target="_blank" rel="noopener">${esc(p.link)}</a></p>` : ""}
  </div>`).join("");
}
async function onPedido(e){
  e.preventDefault();
  const err = $("#pedido-err");
  if (err){ err.hidden = true; err.textContent = ""; }
  if (!hasFormatReqs){
    const msg = "Cole o sql/migration_maestri.sql no Supabase para enviar o pedido por aqui.";
    if (err){ err.hidden = false; err.textContent = msg; }
    toast(msg);
    return;
  }
  const mode = $("#pedido-mode").value;
  const name = $("#pedido-nome").value.trim();
  const link = ($("#pedido-link").value || "").trim();
  if (mode === "link" && !link){
    if (err){ err.hidden = false; err.textContent = "Cole o link de referência, ou mude o modo para criar do zero."; }
    return;
  }
  const { data: sessionData } = await sb.auth.getUser();
  const email = sessionData && sessionData.user && sessionData.user.email;
  const row = {
    profile_id: currentProfile().id,
    profile_nome: currentProfile().name,
    mode,
    name,
    link: mode === "link" ? link : null,
    style: $("#pedido-style").value,
    premise: $("#pedido-premissa").value.trim() || null,
    notes: $("#pedido-notas").value.trim() || null,
    status: "novo",
    created_by: email || null,
  };
  const { error } = await sb.from("format_requests").insert(row);
  if (error){
    if (err){ err.hidden = false; err.textContent = error.message; }
    toast(error.message);
    return;
  }
  toast("Pedido de formato registrado. Nada foi publicado.");
  $("#pedido-nome").value = "";
  $("#pedido-link").value = "";
  $("#pedido-premissa").value = "";
  $("#pedido-notas").value = "";
  await loadMaestri();
  renderPedidos();
}
function formatoDe(it){
  return (it && (it.formato || it.style || it.default_style)) || (it && it.qc && it.qc.style) || "";
}
function statsFormato(nome){
  const cuts = cutsForProfile(allCuts).filter(c => (formatoDe(c) || "").toLowerCase() === String(nome||"").toLowerCase() || (c.version||"").toLowerCase().includes(String(nome||"").toLowerCase()));
  // Prefer cuts whose style matches; if none tagged, fall back to all? No — don't invent. If we can't tell the format, skip.
  const tagged = cutsForProfile(allCuts).filter(c => {
    const f = (c.style || (c.qc && (c.qc.style || c.qc.format)) || c.formato || "").toLowerCase();
    return f && f === String(nome||"").toLowerCase();
  });
  const list = tagged;
  const revisados = list.filter(c => {
    const d = decisionOf(c.id);
    return d === "approved" || d === "rejected";
  });
  const aprovados = revisados.filter(c => decisionOf(c.id) === "approved");
  return { total: list.length, revisados: revisados.length, aprovados: aprovados.length, rate: revisados.length ? aprovados.length / revisados.length : 0 };
}
function renderFormatos(){
  const root = $("#formatos-lista");
  if (!root) return;
  if (!hasFormats){ root.innerHTML = ""; return; }
  const known = [];
  const seen = new Set();
  formatRows.forEach(f => { known.push(f); seen.add((f.nome || f.id || "").toLowerCase()); });
  // also show recipe names present in metas
  metas.forEach(m => {
    const nome = m.formato || m.id;
    if (nome && !seen.has(String(nome).toLowerCase())){
      known.push({ id: m.id, nome, profile_id: m.profile_id, status: "em_teste", min_reviews: 10, min_rate: 0.8, _virtual: true });
      seen.add(String(nome).toLowerCase());
    }
  });
  if (!known.length){
    root.innerHTML = `<p class="muted">Nenhum formato cadastrado ainda. Os cortes aprovados e rejeitados deste perfil entram na conta quando o formato estiver identificado.</p>`;
    return;
  }
  root.innerHTML = known.map(f => {
    const st = statsFormato(f.nome || f.id);
    const need = f.min_reviews || 10;
    const minRate = Number(f.min_rate || 0.8);
    const pct = st.revisados ? Math.round(st.rate * 100) : 0;
    const canLib = f.status === "em_teste" && st.revisados >= need && st.rate >= minRate;
    const bar = Math.min(100, Math.round((st.revisados / need) * 100));
    const status = f.status === "liberado" ? "liberado" : f.status === "pausado" ? "pausado" : "em teste";
    const actions = hasFormats && !f._virtual ? (
      (canLib ? `<button type="button" class="btn primary" data-fmt="${esc(f.id)}" data-fmt-act="liberar">Liberar formato</button>` : "") +
      (f.status === "liberado" ? `<button type="button" class="btn ghost" data-fmt="${esc(f.id)}" data-fmt-act="pausar">Pausar</button>` : "") +
      (f.status === "pausado" ? `<button type="button" class="btn ghost" data-fmt="${esc(f.id)}" data-fmt-act="teste">Voltar a teste</button>` : "")
    ) : "";
    return `<div class="fmt-card">
      <h3>${esc(f.nome || f.id)}</h3>
      <p class="meta">${esc(status)} · ${st.revisados} revisados · ${st.aprovados} aprovados${st.revisados? " · "+pct+"%":""}</p>
      <div class="bar" aria-hidden="true"><span style="width:${bar}%"></span></div>
      <p class="hint tight">Meta para liberar: ${need} revisados e ${Math.round(minRate*100)}% aprovados. Liberar não autoriza postar.</p>
      <div class="actions">${actions}</div>
    </div>`;
  }).join("");
  root.querySelectorAll("[data-fmt-act]").forEach(btn => {
    btn.addEventListener("click", () => onFormatoAct(btn.dataset.fmt, btn.dataset.fmtAct));
  });
}
async function onFormatoAct(id, act){
  if (!hasFormats || !id) return;
  let error;
  if (act === "liberar"){
    const res = await sb.rpc("cortes_liberar_formato", { p_id: id });
    error = res.error;
  } else {
    const status = act === "pausar" ? "pausado" : "em_teste";
    const res = await sb.rpc("cortes_set_formato_status", { p_id: id, p_status: status });
    error = res.error;
  }
  if (error){ toast(error.message || "Não consegui atualizar o formato."); return; }
  toast(act === "liberar" ? "Formato liberado. Postar continua precisando do seu ok." : "Status do formato atualizado.");
  await loadMaestri();
  renderFormatos();
}
function lastStat(plat, field){
  return (statRows || []).find(n => n.platform === plat && n.scope === "conta" && n[field] != null);
}
// Último número de seguidores por plataforma. Fonte única da aba Números e do resumo da home.
function numerosData(){
  return ["instagram","tiktok","youtube"].map(pl => {
    const acc = (accountRows || []).find(a => a.platform === pl);
    const fol = lastStat(pl, "followers");
    return {
      pl,
      handle: (acc && acc.handle) || (currentProfile().platforms && currentProfile().platforms[pl]) || "",
      val: fol && fol.followers != null ? fol.followers : null,
      fonte: fol ? `${fol.source || "manual"} · ${brDate(fol.captured_at)}` : "",
    };
  });
}
function renderNumeros(){
  const root = $("#numeros-corpo");
  if (!root) return;
  if (!hasStats && !hasAccounts){ root.innerHTML = `<p class="muted">sem dados ainda</p>`; return; }
  const cards = numerosData().map(({ pl, handle, val, fonte }) => `<div class="stat">
      <span>${pl}${handle? " · "+esc(handle):""}</span>
      <b>${val == null ? "sem dados ainda" : val.toLocaleString("pt-BR")}</b>
      <span>${esc(fonte)}</span>
    </div>`).join("");
  const hasAny = (statRows || []).some(n => n.followers != null || n.views != null);
  root.innerHTML = `<div class="num-grid">${cards}</div>` + (hasAny ? "" : `<p class="muted">sem dados ainda</p>`);
}
async function onSaveConta(e){
  e.preventDefault();
  const err = $("#conta-err");
  if (err){ err.hidden = true; }
  if (!hasAccounts) return;
  const plat = $("#conta-plat").value;
  const handle = $("#conta-handle").value.trim();
  const url = $("#conta-url").value.trim();
  const pid = currentProfile().id;
  const row = {
    id: `${pid}:${plat}`,
    profile_id: pid,
    profile_nome: currentProfile().name,
    platform: plat,
    handle,
    url: url || null,
    connect_status: "manual",
  };
  const { error } = await sb.from("social_accounts").upsert(row);
  if (error){ if (err){ err.hidden=false; err.textContent=error.message; } toast(error.message); return; }
  toast("Conta salva. Nenhuma rede foi conectada.");
  await loadMaestri();
  renderNumeros();
}
async function onSaveStat(e){
  e.preventDefault();
  const err = $("#stat-err");
  if (err){ err.hidden = true; }
  if (!hasStats) return;
  const raw = $("#stat-followers").value;
  if (raw === ""){ if (err){ err.hidden=false; err.textContent="Se não houver número, não lance nada — a aba já mostra “sem dados ainda”."; } return; }
  const { data: sessionData } = await sb.auth.getUser();
  const email = sessionData && sessionData.user && sessionData.user.email;
  const row = {
    profile_id: currentProfile().id,
    platform: $("#stat-plat").value,
    scope: "conta",
    followers: Number(raw),
    source: "manual",
    note: $("#stat-note").value.trim() || null,
    captured_at: new Date().toISOString(),
    created_by: email || null,
  };
  const { error } = await sb.from("stats").insert(row);
  if (error){ if (err){ err.hidden=false; err.textContent=error.message; } toast(error.message); return; }
  toast("Número lançado.");
  $("#stat-followers").value = "";
  $("#stat-note").value = "";
  await loadMaestri();
  renderNumeros();
}
async function onPedidoColeta(){
  if (!hasAccounts){ toast("Cole o SQL do painel para pedir a coleta."); return; }
  const pid = currentProfile().id;
  const now = new Date().toISOString();
  const mine = accountRows.filter(a => a.profile_id === pid);
  if (!mine.length){ toast("Cadastre pelo menos uma conta neste perfil."); return; }
  for (const a of mine){
    await sb.from("social_accounts").update({ refresh_requested_at: now }).eq("id", a.id);
  }
  toast("Pedido de coleta registrado. O job do Mac (9h ou o próximo ciclo) pede ao Postagem, só leitura.");
}
async function saveAgenda(){
  const err = $("#agenda-err");
  if (err){ err.hidden = true; err.textContent = ""; }
  if (!hasAgenda || !playerCut){
    if (err){ err.hidden = false; err.textContent = "Cole o SQL do painel no Supabase para agendar."; }
    return;
  }
  const when = $("#agenda-when").value;
  if (!when){
    if (err){ err.hidden = false; err.textContent = "Escolha data e hora (Brasília)."; }
    return;
  }
  // datetime-local is naive; treat as Brasília (UTC-3, no DST in 2026)
  const iso = when.length === 16 ? when + ":00-03:00" : when;
  const { data: sessionData } = await sb.auth.getUser();
  const email = sessionData && sessionData.user && sessionData.user.email;
  const row = {
    cut_id: playerCut.id,
    profile_id: currentProfile().id,
    platform: $("#agenda-plat").value,
    scheduled_at: iso,
    updated_by: email || null,
  };
  const { error } = await sb.from("agenda").upsert(row, { onConflict: "cut_id,platform" });
  if (error){ if (err){ err.hidden=false; err.textContent=error.message; } toast(error.message); return; }
  toast("Horário salvo. Nada foi publicado.");
  await loadMaestri();
  renderHoje();
}

try { boot(); } catch (err) { showGate(); showError("Não consegui iniciar a página."); }
