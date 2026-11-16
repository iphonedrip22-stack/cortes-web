# Direto ao Osso — esteira de cortes (interface)

Página pública só com o código da interface. **Não tem senha, vídeo, token nem dado da fila neste repositório.**

O site abre no GitHub Pages, o login e a fila ficam num projeto gratuito do Supabase, e o processamento pesado roda no servidor da esteira, que só faz chamadas de saída.

- Aprovar e rejeitar **só registram a decisão**. Nada é publicado nas redes por aqui.
- A chave que aparece em `js/config.js` é a chave anônima (pública por desenho). A chave de serviço nunca entra neste repositório.

## Depois do setup

1. Abra o endereço do GitHub Pages.
2. Entre com o e-mail e a senha gerados no servidor (arquivo `site_login.txt`).
3. Cole o link de um vídeo ou envie um arquivo, escolha o estilo e rode a esteira.
4. A fila mostra a prévia. Aprovar não publica.

Se a página abrir mas o login ainda não funcionar, o setup do Supabase ainda não terminou.

## Perfis (segundo SQL)

Depois da migration inicial, cole também `sql/migration_profiles.sql` no SQL Editor para liberar vários perfis de cortes. A página funciona antes e depois desse passo.

## Painel Maestri (terceiro SQL)

Cole `sql/migration_maestri.sql` no SQL Editor do projeto **cortes** (não o hs3d) para ligar Metas, agenda, pedidos de formato, Números e liberação de formato. Até lá o site continua no ar e essas abas avisam que falta o SQL. Números só mostram valores reais; se não houver coleta, aparece “sem dados ainda”. Nada é publicado por aqui.


## Endurecimento (SQL atual)

Cole `sql/hardening.sql` no SQL Editor do projeto **cortes** (não o hs3d). Esse arquivo substitui o `migration_maestri.sql` antigo: cria as tabelas do painel se faltarem, coloca uma allowlist de admin e troca as policies para que só esses e-mails leiam ou escrevam. Também desligue o cadastro aberto em Authentication → Sign In / Providers → Email → **Allow new users to sign up**.
