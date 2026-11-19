# PushNotification

Aviso do sistema (phase 3 entrega o comportamento; phase 5 troca a marca).

- Título: nome do bot ou "Chat geral"; corpo: o tipo do evento ("Concluída", "Falha", "Aprovação pendente", "Aprovação expirada"). Nada de conteúdo da conversa.
- Emblema (`badge`): o Android usa só o canal alfa. Phase 3 gera o "A" branco transparente; phase 5 troca por `assets/Icones/push-badge.svg` (estrela branca).
- Ícone grande (`icon`): phase 3 mantém o "A"; phase 5 usa `push-icone-grande.svg` (Faísca sobre disco tinta).
- Fallback silencioso: título "Aion", sem corpo, sem som nem vibração, fechado logo depois.
