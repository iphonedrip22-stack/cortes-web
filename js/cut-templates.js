/* Catálogo de templates de cor do corte. Manter alinhado a /workspace/cortes/themes/catalog.json */
window.CUT_TEMPLATES = {
  version: "1.0.0",
  default: "incisao",
  templates: [
    {
      id: "incisao",
      label: "Direto ao Osso / Incisão",
      default: true,
      paper: "#F2EDE4",
      ink: "#111111",
      highlight: "#E8261C",
      caption_font: "Archivo Black",
      hook: "Caixa branca, Montserrat Black, y=1250, texto tinta; só a legenda destaca em vermelho."
    },
    {
      id: "empreendedorismo",
      label: "Amarelo clássico",
      default: false,
      paper: "#0A0A0A",
      ink: "#FFFFFF",
      highlight: "#FFFE03",
      caption_font: "Montserrat Black",
      hook: "Mesmo formato de gancho; a palavra ativa da legenda fica amarela."
    }
  ]
};

window.cutTemplateById = function (id) {
  const list = (window.CUT_TEMPLATES && window.CUT_TEMPLATES.templates) || [];
  return list.find(t => t.id === id) || list.find(t => t.default) || list[0] || null;
};

window.inferCutTemplateId = function (theme) {
  const th = theme && typeof theme === "object" ? theme : {};
  const raw = th.cut_template || th.template_id || th.theme_id;
  if (raw && window.cutTemplateById(raw) && window.cutTemplateById(raw).id === raw) return raw;
  const acc = String(th.accent || "").toLowerCase();
  if (acc === "#fffe03" || acc === "#ffd400" || acc === "#fff500") return "empreendedorismo";
  if (acc === "#e8261c") return "incisao";
  return (window.CUT_TEMPLATES && window.CUT_TEMPLATES.default) || "incisao";
};

window.themeFromCutTemplate = function (tmpl, prev) {
  const t = tmpl || window.cutTemplateById();
  const base = (prev && typeof prev === "object") ? Object.assign({}, prev) : {};
  if (!t) return base;
  base.cut_template = t.id;
  base.bg = t.paper;
  base.accent = t.highlight;
  base.text = t.ink;
  return base;
};
