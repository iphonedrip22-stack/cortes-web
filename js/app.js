/* Cortes Studio — public GitHub Pages frontend. Uses only the anon key. */
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
  theme: { bg: "#0a0a0a", accent: "#ffd400", text: "#111111" },
  platforms: { instagram: "@diretoaosso", tiktok: "@diretoaosso", youtube: "" },
};

const cfg = window.CORTES_CONFIG || {};
const appName = cfg.appName || "Cortes Studio";
const appTagline = cfg.appTagline || "Cortes para redes, em vários perfis";
const configured = !!(cfg.supabaseUrl && cfg.supabaseAnonKey);

let sb = null;
let currentJobId = null;
let hasProfiles = false;
let hasProfileCols = false;
let profiles = [];
let currentProfileId = storageGet("cortes.profile") || SEED_PROFILE;
let allCuts = [];
let decMap = {};
let playerCut = null;
let signedCache = {};
let coverCache = {};
let appBound = false;

function toast(msg){
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("is-on");
  setTimeout(() => t.classList.remove("is-on"), 2800);
}
function esc(s){
  return String(s||"").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]));
}
function stageLabel(key){ return (STAGES.find(s=>s[0]===key)||[key,key])[1]; }
function currentProfile(){
  return profiles.find(p => p.id === currentProfileId) || profiles[0] || FALLBACK_PROFILE;
}

function applyTheme(p){
  const theme = p.theme && typeof p.theme === "object" ? p.theme : {};
  const accent = theme.accent || "#ffd400";
  const ink = theme.text || "#111111";
  document.documentElement.style.setProperty("--accent", accent);
  document.documentElement.style.setProperty("--accent-ink", ink);
  const initials = (p.name || "CS").split(/\s+/).map(w => w[0]).join("").slice(0,2).toUpperCase();
  ["login-mark","app-mark","app-mark-m"].forEach(id => { const el=$( "#"+id ); if (el) el.textContent = initials || "CS"; });
  const title = appName;
  document.title = `${p.name} · ${title}`;
  ["login-title","app-title","app-title-m"].forEach(id => { const el=$( "#"+id ); if (el) el.textContent = title; });
  if ($("#login-tag")) $("#login-tag").textContent = appTagline;
  if ($("#app-tag")) $("#app-tag").textContent = p.name;
  if ($("#profile-label-m")) $("#profile-label-m").textContent = p.handle ? `@${p.handle.replace(/^@/,"")}` : (p.niche || "");
  if ($("#dash-kicker")) $("#dash-kicker").textContent = p.niche || "Perfil";
  if ($("#dash-title")) $("#dash-title").textContent = p.name;
  if ($("#dash-sub")) $("#dash-sub").textContent = [p.niche, p.handle ? `@${p.handle.replace(/^@/,"")}` : ""].filter(Boolean).join(" · ");
}

function fillProfileSelects(){
  const html = profiles.map(p => `<option value="${esc(p.id)}" ${p.id===currentProfileId?"selected":""}>${esc(p.name)}</option>`).join("");
  ["#profile-select","#profile-select-m"].forEach(sel => { const el=$(sel); if (el) el.innerHTML = html; });
}

