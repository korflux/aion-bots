# Composer

Campo de mensagem da conversa (conversation/composer.tsx), o mesmo no bot, no Chat geral, no Início e em Chats. Desenho da phase 18: pílula lisa, sem degradê nem brilho.

- Forma: bg-surface, borda border, raio de 28 px (perto de pílula), padding 12 × 16, até 760 px; o anel focus vai no formulário inteiro quando o campo tem foco.
- Campo em cima: cresce até 40 dvh (no Início começa com 72 px de altura), 16 px no celular e 15/24 no desktop, placeholder "Escreva uma mensagem" ou o motivo do bloqueio ("Configure um provedor para conversar.").
- Anexos acima do texto: miniatura de 56 px para imagem, chip de 40 px para documento ("PDF · 212 KB"), borda danger com a mensagem quando falha.
- Uma linha de controles embaixo: anexar (Paperclip) à esquerda e, à direita, nesta ordem, modelo (texto muted com seta, trunca primeiro), effort, contexto, ditado e o botão redondo. Em 390 px só o modelo encolhe: nenhum controle some nem se sobrepõe.
- Botão redondo: ArrowUp para enviar (50% sem texto), quadrado cheio para parar quando o bot trabalha e o campo está vazio, LoaderCircle enquanto envia ou para.
- Ditado ativo em tons neutros: microfone em bg-selected com contorno text pulsando e a linha "Ouvindo… o áudio é processado pelo navegador.", com o ponto em text.
- Rascunho devolvido: linha bg-surface-hover "Rascunho devolvido · Usar · Descartar" acima do campo.
