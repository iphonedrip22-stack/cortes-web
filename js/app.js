/* Direto ao Osso — public GitHub Pages frontend. Uses only the anon key. */
const $ = (s, r=document) => r.querySelector(s);
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
const cfg = window.CORTES_CONFIG || {};
const configured = !!(cfg.supabaseUrl && cfg.supabaseAnonKey);
let sb = null;
let currentJobId = null;
let signedCache = {}; // path -> {url, exp}

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

async function signed(path, isVideo){
  if (!path) return null;
  const now = Date.now();
  const hit = signedCache[path];
  if (hit && hit.exp > now + 15_000) return hit.url;
  const { data, error } = await sb.storage.from("previews").createSignedUrl(path, 3600);
  if (error || !data || !data.signedUrl) return null;
  signedCache[path] = { url: data.signedUrl, exp: now + 50*60*1000 };
  return data.signedUrl;
}

function showApp(){
  document.body.classList.add("is-in");
  bindApp();
  tickJob();
  loadFila();
  loadLives();
  subscribe();
}
function showGate(){
  document.body.classList.remove("is-in");
}

async function boot(){
  sb = initClient();
  if (!sb) return;
  const { data } = await sb.auth.getSession();
  if (data && data.session) showApp();
  else showGate();
  sb.auth.onAuthStateChange((_e, session) => {
    if (session) showApp();
    else showGate();
  });
}

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