function parseRoute(){
  const raw = decodeURIComponent((location.hash || "").replace(/^#\/?/, ""));
  const parts = raw.split("/").filter(Boolean);
  const incoming = parts[0] || "inicio";
  const map = { inicio:"inicio", projetos:"projetos", cortes:"fila", fila:"fila", lives:"lives", perfis:"perfis" };
  const tab = map[incoming] || "inicio";
  const rest = parts[1] || "";
  const focusNew = tab === "projetos" && rest === "novo";
  const projectId = tab === "projetos" && rest && rest !== "novo" ? rest : null;
  return { tab, projectId, focusNew };
}
function setTab(name){
  const path = name === "fila" ? "cortes" : name;
  const h = "#/" + path;
  if (location.hash === h || location.hash === "#/" + name) applyRoute();
  else location.hash = h;
}
function applyRoute(){
  const { tab, projectId, focusNew } = parseRoute();
  $$(".tab").forEach(x => x.classList.toggle("is-on", x.dataset.tab === tab));
  $$(".panel").forEach(p => p.classList.toggle("is-on", p.id === "tab-"+tab));
  if (tab === "fila") loadFila();
  if (tab === "lives") loadLives();
  if (tab === "inicio") renderDashboard();
  if (tab === "perfis") renderProfiles();
  if (tab === "projetos"){
    tickJob();
    renderProjects(projectId, focusNew);
  }
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
  fillProfileSelects();
  applyTheme(currentProfile());
  const st = $("#style");
  if (st && currentProfile().default_style) st.value = currentProfile().default_style;
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
  detectSchema().then(async () => {
    await loadFila();
    loadLives();
    tickJob();
    renderProfiles();
    subscribe();
    if (!location.hash) history.replaceState(null, "", "#/inicio");
    applyRoute();
  }).catch(err => {
    document.body.classList.remove("is-in");
    showError("Não consegui carregar seus dados. Atualize a página. " + (err && err.message ? err.message : ""));
  });
}
function showGate(){ document.body.classList.remove("is-in"); }

async function boot(){
  try {
    ["login-title","app-title","app-title-m"].forEach(id => { const el=$("#"+id); if (el) el.textContent = appName; });
    if ($("#login-tag")) $("#login-tag").textContent = appTagline;
    document.title = appName;
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
  ["#profile-select","#profile-select-m"].forEach(sel => {
    $(sel).addEventListener("change", e => {
      currentProfileId = e.target.value;
      storageSet("cortes.profile", currentProfileId);
      applyTheme(currentProfile());
      fillProfileSelects();
      const st = $("#style");
      if (st && currentProfile().default_style) st.value = currentProfile().default_style;
      loadFila(); loadLives(); renderDashboard(); renderProfiles();
    });
  });
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
  $("#player-close").addEventListener("click", closePlayer);
  $("#player-close-bg").addEventListener("click", closePlayer);
  document.addEventListener("keydown", ev => { if (ev.key === "Escape") closePlayer(); });
  $("#player-approve").addEventListener("click", () => decideCurrent("approved"));
  $("#player-reject").addEventListener("click", () => decideCurrent("rejected"));
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

async function loadFila(){
  const [{ data: cuts, error: e1 }, { data: decs }] = await Promise.all([
    sb.from("cuts").select("*").order("mtime", { ascending: false, nullsFirst: false }),
    sb.from("decisions").select("*"),
  ]);
  if (e1){ $("#fila").innerHTML = `<p class="error">${esc(e1.message)}</p>`; return; }
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
  if (filter === "pending") items = items.filter(it => decisionOf(it.id) === "pending");
  else if (filter === "approved") items = items.filter(it => decisionOf(it.id) === "approved");
  else if (filter === "rejected") items = items.filter(it => decisionOf(it.id) === "rejected");
  else if (filter === "live") items = items.filter(it => it.tag === "live");
  if (!items.length){
    $("#fila").innerHTML = `<p class="muted">Nenhum corte nesta vista. Se a fila estiver vazia, o servidor ainda está sincronizando.</p>`;
    return;
  }
  // Sign covers only — never attach a video src in the list.
  const covers = {};
  await Promise.all(items.map(async it => {
    covers[it.id] = await signedCover(it.cover_path);
  }));
  $("#fila").innerHTML = items.map(it => cardHtml(it, covers[it.id])).join("");
  bindCutActions($("#fila"));
}

function bindCutActions(root){
  if (!root) return;
  root.querySelectorAll("[data-play]").forEach(b => b.addEventListener("click", () => openPlayer(b.dataset.play)));
  root.querySelectorAll("button[data-act]").forEach(b => b.addEventListener("click", ev => {
    ev.stopPropagation();
    decide(b.closest(".cut").dataset.id, b.dataset.act);
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
      pending: items.filter(i => decisionOf(i.id) === "pending").length,
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
        const link = proj.source_url ? ` · <a href="${esc(proj.source_url)}" target="_blank" rel="noopener">vídeo original</a>` : "";
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
  const badge = decision==="approved" ? "ok" : decision==="rejected" ? "no" : "pending";
  const decLabel = decision==="approved" ? "aprovado" : decision==="rejected" ? "rejeitado" : "pendente";
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
      </div>
    </div>
  </article>`;
}

async function openPlayer(id){
  const it = allCuts.find(x => x.id === id);
  if (!it) return;
  playerCut = it;
  const decision = decisionOf(id);
  const badge = decision==="approved" ? "ok" : decision==="rejected" ? "no" : "pending";
  const decLabel = decision==="approved" ? "aprovado" : decision==="rejected" ? "rejeitado" : "pendente";
  const tag = it.tag === "live" ? `<span class="badge live">live</span>` : "";
  $("#player-badges").innerHTML = `${tag} <span class="badge ${badge}">${decLabel}</span> <span class="badge">${esc(it.version||"")}</span>`;
  $("#player-hook").textContent = it.hook || "Prévia";
  $("#player-meta").textContent = [cutLabel(it), it.title||""].filter(Boolean).join(" · ");
  const video = $("#player-video");
  video.pause();
  video.removeAttribute("src");
  video.load();
  const poster = await signedCover(it.cover_path);
  if (poster) video.poster = poster;
  else video.removeAttribute("poster");
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
  renderFila();
  renderDashboard();
  if (parseRoute().tab === "projetos") renderProjects(parseRoute().projectId, parseRoute().focusNew);
}
function decideCurrent(act){
  if (!playerCut) return;
  decide(playerCut.id, act);
}

async function renderDashboard(){
  const items = allCuts;
  const pending = items.filter(it => decisionOf(it.id) === "pending");
  const approved = items.filter(it => decisionOf(it.id) === "approved");
  const live = items.filter(it => it.tag === "live");
  $("#dash-stats").innerHTML = [
    [items.length, "Cortes no perfil"],
    [pending.length, "Pendentes"],
    [approved.length, "Aprovados"],
    [live.length, "Cortes de live"],
  ].map(([n,l]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join("");
  const show = pending.slice(0, 5);
  if (!show.length){
    $("#dash-pending").innerHTML = `<p class="muted">Nada pendente neste perfil.</p>`;
    return;
  }
  const covers = {};
  await Promise.all(show.map(async it => { covers[it.id] = await signedCover(it.cover_path); }));
  $("#dash-pending").innerHTML = show.map(it => {
    const thumb = covers[it.id] ? `<img src="${covers[it.id]}" alt="">` : `<span class="ph"></span>`;
    return `<div class="mini" data-play="${esc(it.id)}">
      ${thumb}
      <div>
        <h3>${esc(it.hook || it.cut_id)}</h3>
        <p class="meta">${esc(cutLabel(it))}</p>
      </div>
    </div>`;
  }).join("");
  $$("#dash-pending [data-play]").forEach(el => {
    el.addEventListener("click", () => openPlayer(el.dataset.play));
  });
}

function renderProfiles(){
  const box = $("#profiles-migrate");
  const form = $("#profile-form");
  if (box) box.hidden = hasProfiles;
  if (form) form.hidden = !hasProfiles;
  $("#profiles-grid").innerHTML = profiles.map(p => {
    const theme = p.theme && typeof p.theme === "object" ? p.theme : {};
    const on = p.id === currentProfile().id ? " is-on" : "";
    return `<button type="button" class="profile-card${on}" data-pid="${esc(p.id)}">
      <h3><span class="swatch" style="background:${esc(theme.accent||"#ffd400")}"></span>${esc(p.name)}</h3>
      <p class="meta">${esc(p.handle ? "@"+p.handle.replace(/^@/,"") : "")} · ${esc(p.niche||"")} · ${esc(p.default_style||"")}</p>
    </button>`;
  }).join("");
  $$("#profiles-grid [data-pid]").forEach(b => b.addEventListener("click", () => {
    currentProfileId = b.dataset.pid;
    storageSet("cortes.profile", currentProfileId);
    applyTheme(currentProfile());
    fillProfileSelects();
    loadFila(); loadLives(); renderDashboard(); renderProfiles();
  }));
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
    theme: { bg: "#0b0d10", accent: $("#pf-accent").value || "#ffd400", text: "#111111" },
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
  toast("Perfil criado. A fila dele começa vazia.");
  renderProfiles(); renderDashboard(); loadFila();
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
    <a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.url)}</a>
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

try { boot(); } catch (err) { showGate(); showError("Não consegui iniciar a página."); }
