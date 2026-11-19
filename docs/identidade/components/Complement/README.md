# Complement

Complemento enviado enquanto o bot trabalha (phase 4, CONV-03). É o padrão ao enviar com execução ativa, nas duas superfícies.

- Nunca interrompe ferramenta nem resposta em curso; é lido só na fronteira entre etapas (em aprovação, na retomada).
- Marca abaixo da mensagem, 12 px: "Complemento · será lido na próxima etapa" (text-muted) e depois "Complemento lido" (success). Se a execução termina antes, vira nova rodada e a marca some.
- Parar com complemento não lido devolve texto e anexos ao composer, com um aviso neutro (ver Composer).
- Botão redondo: com texto digitado envia o complemento ("Enviar complemento"); com o campo vazio é Parar.
- Rotinas que disparam com execução ativa continuam enfileirando ("Na fila").