let appBound = false;
function bindApp(){
  if (appBound) return;
  appBound = true;
  $("#logout-btn").addEventListener("click", () => sb.auth.signOut());
  $$(".tab").forEach(b => b.addEventListener("click", () => {
    $$(".tab").forEach(x => x.classList.toggle("is-on", x===b));
    $$(".panel").forEach(p => p.classList.toggle("is-on", p.id === "tab-"+b.dataset.tab));
    if (b.dataset.tab === "fila") loadFila();
    if (b.dataset.tab === "lives") loadLives();
  }));
  $("#file").addEventListener("change", () => {
    const f = $("#file").files[0];
    $("#file-name").textContent = f ? `${f.name} (${(f.size/1048576).toFixed(1)} MB)` : "";
  });
  $("#run-form").addEventListener("submit", onRun);
  $("#cancel-btn").addEventListener("click", onCancel);
  $("#reload-fila").addEventListener("click", loadFila);
  $("#add-channel").addEventListener("submit", onAddChannel);
  $("#lives-settings").addEventListener("submit", onSaveSettings);
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
    const { data, error } = await sb.from("jobs").insert({
      status: "queued",
      url: url || null,
      storage_path,
      style,
      source: file ? "upload" : "url",
    }).select("id").single();
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
  const { data, error } = await sb.from("jobs").select("*").order("created_at", { ascending: false }).limit(8);
  if (error){ return; }
  const jobs = data || [];
  const job = jobs.find(j => j.id === currentJobId) || jobs.find(j => ["queued","running"].includes(j.status)) || jobs[0];
  if (!job || (job.status === "done" && !currentJobId && jobs.every(j => !["queued","running"].includes(j.status)) && job !== jobs[0] /* keep last visible */)) {
    /* show most recent if nothing running */
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

async function loadFila(){
  const [{ data: cuts, error: e1 }, { data: decs, error: e2 }] = await Promise.all([
    sb.from("cuts").select("*").order("mtime", { ascending: false, nullsFirst: false }),
    sb.from("decisions").select("*"),
  ]);
  if (e1){ $("#fila").innerHTML = `<p class="error">${esc(e1.message)}</p>`; return; }
  const decMap = {};
  (decs || []).forEach(d => { decMap[d.cut_id] = d; });
  const items = cuts || [];
  if (!items.length){
    $("#fila").innerHTML = `<p class="muted">Nenhum corte na fila ainda. Quando o servidor sincronizar, eles aparecem aqui.</p>`;
    return;
  }
  const cards = await Promise.all(items.map(async it => {
    const decision = (decMap[it.id] && decMap[it.id].decision) || "pending";
    const badge = decision==="approved" ? "ok" : decision==="rejected" ? "no" : "pending";
    const decLabel = decision==="approved" ? "aprovado" : decision==="rejected" ? "rejeitado" : "pendente";
    const qc = it.qc && it.qc.score != null ? `QC ${it.qc.score}` : (it.qc && it.qc.pass === true ? "QC ok" : "");
    const tag = it.tag === "live" ? `<span class="badge live">live</span>` : "";
    const liveTs = it.live_timestamp ? ` · ao vivo ${it.live_timestamp}` : "";
    const reason = it.reason ? `<p class="meta">${esc(it.reason)}</p>` : "";
    const [videoUrl, coverUrl] = await Promise.all([signed(it.preview_path), signed(it.cover_path)]);
    const media = videoUrl
      ? `<video controls preload="metadata" poster="${coverUrl||""}" src="${videoUrl}" playsinline></video>`
      : (coverUrl ? `<img class="cover" src="${coverUrl}" alt="">` : "");
    return `<article class="cut" data-id="${esc(it.id)}">
      ${media}
      <div class="body">
        <div>${tag} <span class="badge ${badge}">${decLabel}</span> <span class="badge">${esc(it.version||"")}</span></div>
        <h3>${esc(it.hook || "Ver prévia do vídeo")}</h3>
        <p class="meta">${esc(it.channel||"")} · ${esc(it.title||"")} · corte ${esc(it.cut_id||"")} ${esc(qc)}${esc(liveTs)}</p>
        ${reason}
        <div class="actions">
          <button class="btn ok" data-act="approved">Aprovar</button>
          <button class="btn danger" data-act="rejected">Rejeitar</button>
        </div>
      </div>
    </article>`;
  }));
  $("#fila").innerHTML = cards.join("");
  $("#fila").querySelectorAll("button[data-act]").forEach(b => b.addEventListener("click", async () => {
    const id = b.closest(".cut").dataset.id;
    const item = items.find(x => x.id === id) || {};
    b.disabled = true;
    const { error } = await sb.from("decisions").upsert({
      cut_id: id,
      decision: b.dataset.act,
      at: new Date().toISOString(),
      hook: item.hook,
      version: item.version,
      source: item.source,
      tag: item.tag,
    });
    if (error) toast(error.message);
    loadFila();
  }));
}

async function loadLives(){
  const [{ data: channels }, { data: sessions }, { data: words }, { data: settings }] = await Promise.all([
    sb.from("lives_watchlist").select("*").order("added_at", { ascending: true }),
    sb.from("live_sessions").select("*").order("updated_at", { ascending: false }).limit(8),
    sb.from("keywords").select("word").order("word"),
    sb.from("app_settings").select("*"),
  ]);
  const set = {};
  (settings || []).forEach(s => { set[s.key] = s.value; });
  if (set.style) $("#live-style").value = set.style;
  if (typeof set.enabled === "boolean") $("#lives-enabled").checked = set.enabled;
  else if (set.enabled && typeof set.enabled.enabled === "boolean") $("#lives-enabled").checked = set.enabled.enabled;
  const kw = (words || []).map(w => w.word).join(", ");
  if (document.activeElement !== $("#keywords")) $("#keywords").value = kw;

  const ul = $("#channels");
  const sessByCh = {};
  (sessions || []).forEach(s => {
    if (["recording","starting","detecting"].includes(s.status)) sessByCh[s.channel_id] = s;
  });
  ul.innerHTML = (channels || []).map(c => {
    const live = sessByCh[c.id] ? `<span class="badge live">ao vivo</span>` : "";
    const plat = c.platform || "youtube";
    const exp = c.experimental ? " · experimental" : "";
    const err = c.last_error ? `<p class="error">${esc(c.last_error)}</p>` : "";
    const check = c.last_check ? `última checagem: ${c.last_check}` : "ainda não verificado";
    return `<li data-id="${esc(c.id)}">
      <div class="name"><strong>${esc(c.name)}</strong> ${live}
        <span>${c.enabled===false?"pausado":"ativo"}</span></div>
      <p class="meta">${esc(plat)}${exp} · ${esc(c.handle||c.channel_id||"")}</p>
      <a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.url)}</a>
      <p class="meta">${esc(check)}</p>
      ${c.note? `<p class="meta">${esc(c.note)}</p>`:""}
      ${err}
      <div class="row">
        <button class="btn ghost" data-act="toggle">${c.enabled===false?"Ligar":"Pausar"}</button>
        <button class="btn danger" data-act="remove">Remover</button>
      </div>
    </li>`;
  }).join("") || `<p class="muted">Nenhum canal na lista.</p>`;
  ul.querySelectorAll("button[data-act]").forEach(b => b.addEventListener("click", async () => {
    const id = b.closest("li").dataset.id;
    const c = (channels || []).find(x => x.id === id);
    if (b.dataset.act === "remove"){
      if (!confirm("Remover este canal da lista?")) return;
      await sb.from("lives_watchlist").delete().eq("id", id);
    } else {
      await sb.from("lives_watchlist").update({ enabled: !(c && c.enabled) }).eq("id", id);
    }
    loadLives();
  }));

  const box = $("#sessions");
  const list = sessions || [];
  const active = list.filter(s => ["recording","starting","detecting","stopping"].includes(s.status));
  const show = active.length ? active : list.slice(0, 5);
  if (!show.length){
    box.innerHTML = `<p class="muted">Nenhuma live sendo gravada.</p>`;
  } else {
    box.innerHTML = show.map(s => {
      const moments = (s.moments || []).slice(-5).map(m => `<p class="moment">${esc(m.why||m.kind)} · ${esc(m.quote||"")}</p>`).join("");
      const ncuts = (s.cuts || []).length ? `${(s.cuts||[]).length} corte(s) na fila` : "ainda sem cortes";
      return `<div class="session">
        <div class="name"><strong>${esc(s.channel_name||"")}</strong> <span class="badge ${s.status==="recording"?"live":"pending"}">${esc(s.status||"")}</span></div>
        <p class="meta">${esc(s.title||"")} · ${s.chunks||0} trecho(s) transcritos · ${esc(ncuts)}</p>
        ${moments}
      </div>`;
    }).join("");
  }
}

async function onAddChannel(e){
  e.preventDefault();
  $("#channel-err").hidden = true;
  const url = $("#channel-url").value.trim();
  const name = $("#channel-name").value.trim();
  if (/instagram\.com/i.test(url)){
    $("#channel-err").hidden = false;
    $("#channel-err").textContent = "Instagram Live está fora de escopo (precisa de login).";
    return;
  }
  let platform = "youtube";
  if (/twitch\.tv/i.test(url)) platform = "twitch";
  if (/tiktok\.com/i.test(url)) platform = "tiktok";
  const id = (name || url).toLowerCase().replace(/https?:\/\//,"").replace(/[^\w]+/g,"-").replace(/^-|-$/g,"").slice(0,40) || ("canal-"+Date.now());
  const { error } = await sb.from("lives_watchlist").insert({
    id, name: name || id, platform, url, enabled: true, seed: false,
    experimental: platform === "tiktok",
    note: platform === "tiktok" ? "TikTok Live é experimental (melhor esforço)." : "",
    added_at: new Date().toISOString(),
  });
  if (error){
    $("#channel-err").hidden = false;
    $("#channel-err").textContent = error.message;
    return;
  }
  $("#channel-url").value = "";
  $("#channel-name").value = "";
  loadLives();
}

async function onSaveSettings(e){
  e.preventDefault();
  const words = $("#keywords").value.split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
  const { data: existing } = await sb.from("keywords").select("id,word");
  const have = new Set((existing||[]).map(x => x.word));
  const want = new Set(words);
  const toDel = (existing||[]).filter(x => !want.has(x.word)).map(x => x.id);
  const toAdd = words.filter(w => !have.has(w)).map(word => ({ word }));
  if (toDel.length) await sb.from("keywords").delete().in("id", toDel);
  if (toAdd.length) await sb.from("keywords").insert(toAdd);
  await sb.from("app_settings").upsert([
    { key: "style", value: $("#live-style").value },
    { key: "enabled", value: $("#lives-enabled").checked },
  ]);
  toast("Ajustes salvos. O servidor aplica na próxima sincronização.");
}

function subscribe(){
  const ch = sb.channel("cortes-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "jobs" }, () => tickJob())
    .on("postgres_changes", { event: "*", schema: "public", table: "cuts" }, () => loadFila())
    .on("postgres_changes", { event: "*", schema: "public", table: "decisions" }, () => loadFila())
    .on("postgres_changes", { event: "*", schema: "public", table: "live_sessions" }, () => {
      if ($("#tab-lives").classList.contains("is-on")) loadLives();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "lives_watchlist" }, () => {
      if ($("#tab-lives").classList.contains("is-on")) loadLives();
    })
    .subscribe();
  setInterval(() => {
    tickJob();
    if ($("#tab-fila").classList.contains("is-on")) loadFila();
    if ($("#tab-lives").classList.contains("is-on")) loadLives();
  }, 8000);
}

boot();
